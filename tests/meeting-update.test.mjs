// meeting-update.test.mjs — a recurring meeting's state file and reminder lines
// (bin/meeting-update). The bookkeeping must never install a crontab it did not
// read in full: `crontab -l | grep -v TAG | crontab -` installs whatever the read
// produced, so a failed or hung read would wipe every job. And `set` must not
// let a later day's instance displace a call still ahead (an update that moves
// Friday's call must not overwrite Thursday's). These run the real script with
// `crontab` on PATH replaced by a stub, so the real crontab is never touched.
//
// Run: node --test tests/meeting-update.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "meeting-update");
const SAFE = path.join(path.dirname(BIN), "crontab-safe");
const TAG = "# MEETING_REMINDER_COACH";
const { installTools } = createRequire(import.meta.url)("../lib/root.cjs");
const REMIND = installTools("bin/meeting-remind");
const ARG = " --meeting coach";

// A synthetic meeting in a throwaway local config dir (the defaults: tag, reminder bin).
const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-local-"));
fs.mkdirSync(path.join(LOCAL, "config"));
fs.writeFileSync(path.join(LOCAL, "instance.json"), JSON.stringify({ tz: "America/New_York" }));
fs.writeFileSync(path.join(LOCAL, "config", "meetings.json"), JSON.stringify({ meetings: [{ id: "coach", name: "Sam" }] }));

// A crontab with the shapes that must survive untouched: comments, a blank
// line in the middle, paused lines, a trailing blank line, and two stale
// reminder lines from an earlier call sitting in the middle.
const SEED = [
  "# morning digest",
  "SHELL=/bin/bash",
  "0 7 * * * /bin/echo digest",
  "",
  `45 15 19 10 * ${REMIND} pre "16:00" ${TAG}`,
  "#MKTPAUSE# 0 10 25 5 * /bin/echo paused",
  `0 17 19 10 * ${REMIND} post "16:00" ${TAG}`,
  "*/5 * * * * /bin/echo every-five",
  "",
].join("\n") + "\n";

// mode: ok | fail | partial | empty | hang
function sandbox(mode = "ok", seed = SEED) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-cron-"));
  const stateFile = path.join(dir, "state.json");
  const cronFile = path.join(dir, "crontab.txt");
  const calls = path.join(dir, "calls.log");
  const log = path.join(dir, "crontab-safe.log");
  fs.writeFileSync(cronFile, seed);
  fs.writeFileSync(path.join(dir, "crontab"), `#!/bin/bash
echo "$*" >> "${calls}"
if [ "$1" = "-l" ]; then
  case "${mode}" in
    ok) cat "${cronFile}" ;;
    fail) echo "crontab: tmp/tmp.1234: Operation not permitted" >&2; exit 1 ;;
    partial) head -n 2 "${cronFile}"; exit 1 ;;
    empty) : ;;
    hang) sleep 6; cat "${cronFile}" ;;
  esac
else
  # Like the real crontab(1): read all of stdin, then replace the file whole.
  cat > "${cronFile}.new" && mv "${cronFile}.new" "${cronFile}"
fi
`, { mode: 0o755 });
  const run = (args, extraEnv = {}) => {
    const t0 = Date.now();
    const r = spawnSync("bash", [BIN, ...args], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, JORI_LOCAL_DIR: LOCAL, MEETING_ID: "coach", MEETING_STATE_FILE: stateFile,
        MEETING_FORCE: "", CRONTAB_SAFE_LOG: log, CRONTAB_SAFE_TIMEOUT: "2", ...extraEnv },
    });
    r.elapsed = Date.now() - t0;
    return r;
  };
  const safe = (args) => spawnSync("bash", [SAFE, ...args], { encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CRONTAB_SAFE_LOG: log } });
  const cron = () => fs.readFileSync(cronFile, "utf8");
  const writes = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter((l) => l === "-") : []);
  const skipLog = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
  return { dir, stateFile, run, safe, cron, writes, skipLog };
}

const etParts = (epoch) => Object.fromEntries(new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
}).formatToParts(new Date(epoch * 1000)).map((p) => [p.type, p.value]));
const etDate = (e) => { const p = etParts(e); return `${p.year}-${p.month.padStart(2, "0")}-${p.day.padStart(2, "0")}`; };
const etTime = (e) => { const p = etParts(e); return `${p.hour.padStart(2, "0")}:${p.minute.padStart(2, "0")}`; };
const cronAt = (e) => { const p = etParts(e); return `${Number(p.minute)} ${Number(p.hour)} ${Number(p.day)} ${Number(p.month)} *`; };

// A call two hours out, on a whole minute, so both reminders are in the future.
function upcoming() {
  const start = Math.floor(Date.now() / 60_000) * 60 + 2 * 3600;
  return { start, date: etDate(start), time: etTime(start) };
}

const untagged = (text) => text.split("\n").slice(0, -1).filter((l) => !l.includes(TAG));

test("set: the old call's reminder lines go, the new call's pre, prep and four post lines are added, nothing else moves", () => {
  const sb = sandbox("ok");
  const call = upcoming();
  const r = sb.run(["set", call.date, call.time, "America/New_York", "series_R1"]);
  assert.equal(r.status, 0, r.stderr);
  const expected = [...untagged(SEED),
    `${cronAt(call.start - 900)} ${REMIND} pre "${call.time}"${ARG} ${TAG}`,
    `${cronAt(call.start - 2400)} ${REMIND} prep "${call.time}"${ARG} ${TAG}`,
    ...[60, 100, 150, 240].map((m) => `${cronAt(call.start + m * 60)} ${REMIND} post "${call.time}"${ARG} ${TAG}`),
  ].join("\n") + "\n";
  assert.equal(sb.cron(), expected);
  assert.match(r.stdout, /Pre-meeting reminder scheduled at/);
  assert.equal(JSON.parse(fs.readFileSync(sb.stateFile, "utf8")).date, call.date);
});

test("clear: only the tagged lines go, blanks and comments stay byte for byte", () => {
  const sb = sandbox("ok");
  const r = sb.run(["clear"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sb.cron(), untagged(SEED).join("\n") + "\n");
  assert.equal(JSON.parse(fs.readFileSync(sb.stateFile, "utf8")).status, "none_today");
});

// Every way the read can go wrong: nothing reaches `crontab -`, the crontab is
// byte-identical, the skip is logged, the exit is 4, and the state file still
// gets written (it tracks the call; the calendar check re-runs every morning).
for (const [mode, logged] of [["fail", /crontab -l exited 1/], ["partial", /crontab -l exited 1/], ["empty", /returned nothing/]]) {
  test(`set when the read is ${mode}: nothing installed, state still records the call, exit 4`, () => {
    const sb = sandbox(mode);
    const call = upcoming();
    const r = sb.run(["set", call.date, call.time, "America/New_York", "series_R1"]);
    assert.deepEqual(sb.writes(), [], "crontab - must never be called");
    assert.equal(sb.cron(), SEED, "crontab untouched");
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /not changed/i);
    assert.match(sb.skipLog(), logged);
    assert.equal(JSON.parse(fs.readFileSync(sb.stateFile, "utf8")).date, call.date);
  });
}

test("clear when `crontab -l` fails: nothing installed, state still says no call, exit 4", () => {
  const sb = sandbox("fail");
  const r = sb.run(["clear"]);
  assert.deepEqual(sb.writes(), []);
  assert.equal(sb.cron(), SEED);
  assert.equal(r.status, 4, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(sb.stateFile, "utf8")).status, "none_today");
});

test("a hung `crontab -l` is abandoned within the timeout and nothing is installed", () => {
  const sb = sandbox("hang");
  const r = sb.run(["clear"]);
  assert.ok(r.elapsed < 5000, `took ${r.elapsed}ms`);
  assert.deepEqual(sb.writes(), []);
  assert.equal(sb.cron(), SEED);
  assert.equal(r.status, 4, r.stderr);
  assert.match(sb.skipLog(), /timed out/);
});

// crontab-safe reads only CRONTAB_SAFE_TIMEOUT; this script family's
// own MEETING_CRONTAB_TIMEOUT reaches it through meeting-update.
test("MEETING_CRONTAB_TIMEOUT still bounds a hung `crontab -l` when CRONTAB_SAFE_TIMEOUT is unset", () => {
  const sb = sandbox("hang");
  const r = sb.run(["clear"], { CRONTAB_SAFE_TIMEOUT: "", MEETING_CRONTAB_TIMEOUT: "1" });
  assert.ok(r.elapsed < 4000, `took ${r.elapsed}ms`);
  assert.equal(r.status, 4, r.stderr);
  assert.match(sb.skipLog(), /timed out after 1s/);
});

test("crontab-safe: never installs an empty crontab, even when every line was tagged", () => {
  const sb = sandbox("ok", `0 9 1 1 * /bin/echo x ${TAG}\n`);
  assert.equal(sb.safe(["remove", TAG]).status, 1);
  assert.deepEqual(sb.writes(), []);
});

test("crontab-safe: nothing tagged and nothing to add means no install at all", () => {
  const sb = sandbox("ok", "0 7 * * * /bin/echo digest\n");
  assert.equal(sb.safe(["remove", TAG]).status, 0);
  assert.deepEqual(sb.writes(), []);
});

test("crontab-safe: a new line without the tag is a usage error; nothing read or written", () => {
  const sb = sandbox("ok");
  assert.equal(sb.safe(["replace", TAG, "0 9 * * * /bin/echo untagged"]).status, 2);
  assert.ok(!fs.existsSync(path.join(sb.dir, "calls.log")));
});

// ---- the later-day guard ----

function guardSandbox(state) {
  const sb = sandbox("ok", "# jobs\n0 7 * * * /bin/true\n");
  if (state) fs.writeFileSync(sb.stateFile, JSON.stringify(state));
  return sb;
}

const inHours = (h) => Math.floor(Date.now() / 1000) + h * 3600;
const gEtDate = (epoch) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(epoch * 1000));
const gEtTime = (epoch) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(epoch * 1000));
const held = (epoch) => ({ date: gEtDate(epoch), time: gEtTime(epoch), timezone: "America/New_York", epoch_start: epoch,
  calendar_event_id: "series_R1", status: "scheduled", pre_reminder_sent: false, post_reminder_sent: false });

test("a later day's instance does not displace a call still ahead", () => {
  const tonight = inHours(2);
  const tomorrow = tonight + 24 * 3600;
  const sb = guardSandbox(held(tonight));
  const before = fs.readFileSync(sb.stateFile, "utf8");
  const r = sb.run(["set", gEtDate(tomorrow), gEtTime(tomorrow), "America/New_York", "series_R1"]);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /still ahead/);
  assert.equal(fs.readFileSync(sb.stateFile, "utf8"), before, "state untouched");
});

test("the same day's call can still move", () => {
  const tonight = inHours(3);
  const later = tonight + 1800;
  const sb = guardSandbox(held(tonight));
  const r = sb.run(["set", gEtDate(tonight), gEtTime(later), "America/New_York", "series_R1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(sb.stateFile, "utf8")).time, gEtTime(later));
});

test("a sooner call replaces a later one (repairs a state that jumped ahead)", () => {
  const tomorrow = inHours(26);
  const tonight = inHours(2);
  if (gEtDate(tomorrow) === gEtDate(tonight)) return; // cannot construct across a day here
  const sb = guardSandbox(held(tomorrow));
  const r = sb.run(["set", gEtDate(tonight), gEtTime(tonight), "America/New_York", "series_R1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(sb.stateFile, "utf8")).date, gEtDate(tonight));
});

test("a call already started or past never blocks the next one", () => {
  const sb = guardSandbox(held(inHours(-3)));
  const next = inHours(24);
  const r = sb.run(["set", gEtDate(next), gEtTime(next), "America/New_York", "series_R1"]);
  assert.equal(r.status, 0, r.stderr);
});

test("MEETING_FORCE=1 overrides the guard", () => {
  const tonight = inHours(2);
  const tomorrow = tonight + 24 * 3600;
  const sb = guardSandbox(held(tonight));
  const r = sb.run(["set", gEtDate(tomorrow), gEtTime(tomorrow), "America/New_York", "series_R1"], { MEETING_FORCE: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(sb.stateFile, "utf8")).date, gEtDate(tomorrow));
});

test("clear is never guarded", () => {
  const sb = guardSandbox(held(inHours(2)));
  const r = sb.run(["clear"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(sb.stateFile, "utf8")).status, "none_today");
});

test("no meeting configured: says so, writes nothing, exit 0", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-off-"));
  const r = spawnSync("bash", [BIN, "clear"], { encoding: "utf8", env: { ...process.env, JORI_LOCAL_DIR: empty, MEETING_ID: "" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no recurring meeting configured/);
});
