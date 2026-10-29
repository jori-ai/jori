// Crash-safety of the CI keychain mutex in .github/scripts/ci-keychain-lock.sh
// (2026-07-28).
//
// The original lock was a bare `mkdir` with no owner and no expiry. A signing
// job SIGKILLed between acquire and release — cancelled workflow, runner
// restart, machine sleep — held /tmp/gandalf-ci-keychain.lock forever, and
// every later job then spun the full timeout and proceeded UNSYNCHRONIZED. The
// serialization silently disappeared exactly when builds were being cancelled
// most, i.e. precisely when it was needed.
//
// Two independent protections cover the two distinct death modes, and BOTH are
// asserted here because neither alone is sufficient: a `trap ... EXIT` cannot
// survive SIGKILL, and stale-breaking alone would hold the lock for the full
// 5-minute window on every ordinary step failure.
//
// Everything runs against an isolated $KC_LOCK in a temp dir — these tests
// never read or mutate the real keychain search list.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, ".github/scripts/ci-keychain-lock.sh");

// Run a bash snippet with the lock script sourced and an isolated lock path.
// Returns {stdout, lockExists}. Never throws on non-zero exit — several cases
// deliberately kill or fail the shell.
function sh(snippet, { lock, env = {} } = {}) {
  const script = `
    exec 2>&1   # the script's warnings go to stderr; fold them in so assertions see them
    export KC_LOCK=${JSON.stringify(lock)}
    export KC_LOCK_WAIT_SECS=\${KC_LOCK_WAIT_SECS:-3}
    export KC_LOCK_STALE_SECS=\${KC_LOCK_STALE_SECS:-2}
    source ${JSON.stringify(SRC)}
    ${snippet}
  `;
  let stdout = "";
  try {
    stdout = execFileSync("bash", ["-c", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
  } catch (e) {
    stdout = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  return { stdout, lockExists: fs.existsSync(lock) };
}

function freshLock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kclock-"));
  return path.join(dir, "test.lock");
}

test("the lock script exists and is syntactically valid", () => {
  assert.ok(fs.existsSync(SRC), `${SRC} is missing — the workflows source it`);
  execFileSync("bash", ["-n", SRC]);
});

test("acquire creates the lock, and the EXIT trap releases it", () => {
  const lock = freshLock();
  const r = sh(`kc_lock_acquire; [ -d "$KC_LOCK" ] && echo held`, { lock });
  assert.match(r.stdout, /held/, "lock dir was not created on acquire");
  assert.equal(r.lockExists, false, "lock leaked after a normal exit");
});

test("a step that FAILS mid-critical-section still releases (trap)", () => {
  const lock = freshLock();
  // `set -e` + false => shell aborts inside the critical section.
  const r = sh(`set -e; kc_lock_acquire; false; echo unreachable`, { lock });
  assert.doesNotMatch(r.stdout, /unreachable/);
  assert.equal(r.lockExists, false, "lock leaked when the step failed");
});

test("SIGKILL leaks the lock — the case staleness exists to cover", () => {
  const lock = freshLock();
  const r = sh(`kc_lock_acquire; kill -9 $$`, { lock });
  assert.equal(r.lockExists, true, "expected SIGKILL to leak (no trap can run)");
});

test("a FRESH leaked lock is respected, not stolen", () => {
  const lock = freshLock();
  sh(`kc_lock_acquire; kill -9 $$`, { lock });
  // Long stale window => the leaked lock is still considered live.
  const r = sh(`kc_lock_acquire; echo "held=$KC_LOCK_HELD"`, {
    lock,
    env: { KC_LOCK_WAIT_SECS: "1", KC_LOCK_STALE_SECS: "9999" },
  });
  assert.match(r.stdout, /held=0/, "stole a lock that was still fresh");
  assert.match(r.stdout, /proceeding UNSERIALIZED/, "no warning when giving up");
});

test("a STALE leaked lock is broken, loudly, and acquired", async () => {
  const lock = freshLock();
  sh(`kc_lock_acquire; kill -9 $$`, { lock });
  await new Promise((r) => setTimeout(r, 2500)); // exceed KC_LOCK_STALE_SECS=2
  const r = sh(`kc_lock_acquire; echo "held=$KC_LOCK_HELD"`, { lock });
  assert.match(r.stdout, /held=1/, "failed to break a stale lock");
  assert.match(r.stdout, /breaking STALE lock/, "stale break was not logged");
});

test("release is owner-guarded — a non-owner cannot delete the lock", () => {
  const lock = freshLock();
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner"), `other 999 ${Math.floor(Date.now() / 1000)}\n`);
  const r = sh(`kc_lock_release`, { lock });
  assert.equal(r.lockExists, true, "a non-owner deleted someone else's lock");
});

test("acquire is bounded and returns 0, so callers are safe under `set -e`", () => {
  const lock = freshLock();
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner"), `other 999 ${Math.floor(Date.now() / 1000)}\n`);
  const started = Date.now();
  // Under `set -e`, a non-zero acquire would abort before `after`.
  const r = sh(`set -e; KC_LOCK_STALE_SECS=9999 kc_lock_acquire; echo after`, {
    lock,
    env: { KC_LOCK_WAIT_SECS: "2" },
  });
  const elapsed = (Date.now() - started) / 1000;
  assert.match(r.stdout, /after/, "acquire returned non-zero and killed the step");
  assert.ok(elapsed < 15, `acquire hung for ${elapsed}s`);
});
