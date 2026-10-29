// Tests for hum-interventions-reconcile's pure merge/pick logic.
//
// REGRESSION GUARD: hum-i-20260823-04 — a hum-interventions.jsonl row staged
// by hum-action-executor's approval-gated path (commit:null,
// approval_id:"<uuid>") never gets a commit sha or measure_at of its own once
// the Face-ID card lands, so hum-metrics-collect --measure's
// `commit in (None, "pending")` guard skips it forever and the 7-day
// before/after attribution measurement silently never fires. Fixture rows
// below are the real shape hum-action-executor.md Step 3.5 appends (see
// data/hum-interventions.jsonl as of 2026-09-10: five rows stuck this
// way — hum-i-20260802-04, -0809-01, -0809-02, -0816-01, -0816-04).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEASURE_WINDOW_MS,
  expectedCommitMessage,
  approvalFiles,
  pickCommit,
  reconcileRows,
} from "../lib/hum-interventions-reconcile.mjs";

// ---- expectedCommitMessage --------------------------------------------------

test("expectedCommitMessage — code-fix uses row.summary, matches applyItem() verbatim", () => {
  const row = { item_type: "code-fix", summary: "fix the thing", id: "abc-123" };
  assert.equal(expectedCommitMessage(row), "self-improve: apply owner-approved fix (Face-ID) — fix the thing");
});

test("expectedCommitMessage — code-fix falls back to id when summary is missing, like applyItem()'s `row.summary || row.id`", () => {
  const row = { item_type: "code-fix", summary: "", id: "abc-123" };
  assert.equal(expectedCommitMessage(row), "self-improve: apply owner-approved fix (Face-ID) — abc-123");
});

test("expectedCommitMessage — new-capability uses item_json.name, matches applyItem() verbatim", () => {
  const row = { item_type: "new-capability", summary: "ignored", item_json: { name: "weather-lookup" } };
  assert.equal(expectedCommitMessage(row), "self-improve: load owner-approved capability 'weather-lookup' (Face-ID)");
});

// ---- approvalFiles -----------------------------------------------------------

test("approvalFiles — reads result.files, tolerates missing/malformed shapes", () => {
  assert.deepEqual(approvalFiles({ result: { files: ["a.mjs", "b.mjs"] } }), ["a.mjs", "b.mjs"]);
  assert.deepEqual(approvalFiles({ result: {} }), []);
  assert.deepEqual(approvalFiles({}), []);
  assert.deepEqual(approvalFiles(null), []);
  assert.deepEqual(approvalFiles({ result: { files: ["a.mjs", 5, null] } }), ["a.mjs"]);
});

// ---- pickCommit ----------------------------------------------------------

test("pickCommit — zero candidates returns null", () => {
  assert.equal(pickCommit([], { applied_at: "2026-08-25T10:00:00Z" }), null);
});

test("pickCommit — one candidate is returned unconditionally", () => {
  assert.equal(pickCommit([{ sha: "deadbeef" }], {}), "deadbeef");
});

test("pickCommit — multiple candidates, file overlap disambiguates", () => {
  const approval = { result: { files: ["lib/foo.mjs"] }, applied_at: "2026-08-25T10:00:00Z" };
  const candidates = [
    { sha: "aaa1111", iso: "2026-08-25T09:00:00Z", files: ["lib/unrelated.mjs"] },
    { sha: "bbb2222", iso: "2026-08-20T09:00:00Z", files: ["lib/foo.mjs"] },
  ];
  // bbb2222 is farther in time but is the one that actually touched the
  // approval's files — file overlap outranks time-closeness.
  assert.equal(pickCommit(candidates, approval), "bbb2222");
});

test("pickCommit — multiple candidates, no usable file info, falls back to closest applied_at", () => {
  const approval = { applied_at: "2026-08-25T10:00:00Z" };
  const candidates = [
    { sha: "far0000", iso: "2026-08-20T10:00:00Z" },
    { sha: "near1111", iso: "2026-08-25T09:55:00Z" },
  ];
  assert.equal(pickCommit(candidates, approval), "near1111");
});

test("pickCommit — multiple candidates, no applied_at and no file info, deterministic first-of-pool", () => {
  const candidates = [
    { sha: "first111" },
    { sha: "second22" },
  ];
  assert.equal(pickCommit(candidates, {}), "first111");
});

// ---- reconcileRows -----------------------------------------------------------

const realRow = (over = {}) => ({
  id: "hum-i-20260802-04",
  lane: null,
  hypothesis: "hum-answer never persists category:lane_diagnosis",
  predicted_effect: {},
  baseline_window: null,
  measure_at: null,
  commit: null,
  approval_id: "d362887a-99c3-464d-9a9f-3b8f24a671ed",
  status: "awaiting_approval",
  ...over,
});

test("reconcileRows — backfills commit + applied_at + measure_at for a resolved row", () => {
  const rows = [realRow()];
  const resolved = new Map([
    ["d362887a-99c3-464d-9a9f-3b8f24a671ed", { commitSha: "abc1234", appliedAt: "2026-08-25T10:00:00.000Z" }],
  ]);
  const { rows: out, changed, updates } = reconcileRows(rows, resolved);
  assert.equal(changed, true);
  assert.deepEqual(updates, [{ id: "hum-i-20260802-04", approval_id: "d362887a-99c3-464d-9a9f-3b8f24a671ed", commit: "abc1234" }]);
  assert.equal(out[0].commit, "abc1234");
  assert.equal(out[0].applied_at, "2026-08-25T10:00:00.000Z");
  assert.equal(out[0].measure_at, new Date(Date.parse("2026-08-25T10:00:00.000Z") + MEASURE_WINDOW_MS).toISOString());
  assert.equal(out[0].status, "applied");
  // Untouched fields carried through byte-for-byte.
  assert.equal(out[0].hypothesis, rows[0].hypothesis);
  assert.equal(out[0].lane, null);
});

test("reconcileRows — accepts a plain object in place of a Map", () => {
  const rows = [realRow()];
  const resolved = { "d362887a-99c3-464d-9a9f-3b8f24a671ed": { commitSha: "abc1234", appliedAt: "2026-08-25T10:00:00.000Z" } };
  const { changed, updates } = reconcileRows(rows, resolved);
  assert.equal(changed, true);
  assert.equal(updates.length, 1);
});

test("reconcileRows — a row already carrying a commit is returned by the SAME reference, untouched", () => {
  const already = { id: "hum-i-20260520-01", commit: "7013a1d", approval_id: null };
  const rows = [already];
  const { rows: out, changed, updates } = reconcileRows(rows, new Map([["whatever", { commitSha: "x", appliedAt: "2026-01-01T00:00:00Z" }]]));
  assert.equal(changed, false);
  assert.equal(updates.length, 0);
  assert.equal(out[0], already); // identity, not just deep-equal
});

test("reconcileRows — a row with no approval_id is left alone", () => {
  const noApproval = { id: "hum-i-x", commit: null, approval_id: null };
  const { rows: out, changed } = reconcileRows([noApproval], new Map());
  assert.equal(changed, false);
  assert.equal(out[0], noApproval);
});

test("reconcileRows — an approval_id not present in `resolved` (not applied yet, or unrecoverable) is left alone", () => {
  const row = realRow();
  const { rows: out, changed } = reconcileRows([row], new Map());
  assert.equal(changed, false);
  assert.equal(out[0], row);
});

test("reconcileRows — never clobbers an already-set measure_at", () => {
  const row = realRow({ measure_at: "2026-09-01T00:00:00.000Z" });
  const resolved = new Map([["d362887a-99c3-464d-9a9f-3b8f24a671ed", { commitSha: "abc1234", appliedAt: "2026-08-25T10:00:00.000Z" }]]);
  const { rows: out } = reconcileRows([row], resolved);
  assert.equal(out[0].measure_at, "2026-09-01T00:00:00.000Z");
});

test("reconcileRows — mixed batch only touches the resolvable row, preserves order and count", () => {
  const stuck = realRow({ id: "hum-i-20260809-01", approval_id: "f828871b-3f36-4c15-a281-21e2784718d9" });
  const resolvable = realRow({ id: "hum-i-20260802-04", approval_id: "d362887a-99c3-464d-9a9f-3b8f24a671ed" });
  const shipped = { id: "hum-i-20260520-01", commit: "7013a1d", approval_id: null };
  const rows = [shipped, stuck, resolvable];
  const resolved = new Map([["d362887a-99c3-464d-9a9f-3b8f24a671ed", { commitSha: "abc1234", appliedAt: "2026-08-25T10:00:00.000Z" }]]);
  const { rows: out, updates } = reconcileRows(rows, resolved);
  assert.equal(out.length, 3);
  assert.equal(out[0], shipped);
  assert.equal(out[1], stuck);
  assert.equal(out[2].commit, "abc1234");
  assert.equal(updates.length, 1);
});

test("reconcileRows — a resolved entry missing appliedAt is treated as unresolved", () => {
  const row = realRow();
  const resolved = new Map([["d362887a-99c3-464d-9a9f-3b8f24a671ed", { commitSha: "abc1234" }]]);
  const { changed } = reconcileRows([row], resolved);
  assert.equal(changed, false);
});
