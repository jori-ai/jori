// Guards the code gate in front of the weekly reclassification digest: fewer
// than 3 `reclassified` corrections in 7 days → exit 3 (templated ping, no
// agent turn); 3 or more → exit 0 (dispatch). Any error fails open (exit 0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "reclassification-digest-gate");

function makeDb(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reclass-gate-"));
  const file = path.join(dir, "email-memory.db");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
    tags TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), expires_at TEXT DEFAULT NULL)`);
  const ins = db.prepare("INSERT INTO memories (text, tags, created_at) VALUES (?, ?, datetime('now', ?))");
  for (const [tags, age] of rows) ins.run("x", tags, age);
  db.close();
  return file;
}

function run(file) {
  return spawnSync(process.execPath, [GATE], { env: { ...process.env, RECLASS_GATE_DB: file }, encoding: "utf8" });
}

test("two corrections this week → below threshold", () => {
  const r = run(makeDb([["example.com,reclassified", "-1 days"], ["reclassified", "-2 days"]]));
  assert.equal(r.status, 3);
  assert.equal(r.stdout.trim(), "2");
});

test("three corrections this week → dispatch", () => {
  const r = run(makeDb([["reclassified", "-1 days"], ["a, reclassified", "-3 days"], ["reclassified,b", "-6 days"]]));
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "3");
});

test("old rows and look-alike tags do not count", () => {
  const r = run(makeDb([
    ["reclassified", "-9 days"],
    ["not-reclassified", "-1 days"],
    ["reclassification-digest,weekly", "-1 days"],
    ["reclassified", "-1 days"],
  ]));
  assert.equal(r.status, 3);
  assert.equal(r.stdout.trim(), "1");
});

test("a missing database fails open", () => {
  const r = run(path.join(os.tmpdir(), "no-such-dir-xyz", "email-memory.db"));
  assert.equal(r.status, 0);
});
