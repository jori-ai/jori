// jori-doctor-and-run.test.mjs — two `bin/jori` fixes from 2026-10-13.
// Run: node --test tests/jori-doctor-and-run.test.mjs
//
// 1. `jori doctor` finds a clock-anchored task whose one script runs at two
//    local times. hum-explore runs trigger-hum-explore.sh from two cron lines,
//    labelled trigger-hum-explore-midday and -evening in
//    data/clock-jobs.json, and cron-tz-sync moves both to the user's local
//    clock. Doctor looked the clock job up by the script's own label only,
//    found none, compared the literal tasks.json schedule ("30 12,17 * * *")
//    and reported "missing cron: hum-explore" on every run. The two entries now
//    name their task, and doctor matches on that, never on a label prefix
//    (trigger-hum, the hum task's own label, is a prefix of
//    trigger-hum-explore-midday).
//
// 2. `jori tasks run` sends the shared webhook token to every local
//    supervisor, not only ops on :9092. The chat agent triggers a scheduled
//    task by hand with it; ops-light's webhook (:9082) checks the same token
//    (supervisor/http-server.mjs checkAuth), so every :9082 task would come
//    back 401.
//
// 3. (2026-10-20) `jori doctor` finds a task whose cron line runs something
//    other than its trigger_script. daily-summary-fix's trigger is launched by
//    launchd off its queue directory; its one cron line is the hourly
//    `daily-summary-fix sweep`, labelled daily-summary-fix-sweep, so the
//    trigger's basename is in no crontab line and doctor reported "missing
//    cron: daily-summary-fix" while the sweep ran and exited 0 every hour. The
//    task now names that label in `cron_label`, matched exactly (a longer label
//    that starts with it does not count).
//
// 4. (2026-10-20) the interpreter check (8d2) stays red for an
//    `#!/usr/bin/env node` script run under cron-run, but no longer says it
//    exits 127: it runs while the wrapper puts node on PATH. A bare line, or
//    any other missing interpreter, still reads "→ exit 127".
//
// All run the real CLI against a fixture HOME with fake `crontab` / `curl`
// first on PATH (the jori-doctor-null-trigger.test.mjs harness), so no
// supervisor, network, real crontab or dispatch is touched.

import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ─── 1. doctor: split clock-anchored jobs ──────────────────────────────

const task = (name, schedule, extra = {}) => ({ name, schedule, trigger_script: `agent/scripts/trigger-${name}.sh`, ops_playbook_section: null, phrases: [], ...extra });

// `cronLines` may use {TOOLS} for the fixture's tools dir; `execs` are
// executables written under it ({relative path: content}).
function doctorChecks({ tasks, clockJobs = [], cronLines, execs = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-split-clock-"));
  const tools = path.join(home, "Dev/jori");
  const bin = path.join(home, "fakebin");
  for (const d of ["system", "agent/scripts", "data"]) fs.mkdirSync(path.join(tools, d), { recursive: true });
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(ROOT, "lib"), path.join(tools, "lib"));
  fs.writeFileSync(path.join(tools, "system/tasks.json"), JSON.stringify({ tasks }));
  fs.writeFileSync(path.join(tools, "system/services.json"), JSON.stringify({ services: [] }));
  fs.writeFileSync(path.join(tools, "data/clock-jobs.json"), JSON.stringify(clockJobs));
  // The fixture's zone is the crontab's zone, so the local times are also the crontab's times.
  fs.writeFileSync(path.join(tools, "data/user-timezone.json"),
    JSON.stringify({ timezone: "America/New_York", updated_at: new Date().toISOString() }));
  for (const [rel, content] of Object.entries(execs)) {
    fs.mkdirSync(path.dirname(path.join(tools, rel)), { recursive: true });
    fs.writeFileSync(path.join(tools, rel), content, { mode: 0o755 });
  }
  const lines = cronLines.map((l) => l.split("{TOOLS}").join(tools));
  fs.writeFileSync(path.join(bin, "crontab"), `#!/bin/sh\ncat <<'EOF'\n${lines.join("\n")}\nEOF\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  try {
    // JORI_TZ: the installation's home zone (the crontab's) is the fixture's too,
    // whatever the host's zone or the checkout's agent/local says.
    const r = spawnSync(process.execPath, [path.join(ROOT, "bin/jori"), "doctor", "--json"], {
      encoding: "utf8", timeout: 60000,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, NO_COLOR: "1", JORI_TZ: "America/New_York" },
    });
    assert.ok(!r.stderr.includes("TypeError"), r.stderr.slice(0, 400));
    return JSON.parse(r.stdout);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function findCheck(checks, name) {
  const ck = checks.find((c) => c.name === name);
  assert.ok(ck, `${name} missing from doctor output`);
  return ck;
}

const SCHED = "tasks.json schedules ↔ crontab";

function scheduleCheck(cronLines) {
  // "split" is the decoy: its label, trigger-split, is a prefix of the clock labels.
  return findCheck(doctorChecks({
    tasks: [task("split-job", "30 12,17 * * *"), task("split", "0 9 * * *")],
    clockJobs: [
      { name: "split-job-midday", label: "trigger-split-job-midday", local_time: "12:30", dow: null, task: "split-job" },
      { name: "split-job-evening", label: "trigger-split-job-evening", local_time: "17:30", dow: null, task: "split-job" },
    ],
    cronLines,
  }), SCHED);
}

const S = "/opt/x/tools/agent/scripts";
const MIDDAY = `30 12 * * * /opt/x/cron-run --label trigger-split-job-midday -- ${S}/trigger-split-job.sh`;
const EVENING = `30 17 * * * /opt/x/cron-run --label trigger-split-job-evening -- ${S}/trigger-split-job.sh`;
const DECOY = `0 9 * * * /opt/x/cron-run --label trigger-split -- ${S}/trigger-split.sh`;

it("a task whose script runs at two local times is found in cron by its clock jobs", () => {
  const sched = scheduleCheck([MIDDAY, EVENING, DECOY]);
  assert.equal(sched.ok, true, sched.detail);
  assert.equal(sched.detail, "2 scheduled tasks, all in cron");
});

it("one of its two lines missing is still reported", () => {
  const sched = scheduleCheck([MIDDAY, DECOY]);
  assert.equal(sched.ok, false);
  assert.equal(sched.detail, "missing cron: split-job (tz-adjusted)");
});

// ─── 2. tasks run: the webhook token for every local supervisor ───────

function curlArgsFor(webhookUrl) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-run-auth-"));
  const tools = path.join(home, "Dev/jori");
  const bin = path.join(home, "fakebin");
  for (const d of ["system", "secrets"]) fs.mkdirSync(path.join(tools, d), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(tools, "system/tasks.json"), JSON.stringify({ tasks: [
    { name: "probe-task", schedule: "on-demand", trigger_script: null, webhook_url: webhookUrl, webhook_task: "PROBE", job: "probe-task", ops_playbook_section: null, delivers_to: "none", phrases: [] },
  ] }));
  fs.writeFileSync(path.join(tools, "secrets/webhook-token"), "tok-123\n");
  const record = path.join(home, "curl-args.txt");
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\nprintf 200\n`, { mode: 0o755 });
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, "bin/jori"), "tasks", "run", "probe-task"], {
      encoding: "utf8", timeout: 30000,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, NO_COLOR: "1" },
    });
    assert.equal(r.status, 0, r.stderr.slice(0, 400));
    return fs.readFileSync(record, "utf8").split("\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

it("attaches the token for ops-light (:9082), which used to get none", () => {
  assert.ok(curlArgsFor("http://localhost:9082").includes("Authorization: Bearer tok-123"));
});

it("still attaches it for ops (:9092)", () => {
  assert.ok(curlArgsFor("http://localhost:9092").includes("Authorization: Bearer tok-123"));
});

it("never sends it anywhere but this machine", () => {
  assert.ok(!curlArgsFor("http://example.com:9082").some((a) => a.includes("tok-123")));
});

// ─── 3. doctor: a task whose cron line is not its trigger (cron_label) ─

// The daily-summary-fix shape: trigger launched by launchd, cron runs a sweep.
const fixJob = (extra = {}) => task("fix-job", "52 * * * *", extra);
const SWEEP = (label, sched = "52 * * * *") =>
  `${sched} /opt/x/cron-run --label ${label} -- bash -c '/opt/x/bin/fix-job sweep >> /opt/x/sweep.log 2>&1'`;

it("a task naming its cron line's label is found in cron by that label", () => {
  const sched = findCheck(doctorChecks({ tasks: [fixJob({ cron_label: "fix-job-sweep" })], cronLines: [SWEEP("fix-job-sweep")] }), SCHED);
  assert.equal(sched.ok, true, sched.detail);
  assert.equal(sched.detail, "1 scheduled tasks, all in cron");
});

it("without cron_label the same line is not tied to it (the false 'missing cron' this fixes)", () => {
  const sched = findCheck(doctorChecks({ tasks: [fixJob()], cronLines: [SWEEP("fix-job-sweep")] }), SCHED);
  assert.equal(sched.detail, "missing cron: fix-job");
});

it("its labelled line gone, at the wrong minute, or only a longer label: still missing", () => {
  for (const cronLines of [[], [SWEEP("fix-job-sweep", "7 * * * *")], [SWEEP("fix-job-sweeper")]]) {
    const sched = findCheck(doctorChecks({ tasks: [fixJob({ cron_label: "fix-job-sweep" })], cronLines }), SCHED);
    assert.equal(sched.ok, false, JSON.stringify(cronLines));
    assert.equal(sched.detail, "missing cron: fix-job");
  }
});

// ─── 4. doctor: the interpreter check says what happens ───────────────

const INTERP = "cron-exec'd scripts have a resolvable interpreter";
const envScript = (interp) => ({ "bin/envy": `#!/usr/bin/env ${interp}\n` });
const WRAPPED_LINE = "52 * * * * /opt/x/cron-run --label envy -- bash -c '{TOOLS}/bin/envy sweep >> /opt/x/e.log 2>&1'";
// The real shape needs `env node` to be unresolvable on cron's PATH, as on macOS.
const nodeOnCronPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].some((d) => fs.existsSync(path.join(d, "node")));

it("an env-node script under cron-run stays red but is not said to exit 127 now", { skip: nodeOnCronPath && "node is on cron's PATH here" }, () => {
  const ck = findCheck(doctorChecks({ tasks: [], execs: envScript("node"), cronLines: [WRAPPED_LINE] }), INTERP);
  assert.equal(ck.ok, false);
  assert.ok(ck.detail.includes("envy (#!/usr/bin/env node; runs only while cron-run puts node on PATH, exit 127 without it)"), ck.detail);
  assert.ok(!ck.detail.includes("→ exit 127"), ck.detail);
});

it("any other missing interpreter still reads exit 127, wrapped or bare", () => {
  // An interpreter no host has, so this does not depend on the machine.
  for (const cronLines of [[WRAPPED_LINE], ["0 3 * * * {TOOLS}/bin/envy"]]) {
    const ck = findCheck(doctorChecks({ tasks: [], execs: envScript("jori-no-such-interp"), cronLines }), INTERP);
    assert.equal(ck.ok, false);
    assert.ok(ck.detail.includes("envy (#!/usr/bin/env jori-no-such-interp → exit 127)"), ck.detail);
  }
});
