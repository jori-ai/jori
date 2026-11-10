// project-tasks: the ledger, the Google Tasks sync rules, slips, the page section, Jori's work queue.
// Run: node --test plugins/projects/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pt = require(path.join(DIR, "lib", "project-tasks.js"));

const NOW = Date.parse("2026-11-10T15:00:00Z");
const DAY = 864e5;

function fresh() {
  return pt.emptyLedger();
}

// A Google Tasks list in memory, shaped like gog's JSON.
function fakeList(rows = []) {
  const items = new Map(rows.map((r) => [r.id, { status: "needsAction", ...r }]));
  let n = 0;
  const calls = [];
  return {
    items, calls,
    list: () => [...items.values()],
    add: (_l, { title, due, notes }) => { const id = `g${++n}`; const r = { id, title, due: due ? `${due}T00:00:00.000Z` : undefined, notes, status: "needsAction" }; items.set(id, r); calls.push(["add", title]); return r; },
    update: (_l, id, { title, due }) => { const r = { ...items.get(id), title, due: `${due}T00:00:00.000Z` }; items.set(id, r); calls.push(["update", id]); return r; },
    done: (_l, id) => { items.get(id).status = "completed"; calls.push(["done", id]); },
    delete: (_l, id) => { items.delete(id); calls.push(["delete", id]); },
  };
}

test("a task for the user needs a date; Jori's tasks need a work mode; duplicates are refused", () => {
  const l = fresh();
  assert.throws(() => pt.addTask(l, { project: "project_x", title: "Book the restaurant", owner: "user" }), /due/);
  const t = pt.addTask(l, { project: "project_x", title: "Book the restaurant for the anniversary", owner: "user", due: "2027-02-01", why: "(gap)" }, { now: NOW });
  assert.match(t.id, /^pt-[0-9a-f]{6}$/);
  assert.equal(t.jori.mode, "no");
  assert.throws(() => pt.addTask(l, { project: "project_x", title: "book the restaurant for the anniversary ", owner: "user", due: "2027-02-01" }), /already open/);
  const j = pt.addTask(l, { project: "project_x", title: "Draft the menu options", owner: "jori", size: "small", due: "2026-11-12" }, { now: NOW });
  assert.equal(j.jori.mode, "autonomous");
  assert.throws(() => pt.addTask(l, { project: "project_x", title: "Y", owner: "jori", jori: "no", due: "2026-11-12" }), /autonomous or needs_ok/);
  assert.throws(() => pt.addTask(l, { project: "project_x", title: "Undated", owner: "jori" }), /every task has a date/);
  assert.throws(() => pt.addTask(l, { project: "project_x", title: "Z", owner: "other", due: "2026-11-12" }), /who/);
});

test("sync puts a new user task on the list with its date and the marker; Jori's own tasks stay off it", () => {
  const l = fresh();
  const t = pt.addTask(l, { project: "project_x", title: "Get movie tickets for the family weekend", owner: "user", due: "2026-11-14", why: "Family chat" }, { now: NOW });
  pt.addTask(l, { project: "project_x", title: "Draft plan", owner: "jori", due: "2026-11-12" }, { now: NOW });
  const g = fakeList();
  const r = pt.syncGoogle(l, g, { projectNames: { project_x: "Family weekend" }, now: NOW });
  assert.deepEqual(r.created, [t.id]);
  const row = [...g.items.values()][0];
  assert.equal(row.title, "Get movie tickets for the family weekend");
  assert.equal(row.due.slice(0, 10), "2026-11-14");
  assert.ok(row.notes.includes(`[jori:${t.id}]`) && row.notes.includes("Project: Family weekend"));
  // A second run changes nothing.
  const again = pt.syncGoogle(l, g, { now: NOW });
  assert.equal(g.calls.length, 1);
  assert.equal(again.created.length + again.pushed.length, 0);
});

test("the user's side wins: ticking off closes, deleting drops, editing title or date is adopted", () => {
  const l = fresh();
  const a = pt.addTask(l, { project: "p", title: "A", owner: "user", due: "2026-11-12" }, { now: NOW });
  const b = pt.addTask(l, { project: "p", title: "B", owner: "user", due: "2026-11-12" }, { now: NOW });
  const c = pt.addTask(l, { project: "p", title: "C", owner: "user", due: "2026-11-05" }, { now: NOW });
  const g = fakeList();
  pt.syncGoogle(l, g, { now: NOW });
  g.items.get(a.gtask.id).status = "completed";
  g.items.delete(b.gtask.id);
  g.items.get(c.gtask.id).title = "C, but at the hotel";
  g.items.get(c.gtask.id).due = "2026-11-20T00:00:00.000Z";
  const r = pt.syncGoogle(l, g, { now: NOW });
  assert.deepEqual(r.closed_by_user.sort(), [a.id, b.id].sort());
  assert.equal(l.tasks[a.id].status, "done");
  assert.equal(l.tasks[a.id].closed_by, "user");
  assert.equal(l.tasks[b.id].status, "dropped");
  assert.deepEqual(r.adopted_edits, [c.id]);
  assert.equal(l.tasks[c.id].title, "C, but at the hotel");
  assert.equal(l.tasks[c.id].due, "2026-11-20");
  assert.equal(l.tasks[c.id].slips.length, 1, "moving an overdue date later counts as a slip");
  // Un-ticking it on the list reopens it.
  g.items.get(a.gtask.id).status = "needsAction";
  const r2 = pt.syncGoogle(l, g, { now: NOW });
  assert.deepEqual(r2.reopened_by_user, [a.id]);
  assert.equal(l.tasks[a.id].status, "open");
});

test("Jori's changes are pushed only while the user hasn't touched the task; a drop deletes only an untouched task", () => {
  const l = fresh();
  const a = pt.addTask(l, { project: "p", title: "A", owner: "user", due: "2026-11-12" }, { now: NOW });
  const b = pt.addTask(l, { project: "p", title: "B", owner: "user", due: "2026-11-12" }, { now: NOW });
  const c = pt.addTask(l, { project: "p", title: "C", owner: "user", due: "2026-11-12" }, { now: NOW });
  const d = pt.addTask(l, { project: "p", title: "D", owner: "user", due: "2026-11-12" }, { now: NOW });
  const g = fakeList();
  pt.syncGoogle(l, g, { now: NOW });
  pt.updateTask(l, a.id, { due: "2026-11-15" }, { now: NOW });
  pt.closeTask(l, b.id, { status: "done", note: "tickets in the inbox", by: "dream" });
  pt.closeTask(l, c.id, { status: "dropped", note: "not needed any more" });
  pt.closeTask(l, d.id, { status: "dropped", note: "not needed any more" });
  g.items.get(d.gtask.id).title = "D (mine now)";
  const r = pt.syncGoogle(l, g, { now: NOW });
  assert.deepEqual(r.pushed, [a.id]);
  assert.equal(g.items.get(a.gtask.id).due.slice(0, 10), "2026-11-15");
  assert.deepEqual(r.completed, [b.id]);
  assert.equal(g.items.get(b.gtask.id).status, "completed");
  assert.deepEqual(r.deleted, [c.id]);
  assert.ok(!g.items.has(c.gtask.id));
  assert.deepEqual(r.detached, [d.id]);
  assert.ok(g.items.has(d.gtask.id), "a task the user changed is never deleted");
  const r2 = pt.syncGoogle(l, g, { now: NOW });
  assert.equal(Object.values(r2).reduce((n, v) => n + v.length, 0), 0, "settled: nothing more to do");
});

test("a lost link is recovered from the marker in the task's notes", () => {
  const l = fresh();
  const a = pt.addTask(l, { project: "p", title: "A", owner: "user", due: "2026-11-12" }, { now: NOW });
  const g = fakeList([{ id: "g9", title: "A", due: "2026-11-12T00:00:00.000Z", notes: `x\n\n[jori:${a.id}]` }]);
  const r = pt.syncGoogle(l, g, { now: NOW });
  assert.deepEqual(r.relinked, [a.id]);
  assert.equal(r.created.length, 0);
  assert.equal(pt.markerIn(`Project: P\n\n[jori:${a.id}]`), a.id);
});

test("slipped lists the user's overdue tasks, once a week each", () => {
  const l = fresh();
  const late = pt.addTask(l, { project: "p", title: "Late", owner: "user", due: "2026-11-08" }, { now: NOW });
  pt.addTask(l, { project: "p", title: "Not yet", owner: "user", due: "2026-11-11" }, { now: NOW });
  pt.addTask(l, { project: "p", title: "Jori's", owner: "jori", due: "2026-11-01" }, { now: NOW });
  const s = pt.slipped(l, { now: NOW });
  assert.deepEqual(s.map((x) => x.id), [late.id]);
  assert.equal(s[0].days_late, 2);
  pt.markNudged(l, late.id, { now: NOW });
  assert.ok(!pt.slipped(l, { now: NOW + 3 * DAY }).some((x) => x.id === late.id), "followed up 3 days ago: not yet");
  assert.ok(pt.slipped(l, { now: NOW + 7 * DAY }).some((x) => x.id === late.id), "a week later: again");
});

test("the page's Tasks section is written by code and goes after What you might need", () => {
  const l = fresh();
  pt.addTask(l, { project: "p", title: "Book the restaurant for the anniversary", owner: "user", due: "2027-02-01" }, { now: NOW });
  const j = pt.addTask(l, { project: "p", title: "Shortlist restaurants", owner: "jori", size: "small", due: "2026-11-12" }, { now: NOW });
  pt.recordWork(l, j.id, { kind: "doc", link: "https://docs.example/1", summary: "Six places" }, { now: NOW });
  const md = pt.renderTasksSection(l, "p", { now: NOW });
  assert.match(md, /^## Tasks\n- \[ \] Shortlist restaurants · Jori · due 2026-11-12/);
  assert.match(md, /\n- \[ \] Book the restaurant for the anniversary · \S+ · due 2027-02-01 · pt-/);
  assert.ok(md.includes("Jori's doc is ready for review (https://docs.example/1)"));
  const section = "## Goal\nG\n\n## What you might need\n- x\n\n## Tasks\n- stale\n\n## Coming up\n- y";
  const out = pt.injectTasks(section, md);
  assert.equal(out.split("## Tasks").length, 2);
  assert.ok(!out.includes("- stale"));
  assert.ok(out.indexOf("## What you might need") < out.indexOf("## Tasks") && out.indexOf("## Tasks") < out.indexOf("## Coming up"));
  assert.equal(pt.injectTasks(out, md), out, "idempotent");
  assert.equal(pt.renderTasksSection(l, "other", { now: NOW }), null);
});

test("work queue: Jori's own tasks and approved ones, once a night, two attempts at most", () => {
  const l = fresh();
  const a = pt.addTask(l, { project: "p", title: "Draft A", owner: "jori", size: "small", due: "2026-11-12" }, { now: NOW });
  const b = pt.addTask(l, { project: "p", title: "Email the contractor", owner: "user", due: "2026-11-20", jori: "needs_ok" }, { now: NOW });
  assert.deepEqual(pt.workQueue(l, { now: NOW }).map((t) => t.id), [a.id]);
  assert.throws(() => pt.approveWork(l, b.id, {}), /quote/);
  pt.approveWork(l, b.id, { quote: "yes, draft it" }, { now: NOW });
  assert.deepEqual(pt.workQueue(l, { now: NOW }).map((t) => t.id), [b.id, a.id], "approved work first");
  pt.startWork(l, a.id, { now: NOW });
  assert.ok(!pt.workQueue(l, { now: NOW }).some((t) => t.id === a.id), "not while working");
  pt.recordWork(l, a.id, { failed: true, summary: "tests failed" }, { now: NOW });
  assert.ok(!pt.workQueue(l, { now: NOW }).some((t) => t.id === a.id), "not again the same night");
  assert.ok(pt.workQueue(l, { now: NOW + DAY }).some((t) => t.id === a.id), "tried again the next night");
  pt.startWork(l, a.id, { now: NOW + DAY });
  pt.recordWork(l, a.id, { failed: true, summary: "again" }, { now: NOW + DAY });
  assert.ok(!pt.workQueue(l, { now: NOW + 2 * DAY }).some((t) => t.id === a.id), "two attempts, then it waits for a person");
});

test("work budget sums the lane's fork costs over 7 days against the allowance", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
  const f = path.join(dir, "job-costs.ndjson");
  const row = (ts, source, usd) => JSON.stringify({ ts: new Date(ts).toISOString(), source, total_cost_usd: usd });
  fs.writeFileSync(f, [row(NOW - DAY, "project-work", 28), row(NOW - 2 * DAY, "project-work", 14), row(NOW - 9 * DAY, "project-work", 500), row(NOW, "chat-build", 99)].join("\n"));
  const b = pt.workBudget({ now: NOW, cap: 0.1, ledgerFile: f });
  assert.equal(b.runs, 2);
  assert.equal(b.spent_usd, 42);
  assert.equal(b.over, false);
  assert.ok(b.share > 0 && b.share < 0.1);
});

test("the ledger file round-trips under the lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
  const file = path.join(dir, "tasks.json");
  const t = pt.withLock((l) => pt.addTask(l, { project: "p", title: "A", owner: "user", due: "2026-11-12" }), file);
  assert.equal(pt.load(file).tasks[t.id].title, "A");
  assert.ok(!fs.existsSync(`${file}.lock`));
});

test("a page title keeps an amount off the page while the user's list keeps their words", () => {
  const l = pt.emptyLedger();
  const t = pt.addTask(l, { project: "p", title: "Move $2k into the safe", owner: "user", due: "2026-11-17", page_title: "Move cash into the safe" }, { now: NOW });
  const md = pt.renderTasksSection(l, "p", { now: NOW });
  assert.ok(md.includes("Move cash into the safe") && !md.includes("$2k"));
  assert.equal(l.tasks[t.id].title, "Move $2k into the safe");
  pt.updateTask(l, t.id, { page_title: "" }, { now: NOW });
  assert.ok(pt.renderTasksSection(l, "p", { now: NOW }).includes("$2k"));
});
