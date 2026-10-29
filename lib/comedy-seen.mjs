// comedy-seen.mjs — has the user already seen (or booked) this comedian this year?
//
// Requirement: never offer the same comedian twice in one calendar year (it is
// usually the same material) unless it is a new show; when unsure, offer it with
// a reminder of the last time.
//
// Two sources, merged:
//   - the calendar: every timed, non-tentative, non-declined event whose TITLE
//     names a roster comedian (ticket confirmations put the show on the calendar
//     with the performer in the title, so a booking counts the moment it exists)
//   - the sightings file (comedy-club-watch config `sightings_file`): sightings
//     the calendar cannot name (a club booking that names the room, not who
//     played), added with `comedian seen add`
//
// A sighting is a fact with a date; code owns the date arithmetic. Whether a
// new listing is a NEW SHOW (a new hour, special or tour) is language: this file
// only finds the earlier sighting and words the reminder, the Hits check decides.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { norm, keysFor, rosterHits } from "./comedy.mjs";

const require = createRequire(import.meta.url);
const { instance } = require("./instance.cjs");
const { comedyConfig } = require("./comedy-config.cjs");

const localDate = (instant, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz || instance().tz }).format(new Date(instant));

/** A timed event's own local date (the calendar API hands back the viewer's offset, not the event's). */
export function eventDate(e) {
  return e?.start?.dateTime ? localDate(e.start.dateTime, e.start.timeZone) : null;
}

// A calendar location opens with the venue's name ("Some Music Hall, 12 Main St")
// or, when it was typed as a street address, with a house number: that one names no venue.
const venueOf = (e) => {
  const first = String(e.location || "").split(",")[0].trim();
  return first && !/^\d/.test(first) ? first : null; // lang-regex-ok: leading house number of a calendar location string
};

/**
 * Calendar events → sightings of the comedians named in an event title.
 * Skipped: cancelled, tentative or "free" events, all-day events (an on-sale
 * reminder, not a seat), and anything the user declined. A configured
 * companion ({name, email}) on the invite, not declining, is named in `with`.
 */
export function calendarSightings(events, roster, { companions = comedyConfig().companions } = {}) {
  const out = [];
  for (const e of events || []) {
    if (!e?.summary || e.status === "cancelled" || e.status === "tentative" || e.transparency === "transparent") continue;
    const date = eventDate(e);
    if (!date) continue;
    const att = e.attendees || [];
    if (att.find((a) => a.self)?.responseStatus === "declined") continue;
    const withWho = (companions || []).find((p) => p?.email && att.some((a) => String(a.email || "").toLowerCase() === String(p.email).toLowerCase() && a.responseStatus !== "declined"));
    for (const c of rosterHits(e.summary, roster)) {
      out.push({ comedian: c.name, date, venue: venueOf(e), show: e.summary, with: withWho ? withWho.name : null, source: "calendar", event_id: e.id || null });
    }
  }
  return out;
}

/** The hand-kept sightings file (comedy-club-watch config `sightings_file`). */
export const seenFile = (file = null) => file || comedyConfig().sightings_file;

export function loadManual(file = null) {
  try { return (JSON.parse(fs.readFileSync(seenFile(file), "utf8")).sightings || []).filter((s) => s?.comedian && s?.date); }
  catch { return []; }
}

export function addManual(file, entry) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(seenFile(file), "utf8")); } catch { doc = null; }
  doc ||= { _comment: "Comedy sightings the calendar can't name (a club booking names the room, not who played). Read by lib/comedy-seen.mjs; add with `comedian seen add`. The calendar is read live, so ticketed shows with the performer in the event title need no entry here.", sightings: [] };
  doc.sightings = [...(doc.sightings || []), { ...entry, source: "manual" }]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  fs.writeFileSync(seenFile(file), JSON.stringify(doc, null, 2) + "\n");
}

/**
 * Every calendar event from Jan 1 of `fromYear` to the end of `toYear`.
 * Fail-open like every other gate: no calendar → no calendar sightings.
 */
export function fetchCalendarEvents(fromYear, toYear, { gog = process.env.COMEDY_SEEN_GOG || "gog", log = () => {} } = {}) {
  try {
    const out = execFileSync(gog, ["calendar", "events", "primary", "--from", `${fromYear}-01-01`, "--to", `${toYear + 1}-01-01`,
      "--all-pages", "--max", "250", "-j"], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(out).events || [];
  } catch (e) {
    log(`comedy-seen: calendar read failed, using the manual list only — ${String(e.message || e).slice(0, 120)}`);
    return [];
  }
}

/** All sightings of every comedian in `roster` for the years `today` is in and the next one. */
export function loadSightings({ file = null, roster, today, log, gog, companions }) {
  const y = Number(today.slice(0, 4));
  return [...loadManual(file), ...calendarSightings(fetchCalendarEvents(y, y + 1, { gog, log }), roster, companions ? { companions } : {})];
}

/** The sightings that belong to one roster entry (name or any aka). */
export function forComedian(entry, sightings) {
  const keys = new Set(keysFor(entry));
  return sightings.filter((s) => keys.has(norm(s.comedian)));
}

const dayLabel = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** The reminder that rides on a repeat: what the user saw, where, when, and with whom. */
export function reminder(last, comedian, today) {
  const who = `you${last.with ? ` and ${last.with}` : ""}`;
  const where = last.venue ? ` at ${last.venue}` : "";
  return last.date <= today
    ? `↺ ${who} saw ${comedian}${where} on ${dayLabel(last.date)}`
    : `↺ ${who} already have tickets to ${comedian}${where} on ${dayLabel(last.date)}`;
}

/**
 * One listing (`item.comedian` canonical, `item.date`) against that comedian's
 * sightings → what the lane should do:
 *   { already_booked }  the user is already going that very night → drop it
 *   { repeat, tag }     a different date in the same calendar year → the Hits
 *                       check decides "new show or the same material"
 *   {}                  nothing this year → carry on
 * `repeat` is the most recent sighting on or before today, else the next booked one.
 */
export function repeatCheck(item, sightings, today) {
  if (!item.date) return {};
  const same = sightings.find((s) => s.date === item.date);
  if (same) return { already_booked: same };
  const year = item.date.slice(0, 4);
  const inYear = sightings.filter((s) => s.date.slice(0, 4) === year);
  if (!inYear.length) return {};
  const past = inYear.filter((s) => s.date <= today).sort((a, b) => b.date.localeCompare(a.date));
  const last = past[0] || [...inYear].sort((a, b) => a.date.localeCompare(b.date))[0];
  return { repeat: last, tag: reminder(last, item.comedian, today) };
}
