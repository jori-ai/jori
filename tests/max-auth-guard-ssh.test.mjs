// max-auth-guard-ssh.test.mjs — a Max-auth refusal from a hand-run SSH session
// refuses (exit 78) but pages nobody.
//
// Defends against this system-channel alert, which read like a Max outage and
// was not one (cluster sic-20261015-ssh-handrun-max-refusal-page):
//   "⚠️ <job> refused to start: this run's `claude auth status` was not
//    the Max subscription (loggedIn=false authMethod=none …) … Remedy: sign
//    Claude Code in to the Max account from a GUI session on the server."
// An operator ran a job's trigger script by hand over SSH. An SSH session cannot reach the login keychain,
// so `auth status` read as signed out; the job re-ran 30 s later from launchd
// and exited 0. The page's remedy was false.
//
// Pinned here:
//   - max_auth_from_ssh keys on SSH_CONNECTION / SSH_CLIENT only — never
//     SSH_AUTH_SOCK, which launchd sets for every GUI-session job.
//   - each refusing caller (the opus runner, plus any the installation lists),
//     run for real against a fake HOME: over SSH -> exit 78, the
//     sender stub is NOT called, stderr names `launchctl kickstart`; unattended
//     (SSH vars cleared, SSH_AUTH_SOCK set) -> exit 78 and the page goes out
//     once, with its text unchanged.
//
// HERMETIC: every path these scripts touch is "$HOME/Dev/jori/…", so HOME is
// a temp tree holding a recording jori-send-curl stub, and CLAUDE_BIN is a
// fake claude whose `auth status` prints the logged-out JSON. Nothing reaches
// the real sender or the real claude.
//
// Run: node --test tests/max-auth-guard-ssh.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = path.join(ROOT, "agent/scripts/lib/max-auth-guard.sh");

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

// The shape `claude auth status --json` printed in that SSH run.
const LOGGED_OUT = JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, null, 2);
const SSH = { SSH_CONNECTION: "203.0.113.7 52144 192.168.1.20 22" };

// A baseline env with no SSH markers, whatever shell runs this suite (it may
// itself be an SSH session); each case adds back only what it tests.
function baseEnv(extra = {}) {
  // The refusal names the machine by the instance host_label; pinned so the text
  // reads the same in any installation.
  const env = { ...process.env, JORI_HOST_LABEL: "the server" };
  delete env.SSH_CONNECTION;
  delete env.SSH_CLIENT;
  delete env.SSH_TTY;
  delete env.SSH_AUTH_SOCK;
  return Object.assign(env, extra);
}

function fromSsh(extra) {
  const r = spawnSync("/bin/bash", ["-c", `set -u; source ${JSON.stringify(GUARD)}; if max_auth_from_ssh; then echo yes; else echo no; fi`], {
    encoding: "utf8",
    env: baseEnv(extra),
  });
  assert.equal(r.status, 0, `the check must not trip set -u:\n${r.stderr}`);
  return r.stdout.trim();
}

test("max_auth_from_ssh keys on SSH_CONNECTION / SSH_CLIENT, never SSH_AUTH_SOCK", () => {
  assert.equal(fromSsh(SSH), "yes", "SSH_CONNECTION marks an SSH login");
  assert.equal(fromSsh({ SSH_CLIENT: "203.0.113.7 52144 22" }), "yes", "SSH_CLIENT marks an SSH login");
  assert.equal(fromSsh({}), "no", "no SSH markers: unattended");
  assert.equal(
    fromSsh({ SSH_AUTH_SOCK: "/private/tmp/com.apple.launchd.abc/Listeners" }),
    "no",
    "launchd sets SSH_AUTH_SOCK for every GUI-session job; it must not suppress a real page",
  );
});

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maxauth-ssh-"));
  const g = path.join(home, "Dev/jori");
  for (const d of ["bin", "agent/logs", "agent/config", "agent/ops-agent/jobs"]) {
    fs.mkdirSync(path.join(g, d), { recursive: true });
  }
  const sends = path.join(home, "sends.log");
  fs.writeFileSync(
    path.join(g, "bin/jori-send-curl"),
    `#!/bin/bash\nprintf 'CALL' >> ${JSON.stringify(sends)}\nfor a in "$@"; do printf ' [%s]' "$a" >> ${JSON.stringify(sends)}; done\necho >> ${JSON.stringify(sends)}\n`,
    { mode: 0o755 },
  );
  // The portfolio trigger reads its model from models.env and its playbook from
  // the fixed ops-agent path; give it both so it reaches the guard.
  fs.writeFileSync(path.join(g, "agent/config/models.env"), "JORI_MODEL_OPUS=claude-opus-5-5\n");
  for (const c of Object.values(CALLERS)) if (c.job) fs.writeFileSync(path.join(g, `agent/ops-agent/jobs/${c.job}.md`), "# stub\n");
  const md = path.join(home, "job.md");
  fs.writeFileSync(md, "# stub job\n");
  const claude = path.join(home, "claude");
  const calls = path.join(home, "claude-calls");
  fs.writeFileSync(claude, `#!/bin/bash\necho "$*" >> ${JSON.stringify(calls)}\nif [ "$1" = auth ]; then cat <<'S'\n${LOGGED_OUT}\nS\nexit 0; fi\ncat > /dev/null\necho '{"type":"result","result":"done"}'\n`, { mode: 0o755 });
  return { home, g, md, claude, calls, sends };
}

function runCaller(which, extraEnv) {
  const h = fakeHome();
  try {
    const c = CALLERS[which];
    const script = path.join(ROOT, c.script);
    const job = c.job || "guard-ssh-test";
    const args = c.job ? [script] : [script, job, h.md, "--model", "claude-opus-5-5"];
    const r = spawnSync("/bin/bash", args, {
      encoding: "utf8",
      env: baseEnv({ HOME: h.home, CLAUDE_BIN: h.claude, ...extraEnv }),
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
  test(`${CALLERS[which].script}: an SSH hand-run refuses with 78, tells the operator, pages nobody`, () => {
    const r = runCaller(which, SSH);
    assert.equal(r.status, 78, `must still refuse with EX_CONFIG:\n${r.stderr}`);
    assert.equal(r.sends, "", `jori-send-curl must NOT be called from an SSH session; calls:\n${r.sends}`);
    assert.ok(!/(^|\n)-p\b/.test(r.claudeCalls), `the model must not be called:\n${r.claudeCalls}`);
    assert.match(r.stderr, /SSH session/, "stderr must say why it refused");
    assert.match(r.stderr, /launchctl kickstart gui\/\$\(id -u\)\/ai\.claude\./, "stderr must name the launchd remedy");
    if (CALLERS[which].job) assert.match(r.stderr, new RegExp(`ai\\.claude\\.${CALLERS[which].job}`));
    assert.match(r.log, /REFUSED: not on the Max subscription \(loggedIn=false authMethod=none[^)]*\) \(SSH session; not paged\)/);
  });

  test(`${CALLERS[which].script}: an unattended refusal still pages once, text unchanged`, () => {
    const r = runCaller(which, { SSH_AUTH_SOCK: "/private/tmp/com.apple.launchd.abc/Listeners" });
    assert.equal(r.status, 78);
    const calls = r.sends.split("\n").filter(Boolean);
    assert.equal(calls.length, 1, `exactly one page expected; calls:\n${r.sends}`);
    assert.match(calls[0], /\[--skip-precheck\] \[--channel\] \[system\] \[--observed-error\] \[loggedIn=false authMethod=none/);
    assert.match(
      calls[0],
      new RegExp(`\\[⚠️ ${r.job} refused to start: .*Remedy: sign Claude Code in to the Max account from a GUI session on the server\\.\\]`),
    );
    assert.ok(!/not paged/.test(r.log), `an unattended refusal must not be logged as unpaged:\n${r.log}`);
    assert.doesNotMatch(r.stderr, /launchctl kickstart/);
  });
}

test("every refusing caller gates its page on max_auth_from_ssh", () => {
  for (const { script: rel } of Object.values(CALLERS)) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const check = src.indexOf("if ! max_auth_check");
    const ssh = src.indexOf("if max_auth_from_ssh", check);
    const page = src.indexOf("jori-send-curl", check);
    assert.ok(check > 0 && ssh > check && page > ssh, `${rel}: the refusal page must sit behind max_auth_from_ssh`);
    assert.match(src, /Hand-run over SSH/, `${rel}: say what the SSH branch guards`);
  }
});
