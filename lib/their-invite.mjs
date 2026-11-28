// their-invite.mjs — did the other side already send the user an invite for this meeting?
//
// The user's rule (2026-11-27): "if someone already sent me an invite ...
// there's no need to send our own invite. we should just use theirs." Refined
// the same day: "if their invite comes first use theirs, but if they haven't
// sent one by the time we're about to send ours - send ours instead." So this is
// a check at send time only; an invite of theirs that arrives later changes
// nothing.
//
// What prompted it: a contractor's coordinator and Jori both sent an invitation
// for the same site visit, so the guests had two invitations for one meeting.
//
// Whether two calendar events are the same meeting is geometry plus identity
// (agent/CLAUDE.md § Rule #0b: code owns geometry): their times overlap, and the
// people on one are the people on the other. No language is read here.
//
// Used by bin/jori-calendar: refuse to send our invite when theirs is already on
// the calendar.

// Mail providers anyone can sign up at: sharing one says nothing about two
// people being on the same side. Everything else is a company or a person's own
// domain, and a colleague at that domain counts as the same party (the invite
// came from one of two people Jori had invited at the same company).
const SHARED_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com",
  "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
  "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com", "zoho.com", "fastmail.com",
  "hey.com", "yandex.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net",
]);
// Calendar-service addresses that are rooms, groups or imports, not people.
const NOT_A_PERSON = ["@group.calendar.google.com", "@resource.calendar.google.com", "@import.calendar.google.com"];

const lc = (s) => String(s || "").trim().toLowerCase();
const domainOf = (email) => { const e = lc(email); const i = e.lastIndexOf("@"); return i > 0 ? e.slice(i + 1) : ""; };
const isPersonEmail = (email) => { const e = lc(email); return e.includes("@") && !NOT_A_PERSON.some((s) => e.endsWith(s)); };

/** Is `email` one of `people`, or a colleague of one (same non-shared domain)? */
export function sameParty(email, people) {
  const e = lc(email);
  if (!isPersonEmail(e)) return false;
  const d = domainOf(e);
  return people.some((p) => {
    const q = lc(p);
    if (!isPersonEmail(q)) return false;
    if (q === e) return true;
    return Boolean(d) && !SHARED_DOMAINS.has(d) && domainOf(q) === d;
  });
}

function ms(t) {
  if (!t) return NaN;
  const v = typeof t === "string" ? t : (t.dateTime || t.date);
  return v ? Date.parse(v) : NaN;
}

/** Private stamp bin/jori-calendar puts on every event it creates. */
export function isJoriMade(e) {
  const priv = (e && e.extendedProperties && e.extendedProperties.private) || {};
  return priv.jori_created === "1" || priv.gandalf_created === "1";
}

function organizerIsOwner(e, owners) {
  const o = e && e.organizer;
  if (!o) return true; // no organizer on the record: the user's own calendar entry
  return Boolean(o.self) || owners.has(lc(o.email));
}

/** Everyone on an event other than the owner: organizer and guests, emails. */
export function eventOthers(e, owners) {
  const out = new Set();
  const o = e && e.organizer;
  if (o && !o.self && isPersonEmail(o.email) && !owners.has(lc(o.email))) out.add(lc(o.email));
  for (const a of (e && Array.isArray(e.attendees) ? e.attendees : [])) {
    if (!a || a.self || a.resource || !isPersonEmail(a.email) || owners.has(lc(a.email))) continue;
    out.add(lc(a.email));
  }
  return [...out];
}

/**
 * An invitation someone else sent: organized by another person, still live,
 * and not declined by the user.
 */
export function isTheirInvite(e, owners) {
  if (!e || e.status === "cancelled") return false;
  if (organizerIsOwner(e, owners) || isJoriMade(e)) return false;
  const me = (e.attendees || []).find((a) => a && (a.self || owners.has(lc(a.email))));
  if (me && me.responseStatus === "declined") return false;
  return isPersonEmail(e.organizer && e.organizer.email);
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/**
 * Invitations already on the calendar from the people we are about to invite.
 *
 * @param {object[]} events   Google Calendar events around the slot
 * @param {object}   o
 * @param {string[]} o.invitees  who we would invite (emails)
 * @param {string}   o.from      RFC3339 start of our event
 * @param {string}   o.to        RFC3339 end of our event
 * @param {Iterable<string>} o.owners  the user's own addresses
 * @param {number}  [o.slackMs]  how far apart in time still counts as the same
 *                               meeting (default 3 h: their invite may say 10:30
 *                               when we proposed 11:00)
 * @returns {{event: object, who: string[]}[]}
 */
export function findTheirInvites(events, { invitees, from, to, owners, slackMs = 3 * 3600e3 }) {
  const own = new Set([...(owners || [])].map(lc).filter(Boolean));
  const people = (invitees || []).map(lc).filter((p) => p && !own.has(p));
  const s = ms(from), en = ms(to);
  if (!people.length || !Number.isFinite(s) || !Number.isFinite(en)) return [];
  const out = [];
  for (const e of events || []) {
    if (!isTheirInvite(e, own)) continue;
    const es = ms(e.start), ee = ms(e.end);
    if (!Number.isFinite(es) || !Number.isFinite(ee)) continue;
    if (!overlaps(s - slackMs, en + slackMs, es, ee)) continue;
    const who = eventOthers(e, own).filter((x) => sameParty(x, people));
    if (who.length) out.push({ event: e, who });
  }
  return out;
}

/** One line naming an event, for refusals and logs. */
export function describeEvent(e) {
  const start = (e.start && (e.start.dateTime || e.start.date)) || "?";
  const end = (e.end && (e.end.dateTime || e.end.date)) || "?";
  const org = (e.organizer && (e.organizer.displayName || e.organizer.email)) || "?";
  return `"${e.summary || "(untitled)"}"  ${start} → ${end}  from ${org}  (id: ${e.id})`;
}
