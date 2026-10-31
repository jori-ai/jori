// watches.mjs — Jori's trigger → action engine ("watches").
//
// The owner asked for a trigger/action mechanism that watches quietly in the
// background, acts when an event is triggered, and is linked to memory.
//
// A watch is a standing instruction: WHEN <condition> THEN <action>. Each one
// is two things kept together:
//   - a wiki page (memory): the human-readable instruction, in the owner's words, with
//     [[links]] to the people/places/projects it touches, and a log of every
//     time it fired. This is where the chat agent, recall and the dream jobs
//     see it.
//   - a `watch_rules` row in the same memory-index.db: the compiled, typed
//     form the engine evaluates on every tick without reading prose.
//
// Three trigger kinds:
//   event  — an event of a listed type arrived (hum-sense sensors, the
//            mailbox, anything spooled with `watch emit`) AND a model judges it
//            satisfies the condition.
//   anchor — date-relative to something on the travel timeline ("two days
//            before I leave for Lisbon", "when a Japan trip is booked"). The
//            model judges which trips match; code computes the fire time.
//   at     — a fixed time.
//
// Who decides what (Rule #0b): every "does this match what the owner meant" is Jev
// (site watch-match, decide() in jev-shadow.mjs) with tool-less Sonnet as the
// fallback rung. A match neither can settle becomes a hum QUESTION (hum-ask);
// the owner's reply comes back through hum-answer → hum-responses.jsonl and is read
// by Jev (site watch-answer). Code owns only structure: event-type globs, trip
// geometry, fire times, quiet hours.
//
// Runs as `watch tick`, kicked by the hum-sense daemon (detached, single
// flight) at most once a minute and whenever it has fresh events. See
// system/watch.md.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HOME = os.homedir();
// This installation's root, identity and local settings (lib/instance.cjs).
const { ROOT, instance, localConfig } = require("./instance.cjs");
export const JORI = ROOT;
// The owner as a stored identifier: decided_by on a match they settled, and
// the key their reply goes under in a Jev state.
const OWNER_ID = instance().owner_id;
// How the virtual-mailbox source names its mailbox in an event summary.
const WATCH_CONFIG = localConfig("watches", { virtual_mailbox_label: "the virtual mailbox" });
const DATA = process.env.WATCH_DATA_DIR || path.join(JORI, "data");

export const PATHS = {
  db: process.env.WATCH_DB || process.env.MEMORY_INDEX_DB || path.join(JORI, "data/memory-index.db"),
  state: path.join(DATA, "watch-state.json"),
  spool: path.join(DATA, "watch-spool.jsonl"),
  lock: path.join(DATA, ".watch-tick.lock"),
  mailDir: path.join(DATA, "watch-mail"),
  log: process.env.WATCH_LOG || path.join(JORI, "agent/logs/watch.log"),
  responses: process.env.WATCH_RESPONSES || path.join(JORI, "data/hum-responses.jsonl"),
  pendingQuestion: path.join(JORI, "data/hum-pending-question.json"),
  userTz: path.join(JORI, "data/user-timezone.json"),
  bin: path.join(JORI, "bin"),
  ocr: path.join(JORI, "data/.bin/photo-ocr"),
};
const GOG = process.env.GOG_BIN || "/opt/homebrew/bin/gog";
// The owner's Google account (inbox and tasks), read through gog.
const ACCOUNT = instance().owner_email;

export const KINDS = ["event", "anchor", "at"];
export const MATCH_VERDICTS = ["match", "no_match", "unclear"];
// Reminders land between 08:00 and 21:59 in the owner's local timezone. A match found
// at 03:00 is held, not dropped: the fire time simply moves to 08:00.
export const AWAKE = { from: 8, to: 22 };
const EMAIL_POLL_SEC = 120;
const TRAVEL_REFRESH_SEC = 600;
const MAX_MODEL_FALLBACKS_PER_TICK = 4;

// ─── small utilities ───────────────────────────────────────────────────────

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
export function log(msg) {
  const line = `${new Date().toISOString()} [watch] ${msg}\n`;
  try { fs.mkdirSync(path.dirname(PATHS.log), { recursive: true }); fs.appendFileSync(PATHS.log, line); } catch {}
  if (process.env.WATCH_VERBOSE) process.stderr.write(line);
}
const isoNow = (nowMs) => new Date(nowMs).toISOString();

export function userTz() {
  const tz = process.env.WATCH_TZ || readJson(PATHS.userTz, null)?.timezone;
  const home = instance().tz;
  if (!tz) return home;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return home; }
}

function zonedParts(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
function tzOffsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
/** The UTC instant of local wall-clock y-mo-d hh:mm in tz. */
export function zonedToUtc(y, mo, d, hh, mm, tz) {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz); // second pass settles a DST boundary
  return t;
}
export function localHourOf(ms, tz) { return zonedParts(ms, tz).h; }
export function fmtLocal(ms, tz) {
  return new Date(ms).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Earliest moment at or after `ms` inside the awake window, in tz. */
export function nextAwake(ms, tz) {
  const h = localHourOf(ms, tz);
  if (h >= AWAKE.from && h < AWAKE.to) return ms;
  const p = zonedParts(ms, tz);
  let at = zonedToUtc(p.y, p.mo, p.d, AWAKE.from, 0, tz);
  if (at <= ms) at = zonedToUtc(p.y, p.mo, p.d, AWAKE.from, 0, tz) + 24 * 3600e3;
  return at;
}

/** Event-type glob: "email.*" matches "email.received"; "*" matches all. Machine types only. */
export function typeMatches(globs, type) {
  return (globs || []).some((g) => g === "*" || g === type || (g.endsWith(".*") && type.startsWith(g.slice(0, -1))));
}

// ─── store (memory-index.db) ───────────────────────────────────────────────

let _db = null;
export function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(PATHS.db), { recursive: true });
  _db = new DatabaseSync(PATHS.db);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA busy_timeout=5000");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS watch_rules (
      id              TEXT PRIMARY KEY,
      page_id         TEXT,
      title           TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active',
      trigger_kind    TEXT NOT NULL,
      listens         TEXT NOT NULL DEFAULT '[]',
      condition       TEXT,
      anchor_source   TEXT,
      anchor_field    TEXT,
      offset_min      INTEGER,
      fire_local_time TEXT,
      fire_at         TEXT,
      action          TEXT NOT NULL,
      recurrence      TEXT NOT NULL DEFAULT 'once',
      expires_at      TEXT,
      context_pages   TEXT NOT NULL DEFAULT '[]',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      last_fired_at   TEXT,
      fire_count      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS watch_rules_status ON watch_rules(status);
    CREATE TABLE IF NOT EXISTS watch_matches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id     TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      summary     TEXT,
      verdict     TEXT NOT NULL,
      decided_by  TEXT,
      fire_at     TEXT,
      fired_at    TEXT,
      question_id TEXT,
      asked_at    TEXT,
      detail      TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      UNIQUE(rule_id, subject_key)
    );
    CREATE INDEX IF NOT EXISTS watch_matches_rule ON watch_matches(rule_id);
    -- Everything that happens to a watch, for "how well does this work"
    -- (watch stats, the weekly watch-review job). Append-only.
    CREATE TABLE IF NOT EXISTS watch_events (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       TEXT NOT NULL,
      rule_id  TEXT,
      match_id INTEGER,
      kind     TEXT NOT NULL,
      detail   TEXT
    );
    CREATE INDEX IF NOT EXISTS watch_events_ts ON watch_events(ts);
  `);
  migrate(_db, "watch_rules", { origin: "TEXT", request: "TEXT" });
  migrate(_db, "watch_matches", { message_id: "TEXT", task_id: "TEXT", delivery: "TEXT" });
  return _db;
}
function migrate(d, table, cols) {
  const have = new Set(d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [c, type] of Object.entries(cols)) if (!have.has(c)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${c} ${type}`);
}

/** Append one lifecycle event. Never throws: tracking must not break the engine. */
export function logEvent(kind, { rule_id = null, match_id = null, nowMs = Date.now(), ...detail } = {}) {
  try {
    db().prepare("INSERT INTO watch_events (ts, rule_id, match_id, kind, detail) VALUES (?, ?, ?, ?, ?)")
      .run(isoNow(nowMs), rule_id, match_id, kind, Object.keys(detail).length ? JSON.stringify(detail) : null);
  } catch (err) { log(`event log failed (${kind}): ${err.message}`); }
}
export function listEvents({ sinceIso, ruleId } = {}) {
  const where = [], args = [];
  if (sinceIso) { where.push("ts >= ?"); args.push(sinceIso); }
  if (ruleId) { where.push("rule_id = ?"); args.push(ruleId); }
  return db().prepare(`SELECT * FROM watch_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`).all(...args)
    .map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : {} }));
}
export function closeDb() { if (_db) { _db.close(); _db = null; } }

function rowToRule(r) {
  if (!r) return null;
  return {
    ...r,
    listens: JSON.parse(r.listens || "[]"),
    action: JSON.parse(r.action || "{}"),
    context_pages: JSON.parse(r.context_pages || "[]"),
  };
}

/**
 * Validate and normalize a rule spec (what `watch add --file` reads):
 * { id, title, page_id?, trigger: { kind, listens?, condition?, anchor?: {source, field, offset_min?, local_time?}, at? },
 *   action: { notify?, task?: {title, notes?}, agent? }, recurrence?: "once"|"each", expires_at?, context_pages? }
 */
export function normalizeSpec(spec) {
  const errs = [];
  const t = spec.trigger || {};
  if (!spec.id || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(spec.id)) errs.push("id: lowercase slug, 3-64 chars");
  if (!spec.title) errs.push("title required");
  if (!KINDS.includes(t.kind)) errs.push(`trigger.kind must be one of ${KINDS.join("/")}`);
  if (t.kind !== "at" && !t.condition) errs.push("trigger.condition required (the owner's words, read by the model)");
  if (t.kind === "event" && !(Array.isArray(t.listens) && t.listens.length)) errs.push("trigger.listens: event-type globs, e.g. [\"email.*\", \"mail.piece\"]");
  if (t.kind === "anchor") {
    if ((t.anchor?.source || "travel") !== "travel") errs.push("trigger.anchor.source: only 'travel' today");
    if (t.anchor?.offset_min != null && !["leave", "arrive"].includes(t.anchor?.field)) errs.push("trigger.anchor.field: leave|arrive when offset_min is set");
    if (t.anchor?.local_time && !/^\d{2}:\d{2}$/.test(t.anchor.local_time)) errs.push("trigger.anchor.local_time: HH:MM");
  }
  if (t.kind === "at" && !Number.isFinite(Date.parse(t.at))) errs.push("trigger.at: ISO time");
  const a = spec.action || {};
  if (!a.notify && !a.task && !a.agent) errs.push("action needs at least one of notify / task / agent");
  if (a.task && !a.task.title) errs.push("action.task.title required");
  const recurrence = spec.recurrence || "once";
  if (!["once", "each"].includes(recurrence)) errs.push("recurrence: once|each");
  if (spec.expires_at && !Number.isFinite(Date.parse(spec.expires_at))) errs.push("expires_at: ISO time");
  if (errs.length) throw new Error(`invalid watch spec: ${errs.join("; ")}`);
  return {
    id: spec.id,
    page_id: spec.page_id || null,
    title: spec.title,
    trigger_kind: t.kind,
    listens: JSON.stringify(t.kind === "event" ? t.listens : []),
    condition: t.condition || null,
    anchor_source: t.kind === "anchor" ? "travel" : null,
    anchor_field: t.kind === "anchor" ? (t.anchor?.field || "leave") : null,
    offset_min: t.kind === "anchor" && t.anchor?.offset_min != null ? Math.round(t.anchor.offset_min) : null,
    fire_local_time: t.kind === "anchor" ? (t.anchor?.local_time || null) : null,
    fire_at: t.kind === "at" ? new Date(t.at).toISOString() : null,
    action: JSON.stringify(a),
    recurrence,
    expires_at: spec.expires_at ? new Date(spec.expires_at).toISOString() : null,
    context_pages: JSON.stringify(spec.context_pages || (spec.page_id ? [spec.page_id] : [])),
    // Who set it up and the owner's exact words: the review audits coverage against chat.
    origin: spec.origin || null,
    request: spec.request || null,
  };
}

export function upsertRule(spec, nowMs = Date.now()) {
  const r = normalizeSpec(spec);
  const now = isoNow(nowMs);
  const existed = Boolean(getRule(r.id));
  db().prepare(`
    INSERT INTO watch_rules (id, page_id, title, status, trigger_kind, listens, condition, anchor_source, anchor_field,
      offset_min, fire_local_time, fire_at, action, recurrence, expires_at, context_pages, origin, request, created_at, updated_at)
    VALUES (:id, :page_id, :title, 'active', :trigger_kind, :listens, :condition, :anchor_source, :anchor_field,
      :offset_min, :fire_local_time, :fire_at, :action, :recurrence, :expires_at, :context_pages, :origin, :request, :now, :now)
    ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id, title=excluded.title, trigger_kind=excluded.trigger_kind,
      listens=excluded.listens, condition=excluded.condition, anchor_source=excluded.anchor_source,
      anchor_field=excluded.anchor_field, offset_min=excluded.offset_min, fire_local_time=excluded.fire_local_time,
      fire_at=excluded.fire_at, action=excluded.action, recurrence=excluded.recurrence, expires_at=excluded.expires_at,
      context_pages=excluded.context_pages, origin=COALESCE(excluded.origin, watch_rules.origin),
      request=COALESCE(excluded.request, watch_rules.request), updated_at=excluded.updated_at
  `).run({ ...r, now });
  logEvent(existed ? "updated" : "created", { rule_id: r.id, nowMs, kind: r.trigger_kind, origin: r.origin });
  return getRule(r.id);
}

export function getRule(id) { return rowToRule(db().prepare("SELECT * FROM watch_rules WHERE id = ?").get(id)); }
export function listRules({ all = false } = {}) {
  const rows = all
    ? db().prepare("SELECT * FROM watch_rules ORDER BY status, created_at").all()
    : db().prepare("SELECT * FROM watch_rules WHERE status = 'active' ORDER BY created_at").all();
  return rows.map(rowToRule);
}
export function setStatus(id, status, nowMs = Date.now(), { reason = null, by = null } = {}) {
  const r = db().prepare("UPDATE watch_rules SET status = ?, updated_at = ? WHERE id = ?").run(status, isoNow(nowMs), id);
  if (r.changes > 0) logEvent(`status:${status}`, { rule_id: id, nowMs, reason, by });
  return r.changes > 0;
}

/** The owner said a reminder never came ("you didn't remind me about X"): a false negative. */
export function recordMiss(note, { ruleId = null, nowMs = Date.now() } = {}) {
  logEvent("missed", { rule_id: ruleId, nowMs, note });
}
/** The owner's reaction to a watch firing, in their words ("perfect", "too late", "wrong one"). */
export function recordFeedback(ruleId, note, { subjectKey = null, nowMs = Date.now() } = {}) {
  const m = subjectKey ? getMatch(ruleId, subjectKey) : null;
  logEvent("feedback", { rule_id: ruleId, match_id: m?.id ?? null, nowMs, note, subject_key: subjectKey });
}
export function getMatch(ruleId, subjectKey) {
  return db().prepare("SELECT * FROM watch_matches WHERE rule_id = ? AND subject_key = ?").get(ruleId, subjectKey) || null;
}
export function listMatches(ruleId) {
  return db().prepare("SELECT * FROM watch_matches WHERE rule_id = ? ORDER BY id").all(ruleId);
}
function putMatch(m, nowMs) {
  const now = isoNow(nowMs);
  db().prepare(`
    INSERT INTO watch_matches (rule_id, subject_key, summary, verdict, decided_by, fire_at, detail, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(rule_id, subject_key) DO UPDATE SET summary=excluded.summary, verdict=excluded.verdict,
      decided_by=excluded.decided_by, fire_at=excluded.fire_at, detail=excluded.detail, updated_at=excluded.updated_at
  `).run(m.rule_id, m.subject_key, m.summary || null, m.verdict, m.decided_by || null, m.fire_at || null,
    m.detail ? JSON.stringify(m.detail) : null, now, now);
  return getMatch(m.rule_id, m.subject_key);
}
function updateMatch(id, fields, nowMs) {
  const keys = Object.keys(fields);
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  db().prepare(`UPDATE watch_matches SET ${sets}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), isoNow(nowMs), id);
}

// ─── events: spool + sources ───────────────────────────────────────────────

/** Normalize anything into the engine's event shape. */
export function toWatchEvent(e) {
  if (!e || !e.type) return null;
  return {
    type: String(e.type),
    subject_key: String(e.subject_key || (e.dedup_key ? `hum:${e.dedup_key}` : `${e.type}:${e.ts || Date.now()}`)),
    summary: String(e.summary || e.subject || e.type).slice(0, 600),
    data: e.data || {},
    ts: e.ts || new Date().toISOString(),
  };
}

/** Append events to the spool (hum-sense tap, `watch emit`). Never throws. */
export function spoolEvents(events) {
  try {
    const rows = (events || []).map(toWatchEvent).filter(Boolean);
    if (!rows.length) return 0;
    fs.mkdirSync(path.dirname(PATHS.spool), { recursive: true });
    fs.appendFileSync(PATHS.spool, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return rows.length;
  } catch { return 0; }
}

function readLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Atomically take everything in the spool (peek = read without taking, for dry runs). */
export function drainSpool({ peek = false } = {}) {
  if (peek) return readLines(PATHS.spool);
  const tmp = `${PATHS.spool}.draining.${process.pid}`;
  try { fs.renameSync(PATHS.spool, tmp); } catch { return []; }
  try { return readLines(tmp); } finally { try { fs.unlinkSync(tmp); } catch {} }
}

function gogJson(args, timeout = 30000) {
  const r = spawnSync(GOG, [...args, "-a", ACCOUNT, "--json", "--no-input"], { encoding: "utf8", timeout, env: process.env });
  if (r.status !== 0) throw new Error(`gog ${args.slice(0, 2).join(" ")}: ${(r.stderr || "").trim().slice(0, 200) || `exit ${r.status}`}`);
  return JSON.parse(r.stdout);
}

const INFORMED_DELIVERY = "informeddelivery.usps.com"; // a sender DOMAIN — structure, not language

/** OCR one USPS mail-piece scan on-device (Apple Vision binary built by photo-ocr). */
function ocrImage(file) {
  if (!fs.existsSync(PATHS.ocr)) return "";
  const r = spawnSync(PATHS.ocr, [file], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) return "";
  return r.stdout.split("\n").map((l) => l.split("\t")[0]).filter(Boolean).join(" / ").slice(0, 800);
}

/** The USPS Informed Delivery digest's mail-piece scans → one `mail.piece` event each. */
export function mailPieceEvents(msgId, deps = {}) {
  const get = deps.gogJson || gogJson;
  const ocr = deps.ocrImage || ocrImage;
  const msg = get(["gmail", "get", msgId]);
  const pieces = (msg.attachments || []).filter((a) => String(a.filename || "").startsWith("mailer-"));
  const out = [];
  for (const a of pieces) {
    const dir = path.join(PATHS.mailDir, msgId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, a.filename);
    if (!fs.existsSync(file)) {
      const r = (deps.download || ((m, id, f) => spawnSync(GOG, ["gmail", "attachment", m, id, "-a", ACCOUNT, "--out", f, "--no-input"], { timeout: 30000 })))(msgId, a.attachmentId, file);
      if (r && r.status && r.status !== 0) continue;
    }
    const text = ocr(file);
    out.push({
      type: "mail.piece",
      subject_key: `mail:${msgId}:${a.filename}`,
      summary: text ? `Physical mail piece arriving today (USPS scan of the envelope reads: ${text})` : "Physical mail piece arriving today (USPS scan, no readable text)",
      data: { digest_message_id: msgId, filename: a.filename, ocr: text, scan_path: file },
    });
  }
  return out;
}

/**
 * New inbox mail → `email.received` events (+ `mail.piece` for the USPS
 * digest). Cold start only records a watermark, so a restart never replays the
 * inbox as fresh events.
 */
export function emailEvents(state, nowMs, deps = {}) {
  const get = deps.gogJson || gogJson;
  const st = state.email || null;
  if (st && nowMs - Date.parse(st.last_poll || 0) < EMAIL_POLL_SEC * 1000) return [];
  const res = get(["gmail", "search", "in:inbox newer_than:2d", "--max", "50"]);
  const threads = res.threads || [];
  const seen = st?.seen || {};
  const out = [];
  const nextSeen = {};
  for (const t of threads) {
    const key = `${t.id}:${t.messageCount || 1}`;
    nextSeen[key] = seen[key] || isoNow(nowMs);
    if (!st || seen[key]) continue;
    out.push({
      type: "email.received",
      subject_key: `email:${key}`,
      summary: `Email from ${t.from}: ${t.subject}`,
      data: { message_id: t.id, from: t.from, subject: t.subject, date: t.date, labels: t.labels || [] },
    });
    if (String(t.from || "").toLowerCase().includes(INFORMED_DELIVERY)) {
      try { out.push(...mailPieceEvents(t.id, deps)); } catch (err) { log(`mail pieces ${t.id}: ${err.message}`); }
    }
  }
  // Keep keys from the last 3 days so a thread that drops out of the window and
  // comes back (a new reply) is still recognized.
  for (const [k, v] of Object.entries(seen)) if (!nextSeen[k] && nowMs - Date.parse(v) < 3 * 86400e3) nextSeen[k] = v;
  state.email = { last_poll: isoNow(nowMs), seen: nextSeen };
  if (!st) log(`email source armed (${threads.length} existing threads recorded, none replayed)`);
  return out;
}

/**
 * A virtual mailbox (Anytime Mailbox) → `mail.piece` events, read-only
 * from the state file `bin/anytime-mail-check` writes after it OCRs and
 * judges each new envelope. Cold start records a watermark, like the inbox.
 */
export function anytimeMailEvents(state, nowMs, deps = {}) {
  const file = deps.anytimeStateFile || path.join(DATA, "anytime-mail-state.json");
  const seenByChecker = readJson(file, null)?.seen;
  if (!seenByChecker) return [];
  const st = state.anytime || null;
  const mine = st?.seen || {};
  const out = [];
  const next = {};
  for (const [malId, v] of Object.entries(seenByChecker)) {
    next[malId] = mine[malId] || isoNow(nowMs);
    if (mine[malId]) continue;
    // Cold start replays only the last 3 days: the checker may have started (and
    // recorded the letter) before this source first looked.
    if (!st && !(v.arrived && nowMs - Date.parse(v.arrived) < 3 * 86400e3)) continue;
    const ocr = (v.ocr || []).map((l) => (typeof l === "string" ? l : l?.text)).filter(Boolean).join(" / ").slice(0, 800);
    out.push({
      type: "mail.piece",
      subject_key: `anytime:${malId}`,
      summary: `Physical mail arrived at ${WATCH_CONFIG.virtual_mailbox_label}: from ${v.sender || "unknown sender"}, addressed to ${v.recipient || "?"}, judged ${v.verdict || "?"}; envelope reads: ${ocr || "(no text)"}`,
      data: { mailbox: "anytime", mal_id: malId, sender: v.sender || null, recipient: v.recipient || null, verdict: v.verdict || null, arrived: v.arrived || null },
    });
  }
  state.anytime = { seen: next };
  if (!st) log(`anytime-mailbox source armed (${Object.keys(next).length} envelopes recorded, ${out.length} from the last 3 days replayed)`);
  return out;
}

// ─── anchors: the travel timeline → trips ──────────────────────────────────

/**
 * Timeline segments → trips: every real stay (not transit, not an undecided
 * "a|b" Schrodinger stay) with the flight that leads into it. leave_at is that
 * flight's takeoff (transit.arrive_at), else the stay's own arrival.
 */
export function buildTrips(segments) {
  const segs = [...(segments || [])].sort((a, b) => Date.parse(a.arrive_at) - Date.parse(b.arrive_at));
  const trips = [];
  for (const s of segs) {
    if (!s.metro || s.metro === "transit" || s.metro.includes("|") || s.metro.includes(",")) continue;
    const arrive = Date.parse(s.arrive_at);
    const inbound = segs.find((t) => t.metro === "transit" && t.depart_at &&
      Math.abs(Date.parse(t.depart_at) - arrive) <= 6 * 3600e3);
    const prev = segs.filter((t) => t.metro !== "transit" && Date.parse(t.arrive_at) < arrive).pop();
    trips.push({
      subject_key: `trip:${s.id}`,
      segment_id: s.id,
      metro: s.metro,
      label: s.place_label || null,
      note: s.note || null,
      leave_ms: inbound ? Date.parse(inbound.arrive_at) : arrive,
      arrive_ms: arrive,
      depart_ms: s.depart_at ? Date.parse(s.depart_at) : null,
      via: inbound?.place_label || null,
      from_metro: prev?.metro || null,
      source: s.source || null,
    });
  }
  return trips;
}

function tripSummary(t, tz) {
  const where = t.label && t.label.toLowerCase() !== t.metro ? `${t.label} (${t.metro})` : t.metro;
  return `Trip to ${where}${t.from_metro ? ` from ${t.from_metro}` : ""}: leaves ${fmtLocal(t.leave_ms, tz)}` +
    `${t.via ? ` on ${t.via}` : ""}, arrives ${fmtLocal(t.arrive_ms, tz)}` +
    `${t.depart_ms ? `, stays until ${fmtLocal(t.depart_ms, tz)}` : ", open-ended"}${t.note ? `. Note: ${t.note.slice(0, 200)}` : ""}`;
}

function fetchSegments() {
  const from = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  const r = spawnSync(path.join(PATHS.bin, "travel"), ["list", "--from", from, "--json"], { encoding: "utf8", timeout: 30000, env: { ...process.env, TRAVEL_CALENDAR_REFRESH: "0" } });
  if (r.status !== 0) throw new Error(`travel list: ${(r.stderr || "").trim().slice(0, 200)}`);
  return JSON.parse(r.stdout);
}

/** When an anchored rule fires for a trip, or null = it can no longer fire usefully. */
export function anchorFireMs(rule, trip, tz) {
  if (rule.offset_min == null) return 0; // "as soon as it's on the timeline"
  const base = rule.anchor_field === "arrive" ? trip.arrive_ms : trip.leave_ms;
  let t = base + rule.offset_min * 60e3;
  if (rule.fire_local_time) {
    const [hh, mm] = rule.fire_local_time.split(":").map(Number);
    const p = zonedParts(t, tz);
    t = zonedToUtc(p.y, p.mo, p.d, hh, mm, tz);
  }
  return t;
}

// ─── model decisions (Jev first, Sonnet fallback) ──────────────────────────

const MATCH_SITE = "watch-match";
const ANSWER_SITE = "watch-answer";

async function sonnetChoice(prompt, choices) {
  const { runToollessDetailed, parseModelJson } = await import("./jev-claude.mjs");
  const { MODELS } = require("./models.cjs");
  const { out, error } = await runToollessDetailed({ model: MODELS.sonnet, prompt, timeoutMs: 90000 });
  if (error) throw new Error(`sonnet: ${error.kind}`);
  const v = parseModelJson(out)?.verdict;
  if (!choices.includes(v)) throw new Error(`sonnet gave no usable verdict`);
  return v;
}

/** Does this item satisfy the watch's condition? → {verdict, used} or throws (retry later). */
export async function judgeMatch(rule, item, { id } = {}) {
  const { decide } = await import("./jev-shadow.mjs");
  const { answerConfidence, jevSiteDef } = await import("./jev.mjs");
  const def = jevSiteDef(MATCH_SITE);
  const state = {
    standing_instruction: rule.condition,
    watch_title: rule.title,
    today: new Date().toISOString().slice(0, 10),
    item: { kind: item.type, description: item.summary, details: item.data || {} },
  };
  const q = def.questions.verdict;
  const crit = Object.entries(q.criteria).map(([k, d]) => `${k}: ${d}`).join("\n");
  const prompt = `${q.instructions}\n\n${crit}\n\n${JSON.stringify(state, null, 1)}\n\nReply with JSON only: {"verdict": "match" | "no_match" | "unclear"}`;
  const r = await decide({
    site: MATCH_SITE,
    id: id || `${rule.id}:${item.subject_key}`,
    state,
    questions: def.questions,
    interpret: (a) => ({ value: a.verdict?.choice || null, confidence: answerConfidence(a.verdict) }),
    legacy: () => sonnetChoice(prompt, MATCH_VERDICTS),
    same: (a, b) => a === b,
  });
  if (!MATCH_VERDICTS.includes(r.value)) throw new Error(`no verdict (${r.used})`);
  return { verdict: r.value, used: r.used };
}

/** The owner's reply to a watch question → yes | no | unclear. */
export async function judgeAnswer(question, reply, { id } = {}) {
  const { decide } = await import("./jev-shadow.mjs");
  const { answerConfidence, jevSiteDef } = await import("./jev.mjs");
  const def = jevSiteDef(ANSWER_SITE);
  const state = { question_jori_asked: question, [`${OWNER_ID}_replied`]: reply };
  const q = def.questions.answer;
  const crit = Object.entries(q.criteria).map(([k, d]) => `${k}: ${d}`).join("\n");
  const prompt = `${q.instructions}\n\n${crit}\n\n${JSON.stringify(state, null, 1)}\n\nReply with JSON only: {"verdict": "yes" | "no" | "unclear"}`;
  const r = await decide({
    site: ANSWER_SITE,
    id,
    state,
    questions: def.questions,
    interpret: (a) => ({ value: a.answer?.choice || null, confidence: answerConfidence(a.answer) }),
    legacy: () => sonnetChoice(prompt, ["yes", "no", "unclear"]),
    same: (a, b) => a === b,
  });
  return ["yes", "no", "unclear"].includes(r.value) ? r.value : "unclear";
}

// ─── actions ───────────────────────────────────────────────────────────────

/** → {delivery: "sent"|"suppressed"|"unknown", message_id?, reason?}; throws on a failed send. */
function sendChat(text, ruleId) {
  const cap = path.join(os.tmpdir(), `watch-send-${process.pid}-${Date.now()}`);
  const r = spawnSync(path.join(PATHS.bin, "jori-send-curl"),
    ["--intent", `watch:${ruleId}`, "--agent", "ops", "--evidence-as-of", "live", "--capture-id", cap, text],
    { encoding: "utf8", timeout: 120000, env: process.env });
  if (r.status !== 0) throw new Error(`jori-send-curl exit ${r.status}: ${(r.stderr || "").trim().slice(0, 200)}`);
  let raw = "";
  try { raw = fs.readFileSync(cap, "utf8").trim(); fs.unlinkSync(cap); } catch {}
  if (raw.startsWith("{")) {
    // The outbound precheck (or a fold) held it back: the reminder the owner asked for did not reach them.
    try { const j = JSON.parse(raw); if (j.suppressed) return { delivery: "suppressed", reason: String(j.reason || j.by || "").slice(0, 300) }; } catch {}
  }
  return raw ? { delivery: "sent", message_id: raw } : { delivery: "unknown" };
}

function addTask({ title, notes, due }) {
  const args = ["tasks", "add", "@default", "--title", title];
  if (notes) args.push("--notes", notes);
  if (due) args.push("--due", due);
  const r = gogJson(args);
  return { task_id: r?.task?.id || r?.id || null };
}

async function dispatchAgent(rule, match, item) {
  const { resolveWebhookChain, webhookToken, supervisorHealthy } = await import("./hum-events.mjs");
  const task = [
    "Read agent/ops-agent/jobs/watch-action.md and follow it.",
    "",
    `Watch: ${rule.id} — ${rule.title}`,
    `Memory pages (wiki_read each first): ${rule.context_pages.join(", ") || "none"}`,
    `Condition: ${rule.condition || "(time-based)"}`,
    `What happened: ${item.summary}`,
    `Details: ${JSON.stringify(item.data || {}).slice(0, 2000)}`,
    "",
    `Instruction: ${rule.action.agent}`,
  ].join("\n");
  const headers = { "content-type": "application/json" };
  const token = webhookToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  for (const { webhook, health } of resolveWebhookChain("watch-action")) {
    if (!(await supervisorHealthy(health))) continue;
    const r = await fetch(`http://127.0.0.1:${webhook}`, {
      method: "POST", headers, body: JSON.stringify({ task, source: "watch-action" }), signal: AbortSignal.timeout(10000),
    }).catch(() => null);
    if (r?.ok) return `dispatched :${webhook}`;
  }
  throw new Error("no healthy supervisor for watch-action");
}

/** Append one line to the watch's wiki page log — the memory write-back. */
function appendPageLog(rule, line) {
  if (!rule.page_id) return;
  const ws = require("./wiki-store.js");
  const page = ws.getPage(rule.page_id);
  if (!page) return;
  let raw = page.raw_md;
  if (!raw.includes("\n## Watch log")) raw = `${raw.trimEnd()}\n\n## Watch log\n`;
  raw = `${raw.trimEnd()}\n- ${line}\n`;
  ws.savePage(page.basename || `${rule.page_id}.md`, raw, { editedBy: "watch" });
}

export const defaultDeps = {
  sendChat, addTask, dispatchAgent, appendPageLog,
  judgeMatch, judgeAnswer,
  fetchSegments,
  emailEvents,
  askQuestion: ({ id, subject, message }) => {
    const r = spawnSync(path.join(PATHS.bin, "hum-ask"),
      ["--id", id, "--lane", "watch", "--subject", subject, "--memory-hook", "watch", "--message", message],
      { encoding: "utf8", timeout: 120000, env: process.env });
    return { code: r.status, out: (r.stdout || "").trim() };
  },
  pendingQuestionOpen: (nowMs) => {
    const p = readJson(PATHS.pendingQuestion, null);
    return Boolean(p && (p.id || p.question) && Date.parse(p.expires_at) > nowMs);
  },
  readResponses: () => readLines(PATHS.responses),
};

/** Execute a match's action. Throws if the reminder itself could not be delivered. */
export async function fire(rule, match, item, { nowMs = Date.now(), deps = defaultDeps, dryRun = false } = {}) {
  const tz = userTz();
  const a = rule.action;
  const done = [];
  if (dryRun) return { dryRun: true, would: Object.keys(a) };
  let sent = {}, task = {};
  try {
    if (a.notify) {
      const text = `${a.notify}${item?.summary && rule.trigger_kind !== "at" ? `\n\n(What set this off: ${item.summary})` : ""}`;
      sent = deps.sendChat(text, rule.id) || { delivery: "unknown" };
      done.push("notify");
    }
  } catch (err) {
    logEvent("fire_failed", { rule_id: rule.id, match_id: match.id, nowMs, step: "notify", error: err.message.slice(0, 300) });
    throw err;
  }
  if (a.task) {
    try { task = deps.addTask({ title: a.task.title, notes: a.task.notes || a.notify || "", due: a.task.due || null }) || {}; done.push("task"); }
    catch (err) { log(`${rule.id}: task failed: ${err.message}`); logEvent("fire_failed", { rule_id: rule.id, match_id: match.id, nowMs, step: "task", error: err.message.slice(0, 300) }); }
  }
  if (a.agent) {
    try { done.push(await deps.dispatchAgent(rule, match, item)); }
    catch (err) {
      log(`${rule.id}: agent dispatch failed: ${err.message}`);
      logEvent("fire_failed", { rule_id: rule.id, match_id: match.id, nowMs, step: "agent", error: err.message.slice(0, 300) });
      if (!done.length) throw err;
    }
  }
  const now = isoNow(nowMs);
  updateMatch(match.id, { fired_at: now, message_id: sent.message_id || null, delivery: sent.delivery || null, task_id: task.task_id || null }, nowMs);
  const due = match.fire_at ? Date.parse(match.fire_at) : nowMs;
  logEvent("fired", {
    rule_id: rule.id, match_id: match.id, nowMs, subject_key: match.subject_key, actions: done,
    delivery: sent.delivery || null, suppressed_reason: sent.reason || null, message_id: sent.message_id || null,
    task_id: task.task_id || null, late_min: Math.round((nowMs - due) / 60000), decided_by: match.decided_by,
  });
  if (sent.delivery === "suppressed") log(`${rule.id}: reminder SUPPRESSED by precheck: ${sent.reason}`);
  db().prepare("UPDATE watch_rules SET last_fired_at = ?, fire_count = fire_count + 1, status = CASE WHEN recurrence = 'once' THEN 'done' ELSE status END, updated_at = ? WHERE id = ?")
    .run(now, now, rule.id);
  try { deps.appendPageLog(rule, `${fmtLocal(nowMs, tz)} — fired (${done.join(", ")}): ${item?.summary || "scheduled"}`); }
  catch (err) { log(`${rule.id}: page log failed: ${err.message}`); }
  log(`FIRED ${rule.id} [${match.subject_key}] → ${done.join(", ")}`);
  return { done };
}

// ─── the tick ──────────────────────────────────────────────────────────────

function loadState() { return readJson(PATHS.state, { retry: [] }); }
function saveState(s) { writeJsonAtomic(PATHS.state, s); }

function expireRules(rules, nowMs) {
  return rules.filter((r) => {
    if (r.expires_at && Date.parse(r.expires_at) < nowMs) { setStatus(r.id, "expired", nowMs, { by: "engine" }); log(`expired ${r.id}`); return false; }
    return true;
  });
}

/**
 * Decide one (rule, item) pair, record it, and return the stored match.
 * Rate-limits the slow fallback rung: Jev answers in <1s, Sonnet takes ~20s.
 */
async function decideItem(rule, item, ctx) {
  const prev = getMatch(rule.id, item.subject_key);
  if (prev && prev.verdict !== "error") return prev;
  if (ctx.fallbacks >= MAX_MODEL_FALLBACKS_PER_TICK) { ctx.deferred.push(item); return null; }
  const t0 = Date.now();
  try {
    const { verdict, used } = await ctx.deps.judgeMatch(rule, item);
    if (used !== "jev") ctx.fallbacks++;
    const m = putMatch({ rule_id: rule.id, subject_key: item.subject_key, summary: item.summary, verdict, decided_by: used, detail: { type: item.type, data: item.data } }, ctx.nowMs);
    logEvent("decided", { rule_id: rule.id, match_id: m.id, nowMs: ctx.nowMs, subject_key: item.subject_key, type: item.type, verdict, used, ms: Date.now() - t0 });
    return m;
  } catch (err) {
    ctx.fallbacks++;
    logEvent("decide_failed", { rule_id: rule.id, nowMs: ctx.nowMs, subject_key: item.subject_key, type: item.type, error: err.message.slice(0, 300) });
    log(`${rule.id}: decision failed for ${item.subject_key}: ${err.message}`);
    ctx.deferred.push(item);
    return null;
  }
}

function questionText(rule, match) {
  return `About your "${rule.title}" reminder: ${match.summary}. Is this the one you meant? If it is, I'll go ahead with the reminder.`;
}

/**
 * One full pass. deps are injectable for tests; nowMs too.
 * Returns a summary of what happened.
 */
export async function tick({ nowMs = Date.now(), deps = defaultDeps, dryRun = false } = {}) {
  const tz = userTz();
  const state = loadState();
  const ctx = { nowMs, deps, fallbacks: 0, deferred: [] };
  const summary = { events: 0, decided: 0, fired: [], asked: [], errors: [] };
  const rules = expireRules(listRules(), nowMs);
  const eventRules = rules.filter((r) => r.trigger_kind === "event");

  // 1. Events: spooled (hum-sense tap, emit) + retries + the mailbox when a rule listens to it.
  let events = [...drainSpool({ peek: dryRun }), ...(state.retry || []).filter((e) => nowMs - Date.parse(e.ts) < 2 * 86400e3)];
  if (eventRules.some((r) => typeMatches(r.listens, "email.received") || typeMatches(r.listens, "mail.piece"))) {
    try { events.push(...deps.emailEvents(state, nowMs, deps)); } catch (err) { summary.errors.push(`email: ${err.message}`); log(`email source: ${err.message}`); }
  }
  if (eventRules.some((r) => typeMatches(r.listens, "mail.piece"))) {
    try { events.push(...(deps.anytimeMailEvents || anytimeMailEvents)(state, nowMs, deps)); } catch (err) { log(`anytime source: ${err.message}`); }
  }
  events = events.map(toWatchEvent).filter(Boolean);
  summary.events = events.length;

  const toFire = [];
  for (const e of events) {
    for (const rule of eventRules.filter((r) => typeMatches(r.listens, e.type))) {
      const m = await decideItem(rule, e, ctx);
      if (!m) continue;
      summary.decided++;
      if (m.verdict === "match" && !m.fired_at) {
        if (!m.fire_at) updateMatch(m.id, { fire_at: isoNow(nowMs) }, nowMs);
        toFire.push({ rule, item: e });
      }
    }
  }
  state.retry = [...new Map(ctx.deferred.map((e) => [e.subject_key, { ...e, ts: e.ts || isoNow(nowMs) }])).values()];

  // 2. Anchored rules over the travel timeline.
  const anchorRules = rules.filter((r) => r.trigger_kind === "anchor");
  if (anchorRules.length) {
    let trips = state.travel?.trips;
    if (!trips || nowMs - Date.parse(state.travel.fetched_at || 0) > TRAVEL_REFRESH_SEC * 1000) {
      try { trips = buildTrips(deps.fetchSegments()); state.travel = { fetched_at: isoNow(nowMs), trips }; }
      catch (err) { summary.errors.push(`travel: ${err.message}`); log(`travel: ${err.message}`); trips = trips || []; }
    }
    for (const rule of anchorRules) {
      for (const trip of trips) {
        const ended = trip.depart_ms ? trip.depart_ms < nowMs : false;
        if (ended) continue;
        const item = { type: "travel.trip", subject_key: trip.subject_key, summary: tripSummary(trip, tz), data: { metro: trip.metro, label: trip.label, via: trip.via, from_metro: trip.from_metro } };
        const m = await decideItem(rule, item, ctx);
        if (!m) continue;
        summary.decided++;
        if (m.verdict !== "match" && m.verdict !== "confirmed") continue;
        if (m.fired_at) continue;
        const at = anchorFireMs(rule, trip, tz);
        const base = rule.anchor_field === "arrive" ? trip.arrive_ms : trip.leave_ms;
        if (at == null || (rule.offset_min != null && base < nowMs)) {
          if (m.verdict !== "missed") updateMatch(m.id, { verdict: "missed" }, nowMs);
          continue;
        }
        const fireIso = isoNow(Math.max(at, 0) || nowMs);
        if (m.fire_at !== fireIso) updateMatch(m.id, { fire_at: fireIso }, nowMs);
        if (at <= nowMs) toFire.push({ rule, item });
      }
    }
  }

  // 3. Fixed-time rules.
  for (const rule of rules.filter((r) => r.trigger_kind === "at")) {
    const key = `at:${rule.fire_at}`;
    let m = getMatch(rule.id, key) || putMatch({ rule_id: rule.id, subject_key: key, summary: rule.title, verdict: "match", decided_by: "clock", fire_at: rule.fire_at }, nowMs);
    if (!m.fired_at && Date.parse(rule.fire_at) <= nowMs) toFire.push({ rule, item: { type: "clock", subject_key: key, summary: rule.title, data: {} } });
  }

  // 4. Questions: ask what the models couldn't settle; read the owner's answers.
  const responses = deps.readResponses();
  const awake = nextAwake(nowMs, tz) === nowMs;
  for (const rule of rules) {
    for (const m of listMatches(rule.id)) {
      if (m.verdict === "unclear" && !m.question_id && awake && !dryRun && !deps.pendingQuestionOpen(nowMs)) {
        const qid = `watch-${m.id}`;
        const r = deps.askQuestion({ id: qid, subject: rule.title, message: questionText(rule, m) });
        if (r.code === 0) {
          updateMatch(m.id, { verdict: "asked", question_id: qid, asked_at: isoNow(nowMs) }, nowMs); summary.asked.push(qid);
          logEvent("asked", { rule_id: rule.id, match_id: m.id, nowMs, question_id: qid });
        } else if ([12, 13, 14].includes(r.code)) {
          // Not sent (resolved from the records / suppressed): stop, don't re-ask every tick.
          // `watch show` lists it; the owner or the chat agent can still confirm it by hand.
          updateMatch(m.id, { verdict: "ask_skipped", question_id: qid }, nowMs);
          logEvent("ask_skipped", { rule_id: rule.id, match_id: m.id, nowMs, question_id: qid, exit: r.code });
          log(`${rule.id}: hum-ask exit ${r.code} for ${qid} — not asked`);
        } else log(`${rule.id}: hum-ask exit ${r.code} for ${qid}; retrying next tick`);
        break; // one new question per tick; hum holds one open slot anyway
      }
      if (m.verdict === "asked" && m.question_id) {
        const reply = responses.filter((x) => x.ping_id === m.question_id && (!m.asked_at || x.ts >= m.asked_at)).pop();
        if (!reply) continue;
        const ans = await deps.judgeAnswer(questionText(rule, m), reply.reply_text, { id: m.question_id });
        logEvent("answered", { rule_id: rule.id, match_id: m.id, nowMs, answer: ans, reply: String(reply.reply_text).slice(0, 300),
          answer_min: m.asked_at ? Math.round((Date.parse(reply.ts) - Date.parse(m.asked_at)) / 60000) : null });
        if (ans === "yes") {
          updateMatch(m.id, { verdict: "confirmed", decided_by: OWNER_ID }, nowMs);
          if (rule.trigger_kind === "event") {
            const d = m.detail ? JSON.parse(m.detail) : {};
            updateMatch(m.id, { fire_at: isoNow(nowMs) }, nowMs);
            toFire.push({ rule, item: { type: d.type || "event", subject_key: m.subject_key, summary: m.summary, data: d.data || {} } });
          }
          // An anchored confirmation fires from step 2 on its computed time next tick.
        } else if (ans === "no") {
          updateMatch(m.id, { verdict: "rejected", decided_by: OWNER_ID }, nowMs);
        }
      }
    }
  }

  // 5. Fire — inside the awake window only; held otherwise (the match keeps its fire_at).
  const seen = new Set();
  for (const { rule, item } of toFire) {
    const k = `${rule.id}|${item.subject_key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!awake) continue;
    const fresh = getRule(rule.id);
    if (!fresh || fresh.status !== "active") continue;
    const m = getMatch(rule.id, item.subject_key);
    if (!m || m.fired_at) continue;
    try {
      const r = await fire(fresh, m, item, { nowMs, deps, dryRun });
      summary.fired.push({ rule: rule.id, subject: item.subject_key, ...r });
    } catch (err) {
      summary.errors.push(`${rule.id}: ${err.message}`);
      log(`${rule.id}: fire failed (${err.message}); will retry next tick`);
    }
  }

  // Event matches not yet fired (held for quiet hours, or a failed delivery)
  // re-enter on a later tick through the retry list.
  for (const rule of eventRules) {
    for (const m of listMatches(rule.id)) {
      if (["match", "confirmed"].includes(m.verdict) && !m.fired_at) {
        const d = m.detail ? JSON.parse(m.detail) : {};
        state.retry.push({ type: d.type || "event", subject_key: m.subject_key, summary: m.summary, data: d.data || {}, ts: m.created_at });
      }
    }
  }
  state.retry = [...new Map(state.retry.map((e) => [e.subject_key, e])).values()];

  if (!dryRun) { state.last_tick = isoNow(nowMs); saveState(state); }
  return summary;
}

// ─── how well it works (watch stats, jobs/watch-review.md) ────────────────

const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const countBy = (xs, f) => xs.reduce((o, x) => { const k = f(x) ?? "none"; o[k] = (o[k] || 0) + 1; return o; }, {});

/**
 * The scorecard over the last `days`. `outcomes` (optional, async) looks up
 * what happened after a firing: {reactions: {message_id: emoji}, tasks: {task_id: "completed"|"needsAction"}}.
 */
export async function stats({ days = 7, nowMs = Date.now(), outcomes = null } = {}) {
  const since = isoNow(nowMs - days * 86400e3);
  const ev = listEvents({ sinceIso: since });
  const of = (k) => ev.filter((e) => e.kind === k);
  const state = readJson(PATHS.state, {});
  const rules = listRules({ all: true });
  const fired = of("fired");
  const answered = of("answered");
  const askedIds = new Set(of("asked").map((e) => e.match_id));
  for (const e of answered) askedIds.delete(e.match_id);
  let out = {};
  if (outcomes) {
    try { out = await outcomes({ message_ids: fired.map((e) => e.detail.message_id).filter(Boolean), task_ids: fired.map((e) => e.detail.task_id).filter(Boolean) }) || {}; }
    catch (err) { out = { error: err.message }; }
  }
  const reactions = out.reactions || {};
  const tasks = out.tasks || {};
  const failedMatches = new Set(of("fire_failed").map((e) => e.match_id));
  for (const e of fired) failedMatches.delete(e.match_id);
  return {
    window_days: days,
    since,
    engine: {
      last_tick: state.last_tick || null,
      tick_age_min: state.last_tick ? Math.round((nowMs - Date.parse(state.last_tick)) / 60000) : null,
      retry_backlog: (state.retry || []).length,
      mail_source_armed: Boolean(state.email), anytime_source_armed: Boolean(state.anytime),
    },
    watches: {
      active: rules.filter((r) => r.status === "active").length,
      by_status: countBy(rules, (r) => r.status),
      created: of("created").length,
      created_by: countBy(of("created"), (e) => e.detail.origin),
      without_request_quote: rules.filter((r) => r.status === "active" && !r.request).map((r) => r.id),
    },
    decisions: {
      total: of("decided").length,
      by_verdict: countBy(of("decided"), (e) => e.detail.verdict),
      by_decider: countBy(of("decided"), (e) => e.detail.used),
      failed: of("decide_failed").length,
      median_ms: median(of("decided").map((e) => e.detail.ms)),
    },
    questions: {
      asked: of("asked").length,
      skipped: of("ask_skipped").length,
      answered: countBy(answered, (e) => e.detail.answer),
      median_answer_min: median(answered.map((e) => e.detail.answer_min)),
      still_open: askedIds.size,
    },
    firings: {
      total: fired.length,
      delivery: countBy(fired, (e) => e.detail.delivery),
      suppressed: fired.filter((e) => e.detail.delivery === "suppressed").map((e) => ({ rule: e.rule_id, ts: e.ts, reason: e.detail.suppressed_reason })),
      median_late_min: median(fired.map((e) => e.detail.late_min)),
      late_over_60_min: fired.filter((e) => e.detail.late_min > 60).map((e) => ({ rule: e.rule_id, ts: e.ts, late_min: e.detail.late_min })),
      failed_never_delivered: failedMatches.size,
      reactions: countBy(fired.filter((e) => e.detail.message_id), (e) => reactions[e.detail.message_id] || "no reaction"),
      tasks: countBy(fired.filter((e) => e.detail.task_id), (e) => tasks[e.detail.task_id] || "unknown"),
    },
    feedback: of("feedback").map((e) => ({ rule: e.rule_id, ts: e.ts, note: e.detail.note })),
    misses: of("missed").map((e) => ({ rule: e.rule_id, ts: e.ts, note: e.detail.note })),
    corrections: ev.filter((e) => e.kind === "manual:rejected" || e.kind === "manual:confirmed").map((e) => ({ kind: e.kind, rule: e.rule_id, ts: e.ts, subject_key: e.detail.subject_key })),
    retired: ev.filter((e) => e.kind === "status:done" && e.detail.by !== "engine").map((e) => ({ rule: e.rule_id, ts: e.ts, reason: e.detail.reason })),
    per_watch: rules.map((r) => ({
      id: r.id, status: r.status, kind: r.trigger_kind, origin: r.origin, fire_count: r.fire_count, last_fired_at: r.last_fired_at,
      decisions: ev.filter((e) => e.rule_id === r.id && e.kind === "decided").length,
      questions: ev.filter((e) => e.rule_id === r.id && e.kind === "asked").length,
      next_fire_at: listMatches(r.id).filter((m) => ["match", "confirmed"].includes(m.verdict) && !m.fired_at && m.fire_at).map((m) => m.fire_at).sort()[0] || null,
    })),
  };
}

// ─── single-flight lock ────────────────────────────────────────────────────

export function acquireLock(maxAgeMs = 15 * 60e3) {
  try {
    const cur = readJson(PATHS.lock, null);
    if (cur && Date.now() - cur.at < maxAgeMs) {
      try { process.kill(cur.pid, 0); return false; } catch { /* dead holder */ }
    }
    writeJsonAtomic(PATHS.lock, { pid: process.pid, at: Date.now() });
    return true;
  } catch { return false; }
}
export function releaseLock() {
  try { if (readJson(PATHS.lock, null)?.pid === process.pid) fs.unlinkSync(PATHS.lock); } catch {}
}
