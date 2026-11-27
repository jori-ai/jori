// their-invite.mjs — did the other side already send the user an invite for this meeting?
//
// The user's rule (2026-11-27): "if someone already sent me an invite (like in
// the case of sierra for the same time we wanted to invite them) - there's no
// need to send our own invite. we should just use theirs."
//
// What happened: the user emailed a contractor's coordinator proposing a site
// visit; she answered "works for us, I will send a google calendar invite out
// here shortly"; Jori created its own event and invited her and her colleague
// anyway, and two minutes later her invite for the same hour arrived. The
// two of them then had two invitations for one meeting.
//
// Whether two calendar events are the same meeting is geometry plus identity
// (agent/CLAUDE.md § Rule #0b: code owns geometry): their times overlap, and the
// people on one are the people on the other. No language is read here.
//
// Used by bin/jori-calendar (the guard: refuse to send our invite when theirs is
// already on the calendar) and bin/calendar-their-invite (the sweep: when theirs
// arrives after ours, take ours off).

// Mail providers anyone can sign up at: sharing one says nothing about two
// people being on the same side. Everything else is a company or a person's own
// domain, and a colleague at that domain counts as the same party (the invite
// came from Sierra; Jori had invited Sierra and Zak, both @kbremodel.com).
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

/**
 * Pairs of (an invitation Jori sent, the other side's invitation for the same
 * meeting): Jori's event carries the jori_created stamp, is organized by the
 * user and invited someone; theirs overlaps it in time (strictly: the sweep
 * acts on this, so no slack) and comes from one of the people Jori invited or
 * a colleague of theirs.
 *
 * @returns {{ours: object, theirs: object, who: string[]}[]}  each of ours at most once
 */
export function findDuplicatePairs(events, owners) {
  const own = new Set([...(owners || [])].map(lc).filter(Boolean));
  const list = (events || []).filter((e) => e && e.status !== "cancelled");
  const mine = list.filter((e) => isJoriMade(e) && organizerIsOwner(e, own) && eventOthers(e, own).length);
  const theirs = list.filter((e) => isTheirInvite(e, own));
  const out = [];
  for (const ours of mine) {
    const os = ms(ours.start), oe = ms(ours.end);
    if (!Number.isFinite(os) || !Number.isFinite(oe)) continue;
    const invited = eventOthers(ours, own);
    for (const t of theirs) {
      const ts = ms(t.start), te = ms(t.end);
      if (!Number.isFinite(ts) || !Number.isFinite(te) || !overlaps(os, oe, ts, te)) continue;
      const who = eventOthers(t, own).filter((x) => sameParty(x, invited));
      if (who.length) { out.push({ ours, theirs: t, who }); break; }
    }
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
