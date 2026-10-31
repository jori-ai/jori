// Regression guard for bin/daily-summary-run's SSH guard (exit 4).
//
// Defends against this system-channel alert, which reads like a Max-auth outage
// and was not one:
//   "⚠️ daily-summary-run exited without producing output (DAILY SUMMARY
//    2026-10-12) — auth/empty (\"Not logged in · Please run /login\")"
// On 2026-10-13 at 01:16 home time an operator ran `daily-summary-run 2026-10-12`
// directly in an SSH session on the mini. It waited 6.6 min on the per-date lock
// behind a legitimate SILENT re-render, forked `claude -p`, and the fork failed
// in ~1s because an SSH session cannot reach the Max login in the GUI session's
// keychain (same constraint as cron). The auth/empty guard then paged. The same
// trap is in agent/logs/daily-summary-run.log on 2026-07-27 (x2), 07-30
// and 09-07 (x2). Cluster.
//
// The fix refuses to start from an SSH session (SSH_CONNECTION or SSH_CLIENT
// set) with exit 4, BEFORE the lock and before anything that can page, prints
// the dispatch-to-the-supervisor recipe on stderr, and pages nobody.
// DAILY_SUMMARY_ALLOW_SSH=1 is the operator's escape hatch.
//
// HERMETIC by construction: the REAL script runs with HOME pointed at a temp
// tree, because every path it touches is "$HOME/Dev/jori/...". So the lock it
// would take, the system-channel sender it would call and the log it writes are
// all stubs/files inside that temp tree, and CLAUDE_BIN is a stub too. Nothing
// here can take a real lock under data/locks, fork the real claude, or
// reach the real jori-send-curl. The lock stub always FAILS, so the cases
// that get past the guard stop at the lock (exit 3) and never reach the fork.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = process.env.DAILY_SUMMARY_RUN_SRC || path.join(ROOT, "bin/daily-summary-run");
const DATE = "2026-10-12";
const GUIDANCE = "refused to start, because this shell is an SSH session";

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ds-ssh-guard-"));
  const g = path.join(home, "Dev/jori");
  fs.mkdirSync(path.join(g, "agent/ops-agent/jobs"), { recursive: true });
  fs.mkdirSync(path.join(g, "agent/logs"), { recursive: true });
  fs.mkdirSync(path.join(g, "bin"), { recursive: true });
  fs.writeFileSync(path.join(g, "agent/ops-agent/jobs/daily-summary.md"), "# stub playbook\n");
  const marker = path.join(home, "calls.log");
  const stub = (name, rc) => {
    const p = path.join(g, "bin", name);
    fs.writeFileSync(p, `#!/bin/bash\necho "${name} $*" >> "${marker}"\nexit ${rc}\n`);
    fs.chmodSync(p, 0o755);
  };
  stub("daily-summary-lock", 1);  // fails, so a run that passes the guard stops at exit 3
  stub("jori-send-curl", 0);
  stub("local-day", 1);           // never needed (a DATE is always passed); fail loudly if reached
  const claude = path.join(home, "fake-claude");
  fs.writeFileSync(claude, `#!/bin/bash\necho "claude $*" >> "${marker}"\nexit 0\n`);
  fs.chmodSync(claude, 0o755);
  return { home, marker, claude, log: path.join(g, "agent/logs/daily-summary-run.log") };
}

function run(extraEnv, args = [DATE]) {
  const h = fakeHome();
  const env = { ...process.env, HOME: h.home, CLAUDE_BIN: h.claude };
  // Start from a known baseline whatever shell runs this suite (it may itself be
  // an SSH session); each case adds back only what it is testing.
  delete env.SSH_CONNECTION;
  delete env.SSH_CLIENT;
  delete env.SSH_TTY;
  delete env.DAILY_SUMMARY_ALLOW_SSH;
  Object.assign(env, extraEnv);
  const r = spawnSync("/bin/bash", [SCRIPT, ...args], { encoding: "utf8", env, timeout: 30000 });
  const calls = fs.existsSync(h.marker) ? fs.readFileSync(h.marker, "utf8") : "";
  const log = fs.existsSync(h.log) ? fs.readFileSync(h.log, "utf8") : "";
  fs.rmSync(h.home, { recursive: true, force: true });
  return { status: r.status, stderr: r.stderr, calls, log };
}

const SSH = { SSH_CONNECTION: "203.0.113.7 52144 192.168.1.20 22" };

function assertRefused(r, label) {
  assert.equal(r.status, 4, `${label}: expected exit 4 (SSH guard), got ${r.status}\n${r.stderr}`);
  assert.ok(r.stderr.includes(GUIDANCE), `${label}: stderr must explain the refusal:\n${r.stderr}`);
  assert.ok(r.stderr.includes("Nothing was built for " + DATE), `${label}: must say nothing was built`);
  assert.ok(r.stderr.includes("keychain"), `${label}: must say WHY (the keychain is not reachable over SSH)`);
  assert.ok(!r.calls.includes("daily-summary-lock"),
    `${label}: the guard must fire BEFORE the per-date lock — the 2026-10-13 run sat 6.6 min on it first:\n${r.calls}`);
  assert.ok(!r.calls.includes("jori-send-curl"),
    `${label}: the refusal must not page the system channel — that page is the noise being removed:\n${r.calls}`);
  assert.ok(!r.calls.includes("claude"), `${label}: no fork may be launched:\n${r.calls}`);
  assert.ok(r.log.includes("REFUSED: launched from an SSH session"), `${label}: the refusal must be logged:\n${r.log}`);
  assert.ok(r.log.includes("exit 4 (guard: SSH session"), `${label}: the exit must be logged:\n${r.log}`);
}

function assertPassedGuard(r, label) {
  assert.notEqual(r.status, 4, `${label}: the SSH guard fired when it must not have:\n${r.stderr}`);
  assert.ok(!r.stderr.includes(GUIDANCE), `${label}: guard message present:\n${r.stderr}`);
  assert.ok(r.calls.includes(`daily-summary-lock acquire ${DATE} 900`),
    `${label}: the run should have reached the lock (stubbed to fail):\n${r.calls}\n${r.stderr}`);
  assert.equal(r.status, 3, `${label}: the failing lock stub should end the run with exit 3:\n${r.stderr}`);
}

test("SSH_CONNECTION set: refused with exit 4 before the lock, nothing paged", () => {
  const r = run(SSH);
  assertRefused(r, "SSH_CONNECTION");
  // The remedy is the supervisor dispatch from jobs/daily-summary.md § Manual
  // recovery, with this run's own task line in it.
  assert.ok(r.stderr.includes("http://localhost:9092"), r.stderr);
  assert.ok(r.stderr.includes("secrets/webhook-token"), r.stderr);
  assert.ok(r.stderr.includes(`"task": "DAILY SUMMARY ${DATE}"`), r.stderr);
  assert.ok(r.stderr.includes("DAILY_SUMMARY_ALLOW_SSH=1"), "the escape hatch must be named");
});

test("SSH_CLIENT alone is enough to refuse", () => {
  assertRefused(run({ SSH_CLIENT: "203.0.113.7 52144 22" }), "SSH_CLIENT");
});

test("SILENT is carried into the dispatch recipe", () => {
  const r = run(SSH, [DATE, "SILENT"]);
  assertRefused(r, "SSH + SILENT");
  assert.ok(r.stderr.includes(`"task": "DAILY SUMMARY ${DATE} SILENT"`), r.stderr);
});

test("a --dry-run over SSH is refused WITHOUT suggesting a real DAILY SUMMARY dispatch", () => {
  const r = run(SSH, [DATE, "--dry-run"]);
  assertRefused(r, "SSH + --dry-run");
  assert.ok(!r.stderr.includes("localhost:9092"),
    "dispatching DAILY SUMMARY would run a REAL build (email + push) for what was asked as a dry run");
  assert.ok(r.stderr.includes("daily-summary-ab run " + DATE), r.stderr);
});

test("only the literal DAILY_SUMMARY_ALLOW_SSH=1 opens the escape hatch", () => {
  assertRefused(run({ ...SSH, DAILY_SUMMARY_ALLOW_SSH: "0" }), "ALLOW_SSH=0");
  assertRefused(run({ ...SSH, DAILY_SUMMARY_ALLOW_SSH: "yes" }), "ALLOW_SSH=yes");
});

test("SSH_CONNECTION + DAILY_SUMMARY_ALLOW_SSH=1: the guard steps aside", () => {
  assertPassedGuard(run({ ...SSH, DAILY_SUMMARY_ALLOW_SSH: "1" }), "ALLOW_SSH=1");
});

test("no SSH variables (every scheduled path): the guard does not fire, and `set -u` survives", () => {
  // The script runs `set -uo pipefail`. If the check ever used a bare
  // $SSH_CONNECTION, this case would die as an unbound variable before reaching
  // the lock — i.e. every scheduled run would be killed. This is that tripwire.
  const r = run({});
  assertPassedGuard(r, "no SSH vars");
  assert.ok(!r.stderr.includes("unbound variable"), r.stderr);
});

test("structurally: the SSH check precedes the lock acquire and every system-channel send", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const code = src.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  const guard = code.indexOf('${SSH_CONNECTION:-}${SSH_CLIENT:-}');
  const acquire = code.indexOf('"$LOCK_BIN" acquire');
  const firstSend = code.indexOf("jori-send-curl");
  assert.ok(guard > 0, "the SSH check is gone, or no longer uses `:-` defaults (mandatory under `set -u`)");
  assert.ok(acquire > 0, "the lock acquire moved; nothing to order against");
  assert.ok(guard < acquire, "the SSH check must run BEFORE the per-date lock is acquired");
  assert.ok(firstSend > 0 && guard < firstSend, "the SSH check must run before anything that can page");
  assert.ok(code.includes('"${DAILY_SUMMARY_ALLOW_SSH:-}" != "1"'), "the escape hatch must stay `:-`-guarded and literal");
  // No bare reference anywhere in the code (comments may quote it as a warning).
  for (const v of ["SSH_CONNECTION", "SSH_CLIENT", "DAILY_SUMMARY_ALLOW_SSH"]) {
    assert.ok(!code.includes("$" + v) && !code.includes("${" + v + "}"),
      `bare $${v} in code would abort under set -u wherever it is unset`);
  }
  // The guard block itself must never page.
  const block = code.slice(guard, code.indexOf("exit 4", guard));
  assert.ok(!block.includes("jori-send-curl"), "the SSH refusal must not call jori-send-curl");
});
