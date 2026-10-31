// meeting-call.mjs — the user's calls in a recurring meeting, for the daily summary.
//
// One meeting from lib/meetings.mjs at a time (`m`). The requirement: each call
// of the series that took place is its own line in the day's timeline, at its
// real time when Zoom knows it, else at the calendar's.
//
// A source ladder, then "when they happen":
//
//   1. Zoom actuals (real start/end/duration). The call runs in the user's OWN
//      Zoom room (the meeting's `zoom.room_id`), so the user is the host and a
//      Server-to-Server OAuth app on the account reads it (lib/zoom-client.mjs;
//      secrets/zoom-s2s.json, 0600). `zoomCalls()` lists the room's past
//      instances, takes the ones overlapping the calendar slot, and reads their
//      participants: a call is the instance(s) overlapping the slot IN WHICH
//      THE COUNTERPART WAS PRESENT (an email or Zoom display name from the
//      meeting's `zoom.participant`, compared in code on those structured
//      fields), never the first in a list. Present → the call, at their time
//      in the room. Only the user in the room, or no meeting at all, → it did
//      not happen and is left out. Someone there code cannot place (the
//      counterpart on a phone, a new display name) → that slot is the
//      calendar's. No credentials, any Zoom error, a timeout or a free plan →
//      null, one log line, and the calendar answers as before.
//   2. The calendar: the instance on the primary calendar, read through gog with
//      the local day's bounds stated explicitly, identified by
//      lib/meeting-event.mjs.
//
// A calendar slot alone does not prove the call ran. CODE leaves out what the
// records settle: an instance cancelled on the calendar, one the user declined,
// one that falls inside a flight on the travel timeline, and an in-person event
// that merely names the counterpart (only the series or a video link counts).
// A moved instance is read at its NEW time (the calendar's own start), never at
// its original slot. What the meeting notes and the user's own words
// (day-statements, and the user's chat messages that day) say about it is
// language, so a MODEL reads them: bin/meeting-call-reading runs as its own
// step and leaves its reading in /tmp/<prefix>-calls-<date>.json. With no
// reading there is no interpretation: the call ships worded as scheduled,
// never as a fact. A call Zoom answered for needs no reading.
//
// The call only. Nothing here reads or returns what was discussed; the notes are
// shown to the reading model to decide held / not held and its answer is a
// label (plus, for a call it says did not happen, the words that say so).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { isMeetingEvent } from "./meeting-event.mjs";
import { knownSeriesId } from "./meetings.mjs";
import { loadCredentials, createZoomClient, meetingIdFromUrl, ZoomError } from "./zoom-client.mjs";

const require = createRequire(import.meta.url);
const { instance } = require("./instance.cjs");
const { installTools } = require("./root.cjs");

const GOG = process.env.GOG_BIN || (fs.existsSync("/opt/homebrew/bin/gog") ? "/opt/homebrew/bin/gog" : "gog");
const calAccount = () => process.env.JORI_CAL_ACCOUNT || instance().owner_email;
const TRAVEL_BIN = installTools("bin/travel");
const homeTz = () => instance().tz;

export const VERDICTS = ["held", "not_held", "no_word"];

// ---------------------------------------------------------------------------
// The local day (the same arithmetic as the installation's day-window helper)
// ---------------------------------------------------------------------------

function offsetMinAt(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date(ms));
  const name = (parts.find((p) => p.type === "timeZoneName") || {}).value || "GMT";
  // lang-regex-ok: parses an Intl "GMT+5:30" offset token, machine-generated
  const x = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name);
  if (!x) return 0;
  return (x[1] === "-" ? -1 : 1) * (parseInt(x[2], 10) * 60 + (x[3] ? parseInt(x[3], 10) : 0));
}
function zonedMidnightMs(date, tz) {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  const guess = utcMidnight - offsetMinAt(Date.parse(`${date}T12:00:00Z`), tz) * 60000;
  return utcMidnight - offsetMinAt(guess, tz) * 60000;
}
export function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** [start, end) of `date` in `tz`, as ISO strings and epoch ms. */
export function dayWindow(date, tz) {
  const startMs = zonedMidnightMs(date, tz), endMs = zonedMidnightMs(addDays(date, 1), tz);
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), startMs, endMs, tz };
}

export function readingPath(m, date, dir = process.env.MEETING_CALL_READING_DIR || "/tmp") {
  return path.join(dir, `${m.tmp_prefix}-calls-${date}.json`);
}
export function talkPath(m, date, dir = process.env.MEETING_CALL_READING_DIR || "/tmp") {
  return path.join(dir, `${m.tmp_prefix}-call-talk-${date}.json`);
}

// ---------------------------------------------------------------------------
// 1. Zoom — what the user's own room recorded (lib/zoom-client.mjs does the HTTP)
// ---------------------------------------------------------------------------

const ZOOM_GRACE_MS = 30 * 60_000;      // a call up to 30 min off its slot still overlaps it
const ZOOM_LOOKBACK_MS = 4 * 3600_000;  // instances that began up to 4h before a slot are checked
const ZOOM_SETTLE_MS = 2 * 3600_000;    // Zoom is asked about a slot once it ended 2h ago
const ZOOM_HISTORY_DAYS = 30;           // a room empty for 30 days means Zoom is not showing it
const ZOOM_MIN_PRESENT_MS = 60_000;     // under a minute in the room is a stray join, not a call

const foldName = (s) => String(s || "").toLowerCase().split(" ").filter(Boolean).join(" ");
const squash = (s) => foldName(s).split(" ").join("");

/** The meeting's counterpart as Zoom shows them: {emails, names}. */
export const participantIds = (m) => (m && m.zoom && m.zoom.participant) || { emails: [], names: [] };

/**
 * How this participant record is the counterpart ("email" / "name"), or null.
 * Compared in code, field by field: the email exactly, the display name folded
 * for case and spacing and compared whole. Zoom often leaves a guest's email
 * empty, so the name carries most matches. Waiting room never counts.
 */
export function participantMatch(p, ids) {
  if (!p || !ids || p.status === "in_waiting_room") return null;
  const email = String(p.user_email || "").trim().toLowerCase();
  if (email && (ids.emails || []).includes(email)) return "email";
  const n = foldName(p.name);
  const names = (ids.names || []).map(foldName);
  if (n && (names.includes(n) || names.map(squash).includes(squash(n)))) return "name";
  return null;
}

/** The meeting id the event's call runs in: its Zoom link, else the user's room when it carries no link at all. */
export function zoomMeetingIdOf(e, roomId) {
  const links = [e.location, e.hangoutLink,
    ...((e.conferenceData && e.conferenceData.entryPoints) || []).map((p) => p && p.uri)].filter(Boolean);
  for (const l of links) { const id = meetingIdFromUrl(l); if (id) return id; }
  return links.length ? null : (roomId || null);
}

const overlapMs = (i, c) => Math.min(i.end_ms, c.end_ms + ZOOM_GRACE_MS) - Math.max(i.start_ms, c.start_ms - ZOOM_GRACE_MS);
const theirRecords = (i, ids) => (i.participants || []).filter((p) => participantMatch(p, ids));
// One record's time in the meeting, inside the meeting's own bounds.
function recordMs(p, i) {
  const j = Date.parse(p.join_time), l = Date.parse(p.leave_time);
  if (Number.isFinite(j) && Number.isFinite(l)) return Math.max(0, Math.min(l, i.end_ms) - Math.max(j, i.start_ms));
  return (Number(p.duration) || 0) * 1000;
}
const presentIn = (i, ids) => theirRecords(i, ids).reduce((t, p) => t + recordMs(p, i), 0) >= ZOOM_MIN_PRESENT_MS;
/** The host's own record: the user id, else the email, else the display name (the meeting's own fields). */
function isHost(p, i) {
  if (p.id && i.host_id && p.id === i.host_id) return true;
  const e = String(p.user_email || "").trim().toLowerCase();
  if (e && i.host_email && e === String(i.host_email).trim().toLowerCase()) return true;
  return !!(i.host_name && foldName(p.name) && foldName(p.name) === foldName(i.host_name));
}
// Someone in the meeting code cannot place: not the host, and not the counterpart for a real stretch.
// Could be the counterpart on a phone or under a new name, so a slot with one is left to the calendar.
const unplaced = (i, ids) => (i.participants || []).filter((p) => p && p.status !== "in_waiting_room"
  && !isHost(p, i) && !(participantMatch(p, ids) && presentIn(i, ids)));
// Zoom has a count of people but returned no list: it has not finished, so it cannot say who joined.
const listMissing = (i) => i.participants == null || (!i.participants.length && (i.participants_count || 0) > 1);
const instEvidence = (i) => ({ uuid: i.uuid, start: new Date(i.start_ms).toISOString(), end: new Date(i.end_ms).toISOString(),
  duration: i.duration, participants_count: i.participants_count });

/** The counterpart's time in the room across their instances: first join to last leave, inside each meeting's bounds. */
function presentSpan(mine, ids, meetingId) {
  let start = Infinity, end = -Infinity, total = 0, as = null;
  for (const i of mine) {
    const recs = theirRecords(i, ids);
    as = as || participantMatch(recs[0], ids);
    const joins = recs.map((p) => Date.parse(p.join_time)).filter(Number.isFinite);
    const leaves = recs.map((p) => Date.parse(p.leave_time)).filter(Number.isFinite);
    const s = Math.max(i.start_ms, joins.length ? Math.min(...joins) : i.start_ms);
    const e = Math.min(i.end_ms, leaves.length ? Math.max(...leaves) : i.end_ms);
    const [a, b] = e > s ? [s, e] : [i.start_ms, i.end_ms];
    start = Math.min(start, a); end = Math.max(end, b); total += b - a;
  }
  return { found: true, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    minutes: Math.round(total / 60000),
    evidence: { meeting_id: meetingId, matched_as: as, instances: mine.map(instEvidence) } };
}

/**
 * Pure. Per calendar slot (callKey): {found: true, start, end, minutes, evidence}
 * when an instance overlapping it had the counterpart in it for a minute or
 * more; {found: false, why, evidence} when Zoom shows they never joined (the
 * room had only the user in it, or no meeting at all); and nothing (the
 * calendar answers) when Zoom cannot tell: its participant list is not ready,
 * or someone code cannot place was there. Several instances a day happen in
 * the room: an instance is the slot's by overlap AND the counterpart's
 * presence, and one they were in belongs to the slot it overlaps most. Never
 * by position in a list.
 * @param room {meeting_id, instances: [{uuid, start_ms, end_ms, duration, participants_count,
 *              host_id, host_email, host_name, participants|null}]}
 */
export function matchZoom(slots, room, { ids, name = "them" } = {}) {
  const insts = room.instances || [];
  const owner = new Map();
  for (const i of insts) {
    if (!presentIn(i, ids)) continue;
    let best = null, bestOv = 0;
    for (const c of slots) { const ov = overlapMs(i, c); if (ov > bestOv) { bestOv = ov; best = c; } }
    if (best) owner.set(i, best);
  }
  const out = {};
  for (const c of slots) {
    const over = insts.filter((i) => overlapMs(i, c) > 0);
    const mine = over.filter((i) => owner.get(i) === c);
    if (mine.length) { out[callKey(c)] = presentSpan(mine, ids, room.meeting_id); continue; }
    if (over.some(listMissing) || over.some((i) => !owner.has(i) && unplaced(i, ids).length)) continue;
    const seen = [...new Set(over.flatMap((i) => (i.participants || []).map((p) => p.name).filter(Boolean)))].slice(0, 10);
    const why = over.some((i) => owner.has(i)) ? `Zoom shows the call with ${name} at its other calendar time`
      : over.length ? `Zoom shows ${name} never joined your room then`
      : "Zoom shows no meeting in your room then";
    out[callKey(c)] = { found: false, why, evidence: { meeting_id: room.meeting_id, instances: over.map(instEvidence), participants_seen: seen } };
  }
  return out;
}

const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The room's instances around these slots, with details, and participants for those overlapping one. */
export async function readRoom(client, meetingId, slots) {
  const lo = Math.min(...slots.map((c) => c.start_ms)), hi = Math.max(...slots.map((c) => c.end_ms));
  const list = await client.pastInstances(meetingId, { from: utcDate(lo - ZOOM_HISTORY_DAYS * 86400_000), to: utcDate(hi + 86400_000) });
  const instances = [];
  for (const x of list) {
    const t = Date.parse(x.start_time);
    if (!(t >= lo - ZOOM_LOOKBACK_MS && t < hi + ZOOM_GRACE_MS)) continue;
    const d = await client.pastMeeting(x.uuid);
    const s = Date.parse(d.start_time || x.start_time);
    const e = Date.parse(d.end_time) || s + (Number(d.duration) || 0) * 60000;
    const inst = { uuid: x.uuid, start_ms: s, end_ms: e, duration: d.duration ?? null,
      participants_count: d.participants_count ?? null, host_id: d.host_id || null, host_email: d.user_email || null,
      host_name: d.user_name || null, participants: null };
    if (slots.some((c) => overlapMs(inst, c) > 0)) inst.participants = await client.pastParticipants(x.uuid);
    instances.push(inst);
  }
  return { meeting_id: meetingId, history: list.length, instances };
}

/**
 * Zoom's answer for the day's screened calls: {byKey, status}. byKey is null
 * when Zoom does not answer at all, and the calendar does: no credentials, a
 * refused credentials file, a 401/403/404, a timeout, a free plan, or a room
 * with no meetings in 30 days (Zoom is not showing it). One log line, never an
 * alert. A slot that ended under 2h ago, or whose event links somewhere else,
 * is not asked about.
 */
export async function zoomCalls({ m, kept = [], creds = loadCredentials(), client = null, now = Date.now(),
                                  log = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const tag = `[meeting-call${m ? ` ${m.id}` : ""}]`;
  if (!creds.cfg) {
    if (creds.problem) log(`${tag} zoom credentials refused: ${creds.problem}; using the calendar`);
    return { byKey: null, status: creds.problem ? `credentials refused: ${creds.problem}` : "not configured" };
  }
  const slots = kept.filter((c) => c.zoom_meeting_id && now - c.end_ms >= ZOOM_SETTLE_MS);
  if (!slots.length) return { byKey: null, status: kept.length ? "configured, no call Zoom can speak to yet" : "configured" };
  try {
    const z = client || createZoomClient({ cfg: creds.cfg });
    const byKey = {};
    for (const id of [...new Set(slots.map((c) => c.zoom_meeting_id))]) {
      const mine = slots.filter((c) => c.zoom_meeting_id === id);
      const room = await readRoom(z, id, mine);
      if (!room.history) {
        log(`${tag} zoom: room ${id} shows no meetings in ${ZOOM_HISTORY_DAYS} days; using the calendar`);
        return { byKey: null, status: `room ${id} shows no meetings in ${ZOOM_HISTORY_DAYS} days` };
      }
      Object.assign(byKey, matchZoom(mine, room, { ids: participantIds(m), name: m ? m.name : "them" }));
    }
    return { byKey, status: "answered" };
  } catch (e) {
    const why = e instanceof ZoomError ? e.message : `unexpected ${(e && e.name) || "error"}`;
    log(`${tag} zoom: ${why}; using the calendar`);
    return { byKey: null, status: `failed: ${why}` };
  }
}

// ---------------------------------------------------------------------------
// 2. The calendar
// ---------------------------------------------------------------------------

/** The day's primary-calendar events, read with the local day's bounds stated. */
export function readCalendarDay(date, tz) {
  const w = dayWindow(date, tz);
  const out = execFileSync(GOG, ["calendar", "list", "--account", calAccount(), "--from", w.start, "--to", w.end,
    "--max=250", "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
  return JSON.parse(out).events || [];
}

/** Stable identity of one instance: its event id, else title + start instant. */
export function callKey(c) {
  return `${c.event_id || c.summary}|${new Date(c.start_ms ?? Date.parse(c.start)).toISOString()}`;
}

// A call, not a meeting in person: an instance of the call series, or an event
// with a video link (Google's conference fields, or a link where the location
// goes) and no street address. Dinner with the counterpart at a restaurant is a
// calendar event like any other and stays with the stops and the unmatched list.
const LINK_PREFIXES = ["http://", "https://", "zoom.", "meet.google"];
function isCall(e, knownId) {
  if (knownId && (e.recurringEventId === knownId || e.id === knownId)) return true;
  const loc = String(e.location || "").trim();
  if (loc && !LINK_PREFIXES.some((p) => loc.startsWith(p))) return false;
  const video = (e.conferenceData && (e.conferenceData.entryPoints || []).some((p) => p && p.entryPointType === "video"));
  return !!(loc || e.hangoutLink || video);
}

/**
 * The meeting's instances that START inside the local day [00:00, 24:00) of
 * `date` in `tz`. A call that straddles midnight belongs to the day it began
 * on, and only to that one. Pure.
 */
export function calendarCandidates(events, { m, date, tz, knownId = null } = {}) {
  const w = dayWindow(date, tz);
  const out = [];
  for (const e of events || []) {
    if (!e || !e.start || !e.start.dateTime || !e.end || !e.end.dateTime) continue;
    if (!isMeetingEvent(e, m, knownId) || !isCall(e, knownId)) continue;
    const s = Date.parse(e.start.dateTime), t = Date.parse(e.end.dateTime);
    if (!(s >= w.startMs && s < w.endMs && t > s)) continue;
    const self = (e.attendees || []).find((a) => a && a.self);
    const orig = e.originalStartTime && e.originalStartTime.dateTime ? Date.parse(e.originalStartTime.dateTime) : null;
    out.push({
      event_id: e.id || null, series_id: e.recurringEventId || null, summary: e.summary || "",
      start: new Date(s).toISOString(), end: new Date(t).toISOString(), start_ms: s, end_ms: t,
      minutes: Math.round((t - s) / 60000), status: e.status || null,
      self_response: self ? self.responseStatus || null : null, zoom_meeting_id: zoomMeetingIdOf(e, m && m.room_id),
      ...(orig && orig !== s ? { moved_from: new Date(orig).toISOString() } : {}),
    });
  }
  return out.sort((a, b) => a.start_ms - b.start_ms);
}

/** Flights (transit segments) on the travel timeline around the day. Fail-open: []. */
export function readFlights(date) {
  try {
    const out = execFileSync(TRAVEL_BIN, ["list", "--from", addDays(date, -1), "--to", addDays(date, 1), "--json"],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
    const j = JSON.parse(out);
    const rows = Array.isArray(j) ? j : (j.segments || j.rows || []);
    return rows.filter((r) => r && r.metro === "transit" && r.arrive_at && r.depart_at);
  } catch { return []; }
}

/**
 * What the records settle without reading anyone's words. Returns
 * {kept, left_out}; each left_out entry says why. Pure.
 */
export function screenCandidates(candidates, { flights = [] } = {}) {
  const kept = [], left_out = [];
  for (const c of candidates) {
    let why = null;
    if (c.status === "cancelled") why = "cancelled on the calendar";
    else if (c.self_response === "declined") why = "you declined it on the calendar";
    else {
      const f = flights.find((x) => Date.parse(x.arrive_at) < c.end_ms && Date.parse(x.depart_at) > c.start_ms);
      if (f) why = `you were on a flight then (${f.place_label || "travel timeline"})`;
    }
    if (why) left_out.push({ ...c, why }); else kept.push(c);
  }
  return { kept, left_out };
}

// ---------------------------------------------------------------------------
// 3. What the model is shown (the reading itself is bin/meeting-call-reading)
// ---------------------------------------------------------------------------

const localDate = (ms, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(ms));
// "11:00pm", from Intl's parts (its formatted string puts a narrow no-break
// space before "PM" in current ICU).
const clock = (ms, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute}${String(p.dayPeriod || "").toLowerCase()}`;
};
const dayName = (ms, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" })
  .format(new Date(ms));
/** "Los Angeles" for America/Los_Angeles: the zone's city, as a person says it. */
export const zoneLabel = (tz) => String(tz || "").split("/").pop().split("_").join(" ");

/** The call as words, both clocks computed by code (the model never converts). */
export function callWhen(c, tz, home = homeTz()) {
  const local = `${dayName(c.start_ms, tz)}, ${clock(c.start_ms, tz)} to ${clock(c.end_ms, tz)}`;
  if (tz === home) return `${local} ${zoneLabel(home)} time`;
  return `${local} local time (${dayName(c.start_ms, home)}, ${clock(c.start_ms, home)} to ${clock(c.end_ms, home)} ${zoneLabel(home)} time)`;
}

/**
 * The "### YYYY-MM-DD" sections of the notes' "## Discussed" part whose heading
 * is one of `dates`. Markdown structure only: a heading is matched by exact
 * string equality, nothing in a section is interpreted here.
 */
export function notesForDates(text, dates) {
  const want = new Set(dates);
  const out = [];
  let inDiscussed = false, keep = false;
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("## ")) { inDiscussed = line.trim() === "## Discussed"; keep = false; continue; }
    if (!inDiscussed) continue;
    if (line.startsWith("### ")) { keep = want.has(line.slice(4).trim()); if (keep) out.push(line); continue; }
    if (keep) out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * The dates whose notes can speak to these calls: a week before (a call called
 * off in advance is noted on an earlier day) through the day after (notes sent
 * the next morning), in both the local date and the home zone's.
 */
export function noteDates(calls, tz, home = homeTz()) {
  const ds = new Set();
  for (const c of calls) {
    for (const base of [localDate(c.start_ms, home), localDate(c.start_ms, tz)]) {
      for (let k = -6; k <= 1; k++) ds.add(addDays(base, k));
    }
  }
  return [...ds].sort();
}

/** The user's own words about the day, verbatim, from day-statements' reading (if it ran). */
export function userWords(statements) {
  if (!statements || typeof statements !== "object") return [];
  const out = [];
  const push = (x) => { if (x && typeof x === "string" && !out.includes(x)) out.push(x); };
  for (const k of ["corrections", "places", "non_stops"]) for (const x of statements[k] || []) push(x && x.evidence);
  if (statements.all_stops_declared) push(statements.all_stops_declared.evidence);
  return out;
}

/** The user's own chat messages that day, verbatim and timed: "[HH:MM] text". */
export function chatLines(rows, tz, { max = 120, chars = 300 } = {}) {
  const hm = (iso) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  return (rows || []).filter((r) => r && r.role === "user" && r.content)
    .slice(-max).map((r) => `[${hm(r.created_at)}] ${String(r.content).slice(0, chars)}`);
}

/**
 * The state both rungs read: ids c0..cN, the call times as words, the heading
 * its notes sit under, notes, the user's words. A notes heading carries the
 * call's home-zone date (the post-call step files notes under the state file's
 * date), so code names it: abroad, a late-afternoon home-time call starts after
 * midnight local and shares a local date with the next day's call, and a note
 * under that date would otherwise be read as being about both.
 */
export function readingState(calls, { tz, notes, words, chat = [], home = homeTz() }) {
  return {
    calls: calls.map((c, i) => ({ id: `c${i}`, when: callWhen(c, tz, home), notes_heading: `### ${localDate(c.start_ms, home)}` })),
    notes: notes || "(no notes dated near these calls)",
    user_words: words.length ? words : ["(none read for this day)"],
    user_messages_that_day: chat.length ? chat : ["(none)"],
  };
}

// Provenance, not interpretation: a quoted line must be in what the model was
// shown. Typography folds first, as in day-statements (a straight apostrophe for
// a curly one must still match).
const norm = (x) => String(x || "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "")   // lang-regex-ok: folds accents before comparison
  .replace(/[‘’‛ʼ]/g, "'")        // lang-regex-ok: folds typography before comparison
  .replace(/[“”„]/g, '"')               // lang-regex-ok: folds typography before comparison
  .replace(/[–—−]/g, "-")               // lang-regex-ok: folds typography before comparison
  .replace(/\s+/g, " ").trim().toLowerCase();          // lang-regex-ok: whitespace fold before comparison

/**
 * Check a Claude rung's answer: every call answered once with a known label, and
 * a held / not_held answer quoting words that are really in what it was shown.
 */
export function validateReading(parsed, state) {
  if (!parsed || !Array.isArray(parsed.calls)) return "calls is not an array";
  const ids = state.calls.map((c) => c.id);
  const hay = norm(`${state.notes}\n${(state.user_words || []).join("\n")}\n${(state.user_messages_that_day || []).join("\n")}`);
  const seen = new Set();
  for (const c of parsed.calls) {
    if (!c || !ids.includes(c.id)) return `unknown call id ${c && c.id}`;
    if (!VERDICTS.includes(c.verdict)) return `bad verdict for ${c.id}: ${c.verdict}`;
    if (c.verdict !== "no_word") {
      const q = norm(c.quote).slice(0, 80);
      if (q.length < 6 || !hay.includes(q)) return `the words quoted for ${c.id} are not in what it was shown`;
    }
    seen.add(c.id);
  }
  const missing = ids.filter((id) => !seen.has(id));
  return missing.length ? `no answer for ${missing.join(", ")}` : null;
}

// ---------------------------------------------------------------------------
// 4. Settle: the day's calls, from what code read and what the model read
// ---------------------------------------------------------------------------

/**
 * @param kept     screened calendar candidates
 * @param reading  the reading file's content, or null when the model step did not run
 * @param zoom     zoomCalls().byKey, or null when Zoom did not answer
 * @returns {calls, left_out}  calls: [{who, source, start, end, minutes, status, calendar, evidence}]
 *   source "zoom": the counterpart was in the room; start/end/minutes are their
 *   time there, status "held". Otherwise source "calendar" and status: "held"
 *   (the notes or the user's words say it took place), "on_calendar" (they say
 *   nothing against it), "scheduled" (no reading: only the slot is known). A
 *   slot Zoom shows the counterpart never joined is left out, whatever the
 *   reading says.
 */
export function settleCalls(kept, reading, { leftOut = [], zoom = null, who = null } = {}) {
  const verdicts = (reading && reading.verdicts) || null;
  const calls = [], left_out = leftOut.map((c) => ({ start: c.start, end: c.end, why: c.why }));
  for (const c of kept) {
    const calendar = { summary: c.summary, start: c.start, end: c.end, event_id: c.event_id,
                       ...(c.moved_from ? { moved_from: c.moved_from } : {}) };
    const z = zoom ? zoom[callKey(c)] : null;
    if (z && !z.found) { left_out.push({ start: c.start, end: c.end, why: z.why }); continue; }
    if (z) {
      calls.push({ who, source: "zoom", start: z.start, end: z.end, minutes: z.minutes, status: "held",
                   calendar, evidence: { zoom: z.evidence } });
      continue;
    }
    const v = verdicts ? verdicts[callKey(c)] : null;
    if (v && v.verdict === "not_held") {
      left_out.push({ start: c.start, end: c.end, why: "your notes or your own words say it did not happen" });
      continue;
    }
    const status = !v ? "scheduled" : v.verdict === "held" ? "held" : "on_calendar";
    calls.push({
      who, source: "calendar", start: c.start, end: c.end, minutes: c.minutes, status, calendar,
      evidence: { reading: v ? v.verdict : "absent", ...(reading && reading.read_by ? { read_by: reading.read_by } : {}) },
    });
  }
  return { calls, left_out };
}

/**
 * The whole ladder for one day of one meeting: the calendar's instances,
 * screened; Zoom for the ones it can speak to; the model's reading only for
 * the rest. `ensureReading(calls)` is the caller's hook to run the model step;
 * it returns the reading or null. `zoom` is injectable for tests.
 */
export async function callsForDay({ m, date, tz, events = null, flights = null, ensureReading = () => null, zoom = zoomCalls,
                                    knownId = undefined }) {
  const evs = events || readCalendarDay(date, tz);
  const candidates = calendarCandidates(evs, { m, date, tz, knownId: knownId !== undefined ? knownId : knownSeriesId(m) });
  const { kept, left_out } = screenCandidates(candidates, { flights: flights || (candidates.length ? readFlights(date) : []) });
  const z = await zoom({ m, kept });
  const unread = kept.filter((c) => !(z.byKey && z.byKey[callKey(c)]));
  const reading = unread.length ? ensureReading(unread) : null;
  return { ...settleCalls(kept, reading, { leftOut: left_out, zoom: z.byKey, who: m ? m.name : null }), zoom: z.status };
}

/** The reading file for `date` if it covers every one of `kept`, else null. */
export function readReading(m, date, kept, file = readingPath(m, date)) {
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    const have = r && r.verdicts ? r.verdicts : {};
    return kept.every((c) => have[callKey(c)]) ? r : null;
  } catch { return null; }
}
