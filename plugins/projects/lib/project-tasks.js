// project-tasks — the task ledger behind the project pages (plugins/projects,
// jobs/projects.md § Tasks, jobs/project-work.md).
//
// Every project page names what the user might need; this turns those needs into
// tasks with an id, an owner, a due date and a state, so they can be tracked,
// put on the user's own task list, followed up when they slip, and, where Jori
// can do the work itself, done by Jori.
//
//   The ledger      data/projects/tasks.json, one writer at a time (a lock file).
//                   Agent turns change it only through `projects task …`.
//   Google Tasks    syncGoogle(): the user's tasks (owner "user") go on their own
//                   task list with a due date; their edits win (a completed or
//                   deleted task closes the ledger task, a changed title or date
//                   is adopted). Code only, run from cron.
//   The page        renderTasksSection(): a `## Tasks` section inside the managed
//                   block, written by code from the ledger and never by a model.
//   Slips           slipped(): the user's open tasks past due, at most one
//                   follow-up a week each.
//   Jori's work     workQueue() and workBudget(): which tasks Jori may work on
//                   tonight, and how much of the week's allowance that lane spent.
//
// Deciding what a task is, who owns it, and whether it is done is the model's
// (Rule #0b); this file only stores, syncs and renders.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const LIB = path.join(__dirname, "..", "..", "..", "lib");
const { installTools } = require(path.join(LIB, "root.cjs"));
const { instance, instanceValue, localConfig } = require(path.join(LIB, "instance.cjs"));

const OWNERS = ["user", "jori", "other"];
const JORI_MODES = ["no", "autonomous", "needs_ok"];
const SIZES = ["small", "medium", "large"];
const WORK_KINDS = ["code", "pr", "doc", "note", "research"];
const MARKER = (id) => `[jori:${id}]`;
const DAY_MS = 864e5;

function ledgerPath() {
  return process.env.PROJECTS_TASKS_FILE || installTools("data", "projects", "tasks.json");
}

function today(now = Date.now()) {
  const tz = instanceValue("tz") || "UTC";
  return new Date(now).toLocaleDateString("en-CA", { timeZone: tz });
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

function isDay(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)); // lang-regex-ok: date shape
}

function ownerFirstName() {
  const n = String(instance().owner_name || "").trim();
  return n && n !== "the user" ? n.split(" ")[0] : "The user";
}

function newId(existing) {
  for (;;) {
    const id = `pt-${crypto.randomBytes(3).toString("hex")}`;
    if (!existing[id]) return id;
  }
}

// ── the ledger file ──────────────────────────────────────────────────────────

function emptyLedger() {
  return { version: 1, tasks: {}, meta: { reviewed: {} } };
}

function load(file = ledgerPath()) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!j.tasks) j.tasks = {};
    if (!j.meta) j.meta = { reviewed: {} };
    if (!j.meta.reviewed) j.meta.reviewed = {};
    return j;
  } catch (e) {
    if (e.code === "ENOENT") return emptyLedger();
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
}

function save(ledger, file = ledgerPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 1) + "\n");
  fs.renameSync(tmp, file);
}

// One writer at a time: the half-hourly sync and an agent turn can overlap.
function withLock(fn, file = ledgerPath(), { waitMs = 30000 } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // A lock older than 10 minutes belongs to a process that died.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 600000) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() - start > waitMs) throw new Error("the task ledger is locked by another writer; try again");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  try {
    const ledger = load(file);
    const out = fn(ledger);
    save(ledger, file);
    return out;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// ── task operations (pure: they change the ledger object they are given) ─────

function stamp(t, by, now) {
  t.updated_at = new Date(now).toISOString();
  t.updated_by = by || "projects";
}

function addTask(ledger, f, { now = Date.now() } = {}) {
  const owner = f.owner || "user";
  if (!OWNERS.includes(owner)) throw new Error(`owner must be ${OWNERS.join("|")}`);
  if (!f.project) throw new Error("--project is required");
  if (!f.title || !String(f.title).trim()) throw new Error("--title is required");
  if (owner === "user" && !isDay(f.due)) throw new Error("a task for the user needs --due YYYY-MM-DD (every task on their list has a date)");
  if (f.due != null && !isDay(f.due)) throw new Error("--due must be YYYY-MM-DD");
  if (owner === "other" && !f.who) throw new Error("a task for someone else needs --who");
  const mode = f.jori || (owner === "jori" ? "autonomous" : "no");
  if (!JORI_MODES.includes(mode)) throw new Error(`--jori must be ${JORI_MODES.join("|")}`);
  if (f.size && !SIZES.includes(f.size)) throw new Error(`--size must be ${SIZES.join("|")}`);
  if (owner === "jori" && mode === "no") throw new Error("a task Jori owns needs --jori autonomous or needs_ok");
  // The same title open on the same project is the same task.
  const dupe = Object.values(ledger.tasks).find((t) => t.project === f.project && t.status === "open"
    && t.title.trim().toLowerCase() === String(f.title).trim().toLowerCase());
  if (dupe) throw new Error(`already open as ${dupe.id}; use task update`);
  const id = newId(ledger.tasks);
  const iso = new Date(now).toISOString();
  ledger.tasks[id] = {
    id, project: f.project, title: String(f.title).trim(), owner,
    who: f.who || null, due: f.due || null, status: "open",
    why: f.why ? String(f.why).trim() : null,
    created_at: iso, created_by: f.by || "projects", updated_at: iso, updated_by: f.by || "projects",
    closed_at: null, closed_by: null, close_note: null,
    jori: {
      mode, size: f.size || null, plan: f.plan || null,
      approved_at: null, approved_quote: null,
      state: "idle", attempts: 0, last_attempt_at: null, result: null,
    },
    gtask: null,
    slips: [], last_nudged_at: null,
  };
  return ledger.tasks[id];
}

function getTask(ledger, id) {
  const t = ledger.tasks[id];
  if (!t) throw new Error(`no task ${id}`);
  return t;
}

function updateTask(ledger, id, f, { now = Date.now() } = {}) {
  const t = getTask(ledger, id);
  if (f.title != null) t.title = String(f.title).trim();
  if (f.due !== undefined) {
    if (f.due !== null && !isDay(f.due)) throw new Error("--due must be YYYY-MM-DD");
    if (t.due && f.due && f.due > t.due && t.due < today(now)) t.slips.push({ due: t.due, moved_to: f.due, at: today(now) });
    t.due = f.due;
  }
  if (f.owner != null) {
    if (!OWNERS.includes(f.owner)) throw new Error(`owner must be ${OWNERS.join("|")}`);
    t.owner = f.owner;
  }
  if (t.owner === "user" && t.status === "open" && !isDay(t.due)) throw new Error("a task for the user needs a due date");
  if (f.who != null) t.who = f.who;
  if (f.why != null) t.why = f.why;
  if (f.jori != null) {
    if (!JORI_MODES.includes(f.jori)) throw new Error(`--jori must be ${JORI_MODES.join("|")}`);
    t.jori.mode = f.jori;
  }
  if (f.size != null) {
    if (!SIZES.includes(f.size)) throw new Error(`--size must be ${SIZES.join("|")}`);
    t.jori.size = f.size;
  }
  if (f.plan != null) t.jori.plan = f.plan;
  stamp(t, f.by, now);
  return t;
}

function closeTask(ledger, id, { status, note, by, now = Date.now() }) {
  const t = getTask(ledger, id);
  if (!["done", "dropped"].includes(status)) throw new Error("status must be done|dropped");
  if (!note) throw new Error("--note is required: say what shows it is done, or why it is dropped");
  t.status = status;
  t.closed_at = new Date(now).toISOString();
  t.closed_by = by || "projects";
  t.close_note = String(note).trim();
  stamp(t, by, now);
  return t;
}

function reopenTask(ledger, id, { by, due, now = Date.now() } = {}) {
  const t = getTask(ledger, id);
  t.status = "open";
  t.closed_at = null; t.closed_by = null; t.close_note = null;
  if (due) t.due = due;
  if (t.owner === "user" && !isDay(t.due)) throw new Error("a task for the user needs --due");
  if (t.gtask) t.gtask.detached = false;
  stamp(t, by, now);
  return t;
}

// ── follow-up ────────────────────────────────────────────────────────────────

// The user's open tasks past their date, not followed up in the last
// `nudge_every_days` (one follow-up a week per task, the user's choice).
function slipped(ledger, { now = Date.now(), nudgeEveryDays = 7 } = {}) {
  const d = today(now);
  return Object.values(ledger.tasks).filter((t) => t.status === "open" && t.owner === "user" && t.due && t.due < d
    && (!t.last_nudged_at || daysBetween(t.last_nudged_at.slice(0, 10), d) >= nudgeEveryDays))
    .map((t) => ({ id: t.id, project: t.project, title: t.title, due: t.due, days_late: daysBetween(t.due, d),
      times_slipped: t.slips.length + 1, last_nudged_at: t.last_nudged_at, why: t.why }));
}

function markNudged(ledger, id, { now = Date.now() } = {}) {
  const t = getTask(ledger, id);
  t.last_nudged_at = new Date(now).toISOString();
  return t;
}

// Projects due for tonight's deep "how do we move this forward" pass: the ones
// reviewed longest ago (never reviewed first).
function deepReviewList(projects, ledger, { n = 5, now = Date.now() } = {}) {
  const live = projects.filter((p) => ["active", "upcoming"].includes(p.project_status));
  const seen = ledger.meta.reviewed || {};
  return live.map((p) => ({ id: p.id, name: p.name, last_reviewed: seen[p.id] || null }))
    .sort((a, b) => String(a.last_reviewed || "").localeCompare(String(b.last_reviewed || "")) || a.id.localeCompare(b.id))
    .slice(0, n)
    .map((p) => ({ ...p, days_since: p.last_reviewed ? daysBetween(p.last_reviewed, today(now)) : null }));
}

// ── Jori's work ──────────────────────────────────────────────────────────────

// Tasks Jori may work on now: open, Jori's to do (or the user said yes), not
// already handed over for review, and not tried twice without success.
function workQueue(ledger, { now = Date.now(), maxAttempts = 2 } = {}) {
  const d = today(now);
  return Object.values(ledger.tasks).filter((t) => t.status === "open"
    && (t.jori.mode === "autonomous" || (t.jori.mode === "needs_ok" && t.jori.approved_at))
    && !["review", "working"].includes(t.jori.state)
    && t.jori.attempts < maxAttempts
    && (!t.jori.last_attempt_at || t.jori.last_attempt_at.slice(0, 10) < d))
    .sort((a, b) => (a.jori.approved_at ? 0 : 1) - (b.jori.approved_at ? 0 : 1)
      || String(a.due || "9999").localeCompare(String(b.due || "9999"))
      || a.created_at.localeCompare(b.created_at));
}

function approveWork(ledger, id, { quote, by, now = Date.now() }) {
  const t = getTask(ledger, id);
  if (!quote) throw new Error("--quote is required: the user's own words saying yes");
  if (t.jori.mode === "no") t.jori.mode = "needs_ok";
  t.jori.approved_at = new Date(now).toISOString();
  t.jori.approved_quote = String(quote).slice(0, 500);
  stamp(t, by || "chat", now);
  return t;
}

function startWork(ledger, id, { now = Date.now() } = {}) {
  const t = getTask(ledger, id);
  t.jori.state = "working";
  t.jori.attempts += 1;
  t.jori.last_attempt_at = new Date(now).toISOString();
  return t;
}

function recordWork(ledger, id, { kind, link, summary, failed, by, now = Date.now() }) {
  const t = getTask(ledger, id);
  if (!failed && !WORK_KINDS.includes(kind)) throw new Error(`--kind must be ${WORK_KINDS.join("|")}`);
  if (!summary) throw new Error("--summary is required");
  t.jori.state = failed ? "failed" : "review";
  t.jori.result = { kind: kind || null, link: link || null, summary: String(summary).slice(0, 1200), failed: !!failed, at: new Date(now).toISOString() };
  stamp(t, by || "project-work", now);
  return t;
}

// Share of the weekly allowance the project-work lane spent in the last 7 days,
// from the ephemeral-fork cost ledger (list-rate dollars ÷ the dollars one whole
// allowance is worth, the same unit allowance-brake uses).
function workBudget({ now = Date.now(), cap = 0.05, ledgerFile = null, job = "project-work" } = {}) {
  const file = ledgerFile || installTools("agent", "logs", "ephemeral-forks", "job-costs.ndjson");
  const brake = localConfig("allowance-brake", {});
  const usdPerAllowance = Number(brake.usd_per_allowance) > 0 ? Number(brake.usd_per_allowance) : 1400;
  let spent = 0;
  let runs = 0;
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.includes(job)) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.source !== job || now - Date.parse(r.ts) > 7 * DAY_MS) continue;
      spent += Number(r.total_cost_usd) || 0;
      runs += 1;
    }
  } catch { /* no ledger yet: nothing spent */ }
  const share = spent / usdPerAllowance;
  return { runs, spent_usd: Math.round(spent * 100) / 100, share: Math.round(share * 10000) / 10000, cap, room: Math.max(0, cap - share), over: share >= cap, usd_per_allowance: usdPerAllowance };
}

// ── the page's `## Tasks` section ────────────────────────────────────────────

function ownerLabel(t) {
  if (t.owner === "jori") return "Jori";
  if (t.owner === "other") return t.who || "someone else";
  return ownerFirstName();
}

function joriNote(t) {
  if (t.status !== "open") return "";
  const j = t.jori;
  if (j.state === "review" && j.result) return ` · Jori's ${j.result.kind || "work"} is ready for review${j.result.link ? ` (${j.result.link})` : ""}`;
  if (j.state === "working") return " · Jori is on it";
  if (j.mode === "autonomous") return " · Jori can do this";
  if (j.mode === "needs_ok") return j.approved_at ? " · Jori will do this (approved)" : " · Jori can do this with an OK";
  return "";
}

function renderTasksSection(ledger, projectId, { now = Date.now(), closedDays = 14 } = {}) {
  const d = today(now);
  const mine = Object.values(ledger.tasks).filter((t) => t.project === projectId);
  const open = mine.filter((t) => t.status === "open")
    .sort((a, b) => String(a.due || "9999").localeCompare(String(b.due || "9999")) || a.created_at.localeCompare(b.created_at));
  const closed = mine.filter((t) => t.status !== "open" && t.closed_at && daysBetween(t.closed_at.slice(0, 10), d) <= closedDays)
    .sort((a, b) => b.closed_at.localeCompare(a.closed_at));
  if (!open.length && !closed.length) return null;
  const lines = ["## Tasks"];
  for (const t of open) {
    const late = t.due && t.due < d ? " (overdue)" : "";
    lines.push(`- [ ] ${t.title} · ${ownerLabel(t)}${t.due ? ` · due ${t.due}${late}` : ""}${joriNote(t)} · ${t.id}`);
  }
  for (const t of closed) {
    lines.push(`- [${t.status === "done" ? "x" : "-"}] ${t.title} · ${t.status} ${t.closed_at.slice(0, 10)}${t.close_note ? ` (${t.close_note})` : ""} · ${t.id}`);
  }
  return lines.join("\n");
}

// Put the code-written `## Tasks` section into a block's sections: any `## Tasks`
// already there (an older render, or one a model copied) is replaced, and the
// fresh one goes right after `## What you might need`. Markdown structure only.
function injectTasks(section, tasksMd) {
  const chunks = [];
  for (const line of String(section || "").split("\n")) {
    if (line.startsWith("## ") || !chunks.length) chunks.push([line]);
    else chunks[chunks.length - 1].push(line);
  }
  const kept = chunks.filter((c) => c[0].trim() !== "## Tasks");
  if (tasksMd) {
    const i = kept.findIndex((c) => c[0].trim() === "## What you might need");
    const at = i === -1 ? kept.length : i + 1;
    kept.splice(at, 0, [...tasksMd.split("\n"), ""]);
  }
  return kept.map((c) => c.join("\n").replace(/\n+$/, "")).join("\n\n").trim(); // lang-regex-ok: trailing newlines of a markdown chunk
}

// ── Google Tasks sync ────────────────────────────────────────────────────────

function gtaskNotes(t, projectName) {
  const parts = [];
  if (t.why) parts.push(t.why);
  parts.push(`Project: ${projectName || t.project}`);
  parts.push(MARKER(t.id));
  return parts.join("\n\n");
}

function remoteDue(r) {
  return r && r.due ? String(r.due).slice(0, 10) : null;
}

function markerIn(notes) {
  const s = String(notes || "");
  const a = s.indexOf("[jori:pt-");
  if (a === -1) return null;
  const b = s.indexOf("]", a);
  return b === -1 ? null : s.slice(a + 6, b);
}

// Make the user's task list and the ledger agree. The user's side wins every
// disagreement it can express: completing or deleting a task closes it here,
// a new title or date is adopted. Jori's side is pushed only where the user has
// not touched the task since the last sync. Never deletes a task the user
// changed. `gt` is an adapter over gog (list/add/update/done/undo/delete).
function syncGoogle(ledger, gt, { list = "@default", projectNames = {}, now = Date.now(), dryRun = false } = {}) {
  const report = { created: [], closed_by_user: [], reopened_by_user: [], adopted_edits: [], pushed: [], completed: [], deleted: [], detached: [], relinked: [], errors: [] };
  const remote = new Map();
  for (const r of gt.list(list)) if (r && r.id && !r.deleted) remote.set(r.id, r);
  const byMarker = new Map();
  for (const r of remote.values()) { const m = markerIn(r.notes); if (m) byMarker.set(m, r); }
  const iso = new Date(now).toISOString();
  const snap = (t, r) => { t.gtask = { id: r.id, list, synced: { title: r.title, due: remoteDue(r), status: r.status }, synced_at: iso, detached: false }; };

  for (const t of Object.values(ledger.tasks)) {
    if (t.owner !== "user") continue;
    try {
      // Relink a task whose id we lost but whose marker is on the list.
      if (!t.gtask && byMarker.has(t.id)) { snap(t, byMarker.get(t.id)); report.relinked.push(t.id); }
      if (t.gtask && t.gtask.detached) continue;

      if (!t.gtask) {
        if (t.status !== "open") continue;
        if (dryRun) { report.created.push(t.id); continue; }
        const r = gt.add(list, { title: t.title, due: t.due, notes: gtaskNotes(t, projectNames[t.project]) });
        snap(t, r);
        report.created.push(t.id);
        continue;
      }

      const r = remote.get(t.gtask.id);
      const s = t.gtask.synced || {};
      if (!r) {
        // Gone from the list: the user deleted it (or Jori did, after a drop).
        if (t.status === "open") {
          t.status = "dropped"; t.closed_at = iso; t.closed_by = "user"; t.close_note = "deleted from the task list";
          report.closed_by_user.push(t.id);
        }
        t.gtask.detached = true;
        continue;
      }
      const touched = r.title !== s.title || remoteDue(r) !== s.due || r.status !== s.status;

      if (r.status === "completed" && s.status !== "completed" && t.status === "open") {
        t.status = "done"; t.closed_at = r.completed || iso; t.closed_by = "user"; t.close_note = "ticked off on the task list";
        snap(t, r); report.closed_by_user.push(t.id);
        continue;
      }
      if (r.status !== "completed" && s.status === "completed" && t.status !== "open") {
        t.status = "open"; t.closed_at = null; t.closed_by = null; t.close_note = null;
        if (remoteDue(r)) t.due = remoteDue(r);
        snap(t, r); report.reopened_by_user.push(t.id);
        continue;
      }

      if (t.status === "open") {
        if (touched && r.status !== "completed") {
          // The user edited it on their list: their title and date win.
          if (r.title && r.title !== t.title) t.title = r.title;
          const due = remoteDue(r);
          if (due && due !== t.due) {
            if (t.due && t.due < today(now) && due > t.due) t.slips.push({ due: t.due, moved_to: due, at: today(now), by: "user" });
            t.due = due;
          }
          snap(t, r); report.adopted_edits.push(t.id);
          continue;
        }
        if (t.title !== s.title || t.due !== s.due) {
          if (!dryRun) { const u = gt.update(list, r.id, { title: t.title, due: t.due }); snap(t, u || { ...r, title: t.title, due: t.due }); }
          report.pushed.push(t.id);
        }
        continue;
      }

      // Closed in the ledger and ticked off on the list too: just remember that.
      if (r.status === "completed") { if (s.status !== "completed") snap(t, r); continue; }
      // Closed in the ledger, still open on the list.
      {
        if (touched) {
          // The user changed it since Jori last wrote it: it is theirs now.
          t.gtask.detached = true; report.detached.push(t.id);
        } else if (t.status === "done") {
          if (!dryRun) { gt.done(list, r.id); snap(t, { ...r, status: "completed" }); }
          report.completed.push(t.id);
        } else {
          if (!dryRun) { gt.delete(list, r.id); t.gtask.detached = true; }
          report.deleted.push(t.id);
        }
      }
    } catch (e) {
      report.errors.push({ id: t.id, error: String(e.message || e).slice(0, 200) });
    }
  }
  return report;
}

// The gog adapter syncGoogle uses. Network + keychain: un-sandboxed only.
function gogTasksAdapter(gogJson) {
  const rows = (j) => (Array.isArray(j) ? j : (j && (j.tasks || j.items)) || []);
  const one = (j) => (Array.isArray(j) ? j[0] : (j && (j.task || j)) || null);
  return {
    list: (list) => rows(gogJson(["tasks", "list", list, "--show-completed", "--show-hidden", "--max", "100", "--all"])),
    add: (list, { title, due, notes }) => one(gogJson(["tasks", "add", list, "--title", title, ...(due ? ["--due", due] : []), ...(notes ? ["--notes", notes] : [])])),
    update: (list, id, { title, due }) => one(gogJson(["tasks", "update", list, id, "--title", title, "--due", due || ""])),
    done: (list, id) => one(gogJson(["tasks", "done", list, id])),
    delete: (list, id) => gogJson(["tasks", "delete", list, id, "--force"]),
  };
}

// What the nightly bundle carries about the ledger.
function bundleView(ledger, projects, { now = Date.now(), cfg = {} } = {}) {
  const d = today(now);
  const tasks = Object.values(ledger.tasks).filter((t) => t.status === "open"
    || (t.closed_at && daysBetween(t.closed_at.slice(0, 10), d) <= 14))
    .map((t) => ({ id: t.id, project: t.project, title: t.title, owner: t.owner, who: t.who, due: t.due, status: t.status,
      why: t.why, closed_at: t.closed_at, closed_by: t.closed_by, close_note: t.close_note, slips: t.slips.length,
      jori: { mode: t.jori.mode, size: t.jori.size, state: t.jori.state, approved: !!t.jori.approved_at, attempts: t.jori.attempts, result: t.jori.result },
      on_task_list: !!(t.gtask && !t.gtask.detached) }));
  return {
    tasks,
    slipped: slipped(ledger, { now, nudgeEveryDays: cfg.nudge_every_days || 7 }),
    deep_review: deepReviewList(projects, ledger, { n: cfg.deep_reviews_per_night || 5, now }),
    work_budget: workBudget({ now, cap: cfg.work_weekly_share ?? 0.05 }),
  };
}

module.exports = {
  OWNERS, JORI_MODES, SIZES, WORK_KINDS, MARKER,
  ledgerPath, load, save, withLock, emptyLedger, today, isDay,
  addTask, updateTask, closeTask, reopenTask, getTask,
  slipped, markNudged, deepReviewList,
  workQueue, approveWork, startWork, recordWork, workBudget,
  renderTasksSection, injectTasks,
  syncGoogle, gogTasksAdapter, markerIn, gtaskNotes, bundleView,
};
