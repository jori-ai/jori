// lib/job-failures.mjs: when a failing streak opens and closes an incident,
// what the repair queue admits, and how the error line is found.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jobfail-"));
process.env.JORI_LOCAL_DIR = path.join(tmp, "local");
const JF = await import("../lib/job-failures.mjs");
const cfg = { ...JF.DEFAULTS };
const NOW = Date.parse("2026-11-04T20:00:00Z");
const run = (min, exit, cmd = "x") => ({ label: "j", start: new Date(NOW - min * 60e3).toISOString(), end: new Date(NOW - min * 60e3 + 1000).toISOString(), exit, cmd });

test("three failed runs in a row open one incident; two do not", () => {
  const two = JF.evaluate({ runs: { j: [run(90, 0), run(60, 1), run(30, 1)] }, state: {}, cfg, now: NOW });
  assert.equal(two.open.length, 0);
  const three = JF.evaluate({ runs: { j: [run(120, 0), run(90, 1), run(60, 1), run(30, 1)] }, state: {}, cfg, now: NOW });
  assert.equal(three.open.length, 1);
  assert.equal(three.open[0].streak, 3);
  assert.equal(three.open[0].since, run(90, 1).start);
  // the next scan sees the open incident and says nothing new
  const again = JF.evaluate({ runs: { j: [run(120, 0), run(90, 1), run(60, 1), run(30, 1), run(5, 1)] }, state: three.state, cfg, now: NOW });
  assert.equal(again.open.length, 0);
  assert.equal(again.state.incidents.j.streak, 4);
});

test("a good run closes the incident; a retired job is not reported", () => {
  const opened = JF.evaluate({ runs: { j: [run(90, 1), run(60, 1), run(30, 1)] }, state: {}, cfg, now: NOW }).state;
  const closed = JF.evaluate({ runs: { j: [run(90, 1), run(60, 1), run(30, 1), run(5, 0)] }, state: opened, cfg, now: NOW });
  assert.equal(closed.closed.length, 1);
  assert.equal(closed.state.incidents.j, undefined);
  const old = JF.evaluate({ runs: { j: [run(20000, 1), run(19000, 1), run(18000, 1)] }, state: {}, cfg, now: NOW });
  assert.equal(old.open.length, 0, "last run older than max_age_days");
  const ignored = JF.evaluate({ runs: { j: [run(90, 1), run(60, 1), run(30, 1)] }, state: {}, cfg: { ...cfg, ignore: ["j"] }, now: NOW });
  assert.equal(ignored.open.length, 0);
});

test("a killed run (signal, no exit code) counts as failed", () => {
  assert.ok(JF.failed({ exit: null, signal: "SIGTERM" }));
  assert.ok(!JF.failed({ exit: 0, signal: null }));
});

test("the log file comes from the command's redirect, and the error line is found", () => {
  const log = path.join(tmp, "job.log");
  fs.writeFileSync(log, "starting\nfetched 3 items\nWeatherKit 401: {\"reason\": \"NOT_ENABLED\"}\n    at x (y.js:1)\nNode.js v26\n");
  assert.equal(JF.logFileOf(`bash -c 'node bin/a >> ${log} 2>&1'`), log);
  assert.equal(JF.logFileOf("/x/agent/scripts/trigger-a.sh"), null);
  const { error, tail } = JF.logTail(log);
  assert.match(error, /WeatherKit 401/);
  assert.match(tail, /fetched 3 items/);
  assert.deepEqual(JF.logTail(path.join(tmp, "missing.log")), { tail: "", error: "" });
});

test("the repair queue: one open item per job, a daily cap, claim and finish", () => {
  const q = { pending: [], history: [] };
  const inc = { label: "j", cmd: "x", exit: 1, since: "s", error: "e", log_tail: "t" };
  assert.ok(JF.enqueue(q, inc, { cfg, now: NOW }).ok);
  assert.equal(JF.enqueue(q, inc, { cfg, now: NOW }).reason, "already queued");
  for (let i = 0; i < 3; i++) JF.enqueue(q, { ...inc, label: `k${i}` }, { cfg, now: NOW });
  assert.equal(JF.enqueue(q, { ...inc, label: "late" }, { cfg, now: NOW }).reason, "daily repair cap reached");
  const item = JF.claimNext(q, NOW);
  assert.equal(item.label, "j");
  assert.throws(() => JF.finish(q, item.id, { outcome: "maybe" }), /outcome must be/);
  const done = JF.finish(q, item.id, { outcome: "needs_owner", owner_action: "Enable WeatherKit" }, NOW);
  assert.equal(done.outcome, "needs_owner");
  assert.equal(done.log_tail, undefined, "history keeps no log text");
  assert.equal(q.history.length, 1);
  assert.equal(q.pending.some((p) => p.id === item.id), false);
});
