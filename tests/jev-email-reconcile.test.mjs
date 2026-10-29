// jev-email-reconcile.test.mjs — the late email comparison runs ONCE per message.
// Regression for the 2026-09-23 review: `done` ids were forgotten after 7 days
// while their pending rows stayed, so the same disagreement re-paged weekly.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BIN = path.resolve("bin/jev-email-reconcile");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-reconcile-"));
const SHADOW = path.join(tmp, "shadow");
const DB = path.join(tmp, "email-memory.db");
fs.mkdirSync(SHADOW, { recursive: true });
execFileSync("/usr/bin/sqlite3", [DB, "CREATE TABLE memories (text TEXT, tags TEXT, created_at TEXT); INSERT INTO memories VALUES ('triaged 19abcdef0001 ok', 'vendor p3', '2026-09-23T10:00:00Z');"]);
const PENDING = path.join(SHADOW, "email-triage-pending.jsonl");
const row = (id, over = {}) => JSON.stringify({ ts: new Date().toISOString(), messageId: id, from: "a@b.c", subject: "s", jev: { label: "personal", priority: "P2", confidence: 0.95 }, acted_by: "dispatch", compare: "reconcile", ...over });
fs.writeFileSync(PENDING, [
  row("19abcdef0001"),                                                            // has an ops verdict → compared (disagrees)
  row("19abcdef0002"),                                                            // no verdict yet → waits
  row("19abcdef0003", { ts: new Date(Date.now() - 72 * 3600e3).toISOString() }), // stale, no verdict → retired + dropped
].join("\n") + "\n");

const env = { ...process.env, JEV_SHADOW_DIR: SHADOW, EMAIL_MEMORY_DB: DB, JEV_NO_ALERT: "1" };
const run = () => JSON.parse(execFileSync(process.execPath, [BIN, "--json"], { env, encoding: "utf8" }).trim());
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("compares once, compacts the pending file, never re-pages", () => {
  const a = run();
  assert.equal(a.compared, 1); assert.equal(a.disagree, 1); assert.equal(a.waiting, 1); assert.equal(a.retired, 1);
  assert.deepEqual(lines(PENDING).map((r) => r.messageId), ["19abcdef0002"], "finished + stale rows dropped");
  assert.equal(lines(path.join(SHADOW, "disagreements.jsonl")).length, 1);

  // A row appended by the classifier between runs survives the next compaction.
  fs.appendFileSync(PENDING, row("19abcdef0004") + "\n");
  const b = run();
  assert.equal(b.compared, 0, "the compared message is not compared again");
  assert.deepEqual(lines(PENDING).map((r) => r.messageId).sort(), ["19abcdef0002", "19abcdef0004"]);
  assert.equal(lines(path.join(SHADOW, "disagreements.jsonl")).length, 1, "no second page");
});
