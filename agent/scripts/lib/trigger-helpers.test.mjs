// trigger-helpers.test.mjs — pins trigger_dispatch()/trigger_job() delivery
// verification in trigger-helpers.sh. Fixed 2026-07-24: trigger_dispatch used
// to fire-and-forget its curl POST (output redirected to /dev/null, exit code
// never checked), so trigger_job would log "Dispatched <job>" and return 0
// even when the POST never reached the supervisor. That silently dropped
// episode-archive's 07:25 dispatch on 2026-07-23 — daily-summary ran fine,
// but the wiki day page never got written until watchdog-backfill caught it
// hours later. These tests stub `curl` and `sleep` (no 60s real backoff in a
// test run) to exercise trigger_job's success, dispatch-failure+retry, and
// health-failure+retry paths without touching the real webhook.
//
// Run: node --test agent/scripts/lib/trigger-helpers.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELPERS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "trigger-helpers.sh",
);

// Builds a bash harness that stubs `curl` and `sleep`, sources the real
// trigger-helpers.sh, and runs trigger_job "test-job" once.
//
// - healthCodes: queue of exit statuses (0 = healthy childAlive:true) for
//   successive /health probes (one per trigger_is_healthy call).
// - dispatchCodes: queue of HTTP status codes for successive dispatch POSTs.
function runTriggerJob({ healthCodes, dispatchCodes }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trigger-helpers-test-"));
  const logfile = path.join(tmp, "watchdog.log");
  const healthCallsFile = path.join(tmp, "health-calls.txt");
  const dispatchCallsFile = path.join(tmp, "dispatch-calls.txt");

  const script = `
HEALTH_CODES=(${healthCodes.join(" ")})
DISPATCH_CODES=(${dispatchCodes.join(" ")})

sleep() { :; }  # skip the real 60s backoff

# curl runs inside a subshell every time it's invoked via command
# substitution (\`\$(curl ...)\`), so a plain shell-variable counter resets
# on every call — index off the call-count files on disk instead, since
# those writes persist across the subshell boundary.
curl() {
  local args="$*"
  if printf '%s' "$args" | grep -q '/health'; then
    echo "1" >> "${healthCallsFile}"
    local idx=$(( $(wc -l < "${healthCallsFile}") - 1 ))
    local code="\${HEALTH_CODES[$idx]:-0}"
    if [ "$code" = "0" ]; then
      echo '{"childAlive":true}'
      return 0
    else
      return 1
    fi
  fi
  # dispatch POST — emulate -o /dev/null -w '%{http_code}'
  echo "1" >> "${dispatchCallsFile}"
  local idx=$(( $(wc -l < "${dispatchCallsFile}") - 1 ))
  local code="\${DISPATCH_CODES[$idx]:-200}"
  printf '%s' "$code"
  return 0
}

source "${HELPERS}"
# trigger-helpers.sh hardcodes LOGFILE to the real watchdog.log rather than
# honoring an inherited env var — redefine trigger_log post-source so this
# test never touches the production log file.
trigger_log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [\$TRIGGER_JOB] \$1" >> "${logfile}"; }
CURL_AUTH=()
trigger_job test-job
echo "RC:$?"
`;

  const stdout = execFileSync("bash", ["-c", script], { encoding: "utf8" });
  const rcMatch = stdout.match(/RC:(\d+)/);
  const countLines = (f) =>
    fs.existsSync(f)
      ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).length
      : 0;

  return {
    rc: rcMatch ? Number(rcMatch[1]) : null,
    log: fs.existsSync(logfile) ? fs.readFileSync(logfile, "utf8") : "",
    healthCalls: countLines(healthCallsFile),
    dispatchCalls: countLines(dispatchCallsFile),
  };
}

test("healthy + 2xx dispatch: succeeds on first attempt, dispatches exactly once", () => {
  const r = runTriggerJob({ healthCodes: [0], dispatchCodes: [200] });
  assert.equal(r.rc, 0);
  assert.equal(r.healthCalls, 1);
  assert.equal(r.dispatchCalls, 1);
  assert.match(r.log, /Dispatched test-job(?!.*retry)/s);
  assert.doesNotMatch(r.log, /retry/);
});

test("healthy but dispatch returns 500: does not report success, retries, then succeeds", () => {
  const r = runTriggerJob({ healthCodes: [0, 0], dispatchCodes: [500, 200] });
  assert.equal(r.rc, 0);
  assert.equal(r.healthCalls, 2, "should re-check health before the retry dispatch");
  assert.equal(r.dispatchCalls, 2, "first failed dispatch + one retry, never more");
  assert.match(r.log, /Dispatch failed: curl_exit=0 http_code=500/);
  assert.match(r.log, /Dispatched test-job \(retry\)/);
});

test("healthy but dispatch fails both attempts: reports failure, never claims success", () => {
  const r = runTriggerJob({ healthCodes: [0, 0], dispatchCodes: [500, 503] });
  assert.equal(r.rc, 1);
  assert.equal(r.dispatchCalls, 2);
  assert.doesNotMatch(r.log, /Dispatched test-job/);
  assert.match(r.log, /test-job failed: supervisor unhealthy or dispatch failed after retry/);
});

test("unhealthy on first check: retries, dispatch never attempted before health passes", () => {
  const r = runTriggerJob({ healthCodes: [1, 0], dispatchCodes: [200] });
  assert.equal(r.rc, 0);
  assert.equal(r.dispatchCalls, 1, "no dispatch attempt while unhealthy");
  assert.match(r.log, /Dispatched test-job \(retry\)/);
});

test("unhealthy on both checks: fails without ever dispatching", () => {
  const r = runTriggerJob({ healthCodes: [1, 1], dispatchCodes: [200] });
  assert.equal(r.rc, 1);
  assert.equal(r.dispatchCalls, 0);
  assert.match(r.log, /test-job failed: supervisor unhealthy or dispatch failed after retry/);
});
