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
// 5. (2026-11-10) `jori triage code-filed` — see its section below.
//
// 6. (2026-11-14) a trigger launched only by a LaunchAgent in
//    agent/launch-agents (question-hold-release) or only by a plugin's
//    schedule (an installation plugin's cron job) is not an orphan; and a
//    `transient` service (resilience-test, which removes its own plist after
//    72h) is not a missing plist. Both read red on every doctor run before.
//
// All run the real CLI against a fixture HOME with fake `crontab` / `curl`
// first on PATH (the jori-doctor-null-trigger.test.mjs harness), so no
// supervisor, network, real crontab or dispatch is touched.

import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ─── 1. doctor: split clock-anchored jobs ──────────────────────────────

const task = (name, schedule, extra = {}) => ({ name, schedule, trigger_script: `agent/scripts/trigger-${name}.sh`, ops_playbook_section: null, phrases: [], ...extra });

// `cronLines` may use {TOOLS} for the fixture's tools dir; `execs` are
// executables written under it ({relative path: content}).
function doctorChecks({ tasks, clockJobs = [], cronLines, execs = {}, services = [] }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-split-clock-"));
  const tools = path.join(home, "Dev/jori");
  const bin = path.join(home, "fakebin");
  for (const d of ["system", "agent/scripts", "data"]) fs.mkdirSync(path.join(tools, d), { recursive: true });
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(ROOT, "lib"), path.join(tools, "lib"));
  fs.writeFileSync(path.join(tools, "system/tasks.json"), JSON.stringify({ tasks }));
  fs.writeFileSync(path.join(tools, "system/services.json"), JSON.stringify({ services }));
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

// jori-restart-handoff.test.mjs — `jori restart` run by the chat agent itself.
//
// From inside the chat agent's session (JORI_DISPATCH_URL names chat's port), a
// restart of chat or of the whole session would kill the turn that asked for it.
// Other targets still restart at once; that one goes to a single detached
// job-run job that waits for the turn to end and checks the result. Elsewhere
// nothing changes. Fixture install (JORI_HOME), fake curl / launchctl /
// systemctl / job-run, moved ports: nothing real is touched.
{
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORTS = { pm: "59195", wa: "59100", chat: "59094" };

const FAKE_CURL = `#!/bin/sh
for a in "$@"; do url="$a"; done
S="$FAKE_STATE"
case " $* " in *" -X POST "*) method=POST ;; *) method=GET ;; esac
case "$url" in
  *":${PORTS.pm}/health")
    pid=$(cat "$S/wa.pid")
    if kill -0 "$pid" 2>/dev/null; then cur=$pid; else cur=424242; fi
    echo "$method pm" >> "$S/curl.log"
    printf '{"pid":1000,"children":[{"name":"whatsapp-channel","alive":true,"pid":%s}]}' "$cur" ;;
  *":${PORTS.wa}/health") echo "$method wa" >> "$S/curl.log" ;;
  *":${PORTS.chat}/health")
    left=$(cat "$S/inflight-left" 2>/dev/null || echo 0)
    if [ "$left" -gt 0 ]; then echo $((left - 1)) > "$S/inflight-left"; inflight='{"id":"turn-1","source":"jori"}'; state=inflight
    else inflight=null; state=idle; fi
    if [ -f "$S/chat-restarted" ]; then rc=4; ss=B; else rc=3; ss=A; fi
    echo "$method chat-health $state" >> "$S/curl.log"
    printf '{"restartCount":%s,"childAlive":true,"sessionId":"s1","sessionStartedAt":"%s","startedAt":"T0","inFlight":%s}' "$rc" "$ss" "$inflight" ;;
  *":${PORTS.chat}/restart") echo "$method chat-restart" >> "$S/curl.log"; : > "$S/chat-restarted"; printf 202 ;;
  *) exit 7 ;;
esac
`;

// Records the call (argv, whether the chat marker reached the job, whether the
// WhatsApp restart had already happened) and answers like job-run.
const FAKE_JOB_RUN = `#!${process.execPath}
const fs = require("fs");
const S = process.env.FAKE_STATE;
let waAlive = true;
try { process.kill(Number(fs.readFileSync(S + "/wa.pid", "utf8")), 0); } catch { waAlive = false; }
fs.appendFileSync(S + "/jobrun.jsonl", JSON.stringify({ argv: process.argv.slice(2), marker: "JORI_DISPATCH_URL" in process.env, waAlive }) + "\\n");
console.log("started job 20261105-000000-restart-fake-0000");
console.log("log: /dev/null");
`;

function fixture({ inflight = 0 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jori-restart-handoff-"));
  const tools = path.join(home, "install");
  const fakebin = path.join(home, "fakebin");
  const state = path.join(home, "state");
  for (const d of [path.join(tools, "bin"), path.join(tools, "system"), fakebin, state]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(fakebin, "curl"), FAKE_CURL, { mode: 0o755 });
  for (const tool of ["launchctl", "systemctl"]) fs.writeFileSync(path.join(fakebin, tool), `#!/bin/sh\necho "${tool} $*" >> "$FAKE_STATE/service-manager.log"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(tools, "bin/job-run"), FAKE_JOB_RUN, { mode: 0o755 });
  fs.writeFileSync(path.join(state, "inflight-left"), String(inflight));
  // The "WhatsApp channel": a stray sleep, re-parented so it is reaped once signalled.
  const waPid = execFileSync("/bin/sh", ["-c", "sleep 120 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(state, "wa.pid"), waPid);
  return { home, state, waPid: Number(waPid) };
}

function cleanup(fx) {
  try { process.kill(fx.waPid, "SIGKILL"); } catch {}
  fs.rmSync(fx.home, { recursive: true, force: true });
}

function runRestart(fx, args, { marker = null } = {}) {
  const env = {
    PATH: `${path.join(fx.home, "fakebin")}:/usr/bin:/bin`, HOME: fx.home, JORI_HOME: path.join(fx.home, "install"), NO_COLOR: "1", FAKE_STATE: fx.state,
    JORI_PORT_PROCESS_MANAGER: PORTS.pm, JORI_PORT_WHATSAPP: PORTS.wa, JORI_PORT_CHAT_HEALTH: PORTS.chat,
  };
  if (marker) env.JORI_DISPATCH_URL = marker;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin/jori"), "restart", ...args], { encoding: "utf8", timeout: 60000, env });
  return { ...r, ms: Date.now() - t0 };
}

const read = (fx, f) => { try { return fs.readFileSync(path.join(fx.state, f), "utf8"); } catch { return ""; } };
const jobRuns = (fx) => read(fx, "jobrun.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const curlLog = (fx) => read(fx, "curl.log").split("\n").filter(Boolean);
const CHAT_MARKER = `http://127.0.0.1:${PORTS.chat}/dispatch`;

it("from the chat agent, `restart whatsapp session` restarts WhatsApp now and hands the session restart to one detached job", () => {
  const fx = fixture({ inflight: 1 });
  try {
    const r = runRestart(fx, ["whatsapp", "session"], { marker: CHAT_MARKER });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(r.ms < 15000, `took ${r.ms} ms`);
    assert.match(r.stdout, /whatsapp-channel restarted — new pid 424242/);
    assert.match(r.stdout, /whole-session restart handed off \(background job 20261105-000000-restart-fake-0000\)/);
    assert.equal(read(fx, "service-manager.log"), "", "launchctl/systemctl must not run inside the chat turn");
    const runs = jobRuns(fx), [run] = runs;
    assert.equal(runs.length, 1);
    assert.equal(run.waAlive, false, "the WhatsApp restart ran before the hand-off");
    assert.equal(run.marker, false, "the job must not look like the chat session, or it would hand off again");
    const sep = run.argv.indexOf("--");
    assert.deepEqual(run.argv.slice(sep + 2), [fs.realpathSync(path.join(ROOT, "bin/jori")), "restart", "session", "--after-chat-turn=turn-1"]);
    const flags = run.argv.slice(0, sep);
    assert.equal(flags[flags.indexOf("--tier") + 1], "ops-light");
    assert.equal(flags[flags.indexOf("--name") + 1], "restart-session");
    const notify = flags[flags.indexOf("--notify-task") + 1];
    for (const part of ["{{id}}", "{{status}}", "jori-send-curl"]) assert.ok(notify.includes(part), notify);
  } finally { cleanup(fx); }
});

it("from the chat agent, `restart chat` returns at once without touching the chat supervisor", () => {
  const fx = fixture({ inflight: 1 });
  try {
    const r = runRestart(fx, ["chat"], { marker: CHAT_MARKER });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(r.ms < 5000, `took ${r.ms} ms`);
    assert.match(r.stdout, /chat restart handed off/); // lang-regex-ok: asserts this CLI's own fixed output, not a person's words
    assert.ok(!curlLog(fx).includes("POST chat-restart"), curlLog(fx).join("\n"));
    assert.deepEqual(jobRuns(fx).map((j) => j.argv.slice(-3)), [["restart", "chat", "--after-chat-turn=turn-1"]]);
  } finally { cleanup(fx); }
});

it("without the chat marker (or with another supervisor's), `restart chat` restarts inline as before", () => {
  for (const marker of [null, "http://127.0.0.1:59092/dispatch"]) {
    const fx = fixture();
    try {
      const r = runRestart(fx, ["chat"], { marker });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /✓ chat supervisor restarted \(session s1 resumed; restartCount 3→4; agents.json re-read\)/); // lang-regex-ok: asserts this CLI's own fixed output, not a person's words
      assert.ok(curlLog(fx).includes("POST chat-restart"));
      assert.equal(jobRuns(fx).length, 0);
    } finally { cleanup(fx); }
  }
});

it("the job's own run waits for the chat turn to end, then restarts and checks for a new session", () => {
  const fx = fixture({ inflight: 2 });
  try {
    const r = runRestart(fx, ["chat", "--after-chat-turn=turn-1"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /waiting for chat turn turn-1 to end/); // lang-regex-ok: asserts this CLI's own fixed output, not a person's words
    assert.match(r.stdout, /✓ chat supervisor restarted \(session s1 resumed at B; restartCount 3→4/); // lang-regex-ok: asserts this CLI's own fixed output, not a person's words
    const log = curlLog(fx);
    assert.ok(log.indexOf("POST chat-restart") > log.lastIndexOf("GET chat-health inflight"), log.join("\n"));
    assert.equal(jobRuns(fx).length, 0);
  } finally { cleanup(fx); }
});
}

// ─── 5. triage code-filed: intake-filed mail joined to later label/star changes ──
//
// (2026-11-10) `jori triage code-filed` lists every message intake filed in
// code with no model reading it (sender-history consensus, Jev, an
// intake-skip rule, the spam blocklist; on the live path or a catchup) and
// joins it on messageId to the gmail-action LABEL / UNLABEL / STAR / UNSTAR
// events the same message got afterwards. Intake's own events, a re-delivery
// re-applying the same call and labels outside the triage set are not
// changes. Fixture install (JORI_HOME) holding a synthetic triage log (live +
// rotated days); the run must leave every file untouched.
{
const ID = Object.fromEntries("abcdefghjk".split("").map((k) => [k, `fixture-msg-${k}`]));

function codeFiledFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jori-code-filed-"));
  const tools = path.join(home, "install");
  for (const d of ["logs", "data", "system"]) fs.mkdirSync(path.join(tools, d), { recursive: true });
  const now = Date.now();
  const at = (min) => new Date(now - min * 60_000).toISOString();
  const sec = (min, s) => new Date(now - min * 60_000 + s * 1000).toISOString();
  const L = (ts, rest) => `${ts} | ${rest}\n`;

  // Rotated day, three days back: A filed by sender history.
  const rotatedDay = new Date(now - 3 * 86_400_000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(tools, "logs", `triage-${rotatedDay}.log`),
    L(sec(4320, -2), `LABEL | messageId=${ID.a} | label=personal`) +
    L(sec(4320, -1), `MARK-READ | messageId=${ID.a}`) +
    L(at(4320), `local-classify intake ${ID.a} from a@example.com → personal/P3 (mem-consensus) — dispatch skipped`));
  // Nine days back, outside a 7-day window.
  const oldDay = new Date(now - 9 * 86_400_000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(tools, "logs", `triage-${oldDay}.log`),
    L(at(9 * 1440), `local-classify intake ${ID.g} from g@example.com → personal/P3 (mem-consensus) — dispatch skipped`));

  fs.writeFileSync(path.join(tools, "logs", "triage.log"),
    // A, two days after filing: starred, then p1.
    L(at(2880), `STAR | messageId=${ID.a}`) +
    L(at(2879), `LABEL | messageId=${ID.a} | label=p1`) +
    // F filed by decision consensus; a later label outside the triage set is not a change.
    L(sec(2000, -1), `LABEL | messageId=${ID.f} | label=personal`) +
    L(at(2000), `local-classify intake ${ID.f} from f@example.com → personal/P3 (decision-consensus) — dispatch skipped`) +
    L(at(1990), `LABEL | messageId=${ID.f} | label=assistant-out`) +
    // J: a storm catchup's fast path, starred at intake, unstarred later.
    L(sec(1500, -2), `LABEL | messageId=${ID.j} | label=vendor`) +
    L(sec(1500, -1), `STAR | messageId=${ID.j}`) +
    L(at(1500), `storm-catchup intake-skip (fastpath) ${ID.j}: intake-skip rule=build-ready -> label=vendor+star(P2) applied=true`) +
    L(at(1400), `UNSTAR | messageId=${ID.j}`) +
    // K: a startup catchup's fast path, left alone.
    L(sec(1000, -1), `LABEL | messageId=${ID.k} | label=personal`) +
    L(at(1000), `startup-catchup intake-skip (fastpath) ${ID.k}: intake-skip rule=digest -> label=personal applied=true`) +
    // D: a live intake-skip rule that stars.
    L(sec(500, -2), `LABEL | messageId=${ID.d} | label=personal`) +
    L(sec(500, -1), `STAR | messageId=${ID.d}`) +
    L(at(500), `intake-skip rule=build-ready ${ID.d} from d@example.com → label=personal applied=true`) +
    // E: spam blocklist.
    L(sec(400, -1), `MARK-READ | messageId=${ID.e}`) +
    L(at(400), `spam-blocklist(sender) intake skip ${ID.e} from e@example.com (matches "e@example.com" (noise))`) +
    // H: booking withheld from the filter and dispatched — not code-filed.
    L(at(300), `booking-check ${ID.h} from h@example.com → booking (rule) — intake-skip rule=x withheld, dispatching`) +
    // C: Jev, delivered twice a few seconds apart (its second label is intake's own).
    L(sec(200, -1), `LABEL | messageId=${ID.c} | label=vendor`) +
    L(at(200), `jev-classify intake ${ID.c} from c@example.com → vendor/P3 (jev) — dispatch skipped`) +
    L(sec(200, 4), `LABEL | messageId=${ID.c} | label=vendor`) +
    L(sec(200, 5), `jev-classify intake ${ID.c} from c@example.com → vendor/P3 (jev) — dispatch skipped`) +
    // B: Jev, relabelled later.
    L(sec(60, -1), `LABEL | messageId=${ID.b} | label=vendor`) +
    L(at(60), `jev-classify intake ${ID.b} from b@example.com → vendor/P3 (jev) — dispatch skipped`) +
    L(at(20), `LABEL | messageId=${ID.b} | label=personal`) +
    L(at(19), `UNLABEL | messageId=${ID.b} | label=vendor`));
  return { home, tools };
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const st = fs.statSync(p); out[path.relative(dir, p)] = `${st.size}:${st.mtimeMs}`; } } };
  walk(dir);
  return out;
}

function runCodeFiled(fx, args) {
  return spawnSync(process.execPath, [path.join(ROOT, "bin/jori"), "triage", "code-filed", ...args], {
    encoding: "utf8", timeout: 30000,
    env: { PATH: "/usr/bin:/bin", HOME: fx.home, JORI_HOME: fx.tools, NO_COLOR: "1" },
  });
}

const NOT_SEEN = [
  "\"changed\" is a floor: a wrong call nobody corrected on the message itself (fixed by a rule, or never noticed) is not counted.",
  "Changes made in the Gmail app, or through the agents' Gmail connector tools, are invisible.",
];

it("triage code-filed joins each intake-filed message to later label/star changes, and writes nothing", () => {
  const fx = codeFiledFixture();
  try {
    const before = snapshot(fx.tools);
    const r = runCodeFiled(fx, ["--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(snapshot(fx.tools), before, "the report must not create or touch any file");

    const ids = out.rows.map((x) => x.messageId).sort();
    assert.deepEqual(ids, [ID.a, ID.b, ID.c, ID.d, ID.e, ID.f, ID.j, ID.k].sort(), "outside the window (G) and dispatched (H) mail are not code-filed");
    const row = Object.fromEntries(out.rows.map((x) => [x.messageId, x]));

    assert.equal(row[ID.a].handler, "local-classify:mem-consensus");
    assert.deepEqual(row[ID.a].changes.map((x) => x.change), ["starred", "raised to P1"]);
    assert.deepEqual(row[ID.b].changes.map((x) => x.change), ["relabelled personal", "vendor removed"]);
    assert.deepEqual(row[ID.c].changes, [], "a re-delivery re-applying the same label is not a change");
    assert.equal(row[ID.d].handler, "intake-skip:build-ready");
    assert.equal(row[ID.d].filed_priority, "P2", "intake's own star is part of what it filed");
    assert.equal(row[ID.d].changed, false);
    assert.equal(row[ID.e].family, "spam-blocklist");
    assert.equal(row[ID.e].changed, false);
    assert.deepEqual(row[ID.f].changes, [], "a label outside the triage set is not a relabel");
    assert.deepEqual([row[ID.j].handler, row[ID.j].filed_label, row[ID.j].filed_priority], ["intake-skip:build-ready", "vendor", "P2"], "a catchup fast path is code-filed too");
    assert.deepEqual(row[ID.j].changes.map((x) => x.change), ["unstarred"]);
    assert.deepEqual([row[ID.k].handler, row[ID.k].changed], ["intake-skip:digest", false]);

    const h = Object.fromEntries(out.handlers.map((x) => [x.handler, x]));
    assert.deepEqual([h["intake-skip"].filed, h["intake-skip"].changed], [3, 1]);
    assert.deepEqual([h["jev-classify"].filed, h["jev-classify"].changed], [2, 1]);
    assert.deepEqual([h["local-classify:mem-consensus"].changed, h["local-classify:decision-consensus"].changed, h["spam-blocklist"].changed], [1, 0, 0]);
    assert.deepEqual([out.totals.filed, out.totals.changed, out.totals.rate_pct], [8, 3, 37.5]);
    assert.deepEqual(out.not_seen, NOT_SEEN);

    const human = runCodeFiled(fx, []);
    assert.equal(human.status, 0, human.stderr);
    assert.ok(human.stdout.includes("8 filed, 3 relabelled or starred afterwards (37.5%)"), human.stdout);
    for (const n of NOT_SEEN) assert.ok(human.stdout.includes(n), human.stdout);
  } finally { fs.rmSync(fx.home, { recursive: true, force: true }); }
});

it("triage code-filed refuses a bare, non-positive or too-long --days instead of using 7", () => {
  const fx = codeFiledFixture();
  try {
    for (const args of [["--days"], ["--days", "--json"], ["--days", "0"], ["--days", "-3"], ["--days", "45"], ["--days", "2.5"]]) {
      const r = runCodeFiled(fx, args);
      assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}`);
      assert.ok(r.stderr.includes("--days"), r.stderr);
      assert.equal(r.stdout, "", `${args.join(" ")} must print no report`);
    }
    assert.ok(runCodeFiled(fx, ["--days"]).stderr.includes("--days needs a value"), "a bare --days says what is missing");
    assert.equal(runCodeFiled(fx, ["--days", "30"]).status, 0);
  } finally { fs.rmSync(fx.home, { recursive: true, force: true }); }
});
}

// ─── 6. doctor: LaunchAgent-owned triggers, transient services ──────────

it("doctor: a LaunchAgent-launched trigger is owned; a transient service's absent plist is fine", () => {
  const plist = (script) => `<?xml version="1.0"?><plist><dict><key>ProgramArguments</key><array><string>/x/agent/scripts/${script}</string></array></dict></plist>`;
  const checks = doctorChecks({
    tasks: [],
    cronLines: [],
    execs: {
      "agent/scripts/trigger-zz-launchd-only.sh": "#!/bin/sh\n",
      "agent/scripts/trigger-zz-nobody.sh": "#!/bin/sh\n",
      "agent/launch-agents/ai.claude.zz-launchd-only.plist": plist("trigger-zz-launchd-only.sh"),
    },
    services: [
      { name: "zz-transient", type: "launchagent", label: "ai.claude.zz-transient", plist: "~/Library/LaunchAgents/ai.claude.zz-transient.plist", transient: true },
      { name: "zz-gone", type: "launchagent", label: "ai.claude.zz-gone", plist: "~/Library/LaunchAgents/ai.claude.zz-gone.plist" },
    ],
  });
  const orphans = findCheck(checks, "trigger scripts in tasks.json");
  assert.equal(orphans.ok, false);
  assert.ok(orphans.detail.includes("trigger-zz-nobody.sh"), orphans.detail);
  assert.ok(!orphans.detail.includes("trigger-zz-launchd-only.sh"), orphans.detail);
  const plists = findCheck(checks, "services.json plists exist");
  assert.equal(plists.ok, false);
  assert.ok(plists.detail.includes("ai.claude.zz-gone"), plists.detail);
  assert.ok(!plists.detail.includes("zz-transient"), plists.detail);
});
