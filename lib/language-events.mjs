// language-events — events performed in the user's languages, wherever the
// user is.
//
// The city lanes (venue-watch, organizer-watch, …) each cover one city. This
// lane covers every city the travel timeline (with the calendar override) puts
// the user in over the coming weeks — home, a second home, any trip city — and
// looks for stand-up, theatre, talks, storytelling and concerts performed in
// one of the configured languages. An agent job drives it (its playbook does
// the searching).
//
// THE SPLIT (Rule #0b). The agent's turn does the language work: the web
// searches, reading each listing, judging that it is performed in one of the
// languages and fits the user's taste. This file does the geometry and
// bookkeeping:
//   - stays: which city the user is in on which date (timeline + calendar
//     override, sampled at 20:00 in that city's own zone);
//   - gate: each candidate's date against that city (+ the tier-1 headliner
//     bypass, tagged "worth the trip"), the calendar clash (comedy keeps the
//     show with a note naming the clash; everything else drops), what this
//     lane already sent and what a sibling lane already surfaced;
//   - one item per performer: a performer's several dates become one entry.
// Nothing here reads what a listing says. `language` is a field the agent set.
//
// Config: agent/local/config/language-events.json
//   languages          language codes a candidate may carry (default none: the
//                      gate keeps nothing — off, not broken)
//   horizon_days       how far ahead the stays reach (default 42)
//   pointer_hours      [from, to) local hours a chat pointer may go out (default [8, 22])
//   soft_block_meeting a recurring meeting id (agent/local/config/meetings.json)
//                      whose overlap alone is not a clash (default none)
//
// State: data/language-events-seen.json → { last_run, seen: [{ key,
// performer, title, metro, date, url, surfaced_at }] } (key = performer|metro|date).

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("./presence.js");
const CAL = require("./calendar-presence.js");
const { timezoneForMetro } = require("./geo-timezone.js");
const { writeJsonAtomic } = require("./atomic-write.js");
const { instance, localConfig } = require("./instance.cjs");
const { installRoot } = require("./root.cjs");

export const REPO = process.env.JORI_REPO || installRoot();
export const DATA = process.env.JORI_DATA_DIR || path.join(REPO, "data");
export const SEEN_FILE = () => process.env.LANGUAGE_EVENTS_SEEN_FILE || path.join(DATA, "language-events-seen.json");
export const SURFACED_FILE = () => process.env.VENUE_SURFACED_FILE || path.join(DATA, "venue-surfaced-state.json");

const DEFAULTS = { languages: [], horizon_days: 42, pointer_hours: [8, 22], soft_block_meeting: null };

/** This installation's language-events settings (no languages: the gate keeps nothing). */
export function languageConfig() {
  return localConfig("language-events", DEFAULTS);
}

const CFG = languageConfig();
/** How far ahead the lane looks. */
export const HORIZON_DAYS = Number(CFG.horizon_days) || 42;
export const LANGUAGES = new Set(CFG.languages || []);
export const WORTH_THE_TRIP = "worth the trip";
/** A chat pointer only when it is daytime where the user is (the run is overnight). */
export const POINTER_HOURS = Array.isArray(CFG.pointer_hours) && CFG.pointer_hours.length === 2 ? CFG.pointer_hours : [8, 22];
/** The installation's home zone: the default wall clock. */
export const homeTz = () => instance().tz || "UTC";

// ─── time geometry ─────────────────────────────────────────────────────────

function tzOffsetMs(ms, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant of `date` `time` on the wall clock of `tz` (ms). */
export function localInstantMs(date, time = "20:00", tz = homeTz()) {
  const [y, m, d] = String(date).split("-").map(Number);
  const [hh, mm] = String(time || "20:00").split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh || 0, mm || 0);
  let ms = guess - tzOffsetMs(guess, tz);
  ms = guess - tzOffsetMs(ms, tz); // settle across a DST edge
  return ms;
}

/** "YYYY-MM-DD" of `ms` on the wall clock of `tz`. */
export function localDate(ms, tz = homeTz()) {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: tz });
}

export function localHour(ms, tz = homeTz()) {
  return Number(new Date(ms).toLocaleString("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }));
}

export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function zoneFor(metro, label) {
  try { return timezoneForMetro(metro, label) || homeTz(); } catch { return homeTz(); }
}

// ─── stays: where the user is, date by date ──────────────────────────────────────

/**
 * Cities the user is in over the horizon, from the timeline (+ calendar override).
 * Each date is probed at noon UTC to find the city, then confirmed at 20:00 in
 * that city's own zone (an evening event is what the lane looks for). An
 * ambiguous stay ("home|coast") yields both cities; transit, unknown and a
 * calendar "elsewhere" yield none (there is no city to search).
 *
 * Pure given its inputs.
 * @returns {{ metro, label, tz, from, to, dates: string[] }[]} in date order
 */
export function buildStays({ segments = [], flights = [], overrides = null, fromDate, days = HORIZON_DAYS, nowMs = Date.now() }) {
  const at = (ms) => {
    let res = P.resolvePresenceAt(ms, segments, flights, nowMs);
    if (overrides) res = CAL.applyCalendarOverride(res, ms, overrides);
    return res;
  };
  const byMetro = new Map();
  for (let i = 0; i < days; i++) {
    const date = addDays(fromDate, i);
    // Probe the UTC day every 6 h for candidate cities (an arrival day can be
    // in transit at noon), then let the city's own evening decide.
    const cands = new Map();
    for (const hh of ["00", "06", "12", "18", "23"]) {
      const probe = at(Date.parse(`${date}T${hh}:00:00Z`));
      const ms = probe.ambiguous ? (probe.candidates || [])
        : (probe.metro && !["transit", "elsewhere"].includes(probe.metro) ? [probe.metro] : []);
      for (const m of ms) if (!cands.has(m)) cands.set(m, probe);
    }
    for (const [metro, probe] of cands) {
      const tz = zoneFor(metro, probe.label);
      const v = P.inCityVerdict(metro, at(localInstantMs(date, "20:00", tz)), { strict: true });
      if (!v.in) continue;
      const s = byMetro.get(metro) || { metro, label: probe.ambiguous ? metro : (probe.label || metro), tz, dates: [] };
      s.dates.push(date);
      byMetro.set(metro, s);
    }
  }
  // Split each city's dates into consecutive runs.
  const runs = [];
  for (const s of byMetro.values()) {
    let cur = null;
    for (const d of s.dates) {
      if (cur && addDays(cur.to, 1) === d) { cur.to = d; cur.dates.push(d); continue; }
      cur = { metro: s.metro, label: s.label, tz: s.tz, from: d, to: d, dates: [d] };
      runs.push(cur);
    }
  }
  return runs.sort((a, b) => a.from.localeCompare(b.from) || a.metro.localeCompare(b.metro));
}

export async function loadStays({ fromDate, days = HORIZON_DAYS, nowMs = Date.now() } = {}) {
  const [segments, flights] = [await P.fetchSegments(), P.loadFlights()];
  const overrides = CAL.loadOverrides();
  return buildStays({ segments, flights, overrides, fromDate: fromDate || localDate(nowMs), days, nowMs });
}

// ─── candidates ────────────────────────────────────────────────────────────

/**
 * Key for "the same performer". Entity normalization of a NAME the agent put in
 * a structured field — not interpretation of any text.
 */
export function performerKey(name) {
  return String(name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // lang-regex-ok: strips diacritics from a performer-name key (entity normalization, mirrors bin/headliner)
    .toLowerCase()
    .replace(/^the\s+/, "") // lang-regex-ok: performer-name key normalization, mirrors bin/headliner
    .replace(/[^\p{L}\p{N}]+/gu, " ") // lang-regex-ok: performer-name key normalization; keeps Hebrew letters
    .trim();
}

export function showKey(c) {
  return `${performerKey(c.performer || c.title)}|${P.normalizeMetro(c.city)}|${c.date}`;
}

/** Structural validation of one candidate the agent wrote. → reason string or null. */
export function invalidReason(c) {
  if (!c || typeof c !== "object") return "not an object";
  if (!c.performer && !c.title) return "no performer or title";
  if (!c.city) return "no city";
  // lang-regex-ok: shape of an ISO date the agent wrote into a structured field, not language
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.date || ""))) return "no YYYY-MM-DD date";
  if (!c.url) return "no event URL";
  if (!LANGUAGES.size) return "no languages configured (agent/local/config/language-events.json)";
  if (!LANGUAGES.has(c.language)) return `language "${c.language}" is not one of ${[...LANGUAGES].join(", ")}`;
  return null;
}

/**
 * Gate every candidate. Injected checks keep it testable:
 *   inCity(metro, isoInstant) → boolean   (travel in-city; fails open)
 *   isHeadliner(name) → boolean           (headliner check)
 *   clash(date, time, tz) → { conflict, label? }   (calendar-conflict-check)
 *   known(candidate) → boolean            (already sent by this lane or a sibling)
 * @returns {{ kept: object[], dropped: {candidate, reason}[] }}
 */
export function gateCandidates(cands, { inCity, isHeadliner, clash, known = () => false, today, horizonDays = HORIZON_DAYS + 30 }) {
  const kept = [], dropped = [];
  const seenKeys = new Set();
  const last = addDays(today, horizonDays);
  for (const c of cands || []) {
    const bad = invalidReason(c);
    if (bad) { dropped.push({ candidate: c, reason: `invalid: ${bad}` }); continue; }
    if (c.date < today || c.date > last) { dropped.push({ candidate: c, reason: "outside the window" }); continue; }
    const key = showKey(c);
    if (seenKeys.has(key)) { dropped.push({ candidate: c, reason: "duplicate in this run" }); continue; }
    seenKeys.add(key);
    if (known(c)) { dropped.push({ candidate: c, reason: "already surfaced" }); continue; }
    const metro = P.normalizeMetro(c.city);
    const tz = zoneFor(metro);
    const iso = new Date(localInstantMs(c.date, c.time || "20:00", tz)).toISOString();
    let tag = null;
    if (!inCity(metro, iso)) {
      if (isHeadliner(c.performer || c.title)) tag = WORTH_THE_TRIP;
      else { dropped.push({ candidate: c, reason: "away that date" }); continue; }
    }
    let note = null;
    const cl = clash(c.date, c.time || null, tz) || { conflict: false };
    if (cl.conflict) {
      // A clashing comedy show stays, with a note naming the clash (the user
      // decides whether to move the other thing). Every other kind drops.
      if (c.category === "comedy") note = `⚠︎ you already have ${cl.label || "something"} that night`;
      else { dropped.push({ candidate: c, reason: `calendar conflict${cl.label ? `: ${cl.label}` : ""}` }); continue; }
    }
    kept.push({ ...c, metro, tz, key, tag, clash_note: note });
  }
  return { kept, dropped };
}

/**
 * One item per performer: a performer's several dates (any city) become one
 * entry listing every show, earliest first. Entries are ordered by their
 * earliest show.
 */
export function groupByPerformer(kept) {
  const groups = new Map();
  for (const c of kept) {
    const k = performerKey(c.performer || c.title);
    const g = groups.get(k) || {
      performer: c.performer || c.title, category: c.category || null, language: c.language,
      why: c.why || null, shows: [],
    };
    g.shows.push({
      title: c.title || c.performer, date: c.date, time: c.time || null, venue: c.venue || null,
      city: c.city, metro: c.metro, url: c.url, key: c.key, tag: c.tag, clash_note: c.clash_note,
    });
    if (!g.why && c.why) g.why = c.why;
    groups.set(k, g);
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.shows.sort((a, b) => a.date.localeCompare(b.date) || String(a.time || "").localeCompare(String(b.time || "")));
    g.worth_the_trip = g.shows.some((s) => s.tag === WORTH_THE_TRIP);
  }
  return out.sort((a, b) => a.shows[0].date.localeCompare(b.shows[0].date));
}

/**
 * Which channel: a chat pointer + push only when something in the email is in
 * the city the user is in today (or is a tier-1 "worth the trip"), and it is
 * daytime there; otherwise the email alone (the away-today rule, ops-agent/CLAUDE.md
 * § Travel Timeline). `todayMetros` = cities the user is in today.
 */
export function channelFor(groups, { todayMetros = [], nowMs = Date.now(), todayTz = homeTz() } = {}) {
  if (!groups.length) return "none";
  const here = new Set(todayMetros);
  const relevant = groups.some((g) => g.worth_the_trip || g.shows.some((s) => here.has(s.metro)));
  const h = localHour(nowMs, todayTz);
  return relevant && h >= POINTER_HOURS[0] && h < POINTER_HOURS[1] ? "chat" : "email";
}

// ─── ledgers ───────────────────────────────────────────────────────────────

function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } }

export function loadSeen(file = SEEN_FILE()) {
  const s = readJson(file, {}) || {};
  return { last_run: s.last_run || null, seen: Array.isArray(s.seen) ? s.seen : [] };
}

/** Fingerprints a sibling lane's surfaced entry is known by (watch.mjs uses slug(name)|date). */
function siblingFingerprints(file = SURFACED_FILE()) {
  const s = readJson(file, {}) || {};
  const set = new Set();
  for (const e of Array.isArray(s.entries) ? s.entries : []) {
    for (const n of [e.title, ...(e.performers || [])]) if (n && e.date) set.add(`${performerKey(n)}|${e.date}`);
  }
  return set;
}

export function knownChecker({ seen = loadSeen().seen, surfacedFile = SURFACED_FILE() } = {}) {
  const mine = new Set(seen.map((e) => e.key));
  const siblings = siblingFingerprints(surfacedFile);
  return (c) => mine.has(showKey(c))
    || siblings.has(`${performerKey(c.performer)}|${c.date}`)
    || siblings.has(`${performerKey(c.title)}|${c.date}`);
}

export function recordSurfaced(groups, { file = SEEN_FILE(), nowMs = Date.now() } = {}) {
  const s = loadSeen(file);
  const at = new Date(nowMs).toISOString();
  const have = new Set(s.seen.map((e) => e.key));
  for (const g of groups) for (const sh of g.shows) {
    if (have.has(sh.key)) continue;
    s.seen.push({ key: sh.key, performer: g.performer, title: sh.title, metro: sh.metro, date: sh.date, url: sh.url, surfaced_at: at });
  }
  // Keep a year of history at most.
  const cutoff = addDays(localDate(nowMs), -365);
  s.seen = s.seen.filter((e) => !e.date || e.date >= cutoff).slice(-2000);
  writeJsonAtomic(file, { last_run: at, seen: s.seen });
  return s.seen.length;
}
