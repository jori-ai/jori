// daily-summary-lock.test.mjs — the per-date lock  that
// serializes the daily-summary settle+prose+publish pipeline against the
// three relaunch sources (scheduled cron, watchdog cron-miss self-heal,
// manual "DAILY SUMMARY [date]" redispatch) that can otherwise interleave and
// hit the publish guard's permanent, unrecovered refusal (the
// day_2026-07-27 wiki page never rendered until manually backfilled).
//
// Covers:
//   - a second acquire for the SAME date blocks while the first holds it,
//     and proceeds once the first releases (the actual race being fixed)
//   - a second acquire for a DIFFERENT date is unaffected (not globally
//     serialized — only same-date relaunches should collide)
//   - a holder that dies without releasing (crash, not a clean exit) does
//     NOT wedge the lock forever — shlock's own pid-liveness check lets the
//     next acquire steal it almost immediately, never after the full timeout
//   - acquire times out (not livelock) when a live holder never releases
//   - release is idempotent
//   - a holder that stays ALIVE but never releases (a hang, or an orphaned
//     child of a finished job) is force-reclaimed once the lock outlives the
//     stale-age ceiling (2026-07-29 fix)
//
// Run: node --test tests/daily-summary-lock.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_BIN = path.join(ROOT, "bin", "daily-summary-lock");
// daily-summary-lock hardcodes $HOME/Dev/jori (lowercase "dev") for its
// lock dir, independent of whatever case this repo checkout happens to be
// mounted under (this sandbox has been seen as both .../Dev/jori and
// .../Dev/jori). Derive the expected path the SAME way the script does —
// comparing against a path built from import.meta.url would silently diverge
// on a case-insensitive filesystem when the checkout is mounted as "Dev".
const LOCK_DIR = path.join(os.homedir(), "Dev", "jori", "data", "locks");

// Distinct, obviously-fake dates per test so a real daily-summary lock file
// (if one happens to be held on the actual machine at test time) can never
// collide with the test's own locks.
let dateCounter = 0;
function testDate() {
  dateCounter += 1;
  return `2099-01-${String(dateCounter).padStart(2, "0")}`;
}

function lockPathFor(date) {
  return path.join(LOCK_DIR, `daily-summary-${date}.lock`);
}

function cleanup(date) {
  try { fs.unlinkSync(lockPathFor(date)); } catch {}
}

// Kill a holder's ENTIRE process group, not just the immediate bash process.
// `daily-summary-lock acquire` runs as `bash -c "...; sleep N"` — signalling
// only the bash pid leaves the `sleep` grandchild orphaned and still holding
// its inherited copy of the stdout pipe open, which then keeps this test
// file's own node --test process alive (waiting on a pipe that never sees
// EOF) long after every assertion has already passed. `detached: true` below
// makes the holder a process-group leader; a negative pid targets the group.
function killHolder(child, signal = "SIGKILL") {
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch {} }
}

// Spawn a long-lived "holder" that acquires the lock and then sleeps, so the
// lock stays held until we kill or wait it out. Returns the child + a promise
// that resolves with the acquired lock path once acquire succeeds (parsed
// from stdout), or rejects on failure.
function spawnHolder(date, { timeout = 30, sleepSeconds = 60 } = {}) {
  // Capture $$ into MY_PID BEFORE the command substitution and pass it
  // explicitly — see daily-summary-lock's header (and daily-summary-run's
  // own call site) for why relying on the $PPID default breaks the instant
  // there's a further statement (the `sleep`) after the acquire call: bash
  // forks a real subshell for the substitution, and that subshell's pid
  // isn't this process's pid.
  const child = spawn("bash", ["-c",
    `MY_PID=$$; LOCKPATH=$("${LOCK_BIN}" acquire "${date}" ${timeout} "$MY_PID") || exit 1; echo "$LOCKPATH"; sleep ${sleepSeconds}`
  ], { detached: true });
  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  const acquired = new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (stdout.includes(lockPathFor(date))) {
        clearInterval(check);
        resolve(stdout.trim());
      }
    }, 50);
    child.on("exit", (code) => {
      clearInterval(check);
      if (!stdout.includes(lockPathFor(date))) reject(new Error(`holder exited (code ${code}) before acquiring`));
    });
    setTimeout(() => { clearInterval(check); reject(new Error("holder never acquired within 5s")); }, 5000);
  });
  return { child, acquired };
}

test("acquire succeeds immediately when the date is unlocked", () => {
  const date = testDate();
  const r = spawnSync(LOCK_BIN, ["acquire", date, "5"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), lockPathFor(date));
  assert.ok(fs.existsSync(lockPathFor(date)), "lock file should exist after acquire");
  cleanup(date);
});

test("release removes the lock file and is idempotent", () => {
  const date = testDate();
  spawnSync(LOCK_BIN, ["acquire", date, "5"], { encoding: "utf8" });
  assert.ok(fs.existsSync(lockPathFor(date)));
  const r1 = spawnSync(LOCK_BIN, ["release", date], { encoding: "utf8" });
  assert.equal(r1.status, 0);
  assert.ok(!fs.existsSync(lockPathFor(date)));
  // Releasing again (nothing held) must not error — mirrors the EXIT trap
  // firing on a run that never actually acquired anything.
  const r2 = spawnSync(LOCK_BIN, ["release", date], { encoding: "utf8" });
  assert.equal(r2.status, 0);
});

test("a second relaunch for the SAME date blocks until the first releases (the actual race)", async () => {
  const date = testDate();
  const holder = spawnHolder(date, { timeout: 30, sleepSeconds: 60 });
  await holder.acquired;

  // A second acquire for the same date must NOT succeed while the holder is
  // still alive and holding it — this is precisely the interleaving that let
  // two daily-summary relaunches stomp on the same /tmp/ds-day-<date>.json.
  const before = Date.now();
  const second = spawn(LOCK_BIN, ["acquire", date, "3"]);
  const secondResult = await new Promise((resolve) => {
    let out = "";
    second.stdout.on("data", (d) => { out += d.toString(); });
    second.on("exit", (code) => resolve({ code, out }));
  });
  const elapsedMs = Date.now() - before;

  assert.equal(secondResult.code, 1, "second acquire must fail (timeout) while the first holds the lock");
  assert.equal(secondResult.out.trim(), "", "a failed acquire must print nothing to stdout");
  assert.ok(elapsedMs >= 3000, `second acquire should have waited out its ~3s timeout, only took ${elapsedMs}ms`);

  // Now release the holder's lock (simulating the trap firing at the end of
  // daily-summary-run) and confirm a fresh acquire succeeds right away.
  killHolder(holder.child, "SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
  const r3 = spawnSync(LOCK_BIN, ["release", date], { encoding: "utf8" });
  assert.equal(r3.status, 0);
  const r4 = spawnSync(LOCK_BIN, ["acquire", date, "5"], { encoding: "utf8" });
  assert.equal(r4.status, 0, r4.stderr);
  cleanup(date);
});

test("locks are scoped per date — a different date is never blocked by another date's holder", async () => {
  const dateA = testDate();
  const dateB = testDate();
  const holderA = spawnHolder(dateA, { timeout: 30, sleepSeconds: 10 });
  await holderA.acquired;

  const rB = spawnSync(LOCK_BIN, ["acquire", dateB, "5"], { encoding: "utf8" });
  assert.equal(rB.status, 0, "acquiring an unrelated date must not be blocked by dateA's holder");
  assert.equal(rB.stdout.trim(), lockPathFor(dateB));

  killHolder(holderA.child, "SIGTERM");
  cleanup(dateA);
  cleanup(dateB);
});

test("a holder that dies WITHOUT releasing does not wedge the lock — shlock's pid-liveness check reclaims it almost immediately", async () => {
  const date = testDate();
  const holder = spawnHolder(date, { timeout: 30, sleepSeconds: 120 });
  await holder.acquired;
  assert.ok(fs.existsSync(lockPathFor(date)));

  // SIGKILL — no trap, no cleanup, mirrors a genuine crash (not the graceful
  // SIGTERM path daily-summary-run's own EXIT trap would take). Kill only the
  // bash holder itself here (not its process group) — the whole point of
  // this test is to verify shlock reclaims the lock even though the orphaned
  // `sleep` grandchild is deliberately left running, exactly as a real crash
  // would orphan it.
  holder.child.kill("SIGKILL");
  await new Promise((resolve) => holder.child.on("exit", resolve));

  // The lock FILE is still there (shlock doesn't auto-delete on crash) but a
  // fresh acquire must succeed quickly — shlock reads the recorded pid,
  // finds it's dead, and steals the lock — never waiting anywhere near the
  // full timeout. This is the property that rules out "a lock that never
  // releases on a crash" as a new failure mode.
  const before = Date.now();
  const r = spawnSync(LOCK_BIN, ["acquire", date, "20"], { encoding: "utf8" });
  const elapsedMs = Date.now() - before;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), lockPathFor(date));
  assert.ok(elapsedMs < 5000, `stale-lock reclaim took ${elapsedMs}ms — should be near-instant, not waiting out the poll loop`);
  cleanup(date);
  // Test hygiene only (does not affect the assertions above): the deliberately
  // orphaned `sleep 120` grandchild is still running and would otherwise hold
  // this test file's own process alive for two minutes via its inherited
  // stdout pipe. Reap the whole group now that the crash scenario is proven.
  killHolder(holder.child, "SIGKILL");
});

test("a holder that stays alive but never releases is force-reclaimed once the lock outlives the stale-age ceiling (2026-07-29)", async () => {
  const date = testDate();
  // sleepSeconds long enough to still be alive well past our short stale-age
  // ceiling below — this simulates the real incident: a holder that shlock's
  // pid-liveness check correctly reports as alive, but that never calls
  // release and never exits on its own (a hang, or an orphaned child of a
  // finished job) — the gap the age ceiling exists to close.
  const holder = spawnHolder(date, { timeout: 30, sleepSeconds: 30 });
  await holder.acquired;
  assert.ok(fs.existsSync(lockPathFor(date)));

  // A second acquire with a 2s stale-age ceiling (5th arg) must succeed well
  // before its own 20s timeout — it should detect the lock is older than 2s,
  // force-reclaim, and grab it on the next loop tick, even though the first
  // holder is still very much alive (never killed here).
  const before = Date.now();
  const r = spawnSync(LOCK_BIN, ["acquire", date, "20", String(process.pid + 1), "2"], { encoding: "utf8" });
  const elapsedMs = Date.now() - before;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), lockPathFor(date));
  assert.match(r.stderr, /WARNING.*force-reclaiming/, "should log the distinct stale-alive reclaim warning");
  assert.ok(elapsedMs < 10000, `stale-age reclaim took ${elapsedMs}ms — should reclaim within a couple poll ticks of the 2s ceiling, not wait out the 20s timeout`);

  cleanup(date);
  killHolder(holder.child, "SIGKILL");
});

test("acquire rejects a malformed date instead of silently locking the wrong key", () => {
  const r = spawnSync(LOCK_BIN, ["acquire", "not-a-date", "5"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});
