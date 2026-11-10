// ticket-lottery-run.test.mjs — the run-level "say nothing while the user is
// away" rules of bin/ticket-lottery-run, exercised end to end.
//
// A signed-out listing has no dates, so the per-date AWAY gate never runs; a
// blocker with no dates behind it is judged against the lookahead
// (today..today+3), or it would go out while the user is abroad for weeks.
//
// Isolation: the script runs as a child process with JORI_HOME pointed at a
// temp tree, so its install paths (bin, data, browsing-skills) resolve there, and
// JORI_LOCAL_DIR at a temp local dir holding a synthetic two-platform config
// (one "list-enter" platform, one "form-email" one). That tree's bin holds stub
// metro-presence / calendar-conflict-check / jori-send-curl /
// chrome-close-tabs. A --import preload swaps cdp-runner.mjs for a fake that
// answers from a fixture, and replaces fetch + WebSocket so nothing in the
// child can reach the real automation Chrome or the network. Nothing is sent:
// the stub jori-send-curl only appends to a file.
//
// Run: node --test tests/ticket-lottery-run.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cdpResponsive, healChrome, describeHarnessFailure } from "../lib/ticket-lottery-error-triage.mjs";

const SCRIPT = path.resolve(import.meta.dirname, "..", "bin", "ticket-lottery-run");
const SIGNED_OUT = { ok: false, error: "not_logged_in" };

const PRELOAD = `
import fs from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
const dir = process.env.BW_TEST_DIR;
const fake = pathToFileURL(dir + "/fake-cdp-runner.mjs").href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/cdp-runner.mjs")) return { url: fake, shortCircuit: true };
    return next(specifier, context);
  },
});
// "healed" exists once the stub launchctl has restarted the (pretend) Chrome: only then do new tabs open.
const healed = () => fs.existsSync(dir + "/healed");
globalThis.WebSocket = class {
  constructor() {
    if (!healed()) throw new Error("test: WebSocket blocked");
    this.l = {};
    setTimeout(() => this.l.open && this.l.open(), 1);
  }
  addEventListener(ev, fn) { this.l[ev] = fn; }
  close() {}
};
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/json/new")) {
    if (!healed()) throw new Error("The operation was aborted due to timeout");
    return { ok: true, json: async () => ({ id: "T1", webSocketDebuggerUrl: "ws://localhost/x" }) };
  }
  if (u.includes("/json/close/")) return { ok: true };
  if (u.endsWith("/json/version")) {
    fs.appendFileSync(dir + "/fetch.log", u + "\\n");
    return { ok: process.env.BW_TEST_CDP_UP === "1" };
  }
  throw new Error("test: network blocked (" + u + ")");
};
`;

const FAKE_RUNNER = `
import fs from "node:fs";
import path from "node:path";
const dir = process.env.BW_TEST_DIR;
export function extractActionBlock(p) { return p; }
export async function runActionCdp({ actionBlock, cdpHost }) {
  const key = path.basename(path.dirname(path.dirname(actionBlock))) + "/" + path.basename(actionBlock, ".md");
  fs.appendFileSync(dir + "/skills.log", key + " " + cdpHost + "\\n");
  const fx = JSON.parse(fs.readFileSync(dir + "/skills.json", "utf8"));
  // An array fixture answers call by call (the last answer repeats): signed out, then in after site-login.
  let v = fx[key];
  if (Array.isArray(v)) {
    const cf = dir + "/calls.json"; const calls = fs.existsSync(cf) ? JSON.parse(fs.readFileSync(cf, "utf8")) : {};
    const i = calls[key] = (calls[key] || 0) + 1; fs.writeFileSync(cf, JSON.stringify(calls));
    v = v[Math.min(i, v.length) - 1];
  }
  return { ok: true, result: { content: [{ type: "text", text: JSON.stringify(v ?? { ok: false, error: "no_fixture" }) }] } };
}
`;

const STUBS = {
  // exit code per date from presence/<date>, else presence/default (1 = AWAY)
  "metro-presence": `#!/bin/bash
[ "$1 $2" = "--metro testville" ] || exit 2
echo "$3" >> "$BW_TEST_DIR/presence.log"
f="$BW_TEST_DIR/presence/$3"; [ -f "$f" ] || f="$BW_TEST_DIR/presence/default"
exit "$(cat "$f")"
`,
  "calendar-conflict-check": `#!/bin/bash
echo '{"conflict":false,"events":[]}'
`,
  "jori-send-curl": `#!/bin/bash
printf '%s\\n---\\n' "\${@: -1}" >> "$BW_TEST_DIR/sends.log"
`,
  "chrome-close-tabs": "#!/bin/bash\nexit 0\n",
  // outcome from login-status (default bad_credentials); args logged for assertions
  "site-login": `#!/bin/bash
echo "$*" >> "$BW_TEST_DIR/login.log"
st=bad_credentials; [ -f "$BW_TEST_DIR/login-status" ] && st="$(cat "$BW_TEST_DIR/login-status")"
echo "{\\"site\\":\\"$1\\",\\"status\\":\\"$st\\",\\"detail\\":\\"\\"}"
case "$st" in signed_in|already_signed_in) exit 0;; bad_credentials) exit 10;; *) exit 20;; esac
`,
};

// The config's zone is UTC, so "today" here and in the script agree.
const etToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date());

const CONFIG = {
  metro: "testville",
  tz: "UTC",
  title: "Test lottery",
  intent: "test-lottery",
  shows_file: "data/shows.json",
  files: { state: "data/lottery-state.json", guest: "data/guest-mode.json" },
  platforms: {
    alpha: { kind: "list-enter", label: "Alpha Tix", site: "alpha.example", url: "https://alpha.example/lottery", date_format: "long",
      mirror: [{ entrant: "friend", label: "Friend", cdp_host: "localhost:9333" }] },
    beta: { kind: "form-email", label: "Beta Lotto", site: "beta.example", url: "https://beta.example/", date_format: "slash",
      entry_url: "https://beta.example/enter/?lottery={perfId}" },
  },
};
const plusDays = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const tcStamp = (iso) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) + " at 7:30PM";

/** Run the script once in a fresh sandbox. presence: {default, [date]: exitCode}. */
function run({ skills, presence = { default: 1 }, cdpUp = true, guest = null, platform = "alpha", login = null, heal = "ok" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-lottery-run-"));
  const root = path.join(dir, "install");
  const bin = path.join(root, "bin");
  const data = path.join(root, "data");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(dir, "presence"));
  for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  for (const [k, v] of Object.entries(presence)) fs.writeFileSync(path.join(dir, "presence", k), String(v));
  const local = path.join(dir, "local");
  fs.mkdirSync(path.join(local, "config"), { recursive: true });
  fs.writeFileSync(path.join(local, "config", "ticket-lottery.json"), JSON.stringify(CONFIG));
  fs.writeFileSync(path.join(data, "shows.json"), JSON.stringify({ shows: [{ title: "The Test Play!" }], retired: [] }));
  if (guest) fs.writeFileSync(path.join(data, "guest-mode.json"), JSON.stringify(guest));
  if (login) fs.writeFileSync(path.join(dir, "login-status"), login);
  fs.writeFileSync(path.join(dir, "skills.json"), JSON.stringify(skills));
  fs.writeFileSync(path.join(dir, "fake-cdp-runner.mjs"), FAKE_RUNNER);
  fs.writeFileSync(path.join(dir, "preload.mjs"), PRELOAD);

  // A stub launchctl, first on PATH: logs the call and "restarts" Chrome (or fails), so the real one is never touched.
  const stubs = path.join(dir, "stubs");
  fs.mkdirSync(stubs);
  fs.writeFileSync(path.join(stubs, "launchctl"), `#!/bin/bash
echo "$*" >> "$BW_TEST_DIR/launchctl.log"
[ "$BW_TEST_HEAL" = "fail" ] && { echo "Could not find service" >&2; exit 113; }
touch "$BW_TEST_DIR/healed"
`, { mode: 0o755 });

  const r = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(dir, "preload.mjs")).href, SCRIPT, "--platform", platform], {
    env: { PATH: `${stubs}:${process.env.PATH}`, BW_TEST_HEAL: heal, HOME: dir, JORI_HOME: root, JORI_LOCAL_DIR: local, BW_TEST_DIR: dir, BW_TEST_CDP_UP: cdpUp ? "1" : "0" },
    encoding: "utf8",
    timeout: 60_000,
  });
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; } };
  const sends = read("sends.log").split("\n---\n").filter(Boolean);
  const out = {
    status: r.status, stdout: r.stdout, stderr: r.stderr, sends,
    presenceAsked: read("presence.log").split("\n").filter(Boolean),
    skillCalls: read("skills.log").split("\n").filter(Boolean),
    launchctlCalls: read("launchctl.log").split("\n").filter(Boolean),
    loginCalls: read("login.log").split("\n").filter(Boolean),
    fetches: read("fetch.log").split("\n").filter(Boolean),
    state: JSON.parse(fs.readFileSync(path.join(data, "lottery-state.json"), "utf8")),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(out.status, 0, `script exited ${out.status}\n${out.stdout}\n${out.stderr}`);
  // The fake runner answered, so the real one (and the real Chrome) was never loaded.
  if (cdpUp) assert.ok(out.skillCalls.length > 0, "fake cdp-runner was not used");
  return out;
}

const lookahead = () => [0, 1, 2, 3].map((i) => plusDays(etToday(), i));
const suppressedLines = (stdout) => stdout.split("\n").filter((l) => l.includes("not reported"));
/** The {"skill_health":"quiet"} lines browsing-skills/tools/skill-health.js honours. */
const quietMarkers = (stdout) => stdout.split("\n").filter((l) => l.startsWith('{"skill_health"')).map((l) => JSON.parse(l));

test("signed-out list-enter session + every lookahead date AWAY → nothing sent, one log line", () => {
  const r = run({ skills: { "alpha.example/lottery-list-active": SIGNED_OUT } });
  assert.deepEqual(r.sends, [], "no message while the user is away for every date the lottery could enter");
  assert.equal(suppressedLines(r.stdout).length, 1, r.stdout);
  assert.match(suppressedLines(r.stdout)[0], /Alpha Tix signed out/);
  assert.deepEqual(r.presenceAsked, lookahead(), "presence is judged per lookahead date, today..today+3");
  assert.equal(r.state.last_run_status, "blocked", "the state file still records the blocker");
  assert.equal(r.state.last_run_by_platform.alpha, etToday());
  // ...and the nightly skill-health check is told the same, so it doesn't push about it either.
  const m = quietMarkers(r.stdout);
  assert.equal(m.length, 1, r.stdout);
  assert.deepEqual(m[0].skills, ["alpha.example/lottery-list-active/lottery-list-active"]);
  assert.equal(m[0].skill_health, "quiet");
});

test("signed-out session + one in-town date in the lookahead → blocker reported as today", () => {
  const r = run({ skills: { "alpha.example/lottery-list-active": SIGNED_OUT }, presence: { default: 1, [plusDays(etToday(), 2)]: 0 } });
  assert.equal(r.sends.length, 1);
  assert.equal(r.sends[0],
    "🎟️ Test lottery — nothing got entered today.\n\nNeeds a look: Alpha Tix signed out and the saved login for your alpha.example account didn't work — send me the right email/password and I'll update it.");
  assert.equal(suppressedLines(r.stdout).length, 0);
  assert.deepEqual(quietMarkers(r.stdout), [], "a reported blocker leaves skill-health free to alert");
});

test("presence check erroring → fail open, the blocker is still reported", () => {
  const r = run({ skills: { "alpha.example/lottery-list-active": SIGNED_OUT }, presence: { default: 2 } });
  assert.equal(r.sends.length, 1);
  assert.match(r.sends[0], /Alpha Tix signed out/);
});

test("away for every date but a guest-mode date in the lookahead → blocker reported", () => {
  const r = run({
    skills: { "alpha.example/lottery-list-active": SIGNED_OUT },
    guest: { active: true, for: "a friend", dates: [plusDays(etToday(), 1)] },
  });
  assert.equal(r.sends.length, 1);
  assert.match(r.sends[0], /Alpha Tix signed out/);
});

test("automation Chrome down: quiet while away for the lookahead, reported when a date is in town", () => {
  const away = run({ skills: {}, cdpUp: false });
  assert.deepEqual(away.sends, []);
  assert.equal(suppressedLines(away.stdout).length, 1, away.stdout);
  assert.equal(away.state.last_run_status, "blocked");
  assert.deepEqual(away.skillCalls, [], "nothing was driven");

  const home = run({ skills: {}, cdpUp: false, presence: { default: 0 } });
  assert.equal(home.sends.length, 1);
  assert.match(home.sends[0], /automation Chrome \(port 9222\) isn't answering/);
});

test("form-email list failure while away for the lookahead → nothing sent", () => {
  const r = run({ platform: "beta", skills: { "beta.example/lottery-list-active": { ok: false, error: "list_timeout" } } });
  assert.deepEqual(r.sends, []);
  assert.match(suppressedLines(r.stdout)[0] || "", /Beta Lotto list failed \(list_timeout\)/);
});

test("listing readable, every listed date AWAY → nothing sent and no lookahead probe (the per-date rule)", () => {
  const date = plusDays(etToday(), 1);
  const r = run({
    skills: {
      "alpha.example/lottery-list-active": {
        ok: true, state: "populated",
        shows: [{ eventId: 4242, title: "THE TEST PLAY!", performanceDate: tcStamp(date), status: "open" }],
      },
    },
  });
  assert.deepEqual(r.sends, []);
  assert.deepEqual(r.presenceAsked, [date], "only the listed performance date is checked");
  assert.ok(!r.skillCalls.some((c) => c.startsWith("alpha.example/lottery-enter")), "nothing entered for an AWAY date");
  assert.equal(r.state.last_run_status, "away_no_entries");
});

test("in town: a list-enter drawing is entered for the owner, then mirrored for each mirror entrant", () => {
  const date = plusDays(etToday(), 1);
  const r = run({
    presence: { default: 0 },
    skills: {
      "alpha.example/lottery-list-active": {
        ok: true, state: "populated",
        shows: [{ eventId: 4242, title: "THE TEST PLAY!", performanceDate: tcStamp(date), status: "open" }],
      },
      "alpha.example/lottery-enter": { ok: true, entered: true },
    },
  });
  const rows = r.state.entries.map((e) => [e.show, e.platform, e.entrant, e.status, e.date]);
  assert.deepEqual(rows, [
    ["The Test Play!", "alpha", "user", "submitted", date],
    ["The Test Play!", "alpha", "friend", "submitted", date],
  ]);
  assert.ok(r.skillCalls.includes("alpha.example/lottery-enter localhost:9333"), "the mirror entry ran on the mirror's own Chrome");
  assert.deepEqual(r.sends, ["🎟️ Test lottery entries for today:\n• The Test Play! — Alpha Tix 1 date (+1 for Friend)"]);
  assert.equal(r.state.last_run_status, "submitted");
});

const POPULATED = (date) => ({ ok: true, state: "populated", shows: [{ eventId: 4242, title: "THE TEST PLAY!", performanceDate: tcStamp(date), status: "open" }] });

test("signed out → signed back in automatically with the saved login, then entered as usual", () => {
  const date = plusDays(etToday(), 1);
  const r = run({
    presence: { default: 0 }, login: "signed_in",
    skills: { "alpha.example/lottery-list-active": [SIGNED_OUT, POPULATED(date)], "alpha.example/lottery-enter": { ok: true, entered: true } },
  });
  assert.equal(r.loginCalls.length, 1, "one sign-in, for the owner");
  assert.match(r.loginCalls[0], /^alpha\.example --login-url https:\/\/alpha\.example\/lottery .*--port 9222/);
  assert.deepEqual(r.state.entries.map((e) => [e.entrant, e.status]), [["user", "submitted"], ["friend", "submitted"]]);
  assert.deepEqual(r.sends, ["🎟️ Test lottery entries for today:\n• The Test Play! — Alpha Tix 1 date (+1 for Friend)"], "nothing about the sign-in reaches the user");
});

test("automatic sign-in blocked by something other than the password → says so, asks to find a way around", () => {
  const r = run({ presence: { default: 0 }, login: "captcha", skills: { "alpha.example/lottery-list-active": SIGNED_OUT } });
  assert.equal(r.sends.length, 1);
  assert.match(r.sends[0], /Alpha Tix signed out and the automatic sign-in for your account was blocked \(captcha\) — let's find a way around it/);
});

test("mirror entrant signed out and their saved login refused → asks for their login; owner entries stand", () => {
  const date = plusDays(etToday(), 1);
  const r = run({
    presence: { default: 0 }, login: "bad_credentials",
    skills: { "alpha.example/lottery-list-active": [POPULATED(date), SIGNED_OUT], "alpha.example/lottery-enter": { ok: true, entered: true } },
  });
  assert.equal(r.loginCalls.length, 1);
  assert.match(r.loginCalls[0], /--port 9333/, "signed in on the mirror's own Chrome");
  assert.deepEqual(r.state.entries.filter((e) => e.status === "submitted").map((e) => e.entrant), ["user"]);
  assert.equal(r.sends.length, 1);
  assert.match(r.sends[0], /Friend's alpha\.example account didn't work — send me the right email\/password and I'll update it; your own entries still went in/);
});

test("no lottery config: off — exits 0, drives nothing, writes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-lottery-off-"));
  const r = spawnSync(process.execPath, [SCRIPT, "--platform", "all"], {
    env: { PATH: process.env.PATH, HOME: dir, JORI_HOME: path.join(dir, "install"), JORI_LOCAL_DIR: path.join(dir, "local") },
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no lottery platforms configured/);
  assert.ok(!fs.existsSync(path.join(dir, "install", "data")), "no state written");
  fs.rmSync(dir, { recursive: true, force: true });
});

const EXC = { ok: false, error: "runner_exception", message: "cdp websocket open timeout" };
const wedgedEnter = (date, enter) => ({ presence: { default: 0 }, skills: { "alpha.example/lottery-list-active": POPULATED(date), "alpha.example/lottery-enter": enter } });

test("browser driver failure + Chrome wedged → Chrome is restarted, the entry retried and goes in", () => {
  const date = plusDays(etToday(), 1);
  const r = run(wedgedEnter(date, [EXC, { ok: true, entered: true }]));
  assert.equal(r.launchctlCalls.length, 1, "Chrome restarted once");
  assert.match(r.launchctlCalls[0], /^kickstart -k gui\/\d+\/com\.jori\.chrome-cdp$/);
  assert.deepEqual(r.state.entries.map((e) => [e.entrant, e.status]), [["user", "submitted"], ["friend", "submitted"]]);
  assert.deepEqual(r.sends, ["🎟️ Test lottery entries for today:\n• The Test Play! — Alpha Tix 1 date (+1 for Friend)"]);
});

test("browser driver failure + Chrome will not restart → no pointless retry, the message states the real cause", () => {
  const date = plusDays(etToday(), 1);
  const r = run({ ...wedgedEnter(date, EXC), heal: "fail" });
  assert.equal(r.launchctlCalls.length, 1);
  assert.equal(r.skillCalls.filter((c) => c.startsWith("alpha.example/lottery-enter")).length, 1, "not retried into a dead browser");
  assert.equal(r.sends.length, 1);
  assert.match(r.sends[0], /errors: the automation Chrome stopped answering \(it would not open a new tab\)/);
  assert.match(r.sends[0], /Needs a look: Alpha Tix — the automation Chrome on .* stopped answering and restarting it did not bring it back/);
  assert.doesNotMatch(r.sends[0], /runner_exception/);
});

// ── wedged-Chrome helpers in lib/ticket-lottery-error-triage.mjs ──

const okFetch = async (u) => (String(u).includes("/json/new")
  ? { ok: true, json: async () => ({ id: "T", webSocketDebuggerUrl: "ws://x" }) } : { ok: true });
const OpenWS = class { constructor() { this.l = {}; setTimeout(() => this.l.open?.(), 1); } addEventListener(e, f) { this.l[e] = f; } close() {} };
const SilentWS = class { addEventListener() {} close() {} };

test("cdp-health: a Chrome that opens a tab and a socket is responsive", async () => {
  assert.deepEqual(await cdpResponsive("h:1", { fetchImpl: okFetch, WS: OpenWS }), { ok: true });
});
test("cdp-health: /json/new hanging is reported at the new_tab stage", async () => {
  const r = await cdpResponsive("h:1", { fetchImpl: async () => { throw new Error("The operation was aborted due to timeout"); }, WS: OpenWS });
  assert.equal(r.ok, false); assert.equal(r.stage, "new_tab");
});
test("cdp-health: a socket that never opens is reported at the socket stage, and the tab is still closed", async () => {
  const closed = [];
  const f = async (u) => { if (String(u).includes("/json/close/")) closed.push(u); return okFetch(u); };
  const r = await cdpResponsive("h:1", { timeoutMs: 30, fetchImpl: f, WS: SilentWS });
  assert.equal(r.stage, "socket"); assert.equal(closed.length, 1);
});
test("cdp-health: healChrome kickstarts, then waits until tabs open again", async () => {
  const calls = []; let n = 0; let t = 0;
  const h = await healChrome({ host: "h:1", label: "com.x", run: async (...a) => calls.push(a), probe: async () => ({ ok: ++n >= 3 }), sleep: async (ms) => { t += ms; }, now: () => t });
  assert.equal(h.healed, true); assert.equal(calls.length, 1); assert.deepEqual(calls[0][1].slice(0, 2), ["kickstart", "-k"]);
});
test("cdp-health: healChrome gives up after the wait, and reports a failed kickstart", async () => {
  let t = 0;
  const a = await healChrome({ host: "h:1", label: "com.x", waitMs: 10_000, run: async () => {}, probe: async () => ({ ok: false }), sleep: async (ms) => { t += ms; }, now: () => t });
  assert.equal(a.healed, false);
  const b = await healChrome({ host: "h:1", label: "com.x", run: async () => { throw new Error("no service"); } });
  assert.equal(b.healed, false); assert.match(b.detail, /kickstart com\.x failed/);
});
test("cdp-health: describeHarnessFailure names the cause", () => {
  assert.match(describeHarnessFailure("cdp websocket open timeout"), /stopped answering/);
  assert.match(describeHarnessFailure("The operation was aborted due to timeout"), /stopped answering/);
  assert.match(describeHarnessFailure("websocket error"), /stopped answering/);
  assert.equal(describeHarnessFailure("something odd"), "something odd");
  assert.match(describeHarnessFailure(""), /without saying why/);
});
