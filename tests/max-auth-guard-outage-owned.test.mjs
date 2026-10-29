// max-auth-guard-outage-owned.test.mjs — during a confirmed Max sign-in outage
// the guarded runners refuse (exit 78) and log it, but page nobody: watchdog.sh
// already paged that outage.
//
// Defends against this system-channel fan-out (cluster
// sic-20261021-auth-outage-refusal-fanout). Max was signed out for about five
// hours, until a manual /login. watchdog.sh paged the outage
// (🔴 "Max auth is down … Run `claude /login` on the server"), and then three
// scheduled jobs each added
//   "⚠️ <job> refused to start: this run's `claude auth status` was not the
//    Max subscription (loggedIn=false authMethod=none …) … Remedy: sign Claude
//    Code in to the Max account from a GUI session on the server."
// with the same remedy watchdog had already asked for.
//
// Pinned here:
//   - max_auth_outage_owned_by_watchdog (lib/max-auth-guard.sh) says "owned"
//     only for a signed-OUT summary, plus a fresh failing launchd probe
//     (lib/max-auth-probe.sh) that has lasted >= watchdog's 540 s paging
//     threshold, plus watchdog's own markers saying its auth-outage page was
//     authorised AND delivered (watchdog-incidents/auth-outage.alerted +
//     .delivered). A single reading, ok, stale, absent or unreadable probe,
//     missing markers (watchdog's restored / pre-heal overrides, or an
//     undelivered page), and any non-sign-out refusal (wrong plan, API key)
//     still page. It must not trip `set -euo pipefail`.
//   - each refusing caller (the opus runner, plus any the installation lists),
//     run for real against a fake HOME, a
//     fixture probe file and watchdog markers at their default path: owned ->
//     exit 78, the sender stub is NOT called, the log says why; a single
//     failing reading, or no delivered watchdog page -> still pages once.
//   - structurally, each caller asks max_auth_outage_owned_by_watchdog before
//     its jori-send-curl, and the guard's threshold equals watchdog.sh's.
//
// HERMETIC: HOME is a temp tree holding a recording jori-send-curl stub,
// CLAUDE_BIN is a fake claude printing the logged-out JSON, MAX_AUTH_PROBE_FILE
// points at a fixture, and the watchdog markers live in a temp dir (or under
// the fake HOME). Nothing reaches the real sender, the real claude, the real
// probe file or watchdog's real incident dir.
//
// Run: node --test tests/max-auth-guard-outage-owned.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = path.join(ROOT, "agent/scripts/lib/max-auth-guard.sh");
const WATCHDOG = path.join(ROOT, "agent/scripts/watchdog.sh");

// The kernel's refusing caller, plus the ones this installation adds, from
// agent/local/max-auth-guard/callers.json (private):
//   { "<id>": { "script": "<repo path>", "job": "<job>" } }
// A caller with `job` is a trigger run with no arguments that reads
// agent/ops-agent/jobs/<job>.md and names ai.claude.<job>; one without is a
// runner called as `<script> <job> <playbook> --model <m>`.
const CALLERS = { opus: { script: "agent/scripts/lib/run-ephemeral-opus.sh" } };
try {
  const localCallers = path.join(process.env.JORI_LOCAL_DIR || path.join(ROOT, "agent/local"), "max-auth-guard/callers.json");
  for (const [id, c] of Object.entries(JSON.parse(fs.readFileSync(localCallers, "utf8")))) {
    if (!id.startsWith("_") && c && c.script && fs.existsSync(path.join(ROOT, c.script))) CALLERS[id] = c;
  }
} catch { /* none: the kernel caller only */ }

// The summary max_auth_check produced in those refusal rows.
const SIGNED_OUT = "loggedIn=false authMethod=none apiProvider=firstParty subscription=";
const WRONG_PLAN = "loggedIn=true authMethod=claude.ai apiProvider=firstParty subscription=pro";
const LOGGED_OUT_JSON = JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, null, 2);

const now = () => Math.floor(Date.now() / 1000);

// One JSON line in the shape max_auth_probe_record writes.
function probeLine({ ok, failSec = 0, ageSec = 0 }) {
  const ts = now() - ageSec;
  const since = ok ? 0 : ts - failSec;
  return JSON.stringify({ ts, ok, fail_since: since, summary: ok ? "loggedIn=true authMethod=claude.ai apiProvider=firstParty subscription=max" : SIGNED_OUT, source: "live-day" }) + "\n";
}

function baseEnv(extra = {}) {
  // The refusal names the machine by the instance host_label; pinned so the text
  // reads the same in any installation.
  const env = { ...process.env, JORI_HOST_LABEL: "the server" };
  for (const k of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "SSH_AUTH_SOCK", "MAX_AUTH_PROBE_FILE", "WATCHDOG_INCIDENT_DIR"]) delete env[k];
  return Object.assign(env, extra);
}

const BOTH_MARKERS = ["auth-outage.alerted", "auth-outage.delivered"];

// Source the guard under `set -euo pipefail` and ask it, both as an `if`
// condition and as `|| rc=$?`. `markers` are the watchdog incident files to
// create (default: watchdog paged and the page landed). Returns
// "owned" | "not-owned".
function owned(summary, probe /* string contents, or null for absent */, markers = BOTH_MARKERS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maxauth-owned-"));
  try {
    const file = path.join(dir, "max-auth-probe.json");
    if (probe !== null) fs.writeFileSync(file, probe);
    const incidents = path.join(dir, "watchdog-incidents");
    fs.mkdirSync(incidents);
    for (const m of markers) fs.writeFileSync(path.join(incidents, m), "");
    const script = [
      "set -euo pipefail",
      `source ${JSON.stringify(GUARD)}`,
      `MAX_AUTH_SUMMARY=${JSON.stringify(summary)}`,
      "if max_auth_outage_owned_by_watchdog; then a=owned; else a=not-owned; fi",
      "rc=0; max_auth_outage_owned_by_watchdog || rc=$?",
      'echo "$a rc=$rc"',
    ].join("\n");
    const r = spawnSync("/bin/bash", ["-c", script], {
      encoding: "utf8",
      env: baseEnv({ MAX_AUTH_PROBE_FILE: file, WATCHDOG_INCIDENT_DIR: incidents }),
    });
    assert.equal(r.status, 0, `must not trip set -euo pipefail:\n${r.stderr}`);
    const [a, rc] = r.stdout.trim().split(" ");
    assert.equal(rc, a === "owned" ? "rc=0" : "rc=1", `the two call forms disagree: ${r.stdout}`);
    return a;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("owned: signed out, probe signed out for 600 s, and watchdog's page was delivered", () => {
  assert.equal(owned(SIGNED_OUT, probeLine({ ok: false, failSec: 600 })), "owned");
});

test("not owned unless watchdog's auth-outage page was authorised AND delivered", () => {
  const failing = probeLine({ ok: false, failSec: 600 });
  assert.equal(owned(SIGNED_OUT, failing, []), "not-owned", "no markers: watchdog held it (restored / pre-heal) or never paged");
  assert.equal(owned(SIGNED_OUT, failing, ["auth-outage.alerted"]), "not-owned", ".alerted without .delivered: the page did not land");
  assert.equal(owned(SIGNED_OUT, failing, ["auth-outage.delivered"]), "not-owned", ".delivered alone");
  assert.equal(owned(SIGNED_OUT, failing, ["ops-queue-backlog.alerted", "ops-queue-backlog.delivered"]), "not-owned", "another incident's markers");
  assert.equal(owned(SIGNED_OUT, failing, BOTH_MARKERS), "owned", "all three present");
});

test("not owned: a single failing reading (watchdog waits for a second check)", () => {
  assert.equal(owned(SIGNED_OUT, probeLine({ ok: false, failSec: 0 })), "not-owned");
  assert.equal(owned(SIGNED_OUT, probeLine({ ok: false, failSec: 539 })), "not-owned", "one second under watchdog's 540");
  assert.equal(owned(SIGNED_OUT, probeLine({ ok: false, failSec: 540 })), "owned", "exactly watchdog's threshold");
});

test("not owned: probe ok, stale, absent or unreadable", () => {
  assert.equal(owned(SIGNED_OUT, probeLine({ ok: true })), "not-owned", "ok");
  assert.equal(owned(SIGNED_OUT, probeLine({ ok: false, failSec: 3600, ageSec: 3600 })), "not-owned", "stale (an hour old)");
  assert.equal(owned(SIGNED_OUT, null), "not-owned", "absent");
  assert.equal(owned(SIGNED_OUT, "garbage, no ts\n"), "not-owned", "unreadable");
  assert.equal(owned(SIGNED_OUT, ""), "not-owned", "empty");
});

test("not owned: a refusal that is not a sign-out still pages", () => {
  const failing = probeLine({ ok: false, failSec: 600 });
  assert.equal(owned(WRONG_PLAN, failing), "not-owned", "signed in on the wrong plan");
  assert.equal(owned("loggedIn=true authMethod=api_key apiProvider=firstParty subscription=", failing), "not-owned", "API-key login");
  assert.equal(owned("loggedIn= authMethod= apiProvider= subscription=", failing), "not-owned", "status it could not read");
  assert.equal(owned("", failing), "not-owned", "no summary at all");
});

test("not owned when the probe lib cannot be found (fail open toward paging)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maxauth-nolib-"));
  try {
    const guardCopy = path.join(dir, "max-auth-guard.sh"); // no max-auth-probe.sh beside it
    fs.copyFileSync(GUARD, guardCopy);
    const probe = path.join(dir, "probe.json");
    fs.writeFileSync(probe, probeLine({ ok: false, failSec: 600 }));
    // Every other condition holds, so only the missing lib can say no.
    const incidents = path.join(dir, "watchdog-incidents");
    fs.mkdirSync(incidents);
    for (const m of BOTH_MARKERS) fs.writeFileSync(path.join(incidents, m), "");
    const r = spawnSync("/bin/bash", ["-c", `set -euo pipefail; source ${JSON.stringify(guardCopy)}; MAX_AUTH_SUMMARY=${JSON.stringify(SIGNED_OUT)}; if max_auth_outage_owned_by_watchdog; then echo owned; else echo not-owned; fi`], {
      encoding: "utf8",
      env: baseEnv({ MAX_AUTH_PROBE_FILE: probe, WATCHDOG_INCIDENT_DIR: incidents }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "not-owned");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maxauth-owned-home-"));
  const g = path.join(home, "Dev/jori");
  for (const d of ["bin", "agent/logs", "agent/config", "agent/ops-agent/jobs", "data"]) {
    fs.mkdirSync(path.join(g, d), { recursive: true });
  }
  const sends = path.join(home, "sends.log");
  fs.writeFileSync(
    path.join(g, "bin/jori-send-curl"),
    `#!/bin/bash\nprintf 'CALL' >> ${JSON.stringify(sends)}\nfor a in "$@"; do printf ' [%s]' "$a" >> ${JSON.stringify(sends)}; done\necho >> ${JSON.stringify(sends)}\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(g, "agent/config/models.env"), "JORI_MODEL_OPUS=claude-opus-5-5\n");
  for (const c of Object.values(CALLERS)) if (c.job) fs.writeFileSync(path.join(g, `agent/ops-agent/jobs/${c.job}.md`), "# stub\n");
  const md = path.join(home, "job.md");
  fs.writeFileSync(md, "# stub job\n");
  const claude = path.join(home, "claude");
  const calls = path.join(home, "claude-calls");
  fs.writeFileSync(claude, `#!/bin/bash\necho "$*" >> ${JSON.stringify(calls)}\nif [ "$1" = auth ]; then cat <<'S'\n${LOGGED_OUT_JSON}\nS\nexit 0; fi\ncat > /dev/null\necho '{"type":"result","result":"done"}'\n`, { mode: 0o755 });
  const probe = path.join(home, "max-auth-probe.json");
  return { home, g, md, claude, calls, sends, probe };
}

// markers go to watchdog's DEFAULT incident dir under the fake HOME (no
// WATCHDOG_INCIDENT_DIR), so the production path is what gets exercised.
function runCaller(which, probe, markers = BOTH_MARKERS) {
  const h = fakeHome();
  try {
    fs.writeFileSync(h.probe, probe);
    const incidents = path.join(h.g, "data/watchdog-incidents");
    fs.mkdirSync(incidents, { recursive: true });
    for (const m of markers) fs.writeFileSync(path.join(incidents, m), "");
    const c = CALLERS[which];
    const script = path.join(ROOT, c.script);
    const job = c.job || "guard-owned-test";
    const args = c.job ? [script] : [script, job, h.md, "--model", "claude-opus-5-5"];
    const r = spawnSync("/bin/bash", args, {
      encoding: "utf8",
      env: baseEnv({ HOME: h.home, CLAUDE_BIN: h.claude, MAX_AUTH_PROBE_FILE: h.probe }),
      timeout: 30000,
    });
    const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
    return {
      job,
      status: r.status,
      stderr: r.stderr,
      sends: read(h.sends),
      claudeCalls: read(h.calls),
      log: read(path.join(h.g, `agent/logs/${job}.log`)),
    };
  } finally {
    fs.rmSync(h.home, { recursive: true, force: true });
  }
}

for (const which of Object.keys(CALLERS)) {
  test(`${CALLERS[which].script}: during a confirmed outage refuses with 78, logs it, pages nobody`, () => {
    const r = runCaller(which, probeLine({ ok: false, failSec: 600 }));
    assert.equal(r.status, 78, `must still refuse with EX_CONFIG:\n${r.stderr}`);
    assert.equal(r.sends, "", `jori-send-curl must NOT be called during an outage watchdog owns; calls:\n${r.sends}`);
    assert.ok(!/(^|\n)-p\b/.test(r.claudeCalls), `the model must not be called:\n${r.claudeCalls}`);
    assert.match(
      r.log,
      /REFUSED: not on the Max subscription \(loggedIn=false authMethod=none[^)]*\) \(confirmed Max sign-in outage — watchdog\.sh owns that page; not paged\)/,
    );
  });

  for (const [why, probe, markers] of [
    ["a single failing probe reading", probeLine({ ok: false, failSec: 0 }), BOTH_MARKERS],
    ["watchdog's page not delivered", probeLine({ ok: false, failSec: 600 }), ["auth-outage.alerted"]],
  ]) {
    test(`${CALLERS[which].script}: ${why} still pages once`, () => {
      const r = runCaller(which, probe, markers);
      assert.equal(r.status, 78);
      const calls = r.sends.split("\n").filter(Boolean);
      assert.equal(calls.length, 1, `exactly one page expected; calls:\n${r.sends}`);
      assert.match(calls[0], new RegExp(`\\[⚠️ ${r.job} refused to start: `));
      assert.ok(!/not paged/.test(r.log), `a paged refusal must not be logged as unpaged:\n${r.log}`);
    });
  }
}

test("every refusing caller asks max_auth_outage_owned_by_watchdog before paging", () => {
  for (const { script: rel } of Object.values(CALLERS)) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const check = src.indexOf("if ! max_auth_check");
    const ssh = src.indexOf("if max_auth_from_ssh", check);
    const owned = src.indexOf("elif max_auth_outage_owned_by_watchdog", check);
    const page = src.indexOf("jori-send-curl", check);
    assert.ok(check > 0 && ssh > check && owned > ssh && page > owned, `${rel}: the refusal page must sit behind max_auth_outage_owned_by_watchdog`);
    assert.match(src, /A confirmed Max sign-in outage/, `${rel}: say what the outage branch guards`);
  }
});

test("the guard reads watchdog.sh's own incident dir", () => {
  const guard = fs.readFileSync(GUARD, "utf8");
  const wd = fs.readFileSync(WATCHDOG, "utf8").match(/^INCIDENT_DIR="\$HOME(\/[^"]+)"$/m);
  assert.ok(wd, "watchdog.sh's INCIDENT_DIR moved; re-point this test");
  assert.ok(guard.includes(`\${HOME:-}${wd[1]}}`), `the guard's default must be watchdog's INCIDENT_DIR (${wd[1]})`);
});

test("the guard's paging threshold equals watchdog.sh's", () => {
  const guard = fs.readFileSync(GUARD, "utf8");
  const mine = guard.match(/^MAX_AUTH_WATCHDOG_PAGE_SEC=(\d+)$/m);
  assert.ok(mine, "MAX_AUTH_WATCHDOG_PAGE_SEC must be a plain integer assignment");
  const wd = fs.readFileSync(WATCHDOG, "utf8").match(/"\$MAX_AUTH_PROBE_FAIL_SEC" -lt (\d+)/);
  assert.ok(wd, "watchdog.sh's probe paging threshold moved; re-point this test");
  assert.equal(mine[1], wd[1], "a different threshold would hush a refusal before watchdog pages, or page after it did");
});
