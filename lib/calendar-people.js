"use strict";

// calendar-people — who the user meets, and when (Google Calendar).
//
// The third half of the people pipeline, beside email (lib/email-people.js)
// and texts (lib/chat-people.js); jobs/people-email.md Part C. A meeting is an
// interaction like an email thread or a text: in person or on a call, it says
// who the user sees, how often, and about what. Without it the person pages
// knew only what was written down, and someone the user lunches with every
// month looked like a person gone quiet.
//
// Code owns the structure: the ledger of primary-calendar events (title,
// time, in person or video, guests and their replies), which events were held
// (not cancelled, not declined, already over), which guest addresses belong to
// which wiki page (through the email ledger's links, or a link set here), who
// qualifies, which pages are due a summary, and the dated facts line on the
// page. A model owns the meaning: whether a guest address is a person and
// which page is theirs, which people an event's TITLE names ("Lunch with Dana
// Levi" has no guest list), and the "what they meet about" summary.
//
// Two ways an event reaches a person:
//   1. A guest on the invite. Resolved in code: the email ledger's link for
//      that address, else a link the model set here (`link`). A guest with no
//      page who was at 2+ held small meetings with the user (1 when they are in
//      Google Contacts) is offered to the model as `unmatched`.
//   2. A name in the title, for the many events with no guest list (dinners,
//      visits, pick-ups). Every held event is read once by the model
//      (`titles` → `review`), which records the pages the title names.
//
// Privacy: descriptions and notes are never fetched or stored; titles,
// times, the location string and the guest list are. The page gets prose and
// a facts line only, never a location, an address or an attendee's email.

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { installTools } = require("./root.cjs");

const DB_PATH = process.env.CALENDAR_PEOPLE_DB || installTools("data/calendar-people.db");

const DAY = 864e5;
// A meeting with more guests than this is a group event: it still counts on
// the page of someone who already has one, but it never makes a stranger
// qualify (a 40-person invite is not 40 relationships).
const SMALL_MAX_GUESTS = 8;
const MIN_MEETINGS = 2;
const MIN_MEETINGS_IN_CONTACTS = 1;
// A regular meeting partner is not re-summarised weekly: stale again only
// after this many days, or this many new meetings, since the last summary.
const RESUMMARY_DAYS = 14;
const RESUMMARY_NEW_MEETINGS = 3;
// Not interactions: Google's own status blocks.
const SKIP_EVENT_TYPES = new Set(["workingLocation", "focusTime", "outOfOffice", "birthday"]);
const LINK_PREFIXES = ["http://", "https://", "zoom.", "meet.google", "teams.microsoft"];

let _db = null;

function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      location TEXT,
      kind TEXT NOT NULL,
      status TEXT,
      self_response TEXT,
      organizer_self INTEGER NOT NULL DEFAULT 0,
      recurring_id TEXT,
      guests INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_ms);
    CREATE TABLE IF NOT EXISTS attendees (
      event_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      response TEXT,
      PRIMARY KEY (event_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_attendees_email ON attendees(email);
    CREATE TABLE IF NOT EXISTS attendee_links (
      email TEXT PRIMARY KEY,
      wiki_id TEXT,
      ignored INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mentions (
      event_id TEXT NOT NULL,
      wiki_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (event_id, wiki_id)
    );
    CREATE TABLE IF NOT EXISTS reviewed (
      event_id TEXT PRIMARY KEY,
      title TEXT,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS links (
      wiki_id TEXT PRIMARY KEY,
      summarized_at INTEGER,
      summarized_last_at INTEGER,
      summarized_n INTEGER
    );
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  return _db;
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function getMeta(k) {
  return db().prepare("SELECT v FROM meta WHERE k = ?").get(k)?.v ?? null;
}

function setMeta(k, v) {
  db().prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, String(v));
}

function config() {
  const { localConfig } = require("./instance.cjs");
  const own = localConfig("calendar-people", { self_addresses: [], account: null, backfill_from: null });
  // The calendar audit already lists the user's other addresses.
  const audit = localConfig("calendar-audit", { self_addresses: [] });
  return { ...own, self_addresses: [...(own.self_addresses || []), ...(audit.self_addresses || [])] };
}

function account() {
  return process.env.CALENDAR_PEOPLE_ACCOUNT || config().account || require("./instance.cjs").instance().owner_email;
}

// The user's own addresses (and the assistant's): never a guest.
function selfSet() {
  const out = new Set();
  const add = (e) => e && out.add(String(e).trim().toLowerCase());
  try {
    const { instance, agentAddresses } = require("./instance.cjs");
    add(instance().owner_email);
    for (const a of agentAddresses() || []) add(a);
  } catch { /* no instance: tests */ }
  for (const a of config().self_addresses || []) add(a);
  try {
    for (const a of JSON.parse(require("./email-people.js").getMeta("self_emails") || "[]")) add(a);
  } catch { /* no email ledger */ }
  return out;
}

// ── Event geometry (pure) ──

function eventKind(raw) {
  if (raw.start && raw.start.date && !raw.start.dateTime) return "all_day";
  const loc = String(raw.location || "").trim();
  const video = raw.hangoutLink || (raw.conferenceData?.entryPoints || []).some((p) => p && p.entryPointType === "video");
  if (loc && !LINK_PREFIXES.some((p) => loc.toLowerCase().startsWith(p))) return "in_person";
  if (video || loc) return "video";
  return "unknown";
}

function timeOf(t) {
  if (!t) return NaN;
  if (t.dateTime) return Date.parse(t.dateTime);
  if (t.date) return Date.parse(`${t.date}T12:00:00Z`);
  return NaN;
}

/** A Google Calendar event → the ledger's row + guests, or null when it is not an interaction. Pure. */
function normalizeEvent(raw, self = new Set()) {
  if (!raw || !raw.id) return null;
  if (SKIP_EVENT_TYPES.has(raw.eventType)) return null;
  const start = timeOf(raw.start);
  const end = timeOf(raw.end);
  if (!Number.isFinite(start)) return null;
  const isSelf = (a) => a && (a.self || self.has(String(a.email || "").toLowerCase()));
  const guests = (raw.attendees || []).filter((a) => a && a.email && !a.resource && !isSelf(a));
  const me = (raw.attendees || []).find(isSelf);
  return {
    event_id: raw.id,
    start_ms: start,
    end_ms: Number.isFinite(end) ? end : start,
    all_day: raw.start && raw.start.date && !raw.start.dateTime ? 1 : 0,
    title: raw.summary || null,
    location: raw.location || null,
    kind: eventKind(raw),
    status: raw.status || "confirmed",
    self_response: me ? me.responseStatus || null : null,
    organizer_self: raw.organizer && (raw.organizer.self || self.has(String(raw.organizer.email || "").toLowerCase())) ? 1 : 0,
    recurring_id: raw.recurringEventId || null,
    guests: guests.map((a) => ({ email: String(a.email).toLowerCase(), name: a.displayName || null, response: a.responseStatus || null })),
  };
}

/** SQL predicate: the event took place with the user in it. */
const HELD_SQL = "e.status != 'cancelled' AND COALESCE(e.self_response, '') != 'declined' AND e.end_ms <= ?";

// ── Ingest ──

/**
 * Store the events of one window [fromMs, toMs). Events that start inside the
 * window and are no longer on the calendar are dropped (deleted or moved out).
 */
function ingestWindow(rawEvents, { fromMs, toMs, now = Date.now(), self = selfSet() } = {}) {
  const d = db();
  const rows = [];
  for (const raw of rawEvents || []) {
    const r = normalizeEvent(raw, self);
    if (r) rows.push(r);
  }
  const seen = new Set(rows.map((r) => r.event_id));
  d.exec("BEGIN IMMEDIATE");
  try {
    let dropped = 0;
    if (Number.isFinite(fromMs) && Number.isFinite(toMs)) {
      for (const { event_id } of d.prepare("SELECT event_id FROM events WHERE start_ms >= ? AND start_ms < ?").all(fromMs, toMs)) {
        if (seen.has(event_id)) continue;
        d.prepare("DELETE FROM events WHERE event_id = ?").run(event_id);
        d.prepare("DELETE FROM attendees WHERE event_id = ?").run(event_id);
        d.prepare("DELETE FROM mentions WHERE event_id = ?").run(event_id);
        dropped++;
      }
    }
    const up = d.prepare(
      `INSERT INTO events (event_id, start_ms, end_ms, all_day, title, location, kind, status, self_response, organizer_self, recurring_id, guests, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET start_ms = excluded.start_ms, end_ms = excluded.end_ms, all_day = excluded.all_day,
         title = excluded.title, location = excluded.location, kind = excluded.kind, status = excluded.status,
         self_response = excluded.self_response, organizer_self = excluded.organizer_self,
         recurring_id = excluded.recurring_id, guests = excluded.guests, synced_at = excluded.synced_at`,
    );
    const insA = d.prepare("INSERT OR REPLACE INTO attendees (event_id, email, name, response) VALUES (?, ?, ?, ?)");
    for (const r of rows) {
      const prevTitle = d.prepare("SELECT title FROM events WHERE event_id = ?").get(r.event_id)?.title;
      up.run(r.event_id, r.start_ms, r.end_ms, r.all_day, r.title, r.location, r.kind, r.status, r.self_response, r.organizer_self, r.recurring_id, r.guests.length, now);
      d.prepare("DELETE FROM attendees WHERE event_id = ?").run(r.event_id);
      for (const g of r.guests) insA.run(r.event_id, g.email, g.name, g.response);
      // A retitled event is read again: the people it names may have changed.
      if (prevTitle !== undefined && prevTitle !== r.title) {
        d.prepare("DELETE FROM reviewed WHERE event_id = ?").run(r.event_id);
        d.prepare("DELETE FROM mentions WHERE event_id = ?").run(r.event_id);
      }
    }
    d.exec("COMMIT");
    return { events: rows.length, dropped };
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

// ── Who a guest is ──

function emailLedger() {
  try {
    return require("./email-people.js");
  } catch {
    return null;
  }
}

/** The wiki page of a guest address: a link set here wins, else the email ledger's. */
function wikiIdForGuest(email) {
  const e = String(email || "").toLowerCase();
  const own = db().prepare("SELECT wiki_id, ignored FROM attendee_links WHERE email = ?").get(e);
  if (own) return own.ignored ? null : own.wiki_id || null;
  const ep = emailLedger();
  try {
    return ep ? ep.wikiIdForEmail(e) : null;
  } catch {
    return null;
  }
}

function isIgnoredGuest(email) {
  const e = String(email || "").toLowerCase();
  if (db().prepare("SELECT 1 FROM attendee_links WHERE email = ? AND ignored = 1").get(e)) return true;
  const ep = emailLedger();
  try {
    if (ep && ep.isRoleAddress(e)) return true;
    if (ep && ep.db().prepare("SELECT 1 FROM people WHERE email = ? AND ignored = 1").get(e)) return true;
  } catch { /* no ledger */ }
  return false;
}

function inContacts(email) {
  const ep = emailLedger();
  try {
    return ep ? ep.db().prepare("SELECT name, resource FROM contacts WHERE email = ?").get(String(email).toLowerCase()) || null : null;
  } catch {
    return null;
  }
}

function linkGuest(email, wikiId, note = null) {
  db()
    .prepare(
      `INSERT INTO attendee_links (email, wiki_id, ignored, note, at) VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(email) DO UPDATE SET wiki_id = excluded.wiki_id, ignored = 0, note = excluded.note, at = excluded.at`,
    )
    .run(String(email).toLowerCase(), wikiId, note, Date.now());
}

function ignoreGuest(email, note = null) {
  db()
    .prepare(
      `INSERT INTO attendee_links (email, wiki_id, ignored, note, at) VALUES (?, NULL, 1, ?, ?)
       ON CONFLICT(email) DO UPDATE SET wiki_id = NULL, ignored = 1, note = excluded.note, at = excluded.at`,
    )
    .run(String(email).toLowerCase(), note, Date.now());
}

// ── Meetings per page ──

/** wiki_id → Map(event_id → event row), every held or upcoming event linked to that page. */
function meetingsByPage({ now = Date.now() } = {}) {
  const d = db();
  const out = new Map();
  const add = (wikiId, ev) => {
    if (!wikiId) return;
    if (!out.has(wikiId)) out.set(wikiId, new Map());
    out.get(wikiId).set(ev.event_id, ev);
  };
  const live = "e.status != 'cancelled' AND COALESCE(e.self_response, '') != 'declined'";
  const guestCache = new Map();
  for (const r of d.prepare(`SELECT e.*, a.email FROM events e JOIN attendees a ON a.event_id = e.event_id WHERE ${live}`).all()) {
    if (!guestCache.has(r.email)) guestCache.set(r.email, wikiIdForGuest(r.email));
    add(guestCache.get(r.email), r);
  }
  for (const r of d.prepare(`SELECT e.*, m.wiki_id FROM events e JOIN mentions m ON m.event_id = e.event_id WHERE ${live}`).all()) add(r.wiki_id, r);
  return out;
}

function totals(evsIn, now = Date.now()) {
  const evs = [...evsIn];
  const held = evs.filter((e) => e.end_ms <= now).sort((a, b) => a.start_ms - b.start_ms);
  const upcoming = evs.filter((e) => e.end_ms > now).sort((a, b) => a.start_ms - b.start_ms);
  const count = (k) => held.filter((e) => e.kind === k).length;
  return {
    meetings: held.length,
    in_person: count("in_person"),
    video: count("video"),
    group: held.filter((e) => e.guests > SMALL_MAX_GUESTS).length,
    first_at: held.length ? held[0].start_ms : null,
    last_at: held.length ? held[held.length - 1].start_ms : null,
    next_at: upcoming.length ? upcoming[0].start_ms : null,
  };
}

function pageTitle(wikiId) {
  try {
    const ws = require("./wiki-store.js");
    const row = ws.getPage(wikiId);
    return row ? { title: row.title || wikiId, active: row.status === "active" } : null;
  } catch {
    return { title: wikiId, active: true };
  }
}

/** Pages with at least one held meeting, newest meeting first; `stale` = a summary is due. */
function candidates({ staleOnly = false, limit = null, now = Date.now() } = {}) {
  const d = db();
  const out = [];
  for (const [wikiId, evs] of meetingsByPage({ now })) {
    const t = totals(evs.values(), now);
    if (!t.meetings) continue;
    const l = d.prepare("SELECT * FROM links WHERE wiki_id = ?").get(wikiId);
    let stale = !l || !l.summarized_at;
    if (!stale && t.last_at > (l.summarized_last_at || 0)) {
      stale = now - l.summarized_at >= RESUMMARY_DAYS * DAY || t.meetings - (l.summarized_n || 0) >= RESUMMARY_NEW_MEETINGS;
    }
    if (staleOnly && !stale) continue;
    out.push({ wiki_id: wikiId, ...t, stale });
  }
  out.sort((a, b) => b.last_at - a.last_at);
  const rows = limit ? out.slice(0, limit) : out;
  for (const r of rows) r.name = pageTitle(r.wiki_id)?.title || r.wiki_id;
  return rows;
}

/** Guests with no page who qualify: 2+ held small meetings, or 1 when in Contacts. */
function unmatched({ limit = null, now = Date.now() } = {}) {
  const d = db();
  const rows = d
    .prepare(
      `SELECT a.email, a.name, e.event_id, e.start_ms, e.title, e.kind, e.guests FROM attendees a
       JOIN events e ON e.event_id = a.event_id WHERE ${HELD_SQL}`,
    )
    .all(now);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.email)) by.set(r.email, { email: r.email, names: new Set(), small: 0, meetings: 0, first_at: r.start_ms, last_at: r.start_ms, titles: [] });
    const g = by.get(r.email);
    if (r.name) g.names.add(r.name);
    g.meetings++;
    if (r.guests <= SMALL_MAX_GUESTS) g.small++;
    g.first_at = Math.min(g.first_at, r.start_ms);
    g.last_at = Math.max(g.last_at, r.start_ms);
    g.titles.push({ date: isoDay(r.start_ms), title: r.title, kind: r.kind, guests: r.guests });
  }
  const out = [];
  for (const g of by.values()) {
    if (wikiIdForGuest(g.email) || isIgnoredGuest(g.email)) continue;
    const contact = inContacts(g.email);
    if (g.small < (contact ? MIN_MEETINGS_IN_CONTACTS : MIN_MEETINGS)) continue;
    g.titles.sort((a, b) => (a.date < b.date ? 1 : -1));
    out.push({ email: g.email, names: [...g.names], contact, meetings: g.meetings, small_meetings: g.small, first_at: g.first_at, last_at: g.last_at, titles: g.titles.slice(0, 20) });
  }
  out.sort((a, b) => b.last_at - a.last_at);
  return limit ? out.slice(0, limit) : out;
}

/** Held events whose title the model has not read yet, newest first. */
function titlesPending({ limit = 200, now = Date.now() } = {}) {
  const d = db();
  const rows = d
    .prepare(
      `SELECT e.event_id, e.start_ms, e.all_day, e.title, e.kind, e.guests FROM events e
       LEFT JOIN reviewed r ON r.event_id = e.event_id
       WHERE r.event_id IS NULL AND e.title IS NOT NULL AND TRIM(e.title) != '' AND ${HELD_SQL}
       ORDER BY e.start_ms DESC LIMIT ?`,
    )
    .all(now, limit);
  return rows.map((r) => {
    const linked = [];
    for (const a of d.prepare("SELECT email, name FROM attendees WHERE event_id = ?").all(r.event_id)) {
      linked.push({ name: a.name || null, wiki_id: wikiIdForGuest(a.email) });
    }
    return { event_id: r.event_id, date: isoDay(r.start_ms), all_day: !!r.all_day, title: r.title, kind: r.kind, guests: linked };
  });
}

/**
 * Record the model's reading of a batch of titles: `{event_id: [wiki_id, ...]}`.
 * Every key is marked read (an empty list = names nobody); each wiki id is a
 * person the title names. Unknown event ids and wiki ids are reported, not stored.
 */
function review(map, { pageExists = (id) => !!pageTitle(id) } = {}) {
  const d = db();
  const now = Date.now();
  const res = { reviewed: 0, mentions: 0, unknown_events: [], unknown_pages: [] };
  d.exec("BEGIN IMMEDIATE");
  try {
    for (const [eventId, ids] of Object.entries(map || {})) {
      const ev = d.prepare("SELECT title FROM events WHERE event_id = ?").get(eventId);
      if (!ev) {
        res.unknown_events.push(eventId);
        continue;
      }
      d.prepare("DELETE FROM mentions WHERE event_id = ?").run(eventId);
      for (const id of Array.isArray(ids) ? ids : []) {
        if (!pageExists(id)) {
          res.unknown_pages.push(id);
          continue;
        }
        d.prepare("INSERT OR IGNORE INTO mentions (event_id, wiki_id, at) VALUES (?, ?, ?)").run(eventId, id, now);
        res.mentions++;
      }
      d.prepare("INSERT OR REPLACE INTO reviewed (event_id, title, at) VALUES (?, ?, ?)").run(eventId, ev.title, now);
      res.reviewed++;
    }
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
  return res;
}

/** One page's meetings for the summarising turn. Locations are context, never page text. */
function personDigest(wikiId, { limit = 80, now = Date.now() } = {}) {
  const evs = meetingsByPage({ now }).get(wikiId);
  if (!evs) return { wiki_id: wikiId, meetings: [], totals: totals([], now), by_year: {} };
  const d = db();
  const list = [...evs.values()].sort((a, b) => b.start_ms - a.start_ms);
  const byYear = {};
  for (const e of list) if (e.end_ms <= now) byYear[new Date(e.start_ms).getUTCFullYear()] = (byYear[new Date(e.start_ms).getUTCFullYear()] || 0) + 1;
  const series = {};
  for (const e of list) if (e.recurring_id) series[e.recurring_id] = (series[e.recurring_id] || 0) + 1;
  const meetings = list.slice(0, limit).map((e) => ({
    date: isoDay(e.start_ms),
    upcoming: e.end_ms > now,
    title: e.title,
    kind: e.kind,
    location: e.kind === "in_person" ? e.location : null,
    via: d.prepare("SELECT 1 FROM mentions WHERE event_id = ? AND wiki_id = ?").get(e.event_id, wikiId) ? "title" : "guest",
    others: d
      .prepare("SELECT name, email FROM attendees WHERE event_id = ?")
      .all(e.event_id)
      .map((a) => ({ name: a.name, wiki_id: wikiIdForGuest(a.email) }))
      .filter((a) => a.wiki_id !== wikiId),
    series: e.recurring_id && series[e.recurring_id] > 1 ? series[e.recurring_id] : null,
  }));
  return { wiki_id: wikiId, name: pageTitle(wikiId)?.title || wikiId, totals: totals(list, now), by_year: byYear, meetings };
}

function markSummarized(wikiId, { now = Date.now() } = {}) {
  const evs = meetingsByPage({ now }).get(wikiId);
  const t = totals(evs ? evs.values() : [], now);
  db()
    .prepare(
      `INSERT INTO links (wiki_id, summarized_at, summarized_last_at, summarized_n) VALUES (?, ?, ?, ?)
       ON CONFLICT(wiki_id) DO UPDATE SET summarized_at = excluded.summarized_at,
         summarized_last_at = excluded.summarized_last_at, summarized_n = excluded.summarized_n`,
    )
    .run(wikiId, now, t.last_at, t.meetings);
}

/** wiki_id → Set of day numbers with a held meeting (people-watch's contact rhythm). */
function contactDays({ now = Date.now() } = {}) {
  const out = new Map();
  for (const [wikiId, evs] of meetingsByPage({ now })) {
    const set = new Set();
    for (const e of evs.values()) if (e.end_ms <= now) set.add(Math.floor(e.start_ms / DAY));
    if (set.size) out.set(wikiId, set);
  }
  return out;
}

// ── Wiki section ──

const SECTION_START = "<!-- calendar-people:start -->";
const SECTION_END = "<!-- calendar-people:end -->";

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The facts line, from the ledger only. Pure. */
function factsLine(t, { today = Date.now() } = {}) {
  const kinds = [];
  if (t.in_person) kinds.push(`${t.in_person} in person`);
  if (t.video) kinds.push(`${t.video} video`);
  if (t.group) kinds.push(`${t.group} group`);
  const parts = [`${plural(t.meetings, "meeting")}${kinds.length ? ` (${kinds.join(", ")})` : ""}`];
  if (t.first_at) parts.push(`first ${isoDay(t.first_at)}`);
  if (t.last_at) parts.push(`last ${isoDay(t.last_at)}`);
  if (t.next_at) parts.push(`next ${isoDay(t.next_at)}`);
  return `_From Google Calendar · ${parts.join(" · ")} · updated ${isoDay(today)}_`;
}

/** rawMd with its `## Meetings` block replaced or appended. Pure. */
function renderSection(rawMd, { facts, summary }) {
  const block = `${SECTION_START}\n${facts}\n\n${String(summary).trim()}\n${SECTION_END}`;
  const re = new RegExp(`${SECTION_START}[\\s\\S]*?${SECTION_END}`);
  if (re.test(rawMd)) return rawMd.replace(re, () => block);
  return `${rawMd.replace(/\s*$/, "")}\n\n## Meetings\n${block}\n`;
}

function writeSection(wikiId, summary, { now = Date.now() } = {}) {
  const ws = require("./wiki-store.js");
  try {
    const row = ws.getPage(wikiId);
    if (!row) throw new Error(`no wiki page ${wikiId}`);
    const evs = meetingsByPage({ now }).get(wikiId);
    const t = totals(evs ? evs.values() : [], now);
    if (!t.meetings) throw new Error(`${wikiId} has no held meetings in the ledger`);
    const out = ws.savePage(wikiId, renderSection(row.raw_md, { facts: factsLine(t, { today: now }), summary }), { editedBy: "people-meetings" });
    markSummarized(wikiId, { now });
    return { wiki_id: wikiId, rev: out.rev, changed: Boolean(out.changed || out.isNew) };
  } finally {
    ws.closeDb();
  }
}

module.exports = {
  DB_PATH,
  SMALL_MAX_GUESTS,
  MIN_MEETINGS,
  MIN_MEETINGS_IN_CONTACTS,
  RESUMMARY_DAYS,
  RESUMMARY_NEW_MEETINGS,
  SECTION_START,
  SECTION_END,
  db,
  closeDb,
  getMeta,
  setMeta,
  config,
  account,
  selfSet,
  eventKind,
  normalizeEvent,
  ingestWindow,
  wikiIdForGuest,
  linkGuest,
  ignoreGuest,
  meetingsByPage,
  totals,
  candidates,
  unmatched,
  titlesPending,
  review,
  personDigest,
  markSummarized,
  contactDays,
  factsLine,
  renderSection,
  writeSection,
};
