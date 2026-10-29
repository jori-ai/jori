// calendar-presence-refresh.mjs — the producer for the calendar override
// (lib/calendar-presence.js has the why). It reads the user's calendar for
// yesterday → +HORIZON_DAYS, groups the events into one question per
// (home-zone day, timeline city), asks Jev per day "do these events show the
// user away from that city, and which events are the evidence", and writes
// data/calendar-presence-overrides.json for presence resolution to apply.
//
// Run lazily by `bin/travel` (refresh on read, chosen over a cron) when the
// file is older than REFRESH_TTL_MS, and by hand with `travel calendar-refresh`.
//
// Cost shape: a day's decision is cached under a hash of exactly what the model
// saw (its city + its events), so a refresh re-asks only days whose calendar
// changed. A steady-state refresh is one `gog calendar list` and no model call.
//
// Rule #0b: no regex or keyword test touches an event title anywhere here. The
// model decides; code owns which days, the window arithmetic and the file.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const CAL = require("./calendar-presence.js");
const P = require("./presence.js");

export const SITE = "calendar-presence";
const LOCK_STALE_MS = 2 * 60 * 1000;
const DEFAULT_BUDGET_MS = 15_000;
const CONCURRENCY = 6;
const RETRY_MS = 5 * 60 * 1000;

/** Calendar events in [fromIso, toIso) via the proven gog call (calendar-conflict-check). */
export function fetchCalendarEvents(fromIso, toIso, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("gog", ["calendar", "list", "--from", fromIso, "--to", toIso, "--max=2500", "--json"],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs },
      (err, out) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(out).events || []); } catch (e) { reject(e); }
      });
  });
}

const hhmm = (iso) => new Intl.DateTimeFormat("en-GB", { timeZone: CAL.homeTz(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** What Jev sees for one day: the timeline's city and the day's events, numbered. */
export function groupState(g) {
  return {
    date: g.date,
    timeline_city: g.base,
    times: `${CAL.homeTz()} wall clock`,
    events: g.events.map((e, n) => ({
      n, title: e.title,
      when: e.all_day ? "all day" : `${hhmm(e.start)}-${hhmm(e.end)}`,
      location: e.location, note: e.note, marked_free: e.free,
    })),
  };
}

/** One day-level boolean + one boolean per event, from the site's templates. */
export function groupQuestions(g, def) {
  // Fill {{name}} in every string of the template (instructions and criteria).
  const fill = (t, vars) => typeof t === "string"
    ? Object.entries(vars).reduce((s, [k, v]) => s.split(`{{${k}}}`).join(String(v)), t)
    : t && typeof t === "object" ? Object.fromEntries(Object.entries(t).map(([k, x]) => [k, fill(x, vars)])) : t;
  const q = { away: fill(def.away_question, { city: g.base, date: g.date }) };
  g.events.forEach((_, n) => { q[`e${n}`] = fill(def.event_question, { city: g.base, date: g.date, n }); });
  return q;
}

/**
 * Jev answers → { value: evidence event indexes ([] = no override), confidence }.
 * Confidence is the day-level answer's. "Away" with no event flagged is
 * incoherent, so it carries confidence 0 and falls to "no interpretation".
 */
export function interpretAnswers(answers, n, { boolOf, answerConfidence }) {
  const away = answers && answers.away;
  const conf = answerConfidence(away);
  if (boolOf(away) !== true) return { value: [], confidence: conf };
  const flagged = [];
  for (let i = 0; i < n; i++) if (boolOf(answers[`e${i}`]) === true) flagged.push(i);
  return flagged.length ? { value: flagged, confidence: conf } : { value: [], confidence: 0 };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

function readPrev(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * Build the override document. Everything external is injectable (tests):
 *   fetchEvents(fromIso, toIso) → gog events
 *   decideDay(group) → { flagged:number[], cacheable:boolean } | null (no decision possible)
 *   segments / flights → the timeline (default: live)
 */
export async function buildOverrides({
  nowMs = Date.now(), horizonDays = CAL.HORIZON_DAYS, prev = null, budgetMs = DEFAULT_BUDGET_MS,
  fetchEvents = fetchCalendarEvents, decideDay, segments, flights,
} = {}) {
  const t0 = Date.now();
  const today = CAL.etDate(nowMs);
  const fromDate = CAL.addDays(today, -1);
  const toDate = CAL.addDays(today, horizonDays);
  const segs = segments || await P.fetchSegments();
  const fl = flights || P.loadFlights();
  const events = await fetchEvents(new Date(CAL.etMidnightMs(fromDate)).toISOString(), new Date(CAL.etMidnightMs(CAL.addDays(toDate, 1))).toISOString());
  const groups = CAL.groupDays(events, (ms) => P.resolvePresenceAt(ms, segs, fl, nowMs), { fromDate, toDate });

  const prevDays = (prev && prev.days) || {};
  const days = {};
  let asked = 0, reused = 0, undecided = 0, offline = 0;
  await pool(groups, CONCURRENCY, async (g) => {
    const hash = CAL.groupHash(g);
    const cached = prevDays[g.key];
    if (cached && cached.hash === hash) { days[g.key] = cached; reused++; return; }
    if (Date.now() - t0 > budgetMs) { undecided++; return; }
    let d = null;
    try { d = await decideDay(g); } catch { d = null; }
    asked++;
    if (!d) { undecided++; return; }
    if (d.offline) { offline++; return; } // Jev off/unkeyed: no interpretation, nothing to retry
    const window = CAL.deriveWindow(g, d.flagged);
    const row = { hash, base: g.base, flagged: d.flagged, window, decided_by: d.decided_by || null, decided_at: new Date(nowMs).toISOString() };
    if (d.cacheable) days[g.key] = row;
    else { undecided++; if (window) days[g.key] = { ...row, hash: null }; } // used this round, re-asked next
  });

  const windows = Object.values(days).map((d) => d.window).filter(Boolean)
    .sort((a, b) => a.from.localeCompare(b.from));
  return {
    generated_at: new Date(nowMs).toISOString(),
    horizon: { from: fromDate, to: toDate },
    incomplete: undecided > 0,
    stats: { groups: groups.length, asked, reused, undecided, offline, windows: windows.length },
    windows,
    days,
  };
}

/** The live decideDay: Jev via decide(), legacy = no interpretation. */
export async function jevDecideDay(g) {
  const { decide, jevWouldRun } = await import("./jev-shadow.mjs");
  const { jevSiteDef, boolOf, answerConfidence } = await import("./jev.mjs");
  if (!jevWouldRun(SITE)) return { flagged: [], offline: true }; // Jev off/unkeyed → no interpretation
  const def = jevSiteDef(SITE);
  if (!def || !def.away_question || !def.event_question) return { flagged: [], offline: true };
  const r = await decide({
    site: SITE,
    id: g.key,
    state: groupState(g),
    questions: groupQuestions(g, def),
    interpret: (answers) => interpretAnswers(answers, g.events.length, { boolOf, answerConfidence }),
    // No model answer means no interpretation — exactly today's behaviour.
    legacy: async () => [],
    awaitShadow: false,
    jevTimeoutMs: 6000,
  });
  // A transport error is not a decision: never cache it.
  const cacheable = r.used === "jev" || r.reason === "jev-low-confidence";
  return { flagged: Array.isArray(r.value) ? r.value : [], cacheable, decided_by: r.used === "jev" ? "jev" : `none (${r.reason || r.used})` };
}

function writeAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function takeLock(lock) {
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
  } catch {}
  try { fs.closeSync(fs.openSync(lock, "wx")); return true; } catch { return false; }
}

/** True when the file should be rebuilt now: missing, older than the TTL, or left incomplete. */
export function needsRefresh({ file = CAL.OVERRIDE_FILE, nowMs = Date.now(), ttlMs = CAL.REFRESH_TTL_MS } = {}) {
  if (CAL.disabled()) return false;
  // A refresh that just failed (gog down, …) is not retried on every read: each
  // retry would put a dead calendar call on a hot gate.
  try { if (nowMs - fs.statSync(`${file}.failed`).mtimeMs < RETRY_MS) return false; } catch {}
  const j = readPrev(file);
  const gen = j && Date.parse(j.generated_at);
  if (!Number.isFinite(gen)) return true;
  if (j.incomplete) return nowMs - gen > RETRY_MS; // finish an interrupted build, at most every RETRY_MS
  return nowMs - gen > ttlMs;
}

/**
 * Refresh-on-read entry point. Never throws; returns a short status object.
 * Another process already refreshing → skip (the caller reads the current file).
 */
export async function maybeRefresh({ force = false, file = CAL.OVERRIDE_FILE, budgetMs = DEFAULT_BUDGET_MS, ...inject } = {}) {
  try {
    if (CAL.disabled()) return { refreshed: false, reason: "disabled" };
    if (!force && !needsRefresh({ file })) return { refreshed: false, reason: "fresh" };
    const lock = `${file}.lock`;
    if (!takeLock(lock)) return { refreshed: false, reason: "locked" };
    try {
      let doc;
      try {
        doc = await buildOverrides({ prev: readPrev(file), budgetMs, decideDay: jevDecideDay, ...inject });
      } catch (e) {
        // Leave the old file as it is (it ages out at MAX_AGE_MS) and back off.
        try { fs.writeFileSync(`${file}.failed`, `${new Date().toISOString()} ${String(e && e.message || e).slice(0, 300)}\n`); } catch {}
        throw e;
      }
      writeAtomic(file, doc);
      fs.rmSync(`${file}.failed`, { force: true });
      return { refreshed: true, stats: doc.stats, incomplete: doc.incomplete };
    } finally {
      fs.rmSync(lock, { force: true });
    }
  } catch (e) {
    return { refreshed: false, reason: `error: ${String(e && e.message || e).slice(0, 200)}` };
  }
}
