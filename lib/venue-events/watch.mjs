// venue-events/watch.mjs — the shared pipeline every venue watch lane runs.
//
//   store (venue-ingest) → lane's groups/categories → drop what this lane has
//   already evaluated and what a sibling lane already surfaced → ONE batched
//   tool-less model call that ranks only the NEW candidates → code gates each
//   pick (travel in-city + headliner bypass, calendar-conflict-check,
//   availability) → code renders + delivers → code persists seen/surfaced.
//
// The model owns exactly the language/taste question — "is this a voice-forward
// singer", "would the user enjoy this comedian", "is this page saying sold
// out". Everything else was arithmetic or bookkeeping the old playbooks
// asked a full agent turn to do by hand.
//
// Rule #0b: no regex here decides what anything means. Name matching for the
// watchlist (lanes.mjs namesArtist) is entity matching of artist names against
// vendor event titles — and every hit is still confirmed by the model (a
// tribute act named after a watched artist is the model's call, not ours).

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { loadStore, eventsForGroups, readJson, writeJsonAtomic, SURFACED_PATH } from "./store.mjs";
import { slug, todayLocal } from "./normalize.mjs";
import { REPO, stripHtml } from "./fetchers.mjs";
import { homeMetro, metroTz } from "./config.mjs";

const require = createRequire(import.meta.url);
const BIN = (n) => path.join(REPO, "bin", n);
const { localConfig } = require("../instance.cjs");

export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "haiku";

// ─── seen / surfaced bookkeeping ───────────────────────────────────────────

/** Fingerprints an event is known by: its key, plus name|date forms that legacy seen files used. */
export function fingerprints(ev) {
  const fps = new Set();
  if (ev.key) fps.add(ev.key);
  if (ev.id) fps.add(String(ev.id));
  const d = ev.date || "undated";
  for (const n of [ev.title, ev.artist, ...(ev.performers || [])]) {
    if (n) fps.add(`${slug(n)}|${d}`);
  }
  return [...fps];
}

export function loadSeen(file) {
  const s = readJson(file, null) || {};
  return { last_run: s.last_run || "", seen: Array.isArray(s.seen) ? s.seen : flattenLegacy(s) };
}

// An older seen-file shape: {watchlist:[], discovery:[], comedy:[]}.
function flattenLegacy(s) {
  return ["watchlist", "discovery", "comedy"].flatMap((k) => (Array.isArray(s[k]) ? s[k].map((e) => ({ ...e, branch: k })) : []));
}

export function seenSet(entries) {
  const set = new Set();
  for (const e of entries) for (const fp of fingerprints(e)) set.add(fp);
  return set;
}

export function isKnown(ev, set) {
  return fingerprints(ev).some((fp) => set.has(fp));
}

export function loadSurfaced() {
  const s = readJson(SURFACED_PATH, null) || {};
  return Array.isArray(s.entries) ? s.entries : [];
}

// ─── gates (code owns geometry) ────────────────────────────────────────────

export function travelInCity(metro, date) {
  if (!date) return true;
  const r = spawnSync(BIN("travel"), ["in-city", metro, date], { stdio: "ignore", timeout: 30000 });
  return r.status !== 1; // 1 = away; anything else (error) fails open
}

export function isHeadliner(...names) {
  return names.filter(Boolean).some((n) => spawnSync(BIN("headliner"), ["check", n], { stdio: "ignore", timeout: 15000 }).status === 0);
}

/** Zone of an event's date/time, from its gate metro (venue-events metro_tz); null = the check's home-zone default. */
export function metroZone(metro) {
  try { return metroTz(metro); } catch { return null; }
}

// A soft block: one recurring calendar event the user can move (venue-watch
// config `soft_block`: {name, id_file, note}). Overlapping only that event never
// drops a pick; the pick is tagged with `note` instead. It is recognised by the
// stored series id (`id_file`'s calendar_event_id), else by `name` as a whole
// word in its title or an attendee's name / mailbox. No soft_block configured:
// every overlap is a conflict.
export function softBlockConfig() {
  const cfg = localConfig("venue-watch", { soft_block: null, lanes_file: null });
  let sb = cfg.soft_block;
  if (!sb && cfg.lanes_file) {
    try { sb = JSON.parse(fs.readFileSync(path.isAbsolute(cfg.lanes_file) ? cfg.lanes_file : path.join(REPO, cfg.lanes_file), "utf8")).soft_block; } catch { sb = null; }
  }
  return sb && sb.name ? sb : null;
}

const hasNameToken = (s, name) => !!s && !!name
  // lang-regex-ok: tokenising a calendar title/attendee field to find a configured participant's name, not reading meaning
  && String(s).toLowerCase().split(/[^a-z0-9]+/).includes(String(name).toLowerCase());

/** Is `ev` (a calendar event: {id, recurringEventId, summary, attendees[]}) the soft-block event? */
export function isSoftBlockEvent(ev, { name, knownId = null } = {}) {
  if (!ev || !name) return false;
  if (knownId && (ev.id === knownId || ev.recurringEventId === knownId ||
      String(ev.id || "").startsWith(`${knownId}_`))) return true;
  if (hasNameToken(ev.summary, name)) return true;
  for (const a of ev.attendees || []) {
    const email = typeof a === "string" ? a : a?.email;
    const dn = typeof a === "string" ? "" : a?.displayName;
    if (hasNameToken(dn, name)) return true;
    if (email && hasNameToken(String(email).split("@")[0], name)) return true;
  }
  return false;
}

function softBlockId(sb) {
  if (!sb?.id_file) return null;
  return readJson(path.isAbsolute(sb.id_file) ? sb.id_file : path.join(REPO, sb.id_file), {})?.calendar_event_id || null;
}

/**
 * → { conflict: something other than the soft-block event overlaps, softOnly }.
 * `date`/`time` are the event's own wall clock in `tz` (without it, a 21:00
 * show abroad was once checked at 04:00 the next morning, home time).
 * Any error, unparseable output or a missing calendar-conflict-check fails open: no conflict.
 */
export function calendarClash(date, time, tz = null, { softBlock = softBlockConfig(), knownId } = {}) {
  const clear = { conflict: false, softOnly: false };
  if (!date) return clear;
  const bin = BIN("calendar-conflict-check");
  if (!fs.existsSync(bin)) return clear;
  const args = [date];
  if (time) args.push("--time", time);
  if (tz) args.push("--tz", tz);
  args.push("--json");
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 60000 });
  if (r.status !== 1) return clear; // 0 = clear; anything else fails open
  let events;
  try { events = JSON.parse(r.stdout).events || []; } catch { return clear; }
  const id = knownId !== undefined ? knownId : softBlockId(softBlock);
  const hard = softBlock ? events.filter((ev) => !isSoftBlockEvent(ev, { name: softBlock.name, knownId: id })) : events;
  return { conflict: hard.length > 0, softOnly: hard.length === 0 && events.length > 0 };
}

/**
 * runLane's calendar step for one pick → { drop, tag }. A soft-block-only
 * overlap keeps it, tagged with the soft block's note, unless it is already
 * "worth the trip" (the lanes' pointers test that tag by value).
 */
export function calendarGate(ev, metro, tag = null, opts = {}) {
  const softBlock = opts.softBlock !== undefined ? opts.softBlock : softBlockConfig();
  const clash = calendarClash(ev.date, ev.time, metroZone(metro), { ...opts, softBlock });
  const note = softBlock?.note || "overlaps a movable calendar event";
  return { drop: clash.conflict, tag: clash.softOnly && !tag ? note : tag };
}

// ─── pre-model gates over many candidates ─────────────────────────────────

/**
 * Map(date → true|false): is the user in `metro` on that date. Same resolution
 * as `travel in-city <metro> <date>` (lib/presence.js), read once, so a lane
 * can drop the months the user is elsewhere before any model call.
 * Fail-open: an unresolvable date or a failed read is `true`.
 */
export async function presenceByDate(dates, metro, { presence = null } = {}) {
  const P = presence || require("../presence.js");
  const out = new Map();
  let segments = [], flights = [];
  try { segments = await P.fetchSegments(); flights = P.loadFlights(); }
  catch { for (const d of dates) out.set(d, true); return out; }
  const target = P.normalizeMetro(metro);
  for (const d of dates) {
    try {
      const res = P.resolvePresenceAt(P.parseWhen(d), segments, flights);
      const unknown = res.metro == null && !res.ambiguous;
      out.set(d, res.metro === target || (res.ambiguous && (res.candidates || []).includes(target)) || unknown);
    } catch { out.set(d, true); }
  }
  return out;
}

/**
 * A matcher over the tier-1 headliner list (`bin/headliner list`), loaded once.
 * The authoritative check stays `bin/headliner check` (runLane calls it on
 * every pick); this mirrors its normalization so a pre-filter over hundreds of
 * candidates does not spawn a process per row. No list: matches nothing.
 */
export function headlinerMatcher() {
  let artists = [];
  try {
    const r = spawnSync(BIN("headliner"), ["list", "--json"], { encoding: "utf8", timeout: 15000 });
    artists = JSON.parse(r.stdout || "[]");
  } catch { artists = []; }
  const norm = (s) => String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // lang-regex-ok: mirrors bin/headliner's key normalization of artist names
    .toLowerCase()
    .replace(/^the\s+/, "") // lang-regex-ok: mirrors bin/headliner's key normalization
    .replace(/[^a-z0-9]+/g, " ") // lang-regex-ok: mirrors bin/headliner's key normalization
    .trim();
  const keys = (Array.isArray(artists) ? artists : []).map(norm).filter(Boolean);
  return (...names) => names.filter(Boolean).some((n) => { const k = norm(n); return k && keys.some((a) => k.includes(a)); });
}

// ─── model ─────────────────────────────────────────────────────────────────

export async function judge(opts) {
  const { judge: run } = require("../max-judge.js");
  return run(opts);
}

/** Compact, token-cheap candidate rows with short ids the model must cite back. */
export function candidateRows(cands) {
  return cands.map((ev, i) => ({
    id: `c${i + 1}`,
    title: ev.title.slice(0, 160),
    ...(ev.performers?.length ? { performers: ev.performers.slice(0, 4) } : {}),
    venue: ev.venue,
    ...(ev.city && ev.city !== homeMetro() ? { city: ev.city } : {}),
    ...(ev.drive_min != null ? { drive_min: ev.drive_min, zone: ev.zone } : {}),
    date: ev.date,
    ...(ev.time ? { time: ev.time } : {}),
    ...(ev.category ? { category: ev.category } : {}),
    ...(ev.description ? { info: ev.description.slice(0, 220) } : {}),
    ...(ev.price_min != null ? { price_min: ev.price_min } : {}),
    ...(ev.branch ? { branch: ev.branch } : {}),
    ...(ev.headliner ? { tier1_headliner: true } : {}),
    ...(ev.run_dates > 1 ? { run_dates: ev.run_dates } : {}),
  }));
}

// ─── availability (a model reads the page; code fetches it) ────────────────

async function pageText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const html = await res.text();
    return stripHtml(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")).slice(0, 4000); // lang-regex-ok: dropping script/style blocks from fetched HTML
  } catch { return null; }
}

const AVAIL_SCHEMA = {
  type: "object", additionalProperties: false, required: ["pages"],
  properties: { pages: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["id", "status"],
    properties: { id: { type: "string" }, status: { type: "string", enum: ["available", "sold_out", "cancelled", "postponed", "unclear"] } },
  } } },
};

/**
 * Returns Map(key → "available"|"sold_out"|"cancelled"|"postponed"|"unclear").
 * A row whose fetcher marked `structured_status` (a ticketing API's own status
 * field) is decided by that field; only the rest get a page read, all in ONE
 * Haiku call.
 */
export async function availability(picks) {
  const out = new Map();
  const toRead = [];
  for (const ev of picks) {
    if (ev.status === "cancelled" || ev.status === "postponed" || ev.status === "sold_out") out.set(ev.key, ev.status);
    else if (ev.status === "onsale" && ev.structured_status) out.set(ev.key, "available");
    else toRead.push(ev);
  }
  if (!toRead.length) return out;
  const pages = [];
  for (const [i, ev] of toRead.entries()) {
    const text = ev.url ? await pageText(ev.url) : null;
    if (text) pages.push({ id: `p${i + 1}`, show: `${ev.title} — ${ev.date || ""}`, page_text: text });
    else out.set(ev.key, "unclear");
  }
  if (pages.length) {
    try {
      const res = await judge({
        model: HAIKU,
        system: "You read event/ticket web pages. For each page decide whether THAT show (title + date given) reads as available, sold out, cancelled, or postponed. If the page does not clearly say, answer unclear. Judge only the named show and date, not other dates on the page.",
        prompt: JSON.stringify({ pages }),
        schema: AVAIL_SCHEMA,
        timeoutMs: 120000,
      });
      for (const p of res.pages || []) {
        const idx = Number(String(p.id).slice(1)) - 1;
        const ev = toRead[idx];
        if (ev) out.set(ev.key, p.status);
      }
    } catch { /* fail open: unread pages stay unset → treated as unclear below */ }
  }
  for (const ev of toRead) if (!out.has(ev.key)) out.set(ev.key, "unclear");
  return out;
}

// ─── the pipeline ──────────────────────────────────────────────────────────

/**
 * @param lane   lane definition (see lanes.mjs)
 * @param opts   { dryRun, noModel, log }
 * @returns { evaluated, picks, delivered, reason }
 */
export async function runLane(lane, { dryRun = false, log = console.error } = {}) {
  const today = todayLocal();
  const store = loadStore();
  if (!store.updated_at) return { reason: "no venue store yet (venue-ingest has not run)" };

  const seenFile = path.join(REPO, lane.seenFile);
  const seen = loadSeen(seenFile);
  const known = seenSet(seen.seen);
  const surfaced = loadSurfaced();
  const siblingSet = seenSet(surfaced.filter((e) => (lane.siblings || []).includes(e.lane)));

  let pool = eventsForGroups(store, lane.groups, { today, horizonDays: lane.horizonDays || 120 })
    .filter((ev) => !lane.categories || lane.categories.includes(ev.category));
  if (lane.extraCandidates) pool = pool.concat(await lane.extraCandidates({ store, today, log }));
  if (lane.prepare) pool = await lane.prepare(pool, { today });

  // Dedup within the pool (two sources, one show), then against history.
  const byFp = new Set();
  const fresh = [];
  for (const ev of pool.sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    if (isKnown(ev, known) || isKnown(ev, siblingSet)) continue;
    const fps = fingerprints(ev);
    if (fps.some((fp) => byFp.has(fp))) continue;
    fps.forEach((fp) => byFp.add(fp));
    fresh.push(ev);
  }
  log(`[${lane.name}] pool ${pool.length}, new ${fresh.length}`);

  const batch = fresh.slice(0, lane.maxCandidates || 200); // the rest wait for the next run, unseen
  const persist = (picksDelivered) => {
    if (dryRun) return;
    const now = new Date().toISOString();
    const delivered = new Set(picksDelivered.map((p) => p.key));
    const added = batch.map((ev) => ({ key: ev.key, title: ev.title, performers: ev.performers, venue: ev.venue,
      date: ev.date, url: ev.url, first_seen: now, surfaced: delivered.has(ev.key), ...(ev.branch ? { branch: ev.branch } : {}) }));
    const keep = seen.seen.filter((e) => !e.date || e.date >= shift(today, -30)); // stale history is dead weight
    writeJsonAtomic(seenFile, { last_run: now, seen: keep.concat(added) });
    if (picksDelivered.length) {
      const entries = loadSurfaced().filter((e) => !e.date || e.date >= shift(today, -30))
        .concat(picksDelivered.map((p) => ({ key: p.key, lane: lane.name, title: p.title, performers: p.performers, date: p.date, surfaced_at: now })));
      writeJsonAtomic(SURFACED_PATH, { entries });
    }
  };

  if (!batch.length) { persist([]); return { evaluated: 0, picks: [], reason: "nothing new" }; }

  // ONE model call over the new candidates.
  const rows = candidateRows(batch);
  const byId = new Map(rows.map((r, i) => [r.id, batch[i]]));
  let result;
  try {
    result = await judge({ model: lane.model || SONNET, effort: lane.effort || "medium",
      system: lane.system(), prompt: lane.prompt(rows, { today }), schema: lane.schema, timeoutMs: 300000 });
  } catch (e) {
    log(`[${lane.name}] model call failed: ${e.message}`);
    // Nothing is marked seen: the same candidates get a fresh look next run.
    if (e.fatal) throw e;
    return { evaluated: 0, picks: [], reason: `model failed: ${e.message}` };
  }
  const picks = [];
  for (const p of result.picks || []) {
    const ev = byId.get(p.id); // grounding is structural: an id we did not hand out is ignored
    if (!ev || picks.some((x) => x.key === ev.key)) continue;
    // A lane's own structural rule on the model's choice (a regional lane: an
    // event outside its near zone only in its worth-the-drive section).
    if (lane.acceptPick && !lane.acceptPick({ ...ev, pick: p })) { log(`  drop (lane rule): ${ev.title} ${ev.date}`); continue; }
    picks.push({ ...ev, pick: p });
  }
  log(`[${lane.name}] model picked ${picks.length}`);

  // Gates: travel (with tier-1 bypass) → calendar conflict → availability.
  const gated = [];
  for (const ev of picks) {
    const metro = lane.metroFor ? lane.metroFor(ev) : homeMetro();
    let tag = null;
    if (!travelInCity(metro, ev.date)) {
      if (!isHeadliner(ev.title, ...(ev.performers || []))) { log(`  drop (away): ${ev.title} ${ev.date}`); continue; }
      tag = "worth the trip";
    }
    const cal = calendarGate(ev, metro, tag);
    if (cal.drop) { log(`  drop (calendar conflict): ${ev.title} ${ev.date}`); continue; }
    gated.push({ ...ev, tag: cal.tag });
  }
  const avail = await availability(gated);
  const final = [];
  for (const ev of gated) {
    const a = avail.get(ev.key);
    if (a === "sold_out" || a === "cancelled" || a === "postponed") { log(`  drop (${a}): ${ev.title}`); continue; }
    final.push({ ...ev, doubleCheck: a === "unclear" });
  }
  const capped = final.slice(0, lane.maxPicks || 10);

  if (!capped.length) { persist([]); return { evaluated: batch.length, picks: [], reason: "nothing survived the gates" }; }

  if (dryRun) {
    return { evaluated: batch.length, picks: capped.map((p) => ({ title: p.title, venue: p.venue, date: p.date, branch: p.pick.branch || p.pick.section, why: p.pick.why, tag: p.tag, doubleCheck: p.doubleCheck })), reason: "dry run" };
  }
  await lane.deliver(capped, { today, log });
  persist(capped);
  return { evaluated: batch.length, picks: capped.length, delivered: true };
}

function shift(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
