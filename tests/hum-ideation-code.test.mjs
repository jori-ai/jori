// hum-ideation's bookkeeping in code (2026-10-04): the scorecard, the single
// ideas writer (schema + Rules 9/12 + claim-check plumbing), and the slot gate.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildScorecard } from "../lib/hum-ideas-scorecard.mjs";
// The agent's own address (what materialKeys skips) is set before the module
// loads, so normal and fresh installs test the same thing.
process.env.JORI_AGENT_FROM_EMAIL = "agent@example.com";
process.env.JORI_AGENT_EMAIL_ALIASES = "agent-old@example.com";
const { quietRsvp, replyClosedTasks, markReplyClosed, materialKeys } = await import("../bin/hum-ideation-prefetch");
import { claimCheckText } from "../bin/hum-ideas-append";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "hum-ideation-")); dirs.push(d); return d; };
const NOW = Date.parse("2026-10-04T18:00:00Z");
const hAgo = (h) => new Date(NOW - h * 3600e3).toISOString();

test("scorecard joins reactions to consumed ideas and applies the formula", () => {
  const ideas = new Map([
    ["i1", { id: "i1", category: "taste-match", idea_lens: "combine", ping_id: "p1" }],
    ["i2", { id: "i2", category: "taste-match", idea_lens: "adapt", ping_id: "p2" }],
    ["i3", { id: "i3", category: "stuck-task", ping_id: "p3" }],
  ]);
  const fb = [
    { ping_id: "p1", sent_at: hAgo(10), reaction: "more" },
    { ping_id: "p2", sent_at: hAgo(10), reaction: "helpful" },
    { ping_id: "p3", sent_at: hAgo(10), reaction: null },
    { ping_id: "p9", sent_at: hAgo(10), reaction: "skip" }, // not an idea ping
    { ping_id: "p1", sent_at: hAgo(24 * 40), reaction: "skip" }, // outside 30d
  ];
  const sc = buildScorecard(ideas, fb, NOW);
  assert.deepEqual({ sent: sc.by_category["taste-match"].sent, more: sc.by_category["taste-match"].more, up: sc.by_category["taste-match"].up }, { sent: 2, more: 1, up: 1 });
  assert.equal(sc.by_category["taste-match"].score, Number(((1.2 + 0.6) / 3).toFixed(3)));
  assert.equal(sc.by_category["stuck-task"].silent, 1);
  assert.ok(sc.by_category_lens["taste-match×combine"]);
  assert.equal(sc.top[0].category, "taste-match");
});

test("scorecard flags a mostly-silent category", () => {
  const ideas = new Map(), fb = [];
  for (let i = 0; i < 6; i++) { ideas.set(`i${i}`, { id: `i${i}`, category: "family", ping_id: `p${i}` }); fb.push({ ping_id: `p${i}`, sent_at: hAgo(12), reaction: null }); }
  assert.equal(buildScorecard(ideas, fb, NOW).rejected_patterns[0].pattern, "category:family mostly silent");
});

const good = (over = {}) => ({
  id: "idea-20261004-x", subject: "Gallery closing Sunday", rationale: "matches taste", why_now: "closes Oct 6",
  category: "seasonal-closing", idea_lens: "reverse", urgency: 0.6, time_sensitive_until: null,
  draws_on: ["websearch"], supporting_data: {}, confidence: "high", ...over,
});
function append(dir, ideas, extra = []) {
  return spawnSync(process.execPath, [path.join(HERE, "../bin/hum-ideas-append"), "--no-claim-check", ...extra], {
    input: ideas.map((i) => JSON.stringify(i)).join("\n"), encoding: "utf8",
    env: { ...process.env, JORI_DATA_DIR: dir, HUM_IDEAS_NO_EMBED: "1" },
  });
}

test("hum-ideas-append writes valid ideas and refuses schema, id, task and thread violations", () => {
  const d = mk();
  fs.writeFileSync(path.join(d, "hum-ideas.jsonl"), JSON.stringify({ id: "idea-old" }) + "\n");
  fs.writeFileSync(path.join(d, "hum-ideas-digest.json"), JSON.stringify({ task_ids_blocked: ["T1"], unconsumed_thread_ids: ["TH1"], unconsumed: [] }));
  fs.writeFileSync(path.join(d, "hum-resolved-topics.jsonl"), JSON.stringify({ task_id: "T2", suppress_until: new Date(Date.now() + 3600e3).toISOString() }) + "\n");
  const r = append(d, [
    good(),
    good({ id: "idea-old" }),
    good({ id: "idea-bad", category: "nope", confidence: "low" }),
    good({ id: "idea-task", draws_on: ["tasks"], supporting_data: { task_id: "T1" } }),
    good({ id: "idea-res", draws_on: ["tasks"], supporting_data: { task_id: "T2" } }),
    good({ id: "idea-thr", supporting_data: { gmail_thread_id: "TH1" } }),
    good({ id: "idea-notask", draws_on: ["tasks"] }),
  ]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.written, ["idea-20261004-x"]);
  const rules = Object.fromEntries(out.rejected.map((x) => [x.id, x.rule]));
  assert.deepEqual(rules, { "idea-old": "duplicate-id", "idea-bad": "schema", "idea-task": "rule-9-task-id", "idea-res": "rule-9-task-id", "idea-thr": "rule-12-thread-id", "idea-notask": "schema" });
  const lines = fs.readFileSync(path.join(d, "hum-ideas.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].consumed, false);
});

test("hum-ideas-append --dry-run writes nothing", () => {
  const d = mk();
  const r = append(d, [good()], ["--dry-run"]);
  assert.deepEqual(JSON.parse(r.stdout).written, ["idea-20261004-x"]);
  assert.ok(!fs.existsSync(path.join(d, "hum-ideas.jsonl")));
});

function gate(dir, env = {}) {
  const r = spawnSync(process.execPath, [path.join(HERE, "../bin/hum-ideation-prefetch")], {
    encoding: "utf8", env: { ...process.env, JORI_DATA_DIR: dir, HUM_IDEATION_NO_FETCH: "1", ...env },
  });
  return JSON.parse(r.stdout);
}

test("slot gate: thin inventory runs; healthy + unchanged skips; a change runs again", () => {
  const d = mk();
  const live = [];
  for (let c = 0; c < 5; c++) for (let i = 0; i < 6; i++) live.push({ id: `i-${c}-${i}`, category: `cat${c}` });
  fs.writeFileSync(path.join(d, "hum-ideas-digest.json"), JSON.stringify({ unconsumed: live.slice(0, 4) }));
  assert.equal(gate(d).decision, "run");
  fs.writeFileSync(path.join(d, "hum-ideas-digest.json"), JSON.stringify({ unconsumed: live }));
  assert.equal(gate(d).decision, "skip"); // healthy, nothing new (the reservoir's own churn is not an input)
  assert.equal(gate(d).decision, "skip");
  fs.writeFileSync(path.join(d, "hum-ideation-tasks.txt"), "new task\n");
  const r = gate(d);
  assert.equal(r.decision, "run");
  assert.match(r.reason, /task 1/);
  assert.equal(gate(d).decision, "skip");
  assert.ok(fs.existsSync(path.join(d, "hum-ideation-context.json")));
});

test("slot gate: a state file from before the seen set runs once, then gates", () => {
  const d = mk();
  const live = [];
  for (let c = 0; c < 5; c++) for (let i = 0; i < 6; i++) live.push({ id: `i-${c}-${i}`, category: `cat${c}` });
  fs.writeFileSync(path.join(d, "hum-ideas-digest.json"), JSON.stringify({ unconsumed: live }));
  fs.writeFileSync(path.join(d, "hum-ideation-last-input.json"), JSON.stringify({ hash: "abc", at: "2026-10-19T23:00:00.000Z" }));
  const r = gate(d);
  assert.equal(r.decision, "run");
  assert.match(r.reason, /no seen set/);
  assert.equal(gate(d).decision, "skip");
});

test("materialKeys: noise is not new, real arrivals are", () => {
  const ev = (o) => ({ id: "e1", summary: "Dinner", start: { dateTime: "2026-10-22T19:00:00-04:00" }, etag: "1", updated: "a", ...o });
  const tasksHead = "ID\tTITLE\tSTATUS\tDUE\tUPDATED\n";
  const base = {
    calendar_14d: { events: [ev(), { id: "weekly_20261103", recurringEventId: "weekly", summary: "Weekly 1:1", start: { dateTime: "2026-11-03T17:30:00-05:00" } }] },
    p1_threads: [
      { id: "t-ext", from: "Insurer <a@insurer.example>", messageCount: 1, labels: ["p1", "UNREAD"] },
      { id: "t-g", from: "Jori <agent-old@example.com>", messageCount: 1, labels: ["p1"] },
    ],
    flights: [{ code: "LY1" }], trip_history: { a: 1 }, context: { built_at: "x", profile: {} }, reply_closed_tasks: [],
  };
  const tasks = tasksHead + "T1\tSend docs\tneedsAction\t2026-10-21\t2026-10-19T10:00:00Z\n";
  const k0 = new Set(materialKeys(base, tasks));
  const fresh = (ctx, tk = tasks) => materialKeys(ctx, tk).filter((k) => !k0.has(k));
  // Noise: etag/updated churn, an attendee reply, labels, a new recurring instance, a new unanswered Jori digest,
  // an event ending out of the window, the UPDATED column, context timestamps.
  const noisy = structuredClone(base);
  noisy.calendar_14d.events[0].etag = "2"; noisy.calendar_14d.events[0].updated = "b";
  noisy.calendar_14d.events[0].attendees = [{ email: "x@y", responseStatus: "accepted" }];
  noisy.calendar_14d.events.push({ id: "weekly_20261104", recurringEventId: "weekly", summary: "Weekly 1:1", start: { dateTime: "2026-11-04T17:30:00-05:00" } });
  noisy.p1_threads[0].labels = ["p1"];
  noisy.p1_threads.push({ id: "t-g2", from: "Jori <agent@example.com>", messageCount: 1 });
  noisy.context.built_at = "y";
  assert.deepEqual(fresh(noisy, tasks.replace("2026-10-19T10:00:00Z", "2026-10-20T01:00:00Z")), []);
  const ended = structuredClone(base); ended.calendar_14d.events.shift();
  assert.deepEqual(fresh(ended), []);
  // Real arrivals.
  const moved = structuredClone(base); moved.calendar_14d.events[0].start.dateTime = "2026-10-22T20:00:00-04:00";
  assert.equal(fresh(moved).length, 1);
  const added = structuredClone(base); added.calendar_14d.events.push(ev({ id: "e2", summary: "Show" }));
  assert.equal(fresh(added).length, 1);
  const replied = structuredClone(base); replied.p1_threads[1].messageCount = 2;
  assert.equal(fresh(replied).length, 1);
  const ext = structuredClone(base); ext.p1_threads.push({ id: "t-new", from: "Vendor <s@vendor.example>", messageCount: 1 });
  assert.equal(fresh(ext).length, 1);
  assert.equal(fresh(base, tasks.replace("needsAction", "completed")).length, 1);
  const fl = structuredClone(base); fl.flights.push({ code: "LY2" });
  assert.equal(fresh(fl).length, 1);
  const rc = structuredClone(base); rc.reply_closed_tasks = [{ task_id: "T1" }];
  assert.equal(fresh(rc).length, 1);
  const placed = structuredClone(base); placed.calendar_14d.events[0].location = "City Stadium";
  assert.equal(fresh(placed).length, 1);
  const movedInstance = structuredClone(base);
  Object.assign(movedInstance.calendar_14d.events[1], { start: { dateTime: "2026-11-03T19:00:00-05:00" }, originalStartTime: { dateTime: "2026-11-03T17:30:00-05:00" } });
  assert.equal(fresh(movedInstance).length, 1);
  const onSlot = structuredClone(base); onSlot.calendar_14d.events[1].originalStartTime = { dateTime: "2026-11-03T22:30:00Z" };
  assert.deepEqual(fresh(onSlot), []); // same instant, different offset
  const spoof = structuredClone(base); spoof.p1_threads.push({ id: "t-s", from: "agent@example.com <x@evil.example>", messageCount: 1 });
  assert.equal(fresh(spoof).length, 1);
  // A failed source contributes nothing rather than throwing.
  assert.deepEqual(materialKeys({ calendar_14d: { error: "x" }, p1_threads: { error: "y" }, context: { error: "z" } }, ""), []);
});

test("prefetch: an FYI attendee's unanswered invite is scrubbed, a real answer and everyone else are kept", () => {
  const FYI = ["fyi.partner@example.com"];
  const cal = { events: [
    { summary: "JOURNEY 2026 Conference", attendees: [
      { email: "fyi.partner@example.com", responseStatus: "needsAction" },
      { email: "owner@example.com", organizer: true, self: true, responseStatus: "accepted" },
    ] },
    { summary: "Dinner with friends", attendees: [{ email: "fyi.partner@example.com", organizer: true, responseStatus: "accepted" }] },
    { summary: "Show", attendees: [{ email: "FYI.Partner@example.com", responseStatus: "declined" }] },
    { summary: "Call with Michael", attendees: [{ email: "michael@example.com", responseStatus: "needsAction" }] },
    { summary: "No attendees" },
  ] };
  const out = quietRsvp(cal, FYI);
  const [journey, dinner, show, call] = out.events;
  assert.equal(journey.attendees[0].responseStatus, undefined);
  assert.match(journey.attendees[0].rsvp, /not a signal/);
  assert.equal(journey.attendees[1].responseStatus, "accepted");
  assert.equal(dinner.attendees[0].responseStatus, "accepted");
  assert.equal(show.attendees[0].responseStatus, "declined");
  assert.equal(call.attendees[0].responseStatus, "needsAction");
  assert.deepEqual(quietRsvp({ error: "exit 1" }, FYI), { error: "exit 1" });
  assert.equal(quietRsvp(null, FYI), null);
  // No configured FYI attendees: nothing is touched.
  const untouched = { events: [{ attendees: [{ email: "fyi.partner@example.com", responseStatus: "needsAction" }] }] };
  assert.equal(quietRsvp(untouched, []).events[0].attendees[0].responseStatus, "needsAction");
});

test("prefetch: a task the reply sweep closed is marked closed-by-reply, not read as done", () => {
  // A 'send missing docs' task was closed by p1-reply-sweep on a reply that
  // asked questions back; three ideas then assumed the documents had gone in.
  const now = Date.parse("2026-10-11T10:00:00Z");
  const lines = [
    JSON.stringify({ ts: "2026-10-11T08:15:07.035Z", source: "reply", success: true, subject: "Insurance case", from: "crm@insurer.example",
      task: { closed: [{ id: "T1", title: "Policy transfer: send missing docs" }] } }),
    JSON.stringify({ ts: "2026-10-11T08:20:00Z", source: "unstar-scan", success: true, task: { closed: [{ id: "T2", title: "unstarred" }] } }),
    JSON.stringify({ ts: "2026-09-01T08:15:00Z", source: "reply", success: true, task: { closed: [{ id: "T3", title: "too old" }] } }),
    JSON.stringify({ ts: "2026-10-11T08:30:00Z", source: "reply", success: true, task: { closed: [] } }),
    "",
    "not json",
  ];
  const got = replyClosedTasks(lines, now);
  assert.deepEqual(got.map((t) => t.task_id), ["T1"]);
  assert.equal(got[0].closed_at, "2026-10-11T08:15:07.035Z");
  assert.equal(got[0].from, "crm@insurer.example");

  const tsv = "ID\tTITLE\tSTATUS\tDUE\tUPDATED\n"
    + "T1\tPolicy transfer: send missing docs\tcompleted\t2026-10-11T00:00:00.000Z\t2026-10-11T08:15:06.978Z\n"
    + "T2\tunstarred\tcompleted\t\t2026-10-11T08:20:00Z\n"
    + "T4\treopened since\tneedsAction\t\t2026-10-11T09:00:00Z\n";
  const out = markReplyClosed(tsv, new Set(["T1", "T4"]));
  const rows = out.split("\n").map((l) => l.split("\t"));
  assert.equal(rows[1][2], "closed-by-reply");
  assert.equal(rows[2][2], "completed"); // closed some other way: untouched
  assert.equal(rows[3][2], "needsAction"); // reopened since: untouched
  assert.equal(markReplyClosed(out, new Set(["T1"])), out); // idempotent
  assert.equal(markReplyClosed("new task\n", new Set(["T1"])), "new task\n"); // no header: untouched

  const d = mk();
  fs.writeFileSync(path.join(d, "p1-resolutions.jsonl"), JSON.stringify({ ts: new Date().toISOString(), source: "reply", success: true,
    task: { closed: [{ id: "T1", title: "Policy transfer: send missing docs" }] } }) + "\n");
  fs.writeFileSync(path.join(d, "hum-ideation-tasks.txt"), tsv);
  gate(d);
  assert.equal(fs.readFileSync(path.join(d, "hum-ideation-tasks.txt"), "utf8").split("\n")[1].split("\t")[2], "closed-by-reply");
  const ctx = JSON.parse(fs.readFileSync(path.join(d, "hum-ideation-context.json"), "utf8"));
  assert.deepEqual(ctx.reply_closed_tasks.map((t) => t.task_id), ["T1"]);
});

test("claim-check text keeps subject, rationale and why_now as separate sentences", () => {
  // "...airport pickup 7am" + "Oct 12 has the day trip" read as
  // "airport pickup 7am Oct 12" and a true idea was rewritten three times.
  const text = claimCheckText({
    subject: "Oct 12 into Oct 13 is a short night: late call 11pm, then airport pickup 7am",
    rationale: "Oct 12 has the day trip 9am-5pm, then the call at 11pm local time.",
    why_now: "The call is four days out",
  });
  assert.equal(text, "Oct 12 into Oct 13 is a short night: late call 11pm, then airport pickup 7am. Oct 12 has the day trip 9am-5pm, then the call at 11pm local time. The call is four days out.");
  assert.ok(!text.includes("7am Oct 12"));
  // A field that already ends a sentence is left alone.
  assert.equal(
    claimCheckText({ subject: "Cancel the analytics trial is due Oct 15 -- is that the billing day?", rationale: "A new task.", why_now: "Due within a week!" }),
    "Cancel the analytics trial is due Oct 15 -- is that the billing day? A new task. Due within a week!",
  );
});
