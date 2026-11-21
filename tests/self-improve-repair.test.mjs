// lib/self-improve-repair.mjs — an approved card that went in but whose tests
// fail gets a fix queued (once), and turns green when that fix is in.
// Regression for 2026-11-15: the Shows seen card sat "In, not running: its
// tests fail." and every Retry failed the same way, with nothing fixing it.
//
// Run: node --test tests/self-improve-repair.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { notLiveFollowUp, settleRepaired } from "../lib/self-improve-repair.mjs";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "si-repair-test-"));
const ORIG = "3345b2d3-230c-4575-91f5-28422a3300e6";
const row = (extra = {}) => ({
  id: ORIG, item_type: "code-fix", summary: "Shows seen covers museums", rationale: "What's wrong: ...",
  item_json: { files: { "lib/decision-queue.mjs": "x", "tests/decision-queue.test.mjs": "y" } }, ...extra,
});
const testsFailed = {
  ok: false, not_live: true, git: "committed", files: ["lib/decision-queue.mjs", "tests/decision-queue.test.mjs"],
  error: "its tests fail: a tapped decision answers in code (Expected values to be strictly equal:).",
  notes: ["The shows-seen plugin is on and its 3 schedules are installed."],
  tests_failed: true, failures: ["a tapped decision answers in code (Expected values to be strictly equal:)"],
};

// A tiny approvals table with the poller's store interface.
function db(rows) {
  const t = Object.fromEntries(rows.map((r) => [r.id, structuredClone(r)]));
  return {
    t,
    async getApproval(id) { return t[id] ? structuredClone(t[id]) : null; },
    async updateApproval(id, patch) { t[id] = { ...t[id], ...structuredClone(patch) }; },
  };
}

test("failing tests → a repair is queued once, its id goes on the row, the notice says a fix is coming", async () => {
  const root = tmpRoot();
  const store = db([{ ...row(), status: "apply_failed", result: testsFailed }]);
  const o = { id: ORIG, result: testsFailed };
  const first = await notLiveFollowUp({ o, row: row(), title: "Shows seen covers museums", root, update: store.updateApproval });
  assert.match(first.requestId, /-rp3345b2d3$/); // lang-regex-ok: checks our own fixed notice text
  assert.equal(store.t[ORIG].result.repair_request, first.requestId);
  assert.equal(store.t[ORIG].result.tests_failed, true, "the rest of the result is kept");
  assert.match(first.message, /^⚠️ "Shows seen covers museums" is in the code but it is not running: its tests fail: a tapped decision/); // lang-regex-ok: checks our own fixed notice text
  assert.match(first.message, /I'm fixing it now/); // lang-regex-ok: checks our own fixed notice text
  const pending = fs.readdirSync(path.join(root, "data/build-queue/pending"));
  assert.deepEqual(pending, [`${first.requestId}.json`]);
  const req = JSON.parse(fs.readFileSync(path.join(root, "data/build-queue/pending", pending[0]), "utf8"));
  assert.equal(req.kind, "repair");
  assert.match(req.spec, /a tapped decision answers in code/); // lang-regex-ok: checks our own fixed notice text

  // Retry, same failure: the apply rewrote the result (no repair_request); no
  // second request, the id is put back, and the notice says it is on its way.
  store.t[ORIG].result = testsFailed;
  const again = await notLiveFollowUp({ o, row: row(), retried: true, title: "Shows seen covers museums", root, update: store.updateApproval });
  assert.equal(again.requestId, first.requestId);
  assert.equal(store.t[ORIG].result.repair_request, first.requestId);
  assert.match(again.message, /^⚠️ I retried "Shows seen covers museums" but it is not running/); // lang-regex-ok: checks our own fixed notice text
  assert.match(again.message, /still on its way/); // lang-regex-ok: checks our own fixed notice text
  assert.equal(fs.readdirSync(path.join(root, "data/build-queue/pending")).length, 1);
});

test("not running for another reason (a schedule missing) → no repair, Retry as before", async () => {
  const root = tmpRoot();
  let updated = false;
  const res = { ok: false, not_live: true, error: "the shows-seen plugin is on but not scheduled: shows-seen did not get installed." };
  const r = await notLiveFollowUp({ o: { id: ORIG, result: res }, row: row(), title: "T", root, update: async () => { updated = true; } });
  assert.equal(r.requestId, null);
  assert.equal(updated, false);
  assert.match(r.message, /Tap Retry on it once that's fixed/); // lang-regex-ok: checks our own fixed notice text
  assert.equal(fs.existsSync(path.join(root, "data/build-queue")), false);
});

test("a fix whose own tests fail is not fixed again on its own", async () => {
  const root = tmpRoot();
  const fix = row({ id: "aaaaaaaa-fix", item_json: { files: { a: "1" }, rebuild_of: ORIG } });
  const r = await notLiveFollowUp({ o: { id: fix.id, result: testsFailed }, row: fix, title: "Fix", root, update: async () => assert.fail("nothing to record") });
  assert.equal(r.requestId, null);
  assert.match(r.message, /This card was itself a fix/); // lang-regex-ok: checks our own fixed notice text
});

test("a card already queued for a conflict rebuild says so, not that it was a fix", async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data/self-improve-rebuilds.json"), JSON.stringify({ [ORIG]: { request_id: "20261115-rb3345b2d3", kind: "rebuild" } }));
  const r = await notLiveFollowUp({ o: { id: ORIG, result: testsFailed }, row: row(), title: "T", root, update: async () => assert.fail("not a repair") });
  assert.equal(r.requestId, null);
  assert.match(r.message, /A rebuild of it is already queued/); // lang-regex-ok: checks our own fixed notice text
});

test("the fix went in → the original is checked again and marked running", async () => {
  const store = db([{ ...row(), status: "apply_failed", result: { ...testsFailed, repair_request: "x-rp" } }]);
  const sent = [], checked = [];
  const out = await settleRepaired({
    origId: ORIG, fixId: "fix-1", fixTitle: "Decision taps work from cron", store, confirm: async (m) => sent.push(m),
    commitMsgOf: (x) => `self-improve: apply owner-approved fix (Face-ID) — ${x.summary}`,
    goLive: async (rels, msg) => { checked.push([rels, msg]); return { ok: true, notes: ["Its tests pass (2 files)."] }; },
  });
  assert.equal(out, "applied");
  assert.deepEqual(checked, [[testsFailed.files, "self-improve: apply owner-approved fix (Face-ID) — Shows seen covers museums"]]);
  const x = store.t[ORIG];
  assert.equal(x.status, "applied");
  assert.equal(x.result.ok, true);
  assert.equal(x.result.not_live, false);
  assert.equal(x.result.repaired_by, "fix-1");
  assert.deepEqual(x.result.notes, ["Its tests pass (2 files)."]);
  for (const k of ["tests_failed", "failures", "error"]) assert.ok(!(k in x.result), `${k} cleared`);
  assert.deepEqual(x.result.files, testsFailed.files, "the rest is kept");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^✅ "Shows seen covers museums" is running now too: "Decision taps work from cron" fixed what stopped it\. Its tests pass/); // lang-regex-ok: checks our own fixed notice text
});

test("the fix went in but the original still fails → it stays failed and the notice says so", async () => {
  const store = db([{ ...row(), status: "apply_failed", result: testsFailed }]);
  const sent = [];
  const out = await settleRepaired({
    origId: ORIG, fixId: "fix-1", fixTitle: "Fix", store, confirm: async (m) => sent.push(m), commitMsgOf: () => "m",
    goLive: async () => ({ ok: false, error: "its tests fail: other (boom).", notes: [] }),
  });
  assert.equal(out, "still-failing");
  assert.equal(store.t[ORIG].status, "apply_failed");
  assert.equal(store.t[ORIG].result.error, "its tests fail: other (boom).");
  assert.equal(store.t[ORIG].result.checked_after, "fix-1");
  assert.match(sent[0], /^⚠️ "Fix" went in, but "Shows seen covers museums" still isn't running: its tests fail: other \(boom\)\./); // lang-regex-ok: checks our own fixed notice text
});

test("an original that is already running, or never went in, is left alone", async () => {
  for (const r of [
    { ...row(), status: "applied", result: { ok: true, files: ["a"] } },
    { ...row(), status: "apply_failed", result: { ok: false, conflict: true, error: "moved on" } },
  ]) {
    const store = db([r]);
    const out = await settleRepaired({ origId: ORIG, fixId: "f", fixTitle: "F", store, commitMsgOf: () => "m",
      confirm: async () => assert.fail("no notice"), goLive: async () => assert.fail("no check") });
    assert.equal(out, "skipped");
  }
  const none = await settleRepaired({ origId: "gone", fixId: "f", fixTitle: "F", store: db([]), commitMsgOf: () => "m",
    confirm: async () => assert.fail("no notice"), goLive: async () => assert.fail("no check") });
  assert.equal(none, "skipped");
});

test("a database error while settling never throws", async () => {
  const logs = [];
  const out = await settleRepaired({
    origId: ORIG, fixId: "f", fixTitle: "F", commitMsgOf: () => "m", confirm: async () => {}, goLive: async () => ({ ok: true, notes: [] }),
    store: { getApproval: async () => { throw new Error("503"); }, updateApproval: async () => {} }, log: (m) => logs.push(m),
  });
  assert.equal(out, "error");
  assert.match(logs[0], /settle .* failed: 503/); // lang-regex-ok: checks our own fixed notice text
});
