// Item 2 of the 2026-10-20 review (2026-10-22): stale-code-watch restarts the
// small daemons nothing else restarted (heartbeat-sender, minibeat, dashboard,
// the wiki servers) once their committed code is newer than the process, and
// flags what it must not restart (process-manager on old code 6h+; a restart
// that did not take; code left uncommitted 12h+). phone-channel is no longer
// flagged here: supervisor-code-reload reloads it with chat.
// whatsapp-channel is restarted the same way once WhatsApp has been quiet, and
// flagged only when it never was. Every machine touch is an injected fake over
// a throwaway tree: nothing real is restarted or signalled.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "scw-"));
process.env.JORI_ROOT = ROOT;
const m = await import("../lib/stale-code-watch.mjs");

const MIN = 60_000, H = 3_600_000;
const NOW = Date.parse("2026-10-22T10:01:20Z");
const OLD = NOW - 30 * 86_400_000;
const FILES = {
  "heartbeat-sender.sh": "#!/bin/bash\nwhile true; do sleep 120; done\n",
  "bin/minibeat": "#!/bin/bash\nwhile true; do sleep 30; done\n",
  "agent/dashboard/server.mjs": 'import "./lib.mjs";\n',
  "agent/dashboard/lib.mjs": "export {};\n",
  "bin/wiki": 'require("../lib/wiki-serve.js");\n',
  "lib/wiki-serve.js": "module.exports = {};\n",
  "agent/whatsapp-channel/index.mjs": "export {};\n",
  "agent/phone-channel/index.mjs": "export {};\n",
  "agent/bin/process-manager.mjs": "export {};\n",
};
for (const [rel, body] of Object.entries(FILES)) {
  const f = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  fs.utimesSync(f, OLD / 1000, OLD / 1000);
}
const touch = (rel, ms) => fs.utimesSync(path.join(ROOT, rel), ms / 1000, ms / 1000);
const lstart = (ms) => new Date(ms).toString().split(" ").slice(0, 5).join(" ").replace(/^(\w+) (\w+) (\d+) (\d+) ([\d:]+)$/, "$1 $2 $3 $5 $4");
const row = (pid, ppid, startMs, cmd) => `${pid} ${ppid} ${lstart(startMs)} ${cmd}`;

function harness(o = {}) {
  const started = o.started ?? NOW - 2 * 86_400_000;
  const procs = {
    797: ["/bin/bash", path.join(ROOT, "heartbeat-sender.sh")],
    815: ["/bin/bash", path.join(ROOT, "bin/minibeat")],
    47267: ["/opt/homebrew/bin/node", path.join(ROOT, "agent/dashboard/server.mjs")],
    24132: ["/opt/homebrew/bin/node", path.join(ROOT, "bin/wiki"), "serve", "--port", "9096"],
    24133: ["/opt/homebrew/bin/node", path.join(ROOT, "bin/wiki"), "serve", "--port", "9097"],
    24134: ["/opt/homebrew/bin/node", path.join(ROOT, "agent/whatsapp-channel/index.mjs")],
    24125: ["/opt/homebrew/bin/node", path.join(ROOT, "agent/bin/process-manager.mjs")],
    51475: ["node", path.join(ROOT, "agent/phone-channel/index.mjs")],
  };
  const startOf = o.startOf || {};
  const ps = Object.entries(procs).map(([pid, argv]) => row(pid, 1, startOf[pid] ?? started, argv.join(" "))).join("\n");
  const calls = [];
  let state = o.state || {};
  const io = {
    now: () => new Date(o.now ?? NOW),
    ps: () => (o.psNull ? null : ps),
    pmHealth: async () => (o.pmDown ? null : { children: [
      { name: "wiki-server", pid: 24132, alive: true }, { name: "wiki-server-public", pid: 24133, alive: true },
      { name: "whatsapp-channel", pid: 24134, alive: !o.waDown }] }),
    launchdPid: (label) => ({ [m.SMALL[0].label]: 797, "com.jori.minibeat": 815, "com.jori.dashboard": 47267, "ai.claude.session": 24125 })[label] ?? null,
    git: (args) => {
      if (args[0] === "status") return (o.dirty || []).map((p) => ` M ${p}`).join("\0");
      return "";
    },
    statMs: (f) => fs.statSync(f).mtimeMs,
    syntaxOk: () => o.syntaxOk ?? true,
    gitBusy: () => o.gitBusy ?? null,
    // WhatsApp's message log / key store: written a minute ago unless a test says it went quiet
    // (o.waWrites: per-path last write, keyed by a suffix of the path, for tests that need them apart)
    lastWriteMs: (files) => {
      if (!o.waWrites) return o.waLastWrite ?? (o.now ?? NOW) - 1 * MIN;
      return Math.max(0, ...files.map((f) => Object.entries(o.waWrites).find(([k]) => f.endsWith(k))?.[1] ?? 0));
    },
    kickstart: (label) => calls.push(["kickstart", label]),
    kill: (pid, sig) => calls.push(["kill", pid, sig]),
    readState: () => state,
    writeState: (s) => { state = JSON.parse(JSON.stringify(s)); },
    readReloadState: () => o.reload || {},
    say: () => {},
  };
  return { io, calls, state: () => state };
}

test("nothing changed since the daemons started: no restart, no flag", async () => {
  const h = harness();
  assert.equal(await m.main([], h.io, ROOT), 0);
  assert.deepEqual(h.calls, []);
});

test("a committed change to a small daemon restarts exactly it, by its own mechanism", async () => {
  touch("bin/minibeat", NOW - 30 * MIN);
  touch("lib/wiki-serve.js", NOW - 30 * MIN);   // in bin/wiki's closure
  const h = harness();
  assert.equal(await m.main([], h.io, ROOT), 0);
  assert.deepEqual(h.calls.sort(), [["kickstart", "com.jori.minibeat"], ["kill", 24132, "SIGTERM"], ["kill", 24133, "SIGTERM"]].sort());
  assert.ok(h.state().minibeat.stampMs);
  // the next tick sees the same stamp, process not yet back: no second restart
  const h2 = harness({ state: h.state(), now: NOW + 2 * MIN });
  await m.main([], h2.io, ROOT);
  assert.deepEqual(h2.calls, []);
  touch("bin/minibeat", OLD); touch("lib/wiki-serve.js", OLD);
});

test("holds: uncommitted edit, failing syntax, code still settling, git busy", async () => {
  touch("agent/dashboard/lib.mjs", NOW - 30 * MIN);
  for (const o of [{ dirty: ["agent/dashboard/lib.mjs"] }, { syntaxOk: false }, { now: NOW - 29 * MIN }, { gitBusy: "git operation in progress" }]) {
    const h = harness(o);
    await m.main([], h.io, ROOT);
    assert.deepEqual(h.calls, [], JSON.stringify(o));
  }
  touch("agent/dashboard/lib.mjs", OLD);
});

test("a restart that did not take is flagged", async () => {
  touch("heartbeat-sender.sh", NOW - 60 * MIN);
  const st = { "heartbeat-sender": { stampMs: NOW - 60 * MIN, at: new Date(NOW - 20 * MIN).toISOString(), pid: 797 } };
  const h = harness({ state: st });
  assert.equal(await m.main([], h.io, ROOT), 6);
  assert.match(h.state()._flag, /heartbeat-sender: restarted for new code but still runs the old/);
  touch("heartbeat-sender.sh", OLD);
});

test("big daemons are never restarted, only flagged after 6h on old code (whatsapp-channel: while WhatsApp is never quiet)", async () => {
  touch("agent/whatsapp-channel/index.mjs", NOW - 2 * H);
  let h = harness();
  assert.equal(await m.main([], h.io, ROOT), 0, "2h: not yet");
  touch("agent/whatsapp-channel/index.mjs", NOW - 7 * H);
  touch("agent/bin/process-manager.mjs", NOW - 8 * H);
  h = harness();
  assert.equal(await m.main([], h.io, ROOT), 6);
  assert.deepEqual(h.calls, []);
  assert.match(h.state()._flag, /whatsapp-channel: on code older than committed for 7h \(jori restart whatsapp-channel\)/);
  assert.match(h.state()._flag, /process-manager: on code older than committed for 8h/);
  assert.match(h.state()._flag, /^⚠️ /);
  touch("agent/whatsapp-channel/index.mjs", OLD); touch("agent/bin/process-manager.mjs", OLD);
});

// Regression guard for the stale-code-flag alert ("Code on disk isn't fully
// live or saved: whatsapp-channel: on code older than committed"): with
// whatsapp-channel flag-only, every commit to code it loads left that fix inert
// and the alert re-posting until someone restarted it by hand. It now restarts
// itself once its message log and key store have been still for QUIET_MS.
test("whatsapp-channel restarts onto committed code once WhatsApp has been quiet, once per code stamp", async () => {
  const WA = "agent/whatsapp-channel/index.mjs";
  touch(WA, NOW - 30 * MIN);
  const h = harness({ waLastWrite: NOW - 15 * MIN });
  assert.equal(await m.main([], h.io, ROOT), 0);
  assert.deepEqual(h.calls, [["kill", 24134, "SIGTERM"]]);
  assert.equal(h.state()["whatsapp-channel"].stampMs, NOW - 30 * MIN);
  assert.equal(h.state()._flag, undefined);
  const after = () => JSON.parse(JSON.stringify(h.state()));   // each later tick starts from this one's state

  // next tick, still the old process: no second signal for the same code
  const h2 = harness({ state: after(), now: NOW + 2 * MIN, waLastWrite: NOW - 15 * MIN });
  assert.equal(await m.main([], h2.io, ROOT), 0);
  assert.deepEqual(h2.calls, []);

  // the old process is still there 15 minutes on: the restart did not take
  const h3 = harness({ state: after(), now: NOW + 15 * MIN, waLastWrite: NOW - 15 * MIN });
  assert.equal(await m.main([], h3.io, ROOT), 6);
  assert.match(h3.state()._flag, /whatsapp-channel: restarted for new code but still runs the old \(pid 24134\)/);

  // it came back on a new process: current, nothing flagged, nothing to restart
  const h4 = harness({ state: after(), now: NOW + 3 * MIN, startOf: { 24134: NOW + 1 * MIN }, waLastWrite: NOW - 15 * MIN });
  assert.equal(await m.main([], h4.io, ROOT), 0);
  assert.deepEqual(h4.calls, []);
  assert.equal(h4.state()["whatsapp-channel"].back, true);
  assert.equal(h4.state()._missed_since?.["whatsapp-channel"], undefined);

  // it never came back: that restart is the suspect
  const h5 = harness({ state: after(), now: NOW + 15 * MIN, waDown: true });
  assert.equal(await m.main([], h5.io, ROOT), 6);
  assert.match(h5.state()._flag, /whatsapp-channel: restarted at \d\d:\d\dZ for new code and not running since/);
  touch(WA, OLD);
});

test("whatsapp-channel holds while WhatsApp is busy or its code is not committed, and is flagged if no quiet window came in 6h", async () => {
  const WA = "agent/whatsapp-channel/index.mjs";
  touch(WA, NOW - 30 * MIN);
  for (const o of [{ waLastWrite: NOW - 2 * MIN }, { waLastWrite: NOW - 15 * MIN, dirty: [WA] }, { waLastWrite: NOW - 15 * MIN, syntaxOk: false }, { waLastWrite: NOW - 15 * MIN, gitBusy: "git operation in progress" }]) {
    const h = harness(o);
    assert.equal(await m.main([], h.io, ROOT), 0, JSON.stringify(o));
    assert.deepEqual(h.calls, [], JSON.stringify(o));
  }
  touch(WA, NOW - 1 * MIN);                       // code still settling
  const hs = harness({ waLastWrite: NOW - 15 * MIN });
  await m.main([], hs.io, ROOT);
  assert.deepEqual(hs.calls, []);
  touch(WA, NOW - 7 * H);                         // busy all along: flagged as before, still not signalled
  const h7 = harness({ waLastWrite: NOW - 1 * MIN });
  assert.equal(await m.main([], h7.io, ROOT), 6);
  assert.deepEqual(h7.calls, []);
  assert.match(h7.state()._flag, /whatsapp-channel: on code older than committed for 7h \(jori restart whatsapp-channel\)/);
  // --dry-run names it and signals nothing
  const hd = harness({ waLastWrite: NOW - 15 * MIN });
  await m.main(["--dry-run"], hd.io, ROOT);
  assert.deepEqual(hd.calls, []);
  touch(WA, OLD);
});

// Regression guard for the stale-code-flag alert re-posting for whatsapp-channel
// after the quiet restart shipped: the running client rewrites creds.json about
// every 10 minutes with no traffic at all, so with the key store held to the
// message log's 10-minute window no tick ever saw it still and the restart never
// fired (12h flagged overnight with the message log quiet for hours). The key
// store now only has to be still for KEY_QUIET_MS.
test("whatsapp-channel restarts when the message log is quiet even though the key store is rewritten every 10 minutes", async () => {
  const WA = "agent/whatsapp-channel/index.mjs";
  touch(WA, NOW - 30 * MIN);
  const timer = { "whatsapp-inbox.jsonl": NOW - 3 * H, "wa-auth/baileys": NOW - 9 * H, "creds.json": NOW - 3 * MIN };
  try {
  const h = harness({ waWrites: timer });
  assert.equal(await m.main([], h.io, ROOT), 0);
  assert.deepEqual(h.calls, [["kill", 24134, "SIGTERM"]]);
  // a key write in the last minute still holds it
  const hk = harness({ waWrites: { ...timer, "creds.json": NOW - 20 * 1000 } });
  await m.main([], hk.io, ROOT);
  assert.deepEqual(hk.calls, []);
  assert.equal(hk.state()._held["whatsapp-channel"], "session keys written in the last minute");
  // a message in the last 10 minutes still holds it
  const hm = harness({ waWrites: { ...timer, "whatsapp-inbox.jsonl": NOW - 5 * MIN } });
  await m.main([], hm.io, ROOT);
  assert.deepEqual(hm.calls, []);
  assert.equal(hm.state()._held["whatsapp-channel"], "written to in the last 10 minutes");
  } finally { touch(WA, OLD); }
});

test("quietHold: each path against its own window, first one written too recently wins", () => {
  const q = [{ path: "log", ms: 10 * MIN, what: "log" }, { path: "keys", ms: MIN, what: "keys" }];
  const at = (w) => (p) => w[p];
  assert.deepEqual(m.quietHold(q, NOW, at({ log: NOW - 11 * MIN, keys: NOW - 2 * MIN })), { hold: null, stillMs: 11 * MIN });
  assert.equal(m.quietHold(q, NOW, at({ log: NOW - 11 * MIN, keys: NOW - 30 * 1000 })).hold, "keys");
  assert.equal(m.quietHold(q, NOW, at({ log: NOW - 9 * MIN, keys: NOW - 30 * 1000 })).hold, "log");
});

test("process-manager stays flag-only even when WhatsApp is quiet", async () => {
  touch("agent/bin/process-manager.mjs", NOW - 7 * H);
  const h = harness({ waLastWrite: NOW - 60 * MIN });
  assert.equal(await m.main([], h.io, ROOT), 6);
  assert.deepEqual(h.calls, []);
  assert.match(h.state()._flag, /process-manager: on code older than committed for 7h/);
  touch("agent/bin/process-manager.mjs", OLD);
});

// Regression guard for the stale-code-flag alert "phone-channel: on code older
// than committed for Nh (loads with chat's next session: jori restart chat)":
// phone-channel is chat's MCP grandchild and nothing reloaded it, so a commit to
// its own code sat unloaded for a day. supervisor-code-reload now reloads it with
// chat (idle-gated) and pages through its own exit 4; flagging it here as well
// would page twice for one condition.
test("phone-channel on old code is neither flagged nor signalled here (supervisor-code-reload owns it)", async () => {
  assert.ok(!m.FLAG_ONLY.some((t) => t.name === "phone-channel"));
  assert.ok(![...m.SMALL, ...m.WHEN_QUIET].some((t) => t.name === "phone-channel"));
  touch("agent/phone-channel/index.mjs", NOW - 30 * H);
  try {
    const stale = { _missed_since: { "phone-channel": { pid: 51475, startedMs: NOW - 2 * 86_400_000 + 999, sinceMs: NOW - 30 * H } } };
    const h = harness({ state: stale });
    assert.equal(await m.main([], h.io, ROOT), 0);
    assert.deepEqual(h.calls, []);
    assert.equal(h.state()._flag, undefined);
    assert.equal(h.state()._missed_since, undefined, "an old phone-channel sighting is dropped");
  } finally { touch("agent/phone-channel/index.mjs", OLD); }
});

// Regression guard for the stale-code-flag alert: missedSince sees only a
// file's newest mtime, so a second commit to a file a long-running daemon had
// already missed used to reset the age to 0, clear the flag (watchdog's false
// "Recovered: stale-code-flag ... auto-healed") and page again 6h later, while
// the daemon ran the old code the whole time.
test("a re-commit to a file a long-running daemon already missed does not clear or reset the stale-code flag", async () => {
  const WA = "agent/whatsapp-channel/index.mjs";
  touch(WA, NOW - 7 * H);
  const h1 = harness();
  assert.equal(await m.main([], h1.io, ROOT), 6);
  assert.match(h1.state()._flag, /whatsapp-channel: on code older than committed for 7h/);
  const first = h1.state()._missed_since["whatsapp-channel"];
  assert.equal(first.pid, 24134);
  assert.equal(first.sinceMs, NOW - 7 * H);

  touch(WA, NOW - 1 * H);                       // the same file committed again; the daemon still was not restarted
  const h2 = harness({ state: h1.state() });
  assert.equal(await m.main([], h2.io, ROOT), 6, "flag must not clear");
  assert.match(h2.state()._flag, /whatsapp-channel: on code older than committed for 7h \(jori restart whatsapp-channel\)/);
  assert.ok(!h2.state()._flag.includes("for 1h"), h2.state()._flag);
  assert.equal(h2.state()._missed_since["whatsapp-channel"].sinceMs, NOW - 7 * H);

  // an uncommitted edit on top hides the file from missedSince; the same process is still on old code
  const h3 = harness({ state: h2.state(), dirty: [WA] });
  assert.equal(await m.main([], h3.io, ROOT), 6);
  assert.match(h3.state()._flag, /whatsapp-channel: on code older than committed for 7h/);

  // restarted after the last commit: current, no flag, the entry is gone
  const h4 = harness({ state: h2.state(), startOf: { 24134: NOW - 30 * MIN } });
  assert.equal(await m.main([], h4.io, ROOT), 0);
  assert.equal(h4.state()._flag, undefined);
  assert.equal(h4.state()._missed_since?.["whatsapp-channel"], undefined);

  // restarted between the two commits: a new process ages from what it missed, not the old process's sighting
  const h5 = harness({ state: h2.state(), startOf: { 24134: NOW - 3 * H } });
  assert.equal(await m.main([], h5.io, ROOT), 0);
  assert.equal(h5.state()._missed_since["whatsapp-channel"].sinceMs, NOW - 1 * H);
  touch(WA, OLD);
});

test("no stored sighting (first run after deploy) or one from an earlier process: the computed age is used", async () => {
  const WA = "agent/whatsapp-channel/index.mjs";
  touch(WA, NOW - 7 * H);
  for (const state of [{}, { _missed_since: { "whatsapp-channel": { pid: 999, startedMs: NOW - 9 * 86_400_000, sinceMs: NOW - 40 * H } } }]) {
    const h = harness({ state });
    assert.equal(await m.main([], h.io, ROOT), 6);
    assert.match(h.state()._flag, /whatsapp-channel: on code older than committed for 7h/, JSON.stringify(state));
    assert.equal(h.state()._missed_since["whatsapp-channel"].pid, 24134);
    assert.equal(h.state()._missed_since["whatsapp-channel"].sinceMs, NOW - 7 * H);
  }
  // an uncommitted edit with no sighting stored: not flagged, same as before the ledger existed
  const h = harness({ dirty: [WA] });
  assert.equal(await m.main([], h.io, ROOT), 0);
  assert.equal(h.state()._missed_since, undefined);
  touch(WA, OLD);
});

test("stickyMissed: keeps the first sighting for the same process only", () => {
  const run = { pid: 7, startedMs: 1000 };
  assert.equal(m.stickyMissed(undefined, run, 0), null);
  assert.deepEqual(m.stickyMissed(undefined, run, 5000), { pid: 7, startedMs: 1000, sinceMs: 5000 });
  assert.equal(m.stickyMissed({ pid: 7, startedMs: 1000, sinceMs: 2000 }, run, 9000).sinceMs, 2000);
  assert.equal(m.stickyMissed({ pid: 8, startedMs: 1000, sinceMs: 2000 }, run, 9000).sinceMs, 9000);
  assert.equal(m.stickyMissed({ pid: 7, startedMs: 999, sinceMs: 2000 }, run, 9000).sinceMs, 9000);
  assert.equal(m.stickyMissed({ pid: 7, startedMs: 1000, sinceMs: 2000 }, run, 0), null);
  assert.equal(m.stickyMissed({ pid: 7, startedMs: 1000, sinceMs: 2000 }, run, 0, true).sinceMs, 2000);
  assert.equal(m.stickyMissed({ pid: 8, startedMs: 1000, sinceMs: 2000 }, run, 0, true), null);
});

test("code left uncommitted 12h+ is flagged; runtime data and young edits are not", async () => {
  const since = (h) => new Date(NOW - h * H).toISOString();
  const h = harness({
    dirty: ["agent/chat-agent/CLAUDE.md", "lib/wiki-access.js", "data/spam-blocklist.json", "bin/new-thing"],
    reload: { _dirty_since: {
      "agent/chat-agent/CLAUDE.md": { since: since(50) }, "lib/wiki-access.js": { since: since(13) },
      "data/spam-blocklist.json": { since: since(48) }, "bin/new-thing": { since: since(2) },
      "lib/already-committed.js": { since: since(99) } } },
  });
  assert.equal(await m.main([], h.io, ROOT), 6);
  const f = h.state()._flag;
  assert.ok(f.includes("not committed: agent/chat-agent/CLAUDE.md (50h), lib/wiki-access.js (13h)"), f);
  assert.ok(!f.includes("spam-blocklist") && !f.includes("new-thing") && !f.includes("already-committed"));
});

test("unreadable processes: exit 5 (watchdog neither pages nor clears)", async () => {
  assert.equal(await m.main([], harness({ psNull: true }).io, ROOT), 5);
});

test("watchdog.sh runs it after the supervisor reload and pages only through its incident dedup", () => {
  const src = fs.readFileSync(path.join(REPO, "agent/scripts/watchdog.sh"), "utf8");
  const i = src.indexOf('bin/stale-code-watch"');
  assert.ok(i > src.indexOf('bin/supervisor-code-reload"'), "stale-code-watch must run after supervisor-code-reload");
  const block = src.slice(i, i + 700);
  assert.ok(block.includes('incident_should_alert "stale-code-flag"') && block.includes('incident_clear "stale-code-flag"'));
  assert.ok(src.includes(".stale-code-watch-off"));
});

test("watchdog.sh block: 6 pages the state file's text once, 0 clears, 5 does neither", async () => {
  const { execFileSync } = await import("node:child_process");
  const src = fs.readFileSync(path.join(REPO, "agent/scripts/watchdog.sh"), "utf8");
  const from = src.indexOf('if [ ! -f "$HOME/Dev/jori/data/.stale-code-watch-off" ]');
  let depth = 0, end = from;
  for (const line of src.slice(from).split("\n")) {     // to the matching top-level fi
    end += line.length + 1;
    if (/^\s*if /.test(line)) depth++;                   // lang-regex-ok: shell keywords in a script
    if (/^\s*fi\s*$/.test(line) && --depth === 0) break; // lang-regex-ok: shell keywords in a script
  }
  const block = src.slice(from, end);
  const run = (rc, alert = true) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "scw-wd-"));
    fs.mkdirSync(path.join(home, "bin"));
    fs.mkdirSync(path.join(home, "Dev/jori/data"), { recursive: true });
    fs.writeFileSync(path.join(home, "Dev/jori/data/stale-code-watch-state.json"), JSON.stringify({ _flag: "⚠️ X\n• y" }));
    fs.writeFileSync(path.join(home, "bin/node"), `#!/bin/bash\nexit ${rc}\n`);
    fs.chmodSync(path.join(home, "bin/node"), 0o755);
    const out = path.join(home, "out");
    const script = [`LOG=/dev/null`, `incident_seen() { echo "seen $1" >> ${out}; }`, `incident_should_alert() { return ${alert ? 0 : 1}; }`,
      `incident_clear() { echo "clear $1" >> ${out}; }`, `notify() { printf 'notify %s\\n' "$1" >> ${out}; }`, block].join("\n");
    execFileSync("bash", ["-c", script], { env: { PATH: `${home}/bin:/usr/bin:/bin:/opt/homebrew/bin`, HOME: home } });
    return fs.existsSync(out) ? fs.readFileSync(out, "utf8").trim() : "";
  };
  assert.equal(run(6), "seen stale-code-flag\nnotify ⚠️ X\n• y");
  assert.equal(run(6, false), "seen stale-code-flag");
  assert.equal(run(0), "clear stale-code-flag");
  assert.equal(run(5), "");
});

// Regression guard for the "✅ Recovered: stale-code-flag ... auto-healed" line:
// nothing automatic clears this flag (it goes when someone restarts a daemon or
// commits a file), so incident_clear must report what it observed, never
// "auto-healed" and never a restart (a commit clears it too).
test("watchdog.sh incident_clear: the stale-code-flag recovery says what it saw, once, never 'auto-healed'", async () => {
  const { execFileSync } = await import("node:child_process");
  const src = fs.readFileSync(path.join(REPO, "agent/scripts/watchdog.sh"), "utf8");
  const fn = (name) => {
    const from = src.indexOf(`\n${name}() {`);
    assert.notEqual(from, -1, `${name} is defined in watchdog.sh`);
    return src.slice(from + 1, src.indexOf("\n}\n", from) + 3);
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scw-clear-"));
  const dir = path.join(home, "incidents");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "stale-code-flag.alerted"), "");
  fs.writeFileSync(path.join(dir, "stale-code-flag.delivered"), "");
  const out = path.join(home, "out");
  const script = [`INCIDENT_DIR=${JSON.stringify(dir)}`, `log() { :; }`, `notify() { printf '%s\\n' "$1" >> ${JSON.stringify(out)}; }`,
    fn("_incident_label"), fn("_disk_gib_threshold"), fn("incident_clear"),
    `incident_clear stale-code-flag`, `incident_clear stale-code-flag`, `incident_clear stale-code-flag`, `incident_clear stale-code-flag`].join("\n");
  execFileSync("bash", ["-c", script], { env: { PATH: "/usr/bin:/bin", HOME: home } });
  const lines = fs.readFileSync(out, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `one recovery line after 3 green ticks, none after: ${JSON.stringify(lines)}`);
  assert.ok(lines[0].startsWith("✅ Recovered: ") && lines[0].endsWith(", stable for 3 checks."), lines[0]);
  assert.ok(lines[0].includes("stale-code-watch no longer flags any daemon or uncommitted code file"), lines[0]);
  assert.ok(!lines[0].includes("auto-healed"), lines[0]);
  assert.ok(!lines[0].toLowerCase().includes("restart"), lines[0]);
  assert.ok(!fs.existsSync(path.join(dir, "stale-code-flag.alerted")), "the incident is closed after the recovery");
  fs.rmSync(home, { recursive: true, force: true });
});

test("--dry-run reports every daemon every time, up to date or not, and writes no state", async () => {
  const said = [];
  const h = harness();
  let writes = 0;
  h.io.say = (s) => said.push(s);
  h.io.writeState = () => { writes++; };
  assert.equal(await m.main(["--dry-run"], h.io, ROOT), 0);
  assert.deepEqual(h.calls, []);
  for (const t of [...m.SMALL]) assert.ok(said.some((s) => s.startsWith(`${t.name}: `)), `${t.name} reported: ${said.join(" / ")}`);
  assert.ok(said.some((s) => / up to date \(pid \d+\)$/.test(s))); // lang-regex-ok: the tool's own output line
  assert.ok(said.includes("no flag: nothing to page about"));
  assert.equal(writes, 0, "a dry run writes no state");
  // a second dry run says it all again (no once-per-hold silence)
  const again = [];
  h.io.say = (s) => again.push(s);
  await m.main(["--dry-run"], h.io, ROOT);
  assert.equal(again.length, said.length);
});
