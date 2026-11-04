// companions.test.mjs — companion names: the user is never a companion, a
// face tag reads under its canonical name, and a fresh install keeps every tag.
// Run: node --test tests/companions.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");
const C = require(path.join(LIB, "companions.js"));

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companions-"));
  fs.mkdirSync(path.join(dir, "local", "config"), { recursive: true });
  fs.mkdirSync(path.join(dir, "home", "data"), { recursive: true });
  fs.writeFileSync(path.join(dir, "local", "instance.json"), JSON.stringify({ owner_name: "Alex" }));
  fs.writeFileSync(path.join(dir, "local", "config", "companion-names.json"),
    JSON.stringify({ self: ["Alex Example"], aliases: { "Sam Example": "Sam", "Rover Example": "Rover" } }));
  fs.writeFileSync(path.join(dir, "home", "data", "known-companions.json"), JSON.stringify({ names: ["Sam", "Rover"] }));
  return dir;
}

function withEnv(env, fn) {
  const old = {};
  for (const k of Object.keys(env)) { old[k] = process.env[k]; process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}

test("the user is never a companion; tags read under one canonical name", () => {
  const dir = sandbox();
  withEnv({ JORI_LOCAL_DIR: path.join(dir, "local"), JORI_HOME: path.join(dir, "home") }, () => {
    assert.deepEqual(C.companionNames().self.sort(), ["Alex", "Alex Example"]);
    assert.deepEqual(C.canonicalCompanions(["Alex Example", "Sam Example", "Sam", { name: "Rover Example", n: 2 }, "Alex"]),
      ["Sam", { name: "Rover", n: 2 }]);
    assert.equal(C.canonicalName("Someone New"), "Someone New", "an unknown tag is kept as written");
    assert.deepEqual(C.knownCompanions(), ["Sam", "Rover"]);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a fresh install: no aliases, nobody known, only the owner is self", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companions-empty-"));
  withEnv({ JORI_LOCAL_DIR: dir, JORI_HOME: dir }, () => {
    assert.deepEqual(C.companionNames(), { self: ["the user"], aliases: {} });
    assert.deepEqual(C.canonicalCompanions(["Sam Example"]), ["Sam Example"]);
    assert.deepEqual(C.knownCompanions(), []);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the Python twin reads the same files", () => {
  const dir = sandbox();
  const r = spawnSync("python3", ["-c",
    "import json,companions as c; print(json.dumps([sorted(c.companion_names()['self']), c.canonical_name('Sam Example'), c.canonical_name('Alex'), c.known_companions()]))"],
    { cwd: LIB, encoding: "utf8", env: { ...process.env, JORI_LOCAL_DIR: path.join(dir, "local"), JORI_HOME: path.join(dir, "home") } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [["Alex", "Alex Example"], "Sam", null, ["Sam", "Rover"]]);
  fs.rmSync(dir, { recursive: true, force: true });
});
