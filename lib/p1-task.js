// p1-task — the link between a P1 email and the Google Task it spawned.
//
// Why this exists (a user requirement: replying to a P1 email closes its
// task): triage creates a Google Task for every P1, but nothing ever tied the
// task back to the email. Titles are freeform (the agent writes "Contractor —
// paint code for the wall patch", not the email's subject), so when the P1 is
// resolved — the user replies, unstars it, or says "that's handled" — the task
// lived on until it was closed by hand.
//
// Two halves:
//   1. `addTask` stamps a machine marker into the task's notes at creation:
//        [jori-p1 thread:<threadId> msg:<messageId>]
//      That is the exact link. Every P1 task created through `p1-task add`
//      carries it.
//   2. `closeTasksFor` finds the task for a resolved P1 — by marker first, and
//      for tasks created before the marker existed (or by an agent turn that
//      skipped the wrapper) by subject-token overlap with the title + notes,
//      accepted only when there is ONE clear winner. Ambiguity closes nothing:
//      a wrong task closed silently is worse than a stale one the user can see.
//
// "Remove" means mark completed, not delete: the daily summary lists the day's
// completed tasks, so a task closed by the user's reply shows up there as closed.
//
// Matching subjects to titles is structural (two machine-held strings, token
// overlap), not language interpretation — no model is needed and none is used.

"use strict";

const { spawnSync } = require("node:child_process");
const { loadEnv } = require("./load-env.js");
const { instance } = require("./instance.cjs");

loadEnv();

const GOG = process.env.GOG_BIN || "/opt/homebrew/bin/gog";
const DEFAULT_ACCOUNT = process.env.JORI_CAL_ACCOUNT || instance().owner_email;
const DEFAULT_LIST = "@default";

const MARKER_PREFIX = "[jori-p1 ";

function taskMarker(threadId, messageId) {
  return `${MARKER_PREFIX}thread:${threadId} msg:${messageId}]`;
}

// Parse our own marker out of a task's notes. The marker is a string this
// library wrote; its shape is fixed, so a split is the right tool.
function parseMarker(notes) {
  if (!notes) return null;
  const start = notes.indexOf(MARKER_PREFIX);
  if (start < 0) return null;
  const end = notes.indexOf("]", start);
  if (end < 0) return null;
  const inner = notes.slice(start + MARKER_PREFIX.length, end);
  const out = {};
  for (const part of inner.split(/\s+/)) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out.thread || out.msg ? { threadId: out.thread || null, messageId: out.msg || null } : null;
}

// Words that carry no identity — a subject is matched on the rest.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "your", "you", "are", "this", "that",
  "has", "have", "was", "were", "will", "about", "new", "please", "request",
  "update", "updated", "action", "required", "needed", "notification", "email",
  "mail", "message", "important", "urgent", "reminder", "info", "re", "fwd",
]);

// Subject → identity tokens. Strips reply/forward prefixes (structural mail
// headers, not meaning), lowercases, drops punctuation, short words and
// stopwords. Returns a de-duplicated array.
function subjectTokens(subject) {
  if (!subject) return [];
  let s = String(subject).toLowerCase();
  // leading "re:", "fwd:", "fw:" chains (any count, any spacing)
  for (;;) {
    const m = /^\s*(re|fwd|fw|aw|tr)\s*:\s*/i.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  const toks = s.split(/[^a-z0-9$%@.-]+/).map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(toks)];
}

function textTokens(text) {
  return new Set(subjectTokens(text));
}

// Score one task against a subject: fraction of the subject's identity tokens
// present in the task's title + notes. `matched` is the absolute count.
function scoreTask(task, subjTokens) {
  if (!subjTokens.length) return { score: 0, matched: 0 };
  const hay = textTokens(`${task.title || ""} ${task.notes || ""}`);
  let matched = 0;
  for (const t of subjTokens) if (hay.has(t)) matched++;
  return { score: matched / subjTokens.length, matched };
}

const FUZZY_MIN_SCORE = 0.6;
const FUZZY_MIN_MATCHED = 2;
const FUZZY_CLEAR_LEAD = 0.25;

// Pick the task(s) for a resolved P1 from a list of OPEN tasks.
//   exact  — tasks whose marker names this thread (or this message).
//   fuzzy  — the single clear subject-overlap winner, only when no exact hit.
//   ambiguous — fuzzy candidates that were good but not clearly best (reported,
//               never closed).
function matchTasks(tasks, { threadId, messageId, subject }) {
  const open = (tasks || []).filter((t) => t && t.status !== "completed" && !t.deleted);
  const exact = open.filter((t) => {
    const m = parseMarker(t.notes);
    if (!m) return false;
    return (threadId && m.threadId === threadId) || (messageId && m.messageId === messageId);
  });
  if (exact.length) return { exact, fuzzy: [], ambiguous: [] };

  const toks = subjectTokens(subject);
  if (toks.length < FUZZY_MIN_MATCHED) return { exact: [], fuzzy: [], ambiguous: [] };
  const scored = open
    .map((t) => ({ task: t, ...scoreTask(t, toks) }))
    .filter((s) => s.score >= FUZZY_MIN_SCORE && s.matched >= FUZZY_MIN_MATCHED)
    .sort((a, b) => b.score - a.score || b.matched - a.matched);
  if (!scored.length) return { exact: [], fuzzy: [], ambiguous: [] };
  const [top, second] = scored;
  const clear = !second || top.score - second.score >= FUZZY_CLEAR_LEAD;
  if (clear) return { exact: [], fuzzy: [top.task], ambiguous: [] };
  return { exact: [], fuzzy: [], ambiguous: scored.map((s) => s.task) };
}

// ---- gog ---------------------------------------------------------------------
function gogJson(args, timeout = 20000) {
  const r = spawnSync(GOG, [...args, "--json", "--no-input"], {
    encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw new Error(r.error.message);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `gog exited ${r.status}`).trim().slice(0, 300));
  try { return JSON.parse(r.stdout); }
  catch (e) { throw new Error(`gog returned non-JSON: ${e.message}`); }
}

function listOpenTasks({ account = DEFAULT_ACCOUNT, list = DEFAULT_LIST } = {}) {
  const out = [];
  let page = null;
  do {
    const res = gogJson([
      "tasks", "list", list, "-a", account, "--max", "100",
      ...(page ? ["--page", page] : []),
    ]);
    for (const t of res.tasks || []) if (t.status !== "completed") out.push(t);
    page = res.nextPageToken || null;
  } while (page);
  return out;
}

function completeTask(taskId, { account = DEFAULT_ACCOUNT, list = DEFAULT_LIST } = {}) {
  return gogJson(["tasks", "done", list, taskId, "-a", account]);
}

// One P1 thread, one task. Two "new mail" notices on one thread once became
// two identical tasks, listed twice in the day's summary. A later email on a thread that
// already has an open task is the same to-do: the open task is returned instead.
function openTaskForThread(tasks, threadId) {
  if (!threadId) return null;
  return (tasks || []).find((t) => t && t.status !== "completed"
    && (parseMarker(t.notes) || {}).threadId === threadId) || null;
}

function addTask({ title, due, notes, threadId, messageId, account = DEFAULT_ACCOUNT, list = DEFAULT_LIST }) {
  if (!title) throw new Error("addTask: title required");
  const marker = taskMarker(threadId, messageId);
  if (threadId && process.env.P1_TASK_THREAD_DEDUPE !== "0") {
    let open = null;
    try { open = openTaskForThread(listOpenTasks({ account, list }), threadId); }
    catch { open = null; }   // a failed lookup adds the task, as before
    if (open) return { id: open.id || null, title: open.title || title, marker, existing: true };
  }
  const fullNotes = notes ? `${notes}\n\n${marker}` : marker;
  const args = ["tasks", "add", list, "-a", account, "--title", title, "--notes", fullNotes];
  if (due) args.push("--due", due);
  const res = gogJson(args);
  const task = res.task || res;
  return { id: task.id || null, title: task.title || title, marker };
}

// Close the task(s) linked to a resolved P1. Never throws — returns
// { closed, ambiguous, error } so callers (p1-downgrade, the reply sweep) can
// record the outcome without letting a Tasks hiccup fail the Gmail side.
function closeTasksFor({ threadId, messageId, subject, account = DEFAULT_ACCOUNT, list = DEFAULT_LIST, dryRun = false }) {
  let tasks;
  try { tasks = listOpenTasks({ account, list }); }
  catch (e) { return { closed: [], ambiguous: [], error: `list: ${e.message}` }; }
  const m = matchTasks(tasks, { threadId, messageId, subject });
  const targets = m.exact.length ? m.exact.map((t) => ({ t, via: "marker" })) : m.fuzzy.map((t) => ({ t, via: "subject" }));
  const closed = [];
  const errors = [];
  for (const { t, via } of targets) {
    if (dryRun) { closed.push({ id: t.id, title: t.title, via, dryRun: true }); continue; }
    try { completeTask(t.id, { account, list }); closed.push({ id: t.id, title: t.title, via }); }
    catch (e) { errors.push(`${t.id}: ${e.message}`); }
  }
  return {
    closed,
    ambiguous: m.ambiguous.map((t) => ({ id: t.id, title: t.title })),
    error: errors.length ? errors.join("; ") : null,
  };
}

module.exports = {
  taskMarker, parseMarker, subjectTokens, matchTasks,
  listOpenTasks, completeTask, addTask, closeTasksFor, openTaskForThread,
  DEFAULT_ACCOUNT, DEFAULT_LIST,
};
