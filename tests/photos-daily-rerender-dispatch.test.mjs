// Regression guard for the stale-render repair in
// agent/scripts/trigger-photos-daily.sh (Step 4b).
//
// Defends against the failure that produced the 2026-10-05 00:01 UTC system
// alert — "daily-summary-run exited without producing output (DAILY SUMMARY
// 2026-09-26) — auth/empty (Failed to authenticate: OAuth session expired and
// could not be refreshed)" — wrongly implying a re-login was the remedy.
//
// photos-daily is a pure cron script. `daily-summary-run` forks a `claude -p`
// session, and a fork launched straight from cron has no route to the Max
// credential in the login keychain, so it dies within ten seconds every time.
// Measured 2026-10-02/03/04: six cron-launched repair forks for 2026-09-26 and
// 2026-09-27, six auth failures, zero re-renders — while the daily-summary run
// an hour later, dispatched through the supervisor, succeeded every night.
// agent/CLAUDE.md § Long-Running Jobs states the rule this broke:
// job-run "must be launched from an agent turn (inherits Max keychain auth),
// not straight from cron".
//
// So: the repair must be DISPATCHED to a supervisor, never forked in cron.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "agent", "scripts", "trigger-photos-daily.sh");
const src = readFileSync(SCRIPT, "utf8");

// Executable lines only — the file's comments deliberately quote the old,
// broken invocation to explain why it is gone.
const code = src
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"))
  .join("\n");

// Every binary this script actually RUNS is invoked as "$BIN/<name>" — the
// quoted form, used uniformly throughout the file ("$BIN/photos",
// "$BIN/findme", "$BIN/jori-send-curl"). The two names also appear unquoted
// inside the dispatched task text, which is the whole point of the fix, so the
// guard keys on the execution form rather than on the names.
const execLines = code
  .split("\n")
  .filter((l) => l.includes('"$BIN/job-run"') || l.includes('"$BIN/daily-summary-run"'));

test("photos-daily never forks daily-summary-run or job-run from cron", () => {
  assert.deepEqual(
    execLines,
    [],
    "trigger-photos-daily.sh runs in cron, which cannot reach the Max keychain. " +
      "A `claude -p` fork launched here fails auth within 10s, every time. " +
      "Dispatch the re-render to a supervisor instead (dispatch_rerender). " +
      "Offending line(s): " + JSON.stringify(execLines)
  );
});

test("the one surviving mention is the dispatched command string", () => {
  const cmdLine = code.split("\n").find((l) => l.includes("cmd="));
  assert.ok(cmdLine, "dispatch_rerender no longer builds a command string");
  assert.ok(cmdLine.includes("job-run"), "the dispatched command must use job-run");
  assert.ok(
    cmdLine.includes("daily-summary-run"),
    "the dispatched command must run daily-summary-run"
  );
  assert.ok(
    !cmdLine.trimStart().startsWith('"$BIN/'),
    "this line must BUILD the command, not execute it"
  );
});

test("the stale-render repair dispatches through the supervisor", () => {
  assert.ok(code.includes("dispatch_rerender"), "repair helper is missing");
  assert.ok(
    code.includes("dispatch_or_skip"),
    "the repair must go through dispatch_or_skip so it reaches a supervisor " +
      "with keychain auth (and is skipped cleanly when none is healthy)"
  );
  assert.ok(
    code.includes("lib/webhook-auth.sh"),
    "dispatch_or_skip comes from lib/webhook-auth.sh — it must be sourced"
  );
});

test("both ladder rungs dispatch, and SILENT is still distinct", () => {
  assert.match(code, /dispatch_rerender "\$date" ""/);
  assert.match(code, /dispatch_rerender "\$date" " SILENT"/);
  // ...and the SILENT rung has to survive into the command the agent runs.
  // Dropping $silent from cmd= would re-send a full email for a 9-day-old day.
  const cmdLine = code.split("\n").find((l) => l.includes("cmd="));
  assert.ok(
    cmdLine.includes("$date$silent"),
    "the dispatched command must carry the rung's SILENT token, not just $date"
  );
});

test("a malformed date is refused rather than interpolated into JSON", () => {
  assert.ok(
    code.includes("[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]"),
    "dispatch_rerender builds a JSON payload by interpolation; the date must " +
      "be shape-checked first"
  );
});
