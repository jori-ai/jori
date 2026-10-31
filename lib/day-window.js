"use strict";
// day-window — where a calendar day starts and ends in a given zone.
//
// One implementation of "which UTC window is date X", shared by resolve-day
// (location, photos, sleep), the daily-summary harvest and the chat fetch.
// The harvest and the chat fetch once carried their own copies, hard-wired to
// the home zone, while resolve-day followed the day's zone, so on a day spent
// seven hours east of home the first seven hours of chat, commits, mail and
// notes fell outside every window.
//
// The day is midnight-to-midnight in the zone the user was in when it began,
// so on a DST-change day it is 23 or 25 hours long. With no zone given, the
// installation's home zone (instance().tz).

const { instance } = require("./instance.cjs");

// The home zone, read per call so a test (or a host) can set JORI_TZ.
function defaultTz() {
  return instance().tz;
}
// The home zone when this module loaded (kept for callers that import it).
const DEFAULT_TZ = defaultTz();

// Offset of `tz` from UTC at instant `ms`, in minutes east of UTC. Intl prints
// it as "GMT-4", "GMT+5:30", or a bare "GMT" at zero.
function offsetMinAt(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
    .formatToParts(new Date(ms));
  const name = (parts.find((p) => p.type === "timeZoneName") || {}).value || "GMT";
  // lang-regex-ok: parses an Intl "GMT+5:30" offset token, machine-generated
  const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0));
}

/**
 * UTC instant (ms) of 00:00 on `date` (YYYY-MM-DD) in `tz`. The offset is read
 * at the instant being returned, not at noon, so the two days a year the clock
 * changes still land on the true midnight.
 */
function zonedMidnightMs(date, tz = defaultTz()) {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  const atNoon = offsetMinAt(Date.parse(`${date}T12:00:00Z`), tz);
  const guess = utcMidnight - atNoon * 60000;
  return utcMidnight - offsetMinAt(guess, tz) * 60000;
}

function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The window of `date` in `tz`: [start, end) as ISO strings and epoch ms. */
function dayWindow(date, tz = defaultTz(), days = 1) {
  const startMs = zonedMidnightMs(date, tz);
  const endMs = zonedMidnightMs(addDays(date, days), tz);
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), startMs, endMs, tz };
}

/**
 * The zone a resolved day was cut in: the day-path's own zone, else the zone
 * resolve-day displayed it in, else `fallback`. Everything that has to agree
 * with resolve-day about where the day starts reads it from here.
 */
function boundaryTzOf(resolved, fallback = defaultTz()) {
  return (resolved && resolved.path && resolved.path.tz) || (resolved && resolved.tz) || fallback;
}

module.exports = { DEFAULT_TZ, defaultTz, offsetMinAt, zonedMidnightMs, addDays, dayWindow, boundaryTzOf };
