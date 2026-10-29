// watchdog-ds-heal-auth-defer.test.mjs: pins how watchdog.sh's daily-summary
// cron-miss detector behaves during a Max auth outage
// (cluster sic-20261021-daily-summary-missing-auth-outage).
//
// THE ALERT THIS DEFENDS: "🔴 Daily-summary missing for <date> ... Backfill
// manually: dispatch DAILY SUMMARY <date> to the ops webhook". On 2026-10-21 Max
// was signed out ~01:51Z until a manual /login ~06:48Z. Inside that outage the
// detector spent its single once-per-24h self-heal (marker
// data/.daily-summary-heal-cooldown) on an ops turn that was certain to
// fail (ops logged AUTH ERROR at 03:00:06Z), then at 03:22Z paged the red above:
// a second 🔴 for the same root cause as watchdog's own "🔴 Max auth is DOWN",
// with a remedy that could not work until /login. And with the marker spent,
// nothing re-armed the heal once auth came back.
//
// The fix: § Max auth outage sets AUTH_OUTAGE_HELD=1 on every branch that holds
// the incident open; the daily-summary block then records the miss but neither
// dispatches, touches the marker, nor pages. On the one-time recovery transition
// (auth-outage.alerted present before incident_clear, gone after) the auth
// section removes the marker so the backfill runs once auth is back.
//
// Behavioural cases run the real watchdog sections (with the real incident_* /
// notify machinery and the real max-auth-probe lib) in bash, with curl, the
// agent loader, local-day and the sender replaced by stubs. Nothing touches the
// real machine, the ops webhook or the system channel.
//
// Run against a proposed copy:
//   WATCHDOG_SH=/tmp/x/watchdog.sh node --test tests/watchdog-ds-heal-auth-defer.test.mjs

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
const SRC = fs.readFileSync(WATCHDOG_PATH, "utf8");

const AUTH_HEADER = "# --- Max auth outage";
const AUTH_END = "# --- Wiki server health ---";
const DS_HEADER = "# ── Daily-summary cron-miss detection";
const DS_END = "# ── Episode-archive cron-miss detection";
const TARGET = "2026-10-20";

function fnSrc(name) {
  const start = SRC.indexOf(`\n${name}() {`);
  assert.notEqual(start, -1, `${name} must be defined in watchdog.sh`);
  const end = SRC.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} must be a closed function body`);
  return SRC.slice(start + 1, end + 3);
}

function between(header, endMarker) {
  const start = SRC.indexOf(header);
  assert.notEqual(start, -1, `expected a "${header}" section in watchdog.sh`);
  const end = SRC.indexOf(endMarker, start);
  assert.notEqual(end, -1, `the section must end before "${endMarker}"`);
  return SRC.slice(start, end);
}
const authSection = () => between(AUTH_HEADER, AUTH_END);
const dsSection = () => between(DS_HEADER, DS_END);

// The top-level assignment of a global (e.g. DS_HEAL_MARKER="..."), one line.
function assignSrc(name) {
  const start = SRC.indexOf(`\n${name}=`);
  assert.notEqual(start, -1, `${name} must be assigned at top level in watchdog.sh`);
  return SRC.slice(start + 1, SRC.indexOf("\n", start + 1));
}

const codeOnly = (s) => s.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

// ---- harness ---------------------------------------------------------------

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wd-dsauth-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const g = path.join(home, "Dev/jori");
  const logs = path.join(g, "agent/logs");
  const data = path.join(g, "data");
  const config = path.join(root, "config");
  const incidents = path.join(data, "watchdog-incidents");
  for (const d of [bin, logs, data, config, incidents, path.join(g, "bin")]) fs.mkdirSync(d, { recursive: true });
  const stub = (p, body) => { fs.writeFileSync(p, `#!/bin/bash\n${body}\n`); fs.chmodSync(p, 0o755); return p; };
  // curl: supervisor /health -> $FAKE_HEALTH; the ops webhook -> record a
  // dispatch; Supabase daily_summaries -> $FAKE_DS_ROW.
  stub(path.join(bin, "curl"), [
    'all="$*"',
    'case "$all" in',
    '  *localhost:9092*) printf "%s\\n" "$all" >> "$STUB_LOG_DIR/dispatched"; exit 0 ;;',
    '  */health*) printf "%s" "${FAKE_HEALTH:-}"; [ -n "${FAKE_HEALTH:-}" ]; exit $? ;;',
    '  *daily_summaries*) printf "%s" "${FAKE_DS_ROW:-[]}"; exit 0 ;;',
    'esac',
    'exit 7',
  ].join("\n"));
  stub(path.join(config, "load-agent.sh"), 'echo "AGENT_SUPERVISOR_HEALTH_PORT=19999"');
  // local-day: noon local, yesterday = TARGET, so the grace gate is always open.
  stub(path.join(g, "bin/local-day"), `echo '{"hour":12,"yesterday":"${TARGET}"}'`);
  const send = stub(path.join(bin, "send"), 'printf "%s\\n" "${@: -1}" >> "$STUB_LOG_DIR/sent"');
  const lines = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8").split("\n").filter(Boolean) : []);
  return {
    root, bin, home, logs, config, send, incidents,
    marker: path.join(data, ".daily-summary-heal-cooldown"),
    probeFile: path.join(data, "max-auth-probe.json"),
    sent: () => lines("sent"),
    dispatched: () => lines("dispatched"),
    log: () => lines("log"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const env = (sb, extra = {}) => ({
  PATH: `${sb.bin}:/opt/homebrew/bin:/usr/bin:/bin`,
  HOME: sb.home,
  STUB_LOG_DIR: sb.root,
  MAX_AUTH_PROBE_FILE: sb.probeFile,
  ...extra,
});

const now = () => Math.floor(Date.now() / 1000);
const isoZ = (epoch) => new Date(epoch * 1000).toISOString().replace(/\.\d+Z$/, ".000Z");

function writeProbe(sb, { ts, ok, failSince = 0 }) {
  fs.writeFileSync(sb.probeFile,
    `{"ts":${ts},"ok":${ok},"fail_since":${failSince},"summary":"loggedIn=${ok} authMethod=none","source":"live-day"}\n`);
}

function setMtime(p, ageSec) {
  const t = new Date(Date.now() - ageSec * 1000);
  fs.utimesSync(p, t, t);
}

function touchMarker(sb, ageSec) {
  fs.writeFileSync(sb.marker, "");
  setMtime(sb.marker, ageSec);
}

// Pretend an earlier tick paged (and delivered) the auth-outage red.
function markAuthPaged(sb) {
  for (const f of ["auth-outage.alerted", "auth-outage.delivered", "auth-outage.alert_first"]) {
    fs.writeFileSync(path.join(sb.incidents, f), "");
  }
  fs.writeFileSync(path.join(sb.incidents, "auth-outage.alert_count"), "1");
  setMtime(path.join(sb.incidents, "auth-outage.alerted"), 600); // within the 30-min re-page cooldown
}

// One watchdog tick over the chosen sections. `held` (if given) presets
// AUTH_OUTAGE_HELD for a DS-only run; with `auth: true` the real auth section
// computes it.
function tick(sb, { auth = false, ds = true, held, health = '{"authAlertSent":false}', keychainHealed = "0", dsRow = "[]" } = {}) {
  const script = [
    'INCIDENT_DIR="$HOME/Dev/jori/data/watchdog-incidents"',
    `CONFIG_DIR=${JSON.stringify(sb.config)}`,
    `SEND=${JSON.stringify(sb.send)}`,
    'EMAIL_SEND=/nonexistent',
    'PENDING_ALERT_KEY=""',
    'ISSUES=""',
    `KEYCHAIN_HEALED=${keychainHealed}`,
    'SUPABASE_URL="https://example.invalid"',
    'SUPABASE_KEY="test-key"',
    assignSrc("DS_HEAL_MARKER"),
    held === undefined ? "" : `AUTH_OUTAGE_HELD=${held}`,
    'log() { printf "%s\\n" "$*" >> "$STUB_LOG_DIR/log"; }',
    `source ${JSON.stringify(PROBE_LIB)}`,
    fnSrc("_incident_label"), fnSrc("incident_seen"), fnSrc("incident_clear"),
    fnSrc("incident_should_alert"), fnSrc("notify"),
    auth ? authSection() : "",
    ds ? dsSection() : "",
    'printf "ISSUES=%s\\n" "$ISSUES"',
    'printf "HELD=%s\\n" "${AUTH_OUTAGE_HELD:-unset}"',
  ].join("\n");
  const before = { sent: sb.sent().length, dispatched: sb.dispatched().length, log: sb.log().length };
  const out = execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: env(sb, { FAKE_HEALTH: health, FAKE_DS_ROW: dsRow }),
  });
  return {
    issues: (out.match(/ISSUES=(.*)/) || [])[1] || "",
    held: (out.match(/HELD=(.*)/) || [])[1] || "",
    pages: sb.sent().slice(before.sent),
    dispatches: sb.dispatched().slice(before.dispatched),
    logs: sb.log().slice(before.log),
  };
}

const DEFER_LOG = /daily-summary backfill \+ page deferred: Max auth outage open/;
const REARM_LOG = /re-armed daily-summary self-heal after Max auth recovery/;

// ---- static ----------------------------------------------------------------

test("watchdog.sh parses", () => {
  execFileSync("bash", ["-n", WATCHDOG_PATH]);
});

test("DS_HEAL_MARKER is defined once, at top level, before the auth section uses it", () => {
  const defs = SRC.split("\n").filter((l) => l.startsWith("DS_HEAL_MARKER="));
  assert.equal(defs.length, 1, "one definition, not a duplicated literal");
  assert.ok(SRC.indexOf("\nDS_HEAL_MARKER=") < SRC.indexOf(AUTH_HEADER), "defined before § Max auth outage");
  assert.match(authSection(), /rm -f "\$DS_HEAL_MARKER"/);
});

test("(d) structural: AUTH_OUTAGE_HELD=0 before the branches, =1 on every holding branch, never in the clearing else", () => {
  const sec = codeOnly(authSection());
  const init = sec.indexOf("AUTH_OUTAGE_HELD=0");
  const firstBranch = sec.indexOf('if [ -n "$AUTH_HIT" ]; then');
  assert.ok(init !== -1 && init < firstBranch, "initialised before the first branch");
  // The four holding branches, in order, each followed by its own =1 before the next branch opens.
  const opens = [
    'if [ -n "$AUTH_HIT" ]; then',
    'if [ -n "$AUTH_STILL_PAUSED" ]; then',
    'elif [ "$MAX_AUTH_PROBE_STATE" = "fail" ]; then',
    'elif [ "$MAX_AUTH_PROBE_STATE" = "pre-heal" ]; then',
  ];
  const idx = opens.map((o) => sec.indexOf(o));
  idx.forEach((i, k) => assert.notEqual(i, -1, `missing branch ${opens[k]}`));
  const clearing = sec.indexOf('incident_clear "auth-outage"');
  const bounds = [...idx, clearing];
  for (let k = 0; k < opens.length; k++) {
    const body = sec.slice(bounds[k], bounds[k + 1]);
    assert.match(body, /AUTH_OUTAGE_HELD=1/, `branch ${opens[k]} must set AUTH_OUTAGE_HELD=1`);
  }
  // The clearing else (from the pre-heal branch's last "else" on) never sets it.
  const elseStart = sec.lastIndexOf("\n  else\n", clearing);
  assert.ok(elseStart > idx[3], "the clearing else follows the pre-heal branch");
  assert.doesNotMatch(sec.slice(elseStart, clearing + 200), /AUTH_OUTAGE_HELD=1/);
});

test("the daily-summary block reads AUTH_OUTAGE_HELD with a default (safe when unset)", () => {
  assert.match(codeOnly(dsSection()), /"\$\{AUTH_OUTAGE_HELD:-0\}" = "1"/);
});

// ---- (a) auth held: defer --------------------------------------------------

test("(a) auth held, marker absent: no dispatch, marker untouched, no page, deferral logged, miss still recorded", () => {
  const sb = makeSandbox();
  try {
    for (let i = 0; i < 3; i++) {
      const t = tick(sb, { held: 1 });
      assert.deepEqual(t.dispatches, [], "no backfill dispatched into a failing auth");
      assert.deepEqual(t.pages, [], "no second 🔴 for the auth root cause");
      assert.ok(t.logs.some((l) => DEFER_LOG.test(l)), "the deferral is logged");
      assert.match(t.issues, new RegExp(`daily-summary\\(missing:${TARGET}\\)`));
    }
    assert.equal(fs.existsSync(sb.marker), false, "the heal marker is not spent");
    assert.equal(fs.readFileSync(path.join(sb.incidents, "daily-summary-missing"), "utf8").trim(), "3");
  } finally { sb.cleanup(); }
});

test("(a) the 2026-10-21 03:22Z shape: marker spent 30 min ago + auth held -> no 🔴 page, marker mtime unchanged", () => {
  const sb = makeSandbox();
  try {
    touchMarker(sb, 1800);
    const before = fs.statSync(sb.marker).mtimeMs;
    const t = tick(sb, { held: 1 });
    assert.deepEqual(t.pages, []);
    assert.deepEqual(t.dispatches, []);
    assert.equal(fs.statSync(sb.marker).mtimeMs, before);
  } finally { sb.cleanup(); }
});

// ---- (b) auth not held: today's behaviour -----------------------------------

test("(b) auth not held, marker absent: dispatches the backfill once and touches the marker, no page yet", () => {
  const sb = makeSandbox();
  try {
    const t = tick(sb, { held: 0 });
    assert.equal(t.dispatches.length, 1);
    assert.match(t.dispatches[0], new RegExp(`DAILY SUMMARY ${TARGET}`));
    assert.ok(fs.existsSync(sb.marker), "marker touched");
    assert.deepEqual(t.pages, [], "no page while the fresh backfill is running (<20 min)");
    assert.ok(!t.logs.some((l) => DEFER_LOG.test(l)));
    // Next tick: marker fresh, so no second dispatch and still no page.
    const t2 = tick(sb, { held: 0 });
    assert.deepEqual(t2.dispatches, []);
    assert.deepEqual(t2.pages, []);
  } finally { sb.cleanup(); }
});

test("(b) unset AUTH_OUTAGE_HELD behaves as not held", () => {
  const sb = makeSandbox();
  try {
    const t = tick(sb);
    assert.equal(t.held, "unset");
    assert.equal(t.dispatches.length, 1);
  } finally { sb.cleanup(); }
});

test("(b) auth not held, heal spent >= 20 min ago and row still missing: pages 🔴 once", () => {
  const sb = makeSandbox();
  try {
    touchMarker(sb, 1800);
    const t = tick(sb, { held: 0 });
    assert.deepEqual(t.dispatches, [], "the once-per-24h heal is already spent");
    assert.equal(t.pages.length, 1);
    assert.match(t.pages[0], new RegExp(`^🔴 Daily-summary missing for ${TARGET}`));
  } finally { sb.cleanup(); }
});

test("(b) row present: clears the incident and the marker", () => {
  const sb = makeSandbox();
  try {
    touchMarker(sb, 1800);
    const t = tick(sb, { held: 1, dsRow: `[{"date":"${TARGET}"}]` });
    assert.deepEqual(t.pages, []);
    assert.deepEqual(t.dispatches, []);
    assert.equal(fs.existsSync(sb.marker), false);
  } finally { sb.cleanup(); }
});

// ---- (c) re-arm on the recovery transition ----------------------------------

test("(c) recovery transition removes the marker exactly once (3rd green tick), later green ticks leave it", () => {
  const sb = makeSandbox();
  try {
    markAuthPaged(sb);
    writeProbe(sb, { ts: now() - 60, ok: true });
    touchMarker(sb, 3 * 3600); // spent inside the outage
    const rearms = [];
    for (let i = 0; i < 3; i++) {
      const t = tick(sb, { auth: true, ds: false });
      assert.equal(t.held, "0");
      rearms.push(t.logs.filter((l) => REARM_LOG.test(l)).length);
      if (i < 2) assert.ok(fs.existsSync(sb.marker), `green tick ${i + 1} of 3 does not re-arm yet`);
    }
    assert.deepEqual(rearms, [0, 0, 1]);
    assert.equal(fs.existsSync(sb.marker), false, "re-armed on the recovery tick");
    assert.equal(fs.existsSync(path.join(sb.incidents, "auth-outage.alerted")), false);
    // An ordinary green tick afterwards must not touch a (new) marker.
    touchMarker(sb, 60);
    for (let i = 0; i < 4; i++) {
      const t = tick(sb, { auth: true, ds: false });
      assert.ok(!t.logs.some((l) => REARM_LOG.test(l)));
    }
    assert.ok(fs.existsSync(sb.marker), "no re-arm without an auth-outage.alerted transition");
  } finally { sb.cleanup(); }
});

test("(c) recovery transition leaves a marker spent AFTER the last auth page (that backfill is already running)", () => {
  const sb = makeSandbox();
  try {
    markAuthPaged(sb);              // last auth page 10 min ago
    writeProbe(sb, { ts: now() - 60, ok: true });
    touchMarker(sb, 60);            // spent on a recovery tick, after that page
    const logs = [];
    for (let i = 0; i < 3; i++) logs.push(...tick(sb, { auth: true, ds: false }).logs);
    assert.ok(!logs.some((l) => REARM_LOG.test(l)));
    assert.ok(logs.some((l) => /self-heal already ran after the outage's last auth page; not re-arming/.test(l)));
    assert.ok(fs.existsSync(sb.marker));
  } finally { sb.cleanup(); }
});

test("(c) ordinary green ticks with no auth page ever sent never touch the marker", () => {
  const sb = makeSandbox();
  try {
    writeProbe(sb, { ts: now() - 60, ok: true });
    touchMarker(sb, 600);
    for (let i = 0; i < 5; i++) {
      const t = tick(sb, { auth: true, ds: false });
      assert.ok(!t.logs.some((l) => REARM_LOG.test(l)));
    }
    assert.ok(fs.existsSync(sb.marker));
  } finally { sb.cleanup(); }
});

// ---- (d) behavioural: every holding branch sets AUTH_OUTAGE_HELD=1 -----------

test("(d) fresh AUTH ERROR (AUTH_HIT) holds, including the keychain-healed deferral", () => {
  for (const keychainHealed of ["0", "1"]) {
    const sb = makeSandbox();
    try {
      fs.writeFileSync(path.join(sb.logs, "ops-supervisor.log"),
        `${isoZ(now() - 60)} [ops] AUTH ERROR #1: Failed to authenticate: OAuth session expired and could not be refreshed\n`);
      const t = tick(sb, { auth: true, ds: false, keychainHealed });
      assert.match(t.issues, /auth\(not-logged-in\)/);
      assert.equal(t.held, "1", `keychainHealed=${keychainHealed}`);
    } finally { sb.cleanup(); }
  }
});

test("(d) authAlertSent=true (paused supervisor) holds", () => {
  const sb = makeSandbox();
  try {
    const t = tick(sb, { auth: true, ds: false, health: '{"authAlertSent":true}' });
    assert.match(t.issues, /auth\(paused-no-log\)/);
    assert.equal(t.held, "1");
  } finally { sb.cleanup(); }
});

test("(d) launchd signed-out check holds on both the single reading (<540s) and the confirmed page", () => {
  for (const failFor of [30, 70 * 60]) {
    const sb = makeSandbox();
    try {
      writeProbe(sb, { ts: now() - 30, ok: false, failSince: now() - failFor });
      const t = tick(sb, { auth: true, ds: false });
      assert.match(t.issues, /auth\(signed-out\)/);
      assert.equal(t.held, "1", `signed out for ${failFor}s`);
    } finally { sb.cleanup(); }
  }
});

test("(d) a signed-out reading older than this tick's keychain self-heal (pre-heal) holds", () => {
  const sb = makeSandbox();
  try {
    writeProbe(sb, { ts: now() - 30, ok: false, failSince: now() - 1200 });
    const t = tick(sb, { auth: true, ds: false, keychainHealed: "1" });
    assert.equal(t.held, "1");
  } finally { sb.cleanup(); }
});

test("(d) the clearing branch leaves AUTH_OUTAGE_HELD=0", () => {
  const sb = makeSandbox();
  try {
    writeProbe(sb, { ts: now() - 60, ok: true });
    assert.equal(tick(sb, { auth: true, ds: false }).held, "0");
  } finally { sb.cleanup(); }
});

// ---- end to end: the 2026-10-21 replay ---------------------------------------

test("2026-10-21 replay: outage defers the backfill and the page; after /login the backfill runs exactly once", () => {
  const sb = makeSandbox();
  try {
    // Outage: the launchd check has read signed out for 70 min; the auth red went out.
    markAuthPaged(sb);
    writeProbe(sb, { ts: now() - 60, ok: false, failSince: now() - 70 * 60 });
    for (let i = 0; i < 6; i++) {
      const t = tick(sb, { auth: true });
      assert.equal(t.held, "1");
      assert.deepEqual(t.dispatches, []);
      for (const p of t.pages) assert.doesNotMatch(p, /Daily-summary missing/);
    }
    assert.equal(fs.existsSync(sb.marker), false);
    // /login: the next launchd check reads signed in. The first green tick already
    // dispatches the backfill (the marker was never spent during the outage).
    writeProbe(sb, { ts: now() - 30, ok: true });
    const dispatches = [];
    const pages = [];
    for (let i = 0; i < 5; i++) {
      const t = tick(sb, { auth: true });
      dispatches.push(...t.dispatches);
      pages.push(...t.pages);
    }
    assert.equal(dispatches.length, 1, "exactly one backfill after recovery");
    assert.match(dispatches[0], new RegExp(`DAILY SUMMARY ${TARGET}`));
    assert.ok(!pages.some((p) => /Daily-summary missing/.test(p)), "no 🔴 while the backfill is fresh");
    assert.ok(pages.some((p) => /✅ Recovered: Max auth/.test(p)));
  } finally { sb.cleanup(); }
});

test("2026-10-21 replay, heal already spent before the outage was seen: recovery re-arms and re-dispatches once", () => {
  const sb = makeSandbox();
  try {
    markAuthPaged(sb);
    touchMarker(sb, 3 * 3600); // the 03:00Z backfill that died on AUTH ERROR
    writeProbe(sb, { ts: now() - 30, ok: true });
    const dispatches = [];
    for (let i = 0; i < 6; i++) dispatches.push(...tick(sb, { auth: true }).dispatches);
    assert.equal(dispatches.length, 1, "re-armed on the recovery tick, dispatched once, not every tick");
  } finally { sb.cleanup(); }
});

test("2026-10-21 replay, heal spent before the outage was seen: no 🔴 on the recovery ticks before the ✅ (AUTH_RECOVERY_PENDING)", () => {
  // Without the pending hold the first green tick saw a 3h-old marker, held=0,
  // and paged "🔴 Daily-summary missing ... Backfill manually" two ticks before
  // the re-arm ran that very backfill by itself.
  const sb = makeSandbox();
  try {
    markAuthPaged(sb);
    touchMarker(sb, 3 * 3600);
    writeProbe(sb, { ts: now() - 30, ok: true });
    const pages = [];
    const dispatchTicks = [];
    let recoveredAt = -1;
    for (let i = 0; i < 6; i++) {
      const t = tick(sb, { auth: true });
      pages.push(...t.pages);
      if (t.dispatches.length) dispatchTicks.push(i);
      if (recoveredAt === -1 && t.pages.some((p) => /✅ Recovered: Max auth/.test(p))) recoveredAt = i;
    }
    assert.ok(!pages.some((p) => /Daily-summary missing/.test(p)), "no 🔴 for a backfill the recovery is about to run");
    assert.notEqual(recoveredAt, -1, "the auth recovery is confirmed");
    assert.deepEqual(dispatchTicks, [recoveredAt], "the backfill runs once, on the tick the recovery is confirmed");
  } finally { sb.cleanup(); }
});

test("(d) AUTH_RECOVERY_PENDING: initialised to 0, set only on the clearing branch while auth-outage.alerted survives incident_clear, read by the daily-summary block", () => {
  const sec = codeOnly(authSection());
  const init = sec.indexOf("AUTH_RECOVERY_PENDING=0");
  assert.ok(init !== -1 && init < sec.indexOf('if [ -n "$AUTH_HIT" ]; then'), "initialised before the first branch");
  const clearing = sec.indexOf('incident_clear "auth-outage"');
  const set = sec.indexOf("AUTH_RECOVERY_PENDING=1");
  assert.ok(set > clearing, "set only after incident_clear on the clearing branch");
  assert.equal(sec.indexOf("AUTH_RECOVERY_PENDING=1", set + 1), -1, "set in exactly one place");
  assert.match(codeOnly(dsSection()), /"\$\{AUTH_RECOVERY_PENDING:-0\}" = "1"/);
});
