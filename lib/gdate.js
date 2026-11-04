"use strict";
// gdate — the single deterministic source of truth for dates and days-of-week
// across Jori. Everything is anchored to the installation's home time zone
// (instance().tz).
//
// WHY THIS EXISTS: dozens of files hand-rolled their own home-zone Intl
// helpers, and the agent repeatedly computed day-of-week / relative dates "in
// its head" and got them wrong. The requirement: never reason about a date
// mentally — call this module (or the `gdate` CLI that wraps it) and quote
// what it returns verbatim.
//
// Pure, dependency-free, no network, no LLM. Calendar-date weekday math is done
// with UTC arithmetic so it is timezone-independent and never rolls over.

const TZ = require("./instance.cjs").instance().tz;
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DOW_ABBR = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

// Today's calendar date in the home zone, as 'YYYY-MM-DD'.
function todayISO(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

function assertISO(iso) {
  if (!ISO_RE.test(iso)) throw new Error(`not an ISO date (YYYY-MM-DD): ${iso}`);
  const [y, m, d] = iso.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d)
    throw new Error(`not a real calendar date: ${iso}`);
  return iso;
}

// Day-of-week NUMBER (0=Sun..6=Sat) for a calendar date — TZ-independent.
function dowNum(iso) {
  const [y, m, d] = assertISO(iso).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
// Day-of-week NAME ('Sunday'..'Saturday').
function dow(iso) { return DOW[dowNum(iso)]; }

// iso + n days (n may be negative).
function addDays(iso, n) {
  const [y, m, d] = assertISO(iso).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(n));
  return dt.toISOString().slice(0, 10);
}

// Whole-day difference B - A (integer; positive if B is later).
function diffDays(isoA, isoB) {
  const a = new Date(`${assertISO(isoA)}T00:00:00Z`);
  const b = new Date(`${assertISO(isoB)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

// Resolve a relative/natural expression to an ISO date (anchored to today in the home zone,
// or to `anchor` if given). Supported:
//   today | tomorrow | yesterday
//   +Nd | -Nd  (also +Nw / -Nw weeks)
//   next <weekday> | last <weekday> | this <weekday> | <weekday>
//   a bare ISO date (returned as-is after validation)
function resolve(expr, anchor) {
  const base = anchor ? assertISO(anchor) : todayISO();
  if (expr == null) return base;
  const s = String(expr).trim().toLowerCase();
  if (s === "" || s === "today" || s === "now") return base;
  if (s === "tomorrow") return addDays(base, 1);
  if (s === "yesterday") return addDays(base, -1);
  if (ISO_RE.test(s)) return assertISO(s);

  let mm = s.match(/^([+-]\d+)\s*([dw])?$/);
  if (mm) return addDays(base, Number(mm[1]) * (mm[2] === "w" ? 7 : 1));

  mm = s.match(/^(next|last|this)?\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/);
  if (mm) {
    const dir = mm[1] || "next";
    const target = DOW_ABBR[mm[2]];
    const cur = dowNum(base);
    if (dir === "this") {
      // same ISO week (Mon-anchored): move to the target weekday within it
      const mondayOffset = (cur === 0 ? -6 : 1 - cur);
      const monday = addDays(base, mondayOffset);
      const tIdx = target === 0 ? 6 : target - 1; // Mon=0..Sun=6
      return addDays(monday, tIdx);
    }
    let delta = (target - cur + 7) % 7;
    if (dir === "next") delta = delta === 0 ? 7 : delta;       // strictly future
    if (dir === "last") { delta = (cur - target + 7) % 7; delta = delta === 0 ? 7 : delta; return addDays(base, -delta); }
    return addDays(base, delta);
  }
  throw new Error(`cannot parse date expression: ${expr}`);
}

// Full structured description of a resolved date.
function describe(expr, anchor) {
  const iso = resolve(expr, anchor);
  // Anchor "today" to the same reference resolve() used, so is_today /
  // days_from_today stay consistent with iso (and describe is deterministic
  // when an anchor is injected). Mirrors resolve()'s base handling.
  const today = anchor ? assertISO(anchor) : todayISO();
  return {
    iso,
    weekday: dow(iso),
    dow_num: dowNum(iso),
    is_today: iso === today,
    days_from_today: diffDays(today, iso),
    tz: TZ,
  };
}

module.exports = { TZ, DOW, todayISO, dow, dowNum, addDays, diffDays, resolve, describe, assertISO };
