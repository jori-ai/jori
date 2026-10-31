// self-improve-rebuild.test.mjs — an approved card that failed on a conflict is
// queued for ONE rebuild (a chat-build request), never twice, and a rebuild is
// never rebuilt again. Regression for a 2026-10-07
// card, which failed on a conflict, was never rebuilt, and let the same question
// reach the user again on 2026-10-18.
//
// Run: node --test tests/self-improve-rebuild.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canRebuild, queueCardRebuild, rebuildSpec, rebuildStatePath } from "../lib/self-improve-rebuild.mjs";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "si-rebuild-test-"));
const row = (extra = {}) => ({
  id: "3f1c2a90-aaaa-bbbb-cccc-000000000001",
  item_type: "code-fix",
  summary: "Don't ask about the flat you're sleeping in",
  rationale: "What's wrong: ...",
  item_json: { files: { "bin/segment-ask": "x" } },
  ...extra,
});
const now = new Date("2026-10-22T12:00:00Z");

test("a conflicted card is queued once as a chat-build request with the brief", () => {
  const r = root();
  const out = queueCardRebuild({ root: r, row: row(), error: "bin/segment-ask changed on disk", now });
  assert.equal(out.queued, true);
  const file = path.join(r, "data/build-queue/pending", `${out.requestId}.json`);
  const req = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(req.source, "approval-rebuild");
  assert.equal(req.rebuild_of, row().id);
  assert.match(req.spec, /REBUILD OF AN APPROVED CARD/);
  assert.match(req.spec, /self-improve-show 3f1c2a90-aaaa-bbbb-cccc-000000000001 --full/);
  assert.match(req.spec, /bin\/segment-ask/);
  assert.ok(req.spec.length < 6000, "fits build-request's cap");
  assert.ok(JSON.parse(fs.readFileSync(rebuildStatePath(r), "utf8"))[row().id]);

  // The retry path hits the same conflict again: no second request.
  const again = queueCardRebuild({ root: r, row: row(), error: "same", now });
  assert.equal(again.queued, false);
  assert.equal(again.already, true);
  assert.equal(fs.readdirSync(path.join(r, "data/build-queue/pending")).length, 1);
});

test("a rebuild that conflicts again is never rebuilt a second time", () => {
  const r = root();
  const out = queueCardRebuild({ root: r, row: row({ id: "9e9e9e9e-1", item_json: { files: { a: "1" }, rebuild_of: row().id } }), error: "e", now });
  assert.equal(out.queued, false);
  assert.equal(out.already, true);
  assert.equal(fs.existsSync(path.join(r, "data/build-queue/pending")), false);
});

test("only code-fix cards are rebuilt", () => {
  assert.equal(canRebuild(row({ item_type: "new-capability" })).ok, false);
  assert.equal(canRebuild(row({ item_type: "new-capability" })).already, undefined);
  assert.equal(canRebuild(row()).ok, true);
});

test("a long rationale is truncated so the brief stays small", () => {
  const spec = rebuildSpec(row({ rationale: "x".repeat(10_000) }), "conflict");
  assert.ok(spec.length < 4000);
});

test("never throws: an unwritable root reports why", () => {
  const out = queueCardRebuild({ root: "/dev/null/nope", row: row(), error: "e", now });
  assert.equal(out.queued, false);
  assert.match(out.reason, /could not queue/);
});
