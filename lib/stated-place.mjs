// stated-place — before Jori asks where a stop was, has the user already said so today?
//
// The case: at 12:42 the user wrote of picking up family and meeting friends
// "for lunch at <restaurant> in the port". At 15:31 a card asked "13:31–14:52
// (80 min), after <the rental flat> — which of these was it?" and the user
// answered "If you know this, why did you ask?".
// Both ask paths had the answer within reach and missed it:
//   - location-confirm-resolve read jori_messages through a `body` column
//     that does not exist, so it had never seen a single message (its top
//     candidate that afternoon was the restaurant);
//   - stop-evidence read the chat from 10 minutes before the stop, and its
//     model is told a plan does not count. The message was 49 minutes before.
//
// This step reads the DAY: the user's chat messages since local midnight (from six
// hours before the stop when it starts in the small hours), each with the
// Jori message it answered, plus the timed calendar events around the
// window. A model decides whether any of it names where the user was during THIS
// window (Rule #0b: no pattern reads the user's words). Code owns the rest: which
// messages, the window, whether the words the model cites are really the user's,
// and the map check below.
//
// THE LADDER (as in bin/day-statements): on-device gemma3:1b, then
// Sonnet, then Opus, climbing only when a rung's answer fails validation, all
// inside DEADLINE_MS. A 1B model may settle only a positive naming a listed
// nearby place, and that answer is not `durable`: callers may name the stop
// from it but never write a confirmation (placing a plan in the right window
// is beyond a 1B model, and confirmed-stops.json names anything within 30 m
// for good). Its "no" is not evidence, so it climbs.
//
// CODE-OWNED CHECKS on a positive:
//   - the quote must be found in what was read: the user's own message for `chat`,
//     the event's own text for `calendar`. That is provenance, not reading
//     (day-statements does the same), and it stops an invented place;
//   - a plan (said before the stop began) or a calendar entry must name one of
//     the businesses actually near where the user stopped. Plans change; the map is
//     the witness. Something the user said during or after the stop stands on the user's
//     word alone.
//
// Callers: lib/stop-evidence.mjs evidenceVerdict (reached from
// bin/stop-passage, before every segment-ask card and findme-enrich
// question) and bin/location-confirm-resolve.mjs localResolve (the
// location-confirm cron). When the user's own words settle it on a Claude rung, both
// save through the confirm path, the same write the user's answer to the card would
// have made; a calendar-only or on-device answer only names the stop.
//
// Log and cache: data/stated-place-log.jsonl. An identical bundle read
// within CACHE_TTL_H reuses its answer, so the 15-minute re-runs of the ask
// paths (and twin visit rows) don't ask the model again.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runToollessDetailed, parseModelJson } from "./jev-claude.mjs";

const require = createRequire(import.meta.url);
const { instance } = require("./instance.cjs");
const { installTools } = require("./root.cjs");
// The owner as the transcript names them (instance owner_name).
const OWNER = instance().owner_name;

// The typography/accent fold bin/day-statements uses before its quote
// check, copied rather than required: a lib must not fail to load because a
// bin's own dependencies did. Folding is provenance, not reading the user's words.
const norm = (x) => String(x || "")
  .normalize("NFD").replace(/[\u0300-\u036F]/g, "")  // lang-regex-ok: folds accents before comparison
  .replace(/[\u2018\u2019\u201B\u02BC]/g, "'")       // lang-regex-ok: folds typography before comparison
  .replace(/[\u201C\u201D\u201E]/g, '"')              // lang-regex-ok: folds typography before comparison
  .replace(/[\u2013\u2014\u2212]/g, "-")              // lang-regex-ok: folds typography before comparison
  .replace(/\u2026/g, "...")                          // lang-regex-ok: folds typography before comparison
  .replace(/\s+/g, " ").trim().toLowerCase();         // lang-regex-ok: collapses whitespace before comparison
// How a model joins words from two messages (day-statements EVIDENCE_JOINS).
const QUOTE_JOINS = [" / ", "\u2026", "...", "\n"];

const DEFAULT_LOG = installTools("data", "stated-place-log.jsonl");
const logFile = () => process.env.JORI_STATED_PLACE_LOG || DEFAULT_LOG;

export const TIERS = ["local", "sonnet", "opus"];
export const ACCEPT_CONFIDENCE = 0.85;
/** A stop early in the morning still sees last night's plans. */
export const EARLY_LOOKBACK_H = 6;
/** The user often reports a stop after leaving it. */
export const CHAT_AFTER_MIN = 60;
/** Calendar events this close to the window are read. */
export const CAL_PAD_MIN = 30;
/** Said this close to the stop's start counts as said at the stop, not a plan. */
export const DURING_GRACE_MIN = 10;
export const CACHE_TTL_H = 36;
/** The whole ladder. The ask paths give stop-passage 150 s, photo probe and evidence step included. */
export const DEADLINE_MS = 75000;
const TIER_TIMEOUT_MS = { local: 15000, sonnet: 45000, opus: 60000 };
const MAX_ROWS = 400;
const MAX_LINES = 120;
const HIS_CHARS = 600;
const JORI_CHARS = 240;
/** A Jori message is shown as context only for a reply that came within this. */
const CONTEXT_GAP_MS = 6 * 3600e3;

// ---------------------------------------------------------------------------
// Time. The window and every message are shown in the day's own timezone.
// ---------------------------------------------------------------------------
export function tzOffsetMs(tz, t) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(t)).reduce((a, x) => ({ ...a, [x.type]: x.value }), {});
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}

/** UTC ms of local midnight, in tz, of the day containing t. */
export function localDayStartMs(t, tz) {
  const local = t + tzOffsetMs(tz, t);
  const d = new Date(local);
  const midnightLocal = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnightLocal - tzOffsetMs(tz, midnightLocal - tzOffsetMs(tz, t));
}

/** Where the read starts: local midnight, or six hours back for a small-hours stop. */
export function readFromMs(start, tz) {
  return Math.min(localDayStartMs(start, tz), start - EARLY_LOOKBACK_H * 3600e3);
}

const hhmm = (t, tz) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t));
const ymd = (t, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));

// ---------------------------------------------------------------------------
// What was said. The user's messages, each with the Jori message it answered —
// "בוטיקפה" alone reads like a place for any window; after "08:55–09:54 …
// which of these was it?" it is plainly the morning's answer.
// ---------------------------------------------------------------------------
/** An uploaded image link. Structure (a URL into our own bucket), not language. */
function isAttachment(content) {
  let u;
  try { u = new URL(String(content || "").trim()); } catch { return false; }
  return u.protocol === "https:" && u.pathname.includes(`/storage/v1/object/public/${instance().attachments_bucket}/`);
}

export function buildTranscript(rows) {
  const sorted = (rows || []).filter((r) => r && r.created_at)
    .map((r) => ({ t: Date.parse(r.created_at), role: r.role, content: String(r.content || "") }))
    .filter((r) => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
  const lines = [];
  let lastJori = null, shown = null;
  for (const r of sorted) {
    if (r.role !== "user") { lastJori = r; continue; }
    if (lastJori && lastJori !== shown && r.t - lastJori.t <= CONTEXT_GAP_MS) {
      lines.push({ t: lastJori.t, who: "Jori", text: lastJori.content.slice(0, JORI_CHARS) });
      shown = lastJori;
    }
    lines.push({ t: r.t, who: OWNER, text: isAttachment(r.content) ? "[sent a photo]" : r.content.slice(0, HIS_CHARS) });
  }
  return lines.slice(-MAX_LINES);
}

/** Timed (not all-day) events overlapping the window ± CAL_PAD_MIN. */
export function timedEvents(calendar, start, end) {
  const pad = CAL_PAD_MIN * 60000;
  return (calendar || []).filter((e) => {
    const s = String(e.start || ""), f = String(e.end || "");
    if (!s.includes("T") || !f.includes("T")) return false; // an all-day "Jerusalem" is a day plan, not a place
    const a = Date.parse(s), b = Date.parse(f);
    return Number.isFinite(a) && Number.isFinite(b) && a < end + pad && b > start - pad;
  }).map((e) => ({ title: String(e.summary || e.title || ""), location: String(e.location || ""),
    description: String(e.description || "").slice(0, 300), start: Date.parse(e.start), end: Date.parse(e.end) }));
}

// ---------------------------------------------------------------------------
// The question.
// ---------------------------------------------------------------------------
const SCHEMA = `{"named": true|false, "venue": "<the place, as a map pin would label it>"|null, "listed_id": "<id from places_nearby when it is that business>"|null, "source": "chat"|"calendar"|null, "quote": "<the user's exact words, or the calendar event's exact title/location, copied verbatim>"|null, "said_at": "<HH:MM of the user's message>"|null, "confidence": <0..1>, "basis": "<one sentence>"}`;

export function buildPrompt({ start, end, tz, lines, events, places }) {
  const mins = Math.round((end - start) / 60000);
  const chat = lines.length
    ? lines.map((l) => `[${hhmm(l.t, tz)}] ${l.who === OWNER ? "USER" : "jori"}: ${l.text.split("\n").join(" ")}`).join("\n")
    : "(the user sent nothing today)";
  const cal = events.length
    ? events.map((e) => `- ${hhmm(e.start, tz)}–${hhmm(e.end, tz)} "${e.title}"${e.location ? ` @ ${e.location}` : ""}${e.description ? ` — ${e.description.split("\n").join(" ")}` : ""}`).join("\n")
    : "(no timed events around the stop)";
  const near = places.length
    ? places.map((p) => `- ${p.id}: ${p.name}${p.type ? ` (${String(p.type).split("_").join(" ")})` : ""}${p.from_m != null ? `, ${p.from_m} m` : ""}`).join("\n")
    : "(none known)";
  return `${OWNER}'s phone recorded a stop on ${ymd(start, tz)} from ${hhmm(start, tz)} to ${hhmm(end, tz)} (${mins} min), local time (${tz}). ${OWNER} is "the user" below; the user's chat lines are marked USER. Before Jori asks the user where it was, decide whether the user ALREADY told Jori where they would be or were during that stop — in today's chat or on their calendar.

It counts when:
- the user says where they are or were at that time ("we're at X", "had lunch at X");
- earlier today the user said where they were going for that time, and the stop fits it ("meeting them for lunch at X" before a stop over lunchtime; "heading to X" shortly before the stop began);
- a calendar event during the stop names the place in its title, location or description.

It does NOT count:
- a place the user named for a different time or a different stop (an answer to a question about another stop, where the user had coffee this morning);
- a recommendation, an idea, somewhere talked about, somewhere the user said they would not go;
- a plan the stop's time does not fit (a dinner plan for a morning stop);
- anything only Jori said ("You're near the old port"). Jori's lines are shown only so you can see what the user was answering.
If two places could fit, or you are not sure, answer named:false. A wrong confident name is worse than asking.

places_nearby are businesses near where the phone stopped, with distances. Use them to recognise the place the user named (the spelling may differ, or be in another language or script) and give its id when it is the same business. For a place that is not listed, spell venue exactly as the user wrote it.

Answer with ONLY one JSON object, no prose:
${SCHEMA}

Today's chat (oldest first):
${chat}

Calendar around the stop:
${cal}

places_nearby:
${near}`;
}

// ---------------------------------------------------------------------------
// Validation — code, on the model's answer. Returns {ok:false, why} (the rung
// failed, climb) or {ok:true, settled, venue?, reason}.
// ---------------------------------------------------------------------------
// Every piece must be real words of the user's (3+ characters) and one must carry
// meaning (6+), so "ok" can never pass as a quote.
function quotePieces(quote) {
  let parts = [String(quote || "")];
  for (const join of QUOTE_JOINS) parts = parts.flatMap((p) => p.split(join));
  const pieces = parts.map((p) => norm(p)).filter(Boolean);
  if (!pieces.length || pieces.some((p) => p.length < 3) || Math.max(...pieces.map((p) => p.length)) < 6) return [];
  return pieces;
}
function containsAll(text, pieces) {
  const hay = norm(text);
  return pieces.length > 0 && pieces.every((p) => hay.includes(p));
}

export function checkAnswer(ans, { lines, events, places, start }, tier) {
  if (!ans || typeof ans !== "object" || typeof ans.named !== "boolean") return { ok: false, why: "not the schema" };
  if (!ans.named) {
    if (tier === "local") return { ok: false, why: "a 1B model's no is not evidence" };
    return { ok: true, settled: false, reason: String(ans.basis || "nothing the user said names it").slice(0, 200) };
  }
  const venue = typeof ans.venue === "string" ? ans.venue.trim() : "";
  if (!venue || venue.length > 120) return { ok: false, why: "named without a usable venue" };
  if (!["chat", "calendar"].includes(ans.source)) return { ok: false, why: `source ${JSON.stringify(ans.source)}` };
  if (typeof ans.confidence !== "number" || !(ans.confidence >= 0 && ans.confidence <= 1)) return { ok: false, why: "no confidence" };
  const listedId = ans.listed_id == null || ans.listed_id === "" ? null : String(ans.listed_id);
  const listed = listedId ? places.find((p) => p.id === listedId) : null;
  if (listedId && !listed) return { ok: false, why: `listed_id ${listedId} is not a nearby place` };

  // Provenance: the words must be there.
  const pieces = quotePieces(ans.quote);
  let saidAt = null;
  if (ans.source === "chat") {
    // Every piece in one of HIS messages (the model may join two with " / ").
    // When the earliest of them came before the stop, it is treated as a plan.
    const his = lines.filter((l) => l.who === OWNER);
    const hits = pieces.map((p) => his.find((l) => containsAll(l.text, [p])));
    if (!pieces.length || hits.some((h) => !h)) {
      return { ok: false, why: `quote is not in the user's messages: ${JSON.stringify(String(ans.quote || "").slice(0, 60))}` };
    }
    saidAt = Math.min(...hits.map((h) => h.t));
    // A name not on the map must be HIS spelling, from the words quoted.
    if (!listedId && !hits.some((h) => norm(h.text).includes(norm(venue)))) {
      return { ok: false, why: `unlisted venue ${JSON.stringify(venue)} is not in the words quoted` };
    }
  } else {
    const ev = events.find((e) => containsAll(`${e.title} ${e.location} ${e.description}`, pieces));
    if (!ev) return { ok: false, why: "quote is not in a calendar event around the stop" };
  }

  if (tier === "local" && !listed) return { ok: false, why: "the local rung may only settle a listed place" };
  if (ans.confidence < ACCEPT_CONFIDENCE) {
    if (tier === "local") return { ok: false, why: `local not sure (${ans.confidence})` };
    return { ok: true, settled: false, reason: `named ${venue} but not sure (${ans.confidence})` };
  }
  // The map check. A plan or a calendar entry must name a place that is there.
  const plan = ans.source === "calendar" || saidAt < start - DURING_GRACE_MIN * 60000;
  if (plan && !listed) {
    return { ok: true, settled: false,
      reason: `${ans.source === "calendar" ? "calendar" : "the user's plan"} names ${venue}, which is not among the places where the user stopped` };
  }
  return { ok: true, settled: true, reason: String(ans.basis || "").slice(0, 200),
    venue: { name: listed ? listed.name : venue, listed: !!listed, listed_id: listed ? listed.id : null,
      source: ans.source, plan, durable: tier !== "local", confidence: ans.confidence, quote: String(ans.quote || "").slice(0, 200),
      said_at: saidAt, basis: String(ans.basis || "").slice(0, 200) } };
}

// ---------------------------------------------------------------------------
// The rungs.
// ---------------------------------------------------------------------------
export async function runTier(tier, prompt, timeoutMs = TIER_TIMEOUT_MS[tier]) {
  if (tier === "local") {
    const { localLlmChat } = await import("./local-llm.mjs");
    return localLlmChat({
      system: "You read messages and answer with exactly one JSON object. No prose, no markdown, no code fence.",
      user: prompt, maxTokens: 400, timeoutMs, temperature: 0.2, think: false, numCtx: 8192,
    });
  }
  const { MODELS } = require("./models.cjs");
  const { out, error } = await runToollessDetailed({ model: MODELS[tier], prompt, effort: "low", timeoutMs });
  if (error) throw new Error(`${error.kind}: ${error.message}`);
  return out;
}

// ---------------------------------------------------------------------------
// Log + cache.
// ---------------------------------------------------------------------------
function readCache(hash, now) {
  try {
    const f = logFile(), size = fs.statSync(f).size, len = Math.min(size, 1024 * 1024);
    const fd = fs.openSync(f, "r"), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    for (const l of buf.toString("utf8").split("\n").reverse()) {
      if (!l.includes(hash)) continue;
      try {
        const r = JSON.parse(l);
        if (r.hash === hash && r.result && now - Date.parse(r.ts) <= CACHE_TTL_H * 3600e3) return r.result;
      } catch {}
    }
  } catch {}
  return null;
}

function writeLog(row) {
  try { fs.appendFileSync(logFile(), JSON.stringify(row) + "\n"); } catch {}
}

/**
 * Has the user already named this stop's place? Never throws for a model failure;
 * returns {settled:false, reason} and the caller asks as before.
 *
 * @param sb        Supabase REST GET (path+query → rows)
 * @param places    [{id, name, type?, from_m?}] businesses near where the user stopped
 * @param calendar  [{summary, location, description, start, end}] (any range; filtered here)
 * @param asOf      read only what had been said by then (the nightly audit)
 * @returns {Promise<{settled:boolean, venue?, tier?, reason:string, summary, attempts?, cached?}>}
 */
export async function statedPlace({ sb, start, end, tz, places = [], calendar = [], asOf = null, id = null,
  tiers = TIERS, run = runTier, now = Date.now(), cache = true, deadlineMs = DEADLINE_MS }) {
  const from = readFromMs(start, tz);
  const to = Math.min(end + CHAT_AFTER_MIN * 60000, asOf ?? Infinity, now);
  const q = encodeURIComponent;
  let rows;
  try {
    rows = await sb(`jori_messages?channel=eq.chat&created_at=gte.${q(new Date(from).toISOString())}`
      + `&created_at=lte.${q(new Date(to).toISOString())}&select=role,content,created_at&order=created_at.asc&limit=${MAX_ROWS}`);
  } catch (e) {
    return { settled: false, reason: `chat unreadable: ${String(e.message || e).slice(0, 120)}`, summary: {} };
  }
  const lines = buildTranscript(rows);
  const events = timedEvents(calendar, start, end);
  const summary = { his_messages: lines.filter((l) => l.who === OWNER).length, calendar_events: events.length, places: places.length };
  if (!summary.his_messages && !events.length) return { settled: false, reason: "the user said nothing today and nothing is on the calendar", summary };

  const prompt = buildPrompt({ start, end, tz, lines, events, places });
  const hash = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 20);
  const cached = cache ? readCache(hash, now) : null;
  if (cached) return { ...cached, summary, cached: true };

  const ctx = { lines, events, places, start };
  const attempts = [];
  let result = null;
  let noMax = false;
  const deadline = Date.now() + deadlineMs;
  for (const tier of tiers) {
    // Without the Max login (a cron child) every Claude rung fails the same way.
    if (noMax && tier !== "local") { attempts.push({ tier, error: "skipped: not logged in" }); continue; }
    const left = deadline - Date.now();
    if (left < 5000) { attempts.push({ tier, error: "skipped: out of time" }); continue; }
    let raw;
    try { raw = await run(tier, prompt, Math.min(TIER_TIMEOUT_MS[tier] || 60000, left)); }
    catch (e) {
      const msg = String(e.message || e);
      if (msg.startsWith("not_logged_in")) noMax = true;
      attempts.push({ tier, error: msg.slice(0, 160) });
      continue;
    }
    const chk = checkAnswer(parseModelJson(raw), ctx, tier);
    if (!chk.ok) { attempts.push({ tier, error: chk.why }); continue; }
    attempts.push({ tier, ok: true });
    result = { settled: chk.settled, tier, reason: chk.reason, ...(chk.venue ? { venue: chk.venue } : {}) };
    break;
  }
  const window = { start: new Date(start).toISOString(), end: new Date(end).toISOString(), tz };
  if (!result) {
    // Not cached: a dead rung is transient, and the next run should try again.
    writeLog({ ts: new Date(now).toISOString(), id, window, hash, summary, attempts, settled: false });
    return { settled: false, reason: "no rung gave a usable answer", summary, attempts };
  }
  writeLog({ ts: new Date(now).toISOString(), id, window, hash, summary, attempts, result });
  return { ...result, summary, attempts };
}
