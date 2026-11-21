// meeting-event.mjs — is this calendar event one of the user's recurring meetings?
//
// Shared by bin/meeting-calendar-check (the morning state refresh), the daily
// summary's call line (lib/meeting-call.mjs) and planners that treat an
// overlap with the meeting as a soft block, not a conflict.
//
// This is entity identification on calendar metadata, not interpretation of
// anything the user said: the meeting is a known recurring event, and the
// test is whether one of its configured words (the counterpart's name, by
// default) is a whole token of the title, an attendee's display name or an
// attendee's mailbox. The stored series id (the meeting's state file) is
// checked first, so a renamed instance of the same series still matches.
//
// Also here: who an event is actually with (eventPeople / eventPeopleLine),
// read from the event's organizer and guests and never from its title. The
// hum calendar lane, the speak gate and resolve-first show it beside every
// event so a person the title names by first name is checked against the
// event itself.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function hasToken(s, tokens) {
  if (!s || !tokens || !tokens.length) return false;
  // lang-regex-ok: tokenising a calendar title/attendee field to find a configured participant's name, not reading meaning
  const words = String(s).toLowerCase().split(/[^a-z0-9]+/);
  return tokens.some((t) => words.includes(t));
}

/**
 * @param {object} ev  gog/Google Calendar event ({id, recurringEventId, summary, attendees[]})
 * @param {object} m   a meeting from lib/meetings.mjs (uses m.calendar_match), or {calendar_match: [...]}
 * @param {string|null} knownId  the series id from the meeting's state file, if any
 */
export function isMeetingEvent(ev, m, knownId = null) {
  if (!ev || !m) return false;
  if (knownId && (ev.id === knownId || ev.recurringEventId === knownId ||
      String(ev.id || "").startsWith(`${knownId}_`))) return true;
  const tokens = (m.calendar_match || []).map((t) => String(t).toLowerCase());
  if (hasToken(ev.summary, tokens)) return true;
  for (const a of ev.attendees || []) {
    const email = typeof a === "string" ? a : a?.email;
    const name = typeof a === "string" ? "" : a?.displayName;
    if (hasToken(name, tokens)) return true;
    if (email && hasToken(String(email).split("@")[0], tokens)) return true;
  }
  return false;
}

// Calendar-service addresses that are rooms, groups or imports, not people.
const NOT_A_PERSON = ["@group.calendar.google.com", "@resource.calendar.google.com", "@import.calendar.google.com"];

function ownerEmail() {
  try { return String(require("./instance.cjs").instance().owner_email || "").toLowerCase(); } catch { return ""; }
}

const person = (p) => ({ name: String(p.displayName || "").trim() || null, email: String(p.email || "").trim() });
const isPerson = (p, owner) => {
  if (!p || !p.email || p.self || p.resource) return false;
  const e = String(p.email).toLowerCase();
  return e !== owner && !NOT_A_PERSON.some((s) => e.endsWith(s));
};

/**
 * The people on a calendar event other than the owner.
 * @param {object} e a Google Calendar event (`gog calendar list --json`)
 * @param {{ownerEmails?: string[]}} [opts]
 * @returns {{organizer: {name:string|null,email:string}|null, guests: {name:string|null,email:string}[]}}
 */
export function eventPeople(e, { ownerEmails } = {}) {
  const owners = new Set([ownerEmail(), ...(ownerEmails || []).map((x) => String(x).toLowerCase())].filter(Boolean));
  const mine = (p) => owners.has(String(p.email || "").toLowerCase());
  const o = e && e.organizer;
  const organizer = o && isPerson(o, "") && !mine(o) && !o.self ? person(o) : null;
  const seen = new Set(organizer ? [organizer.email.toLowerCase()] : []);
  const guests = [];
  for (const a of (e && Array.isArray(e.attendees) ? e.attendees : [])) {
    if (!isPerson(a, "") || mine(a)) continue;
    const k = String(a.email).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    guests.push(person(a));
  }
  return { organizer, guests };
}

const label = (p) => (p.name ? `${p.name} <${p.email}>` : p.email);

/**
 * One short line for a calendar listing: "invite from X; guests: Y, Z", or ""
 * when the event lists nobody but the owner. An event with no such line names
 * nobody: whoever the title calls by a first name is not identified by it.
 */
export function eventPeopleLine(e, opts) {
  const { organizer, guests } = eventPeople(e, opts);
  const bits = [];
  if (organizer) bits.push(`invite from ${label(organizer)}`);
  if (guests.length) bits.push(`guests: ${guests.slice(0, 8).map(label).join(", ")}${guests.length > 8 ? ` (+${guests.length - 8} more)` : ""}`);
  return bits.join("; ");
}
