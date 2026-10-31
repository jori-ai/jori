// jori-doctor-null-trigger.test.mjs — `jori doctor` survives a scheduled
// task with `trigger_script: null`.
// Run: node --test tests/jori-doctor-null-trigger.test.mjs
//
// Two jobs were
// registered as cron-run-direct jobs with no trigger script. The tasks.json ↔
// crontab check called path.basename(null), threw, and every doctor run (and so
// every doctor-preflight-check) died with a stack trace instead of reporting.
//
// Runs the real doctor against a fixture HOME (tasks.json, services.json, the
// repo's own lib) with fake `crontab` and `curl` first on PATH, so no
// supervisor, network or the real crontab is touched.

import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

it("a null-trigger task is matched by its crontab --label; one with no cron line is reported, not thrown", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-null-trigger-"));
  const tools = path.join(home, "Dev/jori");
  const bin = path.join(home, "fakebin");
  for (const d of ["system", "agent/scripts", "data"]) fs.mkdirSync(path.join(tools, d), { recursive: true });
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(ROOT, "lib"), path.join(tools, "lib"));
  const task = (name, schedule) => ({ name, schedule, trigger_script: null, ops_playbook_section: null, phrases: [] });
  fs.writeFileSync(path.join(tools, "system/tasks.json"),
    JSON.stringify({ tasks: [task("label-job", "40 9 * * *"), task("absent-job", "10 1 * * *")] }));
  fs.writeFileSync(path.join(tools, "system/services.json"), JSON.stringify({ services: [] }));
  fs.writeFileSync(path.join(bin, "crontab"),
    "#!/bin/sh\necho '40 9 * * * /usr/bin/true --label label-job -- /usr/bin/true'\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, "bin/jori"), "doctor", "--json"], {
      encoding: "utf8", timeout: 60000,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, NO_COLOR: "1" },
    });
    assert.ok(!r.stderr.includes("TypeError"), r.stderr.slice(0, 400));
    const checks = JSON.parse(r.stdout);
    const sched = checks.find((ck) => ck.name === "tasks.json schedules ↔ crontab");
    assert.ok(sched, "schedule check missing from doctor output");
    assert.equal(sched.ok, false);
    assert.equal(sched.detail, "missing cron: absent-job");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
