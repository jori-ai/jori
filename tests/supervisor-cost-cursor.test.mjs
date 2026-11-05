// A supervisor restart that resumes its session must diff the next cost row
// against the session's last row. The cursor lives in State next to the
// context floor; an in-memory-only cursor made the first row after every
// restart carry the session's whole running total.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { State } from "../agent/supervisor/state.mjs";
import { REPO_ROOT as ROOT } from "../lib/root.cjs";

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-cursor-"));
  return { dir, file: path.join(dir, "session.json") };
}

test("the cost cursor survives a restart for the same session", () => {
  const { dir, file } = tmpState();
  try {
    const before = new State(file);
    const cursor = { sessionId: before.sessionId, cost: 1.63, input: 12, output: 400, cacheRead: 5_000_000, cacheCreate: 180_000, webSearch: 0 };
    before.recordCostCursor(cursor);
    const after = new State(file);
    assert.deepEqual(after.costCursorFor(after.sessionId), cursor);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the cost cursor is not reused for another session", () => {
  const { dir, file } = tmpState();
  try {
    const s = new State(file);
    s.recordCostCursor({ sessionId: s.sessionId, cost: 2, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, webSearch: 0 });
    s.rotateSession();
    assert.equal(s.costCursorFor(s.sessionId), null);
    assert.equal(s.costCursorFor(null), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a state file written before the cursor existed has none", () => {
  const { dir, file } = tmpState();
  try {
    fs.writeFileSync(file, JSON.stringify({ sessionId: "abc", everInitialized: true }));
    assert.equal(new State(file).costCursorFor("abc"), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the ops supervisor seeds its cost cursor from State and keeps it there", () => {
  const src = fs.readFileSync(path.join(ROOT, "agent/supervisor/index.mjs"), "utf8");
  assert.ok(src.includes("this.costCursor = this.state.costCursorFor(this.state.sessionId)"), "cursor not seeded from State");
  assert.ok(src.includes("this.state.recordCostCursor(this.costCursor);"), "cursor not persisted after a cost row");
});
