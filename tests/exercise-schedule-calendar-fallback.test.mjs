// exercise-schedule-calendar-fallback.test.mjs
//
// Regression guard for exercise-calendar-fallback-silent-skip.
//
// WHAT BROKE. On consecutive days no exercise block was placed on the user's
// calendar, and every run reported success. Three independent defects lined up:
//
//   1. `getTodayEvents()` had NO retry. One transient gog/network blip returned
//      the `_fetchFailed` sentinel, and in `main()` that branch writes the
//      defensive fallback state row and `process.exit(0)` WITHOUT ever reaching
//      `createExerciseEvent()`. A failure of the calendar READ therefore
//      cancelled the calendar WRITE that is the job's entire purpose — and
//      exited 0, so every downstream check saw success.
//   2. `log()` wrote ONLY to stderr. The script ran inside an ops-agent turn,
//      so its stderr landed in an agent transcript and vanished. That is why
//      the outage ran for days unnoticed, and why a later agent turn paged the
//      user with an INVENTED mechanism that was verified false during review —
//      there was no trace to read, so it guessed.
//   3. The state file could not distinguish "the fallback slot because we chose
//      it" from "the fallback slot because we could not read the calendar":
//      `event_id` is null on BOTH paths.
//
// WHAT IS DELIBERATELY *NOT* FIXED. The `_fetchFailed` branch still does not
// create an event. Writing a block against an untrusted (empty) busy list could
// double-book a real meeting ("calendar read failure: log, skip silently for
// the day"). That is the user's decision to change, not a bug to patch — so
// this file asserts the skip is still there, to stop a well-meaning future fix
// from writing blind.
//
// WHY SOURCE INSPECTION RATHER THAN BEHAVIOUR. `bin/exercise-schedule`
// ends in a top-level async IIFE, so importing it RUNS it — it would hit the
// real calendar, the real workout tracker and the real phone channel. Rather
// than contort a working script into testability, this asserts the structural
// properties of the three fixes. It is a weaker test than a behavioural one and
// it is honest about that: it catches removal, not misbehaviour.
// (tests/exercise-config.test.mjs covers the config layer behaviourally.)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "bin/exercise-schedule");
const src = fs.readFileSync(SCRIPT, "utf8");

/**
 * Return the body of `function <name>(...) { ... }` by brace matching.
 * Deliberately not a regex: nested braces in the body defeat that, and a
 * silently-truncated body would make every assertion below meaningless.
 */
function fnBody(name) {
  const decl = `function ${name}(`;
  const at = src.indexOf(decl);
  assert.notEqual(at, -1, `${name}() is gone from bin/exercise-schedule`);
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces reading ${name}()`);
}

// ── Fix 1: the calendar read is retried ──────────────────────────────────────

test("getTodayEvents retries before returning the _fetchFailed sentinel", () => {
  const body = fnBody("getTodayEvents");

  assert.ok(
    body.includes("CAL_FETCH_ATTEMPTS"),
    "getTodayEvents no longer loops over CAL_FETCH_ATTEMPTS. Without a retry, ONE " +
    "transient gog failure silently cancels the whole day's calendar write — that is " +
    "exercise-calendar-fallback-silent-skip, days of no exercise block " +
    "all reported as success.",
  );
  assert.ok(
    body.includes("for (let attempt = 1"),
    "the retry loop in getTodayEvents is gone",
  );
  assert.ok(
    body.includes("sleepSync("),
    "the retry no longer backs off between attempts — hammering gog three times in " +
    "the same millisecond retries nothing useful",
  );

  // The sentinel must be reachable only AFTER the loop, never from inside it.
  const loopStart = body.indexOf("for (let attempt = 1");
  const sentinel = body.indexOf("_fetchFailed: true");
  assert.ok(sentinel > loopStart, "_fetchFailed sentinel must come after the retry loop");
  assert.equal(
    body.split("_fetchFailed: true").length - 1,
    1,
    "there must be exactly ONE give-up point in getTodayEvents; a second early return " +
    "is how the retry gets bypassed without anyone noticing",
  );
});

test("the retry budget stays small enough to finish inside one run", () => {
  const attempts = Number(/CAL_FETCH_ATTEMPTS = (\d+)/.exec(src)?.[1]); // lang-regex-ok: reads a numeric constant out of our own source
  assert.ok(attempts >= 2 && attempts <= 5, `CAL_FETCH_ATTEMPTS = ${attempts}, expected 2..5`);

  const backoff = /CAL_FETCH_BACKOFF_MS = \[([^\]]*)\]/.exec(src)?.[1] ?? ""; // lang-regex-ok: reads a numeric array out of our own source
  const waits = backoff.split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n));
  assert.ok(waits.length >= attempts - 1, "one backoff value per gap between attempts");
  const total = waits.reduce((a, b) => a + b, 0);
  assert.ok(
    total > 0 && total < 60_000,
    `backoff totals ${total}ms — must be non-zero (a retry with no pause retries nothing) ` +
    `and well under a minute (run() already caps each gog call at 30s)`,
  );
});

// ── Fix 2: the log persists to disk ──────────────────────────────────────────

test("log() also appends to data/logs/exercise-schedule.log", () => {
  const body = fnBody("log");

  assert.ok(
    body.includes("process.stderr.write"),
    "stderr logging must stay — the on-disk sink is IN ADDITION to it, not instead of it",
  );
  assert.ok(
    body.includes("appendFileSync") && body.includes("LOG_FILE"),
    "log() stopped persisting to disk. stderr alone is invisible when this script runs inside " +
    "an ops-agent turn, so its stderr lands in a transcript and vanishes. That is how " +
    "the silent skip ran for days unnoticed and was then mis-diagnosed from no evidence.",
  );
  assert.ok(
    body.includes("try {") && body.includes("catch"),
    "the log append must be wrapped in try/catch — a logging problem must never become " +
    "a scheduling problem",
  );
  // Append, never truncate: writeFileSync here would erase the trigger script's
  // own dispatch lines on every run.
  assert.ok(!body.includes("writeFileSync"), "log() must APPEND, not overwrite the shared log");
});

test("LOG_FILE is the same file the trigger script writes to", () => {
  assert.ok(
    src.includes("data/logs/exercise-schedule.log"),
    "LOG_FILE moved away from the path trigger-exercise-schedule.sh appends to, and the " +
    "path the job's playbook tells a reader to check",
  );
  const trigger = fs.readFileSync(path.join(ROOT, "agent/scripts/trigger-exercise-schedule.sh"), "utf8");
  assert.ok(
    trigger.includes("logs/exercise-schedule.log"),
    "the trigger script no longer shares this log — the two sinks have diverged",
  );
});

// ── Fix 3: the fallback is marked in the state file ──────────────────────────

test("writeStateFile stamps calendar_fetch_failed", () => {
  const body = fnBody("writeStateFile");
  assert.ok(
    body.includes("calendar_fetch_failed"),
    "the state row no longer records whether the calendar read failed. event_id is null " +
    "on BOTH the normal path and the fallback, so without this field nothing can tell " +
    "'the slot because we chose it' from 'the slot because we could not read the calendar'.",
  );
  assert.ok(
    body.includes("opts") && body.includes("calendarFetchFailed"),
    "calendar_fetch_failed must be driven by the caller, not hardcoded",
  );
  // Backward compatibility: existing 6-arg call sites must still be valid.
  assert.ok(
    body.includes("opts = {}") || src.includes("opts = {}"),
    "opts must default, or the four existing 6-argument call sites throw",
  );
});

test("only the _fetchFailed branch claims calendarFetchFailed: true", () => {
  const truthy = src.split("calendarFetchFailed: true").length - 1;
  assert.equal(
    truthy, 1,
    "exactly one call site may mark the row as a calendar-fetch fallback — the " +
    "_fetchFailed branch in main(). More than one means a real placement is being " +
    "mislabelled as a degraded one.",
  );
  assert.ok(
    src.includes("writeStateFile(todayStr, FALLBACK_SLOT, etOffset, null, isMakeupDay, null, { calendarFetchFailed: true })"),
    "the defensive fallback row is no longer the one carrying the marker",
  );
});

// ── The deliberate non-fix stays deliberate ──────────────────────────────────

test("the _fetchFailed branch still skips the day rather than writing blind", () => {
  const at = src.indexOf("if (_fetchFailed) {");
  assert.notEqual(at, -1, "the _fetchFailed branch in main() is gone");
  const branch = src.slice(at, src.indexOf("}", src.indexOf("process.exit(0)", at)));

  assert.ok(
    branch.includes("process.exit(0)"),
    "the fallback branch must still exit — changing its exit code was explicitly out of scope",
  );
  assert.ok(
    !branch.includes("createExerciseEvent"),
    "the _fetchFailed branch must NOT create a calendar event. An empty busy list from a " +
    "FAILED read is untrustworthy, and writing a block against it could double-book a real " +
    "meeting ('calendar read failure: log, skip silently for the day'). Lifting that is the " +
    "user's decision, not a fix. The retry makes a TRANSIENT failure not reach here and the " +
    "log + state marker make a PERSISTENT one visible — neither makes the job write blind.",
  );
});

test("the defended failure is named in the source, so the next reader knows what this defends", () => {
  assert.ok(
    src.includes("Regression guard — exercise-calendar-fallback-silent-skip"),
    "the guard comments naming the defended failure were removed from bin/exercise-schedule",
  );
});
