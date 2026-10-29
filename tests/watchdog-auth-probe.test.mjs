// watchdog-auth-probe.test.mjs: pins watchdog.sh's Max-auth outage hold on
// the launchd sign-in check (cluster sic-20260827-false-auth-recovery).
//
// THE ALERT THIS DEFENDS: "✅ Recovered: Max auth is back to normal" posted
// while the outage was still live. On 2026-10-21 Max was signed out from about
// 22:00 ET to a manual /login at 02:48 ET. ops logged one AUTH ERROR (23:00)
// and then ran no turn for 4 hours, and chat logged one (02:05). Neither crossed
// the 3-failure threshold that sets authAlertSent, so once each line aged out
// of watchdog's 6-minute window nothing held the incident. The channel got
// "✅ Recovered" at 23:08 and 02:14 ET, both inside the outage. live-day's
// launchd run had read loggedIn=false every 10 minutes the whole time. It now
// records that in data/max-auth-probe.json (lib/max-auth-probe.sh), and
// watchdog holds the incident open, and pages, on a fresh signed-out reading.
//
// Behavioral cases run the real lib and the real watchdog section (with the
// real incident_* / notify machinery) in bash, with curl, the agent loader and
// the sender replaced by stubs. Nothing touches the real machine.
//
// Run against a proposed copy:
//   WATCHDOG_SH=/tmp/x/watchdog.sh MAX_AUTH_PROBE_SH=/tmp/x/lib/max-auth-probe.sh \
//   LIVE_DAY_SH=/tmp/x/trigger-live-day.sh node --test tests/watchdog-auth-probe.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(REPO_ROOT, "agent/scripts");
const WATCHDOG_PATH = process.env.WATCHDOG_SH || path.join(SCRIPTS, "watchdog.sh");
const PROBE_LIB = process.env.MAX_AUTH_PROBE_SH || path.join(SCRIPTS, "lib/max-auth-probe.sh");
const LIVE_DAY_PATH = process.env.LIVE_DAY_SH || path.join(SCRIPTS, "trigger-live-day.sh");
const SRC = fs.readFileSync(WATCHDOG_PATH, "utf8");

const SECTION_HEADER = "# --- Max auth outage";
const NEXT_HEADER = "# --- Wiki server health ---";

function fnSrc(name) {
  const start = SRC.indexOf(`\n${name}() {`);
  assert.notEqual(start, -1, `${name} must be defined in watchdog.sh`);
  const end = SRC.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} must be a closed function body`);
  return SRC.slice(start + 1, end + 3);
}

function sectionSrc() {
  const start = SRC.indexOf(SECTION_HEADER);
  assert.notEqual(start, -1, `expected a "${SECTION_HEADER}" section in watchdog.sh`);
  const end = SRC.indexOf(NEXT_HEADER, start);
  assert.notEqual(end, -1, `the auth section must end before "${NEXT_HEADER}"`);
  return SRC.slice(start, end);
}

// ---- harness ---------------------------------------------------------------

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wd-auth-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const logs = path.join(home, "Dev/jori/agent/logs");
  const data = path.join(home, "Dev/jori/data");
  const config = path.join(root, "config");
  for (const d of [bin, logs, data, config, path.join(data, "watchdog-incidents")]) fs.mkdirSync(d, { recursive: true });
  const stub = (p, body) => { fs.writeFileSync(p, `#!/bin/bash\n${body}\n`); fs.chmodSync(p, 0o755); return p; };
  // Every supervisor answers /health with $FAKE_HEALTH.
  stub(path.join(bin, "curl"), 'printf "%s" "${FAKE_HEALTH:-}"; [ -n "${FAKE_HEALTH:-}" ]');
  stub(path.join(config, "load-agent.sh"), 'echo "AGENT_SUPERVISOR_HEALTH_PORT=19999"');
  // FAKE_SEND_FAIL=1 makes a send fail (nothing recorded). sentargs keeps every
  // argument, for the flag checks of the renewal heads-up.
  const send = stub(path.join(bin, "send"),
    '[ -n "${FAKE_SEND_FAIL:-}" ] && exit 1; printf "%s\\n" "${@: -1}" >> "$STUB_LOG_DIR/sent"; printf "%s\\n" "$*" >> "$STUB_LOG_DIR/sentargs"');
  return {
    root, bin, home, logs, config, send,
    probeFile: path.join(data, "max-auth-probe.json"),
    reloginFile: path.join(data, "max-auth-relogin.json"),
    incidents: path.join(data, "watchdog-incidents"),
    sentArgs: () => (fs.existsSync(path.join(root, "sentargs")) ? fs.readFileSync(path.join(root, "sentargs"), "utf8").split("\n").filter(Boolean) : []),
    sent: () => (fs.existsSync(path.join(root, "sent")) ? fs.readFileSync(path.join(root, "sent"), "utf8").split("\n").filter(Boolean) : []),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const env = (sb, extra = {}) => ({
  PATH: `${sb.bin}:/opt/homebrew/bin:/usr/bin:/bin`,
  HOME: sb.home,
  STUB_LOG_DIR: sb.root,
  MAX_AUTH_PROBE_FILE: sb.probeFile,
  JORI_HOST_LABEL: "the server", // the alerts name the machine by the instance host_label
  ...extra,
});

const now = () => Math.floor(Date.now() / 1000);
const isoZ = (epoch) => new Date(epoch * 1000).toISOString().replace(/\.\d+Z$/, ".000Z");

function writeProbe(sb, { ts, ok, failSince = 0 }) {
  fs.writeFileSync(sb.probeFile,
    `{"ts":${ts},"ok":${ok},"fail_since":${failSince},"summary":"loggedIn=${ok} authMethod=none","source":"live-day"}\n`);
}

// One watchdog tick of the auth section. Returns what it logged and paged.
function tick(sb, { health = '{"authAlertSent":false,"authErrorCount":1}', keychainHealed = "0" } = {}) {
  const script = [
    'INCIDENT_DIR="$HOME/Dev/jori/data/watchdog-incidents"',
    `CONFIG_DIR=${JSON.stringify(sb.config)}`,
    `SEND=${JSON.stringify(sb.send)}`,
    'EMAIL_SEND=/nonexistent',
    'PENDING_ALERT_KEY=""',
    'ISSUES=""',
    `KEYCHAIN_HEALED=${keychainHealed}`,
    'log() { printf "%s\\n" "$*" >> "$STUB_LOG_DIR/log"; }',
    `source ${JSON.stringify(PROBE_LIB)}`,
    fnSrc("_incident_label"), fnSrc("incident_seen"), fnSrc("incident_clear"),
    fnSrc("incident_should_alert"), fnSrc("notify"),
    sectionSrc(),
    'printf "ISSUES=%s\\n" "$ISSUES"',
  ].join("\n");
  const before = sb.sent().length;
  const out = execFileSync("bash", ["-c", script], { encoding: "utf8", env: env(sb, { FAKE_HEALTH: health }) });
  return { issues: (out.match(/ISSUES=(.*)/) || [])[1] || "", pages: sb.sent().slice(before) };
}

// A supervisor log whose only AUTH ERROR is `ageSec` old (outside the 6-min window).
function staleAuthError(sb, ageSec) {
  fs.writeFileSync(path.join(sb.logs, "ops-supervisor.log"),
    `${isoZ(now() - ageSec)} [ops] AUTH ERROR #1: Failed to authenticate: OAuth session expired and could not be refreshed\n`);
}

// Pretend an earlier tick paged for this incident (as the 03:02Z red did).
function markPaged(sb) {
  const d = path.join(sb.home, "Dev/jori/data/watchdog-incidents");
  for (const f of ["auth-outage.alerted", "auth-outage.delivered", "auth-outage.alert_first"]) fs.writeFileSync(path.join(d, f), "");
  fs.writeFileSync(path.join(d, "auth-outage.alert_count"), "1");
  // Cooldown elapsed, so a re-page is allowed.
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(d, "auth-outage.alerted"), old, old);
}

function readProbe(sb, at = now()) {
  const out = execFileSync("bash", ["-c",
    `source ${JSON.stringify(PROBE_LIB)}; max_auth_probe_read ${at} 1200; ` +
    'printf "%s|%s|%s|%s" "$MAX_AUTH_PROBE_STATE" "$MAX_AUTH_PROBE_FAIL_SEC" "$MAX_AUTH_PROBE_SINCE" "$MAX_AUTH_PROBE_SUMMARY"'],
    { encoding: "utf8", env: env(sb) });
  const [state, failSec, since, summary] = out.split("|");
  return { state, failSec: Number(failSec), since: Number(since), summary };
}

function record(sb, ok, summary = "loggedIn=false authMethod=none apiProvider=firstParty subscription=") {
  execFileSync("bash", ["-c", `source ${JSON.stringify(PROBE_LIB)}; max_auth_probe_record ${ok} "$1" live-day`, "_", summary],
    { encoding: "utf8", env: env(sb) });
  return JSON.parse(fs.readFileSync(sb.probeFile, "utf8"));
}

// ---- static ----------------------------------------------------------------

test("watchdog.sh, the probe lib and trigger-live-day.sh all parse", () => {
  for (const p of [WATCHDOG_PATH, PROBE_LIB, LIVE_DAY_PATH]) execFileSync("bash", ["-n", p]);
});

test("live-day records the check only in its launchd --run mode, and never from SSH", () => {
  const src = fs.readFileSync(LIVE_DAY_PATH, "utf8");
  const run = src.indexOf('if [ "${1:-}" = "--run" ]; then');
  const els = src.indexOf("\nelse\n", run);
  assert.ok(run > 0 && els > run, "expected the --run branch");
  const calls = [...src.matchAll(/max_auth_probe_record/g)].map((m) => m.index);
  assert.equal(calls.length, 2, "one record for ok, one for failed");
  for (const i of calls) {
    assert.ok(i > run && i < els, "a cron-context record would always read signed out");
    assert.match(src.slice(src.lastIndexOf("\n", i), i), /max_auth_from_ssh \|\|/, "an SSH shell always reads signed out");
  }
});

// ---- lib -------------------------------------------------------------------

test("an absent record is no evidence", () => {
  const sb = makeSandbox();
  try { assert.equal(readProbe(sb).state, "absent"); } finally { sb.cleanup(); }
});

test("a record older than 20 minutes, from the future, or garbled reads stale", () => {
  const sb = makeSandbox();
  try {
    writeProbe(sb, { ts: now() - 1300, ok: false, failSince: now() - 5000 });
    assert.equal(readProbe(sb).state, "stale");
    writeProbe(sb, { ts: now() + 900, ok: false });
    assert.equal(readProbe(sb).state, "stale");
    fs.writeFileSync(sb.probeFile, "not json\n");
    assert.equal(readProbe(sb).state, "stale");
  } finally { sb.cleanup(); }
});

test("record: a failing check after a recent failing check keeps the first one's time", () => {
  const sb = makeSandbox();
  try {
    writeProbe(sb, { ts: now() - 600, ok: false, failSince: now() - 4200 });
    const r = record(sb, 0);
    assert.equal(r.ok, false);
    assert.ok(Math.abs(r.fail_since - (now() - 4200)) <= 2);
    const p = readProbe(sb);
    assert.equal(p.state, "fail");
    assert.ok(p.failSec >= 4190);
    assert.match(p.summary, /loggedIn=false/);
  } finally { sb.cleanup(); }
});

test("record: a failure left from an old run does not make a new one look long", () => {
  const sb = makeSandbox();
  try {
    writeProbe(sb, { ts: now() - 86400, ok: false, failSince: now() - 90000 });
    const r = record(sb, 0);
    assert.ok(Math.abs(r.fail_since - r.ts) <= 1);
    assert.ok(readProbe(sb).failSec < 540, "a single fresh failure must not count as confirmed");
  } finally { sb.cleanup(); }
});

test("record: a good check resets the run, and quotes in the summary cannot break the line", () => {
  const sb = makeSandbox();
  try {
    writeProbe(sb, { ts: now() - 600, ok: false, failSince: now() - 4200 });
    const r = record(sb, 1, 'loggedIn=true "max" \\ x');
    assert.equal(r.ok, true);
    assert.equal(r.fail_since, 0);
    assert.equal(readProbe(sb).state, "ok");
  } finally { sb.cleanup(); }
});

test("record never fails its caller, even when the file cannot be written", () => {
  execFileSync("bash", ["-c", `set -eu; source ${JSON.stringify(PROBE_LIB)}; max_auth_probe_record 0 x live-day; echo ok`],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", MAX_AUTH_PROBE_FILE: "/nonexistent/dir/p.json" } });
});

// ---- the 2026-10-21 replay -------------------------------------------------

test("2026-10-21: one aged AUTH ERROR + a fresh signed-out check holds the incident, never ✅", () => {
  const sb = makeSandbox();
  try {
    staleAuthError(sb, 8 * 60);           // ops' 03:00:06Z line, aged out of the 6-min window
    markPaged(sb);                        // the 03:02Z red had gone out
    writeProbe(sb, { ts: now() - 120, ok: false, failSince: now() - 70 * 60 });
    for (let i = 0; i < 4; i++) {
      const t = tick(sb);
      assert.match(t.issues, /auth\(signed-out\)/);
      for (const p of t.pages) assert.doesNotMatch(p, /Recovered/, "no green check while the launchd check reads signed out");
    }
    const pages = sb.sent();
    assert.equal(pages.length, 1, "re-paged once (cooldown elapsed), then held by the 30-min cooldown");
    assert.match(pages[0], /🔴 Max auth is down: Claude Code on the server has read as signed out since/);
    assert.match(pages[0], /claude \/login/);
  } finally { sb.cleanup(); }
});

test("detection: a confirmed signed-out check pages even when no supervisor has hit an error", () => {
  const sb = makeSandbox();
  try {
    writeProbe(sb, { ts: now() - 30, ok: false, failSince: now() - 630 });
    const t = tick(sb, { health: '{"authAlertSent":false,"authErrorCount":0}' });
    assert.equal(t.pages.length, 1);
    assert.match(t.pages[0], /^🔴 Max auth is down/);
  } finally { sb.cleanup(); }
});

test("one signed-out reading alone neither pages nor clears", () => {
  const sb = makeSandbox();
  try {
    markPaged(sb);
    writeProbe(sb, { ts: now() - 30, ok: false, failSince: now() - 30 });
    for (let i = 0; i < 4; i++) assert.deepEqual(tick(sb).pages, []);
  } finally { sb.cleanup(); }
});

test("a reading taken before a keychain self-heal neither pages nor clears until the next check", () => {
  const sb = makeSandbox();
  try {
    markPaged(sb);
    writeProbe(sb, { ts: now() - 30, ok: false, failSince: now() - 1200 });
    assert.deepEqual(tick(sb, { keychainHealed: "1" }).pages, []);
    // The following ticks still only have the pre-heal reading: hold quietly.
    for (let i = 0; i < 4; i++) assert.deepEqual(tick(sb).pages, []);
    // live-day's next check after the heal still reads signed out: now it pages.
    writeProbe(sb, { ts: now() + 1, ok: false, failSince: now() - 1200 });
    const t = tick(sb);
    assert.equal(t.pages.length, 1);
    assert.match(t.pages[0], /^🔴 Max auth is down/);
  } finally { sb.cleanup(); }
});

test("a supervisor 'auth restored' newer than the signed-out reading overrules it (no 🔴 after a /login)", () => {
  const sb = makeSandbox();
  try {
    markPaged(sb);
    // 10-21: /login at 06:48Z, chat logged 'auth restored' at 06:49:31Z, live-day's next check was due ~06:50Z.
    writeProbe(sb, { ts: now() - 300, ok: false, failSince: now() - 5 * 3600 });
    fs.writeFileSync(path.join(sb.logs, "chat-supervisor.log"),
      `${isoZ(now() - 2400)} [chat] AUTH ERROR #1: Failed to authenticate: OAuth session expired and could not be refreshed\n` +
      `${isoZ(now() - 60)} [chat] auth restored after 1 failed turn(s)\n`);
    const pages = [];
    for (let i = 0; i < 3; i++) pages.push(...tick(sb).pages);
    assert.equal(pages.length, 1);
    assert.match(pages[0], /✅ Recovered: Max auth is back to normal — a supervisor has authenticated on Max again/);
  } finally { sb.cleanup(); }
});

test("after a real /login the fresh signed-in check clears it, and the ✅ says what was seen", () => {
  const sb = makeSandbox();
  try {
    staleAuthError(sb, 40 * 60);
    markPaged(sb);
    writeProbe(sb, { ts: now() - 60, ok: true });
    const pages = [];
    for (let i = 0; i < 3; i++) pages.push(...tick(sb).pages);
    assert.equal(pages.length, 1);
    assert.match(pages[0], /✅ Recovered: Max auth is back to normal — Claude Code on the server reads as signed in to Max again/);
    assert.doesNotMatch(pages[0], /ops supervisors/, "the old text named the ops supervisors even after a chat outage");
  } finally { sb.cleanup(); }
});

test("no fresh check (live-day not running) falls back to the old clear, worded as quiet logs only", () => {
  const sb = makeSandbox();
  try {
    staleAuthError(sb, 40 * 60);
    markPaged(sb);
    writeProbe(sb, { ts: now() - 7200, ok: false, failSince: now() - 9000 });
    const pages = [];
    for (let i = 0; i < 3; i++) pages.push(...tick(sb).pages);
    assert.equal(pages.length, 1);
    assert.match(pages[0], /✅ Recovered: Max auth.*quiet logs, not a confirmed sign-in/);
  } finally { sb.cleanup(); }
});

test("authAlertSent=true still holds first, with its own wording", () => {
  const sb = makeSandbox();
  try {
    writeProbe(sb, { ts: now() - 60, ok: true });
    const t = tick(sb, { health: '{"authAlertSent":true}' });
    assert.match(t.issues, /auth\(paused-no-log\)/);
    assert.equal(t.pages.length, 1);
    assert.match(t.pages[0], /STILL down/);
  } finally { sb.cleanup(); }
});

// ---- the sign-in clock and the renewal heads-up ----------------------------
//
// THE OUTAGE THIS HEADS OFF: the Max login's OAuth session ran out ("OAuth
// session expired and could not be refreshed") 26 to 29 days after each of the
// last few manual sign-ins, and every scheduled Claude run refused until the
// next /login. watchdog now keeps a sign-in clock (restarted when a paged
// outage closes that the launchd check read as signed out, unless the keychain
// self-heal ended it) and, from day 22, sends ONE daytime system note with
// --push (and a one-line banner that carries the ask) suggesting a sign-in.
// Runs the real auth section + the real heads-up section; nothing touches the
// real machine.

const RENEW_HEADER = "# --- Max sign-in renewal heads-up ---";
const RENEW_END = "# --- GitHub CLI auth health ---";
const DAY = 86400;

function renewSectionSrc() {
  const start = SRC.indexOf(RENEW_HEADER);
  assert.notEqual(start, -1, `expected a "${RENEW_HEADER}" section in watchdog.sh`);
  const end = SRC.indexOf(RENEW_END, start);
  assert.notEqual(end, -1, `the heads-up section must end before "${RENEW_END}"`);
  return SRC.slice(start, end);
}

// An Etc/GMT zone whose local hour is `h` right now, so a test can pick day or night.
function tzAt(h) {
  let d = (((h - new Date().getUTCHours()) % 24) + 24) % 24;
  if (d > 14) d -= 24;
  if (d === 0) return "Etc/GMT";
  return d > 0 ? `Etc/GMT-${d}` : `Etc/GMT+${-d}`;
}

// One watchdog tick over § Max auth outage then § Max sign-in renewal heads-up.
function renewTick(sb, { health = '{"authAlertSent":false,"authErrorCount":0}', keychainHealed = "0", hour = 12, sendFail = false } = {}) {
  const script = [
    'INCIDENT_DIR="$HOME/Dev/jori/data/watchdog-incidents"',
    `CONFIG_DIR=${JSON.stringify(sb.config)}`,
    `SEND=${JSON.stringify(sb.send)}`,
    'EMAIL_SEND=/nonexistent',
    'PENDING_ALERT_KEY=""',
    'ISSUES=""',
    `KEYCHAIN_HEALED=${keychainHealed}`,
    'log() { printf "%s\\n" "$*" >> "$STUB_LOG_DIR/log"; }',
    `source ${JSON.stringify(PROBE_LIB)}`,
    fnSrc("log_throttled"),
    fnSrc("_incident_label"), fnSrc("incident_seen"), fnSrc("incident_clear"),
    fnSrc("incident_should_alert"), fnSrc("notify"),
    sectionSrc(),
    renewSectionSrc(),
  ].join("\n");
  const before = sb.sent().length;
  const beforeArgs = sb.sentArgs().length;
  execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: env(sb, {
      FAKE_HEALTH: health,
      JORI_TZ: tzAt(hour),
      // root.sh's value in the real run (watchdog sources it via lib/webhook-auth.sh).
      JORI_INSTALL_TOOLS: path.join(sb.home, "Dev/jori"),
      ...(sendFail ? { FAKE_SEND_FAIL: "1" } : {}),
    }),
  });
  return { pages: sb.sent().slice(before), args: sb.sentArgs().slice(beforeArgs) };
}

const readClock = (sb) => (fs.existsSync(sb.reloginFile) ? JSON.parse(fs.readFileSync(sb.reloginFile, "utf8")) : null);
const writeClock = (sb, { relogin, note = 0, source = "outage-recovery" }) =>
  fs.writeFileSync(sb.reloginFile, `{"relogin_ts":${relogin},"note_ts":${note},"source":"${source}"}\n`);
const RENEW_NOTE = /^As far as I can tell, the Claude sign-in on the server hasn't been renewed in \d+ days\./;
const RE_NOTE = /^It's been \d+ days since my last nudge about the Claude sign-in on the server\./;
const BANNER = "Time to renew the Claude sign-in on the server: run claude /login there in the next few days.";

test("watchdog.sh: the heads-up section sits after § Max auth outage (it reads its verdict and its clock helpers)", () => {
  const auth = SRC.indexOf(SECTION_HEADER);
  const renew = SRC.indexOf(RENEW_HEADER);
  assert.ok(auth > 0 && renew > auth, "the heads-up must run after the auth section sets AUTH_OUTAGE_HELD");
  assert.match(renewSectionSrc(), /if \[ "\$\{AUTH_OUTAGE_HELD:-0\}" != "1" \] && \[ "\$\{AUTH_RECOVERY_PENDING:-0\}" != "1" \]; then/);
});

test("clock: a paged outage the launchd check read as signed out restarts it when the outage closes", () => {
  const sb = makeSandbox();
  try {
    const relogin = now() - 27 * DAY;
    writeClock(sb, { relogin, note: now() - 5 * DAY });
    markPaged(sb);
    writeProbe(sb, { ts: now() - 60, ok: false, failSince: now() - 70 * 60 });
    renewTick(sb);                                   // the outage, read signed out (re-pages 🔴)
    assert.ok(fs.existsSync(path.join(sb.incidents, "auth-outage.signed_out")));
    assert.equal(readClock(sb).relogin_ts, relogin, "untouched while the outage is open");
    writeProbe(sb, { ts: now() - 30, ok: true });    // the /login
    const pages = [];
    for (let i = 0; i < 3; i++) pages.push(...renewTick(sb).pages);
    assert.equal(pages.length, 1);
    assert.match(pages[0], /^✅ Recovered: Max auth/);
    const c = readClock(sb);
    assert.ok(Math.abs(c.relogin_ts - now()) <= 5, `restarted now, got ${c.relogin_ts}`);
    assert.equal(c.note_ts, 0);
    assert.equal(c.source, "outage-recovery");
    assert.ok(!fs.existsSync(path.join(sb.incidents, "auth-outage.signed_out")), "the marker is consumed");
  } finally { sb.cleanup(); }
});

test("clock: an outage the launchd check never read as signed out leaves it alone", () => {
  const sb = makeSandbox();
  try {
    const relogin = now() - 10 * DAY;
    writeClock(sb, { relogin });
    staleAuthError(sb, 40 * 60);
    markPaged(sb);
    writeProbe(sb, { ts: now() - 60, ok: true });
    const pages = [];
    for (let i = 0; i < 3; i++) pages.push(...renewTick(sb).pages);
    assert.equal(pages.length, 1);
    assert.match(pages[0], /^✅ Recovered/);
    assert.equal(readClock(sb).relogin_ts, relogin);
  } finally { sb.cleanup(); }
});

test("clock: an outage the keychain self-heal ended leaves it alone", () => {
  const sb = makeSandbox();
  try {
    const relogin = now() - 10 * DAY;
    writeClock(sb, { relogin });
    markPaged(sb);
    writeProbe(sb, { ts: now() - 30, ok: false, failSince: now() - 1200 });
    renewTick(sb, { keychainHealed: "1" });
    writeProbe(sb, { ts: now() + 1, ok: true });
    for (let i = 0; i < 3; i++) renewTick(sb);
    assert.equal(readClock(sb).relogin_ts, relogin);
    assert.match(fs.readFileSync(path.join(sb.root, "log"), "utf8"), /keychain self-heal ran during this outage/);
  } finally { sb.cleanup(); }
});

// The re-run of what the outage made miss (bin/auth-outage-replay) is
// called once, as the paged outage closes, looking from two hours before its
// first page, and its one line goes to the system channel after the ✅.
// renewTick sets JORI_INSTALL_TOOLS the way the real run's root.sh does.
function replayStub(sb, line) {
  const dir = path.join(sb.home, "Dev/jori/bin");
  fs.mkdirSync(dir, { recursive: true });
  const calls = path.join(sb.root, "replay-calls");
  fs.writeFileSync(path.join(dir, "auth-outage-replay"), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n${line ? `printf '%s\\n' ${JSON.stringify(line)}\n` : ""}`);
  fs.chmodSync(path.join(dir, "auth-outage-replay"), 0o755);
  return () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean) : []);
}

test("recovery: the jobs the outage made miss are handed to auth-outage-replay once, and its line follows the ✅", () => {
  const sb = makeSandbox();
  try {
    const LINE = "✅ The Claude sign-in outage made the nightly cost review miss its run, so I started it again just now.";
    const calls = replayStub(sb, LINE);
    staleAuthError(sb, 40 * 60);
    markPaged(sb);
    writeProbe(sb, { ts: now() - 60, ok: true });
    const pages = [];
    for (let i = 0; i < 4; i++) pages.push(...renewTick(sb).pages);
    assert.equal(pages.length, 2, pages.join("\n"));
    assert.match(pages[0], /^✅ Recovered: Max auth/);
    assert.equal(pages[1], LINE);
    const c = calls();
    assert.equal(c.length, 1, "called once, on the closing tick only");
    const since = Number((/^--since (\d+)$/.exec(c[0]) || [])[1]); // lang-regex-ok: the stub's own record of its argv
    assert.ok(Math.abs(since - (now() - 7200)) <= 10, `since two hours before the first page, got ${c[0]}`);
  } finally { sb.cleanup(); }
});

test("recovery: when the outage made nothing miss, nothing more is posted; an outage still open never calls it", () => {
  const sb = makeSandbox();
  try {
    const calls = replayStub(sb, "");
    markPaged(sb);
    writeProbe(sb, { ts: now() - 60, ok: false, failSince: now() - 70 * 60 });
    renewTick(sb);
    assert.equal(calls().length, 0, "called while the outage was still open");
    writeProbe(sb, { ts: now() - 30, ok: true });
    const pages = [];
    for (let i = 0; i < 3; i++) pages.push(...renewTick(sb).pages);
    assert.equal(calls().length, 1);
    assert.equal(pages.length, 1);
    assert.match(pages[0], /^✅ Recovered: Max auth/);
  } finally { sb.cleanup(); }
});

test("recovery: when the outage closes before the launchd check reads signed in, the re-run waits for it, then runs once", () => {
  const sb = makeSandbox();
  try {
    const LINE = "✅ The Claude sign-in outage made the nightly cost review miss its run, so I started it again just now.";
    const calls = replayStub(sb, LINE);
    markPaged(sb);
    // 10-21: the supervisors were back at 02:14 while scheduled runs read signed out until about 02:49.
    writeProbe(sb, { ts: now() - 300, ok: false, failSince: now() - 5 * 3600 });
    fs.writeFileSync(path.join(sb.logs, "chat-supervisor.log"),
      `${isoZ(now() - 2400)} [chat] AUTH ERROR #1: Failed to authenticate: OAuth session expired and could not be refreshed\n` +
      `${isoZ(now() - 60)} [chat] auth restored after 1 failed turn(s)\n`);
    const pages = [];
    for (let i = 0; i < 3; i++) pages.push(...renewTick(sb).pages);
    assert.equal(pages.length, 1);
    assert.match(pages[0], /^✅ Recovered: Max auth/);
    assert.equal(calls().length, 0, "started while scheduled runs still read signed out");
    assert.ok(fs.existsSync(path.join(sb.incidents, "auth-replay.pending")), "queued");
    writeProbe(sb, { ts: now() - 30, ok: true });
    const later = renewTick(sb).pages.concat(renewTick(sb).pages);
    assert.equal(calls().length, 1);
    assert.deepEqual(later, [LINE]);
    assert.ok(!fs.existsSync(path.join(sb.incidents, "auth-replay.pending")));
  } finally { sb.cleanup(); }
});

test("recovery: a queued re-run with no confirmed sign-in for 12 hours is dropped, not run", () => {
  const sb = makeSandbox();
  try {
    const calls = replayStub(sb, "✅ never posted");
    const marker = path.join(sb.incidents, "auth-replay.pending");
    fs.writeFileSync(marker, `${now() - 20 * 3600}\n`);
    const old = new Date(Date.now() - 13 * 3600 * 1000);
    fs.utimesSync(marker, old, old);
    writeProbe(sb, { ts: now() - 30, ok: true });
    const pages = renewTick(sb).pages;
    assert.equal(calls().length, 0);
    assert.deepEqual(pages, []);
    assert.ok(!fs.existsSync(marker));
  } finally { sb.cleanup(); }
});

test("heads-up: 23 days after the last sign-in it goes out once, on the system channel with --push, and not again", () => {
  const sb = makeSandbox();
  try {
    const relogin = now() - 23 * DAY - 60;
    writeClock(sb, { relogin });
    writeProbe(sb, { ts: now() - 60, ok: true });
    const first = renewTick(sb);
    assert.equal(first.pages.length, 1);
    assert.match(first.pages[0], RENEW_NOTE);
    assert.match(first.pages[0], /hasn't been renewed in 23 days/);
    assert.match(first.pages[0], /`claude \/login` on the server/);
    assert.match(first.pages[0], /every scheduled Claude job stops/, "only the Claude runs stop; plain cron jobs keep going");
    assert.doesNotMatch(first.pages[0], /every scheduled job/);
    assert.doesNotMatch(first.pages[0], /^(🔴|🚨)/, "nothing is broken; --push carries it, not a red marker");
    assert.ok(first.args[0].startsWith(`--skip-precheck --intent max-auth-renewal --channel system --push --push-body ${BANNER} `), first.args[0]);
    assert.ok(BANNER.length <= 100, "the banner fits before the ~100-character cut");
    const c = readClock(sb);
    assert.equal(c.relogin_ts, relogin, "the sign-in time is kept");
    assert.ok(Math.abs(c.note_ts - now()) <= 5);
    assert.equal(c.source, "outage-recovery", "the source is kept");
    for (let i = 0; i < 3; i++) assert.deepEqual(renewTick(sb).pages, [], "one note, not one per tick");
  } finally { sb.cleanup(); }
});

test("heads-up: not before day 22", () => {
  const sb = makeSandbox();
  try {
    writeClock(sb, { relogin: now() - 21 * DAY });
    writeProbe(sb, { ts: now() - 60, ok: true });
    assert.deepEqual(renewTick(sb).pages, []);
    assert.equal(readClock(sb).note_ts, 0);
  } finally { sb.cleanup(); }
});

test("heads-up: never at night; it waits for the morning", () => {
  const sb = makeSandbox();
  try {
    writeClock(sb, { relogin: now() - 23 * DAY });
    writeProbe(sb, { ts: now() - 60, ok: true });
    assert.deepEqual(renewTick(sb, { hour: 3 }).pages, []);
    assert.deepEqual(renewTick(sb, { hour: 22 }).pages, []);
    assert.equal(readClock(sb).note_ts, 0);
    assert.equal(renewTick(sb, { hour: 9 }).pages.length, 1);
  } finally { sb.cleanup(); }
});

test("heads-up: not during an open auth outage (the 🔴 page covers it)", () => {
  const sb = makeSandbox();
  try {
    writeClock(sb, { relogin: now() - 30 * DAY });
    writeProbe(sb, { ts: now() - 60, ok: false, failSince: now() - 70 * 60 });
    const t = renewTick(sb);
    assert.equal(t.pages.length, 1);
    assert.match(t.pages[0], /^🔴 Max auth is down/);
    assert.equal(readClock(sb).note_ts, 0);
  } finally { sb.cleanup(); }
});

test("heads-up: 22 days after an unanswered note it nudges once more, in its own words", () => {
  const sb = makeSandbox();
  try {
    writeClock(sb, { relogin: now() - 45 * DAY, note: now() - 10 * DAY });
    writeProbe(sb, { ts: now() - 60, ok: true });
    assert.deepEqual(renewTick(sb).pages, [], "10 days after the last note: quiet");
    writeClock(sb, { relogin: now() - 45 * DAY, note: now() - 23 * DAY });
    const t = renewTick(sb);
    assert.equal(t.pages.length, 1);
    assert.match(t.pages[0], RE_NOTE);
    // A renewal right after the last note would be ~22 days old now, so due again
    // either way: the follow-up must never tell the user to ignore it.
    assert.match(t.pages[0], /whether or not you renewed it after that note, it's about due again now/);
    assert.doesNotMatch(t.pages[0], /ignore/);
    assert.match(t.pages[0], /every scheduled Claude job/);
    assert.ok(t.args[0].includes(`--push --push-body ${BANNER} `));
    assert.deepEqual(renewTick(sb).pages, []);
  } finally { sb.cleanup(); }
});

test("heads-up: a send that fails is not recorded, so the next tick tries again", () => {
  const sb = makeSandbox();
  try {
    writeClock(sb, { relogin: now() - 23 * DAY });
    writeProbe(sb, { ts: now() - 60, ok: true });
    assert.deepEqual(renewTick(sb, { sendFail: true }).pages, []);
    assert.equal(readClock(sb).note_ts, 0);
    assert.equal(renewTick(sb).pages.length, 1);
  } finally { sb.cleanup(); }
});

test("bootstrap: no clock yet seeds it from the newest supervisor 'auth restored' line, rotated logs included", () => {
  const sb = makeSandbox();
  try {
    const restored = now() - 23 * DAY;
    fs.writeFileSync(path.join(sb.logs, "ops-light-supervisor.log"),
      `${isoZ(now() - 50 * DAY)} [supervisor] auth restored — rotating session and resuming dispatcher\n`);
    execFileSync("bash", ["-c", `printf '%s\\n' "$1" | gzip -c > "$2"`, "_",
      `${isoZ(restored)} [chat-supervisor] auth restored after 1 failed turn(s)`,
      path.join(sb.logs, "chat-supervisor-2026-01-01.log.gz")]);
    // Newer lines that merely contain the words are not the supervisors' line.
    fs.writeFileSync(path.join(sb.logs, "ops-supervisor.log"),
      `${isoZ(now() - 2 * DAY)} [supervisor] AUTH ERROR #1: a hum summary saying auth restored after 1 failed turn(s)\n` +
      `${isoZ(now() - DAY)} [supervisor] turn complete: "auth restored — rotating session and resuming dispatcher" quoted in a report\n`);
    writeProbe(sb, { ts: now() - 60, ok: true });
    const t = renewTick(sb);
    const c = readClock(sb);
    assert.equal(c.relogin_ts, restored);
    assert.equal(c.source, "supervisor-log");
    assert.equal(t.pages.length, 1, "already 23 days: the note goes out");
    assert.match(t.pages[0], /hasn't been renewed in 23 days/);
  } finally { sb.cleanup(); }
});

test("bootstrap: with no trace at all the clock starts now, and no note goes out", () => {
  const sb = makeSandbox();
  try {
    writeProbe(sb, { ts: now() - 60, ok: true });
    assert.deepEqual(renewTick(sb).pages, []);
    const c = readClock(sb);
    assert.ok(Math.abs(c.relogin_ts - now()) <= 5);
    assert.equal(c.source, "first-seen");
  } finally { sb.cleanup(); }
});

test("heads-up: a garbled clock file costs the note, never the tick", () => {
  const sb = makeSandbox();
  try {
    fs.writeFileSync(sb.reloginFile, "not json\n");
    writeProbe(sb, { ts: now() - 60, ok: true });
    assert.deepEqual(renewTick(sb).pages, []);
  } finally { sb.cleanup(); }
});

test("clock: a lone signed-out reading that never became a paged outage leaves no marker behind", () => {
  const sb = makeSandbox();
  try {
    writeProbe(sb, { ts: now() - 30, ok: false, failSince: now() - 30 });
    renewTick(sb);
    assert.ok(fs.existsSync(path.join(sb.incidents, "auth-outage.signed_out")), "held, marker set");
    writeProbe(sb, { ts: now(), ok: true });
    assert.deepEqual(renewTick(sb).pages, []);
    assert.ok(!fs.existsSync(path.join(sb.incidents, "auth-outage.signed_out")), "closed unpaged: marker dropped");
  } finally { sb.cleanup(); }
});
