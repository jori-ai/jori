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
