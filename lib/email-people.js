"use strict";

// email-people — who the user corresponds with by email, and when.
//
// A header-only ledger of every Gmail thread the user wrote in (plus the
// threads their correspondents started), in data/email-people.db. Code
// owns the structure — parties, dates, directions, counts, who qualifies as
// "a person the user knows" — and a model (jobs/people-email.md) owns the meaning:
// whether an address is a person, who it is, and the "what they talk about"
// summary written onto that person's wiki page.
//
// Qualifies: an individual (non-role) address that appears in at least two
// threads the user wrote in, or one if it is in their Google Contacts.
// Bodies are never fetched; snippets stay in this
// local DB and never go to the wiki verbatim.

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { installTools } = require("./root.cjs");
const { instance, agentAddresses } = require("./instance.cjs");

const DB_PATH =
  process.env.EMAIL_PEOPLE_DB || installTools("data/email-people.db");

const MIN_THREADS = 2;
const MIN_THREADS_IN_CONTACTS = 1;

// The agent's own mailbox addresses are not people (agentAddresses():
// agent_email plus agent_email_aliases).
const notPeople = () => agentAddresses();

// Local parts that name a function, not a person. Address geometry only.
const ROLE_LOCAL_RE =
  /^((?:no|do[-_.]?not)[-_.]?reply[-_.\w]*|mailer-daemon|postmaster|bounce[s]?|notifications?|notify|alerts?|support|help|helpdesk|info|hello|hi|contact|contactus|sales|billing|invoices?|receipts?|orders?|bookings?|reservations?|service|customerservice|customer\.?service|care|admin|team|office|accounts?|accounting|marketing|news|newsletter|updates?|press|media|privacy|legal|security|jobs|careers|hr|feedback|reply|replies|members?|membership|concierge|frontdesk|guest|guests|hosts?|events?|tickets?|community|webmaster|root|system|automated|robot|calendar|digest|subscriptions?|plans|trips|itinerary|store\d*|shop|returns|refunds|rewards|deals|offers|promo|promotions)$/i;

const ROLE_TOKENS = new Set(["noreply", "donotreply", "news", "newsletter", "alert", "alerts", "notification", "notifications", "notify", "unsubscribe", "bounce", "bounces", "mailer", "daemon", "spamproc", "receipts", "billing", "support", "orders", "marketing", "promo", "offers", "deals", "rewards"]);
const BULK_SUBDOMAINS = new Set(["e", "em", "email", "emails", "alerts", "welcome", "news", "mkt", "marketing", "mailer", "notifications", "notify", "txn", "fbl", "reply", "bounce", "info"]);

// Domains that relay or automate mail on someone's behalf.
const RELAY_DOMAIN_RE =
  /(^|\.)(reply\.github\.com|facebookmail\.com|linkedin\.com|guest\.airbnb\.com|airbnb\.com|messaging\.vrbo\.com|vrbo\.com|craigslist\.org|docusign\.net|calendar-server\.bounces\.google\.com|resource\.calendar\.google\.com|groups\.google\.com|googlegroups\.com|zendesk\.com|intercom-mail\.com|mailchimp\.com|sendgrid\.net|amazonses\.com)$/i;

let _db = null;

function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS threads (
      thread_id TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      has_outbound INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      msg_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      outbound INTEGER NOT NULL,
      list INTEGER NOT NULL DEFAULT 0,
      from_email TEXT,
      subject TEXT,
      snippet TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
    CREATE TABLE IF NOT EXISTS parties (
      msg_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      role TEXT NOT NULL,
      PRIMARY KEY (msg_id, email, role)
    );
    CREATE INDEX IF NOT EXISTS idx_parties_email ON parties(email);
    CREATE TABLE IF NOT EXISTS contacts (
      email TEXT PRIMARY KEY,
      name TEXT,
      resource TEXT
    );
    CREATE TABLE IF NOT EXISTS people (
      email TEXT PRIMARY KEY,
      person_key TEXT NOT NULL,
      ignored INTEGER NOT NULL DEFAULT 0,
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS links (
      person_key TEXT PRIMARY KEY,
      wiki_id TEXT,
      summarized_at INTEGER,
      summarized_last_at INTEGER
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

// ── Address geometry ──

// Split an RFC 5322 address-list header into {name, email}. Handles quoted
// display names containing commas and bare addresses.
function parseAddressList(header) {
  if (!header) return [];
  const out = [];
  let buf = "";
  let quoted = false;
  let angle = 0;
  for (const ch of String(header)) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle++;
    else if (ch === ">" && !quoted) angle = Math.max(0, angle - 1);
    if (ch === "," && !quoted && angle === 0) {
      out.push(buf);
      buf = "";
    } else buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out
    .map((part) => {
      const m = part.match(/<([^>]+)>/);
      const email = (m ? m[1] : part).trim().replace(/^mailto:/i, "").toLowerCase();
      const name = m ? part.slice(0, m.index).trim().replace(/^"|"$/g, "").trim() : "";
      return { name: name || null, email };
    })
    .filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email));
}

function isRoleAddress(email) {
  const [local, domain] = String(email).toLowerCase().split("@");
  if (!local || !domain) return true;
  if (ROLE_LOCAL_RE.test(local)) return true;
  if (RELAY_DOMAIN_RE.test(domain)) return true;
  // Reply tokens and VERP bounces: long opaque local parts carrying a "+" or "=" token.
  if (/[+=]/.test(local) && local.length > 24) return true;
  // A role word as one token of a longer local part: drive-shares-dm-noreply, store-news.
  if (local.split(/[-_.+]/).some((t) => ROLE_TOKENS.has(t))) return true;
  const labels = domain.split(".");
  // Bulk-mail subdomains: e.budget.com, welcome.americanexpress.com, alerts.comcast.net.
  if (labels.length >= 3 && BULK_SUBDOMAINS.has(labels[0])) return true;
  return false;
}

// ── Ingest ──

function header(msg, name) {
  const h = (msg.payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

// Store one Gmail thread (format=metadata). `selfEmails` are the user's own
// addresses (Gmail send-as list); a message is outbound when Gmail labels it
// SENT or it comes from one of them.
function ingestThread(thread, { selfEmails }) {
  const d = db();
  const self = new Set([...selfEmails].map((e) => e.toLowerCase()));
  let hasOutbound = 0;
  d.exec("BEGIN IMMEDIATE");
  try {
    for (const m of thread.messages || []) {
      const from = parseAddressList(header(m, "From"))[0] || null;
      const outbound = (m.labelIds || []).includes("SENT") || (from && self.has(from.email)) ? 1 : 0;
      const list = header(m, "List-Id") || /bulk|list/i.test(header(m, "Precedence") || "") ? 1 : 0;
      if (outbound && !list) hasOutbound = 1;
      d.prepare(
        `INSERT INTO messages (msg_id, thread_id, at, outbound, list, from_email, subject, snippet)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(msg_id) DO UPDATE SET outbound = excluded.outbound, list = excluded.list,
           subject = excluded.subject, snippet = excluded.snippet`,
      ).run(
        m.id,
        thread.id,
        Number(m.internalDate) || 0,
        outbound,
        list,
        from ? from.email : null,
        header(m, "Subject"),
        (m.snippet || "").slice(0, 280),
      );
      d.prepare("DELETE FROM parties WHERE msg_id = ?").run(m.id);
      const ins = d.prepare("INSERT OR IGNORE INTO parties (msg_id, email, name, role) VALUES (?, ?, ?, ?)");
      if (from) ins.run(m.id, from.email, from.name, "from");
      for (const role of ["To", "Cc"]) {
        for (const a of parseAddressList(header(m, role))) ins.run(m.id, a.email, a.name, role.toLowerCase());
      }
    }
    d.prepare(
      `INSERT INTO threads (thread_id, fetched_at, has_outbound) VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET fetched_at = excluded.fetched_at, has_outbound = excluded.has_outbound`,
    ).run(thread.id, Date.now(), hasOutbound);
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
  return { thread_id: thread.id, has_outbound: !!hasOutbound };
}

// After the user's address list grows, messages already stored from a newly
// added address are the user's: mark them outbound and refresh each thread's flag.
function recomputeOutbound(selfEmails) {
  const d = db();
  const self = [...selfEmails].map((e) => e.toLowerCase());
  const ph = self.map(() => "?").join(",");
  d.exec("BEGIN IMMEDIATE");
  try {
    const marked = d.prepare(`UPDATE messages SET outbound = 1 WHERE outbound = 0 AND from_email IN (${ph})`).run(...self).changes;
    d.exec(`UPDATE threads SET has_outbound = EXISTS (
      SELECT 1 FROM messages m WHERE m.thread_id = threads.thread_id AND m.outbound = 1 AND m.list = 0)`);
    d.exec("COMMIT");
    return marked;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

function fetchedThreadIds() {
  return new Set(db().prepare("SELECT thread_id FROM threads").all().map((r) => r.thread_id));
}

function upsertContacts(rows) {
  const d = db();
  const ins = d.prepare(
    `INSERT INTO contacts (email, name, resource) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, resource = excluded.resource`,
  );
  d.exec("BEGIN");
  for (const r of rows) if (r.email) ins.run(String(r.email).toLowerCase(), r.name || null, r.resource || null);
  d.exec("COMMIT");
}

// ── People ──

function personKeyOf(email) {
  return db().prepare("SELECT person_key FROM people WHERE email = ?").get(email)?.person_key || email;
}

// Per-address correspondence stats over threads the user wrote in. A party is
// anyone on From/To/Cc of any message in such a thread, other than the user.
function addressStats({ selfEmails }) {
  const self = [...selfEmails, ...notPeople()].map((e) => e.toLowerCase());
  const placeholders = self.map(() => "?").join(",");
  return db()
    .prepare(
      `SELECT p.email,
              MAX(p.name) AS name,
              COUNT(DISTINCT m.thread_id) AS threads_written,
              MIN(m.at) AS first_at,
              MAX(m.at) AS last_at
       FROM parties p
       JOIN messages m ON m.msg_id = p.msg_id
       JOIN threads t ON t.thread_id = m.thread_id AND t.has_outbound = 1
       WHERE p.email NOT IN (${placeholders}) AND m.list = 0
       GROUP BY p.email`,
    )
    .all(...self);
}

// Qualified people, grouped by person_key (merged addresses), with whether
// their wiki section is stale (a thread newer than the last summary).
function candidates({ selfEmails, staleOnly = false, limit = null } = {}) {
  const d = db();
  const contacts = new Map(d.prepare("SELECT email, name, resource FROM contacts").all().map((c) => [c.email, c]));
  const people = new Map(d.prepare("SELECT email, person_key, ignored FROM people").all().map((p) => [p.email, p]));
  const links = new Map(d.prepare("SELECT * FROM links").all().map((l) => [l.person_key, l]));
  const groups = new Map();
  for (const s of addressStats({ selfEmails })) {
    if (isRoleAddress(s.email)) continue;
    const p = people.get(s.email);
    if (p && p.ignored) continue;
    const key = p ? p.person_key : s.email;
    if (!groups.has(key)) groups.set(key, { person_key: key, emails: [], names: new Set(), threads_written: 0, first_at: null, last_at: null, in_contacts: false, contact: null });
    const g = groups.get(key);
    g.emails.push(s.email);
    if (s.name) g.names.add(s.name);
    g.threads_written += s.threads_written;
    g.first_at = g.first_at == null ? s.first_at : Math.min(g.first_at, s.first_at);
    g.last_at = g.last_at == null ? s.last_at : Math.max(g.last_at, s.last_at);
    const c = contacts.get(s.email);
    if (c) {
      g.in_contacts = true;
      g.contact = g.contact || { name: c.name, resource: c.resource };
    }
  }
  // Latest activity of any kind (inbound-only threads included) per group.
  const lastAny = d.prepare(
    `SELECT MAX(m.at) AS at FROM parties p JOIN messages m ON m.msg_id = p.msg_id WHERE p.email = ? AND m.list = 0`,
  );
  let out = [...groups.values()]
    .filter((g) => g.threads_written >= (g.in_contacts ? MIN_THREADS_IN_CONTACTS : MIN_THREADS))
    .map((g) => {
      const link = links.get(g.person_key) || null;
      const last_any_at = Math.max(g.last_at || 0, ...g.emails.map((e) => lastAny.get(e)?.at || 0));
      return {
        person_key: g.person_key,
        emails: g.emails.sort(),
        names: [...g.names],
        contact: g.contact,
        threads_written: g.threads_written,
        first_at: g.first_at,
        last_at: last_any_at,
        wiki_id: link?.wiki_id || null,
        summarized_at: link?.summarized_at || null,
        stale: !link || !link.summarized_at || (link.summarized_last_at || 0) < last_any_at,
      };
    })
    // Newest correspondence first (a user requirement: start with the newest emails).
    .sort((a, b) => b.last_at - a.last_at || b.threads_written - a.threads_written);
  if (staleOnly) out = out.filter((c) => c.stale);
  if (limit) out = out.slice(0, limit);
  return out;
}

// Thread timeline for one person (all their addresses): newest first.
function personThreads(keyOrEmail, { limit = 80 } = {}) {
  const d = db();
  const key = personKeyOf(String(keyOrEmail).toLowerCase());
  const emails = d.prepare("SELECT email FROM people WHERE person_key = ?").all(key).map((r) => r.email);
  if (!emails.includes(key)) emails.push(key);
  const ph = emails.map(() => "?").join(",");
  const rows = d
    .prepare(
      `SELECT m.thread_id,
              MIN(m.at) AS first_at, MAX(m.at) AS last_at, COUNT(*) AS messages,
              SUM(m.outbound) AS from_owner,
              (SELECT subject FROM messages s WHERE s.thread_id = m.thread_id ORDER BY s.at LIMIT 1) AS subject,
              (SELECT snippet FROM messages s WHERE s.thread_id = m.thread_id ORDER BY s.at DESC LIMIT 1) AS last_snippet
       FROM messages m
       WHERE m.list = 0 AND m.msg_id IN (SELECT msg_id FROM parties WHERE email IN (${ph}))
       GROUP BY m.thread_id
       ORDER BY last_at DESC
       LIMIT ?`,
    )
    .all(...emails, limit);
  const others = d.prepare(
    `SELECT DISTINCT p.email, p.name FROM parties p JOIN messages m ON m.msg_id = p.msg_id
     WHERE m.thread_id = ? AND p.email NOT IN (${ph})`,
  );
  return {
    person_key: key,
    emails,
    threads: rows.map((r) => ({ ...r, with: others.all(r.thread_id, ...emails).map((o) => o.email) })),
  };
}

function merge(intoKey, emails) {
  const d = db();
  const into = String(intoKey).toLowerCase();
  const ins = d.prepare(
    `INSERT INTO people (email, person_key) VALUES (?, ?)
     ON CONFLICT(email) DO UPDATE SET person_key = excluded.person_key`,
  );
  for (const e of [into, ...emails.map((x) => String(x).toLowerCase())]) ins.run(e, into);
  // A merged-away key's wiki link follows it.
  for (const e of emails) {
    const l = d.prepare("SELECT * FROM links WHERE person_key = ?").get(String(e).toLowerCase());
    if (l && !d.prepare("SELECT 1 FROM links WHERE person_key = ?").get(into)) {
      d.prepare("UPDATE links SET person_key = ? WHERE person_key = ?").run(into, l.person_key);
    } else if (l) d.prepare("DELETE FROM links WHERE person_key = ?").run(l.person_key);
  }
}

function ignore(email, note = null) {
  db()
    .prepare(
      `INSERT INTO people (email, person_key, ignored, note) VALUES (?, ?, 1, ?)
       ON CONFLICT(email) DO UPDATE SET ignored = 1, note = excluded.note`,
    )
    .run(String(email).toLowerCase(), String(email).toLowerCase(), note);
}

function link(personKey, wikiId, { summarizedLastAt = null } = {}) {
  const d = db();
  const key = personKeyOf(String(personKey).toLowerCase());
  d.prepare(
    `INSERT INTO links (person_key, wiki_id, summarized_at, summarized_last_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(person_key) DO UPDATE SET wiki_id = excluded.wiki_id,
       summarized_at = COALESCE(excluded.summarized_at, links.summarized_at),
       summarized_last_at = COALESCE(excluded.summarized_last_at, links.summarized_last_at)`,
  ).run(key, wikiId, summarizedLastAt != null ? Date.now() : null, summarizedLastAt);
  return key;
}

// ── Wiki section ──

const SECTION_START = "<!-- email-people:start -->";
const SECTION_END = "<!-- email-people:end -->";

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Replace (or append) the `## Email` block on a person page. Code writes
// the facts line (counts, first/last contact); the model's summary is the
// prose under it.
function renderSection(rawMd, { threadsWritten, firstAt, lastAt, summary, today = Date.now() }) {
  const who = instance().owner_name || "the user";
  const facts = `_From Gmail · ${threadsWritten} thread${threadsWritten === 1 ? "" : "s"} ${who} wrote in · first ${isoDay(firstAt)} · last ${isoDay(lastAt)} · updated ${isoDay(today)}_`;
  const block = `${SECTION_START}\n${facts}\n\n${String(summary).trim()}\n${SECTION_END}`;
  const re = new RegExp(`${SECTION_START}[\\s\\S]*?${SECTION_END}`);
  if (re.test(rawMd)) return rawMd.replace(re, block);
  return `${rawMd.replace(/\s*$/, "")}\n\n## Email\n${block}\n`;
}

module.exports = {
  DB_PATH,
  MIN_THREADS,
  MIN_THREADS_IN_CONTACTS,
  db,
  closeDb,
  getMeta,
  setMeta,
  parseAddressList,
  isRoleAddress,
  ingestThread,
  fetchedThreadIds,
  recomputeOutbound,
  upsertContacts,
  addressStats,
  candidates,
  personThreads,
  personKeyOf,
  merge,
  ignore,
  link,
  renderSection,
  SECTION_START,
  SECTION_END,
};
