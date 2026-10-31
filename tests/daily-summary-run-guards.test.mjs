// Regression guard for bin/daily-summary-run's pre-fork guards.
//
// Defends against this exact system-channel alert:
//   "⚠️ daily-summary-run did NOT run (DAILY SUMMARY 2026-09-26) — auth/empty
//    output (\"\"). No build was attempted."
// Fired twice on 2026-10-01 at 03:02:11 and 03:02:12 home time, for 2026-09-26 and
// 2026-09-27, by two backfill forks that jobs/photos-daily.md's repair step
// launched via `job-run --name day-rerender`. Both job logs
// (data/logs/jobs/20261001-070211-day-rerender-3141.log and -bf2d.log)
// hold the same three lines: `mktemp: mkstemp failed on /var/folders/.../
// daily-summary-run.iCsKa7fmjJ: Operation not permitted`, then line 206's
// redirect failing, then `cat: : No such file or directory`.
//
// Mechanism. The script runs `set -uo pipefail` with NO `set -e`, and `set -u`
// does not fire on a variable that is SET but EMPTY. So a failed mktemp left
// OUT_TMP="" and execution continued: the fork's `> "$OUT_TMP"` redirect became
// `> ""` and failed, so `claude -p` NEVER RAN; `cat ""` / `grep ""` / `head ""`
// each errored; and the auth/empty guard's `[[ ! -s "$OUT_TMP" ]]` is trivially
// true of the empty string, so the run was paged as an auth failure. Auth was
// never involved — the normal 04:00 run on the same host an hour later exited 0 —
// and "re-login" was therefore the wrong remedy to put in front of the user.
// Cluster:.
//
// Asserted against the SOURCE TEXT rather than by running the script: every path
// through daily-summary-run forks a real `claude -p` and sends a real
// system-channel alert, so there is no seam to exercise offline. What matters is
// structural and therefore readable from source — that the temp file is checked,
// and that the check sits BEFORE the first use of it. ORDER is the property under
// test, so the ordering assertions compare character offsets; presence alone
// would pass a patch that put the guard after the fork.
//
// The third test pins the 2026-09-08 fix (cluster
// ): a killed run must be reported as
// killed, which only holds while the `(( RC > 128 ))` branch stays ABOVE the
// auth/empty grep. Same family of defect, same mislabel, so a later patch that
// reorders this region must fail here rather than silently re-break it.
//
// String scanning, not regex: the target is machine-written shell, and the
// claims are all "does this literal appear, and where".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Overridable so the same assertions can be pointed at an older revision of the
// script (e.g. `git show HEAD:bin/daily-summary-run`) to confirm they
// actually fail on the unpatched source. A test that passes before the fix is
// worthless.
const SRC_PATH = process.env.DAILY_SUMMARY_RUN_SRC
  || join(HERE, "..", "bin", "daily-summary-run");

const src = readFileSync(SRC_PATH, "utf8");

// Offsets of the landmarks the ordering claims are made about. -1 means absent,
// which every assertion below treats as a failure in its own words.
const at = (needle) => src.indexOf(needle);

const ASSIGN = 'OUT_TMP="$(mktemp';
const FORK_REDIRECT = '> "$OUT_TMP" 2>&1';   // the `claude -p` output redirect
const RC_CAPTURE = "MKTEMP_RC=$?";
const GUARD_COND = "(( MKTEMP_RC != 0 ))";
const GUARD_EMPTY = '-z "$OUT_TMP"';
const GUARD_LOG = 'log "exit 1 (guard: mktemp failed)"';

test("the script still looks like the one these guards were written against", () => {
  assert.ok(existsSync(SRC_PATH), `${SRC_PATH} missing`);
  assert.ok(at(ASSIGN) > 0, "the mktemp assignment moved or was renamed");
  assert.ok(at(FORK_REDIRECT) > 0,
    "the `claude -p ... > \"$OUT_TMP\" 2>&1` fork redirect moved — the ordering "
    + "assertions below have nothing to anchor against");
  assert.ok(at(ASSIGN) < at(FORK_REDIRECT),
    "the temp file is still created before the fork that writes to it");
});

test("mktemp's result is checked, and checked BEFORE the fork redirect uses it", () => {
  assert.ok(at(RC_CAPTURE) > 0,
    "mktemp's exit status is not captured. `set -u` does NOT fire on a set-but-"
    + "empty variable and there is no `set -e`, so an unchecked mktemp lets "
    + "execution reach the fork with OUT_TMP=\"\" — the 2026-10-01 failure.");
  assert.ok(at(GUARD_COND) > 0, "no `(( MKTEMP_RC != 0 ))` check on the status");
  assert.ok(at(GUARD_EMPTY) > 0,
    "the guard must also reject an EMPTY OUT_TMP, not just a non-zero status: "
    + "an empty string is what every downstream use actually chokes on");
  assert.ok(at(GUARD_LOG) > 0,
    "the guard must leave a durable local log line — the system-channel page "
    + "can itself fail when the temp dir is broken, so the log IS the record");

  // The whole point. Presence is not enough; the guard has to come first.
  assert.ok(at(ASSIGN) < at(RC_CAPTURE),
    "the status capture must immediately follow the assignment, or it is reading "
    + "some other command's $?");
  assert.ok(at(RC_CAPTURE) < at(GUARD_COND), "status captured before it is tested");
  assert.ok(at(GUARD_COND) < at(GUARD_LOG), "the guard's log line is inside the guard");
  assert.ok(at(GUARD_LOG) < at(FORK_REDIRECT),
    "the mktemp guard MUST precede the fork's `> \"$OUT_TMP\"` redirect. Placed "
    + "after it, the empty-string redirect still fails, `claude -p` still never "
    + "runs, and the auth/empty guard still mislabels it.");
  assert.ok(at(GUARD_EMPTY) < at(FORK_REDIRECT),
    "the emptiness check must also precede the first use of OUT_TMP");
});

test("the mktemp branch says plainly that this is not an auth failure", () => {
  // The harm was not the missing build, it was the diagnosis: "auth/empty
  // output" pointed the user at a re-login that would have fixed nothing. The
  // replacement alert has to rule that out in so many words.
  const start = at(GUARD_COND);
  const end = at(GUARD_LOG);
  assert.ok(start > 0 && end > start, "mktemp guard block not found");
  const branch = src.slice(start, end);

  assert.ok(branch.includes("NOT an auth failure"),
    "the mktemp failure alert must explicitly disclaim auth — the recurring "
    + "alert it replaces blamed auth for a broken temp dir");
  assert.ok(branch.includes("re-login is not the remedy"),
    "name the wrong remedy so the reader does not try it");
  assert.ok(branch.includes("mktemp"),
    "the alert must name the real condition (mktemp failed), not a symptom");
  assert.ok(branch.includes("TMPDIR"),
    "include TMPDIR: the reader needs to know which temp dir was being used");

  // Same send shape as the script's other two system-channel guards, including
  // the `|| true`: if the temp dir is broken host-wide then jori-send-curl
  // cannot create ITS own temp file either (RESP_BODY_FILE=$(mktemp -t
  // jori-send.XXXXXX)), and a failed page must not become a second failure.
  assert.ok(branch.includes("--skip-precheck") && branch.includes("--channel system"),
    "infra-condition alerts go to the system channel, skipping precheck");
  assert.ok(branch.includes("|| true"),
    "the send must not be able to fail the guard — the log line is the record");
});

test("a killed run is still reported as killed, not as auth (2026-09-08 fix)", () => {
  // Ordering-only assertion: this one PASSES on the pre-patch source by design.
  // It exists so the mktemp patch — which edits the same region — cannot quietly
  // reorder the earlier fix for the same mislabel.
  const killed = at("(( RC > 128 ))");
  const authGrep = at("grep -qiE 'not logged in");
  assert.ok(killed > 0, "the killed-by-signal branch is gone");
  assert.ok(authGrep > 0, "the auth/empty grep is gone");
  assert.ok(killed < authGrep,
    "the `(( RC > 128 ))` branch must stay ABOVE the auth/empty grep — a "
    + "SIGTERM'd fork writes nothing, so without this ordering it falls through "
    + "and pages as an auth failure (cluster "
    + "sic-20260908-killed-run-misreported-as-auth)");
  assert.ok(src.includes('[[ ! -s "$OUT_TMP" ]]'),
    "the auth/empty guard's own emptiness test is unchanged — the mktemp guard "
    + "is additive, it does not replace it");
});

test("the exit-code header documents the mktemp case", () => {
  // The header near the top of the script enumerates what each exit code means;
  // a new exit-1 condition that is not listed there is a trap for the next
  // reader debugging a nightly miss.
  const header = src.slice(0, at("export PATH="));
  assert.ok(header.includes("Exit codes:"), "the exit-code header moved");
  assert.ok(header.includes("mktemp"),
    "the exit-code header must mention the mktemp failure as an exit-1 case");
});

// ---------------------------------------------------------------------------
// 2026-10-02 addition — same cluster, SECOND recurrence of the same alert:
//   "⚠️ daily-summary-run did NOT run (DAILY SUMMARY 2026-09-26) — auth/empty
//    output (\"\"). No build was attempted."
//   
//
// The guards above made that failure HONEST; they did not make it stop. It fired
// again on 2026-10-02, for 2026-09-26 and 2026-09-27 a second time, because the
// cause was the mktemp INVOCATION itself. On macOS `mktemp -t <prefix>` ignores
// $TMPDIR entirely and resolves the per-user Darwin temp dir via
// confstr(_CS_DARWIN_USER_TEMP_DIR), i.e. /var/folders/<...>/T. `job-run`
// launches this script from a sandboxed agent Bash turn, where TMPDIR is
// remapped to a writable /tmp/claude-<uid> and /var/folders/.../T is DENIED — so
// `-t` aimed at the denied directory and failed EPERM, no fork launched, and the
// date was never built. The fix hands mktemp a full template rooted at whatever
// TMPDIR the process actually has, so it follows the sandbox instead of ignoring
// it, with the trailing slash of the live unsandboxed TMPDIR stripped.
//
// VACUITY WARNING for whoever edits this. The script's own comment block above
// the assignment quotes `mktemp -t` and `%/` verbatim — deliberately, because it
// is what tells the next reader not to "simplify" the template back. So a
// whole-file `src.includes("mktemp -t")` check would pass no matter what the
// CODE does, and a whole-file `${TMPDIR:-` check passes on the pre-fix source
// via the alert's own `TMPDIR=${TMPDIR:-unset}`. Every assertion below therefore
// runs over comment-stripped lines, and the derivation claims are scoped to the
// lines between `log "start ("` and the assignment.

// Comment-stripped view: drop any line whose first non-space character is `#`
// (that includes the shebang, which is fine). The script's string literals never
// begin with `#`, so nothing load-bearing is lost.
const codeLines = src.split("\n").filter((line) => !line.trimStart().startsWith("#"));

test("mktemp gets an explicit TMPDIR-rooted template, never `-t` (2026-10-02 fix)", () => {
  const matches = codeLines.filter((line) => line.includes(ASSIGN));
  assert.equal(matches.length, 1,
    `expected exactly one non-comment OUT_TMP mktemp assignment, found ${matches.length}`);
  const assignLine = matches[0];

  // (a) The assignment statement itself — not the file, not the comment block.
  assert.ok(!assignLine.includes("mktemp -t"),
    "the temp-file assignment is back on `mktemp -t`, which on macOS IGNORES "
    + "$TMPDIR and resolves /var/folders/.../T via confstr — the exact directory "
    + "the agent sandbox that `job-run` launches this under DENIES. That is the "
    + "2026-10-01/02 EPERM, twice over. Offending line: " + assignLine.trim());
  assert.ok(assignLine.includes("XXXXXX"),
    "the assignment must still give mktemp an XXXXXX-style template — without "
    + "one, mktemp takes the argument as a literal name, and the two backfill "
    + "forks that `job-run --name day-rerender` starts seconds apart would "
    + "collide on a single path. Offending line: " + assignLine.trim());

  // (b) The path is derived from the TMPDIR this process actually has, with the
  // trailing slash stripped. Scoped to the derivation lines on purpose: the
  // alert text far below also contains `${TMPDIR:-`, and the comment block just
  // above also contains `%/`, so a wider search would pass pre-fix.
  const startIdx = codeLines.findIndex((line) => line.includes('log "start ('));
  const assignIdx = codeLines.findIndex((line) => line.includes(ASSIGN));
  assert.ok(startIdx >= 0 && assignIdx > startIdx,
    "cannot scope the temp-path derivation: the `log \"start (\"` landmark or the "
    + "assignment moved");
  const derivation = codeLines.slice(startIdx, assignIdx + 1).join("\n");

  assert.ok(derivation.includes("${TMPDIR:-"),
    "the temp path must be derived from ${TMPDIR:-...} so it honors the sandbox's "
    + "remapped TMPDIR (and still has a default when TMPDIR is unset). Nothing "
    + "between the start log and the assignment reads TMPDIR:\n" + derivation);
  assert.ok(derivation.includes("%/"),
    "strip TMPDIR's trailing slash (`%/`): the live unsandboxed TMPDIR ends in "
    + "`/var/folders/.../T/`, so without the strip every path created and logged "
    + "carries a `//`:\n" + derivation);

  // (c) The HIGHEST-CONSEQUENCE claim here. `MKTEMP_RC=$?` must read mktemp's
  // status and nothing else's. If any command — even a `log` line or an echo —
  // is interposed, `$?` silently becomes ITS status, the guard above stops
  // firing on a failed mktemp, and the whole defect comes back wearing the old
  // "auth/empty output" label with no test noticing.
  const between = src.slice(at(ASSIGN), at(RC_CAPTURE));
  assert.equal(between.split("\n").length - 1, 1,
    "there must be exactly ONE line break between the OUT_TMP assignment and "
    + "`MKTEMP_RC=$?` — anything interposed makes $? read that command instead "
    + "of mktemp, silently disabling the guard. Found between them:\n" + between);
  assert.ok(assignLine.trimEnd().endsWith(')"'),
    "the assignment must be the whole line — a trailing `; …` or `&& …` on it "
    + "would also steal $? from mktemp: " + assignLine.trim());

  // (d) And the guard still has to come before the first use of OUT_TMP. Same
  // ordering idiom as the tests above: character offsets, because presence alone
  // would pass a patch that moved the guard below the fork.
  assert.ok(at(GUARD_LOG) > 0 && at(FORK_REDIRECT) > 0,
    "the guard log line or the fork redirect moved — nothing left to order");
  assert.ok(at(GUARD_LOG) < at(FORK_REDIRECT),
    "the mktemp guard must still precede the fork's `> \"$OUT_TMP\"` redirect; a "
    + "corrected template does not retire the guard, it just stops being the "
    + "thing that fires");
});
