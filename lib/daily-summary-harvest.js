"use strict";
// daily-summary-harvest — the day's NON-location facts, harvested and anchored
// to stops by code (2026-10-04).
//
// Until now Steps 2-3 of jobs/daily-summary.md were the forked xhigh session's
// own work: run the jori_messages SQL, `git log` twice, a Gmail connector
// search, an Apple Notes listing, then time-anchor every fact to the stop whose
// [start_ts_ms, end_ts_ms] contains it — in its head. Fetching rows and
// comparing timestamps is arithmetic, so it belongs here; the session now
// reads `manifest.harvest` and spends its effort on what is language (vetting
// chat candidates, writing prose, the review).
//
// Every source is fail-open and reports its own error: a missing source shows
// up as `errors[source]`, never as "nothing happened". Raw facts are cached in
// /tmp/ds-harvest-<date>.json so re-preps (which renumber stops) re-anchor
// without re-fetching.
//
// Chat rows stay inside the jori-model boundary (the user's own, read locally).
// No bank data passes through here.

const fs = require("fs");
const { spawnSync } = require("child_process");
const path = require("path");

const { dayWindow: dayWindowIn, zonedMidnightMs, defaultTz } = require("./day-window.js");
const { autonomousTag, ROUTINE_LOOKBACK_DAYS } = require("./daily-summary-commits.js");
const { dayMessages } = require("./day-messages.js");
const { instance, agentAddresses } = require("./instance.cjs");
const { installRoot, installTools } = require("./root.cjs");

const REPO = installRoot();
const DATA_DIR_FOR_DIGEST = process.env.MESSAGE_DIGEST_DATA_DIR || installTools("data");
// gog: $GOG_BIN, else a package-manager install (launchd's PATH has neither), else PATH.
const GOG = process.env.GOG_BIN || ["/opt/homebrew/bin/gog", "/usr/local/bin/gog"].find((p) => fs.existsSync(p)) || "gog";
const CHAT_TEXT_MAX = 600;
const SNIPPET_MAX = 200;

/**
 * The day's window in the zone the day was cut in — the same boundary
 * resolve-day used (`resolved.path.tz`, see day-window.js `boundaryTzOf`).
 * Defaults to the home zone for a caller with no zone. Cut in the home zone, a
 * day spent seven hours east of home lost its first seven hours of chat,
 * commits, mail and notes and took in the last seven of the previous night.
 */
function dayWindow(date, tz = defaultTz()) {
  return dayWindowIn(date, tz);
}

const inWindow = (ms, w) => Number.isFinite(ms) && ms >= w.startMs && ms < w.endMs;

/** Chat rows (already fetched by prep for the settle loop), trimmed to the day.
 *  `reply_to` is kept when the user used the app's Reply action: it names the
 *  exact Jori message answered, which the review shows beside his message. */
function chatFacts(rows, w) {
  return (rows || [])
    .map((r) => ({ kind: "chat", at: r.created_at, ms: Date.parse(r.created_at), role: r.role,
      id: r.id, ...(r.reply_to ? { reply_to: r.reply_to } : {}), text: String(r.content || "").slice(0, CHAT_TEXT_MAX) }))
    .filter((f) => inWindow(f.ms, w));
}

// Corrections the user sent about this day AFTER the fact, by email.
//
// Chat is the only channel the summary reads for what the user says, and an
// emailed reply to the "Day of ..." mail never reaches it: a "there was also a
// coffee stop before that" names a stop that leaves no GPS, photo or card trace
// of its own, so it had nowhere to land. The email-inbound turn records the
// user's words with `bin/day-correction add`; they are read here, not
// interpreted -- which stop they belong to is a window the recording turn (a
// model) decided from what was said, and the narrator (a model) decides what
// they establish. Code only anchors them by time.
const DAY_CORRECTIONS_DIR = process.env.JORI_DAY_CORRECTIONS_DIR
  || installTools("data", "day-corrections");

function readCorrections(date, dir = DAY_CORRECTIONS_DIR) {
  const fs = require("fs");
  let text;
  try { text = fs.readFileSync(path.join(dir, `${date}.jsonl`), "utf8"); } catch (_) { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      if (c && typeof c.text === "string" && c.text.trim()) out.push(c);
    } catch (_) { /* a torn line is skipped, never fatal */ }
  }
  return out;
}

/**
 * One fact per stop the correction's window touches, each anchored inside that
 * stop; a correction with no window (or none overlapping a stop) is anchored by
 * when it was said and lands as an orphan fact rather than vanishing. Pure.
 */
function correctionFacts(corrections, stops) {
  const out = [];
  for (const c of corrections || []) {
    const base = { kind: "correction", at: c.said_at || null, channel: c.channel || "email",
      text: String(c.text).slice(0, CHAT_TEXT_MAX * 2), window: c.applies_from && c.applies_to
        ? { from: c.applies_from, to: c.applies_to } : null,
      // The recording turn's own reading, kept apart from the user's words.
      ...(c.reading ? { reading: String(c.reading).slice(0, CHAT_TEXT_MAX) } : {}) };
    const from = Date.parse(c.applies_from), to = Date.parse(c.applies_to);
    const touched = Number.isFinite(from) && Number.isFinite(to)
      ? (stops || []).filter((s) => Number.isFinite(s.start_ts_ms) && s.end_ts_ms > from && s.start_ts_ms < to)
      : [];
    if (!touched.length) { out.push({ ...base, ms: Date.parse(c.said_at) }); continue; }
    for (const s of touched) out.push({ ...base, ms: Math.max(from, s.start_ts_ms), stop_id: s.id });
  }
  return out;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} exit ${r.status}: ${(r.stderr || "").slice(0, 200)}`);
  return r.stdout || "";
}

/** Commits and newly-added files in the jori repo during the day. */
function gitFacts(w, repo = REPO) {
  const commits = [];
  const out = run("git", ["-C", repo, "log", `--since=${w.start}`, `--until=${w.end}`,
    "--pretty=format:%h%x09%cI%x09%s"]);
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [sha, iso, ...subj] = line.split("\t");
    const ms = Date.parse(iso);
    if (inWindow(ms, w)) commits.push({ kind: "commit", at: new Date(ms).toISOString(), ms, sha, subject: subj.join("\t") });
  }
  const added = [];
  const out2 = run("git", ["-C", repo, "log", `--since=${w.start}`, `--until=${w.end}`,
    "--diff-filter=A", "--name-only", "--pretty=format:@@%h%x09%cI"]);
  let cur = null;
  for (const line of out2.split("\n")) {
    if (line.startsWith("@@")) {
      const [sha, iso] = line.slice(2).split("\t");
      cur = { sha, ms: Date.parse(iso) };
    } else if (line.trim() && cur && inWindow(cur.ms, w)) {
      added.push({ kind: "new_file", at: new Date(cur.ms).toISOString(), ms: cur.ms, sha: cur.sha, file: line.trim() });
    }
  }
  return { commits, added };
}

/**
 * Which autonomous-commit tags (daily-summary-commits.js AUTONOMOUS_TAGS) turned
 * up on each of the ROUTINE_LOOKBACK_DAYS days before the day's window, by the
 * zone's calendar date: [{date, tags: [tag...]}], oldest first. routineTags()
 * reads it to tell what Jori does every day from what it did once.
 */
function priorCommitTags(w, tz = defaultTz(), repo = REPO, days = ROUTINE_LOOKBACK_DAYS) {
  const since = new Date(w.startMs - days * 86400000).toISOString();
  const out = run("git", ["-C", repo, "log", `--since=${since}`, `--until=${new Date(w.startMs).toISOString()}`,
    "--pretty=format:%cI%x09%s"]);
  const dateOf = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const byDate = new Map();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [iso, ...subj] = line.split("\t");
    const ms = Date.parse(iso);
    const tag = autonomousTag(subj.join("\t"));
    if (!tag || !Number.isFinite(ms)) continue;
    const d = dateOf.format(new Date(ms));
    if (!byDate.has(d)) byDate.set(d, new Set());
    byDate.get(d).add(tag);
  }
  return [...byDate].sort((a, b) => a[0].localeCompare(b[0])).map(([date, tags]) => ({ date, tags: [...tags] }));
}

/** Mail the user sent from their own mailbox (instance owner_email) that day, not the agent's. */
function sentMailFacts(w) {
  const account = instance().owner_email;
  if (!account) throw new Error("no owner_email in agent/local/instance.json");
  const notAgent = agentAddresses().map((a) => ` -from:${a}`).join("");
  const q = `from:me after:${Math.floor(w.startMs / 1000)} before:${Math.floor(w.endMs / 1000)}${notAgent}`;
  const out = run(GOG, ["gmail", "search", q, "--account", account, "--json", "--results-only",
    "--max", "100", "--timezone", "UTC"]);
  if (!out.trim()) return [];
  const rows = JSON.parse(out);
  if (!Array.isArray(rows)) throw new Error("unexpected gog output shape");
  return rows.map((r) => {
    // gog --timezone UTC prints "YYYY-MM-DD HH:MM"; pin it to UTC.
    const s = String(r.date || "").trim();
    const ms = Date.parse(s.includes("T") || s.endsWith("Z") ? s : `${s.replace(" ", "T")}Z`);
    return { kind: "sent_mail", at: Number.isFinite(ms) ? new Date(ms).toISOString() : null, ms,
      id: r.id, thread_id: r.threadId || r.id, to: r.to || null, subject: r.subject || "",
      snippet: String(r.snippet || "").slice(0, SNIPPET_MAX) };
  }).filter((f) => inWindow(f.ms, w));
}

/** Apple Notes created or edited during the day — titles only, never bodies. */
function notesFacts(w) {
  const now = Date.now();
  const fromAgo = Math.max(0, Math.round((now - w.startMs) / 1000));
  const toAgo = Math.max(0, Math.round((now - w.endMs) / 1000));
  const script = `
tell application "Notes"
  set nowD to current date
  set d1 to nowD - ${fromAgo}
  set d2 to nowD - ${toAgo}
  set out to {}
  repeat with f in every folder
    set fname to name of f
    if fname is not "Recently Deleted" then
      repeat with n in (every note of f whose modification date ≥ d1 and modification date < d2)
        set end of out to fname & tab & (name of n) & tab & ((nowD - (modification date of n)) as integer)
      end repeat
    end if
  end repeat
  set AppleScript's text item delimiters to linefeed
  return out as text
end tell`;
  const out = run("osascript", ["-e", script], { timeout: 45000 });
  return out.split("\n").filter((l) => l.trim()).map((l) => {
    const [folder, title, ago] = l.split("\t");
    const ms = now - Number(ago) * 1000;
    return { kind: "note", at: new Date(ms).toISOString(), ms, folder, title };
  }).filter((f) => inWindow(f.ms, w));
}

/**
 * Anchor each fact to the stop whose [start_ts_ms, end_ts_ms] contains it, else
 * to the travel gap between two consecutive stops, else orphan. Pure.
 */
function anchorFacts(facts, stops) {
  const ordered = (stops || [])
    .filter((s) => Number.isFinite(s.start_ts_ms) && Number.isFinite(s.end_ts_ms))
    .sort((a, b) => a.start_ts_ms - b.start_ts_ms);
  const by_stop = {};
  const legs = new Map();
  const orphan = [];
  for (const f of facts) {
    const strip = { ...f };
    delete strip.ms;
    if (!Number.isFinite(f.ms)) { orphan.push(strip); continue; }
    const stop = ordered.find((s) => f.ms >= s.start_ts_ms && f.ms <= s.end_ts_ms);
    if (stop) { (by_stop[stop.id] = by_stop[stop.id] || []).push(strip); continue; }
    let leg = null;
    for (let i = 0; i < ordered.length - 1; i++) {
      if (f.ms > ordered[i].end_ts_ms && f.ms < ordered[i + 1].start_ts_ms) { leg = [ordered[i].id, ordered[i + 1].id]; break; }
    }
    if (leg) {
      const k = leg.join("→");
      if (!legs.has(k)) legs.set(k, { from: leg[0], to: leg[1], facts: [] });
      legs.get(k).facts.push(strip);
    } else {
      orphan.push(strip);
    }
  }
  return { facts_by_stop: by_stop, facts_by_leg: [...legs.values()], orphan_facts: orphan };
}

// data/message-digests/<date>.json, slimmed to what the narrator uses; null when absent.
function readMessageDigest(date) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR_FOR_DIGEST, "message-digests", `${date}.json`), "utf8"));
    return { generated_at: d.generated_at, window: d.window, counts: d.counts, errors: d.errors,
      conversations: (d.conversations || []).filter((c) => c.summary).map(({ channel, chat, is_group, messages, summary, needs_you }) => ({ channel, chat, is_group, messages, summary, needs_you })) };
  } catch { return null; }
}

/**
 * Fetch every source (or reuse `cached` raw facts), then anchor.
 * @param {{date:string, chatRows:Array, stops:Array, cached?:object, sources?:object, tz?:string}} a
 *   `tz` is the zone the day was cut in; the raw-fact cache is keyed on it too.
 *   `sources` lets tests stub fetchers: { git, sentMail, notes, messages }.
 */
function harvestDay({ date, chatRows = [], stops = [], cached = null, sources = {}, tz = defaultTz(), tasks = [] }) {
  const w = dayWindow(date, tz);
  // A cache cut in another zone holds a different window's facts: a day cut in
  // the home zone misses the first hours of a day spent far east, so it is
  // refetched, not reused. A cache with no zone was cut in the home zone.
  const fresh = cached && cached.date === date && (cached.tz || defaultTz()) === tz;
  let raw = fresh ? cached.raw : null;
  const errors = (fresh && cached.errors) || {};
  if (!raw) {
    raw = { commits: [], new_files: [], sent_mail: [], notes: [] };
    const tryIt = (name, fn) => { try { return fn(); } catch (e) { errors[name] = String(e.message || e).slice(0, 200); return null; } };
    const g = tryIt("git", () => (sources.git || gitFacts)(w));
    if (g) { raw.commits = g.commits; raw.new_files = g.added; }
    raw.sent_mail = tryIt("sent_mail", () => (sources.sentMail || sentMailFacts)(w)) || [];
    raw.notes = tryIt("notes", () => (sources.notes || notesFacts)(w)) || [];
  }
  // iMessage / WhatsApp / Slack, both directions (2026-10-27). A cache cut
  // before this source existed is topped up once.
  if (raw.messages === undefined) {
    const m = (sources.messages || dayMessages)(w);
    raw.messages = m.facts;
    raw.message_counts = m.counts;
    for (const [k, v] of Object.entries(m.errors || {})) errors[`messages_${k}`] = v;
  }
  // The previous days' autonomous tags settle which of today's are routine. Past
  // days do not change, so a cache cut before this existed is topped up once.
  // A failed read leaves null: routineTags(null) hides nothing.
  if (raw.prior_tags === undefined) {
    try { raw.prior_tags = (sources.priorTags || priorCommitTags)(w, tz); }
    catch (e) { raw.prior_tags = null; errors.prior_tags = String(e.message || e).slice(0, 200); }
  }
  const chat = chatFacts(chatRows, w);
  // Read fresh every time, never cached: a correction can land between preps.
  const correctionRows = (sources.corrections || readCorrections)(date);
  const corrections = correctionFacts(correctionRows, stops);
  const withMs = (arr) => arr.map((f) => ({ ...f, ms: Number.isFinite(f.ms) ? f.ms : Date.parse(f.at) }));
  // The tasks the user closed, anchored like everything else. As a day-level
  // list only, the writer never saw them beside the stop they happened at, and
  // called a working morning at a café a "slow morning coffee" though two tasks
  // closed there and an important email went out from it.
  const taskFacts = (tasks || []).filter((t) => Number.isFinite(t.completed_ts))
    .map((t) => ({ kind: "task", at: t.completed_utc || new Date(t.completed_ts).toISOString(), ms: t.completed_ts, title: t.title }));
  const all = [...chat, ...withMs(raw.commits), ...withMs(raw.sent_mail), ...withMs(raw.notes), ...withMs(raw.messages || []), ...corrections, ...taskFacts]
    .sort((a, b) => (a.ms || 0) - (b.ms || 0));
  const anchored = anchorFacts(all, stops);
  return {
    date,
    window: { start: w.start, end: w.end, boundary_tz: w.tz },
    counts: { chat: chat.length, commits: raw.commits.length, new_files: raw.new_files.length,
      sent_mail: raw.sent_mail.length, notes: raw.notes.length, corrections: correctionRows.length,
      messages: (raw.messages || []).length, message_sources: raw.message_counts || null },
    new_files: raw.new_files.map(({ ms, ...f }) => f),
    // The flat list `prep` turns into the summary's commits section
    // (daily-summary-commits.js); the anchored copies below are for the prose.
    commits: raw.commits.map(({ ms, ...f }) => f),
    prior_commit_tags: raw.prior_tags,
    errors,
    // The day's conversations summarized by message-digest (2026-10-28), read
    // fresh every prep, never cached: a later digest run supersedes it.
    message_digest: (sources.messageDigest || readMessageDigest)(date),
    ...anchored,
    _cache: { date, tz, raw, errors },
  };
}

/**
 * The count columns `daily_summaries` keeps for the weekly/monthly packets to
 * sum (`lib/period-summary.js` stats()), read off a day's harvest.
 *
 * Commits must be tracked: after a rewrite of the daily summary nothing wrote
 * `commits_count` or `messages_count` (the playbook's bookkeeping SQL stopped
 * naming them), so every day read 0 and a week with 145 commits reported none.
 * `publish` now stamps them from the harvest it already holds.
 *
 * A source that FAILED is left out of the result rather than counted as zero, so
 * a git or mail outage can never overwrite a real count with 0. A harvest cut
 * for another date yields nothing.
 */
function countColumns(harvest, date) {
  if (!harvest || harvest.date !== date || !harvest.counts) return {};
  const errs = harvest.errors || {};
  const c = harvest.counts;
  const cols = {};
  if (!errs.git && Number.isFinite(c.commits)) cols.commits_count = c.commits;
  if (!errs.sent_mail && Number.isFinite(c.sent_mail)) cols.emails_sent_count = c.sent_mail;
  if (Number.isFinite(c.chat)) cols.messages_count = c.chat;
  return cols;
}

module.exports = { countColumns, dayWindow, etMidnightMs: (date, tz = defaultTz()) => zonedMidnightMs(date, tz), chatFacts, gitFacts, priorCommitTags, sentMailFacts, notesFacts, anchorFacts, harvestDay,
  readCorrections, correctionFacts, DAY_CORRECTIONS_DIR };
