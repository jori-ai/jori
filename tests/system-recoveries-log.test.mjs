// system-recoveries-log.test.mjs — ✅ recovery lines stay out of the System tab.
//
// The System tab carries only what the user can act on. A line that says a
// condition cleared by itself (a recovery, a reconnect, a drained queue) is
// not something to act on, so jori-send-curl does not insert it into
// jori_messages: it appends it to data/system-recoveries.jsonl, with
// no push. system-issue-review merges that log back into its batch, because a
// recovery is still evidence for the root-cause pass.
//
// Pinned here:
//   1. A ✅ system line is logged and never inserted; warnings, criticals,
//      other channels and a ✅ the caller marks --push all post as before.
//   2. A log that cannot be written falls back to posting.
//   3. A test run never touches the real log.
//   4. mergeRecoveryLog joins the log to the channel rows in time order and
//      drops old and malformed lines without throwing.
//
// Run: node --test tests/system-recoveries-log.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mergeRecoveryLog } from "../lib/system-issue-gate.mjs";

const KERNEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { underTestRunner } = require("../lib/load-env.js");
const { KERNEL_SUBDIR } = require("../lib/root.cjs");
const SEND_CURL = path.join(KERNEL, "bin/jori-send-curl");
const KEY = "SUPABASE_SERVICE_ROLE_KEY";

// A throwaway installation with a stand-in key and a fake curl that records
// every call, so an insert shows up as a recorded call and nothing reaches the
// network. Same shape as test-run-send-guard.test.mjs.
function sandbox() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "recoveries-log-"));
  fs.mkdirSync(path.join(h, KERNEL_SUBDIR, "data"), { recursive: true });
  fs.writeFileSync(path.join(h, KERNEL_SUBDIR, ".env"), `${KEY}=fake\n`);
  const fakeBin = path.join(h, "fakebin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "curl"), `#!/bin/sh\necho "$@" >> "$CURL_RECORD"\nprintf '%s' "\${FAKE_HTTP:-201}"\n`);
  fs.chmodSync(path.join(fakeBin, "curl"), 0o755);
  const record = path.join(h, "curl.txt");
  const log = path.join(h, "recoveries.jsonl");
  const run = (args, extra = {}) => {
    const env = { ...process.env, HOME: h, JORI_HOME: h, PATH: `${fakeBin}:${process.env.PATH}`, CURL_RECORD: record,
      JORI_SEND_TEST_CURL: path.join(fakeBin, "curl"), JORI_SYSTEM_RECOVERY_LOG: log, [KEY]: "fake", ...extra };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
    return spawnSync(SEND_CURL, args, { encoding: "utf8", timeout: 20_000, env });
  };
  const calls = () => { try { return fs.readFileSync(record, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const rows = () => { try { return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { h, log, run, calls, rows };
}

// The sender's test-run stand-in keys on NODE_TEST_CONTEXT, which only
// node --test's default process isolation sets.
const needsRunner = { skip: !underTestRunner() && "run under node --test with its default process isolation (NODE_TEST_CONTEXT is unset)" };

const RECOVERY = "✅ Recovered: Gmail push / unread delivery is back to normal — auto-healed, stable for 3 checks.";

test("a ✅ system line is logged, not inserted, and pushes nothing", needsRunner, () => {
  const box = sandbox();
  const r = box.run(["--channel", "system", "--skip-precheck", "--intent", "watchdog-alert", RECOVERY]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(box.calls(), [], "the recovery was inserted into jori_messages, so it shows in the System tab");
  const rows = box.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, RECOVERY);
  assert.equal(rows[0].role, "assistant");
  assert.equal(rows[0].channel, "system");
  assert.equal(rows[0].intent, "watchdog-alert");
  assert.ok(Number.isFinite(Date.parse(rows[0].created_at)));
});

test("leading whitespace before the ✅ does not get a recovery into the tab", needsRunner, () => {
  const box = sandbox();
  const r = box.run(["--channel", "system", "--skip-precheck", "  ✅ Slack channel reconnected."]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(box.calls(), []);
  assert.equal(box.rows().length, 1);
});

test("warnings and criticals still post to the System tab", needsRunner, () => {
  for (const msg of ["⚠️ Chat queue backlog: 10 tasks queued.", "🔴 Cloudflare Tunnel is down and didn't recover."]) {
    const box = sandbox();
    const r = box.run(["--channel", "system", "--skip-precheck", msg]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(box.calls().length, 1, `not posted: ${msg}`);
    assert.deepEqual(box.rows(), [], "a non-recovery line was written to the recovery log");
  }
});

test("a ✅ the caller marks --push still posts", needsRunner, () => {
  const box = sandbox();
  const r = box.run(["--channel", "system", "--skip-precheck", "--push", "✅ Done — the sign-in you asked for is back."]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(box.calls().length, 1);
  assert.deepEqual(box.rows(), []);
});

test("a ✅ sent with --keep-in-tab posts silently and is not logged", needsRunner, () => {
  const box = sandbox();
  const r = box.run(["--channel", "system", "--skip-precheck", "--keep-in-tab", "✅ The sign-in outage made the nightly review miss its run, so I started it again just now."]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(box.calls().length, 1, "a ✅ the sender asked to keep in the tab was not posted");
  assert.deepEqual(box.rows(), []);
});

// Two ✅ lines are not self-heals: the after-outage re-run line (the user asked
// to be told in one line what ran) and a shadow path's "now live" note with its
// rollback. Their senders must keep asking for the tab.
test("the re-run line and the go-live note keep their place in the tab", () => {
  const watchdog = fs.readFileSync(path.join(KERNEL, "agent/scripts/watchdog.sh"), "utf8");
  const send = watchdog.split("\n").find((l) => l.includes('"$_auth_replay_line"') && l.includes("$SEND"));
  assert.ok(send, "watchdog.sh no longer posts the after-outage re-run line");
  assert.ok(send.includes("--keep-in-tab"), "the after-outage re-run line would be hidden from the System tab");
  const cutover = path.join(KERNEL, "bin/shadow-cutover-check");
  if (fs.existsSync(cutover)) {
    assert.ok(fs.readFileSync(cutover, "utf8").includes('"--keep-in-tab"'), "the go-live note would be hidden from the System tab");
  }
});

test("a ✅ on another channel is not touched", needsRunner, () => {
  const box = sandbox();
  const r = box.run(["--channel", "improvements", "--skip-precheck", "✅ Landed: a fix you approved."]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(box.calls().length, 1);
  assert.deepEqual(box.rows(), []);
});

test("a log that cannot be written falls back to posting", needsRunner, () => {
  const box = sandbox();
  const blocker = path.join(box.h, "not-a-dir");
  fs.writeFileSync(blocker, "");
  const r = box.run(["--channel", "system", "--skip-precheck", RECOVERY], { JORI_SYSTEM_RECOVERY_LOG: path.join(blocker, "x.jsonl") });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(box.calls().length, 1, "the recovery was lost: neither logged nor posted");
  assert.match(r.stderr, /could not write/); // lang-regex-ok: the tool's own fixed fallback notice, not a person's words
});

test("a test run with no log named touches neither the real log nor the channel", needsRunner, () => {
  const box = sandbox();
  const r = box.run(["--channel", "system", "--skip-precheck", RECOVERY], { JORI_SYSTEM_RECOVERY_LOG: undefined });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(box.calls(), []);
  assert.ok(!fs.existsSync(path.join(box.h, KERNEL_SUBDIR, "data", "system-recoveries.jsonl")), "a test run wrote the installation's recovery log");
});

test("--capture-id records that the line was kept out of the channel", needsRunner, () => {
  const box = sandbox();
  const idFile = path.join(box.h, "id.txt");
  const r = box.run(["--channel", "system", "--skip-precheck", "--capture-id", idFile, RECOVERY]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(idFile, "utf8")), { suppressed: true, by: "system-recoveries-log" });
});

test("mergeRecoveryLog joins the log to the channel rows in time order", () => {
  const rows = [
    { id: "a", role: "assistant", content: "🔴 Tunnel down", created_at: "2026-10-15T20:10:00.123+00:00" },
    { id: "b", role: "assistant", content: "⚠️ later warning", created_at: "2026-10-15T21:00:00+00:00" },
  ];
  const log = [
    JSON.stringify({ created_at: "2026-10-15T20:16:00Z", role: "assistant", content: "✅ Recovered: tunnel", channel: "system" }),
    "{not json",
    "",
    JSON.stringify({ created_at: "2026-09-01T00:00:00Z", role: "assistant", content: "✅ too old", channel: "system" }),
    JSON.stringify({ created_at: "2026-10-15T20:30:00Z", content: 42 }),
  ].join("\n");
  const out = mergeRecoveryLog(rows, log, "2026-10-14T00:00:00Z");
  assert.deepEqual(out.map((r) => r.content), ["🔴 Tunnel down", "✅ Recovered: tunnel", "⚠️ later warning"]);
  assert.equal(out[1].role, "assistant");
  assert.ok(String(out[1].id).startsWith("recovery-log:"));
});

test("mergeRecoveryLog with no log, or no rows, never throws", () => {
  const rows = [{ id: "a", role: "assistant", content: "⚠️ x", created_at: "2026-10-15T20:10:00Z" }];
  assert.deepEqual(mergeRecoveryLog(rows, "", "2026-10-14T00:00:00Z"), rows);
  assert.deepEqual(mergeRecoveryLog(rows, undefined, "2026-10-14T00:00:00Z"), rows);
  assert.deepEqual(mergeRecoveryLog(null, null, "2026-10-14T00:00:00Z"), []);
});
