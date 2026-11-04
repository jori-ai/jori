"use strict";

// chat-people — who the user texts with (iMessage, WhatsApp), and when.
//
// The messaging half of the people-from-email pipeline (lib/email-people.js,
// jobs/people-email.md). Code owns the structure: which phone numbers and
// emails belong to which already-identified person (Contacts), how many
// messages passed in each direction, in which chats, between which dates, and
// which people are due a summary. A model (jobs/people-email.md Part B) owns
// the meaning: whether a matched number really is that person, and the
// "what they talk about" summary written onto the person's wiki page.
//
// Start set: people who already have a wiki page (`entity: person`). Nobody is
// added to the wiki from a text alone.
//
// Privacy: message text is never stored. The ledger (data/chat-people.db)
// holds handles, counts and dates. A bounded, truncated sample of one person's
// direct-chat messages is read live from chat.db / the WhatsApp inbox when the
// summarising turn asks for it (`personDigest`), and the page gets prose only.
//
// Sources and their limits:
//   iMessage  ~/Library/Messages/chat.db, both directions, back to 2013. Since
//             spring 2026 macOS leaves message.text NULL and keeps the body only
//             in attributedBody (an NSArchiver typedstream) — decoded here.
//   WhatsApp  data/whatsapp-inbox.jsonl, what the gateway logged, only
//             since the gateway started. The user's own messages are logged
//             (`from_me`) only since 2026-10-27; before that, inbound only.
//             Reported as such on the page, never implied away.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const imessageDb = require("./imessage-db");

const { installTools } = require("./root.cjs");
const HOME = os.homedir();
const DB_PATH = process.env.CHAT_PEOPLE_DB || installTools("data/chat-people.db");
const CHAT_DB = process.env.CHAT_PEOPLE_CHAT_DB || path.join(HOME, "Library/Messages/chat.db");
const ADDRESS_BOOK = process.env.CHAT_PEOPLE_ADDRESS_BOOK || path.join(HOME, "Library/Application Support/AddressBook");
const WA_INBOX = process.env.CHAT_PEOPLE_WA_INBOX || installTools("data/whatsapp-inbox.jsonl");

const APPLE_EPOCH_S = 978307200;
const CHAT_STYLE_GROUP = 43;
const CHAT_STYLE_DIRECT = 45;

// A person is due a Texts block with at least this much history: messages in
// 1:1 chats, or their own messages in group chats.
const MIN_DIRECT = 3;
const MIN_GROUP = 5;
// An active texter is not re-summarised nightly: stale again only after this
// many days and this many new messages since the last summary.
const RESUMMARY_DAYS = 14;
const RESUMMARY_NEW_MESSAGES = 10;

const WA_TEXT_TYPES = new Set(["conversation", "extendedTextMessage"]);

// How the facts line names the owner ("32 from <owner>"); generic default.
function ownerName() {
  try {
    return require("./instance.cjs").localConfig("chat-people", { owner_name: "the user" }).owner_name || "the user";
  } catch {
    return "the user";
  }
}

function selfWikiIds() {
  try {
    return new Set(require("./instance.cjs").localConfig("chat-people", { self_wiki_ids: [] }).self_wiki_ids || []);
  } catch {
    return new Set();
  }
}

// ── Ledger ──

let _db = null;

function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS people (
      wiki_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS handles (
      wiki_id TEXT NOT NULL,
      handle_key TEXT NOT NULL,
      via TEXT NOT NULL,
      label TEXT,
      PRIMARY KEY (wiki_id, handle_key)
    );
    CREATE TABLE IF NOT EXISTS rejected (
      wiki_id TEXT NOT NULL,
      handle_key TEXT NOT NULL,
      note TEXT,
      PRIMARY KEY (wiki_id, handle_key)
    );
    CREATE TABLE IF NOT EXISTS stats (
      wiki_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      kind TEXT NOT NULL,
      chat_ref TEXT NOT NULL,
      chat_name TEXT,
      n_in INTEGER NOT NULL DEFAULT 0,
      n_out INTEGER NOT NULL DEFAULT 0,
      first_at INTEGER,
      last_at INTEGER,
      PRIMARY KEY (wiki_id, channel, kind, chat_ref)
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

// ── Handle and name geometry ──

// A handle reduced to what identifies it across spellings: an email
// lowercased, a phone as its last 9 digits (so "+972 54…" and "054…" meet).
function handleKey(handle) {
  const s = String(handle ?? "").trim().toLowerCase();
  if (s.includes("@")) return s;
  const digits = s.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-9) : null;
}

function maskKey(key) {
  return key.includes("@") ? key.replace(/^(.).*(@.*)$/, "$1…$2") : `…${key.slice(-4)}`;
}

// Names compared as letters only: case, accents, punctuation and spacing do
// not make two names different. Works for Hebrew as well as Latin.
function normName(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Body decoding (attributedBody typedstream) lives in imessage-db.js, shared
// with the imsg CLI and the imessage-channel watcher.
const { typedstreamText, messageText } = imessageDb;

function openReadOnly(file) {
  return new DatabaseSync(file, { readOnly: true });
}

// ── Contacts (macOS AddressBook) ──

// Every Contacts card with its numbers and emails (imessage-db.js). Throws when
// no AddressBook can be read, so a caller never mistakes that for "nobody".
function readAddressBook(root = ADDRESS_BOOK) {
  return imessageDb.readAddressBook(root);
}

// ── Who is the handle? (people × Contacts cards) ──

// `people`: [{wiki_id, name, emails[]}]; `cards`: readAddressBook() output.
// A card belongs to a person when it carries one of their email addresses
// (`email`, strong) or its first + last name is the person's name (`name`,
// medium; the summarising turn checks the conversation fits). A handle that
// ends up on two different people is dropped for both: it cannot be told apart.
function resolveHandles(people, cards, { selfIds = new Set() } = {}) {
  const byEmail = new Map();
  const byName = new Map();
  for (const c of cards) {
    for (const e of c.emails) {
      const k = String(e).trim().toLowerCase();
      if (!byEmail.has(k)) byEmail.set(k, []);
      byEmail.get(k).push(c);
    }
    const n = normName(`${c.first} ${c.last}`);
    if (c.first && c.last && n) {
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(c);
    }
  }
  const claims = new Map(); // handle_key -> Map(wiki_id -> {via,label})
  for (const p of people) {
    if (selfIds.has(p.wiki_id)) continue;
    const matched = new Map(); // card.id -> {card, via}
    for (const e of p.emails || []) {
      for (const c of byEmail.get(String(e).toLowerCase()) || []) matched.set(c.id, { card: c, via: "email" });
    }
    for (const c of byName.get(normName(p.name)) || []) if (!matched.has(c.id)) matched.set(c.id, { card: c, via: "name" });
    for (const { card, via } of matched.values()) {
      const label = `${card.first} ${card.last}`.trim() || card.org;
      for (const h of [...card.phones, ...card.emails]) {
        const key = handleKey(h);
        if (!key) continue;
        if (!claims.has(key)) claims.set(key, new Map());
        const forKey = claims.get(key);
        const prev = forKey.get(p.wiki_id);
        if (!prev || (prev.via === "name" && via === "email")) forKey.set(p.wiki_id, { via, label });
      }
    }
  }
  const out = new Map(); // wiki_id -> [{handle_key, via, label}]
  const conflicts = [];
  for (const [key, forKey] of claims) {
    if (forKey.size > 1) {
      conflicts.push({ handle_key: key, wiki_ids: [...forKey.keys()] });
      continue;
    }
    const [[wikiId, v]] = forKey;
    if (!out.has(wikiId)) out.set(wikiId, []);
    out.get(wikiId).push({ handle_key: key, via: v.via, label: v.label });
  }
  return { handles: out, conflicts };
}

// ── Sources ──

// chat.db dates are nanoseconds since 2001 (seconds on very old rows) — past
// 2^53, so they are folded to seconds in SQL before they reach JavaScript.
const SEC = (col) => `(CASE WHEN ${col} > 1000000000000 THEN ${col} / 1000000000 ELSE ${col} END)`;
const appleToMs = (sec) => (Number(sec) + APPLE_EPOCH_S) * 1000;

// iMessage: per handle, 1:1 totals and the handle's own messages in group chats.
// Tapbacks and group-event rows are not messages; attachment-only ones are.
function scanImessage(wanted, { chatDb = CHAT_DB } = {}) {
  const d = openReadOnly(chatDb);
  const rows = [];
  try {
    const real = "(m.associated_message_type IS NULL OR m.associated_message_type = 0) AND m.item_type = 0 AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)";
    const direct = d
      .prepare(
        `SELECT h.id handle, c.ROWID chat, m.is_from_me out, COUNT(*) n, MIN(${SEC("m.date")}) lo, MAX(${SEC("m.date")}) hi
         FROM chat c
         JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
         JOIN handle h ON h.ROWID = chj.handle_id
         JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
         JOIN message m ON m.ROWID = cmj.message_id
         WHERE c.style = ${CHAT_STYLE_DIRECT} AND ${real}
         GROUP BY h.id, c.ROWID, m.is_from_me`,
      )
      .all();
    for (const r of direct) {
      const key = handleKey(r.handle);
      if (!key || !wanted.has(key)) continue;
      rows.push({ handle_key: key, kind: "direct", chat_ref: `imessage:${r.chat}`, chat_name: null, n_in: r.out ? 0 : r.n, n_out: r.out ? r.n : 0, first_at: appleToMs(r.lo), last_at: appleToMs(r.hi) });
    }
    const group = d
      .prepare(
        `SELECT h.id handle, c.ROWID chat, COALESCE(NULLIF(c.display_name, ''), '') name,
                (SELECT COUNT(*) FROM chat_handle_join x WHERE x.chat_id = c.ROWID) members,
                COUNT(*) n, MIN(${SEC("m.date")}) lo, MAX(${SEC("m.date")}) hi
         FROM chat c
         JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
         JOIN message m ON m.ROWID = cmj.message_id
         JOIN handle h ON h.ROWID = m.handle_id
         WHERE c.style = ${CHAT_STYLE_GROUP} AND m.is_from_me = 0 AND ${real}
         GROUP BY h.id, c.ROWID`,
      )
      .all();
    for (const r of group) {
      const key = handleKey(r.handle);
      if (!key || !wanted.has(key)) continue;
      rows.push({ handle_key: key, kind: "group", chat_ref: `imessage:${r.chat}`, chat_name: r.name || `group of ${r.members + 1}`, n_in: r.n, n_out: 0, first_at: appleToMs(r.lo), last_at: appleToMs(r.hi) });
    }
  } finally {
    d.close();
  }
  return rows;
}

function* waMessages(inbox = WA_INBOX) {
  if (!fs.existsSync(inbox)) return;
  for (const line of fs.readFileSync(inbox, "utf8").split("\n")) {
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.kind !== "message" || !WA_TEXT_TYPES.has(m.type) || !m.text) continue;
    const chat = String(m.chat_id || "");
    // Phone-number chats and groups only; channels, broadcasts and status
    // updates are not people talking to the user.
    const isGroup = chat.endsWith("@g.us");
    if (!isGroup && !chat.endsWith("@s.whatsapp.net") && !chat.endsWith("@lid")) continue;
    // The user's own message: in a 1:1 chat it counts toward the other person
    // (keyed by the chat), in a group it is nobody else's message.
    const out = m.from_me === true;
    if (out && isGroup) continue;
    // lang-regex-ok: strips the @server suffix of a WhatsApp JID (a machine identifier), not words
    const key = handleKey(String((out ? chat : m.sender) || (isGroup ? "" : chat)).replace(/@.*$/, ""));
    const at = Date.parse(m.ts || "") || (m.timestamp ? Number(m.timestamp) * 1000 : NaN);
    if (!key || !Number.isFinite(at)) continue;
    yield { handle_key: key, group: isGroup, chat_ref: `whatsapp:${chat}`, at, text: m.text, out };
  }
}

// WhatsApp: inbound, plus the user's own messages since the gateway logged them.
function scanWhatsapp(wanted, { inbox = WA_INBOX } = {}) {
  const acc = new Map();
  for (const m of waMessages(inbox)) {
    if (!wanted.has(m.handle_key)) continue;
    const k = `${m.handle_key}|${m.group ? "group" : "direct"}|${m.chat_ref}`;
    const a = acc.get(k) || { handle_key: m.handle_key, kind: m.group ? "group" : "direct", chat_ref: m.chat_ref, chat_name: m.group ? "WhatsApp group" : null, n_in: 0, n_out: 0, first_at: m.at, last_at: m.at };
    if (m.out) a.n_out++;
    else a.n_in++;
    a.first_at = Math.min(a.first_at, m.at);
    a.last_at = Math.max(a.last_at, m.at);
    acc.set(k, a);
  }
  return [...acc.values()];
}

function waCoverage(inbox = WA_INBOX) {
  let first = null;
  for (const m of waMessages(inbox)) first = first == null ? m.at : Math.min(first, m.at);
  return first;
}

// ── Seeds: the people already identified ──

// Wiki person pages, each with the email addresses the email scanner knows.
function loadPeople() {
  const ws = require("./wiki-store.js");
  const wp = require("./wiki-people.js");
  const ep = require("./email-people.js");
  try {
    const emailsByWiki = new Map();
    try {
      const d = ep.db();
      for (const l of d.prepare("SELECT person_key, wiki_id FROM links WHERE wiki_id IS NOT NULL").all()) {
        const addrs = d.prepare("SELECT email FROM people WHERE person_key = ? AND ignored = 0").all(l.person_key).map((r) => r.email);
        emailsByWiki.set(l.wiki_id, [...new Set([l.person_key, ...addrs])]);
      }
    } catch {
      // no email ledger yet: names alone
    }
    return wp.pagesByEntity().people.map((row) => {
      let fm = {};
      try {
        fm = JSON.parse(row.frontmatter_json || "{}");
      } catch {
        // keep {}
      }
      return { wiki_id: row.id, name: fm.name || row.title || row.id, emails: emailsByWiki.get(row.id) || [], locked: Boolean(row.pin_locked) };
    });
  } finally {
    ws.closeDb();
  }
}

// ── Sync ──

function replaceLedger({ people, handles, stats, conflicts }) {
  const d = db();
  const rejected = new Set(d.prepare("SELECT wiki_id, handle_key FROM rejected").all().map((r) => `${r.wiki_id}|${r.handle_key}`));
  d.exec("BEGIN IMMEDIATE");
  try {
    d.exec("DELETE FROM people; DELETE FROM handles; DELETE FROM stats;");
    const insP = d.prepare("INSERT INTO people (wiki_id, name, locked) VALUES (?, ?, ?)");
    for (const p of people) insP.run(p.wiki_id, p.name, p.locked ? 1 : 0);
    const insH = d.prepare("INSERT INTO handles (wiki_id, handle_key, via, label) VALUES (?, ?, ?, ?)");
    for (const [wikiId, list] of handles) for (const h of list) insH.run(wikiId, h.handle_key, h.via, h.label || null);
    const insS = d.prepare(
      `INSERT INTO stats (wiki_id, channel, kind, chat_ref, chat_name, n_in, n_out, first_at, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(wiki_id, channel, kind, chat_ref) DO UPDATE SET
         n_in = n_in + excluded.n_in, n_out = n_out + excluded.n_out,
         first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at)`,
    );
    for (const s of stats) {
      if (rejected.has(`${s.wiki_id}|${s.handle_key}`)) continue;
      insS.run(s.wiki_id, s.channel, s.kind, s.chat_ref, s.chat_name, s.n_in, s.n_out, s.first_at, s.last_at);
    }
    setMeta("conflicts", JSON.stringify(conflicts));
    setMeta("synced_at", new Date().toISOString());
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

// Full rescan. Cheap (two SQL passes and one JSONL read), so it is recomputed
// whole rather than kept incrementally. Throws, leaving the ledger untouched,
// when Contacts or chat.db cannot be read.
function sync({ people = loadPeople(), cards = null, addressBook = ADDRESS_BOOK, chatDb = CHAT_DB, inbox = WA_INBOX, selfIds = selfWikiIds() } = {}) {
  const book = cards || readAddressBook(addressBook);
  const { handles, conflicts } = resolveHandles(people, book, { selfIds });
  const owner = new Map(); // handle_key -> wiki_id
  for (const [wikiId, list] of handles) for (const h of list) owner.set(h.handle_key, wikiId);
  const rejected = db().prepare("SELECT wiki_id, handle_key FROM rejected").all();
  for (const r of rejected) if (owner.get(r.handle_key) === r.wiki_id) owner.delete(r.handle_key);
  const wanted = new Set(owner.keys());
  const stats = [];
  for (const s of scanImessage(wanted, { chatDb })) stats.push({ ...s, channel: "imessage", wiki_id: owner.get(s.handle_key) });
  for (const s of scanWhatsapp(wanted, { inbox })) stats.push({ ...s, channel: "whatsapp", wiki_id: owner.get(s.handle_key) });
  replaceLedger({ people: people.filter((p) => !selfIds.has(p.wiki_id)), handles, stats, conflicts });
  const wa = waCoverage(inbox);
  if (wa != null) setMeta("whatsapp_since", String(wa));
  return { people: people.length, with_handles: handles.size, handles: owner.size, conflicts: conflicts.length, stats_rows: stats.length };
}

// ── Candidates ──

function totalsFor(rows) {
  const t = { direct: 0, group: 0, first_at: null, last_at: null };
  for (const r of rows) {
    t[r.kind] += r.n_in + r.n_out;
    t.first_at = t.first_at == null ? r.first_at : Math.min(t.first_at, r.first_at);
    t.last_at = t.last_at == null ? r.last_at : Math.max(t.last_at, r.last_at);
  }
  return t;
}

function candidates({ staleOnly = false, limit = null, now = Date.now() } = {}) {
  const d = db();
  const links = new Map(d.prepare("SELECT * FROM links").all().map((l) => [l.wiki_id, l]));
  const byPerson = new Map();
  for (const s of d.prepare("SELECT * FROM stats").all()) {
    if (!byPerson.has(s.wiki_id)) byPerson.set(s.wiki_id, []);
    byPerson.get(s.wiki_id).push(s);
  }
  const names = new Map(d.prepare("SELECT wiki_id, name FROM people").all().map((p) => [p.wiki_id, p.name]));
  // A pin_locked page is never edited by this pipeline, so it is never due.
  const locked = new Set(d.prepare("SELECT wiki_id FROM people WHERE locked = 1").all().map((p) => p.wiki_id));
  let out = [];
  for (const [wikiId, rows] of byPerson) {
    if (locked.has(wikiId)) continue;
    const t = totalsFor(rows);
    if (t.direct < MIN_DIRECT && t.group < MIN_GROUP) continue;
    const link = links.get(wikiId) || null;
    const n = t.direct + t.group;
    const stale =
      !link ||
      !link.summarized_at ||
      (now - link.summarized_at >= RESUMMARY_DAYS * 864e5 && n - (link.summarized_n || 0) >= RESUMMARY_NEW_MESSAGES);
    out.push({
      wiki_id: wikiId,
      name: names.get(wikiId) || wikiId,
      direct_messages: t.direct,
      group_messages: t.group,
      first_at: t.first_at,
      last_at: t.last_at,
      channels: [...new Set(rows.map((r) => r.channel))].sort(),
      summarized_at: link?.summarized_at || null,
      stale,
    });
  }
  out.sort((a, b) => b.last_at - a.last_at || b.direct_messages - a.direct_messages);
  if (staleOnly) out = out.filter((c) => c.stale);
  if (limit) out = out.slice(0, limit);
  return out;
}

// ── One person, read live ──

function yearOf(ms) {
  return new Date(ms).getUTCFullYear();
}

// iMessage 1:1 messages for a person's handles, with text, oldest first.
function imessageDirectMessages(handleKeys, { chatDb = CHAT_DB } = {}) {
  const d = openReadOnly(chatDb);
  const out = [];
  try {
    const rows = d
      .prepare(
        `SELECT h.id handle, ${SEC("m.date")} date, m.is_from_me out, m.text, m.attributedBody body
         FROM chat c
         JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
         JOIN handle h ON h.ROWID = chj.handle_id
         JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
         JOIN message m ON m.ROWID = cmj.message_id
         WHERE c.style = ${CHAT_STYLE_DIRECT}
           AND (m.associated_message_type IS NULL OR m.associated_message_type = 0) AND m.item_type = 0
           AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
         ORDER BY m.date`,
      )
      .all();
    for (const r of rows) {
      const key = handleKey(r.handle);
      if (!key || !handleKeys.has(key)) continue;
      out.push({ at: appleToMs(r.date), channel: "imessage", from: r.out ? "user" : "them", text: messageText(r.text, r.body) });
    }
  } finally {
    d.close();
  }
  return out;
}

function whatsappDirectMessages(handleKeys, { inbox = WA_INBOX } = {}) {
  const out = [];
  for (const m of waMessages(inbox)) {
    if (m.group || !handleKeys.has(m.handle_key)) continue;
    // lang-regex-ok: collapses whitespace in a sample line; decides nothing about meaning
    out.push({ at: m.at, channel: "whatsapp", from: m.out ? "me" : "them", text: String(m.text).replace(/\s+/g, " ").trim() });
  }
  return out.sort((a, b) => a.at - b.at);
}

// The newest `recent` messages plus an even spread of the older ones, each
// cut to `chars`: enough for a model to say what the two talk about without
// the whole history leaving the machine's own sources.
function sampleMessages(messages, { limit = 60, recent = 20, chars = 200 } = {}) {
  const withText = messages.filter((m) => m.text);
  if (withText.length <= limit) return withText.map((m) => cut(m, chars));
  const tail = withText.slice(-recent);
  const older = withText.slice(0, withText.length - recent);
  const want = limit - recent;
  const step = older.length / want;
  const spread = Array.from({ length: want }, (_, i) => older[Math.floor(i * step)]);
  return [...spread, ...tail].map((m) => cut(m, chars));
}

function cut(m, chars) {
  return { ...m, text: m.text.length > chars ? `${m.text.slice(0, chars)}…` : m.text };
}

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString().slice(0, 10);
}

function personDigest(wikiId, { sample = 60, chatDb = CHAT_DB, inbox = WA_INBOX } = {}) {
  const d = db();
  const person = d.prepare("SELECT * FROM people WHERE wiki_id = ?").get(wikiId);
  if (!person) throw new Error(`${wikiId} is not in the ledger (run sync, or the person has no matched handles)`);
  const rejected = new Set(d.prepare("SELECT handle_key FROM rejected WHERE wiki_id = ?").all(wikiId).map((r) => r.handle_key));
  const handles = d.prepare("SELECT * FROM handles WHERE wiki_id = ?").all(wikiId).filter((h) => !rejected.has(h.handle_key));
  const keys = new Set(handles.map((h) => h.handle_key));
  const stats = d.prepare("SELECT * FROM stats WHERE wiki_id = ?").all(wikiId);
  const direct = [...imessageDirectMessages(keys, { chatDb }), ...whatsappDirectMessages(keys, { inbox })].sort((a, b) => a.at - b.at);
  const byYear = {};
  for (const m of direct) byYear[yearOf(m.at)] = (byYear[yearOf(m.at)] || 0) + 1;
  const sum = (ch) => {
    const rows = stats.filter((s) => s.channel === ch && s.kind === "direct");
    const t = totalsFor(rows);
    return rows.length
      ? { messages: t.direct, from_user: rows.reduce((a, r) => a + r.n_out, 0), from_them: rows.reduce((a, r) => a + r.n_in, 0), first: iso(t.first_at), last: iso(t.last_at) }
      : null;
  };
  return {
    wiki_id: wikiId,
    name: person.name,
    handles: handles.map((h) => ({ via: h.via, card: h.label, handle: maskKey(h.handle_key), key: h.handle_key })),
    direct: { imessage: sum("imessage"), whatsapp: sum("whatsapp") },
    groups: stats
      .filter((s) => s.kind === "group")
      .map((s) => ({ channel: s.channel, name: s.chat_name, their_messages: s.n_in, first: iso(s.first_at), last: iso(s.last_at) }))
      .sort((a, b) => (b.last || "").localeCompare(a.last || "")),
    direct_by_year: byYear,
    sample: sampleMessages(direct, { limit: sample }).map((m) => ({ date: iso(m.at), channel: m.channel, from: m.from, text: m.text })),
    coverage: {
      imessage: "both directions, full history",
      whatsapp: `since ${iso(Number(getMeta("whatsapp_since"))) || "unknown"} (your own messages from 2026-10-27)`,
    },
  };
}

// ── Writes ──

function rejectHandle(wikiId, key, note = null) {
  db().prepare("INSERT INTO rejected (wiki_id, handle_key, note) VALUES (?, ?, ?) ON CONFLICT(wiki_id, handle_key) DO UPDATE SET note = excluded.note").run(wikiId, String(key).toLowerCase(), note);
}

function markSummarized(wikiId) {
  const t = totalsFor(db().prepare("SELECT * FROM stats WHERE wiki_id = ?").all(wikiId));
  db()
    .prepare(
      `INSERT INTO links (wiki_id, summarized_at, summarized_last_at, summarized_n) VALUES (?, ?, ?, ?)
       ON CONFLICT(wiki_id) DO UPDATE SET summarized_at = excluded.summarized_at,
         summarized_last_at = excluded.summarized_last_at, summarized_n = excluded.summarized_n`,
    )
    .run(wikiId, Date.now(), t.last_at, t.direct + t.group);
}

// ── Wiki section ──

const SECTION_START = "<!-- chat-people:start -->";
const SECTION_END = "<!-- chat-people:end -->";

function plural(n, word) {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

// The facts line is built from the ledger, never from the model's prose.
function factsLine(stats, { whatsappSince = null, today = Date.now() } = {}) {
  const parts = [];
  const im = stats.filter((s) => s.channel === "imessage" && s.kind === "direct");
  if (im.length) {
    const t = totalsFor(im);
    const out = im.reduce((a, r) => a + r.n_out, 0);
    parts.push(`iMessage ${plural(t.direct, "text")} (${out.toLocaleString("en-US")} from ${ownerName()}), first ${iso(t.first_at)}, last ${iso(t.last_at)}`);
  }
  const wa = stats.filter((s) => s.channel === "whatsapp" && s.kind === "direct");
  if (wa.length) {
    const t = totalsFor(wa);
    parts.push(`WhatsApp ${plural(t.direct, "text")} received${whatsappSince ? ` since ${iso(whatsappSince)}` : ""}, last ${iso(t.last_at)}`);
  }
  const groups = stats.filter((s) => s.kind === "group");
  if (groups.length) parts.push(`in ${plural(groups.length, "group chat")} (${groups.reduce((a, r) => a + r.n_in, 0).toLocaleString("en-US")} of their own messages)`);
  return `_From iMessage and WhatsApp · ${parts.join(" · ")} · updated ${iso(today)}_`;
}

// Replace (or append) the `## Texts` block on a person page.
function renderSection(rawMd, { facts, summary }) {
  const block = `${SECTION_START}\n${facts}\n\n${String(summary).trim()}\n${SECTION_END}`;
  const re = new RegExp(`${SECTION_START}[\\s\\S]*?${SECTION_END}`);
  if (re.test(rawMd)) return rawMd.replace(re, () => block);
  return `${rawMd.replace(/\s*$/, "")}\n\n## Texts\n${block}\n`;
}

function writeSection(wikiId, summary, { today = Date.now() } = {}) {
  const ws = require("./wiki-store.js");
  try {
    const row = ws.getPage(wikiId);
    if (!row) throw new Error(`no wiki page ${wikiId}`);
    if (row.pin_locked) throw new Error(`${wikiId} is pin_locked; this pipeline never edits it`);
    const stats = db().prepare("SELECT * FROM stats WHERE wiki_id = ?").all(wikiId);
    if (!stats.length) throw new Error(`${wikiId} has no message history in the ledger`);
    const facts = factsLine(stats, { whatsappSince: Number(getMeta("whatsapp_since")) || null, today });
    const out = ws.savePage(wikiId, renderSection(row.raw_md, { facts, summary }), { editedBy: "people-chats" });
    markSummarized(wikiId);
    return { wiki_id: wikiId, rev: out.rev, changed: Boolean(out.changed || out.isNew) };
  } finally {
    ws.closeDb();
  }
}

module.exports = {
  DB_PATH,
  CHAT_DB,
  MIN_DIRECT,
  MIN_GROUP,
  RESUMMARY_DAYS,
  RESUMMARY_NEW_MESSAGES,
  SECTION_START,
  SECTION_END,
  db,
  closeDb,
  getMeta,
  setMeta,
  handleKey,
  maskKey,
  normName,
  typedstreamText,
  messageText,
  readAddressBook,
  resolveHandles,
  scanImessage,
  scanWhatsapp,
  loadPeople,
  sync,
  candidates,
  personDigest,
  sampleMessages,
  rejectHandle,
  markSummarized,
  factsLine,
  renderSection,
  writeSection,
};
