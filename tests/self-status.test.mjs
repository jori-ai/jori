// lib/self-status.mjs — the work snapshot every agent reads before talking
// about its own state. Fixture install in a temp dir; no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collect, render, parseDispatchLog, cronFailures, codeReloadHolds, purchaseQueueItems, purchaseApprovalItems } from "../lib/self-status.mjs";

const NOW = Date.parse("2026-03-10T15:00:00Z");
const iso = (minAgo) => new Date(NOW - minAgo * 60e3).toISOString();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-status-"));
  const w = (rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body)); return f; };
  w("agent/logs/ops-supervisor.log", [
    `${iso(300)} [supervisor] disp aaaaaa → nightly-report: NIGHTLY REPORT — follow jobs/nightly-report.md...`,
    `${iso(298)} [supervisor] disp aaaaaa done nightly-report 120000ms $0.4100 turns=7`,
    `${iso(200)} [supervisor] disp bbbbbb → purchase: PURCHASE — buy the thing...`,
    `${iso(120)} [supervisor] disp cccccc → webhook: something...`,
    `${iso(119)} [supervisor] disp cccccc error webhook: session exited`,
    `${iso(3)} [supervisor] disp dddddd → purchase: PURCHASE — second try...`,
  ].join("\n") + "\n");
  w("data/dispatcher-queue.json", { queue: [{ id: "eeeeee11", source: "hum", enqueuedAt: NOW - 60e3 }], inFlight: null });
  w("data/purchases/queue.json", [
    { id: "pq_old", asked: "a cable", site: "example-store.com", status: "placed", queued_at: iso(5000), done_at: iso(4990) },
    { id: "pq_1", asked: "book the compact car", site: "example-rentals.com", status: "needs_card", queued_at: iso(90), claimed_at: iso(89), done_at: iso(80) },
    { id: "pq_2", asked: "book the compact car again", site: "example-rentals.com", status: "in_progress", queued_at: iso(4), claimed_at: iso(3) },
  ]);
  w("data/build-queue/held/20260310-140000-1.json", { id: "20260310-140000-1", spec: "Fix the card step", size: "large", requested_at: iso(60) });
  w("data/build-queue/pending/20260310-145500-2.json", { id: "20260310-145500-2", spec: "Add a setting", size: "small", requested_at: iso(5) });
  w("data/build-queue/done/20260310-100000-3.json", { id: "20260310-100000-3", spec: "Old build" });
  w("data/build-queue/results/20260310-100000-3.md", "# Result\n\nShipped the setting in commit abc123.\n");
  w("agent/logs/chat-build.log", "2026-03-10 10:00:00 20260310-140000-1: held by the allowance governor: week on pace to run out\n");
  w("data/jobs/j1.json", { id: "j1", name: "daily-report", status: "running", started_at: iso(10) });
  w("data/jobs/j2.json", { id: "j2", name: "backfill", status: "lost", started_at: iso(200), finished_at: iso(100) });
  w("data/cron-runs.jsonl", [
    { label: "good-job", start: iso(30), end: iso(29), exit: 0 },
    { label: "bad-job", start: iso(20), end: iso(19), exit: 1 },
    { label: "bad-job", start: iso(10), end: iso(9), exit: 2 },
    { label: "recovered", start: iso(20), end: iso(19), exit: 1 },
    { label: "recovered", start: iso(10), end: iso(9), exit: 0 },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  // watchdog.log: host-local time, no zone.
  const local = (d) => { const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  w("agent/logs/watchdog.log", `${local(new Date(NOW - 5 * 60e3))} [supervisor-code-reload] ops-light: stale, holding (active 8 min ago)\n${local(new Date(NOW - 4 * 60e3))} [supervisor-code-reload] ops: fresh\n`);
  w("data/role-queue/pending/x.json", { message_id: "m1", conversation_id: "role:cfo", roles: ["cfo"], created_at: iso(2) });
  return root;
}

const health = (inflight) => async (url) => {
  if (url.includes(":9093/")) return { childAlive: true, model: "m", queueDepth: 1, inFlight: inflight, lastEventAgeMs: 1000 };
  if (url.includes(":9083/")) return null; // ops-light unreachable
  return { childAlive: true, model: "m", queueDepth: 0, inFlight: null };
};
const ports = { chat_health: 9094, ops_health: 9093, ops_light_health: 9083, ops_haiku_health: 9073 };

async function snap(extra = {}) {
  return collect({
    root: fixture(), now: NOW, port: (n) => ports[n], pluginOn: () => true,
    fetchJson: health({ id: "dddddd99", source: "purchase", enqueuedAt: NOW - 4 * 60e3 }),
    supabase: async (q) => q.startsWith("purchase_approvals")
      ? [{ id: "pur_1", status: "stale", item_json: { items: [{ title: "Compact car" }], total_cents: 36163, currency: "USD" }, created_at: iso(85), executed_at: iso(82), result: { reason: "page changed", missing: ["card ending 0000"] } }]
      : q.startsWith("action_approvals") ? [] : [{ id: "si1", summary: "Better card step", status: "pending", created_at: iso(30) }],
    openQuestions: async () => [{ id: "q1", question: "Which hotel do you prefer?", asks: 2, first_asked_at: iso(600) }],
    watchCounts: async () => ({ active: 3, paused: 1 }),
    ...extra,
  });
}

const find = (s, section, id) => s.items.find((i) => i.section === section && i.id === id);

test("dispatches: in flight from /health with its log task, done, error, interrupted, queued, unreachable supervisor", async () => {
  const s = await snap();
  const live = find(s, "dispatches", "dddddd");
  assert.equal(live.bucket, "running");
  assert.match(live.what, /second try/);
  assert.equal(live.age_s, 180);
  assert.equal(find(s, "dispatches", "aaaaaa").bucket, "done");
  assert.equal(find(s, "dispatches", "cccccc").bucket, "failed");
  const lost = find(s, "dispatches", "bbbbbb");
  assert.equal(lost.bucket, "stuck");
  assert.match(lost.state, /interrupted/);
  assert.equal(find(s, "dispatches", "eeeeee").bucket, "queued");
  assert.equal(find(s, "dispatches", "ops-light").state, "unreachable");
  assert.ok(s.unknown.some((u) => u.why.includes("ops-light")));
});

test("purchases: raw queue status with its bucket; the approval keeps the poller's result", async () => {
  const s = await snap();
  const p1 = find(s, "purchases", "pq_1");
  assert.match(p1.state, /^needs_card \(a later request followed: pq_2\)/);
  assert.equal(p1.bucket, "failed");
  assert.equal(find(s, "purchases", "pq_2").bucket, "running");
  assert.equal(find(s, "purchases", "pq_old"), undefined, "older than 48h is dropped");
  const a = find(s, "purchases", "pur_1");
  assert.equal(a.bucket, "failed");
  assert.equal(a.detail.missing, "card ending 0000");
  assert.match(a.what, /361\.63 USD/);
});

test("placed with an unchanged page is flagged, not hidden", () => {
  const [it] = purchaseApprovalItems([{ id: "p", status: "placed", created_at: iso(5), result: { clicked: "Book now", before_url: "https://x/checkout/1", after_url: "https://x/checkout/1", after_title: "Checkout" } }], NOW);
  assert.equal(it.bucket, "done");
  assert.equal(it.state, "placed");
  assert.match(it.detail.page_after_click, /unchanged/);
  assert.equal(it.detail.after_title, "Checkout");
});

test("a pending approval past its expiry is not waiting on the user", () => {
  const [a, b] = purchaseApprovalItems([
    { id: "x", status: "pending", created_at: iso(30), expires_at_ms: NOW - 1000 },
    { id: "y", status: "pending", created_at: iso(1), expires_at_ms: NOW + 600e3 },
  ], NOW);
  assert.equal(a.bucket, "done");
  assert.equal(b.bucket, "waiting");
});

test("a stopped purchase with a later request after it is history, the newest stays stuck", () => {
  const its = purchaseQueueItems([
    { id: "a", asked: "x", status: "needs_code_fix", queued_at: iso(60), done_at: iso(55) },
    { id: "b", asked: "x", status: "needs_card", queued_at: iso(30), done_at: iso(25) },
  ], NOW);
  const by = Object.fromEntries(its.map((i) => [i.id, i]));
  assert.equal(by.b.bucket, "stuck");
  assert.equal(by.a.bucket, "failed");
  assert.match(by.a.state, /later request followed: b/);
});

test("stale in_progress purchase claim is stuck", () => {
  const [it] = purchaseQueueItems([{ id: "q", asked: "x", status: "in_progress", queued_at: iso(60), claimed_at: iso(59) }], NOW);
  assert.equal(it.bucket, "stuck");
});

test("builds: held carries the governor's reason; done carries the result's first line", async () => {
  const s = await snap();
  const held = find(s, "builds", "20260310-140000-1");
  assert.equal(held.bucket, "stuck");
  assert.equal(held.detail.held_because, "week on pace to run out");
  assert.equal(find(s, "builds", "20260310-145500-2").bucket, "queued");
  assert.equal(find(s, "builds", "20260310-100000-3").detail.result, "Shipped the setting in commit abc123.");
});

test("jobs, cron, code-reload holds, questions, approvals, roles, watches", async () => {
  const s = await snap();
  assert.equal(find(s, "jobs", "j1").bucket, "running");
  assert.equal(find(s, "jobs", "j2").bucket, "failed");
  const bad = find(s, "cron", "bad-job");
  assert.match(bad.state, /last 2 run\(s\) failed/);
  assert.equal(find(s, "cron", "recovered"), undefined);
  assert.equal(find(s, "cron", "ops-light").bucket, "stuck");
  assert.equal(find(s, "cron", "ops"), undefined);
  assert.equal(find(s, "questions", "q1").bucket, "waiting");
  assert.equal(find(s, "approvals", "si1").bucket, "waiting");
  assert.equal(find(s, "roles", "x").bucket, "queued");
  assert.deepEqual(s.watches, { active: 3, paused: 1 });
});

test("unreadable sources are unknown, never empty", async () => {
  const s = await snap({ supabase: async () => null, openQuestions: async () => { throw new Error("ledger locked"); } });
  const why = s.unknown.map((u) => `${u.section}: ${u.why}`).join("\n");
  assert.match(why, /purchases: purchase_approvals unreachable/);
  assert.match(why, /approvals: action_approvals unreachable/);
  assert.match(why, /questions: ledger locked/);
  assert.match(render(s), /Could not read \(so unknown, not empty\)/);
});

test("match keeps items containing the text; sections narrow the read", async () => {
  const s = await snap({ match: "COMPACT CAR", sections: ["purchases", "builds"] });
  assert.deepEqual([...new Set(s.items.map((i) => i.section))], ["purchases"]);
  assert.ok(s.items.every((i) => JSON.stringify(i).toLowerCase().includes("compact car")));
});

test("render groups by bucket with ages", async () => {
  const text = render(await snap(), { tz: "UTC" });
  assert.match(text, /Running now \(\d+\)/);
  assert.match(text, /Stuck or stopped/);
  assert.match(text, /needs_card \(a later request followed: pq_2\), 80m ago \(pq_1\)/);
  assert.match(text, /Waiting on the user/);
  assert.ok(text.includes("Supervisors: chat up, idle | ops up, busy (purchase), 1 queued"));
});

test("parsers", () => {
  const d = parseDispatchLog("2026-03-10T10:00:00Z [supervisor] disp abc123 → gmail:1: New email...\n2026-03-10T10:00:05Z [supervisor] disp abc123 done gmail:1 5000ms $0.10 turns=2\n");
  assert.deepEqual(d.map((x) => [x.id, x.status, x.ms, x.turns]), [["abc123", "done", 5000, 2]]);
  assert.deepEqual(cronFailures('{"label":"a","end":"' + iso(1) + '","exit":0,"signal":"SIGTERM"}\n', NOW).map((f) => f.label), ["a"]);
  assert.deepEqual(codeReloadHolds("garbage\n", NOW), []);
});
