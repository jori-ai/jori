// daily-summary-fix-tier.test.mjs — the fixer's model tier: Sonnet first, Opus
// once a Sonnet run for the date got stuck, and a date that escalated stays
// on Opus. Driven through the CLI (`tier`, `tier-done`, `request --from-review`)
// against a temp DS_FIX_DIR; --no-kick keeps launchd out of it.
// Run: node --test tests/daily-summary-fix-tier.test.mjs

import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "daily-summary-fix");
const D = "2026-11-02";

function fx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-fix-tier-"));
  // An empty local dir: the installation's own fork-models pin must not reach these tests.
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "ds-fix-nolocal-"));
  const run = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, DS_FIX_DIR: dir, DS_FIX_SEND_BIN: "/usr/bin/true", JORI_LOCAL_DIR: local } });
    return { rc: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const tier = () => JSON.parse(run("tier", D).out).tier;
  const edit = (f) => { const p = path.join(dir, `${D}.json`); const s = JSON.parse(fs.readFileSync(p, "utf8")); f(s); fs.writeFileSync(p, JSON.stringify(s)); };
  return { dir, run, tier, edit };
}

it("starts on Sonnet, and stays there for a follow-up run after a Sonnet run that asked the user", () => {
  const f = fx();
  f.run("request", D, "--from-review", "--reason", "x", "--no-kick");
  assert.equal(f.tier(), "sonnet");
  f.edit((s) => { s.status = "awaiting_test"; s.questions = [{ text: "q" }]; });
  f.run("tier-done", D, "sonnet");
  f.run("request", D, "--answer", "it was the car", "--no-kick");
  assert.equal(f.tier(), "sonnet");
});

it("escalates to Opus when the reviewer rejects the day again after a Sonnet run, and stays on Opus", () => {
  const f = fx();
  f.run("request", D, "--from-review", "--reason", "x", "--no-kick");
  f.edit((s) => { s.status = "confirmed"; });
  f.run("tier-done", D, "sonnet");
  assert.equal(f.tier(), "sonnet", "a confirmed day with nothing new is not stuck");
  f.run("request", D, "--from-review", "--reason", "y", "--no-kick");
  assert.equal(f.tier(), "opus");
  f.run("tier-done", D, "opus");
  f.run("request", D, "--answer", "z", "--no-kick");
  assert.equal(f.tier(), "opus", "an escalated date stays on Opus");
});

it("escalates when a Sonnet run gave up, or ended without confirming or asking anything", () => {
  const a = fx();
  a.run("request", D, "--reason", "x", "--no-kick");
  a.edit((s) => { s.status = "gave_up"; });
  a.run("tier-done", D, "sonnet");
  assert.equal(a.tier(), "opus");
  const b = fx();
  b.run("request", D, "--reason", "x", "--no-kick");
  b.run("tier-done", D, "sonnet"); // still "queued", no questions
  assert.equal(b.tier(), "opus");
});

// An installation pin (agent/local/config/fork-models.json, jobs["daily-summary-fix"])
// is the whole answer: Sonnet stays Sonnet even where the usual tiers would escalate.
it("fork-models.json pinned to sonnet keeps every date on Sonnet, even after a run that gave up", () => {
  const f = fx();
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "ds-fix-local-"));
  fs.mkdirSync(path.join(local, "config"), { recursive: true });
  fs.writeFileSync(path.join(local, "config", "fork-models.json"), JSON.stringify({ jobs: { "daily-summary-fix": { model: "sonnet" } } }));
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, DS_FIX_DIR: f.dir, DS_FIX_SEND_BIN: "/usr/bin/true", JORI_LOCAL_DIR: local } });
  const tier = () => JSON.parse(run("tier", D).stdout.trim());
  run("request", D, "--from-review", "--reason", "x", "--no-kick");
  f.edit((s) => { s.status = "gave_up"; });
  run("tier-done", D, "sonnet");
  const t = tier();
  assert.equal(t.tier, "sonnet");
  assert.match(t.reason, /pins/);
  // The same state without the pin escalates, so the test proves the pin is what held it.
  assert.equal(f.tier(), "opus");
});
