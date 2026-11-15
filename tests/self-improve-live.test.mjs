// lib/self-improve-live.mjs — an approved card is `applied` only once it runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { goLive, pluginsTouched, testEnv, tapFailures, defaultRunTests } from "../lib/self-improve-live.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "si-live-"));
fs.mkdirSync(path.join(root, "plugins/shows-seen/tests"), { recursive: true });
fs.writeFileSync(path.join(root, "plugins/shows-seen/tests/a.test.mjs"), "");

// A plugin world the poller would see: shows-seen is new (not in the state),
// so it follows its manifest default (off) until something turns it on.
function world({ state = {}, enableThrows = null, crontabLeft = [], production = true } = {}) {
  const calls = [];
  let on = Object.prototype.hasOwnProperty.call(state, "shows-seen") ? state["shows-seen"] : false;
  const plugin = { name: "shows-seen", errors: [], manifest: { schedules: [{}, {}] } };
  const P = {
    plugin: (n) => (n === "shows-seen" ? plugin : null),
    state: () => ({ enabled: state }),
    isEnabled: () => on,
    schedulesOf: (p) => p.manifest.schedules,
  };
  const M = {
    enable: (n) => { calls.push(`enable ${n}`); if (enableThrows) throw new Error(enableThrows); on = true; },
    sync: () => { calls.push("sync"); },
    syncAllowedHere: () => production,
    planCrontab: () => crontabLeft,
    planLaunchd: () => [],
  };
  return { P, M, calls };
}
const pass = async () => ({ ok: true });

test("pluginsTouched reads kernel and local plugin paths", () => {
  assert.deepEqual(pluginsTouched(["plugins/shows-seen/plugin.json", "agent/local/plugins/x-y/bin/a", "lib/a.mjs", "plugins/shows-seen/lib/b.js"]), ["shows-seen", "x-y"]);
});

test("a new plugin is turned on, scheduled and its tests run → live", async () => {
  const { P, M, calls } = world();
  const r = await goLive(["plugins/shows-seen/plugin.json", "plugins/shows-seen/tests/a.test.mjs"], { root, plugins: P, manager: M, runTests: pass });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ["enable shows-seen"]);
  assert.match(r.notes.join(" "), /on and its 2 schedules are installed/);
  assert.match(r.notes.join(" "), /tests pass/);
});

test("the 2026-11-15 case: schedules never reached the crontab → not live", async () => {
  const { P, M } = world({ crontabLeft: [{ op: "add", plugin: "shows-seen", label: "shows-seen" }, { op: "remove", plugin: "other", label: "x" }] });
  const r = await goLive(["plugins/shows-seen/plugin.json"], { root, plugins: P, manager: M, runTests: pass });
  assert.equal(r.ok, false);
  assert.match(r.error, /on but not scheduled: shows-seen/);
});

test("crontab install fails while turning it on → not live, with the reason", async () => {
  const { P, M } = world({ enableThrows: "crontab-safe: crontab not changed: crontab install exited 142" });
  const r = await goLive(["plugins/shows-seen/plugin.json"], { root, plugins: P, manager: M, runTests: pass });
  assert.equal(r.ok, false);
  assert.match(r.error, /exited 142/);
});

test("a plugin the owner turned off stays off and is not a failure", async () => {
  const { P, M, calls } = world({ state: { "shows-seen": false } });
  const r = await goLive(["plugins/shows-seen/lib/b.js"], { root, plugins: P, manager: M, runTests: pass });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, []);
  assert.match(r.notes[0], /off because you turned it off/);
});

test("an already-on plugin is re-synced, not re-enabled", async () => {
  const { P, M, calls } = world({ state: { "shows-seen": true } });
  const r = await goLive(["plugins/shows-seen/lib/b.js"], { root, plugins: P, manager: M, runTests: pass });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ["sync"]);
});

test("failing shipped tests → not live, naming the failures", async () => {
  const r = await goLive(["plugins/shows-seen/tests/a.test.mjs", "plugins/shows-seen/tests/missing.test.mjs"], {
    root, plugins: world().P, manager: world().M,
    runTests: async (files) => { assert.deepEqual(files, ["plugins/shows-seen/tests/a.test.mjs"]); return { ok: false, failed: ["restaurants dedupe"] }; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /tests fail: restaurants dedupe/);
});

test("a card with no plugin and no tests is live as written", async () => {
  const r = await goLive(["agent/ops-agent/email-triage-rules.md"], { root, runTests: () => assert.fail("no tests to run") });
  assert.deepEqual(r, { ok: true, notes: [] });
});

test("off the production host the state is saved and that is not a failure", async () => {
  const { P, M } = world({ production: false, crontabLeft: [{ op: "add", plugin: "shows-seen", label: "shows-seen" }] });
  const r = await goLive(["plugins/shows-seen/plugin.json"], { root, plugins: P, manager: M, runTests: pass });
  assert.equal(r.ok, true);
  assert.match(r.notes[0], /installed by the production host/);
});

test("the 2026-11-15 retry loop: shipped tests run with this node on PATH, as in a shell", () => {
  const env = testEnv({ PATH: "/usr/bin:/bin", HOME: "/h" }, "/opt/node/bin/node");
  assert.equal(env.PATH, "/opt/node/bin:/usr/bin:/bin");
  assert.equal(env.HOME, "/h");
  assert.equal(testEnv({ PATH: "/opt/node/bin:/x" }, "/opt/node/bin/node").PATH, "/opt/node/bin:/x", "not doubled");
  assert.equal(testEnv({}, "/n/bin/node").PATH, "/n/bin:/usr/bin:/bin");
});

test("a test that spawns a `#!/usr/bin/env node` script passes under cron's PATH", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "si-live-run-"));
  fs.mkdirSync(path.join(dir, "bin")); fs.mkdirSync(path.join(dir, "tests"));
  fs.writeFileSync(path.join(dir, "bin/hello"), "#!/usr/bin/env node\nprocess.stdout.write('hi');\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "tests/spawn.test.mjs"), [
    'import { test } from "node:test"; import assert from "node:assert/strict";',
    'import { execFileSync } from "node:child_process"; import path from "node:path";',
    'test("spawns our script", () => assert.equal(String(execFileSync(path.resolve("bin/hello"))), "hi"));',
    'test("a real failure", () => assert.equal(1, 2));',
  ].join("\n"));
  const saved = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin"; // cron's
  try {
    const r = await defaultRunTests(["tests/spawn.test.mjs"], dir);
    assert.equal(r.ok, false);
    assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
    assert.match(r.failed[0], /^a real failure \(Expected values to be strictly equal/);
  } finally { process.env.PATH = saved; }
});

test("tapFailures names each failing test with the first line of its error", () => {
  const out = [
    "not ok 1 - a tapped decision answers in code",
    "  ---", "  type: 'test'", "  error: |-", "    Expected values to be strictly equal:", "    ", "    false !== true", "  ...",
    "ok 2 - fine",
    "    not ok 1 - nested one", "      ---", "      error: 'boom'", "      ...",
  ].join("\n");
  assert.deepEqual(tapFailures(out), ["a tapped decision answers in code (Expected values to be strictly equal:)", "nested one (boom)"]);
  assert.deepEqual(tapFailures(""), []);
});
