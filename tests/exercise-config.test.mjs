// exercise-config.test.mjs — the exercise habit's config layer and its
// consumers on a fresh install (off, not broken) and with a synthetic config
// plus a stub workout tracker.
//
// Run: node --test tests/exercise-config.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CFG_LIB = path.join(ROOT, "lib/exercise-config.cjs");

function freshLocal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "exercise-local-"));
}

function loadConfig(localDir, env = {}) {
  const r = spawnSync(process.execPath, ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(CFG_LIB)}).exerciseConfig()))`], {
    env: { ...process.env, JORI_LOCAL_DIR: localDir, ...env }, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("a fresh install has the habit off with generic wording", () => {
  const c = loadConfig(freshLocal());
  assert.equal(c.enabled, false);
  assert.equal(c.tracker, "");
  assert.equal(c.texts.event_match, "Exercise");
  assert.ok(Array.isArray(c.texts.encourage_pools) && c.texts.encourage_pools.length > 0);
});

test("the local config and its texts file layer over the defaults", () => {
  const dir = freshLocal();
  fs.mkdirSync(path.join(dir, "config"));
  fs.mkdirSync(path.join(dir, "exercise"));
  fs.writeFileSync(path.join(dir, "config/exercise.json"), JSON.stringify({
    enabled: true, tracker_bin: "/opt/stub/tracker", rest_days: [0, 3], texts_file: "exercise/texts.json",
  }));
  fs.writeFileSync(path.join(dir, "exercise/texts.json"), JSON.stringify({
    event_summary: "Gym block", backstop: { morning: "Morning {workout}" },
  }));
  const c = loadConfig(dir, { JORI_OWNER_EMAIL: "owner@example.com" });
  assert.equal(c.enabled, true);
  assert.equal(c.tracker, "/opt/stub/tracker");
  assert.deepEqual(c.rest_days, [0, 3]);
  assert.equal(c.calendar_account, "owner@example.com", "the calendar account defaults to the owner");
  assert.equal(c.texts.event_summary, "Gym block");
  assert.equal(c.texts.backstop.morning, "Morning {workout}");
  assert.ok(c.texts.backstop.evening, "unset backstop lines keep the generic default");
});

test("tzOffset follows DST and hhmmToMin rejects junk", () => {
  const { tzOffset, hhmmToMin } = require(CFG_LIB);
  assert.equal(tzOffset("2026-01-15", "Europe/Paris"), "+01:00");
  assert.equal(tzOffset("2026-07-15", "Europe/Paris"), "+02:00");
  assert.equal(tzOffset("2026-07-15", "UTC"), "+00:00");
  assert.equal(hhmmToMin("11:30"), 690);
  assert.equal(hhmmToMin("25:00", 7), 7);
  assert.equal(hhmmToMin("", null), null);
});

test("exercise-schedule exits cleanly when the habit is not configured", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin/exercise-schedule"), "--dry-run"], {
    env: { ...process.env, JORI_LOCAL_DIR: freshLocal() }, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /not configured/);
});

function runHarvester(localDir, home) {
  return spawnSync(process.execPath, [path.join(ROOT, "agent/scripts/hum-harvesters/exercise.mjs")], {
    input: "{}",
    env: { ...process.env, JORI_LOCAL_DIR: localDir, JORI_HOME: home, HUM_HARVEST_PREVIEW: "1", JORI_TZ: "UTC" },
    encoding: "utf8",
  });
}

test("the exercise harvester is a no-op on a fresh install", () => {
  const r = runHarvester(freshLocal(), fs.mkdtempSync(path.join(os.tmpdir(), "exercise-home-")));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "null");
  assert.match(r.stderr, /\[noop\].*not configured/);
});

test("the exercise harvester celebrates a session the stub tracker just finished", () => {
  const dir = freshLocal();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "exercise-home-"));
  const finished = new Date(Date.now() - 30 * 60000).toISOString();
  const started = new Date(Date.now() - 70 * 60000).toISOString();
  const stub = path.join(dir, "tracker");
  const today = {
    plan: { workoutType: "strengthA" },
    session: { all_today: [{ id: "s1", workout_type: "strengthA", started_at: started, finished_at: finished }], completed: true, in_progress: false },
  };
  fs.writeFileSync(stub, `#!/bin/sh
case "$1" in
  today) echo '${JSON.stringify(today)}' ;;
  week) echo '{"rows":[{"sessions":[1]},{"sessions":[1]},{"sessions":[]}]}' ;;
  streak) echo '{"streak":3,"last_active":null}' ;;
esac
`, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, "config"));
  fs.writeFileSync(path.join(dir, "config/exercise.json"), JSON.stringify({
    enabled: true, tracker_bin: stub, hard_stop: "23:59", target_per_week: 4,
  }));
  const r = runHarvester(dir, home);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.ok(out, `expected a candidate, got null (${r.stderr})`);
  assert.equal(out.topic, "exercise");
  assert.equal(out.supporting_data.branch, "progress");
  assert.match(out.signal, /Strength A done\. 3-day streak\. 2\/4 this week/);
});
