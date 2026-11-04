#!/usr/bin/env node
// location-confirm-resolve — the smart half of the hybrid location-confirm flow.
//
// Stdin: detector ask JSON (the same shape the precheck consumes).
// Stdout: {decision: "auto_confirm"|"ask", venue?, reasoning, evidence?}
//
// Bypasses the Opus ops-agent supervisor entirely. Pre-fetches calendar +
// recent phone-channel messages + wiki search results in Node, then decides
// LOCALLY: `localResolve()` does deterministic
// memory + calendar + message matching — a dwell near a previously-confirmed
// favorite/frequent stop auto-confirms it, learning from feedback as every
// confirmation appends to confirmed-stops.json. Matching against known
// candidate/calendar NAMES stays plain code (geometry: does this string
// contain that string) — but deciding whether a free-form message NAMES a
// venue at all is a language judgment (Rule #0b), so tier 3b calls the
// on-device Gemma classifier (`messageVenueViaModel`) instead of a
// hand-written trigger-phrase regex (removed 2026-08-01 after it silently
// missed "Lunch at Numidia." — see the comment at tier 3b for the incident).
// That's the only model call `localResolve()` makes, and it only fires when
// there's a user message inside the dwell window to check.
// The kill-switch fallback classifier — reached only when
// `data/.location-local-off` is set (or the documented local-exception
// path) — also runs ON-DEVICE via local Gemma (`lib/local-llm.mjs`),
// NOT a `claude -p` fork, so even the fallback is zero-Max-cost (2026-06-17,
// Lever B on-device migration; sibling location-confirm-phrase.mjs already
// does this). One inference, no tool use, ~1–3s; on any error it emits
// {decision:"ask"} and the caller falls through to the direct phrase + send
// (the zero-token path).
//
// 2026-10-20: before the model tail, `statedPlace()` (lib/stated-place.mjs)
// reads the WHOLE DAY's chat and the calendar around the dwell, and a model
// ladder (local, Sonnet, Opus) decides whether the user already named the place for
// this window ("meeting them for lunch at X" at 12:42 for a 13:31 dwell). A
// settled answer is an auto_confirm, which the trigger saves with
// `location-confirm save` — the confirm path. Until that day this file read
// jori_messages through a `body` column that does not exist: every query
// 400'd into the catch, so no tier had ever seen one of the user's messages.
//
// On any error path that prevents a confident decision, we emit
// `{decision: "ask"}` so the caller falls through to the direct phrase + send
// (the existing zero-token path). Never blocks the pipeline.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, appendFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { localLlmChat } from "../lib/local-llm.mjs";
import { resolveTail } from "../lib/location-confirm-jev.mjs";
import { installTools } from "../lib/root.cjs";
import { instance, localConfig, supabaseUrl } from "../lib/instance.cjs";

// The owner as the prompts name them (instance owner_name).
const OWNER = instance().owner_name;
// stated-place is imported lazily (below): a broken module must not take the
// resolver, and with it every location-confirm ask, down at load.
let statedMod = null;
try { statedMod = await import("../lib/stated-place.mjs"); }
catch (e) { process.stderr.write(`location-confirm-resolve: stated-place unavailable — ${String((e && e.message) || e).slice(0, 160)}\n`); }

// gog: $GOG_BIN, else a package-manager install (launchd's PATH has neither), else PATH.
const GOG = process.env.GOG_BIN || ["/opt/homebrew/bin/gog", "/usr/local/bin/gog"].find((p) => existsSync(p)) || "gog";
const WIKI_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "wiki");
const ENV_FILE = installTools(".env");
const SUPABASE_URL = process.env.SUPABASE_URL || supabaseUrl();

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function readSupabaseKey() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const txt = readFileSync(ENV_FILE, "utf8");
    const m = txt.match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// Supabase REST GET for statedPlace() (path+query → rows; throws on non-2xx).
async function sbGet(pathQs) {
  const key = readSupabaseKey();
  if (!key) throw new Error("no SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathQs}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`supabase ${r.status}`);
  return r.json();
}

// The dwell is live, so the day is the one the user is in now
// (data/user-timezone.json), else the home zone.
function userTimezone() {
  try {
    return JSON.parse(readFileSync(path.join(DATA_DIR, "user-timezone.json"), "utf8")).timezone || instance().tz;
  } catch { return instance().tz; }
}

// ─── Local resolver (2026-06-07): replaces the Sonnet fork with deterministic
// memory + calendar + message matching. Favorite/frequent stops are preferred —
// a dwell near a place you've confirmed before auto-confirms it — and it learns
// from feedback automatically, since every confirmation appends to confirmed-stops.
// "ask" is the safe fallback (worst case = one extra question). Kill switch:
// touch data/.location-local-off → falls back to the Sonnet path below.
const DATA_DIR = installTools("data");
const CONFIRMED_STOPS = path.join(DATA_DIR, "confirmed-stops.json");
const LOCAL_OFF = path.join(DATA_DIR, ".location-local-off");
const LOCAL_LOG = path.join(DATA_DIR, "location-local-resolve.jsonl");
const MEM_RADIUS_M = 120; // a confirmed stop within this radius (whose name is a candidate) auto-confirms

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
// JORI_CONFIRMED_STOPS_FILE is a TEST-ONLY override so a test can point both
// the read and the write at a temp fixture. Production never sets it — and it
// deliberately steers BOTH sides, so a test can never read one store and append
// to another.
function confirmedStopsFile() {
  return process.env.JORI_CONFIRMED_STOPS_FILE || CONFIRMED_STOPS;
}
function loadConfirmedStops() {
  try { const a = JSON.parse(readFileSync(confirmedStopsFile(), "utf8")); return Array.isArray(a) ? a : []; } catch { return []; }
}

// ─── Durable promotion ────────────────────────────────────────────────────
// Until now this file only READ confirmed-stops.json. The one append path was
// the Python `bin/location-confirm save`, which trigger-location-confirm.sh
// calls after an auto_confirm and which refuses (exit 2) whenever the ask has
// already been pruned out of pending/recent — the trigger then logs
// `auto_confirm_save_failed` and falls through. When that happens the resolved
// centroid → name mapping is simply lost: the same stop gets asked again
// tomorrow and past day records keep the wrong name. Nothing had been appended
// in 14 days while the user answered at least five location questions in
// chat, and asked directly why an answer given "wasn't registered".
//
// So a successful resolve now promotes the mapping here too — but STRICTLY as
// a backstop for the cases the Python saver does not cover. Where that saver
// works, this one stands down (see `canonicalSaverWillHandle`): two rows at one
// centroid is not a cosmetic duplicate, because localResolve tier 1 COUNTS rows
// per name (`near[names[i]] = (near[names[i]] || 0) + 1`) and takes the max, so
// an extra row inflates one venue's score by exactly 1 and can flip a tie
// against a genuinely nearer neighbour. A promotion that corrupted the resolver
// it exists to strengthen would be worse than the gap it closes.
//
// LIMITATION, by design: a JS-promoted entry does NOT patch
// `location_history.place_type` and does NOT dispatch the silent re-render of
// an already-shipped daily summary — both live in the Python saver. So the
// mapping survives for FUTURE resolves (the same stop stops being re-asked),
// but the historical day record stays wrong until something else repairs it.
// That is why the entry records `patched_location_history: false` rather than
// omitting the key: per jobs/location-confirm-ask.md, a silent no-op here is
// indistinguishable from success, and that is exactly how the class went
// unnoticed for months.
const PROMOTE_DEDUP_RADIUS_M = 30; // the confirmed-stops fast-lane radius

// The ask stores `location-confirm save` looks in. They sit beside
// confirmed-stops.json in DATA_DIR, so deriving them from the store's own
// directory means one env override steers the whole set consistently.
const PENDING_BASENAME = "location-confirm-pending.json";
const RECENT_BASENAME = "location-confirm-recent.json";
function readAskStore(basename) {
  try {
    const a = JSON.parse(readFileSync(path.join(path.dirname(confirmedStopsFile()), basename), "utf8"));
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}

// Will `location-confirm save` handle this ask itself? It looks the id up in
// pending ∪ recent and refuses (exit 2) when it is absent — so when the id IS
// present, trigger-location-confirm.sh is about to write the richer entry and
// we must add nothing. Centroid proximity is checked too, so an ask for the
// same place under a different id also makes us stand down: erring toward
// standing down costs at most a delayed promotion, while erring the other way
// corrupts tier 1's counting. Returns the store that owns it, or null.
function canonicalSaverWillHandle(ask, lat, lon) {
  const askId = ask && ask.ask_id ? String(ask.ask_id) : null;
  for (const basename of [PENDING_BASENAME, RECENT_BASENAME]) {
    for (const a of readAskStore(basename)) {
      if (!a) continue;
      if (askId && String(a.ask_id || "") === askId) return basename;
      const c = a.centroid;
      if (c && typeof c.lat === "number" && typeof c.lon === "number"
        && haversineM(lat, lon, c.lat, c.lon) <= PROMOTE_DEDUP_RADIUS_M) return basename;
    }
  }
  return null;
}

// Mirrors `_resolve_candidate` in bin/location-confirm so a promoted
// entry is shaped exactly like the ones that tool writes: a venue matching a
// GPS candidate carries that candidate's address / place_id / primary_type /
// source, and a free-form name the user supplied carries nulls with
// source "user_freeform". Set-membership over strings WE generated (candidate
// names) is not language matching — Rule #0b is untouched here.
function candidateMeta(cands, venue) {
  const needle = String(venue || "").trim().toLowerCase();
  const list = (cands || []).filter((c) => c && c.name);
  const hit = list.find((c) => String(c.name).toLowerCase() === needle)
    || list.find((c) => String(c.name).toLowerCase().includes(needle));
  if (hit) {
    return {
      address: hit.address ?? null,
      place_id: hit.place_id ?? null,
      primary_type: hit.primary_type ?? null,
      source: hit.source ?? "user_confirmed",
    };
  }
  return { address: null, place_id: null, primary_type: null, source: "user_freeform" };
}

// Appends {centroid → name} to confirmed-stops.json. Returns
// {promoted:boolean, reason?, entry?}. THROWS on an unreadable / malformed /
// wrong-shaped store — a loud failure, never a silent overwrite. Losing one
// promotion is recoverable; replacing every confirmation ever recorded with a
// fresh array is not.
function promoteConfirmedStop(ask, venue, cands) {
  const file = confirmedStopsFile();
  const name = String(venue || "").trim();
  if (!name) return { promoted: false, reason: "no_venue" };

  const centroid = (ask && ask.centroid) || {};
  const lat = typeof centroid.lat === "number" ? centroid.lat : null;
  const lon = typeof centroid.lon === "number" ? centroid.lon : null;
  // Null-island guard, same as location-confirm's own: a 0 or
  // missing coordinate signals an upstream resolver bug — surface it by
  // refusing rather than poisoning the dataset.
  if (lat === null || lon === null || lat === 0 || lon === 0) return { promoted: false, reason: "invalid_centroid" };

  // Stand down where the canonical writer already works. This is the common
  // case in the live trigger path, and a no-op there is the CORRECT outcome —
  // the value of this promotion is exactly the asks that saver cannot find.
  const owner = canonicalSaverWillHandle(ask, lat, lon);
  if (owner) return { promoted: false, reason: `canonical_saver_owns_it:${owner}` };

  let entries;
  if (existsSync(file)) {
    let parsed;
    try { parsed = JSON.parse(readFileSync(file, "utf8")); }
    catch (e) { throw new Error(`confirmed-stops unreadable/malformed (${file}): ${e.message}`); }
    if (Array.isArray(parsed)) entries = parsed;
    // location-confirm tolerates a {entries:[...]} envelope on read; match it.
    else if (parsed && Array.isArray(parsed.entries)) entries = parsed.entries;
    else throw new Error(`confirmed-stops is neither an array nor {entries:[…]} (${file}) — refusing to overwrite`);
  } else {
    entries = [];
  }

  // Idempotency 1 — the same ask resolved twice.
  const askId = ask && ask.ask_id ? String(ask.ask_id) : null;
  if (askId && entries.some((e) => e && e.ask_id === askId)) return { promoted: false, reason: "duplicate_ask_id" };

  // Idempotency 2 — this centroid → name mapping is already durable, under
  // whatever ask_id. This is also what stops us racing the canonical writer:
  // the trigger calls `location-confirm save` immediately after an
  // auto_confirm, so from the next resolve of that place onward we add nothing.
  const already = entries.some((e) => {
    if (!e || !e.centroid || typeof e.centroid.lat !== "number" || typeof e.centroid.lon !== "number") return false;
    if (String(e.name || "").trim().toLowerCase() !== name.toLowerCase()) return false;
    return haversineM(lat, lon, e.centroid.lat, e.centroid.lon) <= PROMOTE_DEDUP_RADIUS_M;
  });
  if (already) return { promoted: false, reason: "duplicate_centroid_name" };

  const meta = candidateMeta(cands, name);
  const entry = {
    ts: new Date().toISOString(),
    ask_id: askId || `lc-resolve-${Date.now()}-${lat.toFixed(3)}-${lon.toFixed(3)}`,
    centroid: { lat, lon },
    name,
    address: meta.address,
    place_id: meta.place_id,
    primary_type: meta.primary_type,
    source: meta.source,
    stop_window: {
      start: (ask && ask.first_sample_ts) || null,
      end: (ask && ask.last_sample_ts) || null,
      duration_min: typeof (ask && ask.duration_min) === "number" ? ask.duration_min : null,
    },
    // Always false, never absent and never a hopeful true: this path has no
    // location_history write-back at all (jobs/location-confirm-ask.md — "do
    // not remove either; a silent no-op here is indistinguishable from
    // success"). Position is last, matching where location-confirm stamps it.
    patched_location_history: false,
  };

  entries.push(entry);
  // Atomic: temp file + rename, in the same on-disk shape location-confirm's
  // _save_json writes (indent 2, trailing newline) so the two writers agree.
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n");
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw new Error(`confirmed-stops write failed (${file}): ${e.message}`);
  }
  return { promoted: true, entry };
}

// Which resolution tiers may promote into the durable confirmed-stops store.
// "auto_confirm" alone was the whole gate until 2026-09-25 — any tier that
// returned that decision label got written with full "user-confirmed"
// authority, including the model-judgment tail (Jev / Gemma extraction /
// the kill-switch fallback classifier below) that GUESSES a venue from
// ambiguous evidence rather than matching something the user actually wrote.
// Once written, tier 1 above trusts that entry at full strength for every
// future dwell near the same centroid — so a single wrong guess became a
// permanent, self-reinforcing "confirmation" that was never actually
// confirmed by the user. This is the "automated guess marking itself confirmed
// on its own authority" gap flagged separately from the direct-save fix
// above — see jobs/location-confirm-ask.md § Automated guesses cannot
// self-confirm. Only tiers whose evidence is a deterministic match against
// something the user produced — a past confirmation (memory), the user's own
// calendar text, or the user's own message text — may promote. A model-judgment
// tier can still auto_confirm (skip asking today — a one-day, reversible
// convenience) but can never grant itself durable "confirmed" status.
// "stated:chat": the user's own words, read by the stated-place model and
// verified in code to be in one of the user's messages — a plan only when the
// place is one of the GPS candidates. Saved through the confirm path by the
// owner's decision. "local:message" is the retired tier 3; kept so an
// old log row still reads as grounded.
const GROUNDED_PROMOTION_SOURCES = new Set([
  "local:memory", "local:calendar", "local:calendar_title", "local:message", "stated:chat",
]);

// Runs the promotion without ever breaking the pipeline: a failure is loud on
// stderr (trigger-location-confirm.sh appends it to watchdog.log) but the
// resolve decision itself still ships.
function promoteSafely(ask, decision, venue, cands, source) {
  if (decision !== "auto_confirm" || !venue) return { promoted: false, reason: "not_auto_confirm" };
  if (!GROUNDED_PROMOTION_SOURCES.has(source)) {
    return { promoted: false, reason: `ungrounded_source:${source || "unknown"}` };
  }
  try {
    return promoteConfirmedStop(ask, venue, cands);
  } catch (err) {
    const msg = String((err && err.message) || err);
    process.stderr.write(`location-confirm-resolve: confirmed-stops promotion FAILED — ${msg} — store left untouched\n`);
    return { promoted: false, error: msg };
  }
}

// ─── Calendar-title fallback helpers (2026-07-24, extended 2026-09-08) ────
// The tier-2 calendar check below only fires when the event text CONTAINS a
// GPS-resolved candidate NAME. That misses the common case where the actual
// venue (e.g. a small local business) never surfaced as a candidate at all —
// OSM Overpass / Google Places simply didn't index it — even though the
// calendar event itself names the correct place and overlaps the dwell in
// both time and space. Root cause: Châtelaillon-Plage 2026-07-24, "☕ Coffee
// — Chez Luly" 09:30-10:05 CEST, GPS candidates were "C & D Brasil" /
// "Miettes et Piquette" / "Villa Atlante" at the same address — none of them
// "Chez Luly" — so tier 2's containment check had nothing to match and fell
// through to "ask", using the wrong candidate names in the question.
//
// 2026-09-08: a second, related gap — tier 2b required `e.location` to be
// set, so an event with NO location field at all (a ticket/order confirmation
// whose venue address sits only in the description block) skipped this tier
// entirely regardless of what its description said. A proposed fix mandating
// every auto-created calendar event carry a location field was the wrong
// lever (not all calendar meetings will carry a location) — plenty
// of legitimate events (calls, internal blocks) never will. The right fix is
// on the reading side: try to determine the event's location from whatever
// text it actually has — title, location, AND description — before falling
// back to asking. Tiers 2 and 2b below now both read description too.
// City/borough names are deliberately excluded here, not just street-type
// words: within a single metro, EVERY address shares them, so they carry zero
// "is this actually the same place" evidence — exactly the opposite of what
// tier 2b uses this set for. The case: a comedy show's calendar event at a club
// overlapped four unrelated GPS-noise dwells that evening — near a hospital, a
// doctor's office half a mile off, and (worst) a stop 1.3km away near home —
// and every one of them shared the city token (the second word of a two-word city) with the
// event's own address, so tier 2b's "address correlates" check passed for all
// four and auto-confirmed every one of them as the show. A city token is 4+
// characters and isn't excluded by the length filter the way "new" and "ny"
// are, so it slipped through as if it were a real street match. The city words
// are the installation's own metros and their aliases (agent/local/config/
// travel.json metros[].aliases, a word at a time).
const METRO_WORDS = (localConfig("travel", { metros: [] }).metros || [])
  .flatMap((m) => [m && m.key, ...((m && m.aliases) || [])])
  .flatMap((a) => String(a || "").toLowerCase().split(/[^a-z0-9à-ÿ]+/))
  .filter(Boolean);
const ADDR_STOP = new Set([
  "rue", "avenue", "ave", "street", "st", "road", "rd", "blvd", "boulevard",
  "chemin", "place", "allee", "allée", "impasse", "quai", "the", "and",
  "de", "la", "le", "du", "des", "france",
  ...METRO_WORDS,
]);
function addrTokens(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^a-z0-9À-ÿ ]/g, " ")
    .split(/\s+/)
    .filter((t) => t && (/^\d+$/.test(t) || (t.length >= 4 && !ADDR_STOP.has(t))));
}
function stripLeadingEmoji(s) {
  return String(s || "")
    .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\s]+/u, "")
    .trim();
}
// "☕ Coffee — Chez Luly" -> "Chez Luly"; falls back to the stripped title
// when there's no "<activity> — <venue>" separator.
function eventVenueTitle(summary) {
  const stripped = stripLeadingEmoji(summary);
  const m = stripped.match(/[—–-]\s*(.+)$/);
  return m && m[1].trim().length >= 2 ? m[1].trim() : stripped;
}

// Asks the on-device model whether any of the given (already time-windowed)
// messages explicitly names a venue the user is/was at. This is a language
// judgment — what did the user say, in the user's own words — so it goes to Gemma rather
// than a hand-written trigger-phrase regex (see tier 3b below). The window
// filter that selects `windowMsgs` stays plain code: that's geometry (a time
// range), not meaning.
async function messageVenueViaModel(windowMsgs) {
  const msgBlock = windowMsgs.map((m) => `- [${m.at}] ${m.body}`).join("\n");
  const prompt = `Below are ${OWNER}'s own phone messages from around the time of a location dwell. Does any of them state, in ${OWNER}'s own words, the specific place/venue ${OWNER} is or was at (a restaurant, cafe, shop, or other named spot)? Ignore messages that don't name a place.

Messages:
${msgBlock}

Reply with ONE LINE of compact JSON, no prose, no markdown fence:
{"venue":"<exact venue name as written, or empty string if none>"}`;
  try {
    const out = (await localLlmChat({
      system: "You are a strict information-extraction classifier. Output ONLY one line of compact JSON matching the requested schema — no prose, no markdown, no code fence.",
      user: prompt,
      maxTokens: 100,
      timeoutMs: 6000,
      think: false,
    })).trim();
    if (!out) return null;
    const m = out.match(/\{[\s\S]*?\}/); // lang-regex-ok: extracts the JSON envelope the model replied with, does not interpret the user's words
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const venue = String(parsed.venue || "").trim();
    return venue.length >= 2 ? venue : null;
  } catch { return null; }
}

// ─── Jev tail (2026-09-23) ─────────────────────────────────────────────────
// Tiers 3b/4 below are resolved by lib/location-confirm-jev.mjs: Jev
// primary, the old Gemma-extraction → ask tail as legacy shadow/fallback. See
// that file's header.
// Returns {decision, venue?, reasoning, source} or null (centroid missing → defer).
async function localResolve(centroid, cands, cal, msgs, dwellWindow, ctx = {}) {
  if (!centroid || typeof centroid.lat !== "number") return null;
  const names = cands.map((c) => c.name);
  const lc = names.map((n) => String(n).toLowerCase());

  // 1) Favorite/frequent memory: confirmed stops near the centroid whose name is a candidate.
  const near = {};
  for (const s of loadConfirmedStops()) {
    if (!s.centroid || typeof s.centroid.lat !== "number") continue;
    if (haversineM(centroid.lat, centroid.lon, s.centroid.lat, s.centroid.lon) > MEM_RADIUS_M) continue;
    const i = lc.indexOf(String(s.name || "").toLowerCase());
    if (i >= 0) near[names[i]] = (near[names[i]] || 0) + 1;
  }
  const mem = Object.entries(near).sort((a, b) => b[1] - a[1])[0];
  if (mem) return { decision: "auto_confirm", venue: mem[0], reasoning: `frequent stop (${mem[1]}x confirmed ≤${MEM_RADIUS_M}m)`, source: "local:memory" };

  // 2) Calendar: an opaque event's location, title, OR description contains
  // a candidate name (≥4 chars). Description is included (2026-09-08) because
  // ticket/order confirmations frequently name the venue only in the
  // description block and never set a location field at all — requiring a
  // location field is the wrong fix; checking everything the event actually
  // carries before giving up is the right one.
  for (const e of (cal || [])) {
    const hay = `${e.location || ""} ${e.summary || ""} ${e.description || ""}`.toLowerCase();
    for (let i = 0; i < lc.length; i++) if (lc[i].length >= 4 && hay.includes(lc[i]))
      return { decision: "auto_confirm", venue: names[i], reasoning: `calendar "${(e.summary || "").slice(0, 60)}" matches`, source: "local:calendar" };
  }

  // 2b) Calendar-title fallback: an opaque event whose time window overlaps
  // the dwell AND whose location shares an address token with a nearby GPS
  // candidate — use the EVENT'S OWN TITLE as the venue even when it never
  // appeared in the candidate list (small local businesses OSM/Google Places
  // don't index). The address-token overlap is the "is this actually the
  // same place" check standing in for a geocode we don't have on hand.
  if (dwellWindow && typeof dwellWindow.startMs === "number" && typeof dwellWindow.endMs === "number") {
    const candAddrTokens = cands.map((c) => new Set(addrTokens(c.address)));
    for (const e of (cal || [])) {
      // 2026-09-08: read address tokens off location AND description, not
      // location alone — a ticket/order confirmation routinely has no
      // location field at all, with the venue address sitting in the
      // description block instead (order-info text). Skipping the whole
      // event whenever location is empty threw that address away.
      const locationText = `${e.location || ""} ${e.description || ""}`;
      if (!locationText.trim()) continue;
      const evStartMs = e.start ? Date.parse(e.start) : NaN;
      const evEndMs = e.end ? Date.parse(e.end) : NaN;
      if (Number.isNaN(evStartMs) || Number.isNaN(evEndMs)) continue;
      if (!(evStartMs < dwellWindow.endMs && evEndMs > dwellWindow.startMs)) continue; // no time overlap with the actual dwell
      const evTokens = addrTokens(locationText);
      if (evTokens.length === 0) continue;
      const correlates = candAddrTokens.some((set) => evTokens.some((t) => set.has(t)));
      if (!correlates) continue;
      const venue = eventVenueTitle(e.summary);
      if (!venue) continue;
      return { decision: "auto_confirm", venue, reasoning: `calendar "${(e.summary || "").slice(0, 60)}" overlaps dwell + address match`, source: "local:calendar_title" };
    }
  }

  // 3) Did the user already say where, today? (2026-10-20, replaces "a recent
  // message contains a candidate name".) That substring tier never ran — the
  // message query selected a column that does not exist — and once the query
  // works it would read Jori's own lines ("You're near the old port") and
  // "not Mazzo" alike as the user naming a place. Whether the user's words name THIS
  // dwell's place is a reading, so a model does it (Rule #0b), over the whole
  // day's chat and the calendar: lib/stated-place.mjs. `ctx.stated` is
  // that call, bound by the caller; absent (the --resolve-only hatch) it is
  // skipped. Any failure falls through to the tail, never to silence.
  if (typeof ctx.stated === "function") {
    let st = null;
    try { st = await ctx.stated(); } catch {}
    // Only a Claude rung's answer is acted on here: the trigger turns every
    // auto_confirm into `location-confirm save`, a durable write, and the
    // on-device rung's reading is not trusted with one (stated-place header).
    if (st && st.settled && st.venue && st.venue.name && st.venue.durable !== false) {
      const v = st.venue;
      const said = v.source === "chat" ? `he said "${String(v.quote || "").slice(0, 80)}"` : `calendar "${String(v.quote || "").slice(0, 80)}"`;
      return { decision: "auto_confirm", venue: v.name, reasoning: `${said} (stated-${st.tier || "?"})`, source: `stated:${v.source}` };
    }
  }

  // 3b/4) Whatever is left is a language judgment over the evidence. It used to
  // be tier 3b — a hand-written trigger-phrase regex (2026-07-29, missed
  // "Lunch at Numidia." on 08-01 — Rule #0b), then on-device Gemma
  // extraction — and tier 4, ask. Both now live in legacyTail(), which is the
  // shadow/fallback for the Jev decision in resolveTail() (lib/location-confirm-jev.mjs).
  return resolveTail({ cands, cal, msgs, dwellWindow, wiki: ctx.wiki, askId: ctx.askId, centroid, durationMin: ctx.durationMin,
    extractVenueFrom: messageVenueViaModel });
}

// ─── `--resolve-only` — a TEST HATCH, not a normal entry point ────────────
// Usage: echo '{"centroid":{...},"candidates":[...],"calendarEvents":[...],
//               "messages":[...],"dwellWindow":{"startMs":...,"endMs":...}}' \
//          | location-confirm-resolve.mjs --resolve-only
//
// Calls `localResolve()` directly with caller-supplied inputs and prints its
// decision, so the memory/calendar/message tiers can be exercised
// deterministically without the `gog calendar` / wiki / Ollama round-trips
// the normal pipeline makes below. `loadConfirmedStops()` still reads the
// real data/confirmed-stops.json (tier 1 has no network dependency to
// stub), so a test relying on tier 1 should pick a centroid nowhere near a
// live entry.
if (process.argv.includes("--resolve-only")) {
  let payload = null;
  try { payload = JSON.parse(readFileSync(0, "utf8")); } catch {}
  if (!payload || typeof payload !== "object") {
    process.stderr.write("location-confirm-resolve --resolve-only: invalid stdin payload\n");
    process.exit(2);
  }
  try {
    // payload.stated: a canned statedPlace() verdict, so tier 3 is testable
    // without a model call.
    const r = await localResolve(
      payload.centroid, payload.candidates || [], payload.calendarEvents || [],
      payload.messages || [], payload.dwellWindow || null,
      payload.stated ? { stated: async () => payload.stated } : {},
    );
    process.stdout.write(JSON.stringify(r || { decision: "ask", reasoning: "no_centroid" }));
    process.exit(0);
  } catch (err) {
    const msg = String((err && err.message) || err);
    process.stderr.write(`location-confirm-resolve --resolve-only: ${msg}\n`);
    process.exit(1);
  }
}

// ─── `--promote-safely-only` — a TEST HATCH, not a normal entry point ─────
// Usage: echo '{"ask":<ask json>,"decision":"auto_confirm","venue":"…",
//               "candidates":[…],"source":"local:memory"}' \
//          | location-confirm-resolve.mjs --promote-safely-only
//
// Calls promoteSafely() directly — the same gate the live pipeline runs
// every localResolve()/kill-switch decision through — so the
// GROUNDED_PROMOTION_SOURCES allowlist can be exercised deterministically
// against a temp fixture (JORI_CONFIRMED_STOPS_FILE), without the
// calendar/Supabase/wiki/Ollama round-trips the normal pipeline makes.
// Unlike --promote-only below, this DOES enforce the decision/source gate —
// exercising that gate is the whole reason to test through here.
if (process.argv.includes("--promote-safely-only")) {
  let payload = null;
  try { payload = JSON.parse(readFileSync(0, "utf8")); } catch {}
  if (!payload || typeof payload !== "object") {
    process.stderr.write("location-confirm-resolve --promote-safely-only: invalid stdin payload\n");
    process.exit(2);
  }
  const r = promoteSafely(payload.ask || {}, payload.decision, payload.venue, payload.candidates || [], payload.source);
  process.stdout.write(JSON.stringify(r));
  process.exit(0);
}

// ─── `--promote-only` — a TEST AND REPAIR HATCH, not a normal entry point ──
// Usage: echo '{"ask":<ask json>,"venue":"…","candidates":[…]}' \
//          | location-confirm-resolve.mjs --promote-only
//
// Performs ONLY the durable promotion and exits, so the write can be exercised
// deterministically without the calendar / Supabase / wiki / Ollama round-trips
// the pipeline below makes.
//
// READ THIS BEFORE REACHING FOR IT: it writes whatever venue you hand it. It
// does NOT run localResolve, so it bypasses the `decision === "auto_confirm"`
// guard that is the whole reason the normal path is trustworthy — the caller
// becomes the evidence. Every other guard still applies (the canonical-saver
// stand-down, both dedups, the null-island check, the loud-failure contract),
// so the blast radius is one unverified name at one centroid. Use it from
// tests, or to hand-repair a mapping that was demonstrably lost. Never wire it
// into an automated path; wire that into the pipeline instead.
//
// Exits non-zero and writes to stderr when the store could not be read.
if (process.argv.includes("--promote-only")) {
  let payload = null;
  try { payload = JSON.parse(readFileSync(0, "utf8")); } catch {}
  if (!payload || typeof payload !== "object") {
    process.stderr.write("location-confirm-resolve --promote-only: invalid stdin payload\n");
    process.exit(2);
  }
  try {
    const r = promoteConfirmedStop(payload.ask || {}, payload.venue, payload.candidates || []);
    process.stdout.write(JSON.stringify(r));
    process.exit(0);
  } catch (err) {
    const msg = String((err && err.message) || err);
    process.stderr.write(`location-confirm-resolve --promote-only: ${msg}\n`);
    process.stdout.write(JSON.stringify({ promoted: false, error: msg }));
    process.exit(1);
  }
}

let raw = "";
try { raw = readFileSync(0, "utf8"); } catch {}
let ask;
try { ask = JSON.parse(raw); } catch { emit({ decision: "ask", reasoning: "invalid_input" }); }
if (!ask || typeof ask !== "object") emit({ decision: "ask", reasoning: "empty_input" });

const candidates = [];
if (ask.primary && ask.primary.name) candidates.push(ask.primary);
for (const c of (ask.alternatives || [])) if (c && c.name) candidates.push(c);
for (const c of (ask.candidates || [])) if (c && c.name && !candidates.some(x => x.name === c.name)) candidates.push(c);
if (candidates.length === 0) emit({ decision: "ask", reasoning: "no_candidates" });

const topCandidates = candidates.slice(0, 5);

// ─── Fetch calendar (±2h around the dwell) ────────────────────────────────
const dwellStart = ask.first_sample_ts ? new Date(ask.first_sample_ts) : new Date(Date.now() - 30 * 60 * 1000);
const dwellEnd   = ask.last_sample_ts  ? new Date(ask.last_sample_ts)  : new Date();
const calFrom = new Date(dwellStart.getTime() - 2 * 60 * 60 * 1000).toISOString();
const calTo   = new Date(dwellEnd.getTime()   + 2 * 60 * 60 * 1000).toISOString();

let calendarEvents = [];
try {
  const res = spawnSync(GOG, [
    "calendar", "list", "--json", "--results-only",
    "--from", calFrom, "--to", calTo, "--all",
  ], { encoding: "utf8", timeout: 8000 });
  if (res.status === 0 && res.stdout) {
    const parsed = JSON.parse(res.stdout);
    if (Array.isArray(parsed)) {
      calendarEvents = parsed
        .filter(e => (e.transparency || "opaque") !== "transparent")
        .map(e => ({
          summary: e.summary || "",
          location: e.location || "",
          // Capped (2026-09-08): descriptions can run long (e.g. guest
          // check-in/out task bodies) and this text feeds both the tier
          // 2/2b matchers and the Sonnet-fallback prompt below — a cap keeps
          // both bounded without losing the venue name/address a ticket
          // confirmation puts near the top of its order-info block.
          description: (e.description || "").slice(0, 500),
          start: e.start?.dateTime || e.start?.date || "",
          end:   e.end?.dateTime   || e.end?.date   || "",
        }));
    }
  }
} catch {}

// ─── Fetch phone-channel messages since dwell start (both roles) ─────────
// Anchor the lookback to the dwell start time, not "now - 90 min". This
// ensures that when an ask is queued during a quiet window and drained hours
// later, we still see conversation that happened during the original dwell.
// Cap at 4 hours max to avoid unbounded queries. Include both roles so
// agent confirmations ("Safe flight") are also visible.
// The column is `content` (2026-10-20). This selected `body`, which does not
// exist: every query 400'd, and the tiers below never saw a message. Chat
// channel only — the System and Improvements tabs are not the user's conversation.
// (The whole day is read separately, by statedPlace() below.)
let recentMessages = [];
const sbKey = readSupabaseKey();
if (sbKey) {
  try {
    const dwellStartMs = dwellStart.getTime();
    const fourHoursAgoMs = Date.now() - 4 * 60 * 60 * 1000;
    // From local midnight too: the Jev tail reads the user's earlier-today messages
    // (a plan for this dwell), and the stated-place step reads the day itself.
    const dayFrom = statedMod ? statedMod.readFromMs(dwellStartMs, userTimezone()) : fourHoursAgoMs;
    const since = new Date(Math.min(dwellStartMs - 5 * 60 * 1000, fourHoursAgoMs, dayFrom)).toISOString();
    const qs = new URLSearchParams({
      select: "role,content,created_at",
      channel: "eq.chat",
      "created_at": `gt.${since}`,
      order: "created_at.desc",
      limit: "200",
    });
    const url = `${SUPABASE_URL}/rest/v1/jori_messages?${qs}`;
    const resp = await fetch(url, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const rows = await resp.json();
      recentMessages = (rows || []).reverse()
        .filter(r => typeof r.content === "string" && r.content.length > 0)
        .map(r => ({ role: r.role || "user", body: r.content.slice(0, 400), at: r.created_at }));
    }
  } catch {}
}

// ─── Wiki search for each top candidate (one-shot, 1 result each) ────────
const wikiHits = [];
if (existsSync(WIKI_BIN)) {
  for (const cand of topCandidates) {
    try {
      const res = spawnSync(WIKI_BIN, ["search", cand.name, "--json", "--k", "1"], {
        encoding: "utf8", timeout: 5000,
      });
      if (res.status === 0 && res.stdout) {
        const parsed = JSON.parse(res.stdout);
        const top = (parsed.results || [])[0];
        if (top && top.id) {
          wikiHits.push({
            candidate: cand.name,
            page_id: top.id,
            title: top.title || top.id,
            snippet: (top.snippet || top.description || "").slice(0, 240),
          });
        }
      }
    } catch {}
  }
}

// ─── Local resolution (replaces the Sonnet fork) ─────────────────────────
// Runs unless the kill switch is present. On any local exception we fall through
// to the Sonnet path below — never blocks the pipeline.
if (!existsSync(LOCAL_OFF)) {
  try {
    // Sonnet → Opus only: the local rung's answer would not be acted on here
    // (see tier 3). From cron the first Claude rung reports not_logged_in and
    // the rest are skipped; the Jev tail, which reads earlier_today, decides.
    const stated = () => statedMod.statedPlace({
      sb: sbGet, start: dwellStart.getTime(), end: dwellEnd.getTime(), tz: userTimezone(),
      calendar: calendarEvents, id: ask.ask_id || null, tiers: ["sonnet", "opus"],
      places: topCandidates.map((c, i) => ({ id: `c${i + 1}`, name: c.name, type: c.primary_type || null,
        from_m: typeof c.distance_m === "number" ? Math.round(c.distance_m) : null })),
    });
    const lv = await localResolve(ask.centroid, topCandidates, calendarEvents, recentMessages, {
      startMs: dwellStart.getTime(),
      endMs: dwellEnd.getTime(),
    }, { wiki: wikiHits, askId: ask.ask_id || null, durationMin: ask.duration_min, stated: sbKey && statedMod ? stated : null });
    if (lv) {
      // Promote BEFORE emitting: emit() calls process.exit(), so anything
      // after it never runs.
      const promotion = promoteSafely(ask, lv.decision, lv.venue, topCandidates, lv.source);
      try {
        appendFileSync(LOCAL_LOG, JSON.stringify({
          ts: new Date().toISOString(), ask_id: ask.ask_id || null,
          centroid: ask.centroid || null, candidates: topCandidates.map((c) => c.name),
          decision: lv.decision, venue: lv.venue || "", reasoning: lv.reasoning, source: lv.source,
          promoted: promotion.promoted === true,
          promote_note: promotion.reason || promotion.error || null,
        }) + "\n");
      } catch {}
      emit({
        decision: lv.decision,
        venue: lv.venue || "",
        reasoning: lv.reasoning,
        source: lv.source,
        promoted: promotion.promoted === true,
        evidence: { calendar_events: calendarEvents.length, recent_messages: recentMessages.length, wiki_hits: wikiHits.length },
      });
    }
  } catch {}
}

// ─── Build the Sonnet prompt (kill-switch fallback / local exception) ─────
const dwellMin = Math.round(ask.duration_min || 0);
const candList = topCandidates.map((c, i) => `${i + 1}. ${c.name}${c.primary_type ? ` (${c.primary_type})` : ""}`).join("\n");

const calBlock = calendarEvents.length === 0
  ? "(no calendar events overlapping ±2h of the dwell)"
  : calendarEvents.map(e => `- "${e.summary}" @ "${e.location || "no location"}"${e.description ? ` — ${e.description.slice(0, 200)}` : ""}  [${e.start} → ${e.end}]`).join("\n");

const msgBlock = recentMessages.length === 0
  ? "(no phone messages since dwell start)"
  : recentMessages.slice(-40).map(m => `- [${m.at}] [${m.role}] ${m.body}`).join("\n");

const wikiBlock = wikiHits.length === 0
  ? "(no wiki pages matched any candidate)"
  : wikiHits.map(h => `- candidate "${h.candidate}" → wiki page "${h.title}" — ${h.snippet}`).join("\n");

const prompt = `You decide whether ${OWNER} is at one of the candidate venues below, using only the evidence provided. Do NOT search the web or invent context.

Dwell: ~${dwellMin} min at lat=${ask.centroid?.lat}, lon=${ask.centroid?.lon}.

Candidates (GPS-resolved, top first):
${candList}

Today's calendar events overlapping ±2h of the dwell window:
${calBlock}

Today's phone-channel conversation, latest 40 messages (both roles, oldest first):
${msgBlock}

Wiki pages matching candidate names:
${wikiBlock}

Decide:
- "auto_confirm" — if the evidence clearly names one candidate (calendar title/location matches, message says "heading to X" / "at X", wiki page confirms ${OWNER}'s relationship to it).
- "ask" — if the evidence is silent, ambiguous, or names something that isn't a candidate.

Reply with ONE LINE of compact JSON, no prose, no markdown fence. Schema:
{"decision":"auto_confirm"|"ask","venue":"<exact candidate name or empty>","reasoning":"<≤120 chars>"}

If decision is "auto_confirm", venue MUST be one of the candidate names verbatim. If "ask", venue is "".`;

// On-device fallback classifier — one Gemma inference, no tool use, zero Max
// cost. On any error (Ollama down, timeout, malformed output) we emit
// {decision:"ask"} so the caller falls through to the direct phrase + send.
let localOut = "";
try {
  localOut = (await localLlmChat({
    system: "You are a strict classifier. Output ONLY one line of compact JSON matching the requested schema — no prose, no markdown, no code fence.",
    user: prompt,
    maxTokens: 200,
    timeoutMs: 8000,
    think: false,
  })).trim();
} catch {}

if (!localOut) emit({ decision: "ask", reasoning: "local_llm_unavailable" });

// Strip possible fences / extract the first JSON object.
const match = localOut.match(/\{[\s\S]*?\}/);
if (!match) emit({ decision: "ask", reasoning: "local_llm_no_json" });

let parsed;
try { parsed = JSON.parse(match[0]); } catch { emit({ decision: "ask", reasoning: "local_llm_bad_json" }); }

if (parsed.decision === "auto_confirm") {
  const venue = (parsed.venue || "").trim();
  const allowed = topCandidates.map(c => c.name);
  if (!venue || !allowed.includes(venue)) {
    emit({ decision: "ask", reasoning: `local_llm_invalid_venue:"${venue}"` });
  }
  // Never grounded (see GROUNDED_PROMOTION_SOURCES above): this classifier is
  // reading ambiguous multi-source context, not matching a literal string
  // the user wrote — it can settle today's ask but must not self-confirm.
  const promotion = promoteSafely(ask, "auto_confirm", venue, topCandidates, "local_llm_fallback");
  emit({
    decision: "auto_confirm",
    venue,
    reasoning: (parsed.reasoning || "local_llm").slice(0, 200),
    source: "local_llm_fallback",
    promoted: promotion.promoted === true,
    evidence: {
      calendar_events: calendarEvents.length,
      recent_messages: recentMessages.length,
      wiki_hits: wikiHits.length,
    },
  });
}

emit({
  decision: "ask",
  reasoning: (parsed.reasoning || "local_llm_ask").slice(0, 200),
});
