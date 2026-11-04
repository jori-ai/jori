// live-day-trigger-launchd.test.mjs — the live-day refresh runs under launchd
// without going dark, never calls Claude without a verified Max login, and its
// log line says what happened. Throwaway HOME (its Dev/jori is the
// installation, also given as JORI_HOME), stubbed `launchctl`, `claude` and
// `live-day`; nothing real runs, no network, no model.
// Run: node --test tests/live-day-trigger-launchd.test.mjs
import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "live-day-trigger-"));
const write = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body, { mode: 0o755 }); return f; };
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
// Any `claude` the photo step spawns lands here (max-judge reads CLAUDE_BIN at load).
const SPAWNS = path.join(TMP, "claude-spawns.log");
process.env.CLAUDE_BIN = write(path.join(TMP, "claude"), `#!/bin/bash\necho "$*" >> "${SPAWNS}"\n` +
  `echo '{"is_error":false,"structured_output":{"name":null,"listed":null,"confidence":0,"evidence":"stub"}}'\n`);
const require = createRequire(import.meta.url);
const { nameStopsFromPhotoText, _internal: { askModel } } = require("../lib/photo-place-name.js");
const TRIGGER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent", "scripts", "trigger-live-day.sh");

const stop = (words = ["aurora", "coffee", "bar"]) => ({ start: "07:49", end: "08:30", place: null,
  photo_text_eligible: ["P1"], photos: [{ uuid: "P1", self_captured: true, ts: "2099-02-10T04:55:00Z" }], words });
const textOf = (stops) => (uuid) => ({ tokens: stops.find(s => s.photos[0].uuid === uuid).words, labels: [] });
const named = { name: "Aurora", listed: null, confidence: 0.92, evidence: "sign" };

test("the tally counts answered, ceiling, too-few-words, failed and skipped separately", async () => {
  const stops = [stop(["open"]), ...Array.from({ length: 13 }, () => stop())];
  stops.forEach((s, i) => { s.photos = [{ ...s.photos[0], uuid: `P${i}` }]; s.photo_text_eligible = [`P${i}`]; });
  let n = 0;
  const ask = async () => {
    n += 1;
    if (n === 2) throw new Error("claude -p: usage limit");
    if (n === 3) throw new Error("legacy failed after jev jev-low-confidence: photo cross-check skipped: no Claude login from cron");
    return n === 1 ? named : { ...named, name: null };
  };
  const { tally } = await nameStopsFromPhotoText(stops, textOf(stops), { ask });
  assert.deepEqual(tally, { eligible: 14, answered: 10, named: 1, ceiling: 1, few_words: 1, failed: 1, no_login: 1,
    error: "claude -p: usage limit" });
});

test("with the no-login flag the photo step never spawns claude; without it, it does", async () => {
  const report = path.join(TMP, "report.jsonl");
  Object.assign(process.env, { JORI_PHOTO_TEXT_NO_CLAUDE: "no Claude login from cron", JORI_PHOTO_TEXT_REPORT: report });
  try {
    const stops = [stop()];
    const { tally } = await nameStopsFromPhotoText(stops, textOf(stops), { ask: askModel });
    assert.deepEqual([tally.no_login, tally.failed, tally.answered], [1, 0, 0]);
    assert.equal(read(SPAWNS), "", "no claude -p while the login is unreachable");
    assert.equal(JSON.parse(read(report).trim()).no_login, 1);
  } finally {
    delete process.env.JORI_PHOTO_TEXT_NO_CLAUDE;
    delete process.env.JORI_PHOTO_TEXT_REPORT;
  }
  assert.equal((await askModel({ photo_words: ["aurora"] })).evidence, "stub");
  assert.match(read(SPAWNS), /^-p --model /);
});

// lib/launchd-kick.sh still finds the installation at $HOME/<this>, so the fake HOME mirrors it.
const INST_REL = "Dev/jori"; // kernel-closure-ok: the fake HOME's installation dir, matching launchd-kick.sh

function sandbox({ loaded = false, kickFails = false, maxOk = true, repoPlist = false, bootstrapFails = false } = {}) {
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  const calls = path.join(home, "calls.log"), logs = path.join(home, INST_REL, "agent/logs");
  fs.mkdirSync(logs, { recursive: true });
  // The refresh as cron saw it: resolve-day chatter on stderr, a photo tally, the JSON on stdout.
  write(path.join(home, INST_REL, "bin/live-day"), `#!/bin/bash
echo "live-day $* no_claude=\${JORI_PHOTO_TEXT_NO_CLAUDE:-}" >> "${calls}"
echo '[resolve-day] wrote back "Aurora" (photo_text) onto visit 123' >&2
echo '{"eligible":2,"answered":1,"named":1,"ceiling":0,"few_words":0,"failed":0,"no_login":1,"error":null}' >> "$JORI_PHOTO_TEXT_REPORT"
echo '{"ok":true,"intervals":3,"current_interval_id":"iv-gps-1","summary":{"calendar_seeded":0}}'
`);
  write(path.join(home, INST_REL, "bin/jori-send-curl"), `#!/bin/bash\necho "jori-send-curl $*" >> "${calls}"\n`);
  write(path.join(home, ".local/bin/claude"), `#!/bin/bash\necho "claude $*" >> "${calls}"\n` +
    `echo '{"loggedIn": ${maxOk}, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"}'\n`);
  // A plist in the repo that was never installed (launchd-kick.sh installs it itself).
  if (repoPlist) write(path.join(home, INST_REL, "agent/launch-agents/ai.claude.live-day.plist"),
    read(path.join(path.dirname(TRIGGER), "..", "launch-agents", "ai.claude.live-day.plist")));
  const stub = path.join(home, "stub"), mark = path.join(home, "bootstrapped");
  write(path.join(stub, "launchctl"), `#!/bin/bash
echo "launchctl $*" >> "${calls}"
case "$1" in
  print) [ -e "${mark}" ] && exit 0; ${loaded ? "exit 0" : 'echo "Could not find service" >&2; exit 113'} ;;
  kickstart) ${kickFails ? 'echo "Boot-out in progress" >&2; exit 37' : "exit 0"} ;;
  bootstrap) ${bootstrapFails ? 'echo "Bootstrap failed: 5: Input/output error" >&2; exit 5' : `: > "${mark}"`} ;;
esac
`);
  write(path.join(stub, "plutil"), `#!/bin/bash\necho "plutil $*" >> "${calls}"\nexec /usr/bin/plutil "$@"\n`);
  const { CLAUDE_BIN, ...env } = { ...process.env, HOME: home, JORI_HOME: path.join(home, INST_REL), PATH: `${stub}:${process.env.PATH}` };
  return {
    installed: path.join(home, "Library/LaunchAgents/ai.claude.live-day.plist"),
    lock: path.join(logs, "live-day-refresh.lock"),
    run: (...args) => spawnSync("/bin/bash", [TRIGGER, ...args], { env, encoding: "utf8", timeout: 30000 }),
    calls: () => read(calls),
    refreshes: () => read(calls).match(/^live-day refresh.*$/gm) || [],
    log: () => read(path.join(logs, "watchdog.log")),
  };
}
const COUNTS = "intervals=3 current=iv-gps-1 calendar_seeded=0 photos: stops=2 answered=1 named=1 ceiling=0 few_words=0 failed=0 no_login=1";

test("agent not installed and no repo plist to install: inline refresh without the Claude call, one honest line, no page", () => {
  const sb = sandbox();
  assert.equal(sb.run().status, 0);
  assert.deepEqual(sb.refreshes(), ["live-day refresh no_claude=no Claude login from cron"]);
  assert.doesNotMatch(sb.calls(), /kickstart|jori-send-curl|claude auth/);
  assert.match(sb.log(), new RegExp(`^\\S+ \\S+ \\[live-day\\] refresh ok: ${COUNTS}; photo cross-check skipped: no Claude login from cron \\[inline from cron: ai\\.claude\\.live-day not installed\\]\n$`));
});

test("agent added but never installed: cron installs it from the repo and kicks it, no inline refresh, no page", () => {
  const sb = sandbox({ repoPlist: true });
  assert.equal(sb.run().status, 0);
  const uid = process.getuid();
  assert.match(sb.calls(), new RegExp(`^launchctl bootstrap gui/${uid} ${sb.installed}\nlaunchctl kickstart gui/${uid}/ai\\.claude\\.live-day$`, "m"));
  assert.equal(fs.existsSync(sb.installed), true);
  assert.deepEqual(sb.refreshes(), []);
  assert.doesNotMatch(sb.calls(), /jori-send-curl|claude auth/);
  assert.match(sb.log(), /\[live-day\] installed launchd agent ai\.claude\.live-day from the repo \(it was added but never installed\)\n\S+ \S+ \[live-day\] kicked launchd agent ai\.claude\.live-day\n$/);
  // A failed install leaves no copy behind and keeps the inline refresh; still no page.
  const failed = sandbox({ repoPlist: true, bootstrapFails: true });
  assert.equal(failed.run().status, 0);
  assert.equal(fs.existsSync(failed.installed), false);
  assert.equal(failed.refreshes().length, 1);
  assert.doesNotMatch(failed.calls(), /kickstart|jori-send-curl/);
  assert.match(failed.log(), /installing launchd agent ai\.claude\.live-day failed: Bootstrap failed: 5[^\n]*\n.*\[inline from cron: ai\.claude\.live-day not installed\]\n$/);
});

test("agent installed: cron only kicks it (no -k); a failed kick refreshes inline", () => {
  const sb = sandbox({ loaded: true });
  assert.equal(sb.run().status, 0);
  assert.match(sb.calls(), new RegExp(`^launchctl kickstart gui/${process.getuid()}/ai\\.claude\\.live-day$`, "m"));
  assert.deepEqual(sb.refreshes(), []);
  assert.match(sb.log(), /\[live-day\] kicked launchd agent ai\.claude\.live-day\n$/);
  const failed = sandbox({ loaded: true, kickFails: true });
  assert.equal(failed.run().status, 0);
  assert.equal(failed.refreshes().length, 1);
  assert.match(failed.log(), /\[inline from cron: kickstart ai\.claude\.live-day failed: Boot-out in progress\]\n$/);
});

test("under launchd the Claude call runs only after the Max check passes; a failed check keeps the refresh", () => {
  const ok = sandbox();
  assert.equal(ok.run("--run").status, 0);
  assert.match(ok.calls(), /^claude auth status --json$/m);
  assert.deepEqual(ok.refreshes(), ["live-day refresh no_claude="]);
  assert.ok(ok.log().endsWith(`refresh ok: ${COUNTS}\n`), ok.log());
  const broken = sandbox({ maxOk: false });
  assert.equal(broken.run("--run").status, 0);
  assert.match(broken.refreshes()[0], /no_claude=Max login check failed \(loggedIn=false authMethod=claude\.ai/);
  assert.match(broken.log(), /photo cross-check skipped: Max login check failed \(loggedIn=false .*\)\n$/);
  assert.doesNotMatch(broken.calls(), /jori-send-curl/, "no page every 10 minutes");
});

test("a refresh in progress makes the next one skip; a lock file left by a dead run does not", async () => {
  const sb = sandbox();
  const holder = spawn("/usr/bin/lockf", ["-k", sb.lock, "/bin/sleep", "30"], { stdio: "ignore", detached: true });
  await new Promise(r => setTimeout(r, 300));
  const r = sb.run();
  process.kill(-holder.pid);   // lockf and its sleep
  assert.equal(r.status, 0);
  assert.deepEqual(sb.refreshes(), []);
  assert.match(sb.log(), /refresh skipped: the previous refresh is still running/);
  await new Promise(r => holder.once("exit", r));
  assert.equal(fs.existsSync(sb.lock), true);
  assert.equal(sb.run().status, 0);
  assert.equal(sb.refreshes().length, 1);
});
