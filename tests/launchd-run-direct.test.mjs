// launchd-run-direct.mjs: a host without launchd runs an on-demand agent's
// program straight from cron, the way launchd would, one copy at a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePlist, runDirect } from "../agent/scripts/lib/launchd-run-direct.mjs";

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <!-- <key>ProgramArguments</key> in a comment is ignored -->
    <key>Label</key>
    <string>ai.claude.example</string>
    <key>ProgramArguments</key>
    <array>
        <string>/srv/jori/bin/cron-run</string>
        <string>--label</string>
        <string>example</string>
        <string>--</string>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>/srv/jori/bin/example-run &gt;&gt; /srv/jori/logs/example.log 2&gt;&amp;1</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/home/u</string>
        <key>PATH</key>
        <string>/usr/bin:/bin</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>/srv/jori</string>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>LOGFILE</string>
    <key>StandardErrorPath</key>
    <string>LOGFILE</string>
</dict>
</plist>`;

test("parses ProgramArguments, environment, working directory and logs", () => {
  const p = parsePlist(PLIST);
  assert.deepEqual(p.args, ["/srv/jori/bin/cron-run", "--label", "example", "--", "/bin/bash", "-c", "/srv/jori/bin/example-run >> /srv/jori/logs/example.log 2>&1"]);
  assert.deepEqual(p.env, { HOME: "/home/u", PATH: "/usr/bin:/bin" });
  assert.equal(p.cwd, "/srv/jori");
  assert.equal(p.stdout, "LOGFILE");
});

test("starts the program detached with the plist's environment, and only once while it runs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lrd-"));
  const log = path.join(dir, "logs", "x.log");
  const plist = parsePlist(PLIST.replaceAll("LOGFILE", log));
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid: process.pid, unref() {} }; };
  assert.equal(runDirect(plist, { label: "ai.claude.example", locksDir: dir, spawnFn: fakeSpawn, env: { X: "1" } }), "started");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "/srv/jori/bin/cron-run");
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.env.X, "1");
  assert.equal(calls[0].opts.env.HOME, "/home/u");
  assert.ok(fs.existsSync(log), "the log file is created");
  // The recorded pid (this test process) is alive: a second kick is a no-op.
  assert.equal(runDirect(plist, { label: "ai.claude.example", locksDir: dir, spawnFn: fakeSpawn }), "running");
  assert.equal(calls.length, 1);
  // A dead pid does not block the next run.
  fs.writeFileSync(path.join(dir, "ai.claude.example.pid"), "999999999\n");
  assert.equal(runDirect(plist, { label: "ai.claude.example", locksDir: dir, spawnFn: fakeSpawn }), "started");
});

test("a plist without a program is an error", () => {
  assert.throws(() => runDirect(parsePlist("<plist><dict></dict></plist>"), { label: "x", locksDir: os.tmpdir() }), /no ProgramArguments/);
});
