"use strict";

// people-watch — staying in touch with the people the user knows.
//
// Three things, all asked first and never done automatically:
//   1. Slipping away. From the contact rhythm the email and texts ledgers
//      already hold (lib/email-people.js, lib/chat-people.js),
//      code finds people the user used to be in regular touch with and has
//      gone quiet with, and asks whether to stay in touch.
//   2. Following someone's news. For a person the user said yes to (and, by
//      default, the people they work with — asked one by one), a nightly turn
//      researches them on the public web (LinkedIn, X, company pages, news),
//      records a structured snapshot here, and writes a `## Background` block
//      onto their wiki page that links their Google Contacts card instead of
//      copying contact details. Code diffs each snapshot against the last one;
//      a job change, a move or a life event becomes a question.
//   3. Keeping in touch. For a person the user wants nudges for, a nudge is
//      asked when the silence runs past the cadence the user chose.
//
// Every question goes to the user as a hum decision card (lib/
// decision-queue.mjs, source "people", its own one-a-day slot). This module
// writes the open questions to people-watch-asks.json, and `importAnswers`
// reads the answers back. An answer that is one of our own option texts is
// applied here (exact match on our own strings, no reading of language); an
// answer in the user's own words waits for a model (jobs/people-watch.md),
// which calls `decide`.
//
// Code owns the geometry: contact days, gaps, cadence, which questions are
// due, the option sets and their effects, snapshot diffs, the facts line.
// A model owns the meaning: whether a profile found on the web is really this
// person, what the facts are, the summary, and answers in the user's words.
//
// Privacy: no message text is read (dates only), no contact details are
// written to a page (the Contacts card is linked), and health matters are
// never recorded.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { installTools } = require("./root.cjs");

const DATA = process.env.JORI_DATA_DIR || installTools("data");
const DB_PATH = process.env.PEOPLE_WATCH_DB || path.join(DATA, "people-watch.db");
const ASKS_PATH = () => process.env.PEOPLE_WATCH_ASKS || path.join(DATA, "people-watch-asks.json");
const CHAT_DB = process.env.CHAT_PEOPLE_CHAT_DB || path.join(require("node:os").homedir(), "Library/Messages/chat.db");
const WA_INBOX = process.env.CHAT_PEOPLE_WA_INBOX || installTools("data/whatsapp-inbox.jsonl");

const DAY = 864e5;
const SECTION_START = "<!-- people-watch:start -->";
const SECTION_END = "<!-- people-watch:end -->";

// ── Tunables (geometry, not taste) ──

// Enough history to call it a relationship with a rhythm.
const MIN_CONTACT_DAYS = 6;
const MIN_CONTACT_MONTHS = 3;
// The rhythm is read from the three years before the last contact.
const RHYTHM_WINDOW_DAYS = 3 * 365;
// Quiet for this many typical gaps (bounded) = slipping.
const SLIP_GAP_MULTIPLE = 3;
const SLIP_MIN_DAYS = 60;
const SLIP_MAX_EXPECTED_DAYS = 365;
// Past this, the relationship is long gone rather than slipping; not asked.
const SLIP_HORIZON_DAYS = 5 * 365;
const CADENCES = [30, 60, 90, 180];
// Questions open at once (all kinds), and the re-research interval.
const MAX_OPEN = 3;
const RESEARCH_EVERY_DAYS = 30;
const ANSWERED_KEEP_DAYS = 30;
// A life event on a first snapshot is news only if it is this recent.
const FIRST_SNAPSHOT_NEWS_DAYS = 90;

const RANK = { change: 10, reach_out: 20, stay_in_touch: 30, follow_news: 40 };

function config() {
  return require("./instance.cjs").localConfig("people-watch", {
    owner_name: "the user",
    self_wiki_ids: [],
    // Frontmatter `scope` values that mark someone the user works with.
    work_scopes: ["work", "colleagues", "investors"],
    // Scopes never asked about (service relationships, not friendships).
    exclude_scopes: ["vendors"],
  });
}

let _db = null;
function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS people (
      wiki_id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT NOT NULL DEFAULT 'unasked',
      nudges INTEGER NOT NULL DEFAULT 0,
      research INTEGER NOT NULL DEFAULT 0,
      cadence_days INTEGER,
      contact_resource TEXT,
      note TEXT,
      decided_at INTEGER,
      snooze_until INTEGER,
      nudge_after INTEGER,
      last_nudged_at INTEGER,
      researched_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS asks (
      id TEXT PRIMARY KEY,
      wiki_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      change_id TEXT,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL,
      recommended INTEGER,
      why TEXT,
      rank INTEGER,
      time_sensitive INTEGER NOT NULL DEFAULT 0,
      asked_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      answer TEXT,
      answer_kind TEXT,
      answered_at INTEGER,
      applied_at INTEGER,
      action TEXT,
      action_done_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_asks_wiki ON asks(wiki_id);
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wiki_id TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      facts_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_wiki ON snapshots(wiki_id, observed_at);
    CREATE TABLE IF NOT EXISTS changes (
      id TEXT PRIMARY KEY,
      wiki_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      before TEXT,
      after TEXT,
      source_url TEXT,
      event_date TEXT,
      observed_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new'
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

const sha = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const monthYear = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

// ── The rhythm (pure) ──

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Nearest offered cadence at or above 1.5 typical gaps (capped at the longest). */
function suggestCadence(typicalGapDays) {
  const want = Math.max(30, (typicalGapDays || 30) * 1.5);
  return CADENCES.find((c) => c >= want) || CADENCES[CADENCES.length - 1];
}

function cadenceWords(days) {
  if (days <= 31) return "every month";
  if (days <= 62) return "every couple of months";
  if (days <= 93) return "every three months";
  return "every six months";
}

function gapWords(days) {
  if (days <= 10) return "every week or so";
  if (days <= 21) return "every couple of weeks";
  if (days <= 45) return "about once a month";
  if (days <= 75) return "every month or two";
  if (days <= 120) return "every few months";
  return "a couple of times a year";
}

/**
 * The contact rhythm of one person from the UTC day numbers they and the user
 * were in touch on.
 */
function rhythm(daySet, now = Date.now()) {
  const days = [...new Set(daySet)].sort((a, b) => a - b);
  const today = Math.floor(now / DAY);
  if (!days.length) return { contact_days: 0, recent_contact_days: 0, last_at: null, silence_days: null, slipping: false, suggested_cadence_days: CADENCES[1] };
  const last = days[days.length - 1];
  const inWindow = days.filter((d) => d >= last - RHYTHM_WINDOW_DAYS);
  // The rhythm is between active MONTHS: a burst of a dozen emails in one week
  // (a project, a purchase) is one episode, not a weekly relationship.
  const monthIdx = [...new Set(inWindow.map((d) => { const t = new Date(d * DAY); return t.getUTCFullYear() * 12 + t.getUTCMonth(); }))].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < monthIdx.length; i++) gaps.push(Math.round((monthIdx[i] - monthIdx[i - 1]) * 30.4));
  const typical = median(gaps);
  const months = monthIdx.length;
  const silence = today - last;
  const expected = typical == null ? null : Math.min(SLIP_MAX_EXPECTED_DAYS, Math.max(SLIP_MIN_DAYS, typical * SLIP_GAP_MULTIPLE));
  const substantial = days.length >= MIN_CONTACT_DAYS && months >= MIN_CONTACT_MONTHS;
  const slipping = Boolean(substantial && expected != null && silence > expected && silence <= SLIP_HORIZON_DAYS);
  return {
    contact_days: days.length,
    recent_contact_days: days.filter((d) => d >= today - 2 * 365).length,
    active_months: months,
    first_at: days[0] * DAY,
    last_at: last * DAY,
    typical_gap_days: typical,
    expected_silence_days: expected,
    silence_days: silence,
    substantial,
    slipping,
    suggested_cadence_days: typical == null ? CADENCES[1] : suggestCadence(typical),
  };
}

// ── Contact days from the ledgers (dates only) ──

function emailContactDays() {
  const out = new Map();
  let ep;
  try {
    ep = require("./email-people.js");
    const d = ep.db();
    const links = d.prepare("SELECT person_key, wiki_id FROM links WHERE wiki_id IS NOT NULL").all();
    const q = d.prepare(
      `SELECT m.at FROM messages m JOIN parties p ON p.msg_id = m.msg_id
       WHERE p.email = ? AND m.list = 0
         AND ((m.outbound = 1 AND p.role IN ('to', 'cc')) OR (m.outbound = 0 AND p.role = 'from'))`,
    );
    for (const l of links) {
      const emails = new Set([l.person_key, ...d.prepare("SELECT email FROM people WHERE person_key = ? AND ignored = 0").all(l.person_key).map((r) => r.email)]);
      if (!out.has(l.wiki_id)) out.set(l.wiki_id, new Set());
      const set = out.get(l.wiki_id);
      for (const e of emails) for (const r of q.all(e)) if (r.at) set.add(Math.floor(r.at / DAY));
    }
  } catch {
    // no email ledger: texts alone
  }
  return out;
}

function textContactDays({ chatDb = CHAT_DB, inbox = WA_INBOX } = {}) {
  const out = new Map();
  let cp;
  try {
    cp = require("./chat-people.js");
  } catch {
    return out;
  }
  const add = (wikiId, ms) => {
    if (!wikiId || !Number.isFinite(ms)) return;
    if (!out.has(wikiId)) out.set(wikiId, new Set());
    out.get(wikiId).add(Math.floor(ms / DAY));
  };
  const owner = new Map();
  try {
    const d = cp.db();
    const rejected = new Set(d.prepare("SELECT wiki_id, handle_key FROM rejected").all().map((r) => `${r.wiki_id}|${r.handle_key}`));
    for (const h of d.prepare("SELECT wiki_id, handle_key FROM handles").all()) {
      if (!rejected.has(`${h.wiki_id}|${h.handle_key}`)) owner.set(h.handle_key, h.wiki_id);
    }
  } catch {
    return out;
  }
  if (!owner.size) return out;
  if (fs.existsSync(chatDb)) {
    let c = null;
    try {
      c = new DatabaseSync(chatDb, { readOnly: true });
      const SEC = (col) => `(CASE WHEN ${col} > 1000000000000 THEN ${col} / 1000000000 ELSE ${col} END)`;
      const rows = c
        .prepare(
          `SELECT h.id handle, ${SEC("m.date")} date
           FROM chat ch
           JOIN chat_handle_join chj ON chj.chat_id = ch.ROWID
           JOIN handle h ON h.ROWID = chj.handle_id
           JOIN chat_message_join cmj ON cmj.chat_id = ch.ROWID
           JOIN message m ON m.ROWID = cmj.message_id
           WHERE ch.style = 45
             AND (m.associated_message_type IS NULL OR m.associated_message_type = 0) AND m.item_type = 0`,
        )
        .all();
      for (const r of rows) add(owner.get(cp.handleKey(r.handle)), (Number(r.date) + 978307200) * 1000);
    } catch (e) {
      process.stderr.write(`people-watch: chat.db unreadable (${String(e.message || e).slice(0, 120)}); texts skipped\n`);
    } finally {
      try { c?.close(); } catch { /* closed */ }
    }
  }
  if (fs.existsSync(inbox)) {
    for (const line of fs.readFileSync(inbox, "utf8").split("\n")) {
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const chat = String(m.chat_id || "");
      if (m.kind !== "message" || !(chat.endsWith("@s.whatsapp.net") || chat.endsWith("@lid"))) continue;
      // The user's own messages carry the user as sender; the chat names the other person.
      const jid = String(m.from_me ? chat : m.sender || chat);
      const key = cp.handleKey(jid.slice(0, jid.indexOf("@") >= 0 ? jid.indexOf("@") : undefined));
      add(owner.get(key), Date.parse(m.ts || "") || (m.timestamp ? Number(m.timestamp) * 1000 : NaN));
    }
  }
  return out;
}

/** wiki_id → Set of contact day numbers, every channel merged. */
function contactDays(opts = {}) {
  const merged = new Map();
  for (const src of [emailContactDays(), textContactDays(opts)]) {
    for (const [id, set] of src) {
      if (!merged.has(id)) merged.set(id, new Set());
      for (const d of set) merged.get(id).add(d);
    }
  }
  return merged;
}

// ── People (wiki person pages + our row) ──

function personPages() {
  const ws = require("./wiki-store.js");
  try {
    return require("./wiki-people.js").pagesByEntity().people.map((row) => {
      let fm = {};
      try { fm = JSON.parse(row.frontmatter_json || "{}"); } catch { /* keep {} */ }
      const scope = Array.isArray(fm.scope) ? fm.scope.map(String) : [];
      return { wiki_id: row.id, name: fm.name || row.title || row.id, description: fm.description || null, scope, locked: Boolean(row.pin_locked) };
    });
  } finally {
    ws.closeDb();
  }
}

function getPerson(wikiId) {
  return db().prepare("SELECT * FROM people WHERE wiki_id = ?").get(wikiId) || null;
}

function upsertPerson(wikiId, patch) {
  const d = db();
  d.prepare("INSERT OR IGNORE INTO people (wiki_id) VALUES (?)").run(wikiId);
  const keys = Object.keys(patch);
  if (!keys.length) return getPerson(wikiId);
  d.prepare(`UPDATE people SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE wiki_id = ?`).run(...keys.map((k) => patch[k] ?? null), wikiId);
  return getPerson(wikiId);
}

/** Whether a person can be asked about now (no decision, or a snooze that ran out). */
function askable(row, now) {
  if (!row || row.status === "unasked") return true;
  return row.status === "snoozed" && (row.snooze_until || 0) <= now;
}

// ── Google Contacts link (a link, never a copy) ──

function contactUrl(resource) {
  // lang-regex-ok: a People API resource name (machine identifier)
  const m = /^people\/(c\d+)$/.exec(String(resource || ""));
  return m ? `https://contacts.google.com/person/${m[1]}` : null;
}

/** The Contacts resource for a person, from the email ledger's Contacts cache. */
function resolveContact(wikiId) {
  const row = getPerson(wikiId);
  if (row?.contact_resource) return row.contact_resource;
  try {
    const d = require("./email-people.js").db();
    const keys = d.prepare("SELECT person_key FROM links WHERE wiki_id = ?").all(wikiId).map((r) => r.person_key);
    const found = new Set();
    for (const k of keys) {
      const emails = [k, ...d.prepare("SELECT email FROM people WHERE person_key = ? AND ignored = 0").all(k).map((r) => r.email)];
      for (const e of emails) {
        const c = d.prepare("SELECT resource FROM contacts WHERE email = ?").get(e);
        if (c?.resource) found.add(c.resource);
      }
    }
    // Two different cards for one person is not ours to pick between.
    if (found.size === 1) {
      const resource = [...found][0];
      upsertPerson(wikiId, { contact_resource: resource });
      return resource;
    }
  } catch {
    // no ledger
  }
  return null;
}

// ── Option sets (code-owned; an exact option text maps to its effect) ──

function optionsFor(kind, ctx = {}) {
  const cadence = ctx.cadence_days || CADENCES[1];
  switch (kind) {
    case "stay_in_touch":
      return [
        { text: `Yes, nudge me ${cadenceWords(cadence)}`, effect: { status: "tracking", nudges: 1, cadence_days: cadence } },
        { text: "Yes, and follow their work and life news too", effect: { status: "tracking", nudges: 1, research: 1, cadence_days: cadence } },
        { text: "Not now, ask me again in three months", effect: { status: "snoozed", snooze_days: 90 } },
        { text: "No, let it go", effect: { status: "declined", nudges: 0, research: 0 } },
      ];
    case "follow_news":
      return [
        { text: "Yes, look them up and watch for changes", effect: { status: "tracking", research: 1 } },
        { text: "Yes, and nudge me to stay in touch too", effect: { status: "tracking", research: 1, nudges: 1, cadence_days: cadence } },
        { text: "Not now, ask me again in three months", effect: { status: "snoozed", snooze_days: 90 } },
        { text: "No, leave them out", effect: { status: "declined", nudges: 0, research: 0 } },
      ];
    case "reach_out":
      return [
        { text: "Draft a note I could send", effect: { action: "draft", nudged: true } },
        { text: "Remind me in two weeks", effect: { nudge_after_days: 14 } },
        { text: "Nudge me less often", effect: { cadence_multiply: 2, nudged: true } },
        { text: "Stop the nudges for them", effect: { nudges: 0 } },
      ];
    case "change":
      return [
        { text: "Draft a note I could send", effect: { action: "draft", change_status: "done" } },
        { text: "Good to know, nothing to do", effect: { change_status: "done" } },
        { text: "Stop following their news", effect: { research: 0, change_status: "done" } },
      ];
    default:
      throw new Error(`unknown ask kind ${kind}`);
  }
}

function questionFor(kind, ctx) {
  const name = ctx.name;
  switch (kind) {
    case "stay_in_touch":
      return `You and ${name} used to be in touch ${gapWords(ctx.typical_gap_days || 60)}, and the last time was ${monthYear(ctx.last_at)}. Do you want to stay in touch?`;
    case "follow_news":
      return `${name} is someone you work with${ctx.description ? ` (${ctx.description})` : ""}. Should I look them up on LinkedIn, X and the news, and tell you when their job or life changes?`;
    case "reach_out":
      return `It has been ${Math.round(ctx.silence_days / 7)} weeks since you were last in touch with ${name} (you asked to hear ${cadenceWords(ctx.cadence_days)}). Want to reach out?`;
    case "change":
      return `${name}: ${ctx.summary} Want to reach out?`;
    default:
      throw new Error(`unknown ask kind ${kind}`);
  }
}

function openAsks() {
  return db().prepare("SELECT * FROM asks WHERE status = 'open' ORDER BY rank, asked_at").all();
}

function enqueue(kind, wikiId, ctx, { why = null, changeId = null, now = Date.now(), timeSensitive = false } = {}) {
  const options = optionsFor(kind, ctx);
  const id = `${kind}-${sha(`${wikiId}|${changeId || ""}|${now}`)}`;
  db()
    .prepare(
      `INSERT INTO asks (id, wiki_id, kind, change_id, question, options_json, recommended, why, rank, time_sensitive, asked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, wikiId, kind, changeId, questionFor(kind, ctx), JSON.stringify(options), 0, why, RANK[kind], timeSensitive ? 1 : 0, now);
  if (changeId) db().prepare("UPDATE changes SET status = 'asked' WHERE id = ?").run(changeId);
  return id;
}

// ── Scan + propose ──

function scan({ now = Date.now(), days = null, pages = null } = {}) {
  const cfg = config();
  const self = new Set(cfg.self_wiki_ids || []);
  const work = new Set(cfg.work_scopes || []);
  const excluded = new Set(cfg.exclude_scopes || []);
  const byId = days || contactDays();
  const out = [];
  for (const p of pages || personPages()) {
    if (self.has(p.wiki_id)) continue;
    // A work scope wins over an excluded one (an advisor who also invoices).
    const worksWith = p.scope.some((s) => work.has(s));
    if (!worksWith && p.scope.some((s) => excluded.has(s))) continue;
    const r = rhythm(byId.get(p.wiki_id) || [], now);
    const row = getPerson(p.wiki_id);
    out.push({ ...p, ...r, works_with: worksWith, state: row || { status: "unasked", nudges: 0, research: 0 } });
  }
  return out;
}

/**
 * Enqueue the questions that are due, most important first, keeping at most
 * MAX_OPEN open and one per person. Returns what was enqueued.
 */
function propose({ now = Date.now(), scanned = null, dryRun = false } = {}) {
  if (!dryRun) importAnswers({ now });
  const people = scanned || scan({ now });
  const open = openAsks();
  const busy = new Set(open.map((a) => a.wiki_id));
  let room = MAX_OPEN - open.length;
  const byId = new Map(people.map((p) => [p.wiki_id, p]));
  const plan = [];
  const take = (kind, p, ctx, extra = {}) => {
    if (room <= 0 || busy.has(p.wiki_id) || p.locked) return;
    busy.add(p.wiki_id);
    room--;
    plan.push({ kind, wiki_id: p.wiki_id, name: p.name, ctx, ...extra });
  };

  // 1. News about someone the user follows.
  for (const c of db().prepare("SELECT * FROM changes WHERE status = 'new' ORDER BY observed_at").all()) {
    const p = byId.get(c.wiki_id);
    const row = getPerson(c.wiki_id);
    if (!p || row?.status !== "tracking" || !row.research) continue;
    take("change", p, { name: p.name, summary: c.summary }, { changeId: c.id, why: c.source_url ? `Source: ${c.source_url}` : null });
  }
  // 2. Overdue nudges.
  for (const p of people) {
    const row = p.state;
    if (row.status !== "tracking" || !row.nudges || !row.cadence_days || p.silence_days == null) continue;
    if (p.silence_days <= row.cadence_days) continue;
    if (row.nudge_after && row.nudge_after > now) continue;
    if (row.last_nudged_at && now - row.last_nudged_at < row.cadence_days * DAY) continue;
    take("reach_out", p, { name: p.name, silence_days: p.silence_days, cadence_days: row.cadence_days });
  }
  // 3. Slipping away, strongest relationship first.
  for (const p of [...people].filter((x) => x.slipping && askable(x.state, now)).sort((a, b) => b.contact_days - a.contact_days)) {
    take("stay_in_touch", p, { name: p.name, typical_gap_days: p.typical_gap_days, last_at: p.last_at, cadence_days: p.suggested_cadence_days }, { why: p.description });
  }
  // 4. People the user works with, most in touch lately first.
  for (const p of [...people].filter((x) => x.works_with && askable(x.state, now)).sort((a, b) => (b.recent_contact_days || 0) - (a.recent_contact_days || 0))) {
    take("follow_news", p, { name: p.name, description: p.description, cadence_days: p.suggested_cadence_days }, { why: p.description });
  }

  if (!dryRun) {
    for (const x of plan) enqueue(x.kind, x.wiki_id, x.ctx, { why: x.why || null, changeId: x.changeId || null, now });
    exportAsks({ now });
  }
  return plan.map(({ kind, wiki_id, name }) => ({ kind, wiki_id, name }));
}

// ── The decision-queue file ──

function readJson(p, d) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; }
}
function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

/**
 * Write the open questions (and recently answered ones, so an answer filed
 * between import and export is never lost) to the file decision-queue reads.
 * Answers already in the file are imported first.
 */
function exportAsks({ now = Date.now() } = {}) {
  importAnswers({ now });
  const rows = db()
    .prepare("SELECT * FROM asks WHERE status = 'open' OR (answered_at IS NOT NULL AND answered_at > ?) ORDER BY rank, asked_at")
    .all(now - ANSWERED_KEEP_DAYS * DAY);
  const questions = rows.map((a) => ({
    id: a.id,
    wiki_id: a.wiki_id,
    kind: a.kind,
    rank: a.rank,
    question: a.question,
    options: JSON.parse(a.options_json).map((o) => o.text),
    recommended: a.recommended,
    why_it_matters: a.why || undefined,
    time_sensitive: Boolean(a.time_sensitive),
    asked_at: new Date(a.asked_at).toISOString(),
    status: a.status === "open" ? "open" : "answered",
    ...(a.answer ? { answer: a.answer } : {}),
  }));
  writeJsonAtomic(ASKS_PATH(), { schema_version: 1, written_at: new Date(now).toISOString(), questions });
  return questions.length;
}

/** Read answers filed by decision-answer back into the ledger, applying exact option picks. */
function importAnswers({ now = Date.now() } = {}) {
  const doc = readJson(ASKS_PATH(), null);
  const applied = [];
  const words = [];
  for (const q of doc?.questions || []) {
    if (q.status === "open" || !q.answer) continue;
    const a = db().prepare("SELECT * FROM asks WHERE id = ?").get(q.id);
    if (!a || a.status !== "open") continue;
    const opts = JSON.parse(a.options_json);
    const hit = opts.find((o) => o.text === q.answer);
    const at = Date.parse(q.answered_at || "") || now;
    db().prepare("UPDATE asks SET status = 'answered', answer = ?, answer_kind = ?, answered_at = ? WHERE id = ?").run(q.answer, hit ? "option" : "own_words", at, a.id);
    if (hit) {
      applyEffect(a, hit.effect, { now, note: q.answer });
      applied.push({ id: a.id, wiki_id: a.wiki_id, answer: q.answer });
    } else {
      words.push({ id: a.id, wiki_id: a.wiki_id, answer: q.answer });
    }
  }
  return { applied, words };
}

function applyEffect(ask, effect, { now = Date.now(), note = null } = {}) {
  const row = getPerson(ask.wiki_id) || upsertPerson(ask.wiki_id, {});
  const patch = {};
  for (const k of ["status", "nudges", "research", "cadence_days"]) if (effect[k] !== undefined) patch[k] = effect[k];
  if (effect.status) patch.decided_at = now;
  if (effect.status === "snoozed") patch.snooze_until = now + (effect.snooze_days || 90) * DAY;
  if (effect.nudge_after_days) patch.nudge_after = now + effect.nudge_after_days * DAY;
  if (effect.cadence_multiply) patch.cadence_days = Math.min(365, (row.cadence_days || CADENCES[1]) * effect.cadence_multiply);
  if (effect.nudged || ask.kind === "reach_out") patch.last_nudged_at = now;
  if (patch.status === "tracking" && patch.nudges && !patch.cadence_days && !row.cadence_days) patch.cadence_days = CADENCES[1];
  if (note) patch.note = note;
  upsertPerson(ask.wiki_id, patch);
  if (ask.change_id && effect.change_status) db().prepare("UPDATE changes SET status = ? WHERE id = ?").run(effect.change_status, ask.change_id);
  db().prepare("UPDATE asks SET status = 'applied', applied_at = ?, action = ? WHERE id = ?").run(now, effect.action || null, ask.id);
}

/**
 * A decision read from the user's own words by a model (or said in chat).
 * Withdraws that person's other open questions.
 */
function decide(wikiId, { status = null, nudges = null, research = null, cadenceDays = null, snoozeDays = null, askId = null, action = null, note, now = Date.now() } = {}) {
  if (!note || !String(note).trim()) throw new Error("decide needs --note with the user's own words");
  if (status && !["tracking", "declined", "snoozed", "unasked"].includes(status)) throw new Error(`bad status ${status}`);
  const effect = {};
  if (status) effect.status = status;
  if (nudges != null) effect.nudges = nudges ? 1 : 0;
  if (research != null) effect.research = research ? 1 : 0;
  if (cadenceDays) effect.cadence_days = Number(cadenceDays);
  if (snoozeDays) effect.snooze_days = Number(snoozeDays);
  if (status === "declined") Object.assign(effect, { nudges: 0, research: 0 });
  if (action) effect.action = action;
  const ask = askId
    ? db().prepare("SELECT * FROM asks WHERE id = ? AND wiki_id = ?").get(askId, wikiId)
    : null;
  if (askId && !ask) throw new Error(`no ask ${askId} for ${wikiId}`);
  if (ask?.change_id) effect.change_status = "done";
  applyEffect(ask || { id: null, wiki_id: wikiId, kind: "manual" }, effect, { now, note });
  db().prepare("UPDATE asks SET status = 'withdrawn' WHERE wiki_id = ? AND status = 'open'").run(wikiId);
  exportAsks({ now });
  return getPerson(wikiId);
}

function wordsPending() {
  return db().prepare("SELECT * FROM asks WHERE status = 'answered' AND answer_kind = 'own_words' ORDER BY answered_at").all()
    .map((a) => ({ id: a.id, wiki_id: a.wiki_id, kind: a.kind, question: a.question, options: JSON.parse(a.options_json).map((o) => o.text), answer: a.answer }));
}

function draftsPending() {
  return db().prepare("SELECT a.*, c.summary change_summary FROM asks a LEFT JOIN changes c ON c.id = a.change_id WHERE a.action = 'draft' AND a.action_done_at IS NULL").all()
    .map((a) => ({ id: a.id, wiki_id: a.wiki_id, kind: a.kind, question: a.question, change: a.change_summary || null }));
}

function markDrafted(askId, now = Date.now()) {
  return db().prepare("UPDATE asks SET action_done_at = ? WHERE id = ?").run(now, askId).changes;
}

// ── Research: snapshots and changes ──

function dueResearch({ now = Date.now(), limit = 8 } = {}) {
  return db()
    .prepare("SELECT * FROM people WHERE status = 'tracking' AND research = 1 AND (researched_at IS NULL OR researched_at < ?) ORDER BY COALESCE(researched_at, 0) LIMIT ?")
    .all(now - RESEARCH_EVERY_DAYS * DAY, limit);
}

// lang-regex-ok: folds case, accents and punctuation so two spellings of one company or place compare equal; decides nothing about meaning
const norm = (s) => String(s ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function eventKey(e) {
  return sha(e.source_url ? `url|${e.source_url}` : `${norm(e.kind)}|${e.date || ""}|${norm(e.summary)}`);
}

/**
 * Diff two snapshots (pure). Fields compare as normalized text, so a
 * re-spelling ("Acme Inc." vs "Acme, Inc") is not a change.
 */
function diffSnapshots(prev, next, { now = Date.now() } = {}) {
  const out = [];
  if (prev) {
    const roleBefore = [prev.role, prev.company].filter(Boolean).join(" at ");
    const roleAfter = [next.role, next.company].filter(Boolean).join(" at ");
    if (next.company && norm(prev.company) !== norm(next.company)) {
      out.push({ kind: "job_change", before: roleBefore || null, after: roleAfter, summary: `now ${roleAfter}${roleBefore ? ` (was ${roleBefore})` : ""}.`, source_url: next.links?.linkedin || null });
    } else if (next.role && prev.role && norm(prev.role) !== norm(next.role)) {
      out.push({ kind: "new_role", before: roleBefore, after: roleAfter, summary: `now ${roleAfter} (was ${prev.role}).`, source_url: next.links?.linkedin || null });
    }
    if (next.location && prev.location && norm(prev.location) !== norm(next.location)) {
      out.push({ kind: "moved", before: prev.location, after: next.location, summary: `moved to ${next.location} (was ${prev.location}).`, source_url: null });
    }
  }
  const seen = new Set((prev?.life_events || []).map(eventKey));
  for (const e of next.life_events || []) {
    if (!e?.summary || seen.has(eventKey(e))) continue;
    const when = Date.parse(e.date || "");
    if (!prev && !(Number.isFinite(when) && now - when <= FIRST_SNAPSHOT_NEWS_DAYS * DAY)) continue;
    out.push({ kind: e.kind || "life_event", before: null, after: null, // lang-regex-ok: ends the model's own sentence with a full stop for the question template
      summary: String(e.summary).trim().replace(/([^.!?])$/, "$1."), source_url: e.source_url || null, event_date: e.date || null });
  }
  return out;
}

const IDENTITY_OK = new Set(["high", "medium"]);

/** Record a research snapshot; returns the changes it produced. */
function observe(wikiId, facts, { now = Date.now() } = {}) {
  if (!facts || typeof facts !== "object") throw new Error("facts must be a JSON object");
  if (!IDENTITY_OK.has(facts.identity_confidence)) {
    upsertPerson(wikiId, { researched_at: now });
    return { stored: false, reason: "identity not established; nothing recorded", changes: [] };
  }
  const prevRow = db().prepare("SELECT facts_json FROM snapshots WHERE wiki_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1").get(wikiId);
  const prev = prevRow ? JSON.parse(prevRow.facts_json) : null;
  const changes = diffSnapshots(prev, facts, { now });
  // Life events accumulate: a later search that misses an old one does not forget it.
  const merged = { ...facts, life_events: [...(facts.life_events || [])] };
  const keys = new Set(merged.life_events.map(eventKey));
  for (const e of prev?.life_events || []) if (!keys.has(eventKey(e))) merged.life_events.push(e);
  db().prepare("INSERT INTO snapshots (wiki_id, observed_at, facts_json) VALUES (?, ?, ?)").run(wikiId, now, JSON.stringify(merged));
  const ins = db().prepare(
    `INSERT OR IGNORE INTO changes (id, wiki_id, kind, summary, before, after, source_url, event_date, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const stored = [];
  for (const c of changes) {
    const id = `chg-${sha(`${wikiId}|${c.kind}|${c.after || ""}|${c.summary}`)}`;
    if (ins.run(id, wikiId, c.kind, c.summary, c.before, c.after, c.source_url, c.event_date || null, now).changes) stored.push({ id, ...c });
  }
  upsertPerson(wikiId, { researched_at: now });
  return { stored: true, changes: stored };
}

function latestSnapshot(wikiId) {
  const r = db().prepare("SELECT observed_at, facts_json FROM snapshots WHERE wiki_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1").get(wikiId);
  return r ? { observed_at: r.observed_at, facts: JSON.parse(r.facts_json) } : null;
}

// ── The page block ──

function factsLine({ contactResource, facts, observedAt }) {
  const links = [];
  const card = contactUrl(contactResource);
  if (card) links.push(`[Google Contacts](${card})`);
  const l = facts?.links || {};
  if (l.linkedin) links.push(`[LinkedIn](${l.linkedin})`);
  if (l.x) links.push(`[X](${l.x})`);
  if (l.website) links.push(`[Website](${l.website})`);
  for (const o of l.other || []) if (o?.url) links.push(`[${String(o.label || "Link").slice(0, 40)}](${o.url})`);
  const now = [facts?.role, facts?.company].filter(Boolean).join(" at ");
  const parts = [];
  if (now) parts.push(`Now: ${now}${facts?.location ? `, ${facts.location}` : ""}.`);
  else if (facts?.location) parts.push(`Based in ${facts.location}.`);
  if (links.length) parts.push(links.join(" · "));
  parts.push(observedAt ? `Researched ${isoDay(observedAt)}.` : "Not researched yet.");
  return `_${parts.join(" ")}_`;
}

function renderSection(rawMd, { facts, summary }) {
  const body = summary && String(summary).trim() ? `\n\n${String(summary).trim()}` : "";
  const block = `${SECTION_START}\n${facts}${body}\n${SECTION_END}`;
  const re = new RegExp(`${SECTION_START}[\\s\\S]*?${SECTION_END}`);
  if (re.test(rawMd)) return rawMd.replace(re, () => block);
  return `${rawMd.replace(/\s*$/, "")}\n\n## Background\n${block}\n`;
}

function writeSection(wikiId, summary) {
  const ws = require("./wiki-store.js");
  try {
    const row = ws.getPage(wikiId);
    if (!row) throw new Error(`no wiki page ${wikiId}`);
    if (row.pin_locked) throw new Error(`${wikiId} is pin_locked; this pipeline never edits it`);
    const snap = latestSnapshot(wikiId);
    const facts = factsLine({ contactResource: resolveContact(wikiId), facts: snap?.facts, observedAt: snap?.observed_at });
    const out = ws.savePage(wikiId, renderSection(row.raw_md, { facts, summary }), { editedBy: "people-watch" });
    return { wiki_id: wikiId, rev: out.rev, changed: Boolean(out.changed || out.isNew) };
  } finally {
    ws.closeDb();
  }
}

function stats() {
  const d = db();
  const by = (sql) => Object.fromEntries(d.prepare(sql).all().map((r) => [r.k, r.n]));
  return {
    people: by("SELECT status k, COUNT(*) n FROM people GROUP BY status"),
    asks: by("SELECT status k, COUNT(*) n FROM asks GROUP BY status"),
    changes: by("SELECT status k, COUNT(*) n FROM changes GROUP BY status"),
    snapshots: d.prepare("SELECT COUNT(*) n FROM snapshots").get().n,
  };
}

module.exports = {
  DB_PATH,
  ASKS_PATH,
  SECTION_START,
  SECTION_END,
  CADENCES,
  MAX_OPEN,
  db,
  closeDb,
  rhythm,
  suggestCadence,
  contactDays,
  personPages,
  getPerson,
  upsertPerson,
  contactUrl,
  resolveContact,
  optionsFor,
  questionFor,
  openAsks,
  enqueue,
  scan,
  propose,
  exportAsks,
  importAnswers,
  decide,
  wordsPending,
  draftsPending,
  markDrafted,
  dueResearch,
  diffSnapshots,
  observe,
  latestSnapshot,
  factsLine,
  renderSection,
  writeSection,
  stats,
};
