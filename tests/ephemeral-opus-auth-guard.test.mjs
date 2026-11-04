// The auth/empty-output guard in agent/scripts/lib/run-ephemeral-opus.sh.
//
// The guard exists because a `claude -p` launched outside the Aqua session
// cannot unlock the keychain holding the Max credentials: it prints
// "Not logged in · Please run /login" and exits 0, so a job that never ran is
// indistinguishable from one that ran fine. That is a real failure and must
// keep paging.
//
// It regressed in the other direction on 2026-08-05. The guard grepped the
// WHOLE captured transcript, and the improvement family's whole subject matter
// is system-channel alerts — many of which quote auth-failure text verbatim.
// system-issue-review shipped a complete report, wrote its state file, and was
// then paged as "did NOT run — the improvement pass was NOT generated" because
// line 18 of that report contained the words `Not logged in` inside a sentence
// root-causing a portfolio alert. The more thorough the pass, the likelier the
// false alarm.
//
// Both real catches on record are ~2-second runs whose ENTIRE output is the
// auth error, so bounding the guard by total output size keeps 100% of them
// while dropping the false-positive class. This test pins that: it extracts the
// LIVE regex, the LIVE line budget and the LIVE predicate out of the script so
// they cannot drift from the implementation, then runs the real predicate
// against real captured output.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const { KERNEL_SUBDIR } = createRequire(import.meta.url)("../lib/root.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "agent/scripts/lib/run-ephemeral-opus.sh");

// `script` is parameterized so the SAME extraction can be pointed at the fable
// sibling (added 2026-09-28 with the cap-kill branch below); it defaults to the
// opus runner, so every assertion written before then is unchanged.
function liveGuard(script = SCRIPT) {
  const src = fs.readFileSync(script, "utf8");
  const who = path.basename(script);

  const re = src.match(/^AUTH_FAIL_RE='(.+)'$/m);
  assert.ok(re, `AUTH_FAIL_RE not found in ${who} — did the guard get renamed or removed?`);

  const lines = src.match(/^AUTH_MAX_OUTPUT_LINES=(\d+)$/m);
  assert.ok(lines, `AUTH_MAX_OUTPUT_LINES not found in ${who} — the guard must stay bounded to near-empty output.`);

  const fn = src.match(/^auth_or_empty_run\(\) \{\n([\s\S]*?)\n\}$/m);
  assert.ok(fn, `auth_or_empty_run() not found in ${who}`);

  return { re: re[0], lines: lines[0], linesN: Number(lines[1]), fn: fn[0] };
}

// Run the script's own predicate against a fixture; true = guard fires.
function guardFires(body, script = SCRIPT) {
  const g = liveGuard(script);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ephem-guard-"));
  const fixture = path.join(dir, "out");
  try {
    fs.writeFileSync(fixture, body);
    const snippet = [
      "set -uo pipefail",
      g.re,
      g.lines,
      g.fn,
      `if auth_or_empty_run ${JSON.stringify(fixture)}; then exit 10; else exit 0; fi`,
    ].join("\n");
    try {
      execFileSync("/bin/bash", ["-c", snippet], { stdio: "pipe" });
      return false;
    } catch (err) {
      assert.equal(err.status, 10, `guard exited ${err.status}, expected 0 or 10:\n${err.stderr}`);
      return true;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// MUST FIRE — the failure the guard is for. The first two are verbatim from a
// weekly job's log, the only two real catches on record.
// ---------------------------------------------------------------------------
const MUST_FIRE = {
  "keychain-locked run, sole line of output": "Not logged in · Please run /login\n",
  "same, with a trailing send confirmation": "Not logged in · Please run /login\nMessage sent to Jori.\n",
  "empty output — ran and produced nothing": "",
  // These two are the shapes the SUPERVISOR reported on 2026-07-28. The original
  // regex matched neither, so an ephemeral run that died this way exited 0 with
  // one line of output and paged nothing at all — a silently skipped pass. Safe
  // to cover only now that the guard is bounded to near-empty output; widening
  // the pattern against a whole transcript would have made 08-05 worse.
  "revoked token": "Failed to authenticate. API Error: 401 OAuth access token has been revoked.\n",
  "expired session": "Failed to authenticate: OAuth session expired and could not be refreshed\n",
};

// ---------------------------------------------------------------------------
// MUST NOT FIRE — successful runs whose CONTENT discusses auth failures. The
// first is the verbatim shape of the 2026-08-05 false positive.
// ---------------------------------------------------------------------------
const MUST_NOT_FIRE = {
  "successful review quoting an auth alert far into the body": [
    "Run complete. Working tree is clean — nothing of mine left uncommitted.",
    "",
    "## What ran",
    "",
    "**8 new alerts** since the last cursor, all matching existing clusters.",
    "",
    "### Fix lane",
    "",
    "**1. `chat-agent` turn hangs → Face-ID card `d0470725`**",
    "",
    "The decisive evidence: the dispatch emitted 391 events across 9 of the next",
    "10 minutes and was SIGKILLed mid-work. It was working both times, not hung.",
    "",
    "**2. Portfolio skip alerts → committed `1c4f25a`**",
    "",
    "Both freshness-gate alerts ended with \"re-run manually,\" which cannot work:",
    "the script ends in `claude -p`, keychain-bound. The log shows the user doing",
    "exactly what the alert said on 08-04 — reconnect the feed, re-run, gate",
    "passes at 0.0h — then `Not logged in` two seconds later.",
    "",
  ].join("\n"),

  "review whose CLUSTER TITLES are auth conditions": [
    "Run complete.",
    "",
    "Reviewed 3 clusters tonight:",
    "- sic-20260724-max-auth-flap — supervisor logged 'Not logged in · Please run /login' 23 times",
    "- sic-20260727-daily-summary-auth-guard-transient — guard tripped on unauthorized",
    "- sic-20260725-brokerage-oauth-lapse — authentication_error from brokerage.example.com",
    "",
    "No card filed; all three are already verifying.",
  ].join("\n"),

  "ordinary successful run with no auth words at all":
    "Done. All eight workflow steps completed for the weekly rebalance.\n",
};

test("guard still fires on the real keychain/auth failure shapes", () => {
  for (const [name, body] of Object.entries(MUST_FIRE)) {
    assert.equal(guardFires(body), true, `guard should FIRE but did not: ${name}`);
  }
});

test("guard does not fire on a successful run that merely quotes auth text", () => {
  for (const [name, body] of Object.entries(MUST_NOT_FIRE)) {
    assert.equal(guardFires(body), false, `guard falsely FIRED on a successful run: ${name}`);
  }
});

test("the output-size bound stays in place — an unbounded grep is the bug", () => {
  const g = liveGuard();
  assert.ok(
    g.fn.includes("wc -l") && g.fn.includes("AUTH_MAX_OUTPUT_LINES"),
    "the guard must require near-empty output — grepping a whole transcript re-opens the 2026-08-05 false-positive class",
  );
  assert.ok(
    g.linesN >= 1 && g.linesN <= 10,
    `AUTH_MAX_OUTPUT_LINES=${g.linesN} is outside a sane window; both real catches were a single line`,
  );
  // The empty-output branch is independent of the bound and must survive any
  // future narrowing.
  assert.ok(g.fn.includes("-s"), "the guard must still catch a completely empty run");
});

// ---------------------------------------------------------------------------
// The alert's WORDING (separate from when it fires).
//
// The guard fires correctly; what it SAID was wrong twice, because the text
// asserted the JOB'S FINAL OUTCOME ("$JOB did NOT run … The improvement pass was
// NOT generated") and this process cannot know that:
//   2026-08-06 — a HAND invocation of the trigger died in 2s with "Not logged
//     in" and paged "did NOT run". The real launchd run succeeded 65 seconds
//     later, so the claim was false before the user read it. The script cannot
//     tell a hand run from the scheduled one, and must not try: a
//     scheduled-vs-hand-run discriminator was proposed and refuted because it
//     would silence 100% of genuine unattended auth failures.
//   2026-09-22T03:52Z — a scheduled hourly tick failed during a real Max outage
//     ("did NOT run" was true of that tick), but the 04:52Z retry produced the
//     pass, so "the improvement pass was NOT generated" was false. A later retry
//     can always falsify a final-outcome claim.
// The one thing always true is that THIS INVOCATION produced nothing. These
// tests pin the live string to that scope — without letting it be softened into
// something skimmable, which would forfeit the silent-2026-07-02-miss catch.
// ---------------------------------------------------------------------------
// Requires the literal "auth/empty" so this keeps pinning the AUTH guard's own
// alert. Since 2026-09-28 the file contains a SECOND `⚠️ $JOB` system-channel
// alert above it (the cap-kill branch), and an unanchored match would silently
// re-point every assertion below at that one instead.
function liveAlertLine() {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const m = src.match(/\n\s*("⚠️ \$JOB[^\n]*?auth\/empty[^\n]*?")\s*>>\s*"\$LOG"/);
  assert.ok(
    m,
    "the guard's system-channel alert string was not found in run-ephemeral-opus.sh — " +
      'it must stay a single line starting with "⚠️ $JOB and naming auth/empty, so this test can pin its claims',
  );
  return m[1];
}

test("the alert claims only what this invocation observed, never the job's outcome", () => {
  // The patterns below match a HARD-CODED LINE OF SHELL SOURCE we wrote
  // ourselves, not anything the user said — the same category as this file's
  // existing AUTH_FAIL_RE / AUTH_MAX_OUTPUT_LINES extraction. Nothing here
  // interprets meaning from a message; it pins our own committed literal.
  // lang-regex-ok: asserts against a shell-source literal, not the user's words
  const alertLine = liveAlertLine();

  const FINAL_OUTCOME_CLAIMS = [
    [/did\s+not\s+run/i, 'the 2026-08-06 false page — a hand run cannot say the job "did NOT run"'],
    [/never\s+ran/i, "same class: an assertion about the job rather than this process"],
    [/was\s+not\s+generated/i, "the 2026-09-22 false page — the 04:52Z retry generated the pass"],
    [/(pass|report|memo|review)\s+was\s+not\b/i, "any claim about the job's end state outlives this process's knowledge"],
  ];
  for (const [re, why] of FINAL_OUTCOME_CLAIMS) {
    assert.ok(!re.test(alertLine), `alert re-asserts the job's final outcome (${re}) — ${why}:\n  ${alertLine}`);
  }

  assert.ok(
    /this invocation/i.test(alertLine),
    `alert must scope its claim to this invocation, which is the only thing it can know:\n  ${alertLine}`,
  );

  // Scoped, not softened. The guard's reason to exist is an unattended run that
  // failed in silence; a page nobody acts on is the same as no page.
  assert.ok(
    /missing|nothing was (generated|produced)/i.test(alertLine),
    `alert must still name the consequence, not just narrate an exit:\n  ${alertLine}`,
  );
  assert.ok(alertLine.startsWith('"⚠️ $JOB'), `alert must keep the ⚠️ marker and name the job:\n  ${alertLine}`);
  assert.ok(alertLine.includes('\\"${FIRST}\\"'), `alert must keep quoting the captured first line:\n  ${alertLine}`);
});

test("rewording the alert did not disturb the send flags the gates depend on", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(
    src.includes('--skip-precheck --channel system --observed-error "$FIRST"'),
    "the guard must still send on the system channel, skip precheck, and attest the observed error verbatim " +
      "(jori-send-curl's mechanism-attestation gate rejects an unattested auth-mechanism claim with exit 6)",
  );
});

test("the alert makes no machine-wide outage claim", () => {
  // Pinned against the LIVE pattern in jori-send-curl so the two cannot
  // drift: a message matching it is rejected with exit 3 unless the caller is
  // an authorized out-of-sandbox prober, which this script is not.
  const sendCurl = fs.readFileSync(path.join(ROOT, "bin/jori-send-curl"), "utf8");
  const m = sendCurl.match(/^INFRA_CLAIM_RE='(.+)'$/m);
  assert.ok(m, "INFRA_CLAIM_RE not found in jori-send-curl — did the fabricated-outage gate move?");
  const alertLine = liveAlertLine();
  assert.ok(
    !new RegExp(m[1], "i").test(alertLine),
    `alert would be blocked (exit 3) by the fabricated-outage gate:\n  ${alertLine}`,
  );
});

test("a late auth failure is covered by the exit code, not by this guard", () => {
  // Documents the deliberate trade. This guard's unique job is the
  // exit-0-having-done-nothing case, whose output is an auth error and nothing
  // else. A session that dies mid-run exits non-zero, and run-ephemeral-opus.sh
  // already propagates that — and calling a 25-minute run "did NOT run" would
  // have been false anyway.
  const late = `${"work log line\n".repeat(40)}Not logged in · Please run /login\n`;
  assert.equal(guardFires(late), false);
  // Pinned for EVERY copy, not just this one. The bound and its backstop have
  // to travel together: narrowing the auth scan is only safe because a late
  // auth death exits non-zero, and one weekly trigger carried the narrowing's
  // premise in a comment while ending on `echo` — so it always exited 0 (found
  // by the critic before the narrowing shipped).
  for (const rel of SIBLING_EMITTERS) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    // Both spellings count: the ephemeral runners end `exit $RC`, daily-summary-run
    // ends `exit "$RC"`. The property under test is that the fork's status is
    // propagated, not how it is quoted — widened rather than renormalizing a
    // working script's quoting to suit a regex.
    assert.match(
      src,
      /^exit "?\$RC"?$/m,
      `${rel}: the RC passthrough is what covers late auth failures once the scan is size-bounded — do not remove it`,
    );
  }
});

// ---------------------------------------------------------------------------
// The SAME guard, with the SAME false claim, exists in FOUR emitters.
// run-ephemeral-opus.sh was once one of three copies, and fixing only it would
// have let the cluster close as resolved while two live scripts kept paging
// "did NOT run" / "was NOT generated". Every copy is pinned here so a future
// edit cannot quietly restore the claim in whichever copy this file does not
// watch:
//   agent/scripts/lib/run-ephemeral-opus.sh      — improvement family
//   agent/scripts/lib/run-ephemeral-fable.sh     — council-style jobs on Fable
//   bin/daily-summary-run                        — nightly daily-summary fork
// plus an installation's own copies (a weekly trigger of its own, say), listed
// in agent/local/config/auth-guard-emitters.json {"emitters": [...]}.
//
// daily-summary-run joined the list after the list's own blind spot cost a
// third recurrence: it held the UNBOUNDED grep the whole time the other copies
// were being fixed, because nothing watched it. Its early-morning run persisted
// the narrative, sent the email and delivered the phone pointer — and was then
// paged as "did NOT run … No build was attempted", quoting the report's own
// success line as the "auth/empty output", because the closing paragraph said
// the Supabase MCP tools "were unauthorized for this whole session". The
// non-zero exit drew a backfill that re-ran the build and sent the user a SECOND
// email plus a duplicate push, which that retry turn then had to unstar and archive.
// ---------------------------------------------------------------------------

const LOCAL_EMITTERS = (() => {
  try {
    const c = createRequire(import.meta.url)("../lib/instance.cjs").localConfig("auth-guard-emitters", { emitters: [] });
    return (Array.isArray(c.emitters) ? c.emitters : []).filter((rel) => fs.existsSync(path.join(ROOT, rel)));
  } catch { return []; }
})();
const SIBLING_EMITTERS = [
  "agent/scripts/lib/run-ephemeral-opus.sh",
  "agent/scripts/lib/run-ephemeral-fable.sh",
  "bin/daily-summary-run",
  ...LOCAL_EMITTERS,
];

// Pulls the auth/empty guard's system-channel alert out of any of the three.
// lang-regex-ok: matches a shell-source literal we committed, never a message
function liveAlertLineIn(rel) {
  const body = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const m = body.match(/\n\s*("⚠️ [^\n]*?auth\/empty[^\n]*?")\s*>>\s*"\$LOG"/);
  assert.ok(m, `no auth/empty guard alert found in ${rel} — did the guard move or get renamed?`);
  return m[1];
}

test("every copy of the auth/empty guard scopes its claim to this invocation", () => {
  // lang-regex-ok: asserts against shell-source literals, not the user's words
  for (const rel of SIBLING_EMITTERS) {
    const alertLine = liveAlertLineIn(rel);
    assert.ok(
      !/did not run/i.test(alertLine),
      `${rel}: the alert must not claim the JOB did not run — this process cannot tell a hand invocation from the scheduled one (measured 2026-08-06)`,
    );
    assert.ok(
      !/(was|were) not generated/i.test(alertLine),
      `${rel}: the alert must not assert the job's final outcome — a later retry can produce it (measured 2026-09-22T03:52Z, retried successfully at 04:52Z)`,
    );
    assert.match(
      alertLine,
      /this invocation/i,
      `${rel}: the alert must say what it actually observed — that THIS invocation produced nothing`,
    );
    assert.match(
      alertLine,
      /is missing/i,
      `${rel}: the alert must still name the consequence, or it softens into something skimmable — this guard exists for the silent 2026-07-02 miss`,
    );
    assert.match(
      alertLine,
      /\\"\$\{FIRST\}\\"/,
      `${rel}: the alert must keep quoting the captured first line, which is what jori-send-curl's mechanism-attestation gate is satisfied by`,
    );
  }
});

test("every copy bounds its auth scan by output size, not just one of them", () => {
  // THE GAP THIS CLOSES. The bound test above (`the output-size bound stays in
  // place`) only ever looked at run-ephemeral-opus.sh, so when the
  // hardening landed in one copy of three, nothing noticed. Later the
  // unbounded copy in a weekly trigger paged "the weekly memo is missing"
  // about a run that had written the memo, sent the email and committed —
  // because the report's last line said the Supabase MCP server was "unauthorized".
  // lang-regex-ok: pins committed shell source, not message content
  for (const rel of SIBLING_EMITTERS) {
    const body = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(
      body,
      /AUTH_MAX_OUTPUT_LINES/,
      `${rel}: the auth scan must be bounded by output size — an unbounded grep fires on any successful run that discusses auth, and these jobs discuss auth for a living`,
    );
    assert.match(
      body,
      /wc -l </,
      `${rel}: the bound has to be measured, not just declared`,
    );
  }
});

test("every copy still fires on the same condition and with the same flags", () => {
  // lang-regex-ok: pins committed shell source, not message content
  for (const rel of SIBLING_EMITTERS) {
    const body = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(body, /--skip-precheck/, `${rel}: system-channel infra alert must keep --skip-precheck`);
    assert.match(body, /--channel system/, `${rel}: the alert must stay on the system channel — infrastructure noise never goes to the main conversation`);
    assert.match(body, /--observed-error "\$FIRST"/, `${rel}: the mechanism-attestation gate needs the captured error passed back`);
    // Over CODE lines only (comments stripped). The claim is about what the
    // script DOES, and daily-summary-run has a legitimate comment naming
    // daily-summary-lock's $PPID default — to explain why it passes its own pid
    // instead of relying on it, which is the opposite of a discriminator.
    const code = body.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    assert.ok(
      !/XPC_SERVICE_NAME|PPID|JORI_SCHEDULED/.test(code),
      `${rel}: no scheduled-vs-hand-run discriminator — refuted 2026-08-07 and re-measured dead 2026-09-06; any such test also silences the real unattended failures this guard exists for`,
    );
  }
});

// ---------------------------------------------------------------------------
// A KILLED RUN IS NOT AN AUTH FAILURE — cluster
// sic-20260928-cap-kill-reported-as-auth.
//
// Both ephemeral runners arm their own turn cap by backgrounding `claude -p`,
// sleeping TIMEOUT_MIN*60, then `kill -TERM`. Both then did `wait; RC=$?` and
// never consulted RC. A SIGTERM'd `claude -p` has written NOTHING to $OUT_TMP
// (it emits its output at the end), so the kill fell through to the auth guard's
// `[ -s "$f" ] || return 0` empty-output arm and was paged as auth.
//
// Observed live, agent/logs/system-issue-review.log:
//   2026-09-27 04:27:01 [system-issue-review] start (ephemeral opus-5, xhigh, 45m cap)
//   2026-09-27 05:12:01 [system-issue-review] TIMEOUT after 45m — killing 42464
//   2026-09-27 05:12:12 [system-issue-review] exit 1 (guard: auth/empty run)
// which paged: "⚠️ system-issue-review exited without producing output —
// auth/empty (\"\")." The script had logged its own kill one line earlier. Two
// harms: the remedy the wording implies (re-login) is the wrong action, and a
// habitual cap overrun can never form its own alert cluster while every
// occurrence is mislabelled as auth.
//
// ORDERING IS THE ENTIRE FIX, so these assert on source POSITION, not presence.
// Same defect, same remedy as bin/daily-summary-run's 2026-09-08 branch
// (cluster sic-20260908-killed-run-misreported-as-auth).
// ---------------------------------------------------------------------------

const CAP_RUNNERS = [
  "agent/scripts/lib/run-ephemeral-opus.sh",   // where it was observed firing
  "agent/scripts/lib/run-ephemeral-fable.sh",  // same kill path, same guard, only luckier
];

// NOTE: an emitter with the auth/empty guard but NO timeout/kill path (e.g. a
// plain weekly trigger) cannot exhibit this bug and is deliberately not in
// CAP_RUNNERS. If a cap is ever added there, add it here in the same commit.

function runnerSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

test("every capped runner checks RC>128 BEFORE it reaches the auth/empty guard", () => {
  for (const rel of CAP_RUNNERS) {
    const src = runnerSrc(rel);
    const capAt = src.indexOf("if (( RC > 128 )); then");
    const authAt = src.indexOf("if auth_or_empty_run");
    assert.ok(
      capAt !== -1,
      `${rel}: no RC>128 branch — a SIGTERM'd run reports as an auth failure again (sic-20260928-cap-kill-reported-as-auth, observed 2026-09-27 05:12)`,
    );
    assert.ok(authAt !== -1, `${rel}: the auth/empty guard call went missing`);
    assert.ok(
      capAt < authAt,
      `${rel}: the RC>128 branch must come BEFORE auth_or_empty_run — the ordering IS the fix; below it, the killed run still lands in the empty-output arm first (sic-20260928-cap-kill-reported-as-auth)`,
    );
    assert.ok(
      /^RC=\$\?$/m.test(src),
      `${rel}: RC must still be captured from wait — the 2026-09-27 bug was capturing it and never consulting it`,
    );
  }
});

test("the turn-cap subshell records its marker before it kills", () => {
  for (const rel of CAP_RUNNERS) {
    const src = runnerSrc(rel);
    const start = src.indexOf('if [ "$TIMEOUT_MIN" -gt 0 ]');
    const end = src.indexOf("WATCHDOG_PID=$!");
    assert.ok(start !== -1 && end > start, `${rel}: the turn-cap subshell was not found`);
    const block = src.slice(start, end);

    const markerAt = block.indexOf('"$TIMEOUT_MARKER"');
    const termAt = block.indexOf("kill -TERM");
    assert.ok(
      markerAt !== -1,
      `${rel}: the cap subshell must leave $TIMEOUT_MARKER — it is a separate process, so it cannot hand the parent a variable, and without the marker the parent cannot tell its OWN cap from an operator's kill (sic-20260928-cap-kill-reported-as-auth)`,
    );
    assert.ok(termAt !== -1, `${rel}: the cap's kill -TERM went missing`);
    assert.ok(
      markerAt < termAt,
      `${rel}: the marker must be written BEFORE kill -TERM, or the parent can wake from wait to a signal death it cannot explain`,
    );

    // Declared up front, so `[ -f "$TIMEOUT_MARKER" ]` is safe under `set -u`
    // even when no cap was armed, and cleaned up on every exit path so a stale
    // marker can never mislabel a later run.
    assert.match(src, /^TIMEOUT_MARKER=/m, `${rel}: $TIMEOUT_MARKER must be declared before the cap subshell (set -u)`);
    const removals = src.match(/rm -f "\$OUT_TMP" "\$TIMEOUT_MARKER"/g) || [];
    assert.ok(
      removals.length >= 3,
      `${rel}: expected the marker removed on all three exit paths (cap-kill, auth/empty, normal), found ${removals.length}`,
    );
  }
});

// Pulls the cap-kill branch out of the live script and runs it for real, with a
// stub jori-send-curl, so what it SAYS is pinned to behaviour and not to a
// grep over source.
function capKillBranch(rel) {
  const src = runnerSrc(rel);
  // lang-regex-ok: extracts a block of shell source we committed, never a message
  const m = src.match(/\nif \(\( RC > 128 \)\); then\n[\s\S]*?\nfi\n/);
  assert.ok(m, `${rel}: could not extract the RC>128 branch — did it stop being a top-level if/fi?`);
  return m[0];
}

function runCapKill(rel, { rc, marker }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ephem-capkill-"));
  try {
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    const stub = path.join(dir, "bin/jori-send-curl");
    fs.writeFileSync(stub, '#!/bin/bash\nfor a in "$@"; do printf "ARG %s\\n" "$a"; done\n', { mode: 0o755 });

    const out = path.join(dir, "out");
    fs.writeFileSync(out, "");  // a killed `claude -p` has written nothing yet
    const markerPath = `${out}.timeout`;
    if (marker) fs.writeFileSync(markerPath, "TIMEOUT after 45m — killing 42464\n");
    const logPath = path.join(dir, "log");
    fs.writeFileSync(logPath, "");

    const snippet = [
      "set -uo pipefail",
      `ROOT=${JSON.stringify(dir)}`,
      `JORI_INSTALL_TOOLS=${JSON.stringify(path.join(dir, KERNEL_SUBDIR))}`,  // lib/root.sh's name for the kernel tree
      'JOB="system-issue-review"',
      "TIMEOUT_MIN=45",
      `RC=${rc}`,
      `OUT_TMP=${JSON.stringify(out)}`,
      `TIMEOUT_MARKER=${JSON.stringify(markerPath)}`,
      `LOG=${JSON.stringify(logPath)}`,
      'log() { echo "LOG $1" >> "$LOG"; }',
      capKillBranch(rel),
      "exit 0",
    ].join("\n");

    let status = 0;
    try {
      execFileSync("/bin/bash", ["-c", snippet], { stdio: "pipe" });
    } catch (err) {
      status = err.status;
    }
    return { status, log: fs.readFileSync(logPath, "utf8") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a cap kill is reported as a cap kill, not as auth — and exits 1", () => {
  for (const rel of CAP_RUNNERS) {
    const r = runCapKill(rel, { rc: 143, marker: true });  // SIGTERM, our own cap
    assert.equal(r.status, 1, `${rel}: a killed run must still exit non-zero`);
    assert.match(r.log, /45m cap/, `${rel}: the alert must name the cap it hit, which is the condition an operator can act on`);
    assert.match(r.log, /signal 15/, `${rel}: 143 is SIGTERM — say so, the signal number is the observed fact`);
    assert.match(r.log, /not an auth failure/, `${rel}: the whole point of sic-20260928-cap-kill-reported-as-auth is that this is NOT auth`);
    assert.ok(
      !/auth\/empty/.test(r.log),
      `${rel}: the cap kill must not fall through to the auth/empty guard — that is the 2026-09-27 misreport verbatim:\n${r.log}`,
    );
    assert.match(r.log, /ARG --skip-precheck/, `${rel}: system-channel infra alert must keep --skip-precheck`);
    assert.match(r.log, /ARG --channel\nARG system/, `${rel}: the alert must stay on the system channel`);
    assert.match(
      r.log,
      /ARG --observed-error\nARG TIMEOUT after 45m/,
      `${rel}: the mechanism-attestation gate is satisfied by the text this script actually captured — the watchdog's own timeout line, not a description of it`,
    );
    assert.match(r.log, /LOG exit 1 \(guard: killed by signal 15/, `${rel}: the log line must name the kill, so the next reader is not sent to re-login`);

    // SIGKILL (the cap's follow-up) and an outside kill with no marker.
    const hard = runCapKill(rel, { rc: 137, marker: true });
    assert.equal(hard.status, 1, `${rel}: RC=137 (SIGKILL) is also a kill`);
    assert.match(hard.log, /signal 9/, `${rel}: RC=137 is SIGKILL`);

    const outside = runCapKill(rel, { rc: 143, marker: false });
    assert.equal(outside.status, 1, `${rel}: an operator kill is still an interruption, not auth`);
    assert.match(outside.log, /not an auth failure/, `${rel}: still not auth`);
    assert.ok(
      !/cap/.test(outside.log),
      `${rel}: with no marker the script must NOT claim its own cap fired — it did not observe that:\n${outside.log}`,
    );
    assert.match(
      outside.log,
      /ARG --observed-error\nARG exit status 143/,
      `${rel}: with no marker, the only observed fact is what wait returned — attest that and nothing more`,
    );

    // And an ordinary exit must not touch this branch at all.
    const clean = runCapKill(rel, { rc: 0, marker: false });
    assert.equal(clean.status, 0, `${rel}: RC=0 must fall through to the auth/empty guard as before`);
    assert.equal(clean.log, "", `${rel}: a normal run must page nothing from this branch`);
  }
});

test("the cap-kill alert claims only this invocation, and no machine-wide outage", () => {
  // lang-regex-ok: asserts against shell-source literals we committed, not the user's words
  const sendCurl = fs.readFileSync(path.join(ROOT, "bin/jori-send-curl"), "utf8");
  const infra = sendCurl.match(/^INFRA_CLAIM_RE='(.+)'$/m);
  assert.ok(infra, "INFRA_CLAIM_RE not found in jori-send-curl — did the fabricated-outage gate move?");

  for (const rel of CAP_RUNNERS) {
    const src = runnerSrc(rel);
    const m = src.match(/\n\s*("⚠️ \$JOB[^\n]*?not an auth failure[^\n]*?")\s*>>\s*"\$LOG"/);
    assert.ok(m, `${rel}: the cap-kill alert string was not found — it must stay one line starting with "⚠️ $JOB`);
    const alertLine = m[1];

    // Same discipline as the auth/empty alert: this process knows its fork was
    // interrupted, never the job's final outcome. Both wordings below were
    // measured false in opposite directions (2026-08-06 and 2026-09-22).
    for (const [re, why] of [
      [/did\s+not\s+run/i, "a hand invocation cannot say the job did not run (2026-08-06)"],
      [/never\s+ran/i, "an assertion about the job rather than this process"],
      [/was\s+not\s+generated/i, "a later retry can produce the pass (2026-09-22T03:52Z, retried 04:52Z)"],
    ]) {
      assert.ok(!re.test(alertLine), `${rel}: cap-kill alert re-asserts the job's final outcome (${re}) — ${why}:\n  ${alertLine}`);
    }
    assert.match(alertLine, /this invocation/i, `${rel}: the alert must scope its claim to this invocation`);
    assert.match(alertLine, /is missing|nothing was (produced|generated)/i, `${rel}: the alert must still name the consequence`);
    assert.ok(
      !new RegExp(infra[1], "i").test(alertLine),
      `${rel}: cap-kill alert would be blocked (exit 3) by the fabricated-outage gate — it must describe THIS run only:\n  ${alertLine}`,
    );
  }
});

test("adding the cap-kill branch left the auth/empty guard's firing conditions intact", () => {
  // (d) in the action item: the new branch is additive. Both runners' guards are
  // re-run here against the SAME fixtures the opus guard has always been pinned
  // to, and their bound + pattern are pinned to each other so the pair cannot
  // drift.
  const opus = liveGuard(path.join(ROOT, CAP_RUNNERS[0]));
  for (const rel of CAP_RUNNERS) {
    const script = path.join(ROOT, rel);
    const g = liveGuard(script);
    assert.equal(g.re, opus.re, `${rel}: AUTH_FAIL_RE drifted from run-ephemeral-opus.sh — the two guards must stay one pattern`);
    assert.equal(g.linesN, opus.linesN, `${rel}: AUTH_MAX_OUTPUT_LINES drifted from run-ephemeral-opus.sh`);
    assert.ok(
      g.fn.includes("-s") && g.fn.includes("wc -l") && g.fn.includes("AUTH_MAX_OUTPUT_LINES") && g.fn.includes("AUTH_FAIL_RE"),
      `${rel}: auth_or_empty_run lost one of its three arms (empty / bounded / pattern) — the cap-kill fix must not weaken it`,
    );
    for (const [name, body] of Object.entries(MUST_FIRE)) {
      assert.equal(guardFires(body, script), true, `${rel}: guard should still FIRE but did not: ${name}`);
    }
    for (const [name, body] of Object.entries(MUST_NOT_FIRE)) {
      assert.equal(guardFires(body, script), false, `${rel}: guard falsely FIRED on a successful run: ${name}`);
    }
  }
});

// ---------------------------------------------------------------------------
// THE FOURTH COPY — cluster sic-20261004-daily-summary-authgrep-unbounded.
//
// bin/daily-summary-run carried the unbounded grep until 2026-10-04, and
// it is the copy where the false positive is MOST expensive: a non-zero exit
// from this script draws a backfill dispatch, so a wrongly-failed run does not
// merely mispage, it re-runs the whole build and double-delivers.
//
// Observed 2026-10-03 (agent/logs/daily-summary-run.log):
//   05:23:04 start (DAILY SUMMARY 2026-10-02, sonnet-5 xhigh)
//   ... complete success: daily_summaries written 09:36 UTC, email 09:37, pointer sent
//   05:38:09 exit 1 (guard: auth/empty run)        <-- this test's subject
//   05:38:09 start (DAILY SUMMARY 2026-10-02)      <-- backfill, second email + push
// The only trigger was the word "unauthorized" in the report's LAST paragraph,
// where the session flagged that the Supabase MCP tools had been unauthorized all
// session and that it had worked around them. The page it produced claimed the
// job did not run and that no build was attempted; the quoted "auth/empty output"
// was the report's own opening success line.
//
// The fixtures below are that transcript's shape (auth word in the CLOSING line,
// which an unbounded grep cannot distinguish from an auth stub) and the real
// auth-failure line from the same log, 9 minutes earlier.
// ---------------------------------------------------------------------------

const DAILY_SUMMARY_RUN = path.join(ROOT, "bin/daily-summary-run");

const DS_SUCCESS_REPORT_ENDING_IN_UNAUTHORIZED = [
  "Everything is persisted correctly. The daily summary for Friday, October 2, 2026 is complete:",
  "",
  "- **Resolved** the day's GPS timeline (7 stops across three towns)",
  "- **Confirmed** 4 previously-unlabeled stops from chat context: a quick food stop for the dog,",
  "  the rental flat (afternoon + overnight), and dinner at friends' place",
  "- **Left one stop genuinely unresolved** (early-morning, near the Alhambra Cinema) with a",
  "  grounded follow-up question rather than a guess",
  "- **Caught and reported** a real builder bug via the review loop: one travel leg got",
  '  mislabeled "walked 1.6 miles in 6 minutes" (16 mph)',
  "- **Sent** the email (starred, labeled `personal`, marked read, no `p1`), plus the phone",
  "  pointer and push",
  "",
  "One thing worth flagging to you directly: the Supabase MCP tools (`execute_sql`,",
  "`list_tables`, etc.) were unauthorized for this whole session — I worked around it using",
  "the local REST helper, but that's a connectivity issue someone should look at separately.",
  "",
].join("\n");

// Verbatim, agent/logs/daily-summary-run.log 2026-10-03 05:14:19 and 20:01:32.
const DS_REAL_AUTH_FAILURE = "Failed to authenticate: OAuth session expired and could not be refreshed\n";

// The pattern daily-summary-run used to carry, hard-coded so the widening is
// pinned by behaviour instead of asserted in prose.
// lang-regex-ok: reproduces a retired shell-source literal, not message content
const DS_RETIRED_AUTH_RE =
  /not logged in|please run \/login|invalid (api )?key|authentication_error|unauthorized/i;

test("daily-summary-run: a success report whose LAST line says 'unauthorized' is not auth/empty", () => {
  // The unbounded grep's failure, reproduced: the retired pattern DOES match this
  // successful report, which is exactly why the bound — not the word list — is
  // the fix.
  assert.ok(
    DS_RETIRED_AUTH_RE.test(DS_SUCCESS_REPORT_ENDING_IN_UNAUTHORIZED),
    "fixture no longer reproduces the 2026-10-03 trigger — it must still contain the auth word that tripped the old grep",
  );
  assert.equal(
    guardFires(DS_SUCCESS_REPORT_ENDING_IN_UNAUTHORIZED, DAILY_SUMMARY_RUN),
    false,
    "daily-summary-run's guard fired on the 2026-10-03 run that persisted the narrative, sent the email and shipped the pointer — "
      + "this is the page that drew the backfill and sent the user a second email",
  );
});

test("daily-summary-run: the real OAuth-expiry line fires, which the retired pattern missed", () => {
  assert.equal(
    guardFires(DS_REAL_AUTH_FAILURE, DAILY_SUMMARY_RUN),
    true,
    "the actual auth failure this host produces must page — it is one line in ~3 seconds, the shape the guard exists for",
  );
  // And why the word list had to widen at the same time as the scan narrowed:
  // the retired pattern matched NONE of this line's words, so the two genuine
  // auth deaths on 2026-10-03 (05:14:19 and 20:01:32) paged nothing at all and
  // surfaced only as a bare `exit 1` from the fork's own status.
  assert.ok(
    !DS_RETIRED_AUTH_RE.test(DS_REAL_AUTH_FAILURE),
    "if the retired pattern matches this, the claim in daily-summary-run's comment about why the word list widened is wrong — fix the comment",
  );
  assert.equal(guardFires("", DAILY_SUMMARY_RUN), true, "an empty run must still fire — the empty-file arm is unchanged");
});

test("daily-summary-run's guard is the same guard, not a lookalike", () => {
  const opus = liveGuard();
  const ds = liveGuard(DAILY_SUMMARY_RUN);
  assert.equal(ds.re, opus.re, "AUTH_FAIL_RE drifted from run-ephemeral-opus.sh — the four copies must stay one pattern");
  assert.equal(ds.linesN, opus.linesN, "AUTH_MAX_OUTPUT_LINES drifted from run-ephemeral-opus.sh");
  assert.ok(
    ds.fn.includes("-s") && ds.fn.includes("wc -l") && ds.fn.includes("AUTH_MAX_OUTPUT_LINES") && ds.fn.includes("AUTH_FAIL_RE"),
    "auth_or_empty_run lost one of its three arms (empty / bounded / pattern)",
  );
  // The whole MUST_FIRE / MUST_NOT_FIRE corpus, against this copy too.
  for (const [name, body] of Object.entries(MUST_FIRE)) {
    assert.equal(guardFires(body, DAILY_SUMMARY_RUN), true, `daily-summary-run: guard should FIRE but did not: ${name}`);
  }
  for (const [name, body] of Object.entries(MUST_NOT_FIRE)) {
    assert.equal(guardFires(body, DAILY_SUMMARY_RUN), false, `daily-summary-run: guard falsely FIRED on a successful run: ${name}`);
  }
});

test("daily-summary-run still checks RC>128 before the auth/empty guard", () => {
  // Not in CAP_RUNNERS — this script arms no timeout of its own, so it has no
  // TIMEOUT_MARKER and cannot exhibit sic-20260928-cap-kill-reported-as-auth.
  // It DOES get SIGTERM'd by operators cancelling a superseded regeneration
  // (2026-09-07, sic-20260908-killed-run-misreported-as-auth), so the ordering
  // still has to hold, and narrowing the auth scan must not have moved it.
  const src = fs.readFileSync(DAILY_SUMMARY_RUN, "utf8");
  const capAt = src.indexOf("if (( RC > 128 )); then");
  const authAt = src.indexOf("if auth_or_empty_run");
  assert.ok(capAt !== -1, "the RC>128 branch is gone — a killed fork would page as an auth failure again");
  assert.ok(authAt !== -1, "the auth/empty guard call went missing");
  assert.ok(capAt < authAt, "the RC>128 branch must stay ABOVE auth_or_empty_run — the ordering IS that fix");
});
