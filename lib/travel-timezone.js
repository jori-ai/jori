"use strict";
// travel-timezone.js — best-effort IANA display timezone for the day the user
// was physically in, per the `travel` timeline (see the travel-schedule skill).
//
// The daily summary states every time in the user's local time, so the
// summary and everything that cuts a day (lib/day-window.js) ask here which
// zone a date belongs to instead of always using the home zone.
//
// This is only the day's DEFAULT zone: on a day that crosses zones,
// resolve-day re-states each stop in the zone at its own coordinates
// (geo-timezone.js timezoneForCoords), so each stop shows the local time
// where the user was at that moment.

const { spawnSync } = require("node:child_process");
const { toolsPath } = require("./root.cjs");
const { timezoneForMetro, COUNTRY_TZ } = require("./geo-timezone.js");
const { defaultTz, zonedMidnightMs } = require("./day-window.js");

const TRAVEL_BIN = toolsPath("bin", "travel");

// Fallback, matched against the `travel where --json` `label` field
// ("Springfield, France — ..."). The `metro` slug is tried first
// (geo-timezone.js): a lodging label is often just a street address that names
// no country, so a country match alone left such days on the home zone.
const COUNTRY_RES = [
  ...Object.entries(COUNTRY_TZ)
    .filter(([name]) => name.length > 2)
    .map(([name, tz]) => [new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), tz]),
  [/england|scotland|wales/i, COUNTRY_TZ["united kingdom"]],
];

// The home zone, read per call (JORI_TZ / instance().tz).
const DEFAULT_TZ = defaultTz();

// The zone for one `travel where --json` answer: the metro slug first (it names
// the city even when the label is only a street address), then a country in the
// label. Null when neither says. Pure.
function tzFromWhere(data) {
  const label = (data && data.label) || "";
  const byMetro = timezoneForMetro(data && data.metro, label);
  if (byMetro) return byMetro;
  // lang-regex-ok: a country name at the end of a machine-built timeline label
  for (const [re, tz] of COUNTRY_RES) {
    if (re.test(label)) return tz;
  }
  return null;
}

const isoZ = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");

// `travel where <YYYY-MM-DD>` answers for 19:00 home time on that date
// (presence.js parseWhen), which for a day spent far east of home is already
// the next morning there. On a flight day that instant is often mid-air
// ("transit"), which names no zone, so the later probes ask where the user was
// at 08:00 and at midnight home time: the day belongs to the zone it BEGAN in.
function probesFor(dateStr, homeTz = defaultTz()) {
  const midnight = zonedMidnightMs(dateStr, homeTz);
  return [dateStr, isoZ(midnight + 8 * 3600e3), isoZ(midnight)];
}

function whereAt(when) {
  const r = spawnSync(TRAVEL_BIN, ["where", when, "--json"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  return JSON.parse(r.stdout);
}

// Never throws — falls back to the home zone on any lookup failure or
// unrecognized place so callers can use this unconditionally.
function getDisplayTzForDate(dateStr, where = whereAt) {
  const home = defaultTz();
  try {
    for (const when of probesFor(dateStr, home)) {
      const tz = tzFromWhere(where(when));
      if (tz) return tz;
    }
    return home;
  } catch {
    return home;
  }
}

module.exports = { getDisplayTzForDate, tzFromWhere, probesFor, DEFAULT_TZ };
