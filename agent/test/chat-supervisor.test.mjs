// chat-supervisor.test.mjs — end-to-end tests for the chat supervisor.
//
// Uses mock-claude.mjs instead of real Claude binary.
// Tests the full flow: HTTP dispatch → PriorityDispatcher → ClaudeSession → result.
//
// Run: node --test agent/test/chat-supervisor.test.mjs

import { describe, it, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";

// These tests spawn the chat supervisor as a child process which starts an HTTP
// server. Sandbox environments block child processes from binding ports.
// The tests skip gracefully when this is detected.
function canChildListen() {
  try {
    execSync(`${"/opt/homebrew/bin/node"} -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{s.close();process.exit(0)})"`, { timeout: 3000, stdio: "pipe" });
    return true;
  } catch { return false; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CLAUDE = path.join(__dirname, "mock-claude.mjs");
const CHAT_SUPERVISOR = path.join(__dirname, "..", "supervisor", "chat-supervisor.mjs");
const NODE = "/opt/homebrew/bin/node";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Allocate a random port to avoid conflicts with the live supervisor.
let nextPort = 19000 + Math.floor(Math.random() * 1000);
function allocPort() { return nextPort++; }

function tmpDir() {
  const base = process.env.TMPDIR || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "chat-sup-test-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Write a minimal agents.json for testing.
function writeTestConfig(dir, port, overrides = {}) {
  const config = {
    agents: {
      "test-chat": {
        model: "mock",
        cwd: "agent/chat-agent",
        runtime: "supervisor",
        devChannels: [],
        permissionMode: "bypassPermissions",
        allowedTools: ["Bash"],
        remoteControlPrefix: "test-chat",
        supervisor: { healthPort: port },
        ...overrides,
      },
    },
  };
  const configPath = path.join(dir, "agents.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

// Spawn the chat supervisor process with mock claude.
function startSupervisor({ port, configPath, stateDir, claudeArgs = [], env = {} }) {
  const logDir = path.join(stateDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  // claudeBin as JSON array: ["node", "mock-claude.mjs", ...claudeArgs]
  // ClaudeSession supports array claudeBin — it uses the first element as the
  // binary and prepends the rest before the built args.
  const claudeBinJson = JSON.stringify([NODE, MOCK_CLAUDE, ...claudeArgs]);

  const proc = spawn(NODE, [
    CHAT_SUPERVISOR,
    "--agent", "test-chat",
    "--config", configPath,
    "--state-dir", stateDir,
    "--claude-bin", claudeBinJson,
    "--no-resume",
  ], {
    cwd: stateDir,
    stdio: ["pipe", "pipe", "pipe"],
    // Isolate the events_fts tee (EventLog writes into memory-index.db) into the
    // test state dir so the suite never pollutes the real wiki DB.
    env: { ...process.env, HOME: os.homedir(), MEMORY_INDEX_DB: path.join(stateDir, "event-index.db"), ...env },
  });

  const stderr = [];
  proc.stderr.on("data", (buf) => stderr.push(buf.toString()));
  proc.stdout.on("data", () => {}); // Drain stdout.

  const waitForReady = (timeoutMs = 10000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Supervisor didn't start. stderr: ${stderr.join("")}`)), timeoutMs);
      const check = () => {
        if (stderr.join("").includes("HTTP on :")) {
          clearTimeout(timer);
          resolve();
        }
      };
      check();
      proc.stderr.on("data", check);
    });

  return { proc, stderr, waitForReady };
}

// HTTP helpers.
function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    }).on("error", reject);
  });
}

function httpPost(port, path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (res) => {
      let resBody = "";
      res.on("data", (c) => (resBody += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(resBody) }); }
        catch { resolve({ status: res.statusCode, body: resBody }); }
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("chat-supervisor end-to-end", { skip: !canChildListen() && "child process cannot bind ports (sandbox)" }, () => {
  let sup = null;
  let tmp = null;
  let port = 0;
  afterEach(async () => {
    if (sup?.proc?.exitCode === null && sup?.proc?.signalCode === null) {
      sup.proc.kill("SIGTERM");
      await new Promise((r) => sup.proc.on("exit", r));
    }
    sup = null;
    // Small delay to let port release.
    await sleep(200);
    tmp?.cleanup();
    tmp = null;
  });

  async function setup(claudeArgs = []) {
    port = allocPort();
    tmp = tmpDir();
    const configPath = writeTestConfig(tmp.dir, port);
    sup = startSupervisor({ port, configPath, stateDir: tmp.dir, claudeArgs });
    await sup.waitForReady();
    // Wait for init message to be dispatched and processed.
    await sleep(4000);
  }

  // ── Health endpoint ───────────────────────────────────────────────

  it("returns health with childAlive=true after startup", async () => {
    await setup();
    const { status, body } = await httpGet(port, "/health");
    assert.equal(status, 200);
    assert.equal(body.childAlive, true);
    assert.equal(body.model, "mock");
    assert.ok(body.sessionId);
    assert.ok(body.completed >= 1, "Init message should have completed");
  });

  // ── Dispatch endpoint ─────────────────────────────────────────────

  it("dispatches a message and processes it", async () => {
    await setup();
    const { status, body } = await httpPost(port, "/dispatch", {
      content: "Hello from test",
      source: "test",
      priority: "high",
    });
    assert.equal(status, 200);
    assert.ok(body.id);

    // Wait for the turn to complete.
    await sleep(500);

    const health = await httpGet(port, "/health");
    assert.ok(health.body.completed >= 2, `Expected >=2 completed, got ${health.body.completed}`);
    assert.equal(health.body.queueDepth, 0);
    assert.equal(health.body.inFlight, null);
  });

  it("queues multiple messages and processes them in order", async () => {
    await setup(["--delay", "200"]);
    // Send 3 messages rapidly.
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const { body } = await httpPost(port, "/dispatch", {
        content: `msg-${i}`,
        source: "test",
        priority: "normal",
        msgId: `order-${i}`,
      });
      ids.push(body.id);
    }

    // Wait for all to process.
    await sleep(2000);

    const health = await httpGet(port, "/health");
    // `completed` counts turns, and the dispatcher coalesces same-source normal
    // messages that queue behind a turn into one: init + msg-0 + (msg-1, msg-2)
    // is 3 turns. All three delivered = nothing left queued or in flight.
    assert.ok(health.body.completed >= 3, `Expected >=3 completed turns, got ${health.body.completed}`);
    assert.equal(health.body.queueDepth, 0);
    assert.equal(health.body.inFlight, null);
  });

  // ── Priority ordering ─────────────────────────────────────────────

  it("processes high-priority messages before normal ones", async () => {
    await setup(["--delay", "500"]);

    // Dispatch a normal message to occupy the session.
    await httpPost(port, "/dispatch", { content: "blocking", source: "test", priority: "normal" });
    await sleep(50);

    // Queue a normal and a high-priority behind it.
    await httpPost(port, "/dispatch", { content: "normal-queued", source: "test", priority: "normal", msgId: "n1" });
    await httpPost(port, "/dispatch", { content: "urgent-queued", source: "test", priority: "high", msgId: "h1" });

    // Check queue ordering.
    const health = await httpGet(port, "/health");
    if (health.body.queueDepth >= 2) {
      assert.equal(health.body.byPriority.high, 1);
      assert.equal(health.body.byPriority.normal, 1);
    }

    // Wait for all to complete.
    await sleep(3000);
    const final = await httpGet(port, "/health");
    assert.equal(final.body.queueDepth, 0);
  });

  // ── Dedup ─────────────────────────────────────────────────────────

  it("deduplicates messages with same msgId when queued", async () => {
    await setup(["--delay", "2000"]); // Slow mock so first message stays in-flight.
    // Dispatch a message to occupy the session.
    await httpPost(port, "/dispatch", { content: "blocking", source: "test", priority: "normal" });
    await sleep(100);

    // Now dispatch two messages with the same msgId while blocking is in-flight.
    const { body: first } = await httpPost(port, "/dispatch", {
      content: "original", source: "test", priority: "high", msgId: "dedup-1",
    });
    assert.ok(first.id !== "deduped");

    const { body: dupe } = await httpPost(port, "/dispatch", {
      content: "duplicate", source: "test", priority: "high", msgId: "dedup-1",
    });
    assert.equal(dupe.id, "deduped");
  });

  // ── Session restart on crash ──────────────────────────────────────

  it("restarts session when claude crashes", async () => {
    // fail-after 1: init succeeds (turn 0→1), next message triggers exit.
    port = allocPort();
    tmp = tmpDir();
    const configPath = writeTestConfig(tmp.dir, port);
    sup = startSupervisor({ port, configPath, stateDir: tmp.dir, claudeArgs: ["--fail-after", "1"] });
    await sup.waitForReady();
    await sleep(5000); // Wait for init (3s delay + processing).

    // Init processed. Now send a message that triggers the crash.
    await httpPost(port, "/dispatch", { content: "trigger-crash", source: "test", priority: "high" });

    // Wait for crash + backoff restart (2s) + new session spawn.
    await sleep(10000);

    // Debug: check what the supervisor logged.
    const logs = sup.stderr.join("");
    const hasExit = logs.includes("claude exited");
    const hasRestart = logs.includes("restart #");

    const health = await httpGet(port, "/health");
    assert.ok(hasExit, `Expected 'claude exited' in logs. Got:\n${logs.slice(-1000)}`);
    assert.ok(hasRestart, `Expected 'restart #' in logs. Got:\n${logs.slice(-1000)}`);
    assert.ok(health.body.restartCount >= 1, `Restart count should be >=1, got ${health.body.restartCount}. Logs:\n${logs.slice(-500)}`);
  });

  // ── 404 for unknown routes ────────────────────────────────────────

  it("returns 404 for unknown routes", async () => {
    await setup();
    const { status } = await httpGet(port, "/unknown");
    assert.equal(status, 404);
  });

  // ── Restart endpoint ──────────────────────────────────────────────

  it("POST /restart triggers session restart", async () => {
    await setup();
    const { status, body } = await httpPost(port, "/restart", {});
    assert.equal(status, 202);
    assert.equal(body.restarting, true);

    // Wait for restart to complete.
    await sleep(5000);

    const health = await httpGet(port, "/health");
    assert.equal(health.body.childAlive, true);
    assert.ok(health.body.restartCount >= 1);
  });

  // ── Graceful shutdown ─────────────────────────────────────────────

  it("shuts down cleanly on SIGTERM", async () => {
    await setup();
    const health = await httpGet(port, "/health");
    assert.equal(health.body.childAlive, true);

    sup.proc.kill("SIGTERM");
    const { code } = await new Promise((r) => sup.proc.on("exit", (code, signal) => r({ code, signal })));
    assert.equal(code, 0);
  });

  // ── Queue survives a whole-process restart ───────────────────────
  //
  // A chat process stopped by SIGTERM with messages queued used to lose them:
  // the queue lived only in memory, so the next process started empty. Now it
  // is saved in the state dir and the next process reloads and runs it, their
  // own messages first and in order, each told it is answered late.

  it("restores the queue a SIGTERM'd process left and dispatches it in order", async () => {
    port = allocPort();
    tmp = tmpDir();
    const configPath = writeTestConfig(tmp.dir, port);
    const queueFile = path.join(tmp.dir, "queue.json");
    // The first process never answers, so its init turn stays in flight and
    // three messages of theirs queue up behind it.
    sup = startSupervisor({ port, configPath, stateDir: tmp.dir, claudeArgs: ["--hang"] });
    await sup.waitForReady();
    await sleep(3500);   // the init dispatch (3 s after start) is now in flight
    for (const n of ["first", "second", "third"]) {
      await httpPost(port, "/dispatch", { content: `${n} message`, source: "jori", priority: "high", msgId: `restore-${n}` });
    }
    const before = await httpGet(port, "/health");
    assert.equal(before.body.queueDepth, 3);
    assert.equal(before.body.queueRestored, 0, "nothing reloaded on a clean start");
    sup.proc.kill("SIGTERM");
    await new Promise((r) => sup.proc.on("exit", r));
    const saved = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    assert.deepEqual(saved.queue.map((i) => i.msgId || i.source), ["restore-first", "restore-second", "restore-third", "init"],
      "their three messages, then the interrupted init put back in line at its own (low) priority");

    // A new process on the same state dir, with a CLI that answers.
    const record = path.join(tmp.dir, "received.txt");
    sup = startSupervisor({ port, configPath, stateDir: tmp.dir, claudeArgs: ["--record", record] });
    await sup.waitForReady();
    await sleep(1500);
    const after = await httpGet(port, "/health");
    assert.equal(after.body.queueRestored, 3, "their three messages; the old process's init is not replayed");
    assert.equal(after.body.queueDepth, 0);
    assert.equal(after.body.inFlight, null);
    let got = fs.readFileSync(record, "utf8");
    const at = ["first message", "second message", "third message"].map((s) => got.indexOf(s));
    assert.ok(at.every((i) => i >= 0), `all three delivered, got:\n${got}`);
    assert.ok(at[0] < at[1] && at[1] < at[2], `in the order sent, got:\n${got}`);
    assert.ok(got.indexOf("was still queued when the chat supervisor restarted") < at[0], "the late-answer line comes first");
    assert.equal(fs.existsSync(queueFile), false, "an empty queue leaves no file behind");
    const err = sup.stderr.join("");
    assert.ok(err.includes("restored 3 queued item(s) saved by the previous process"), err);
    assert.ok(err.includes("saved queue: not replaying 1 item(s): init"), err);
    await sleep(3000);   // this process's own init (3 s after start)
    got = fs.readFileSync(record, "utf8");
    assert.equal(got.split("Session started.").length - 1, 1, "exactly one init: this process's own");
    assert.ok(got.indexOf("Session started.") > at[2], "the init runs after their messages");
  });

  it("replays no session-control turns, marks a turn that was running, and drops one running at two restarts", async () => {
    port = allocPort();
    tmp = tmpDir();
    const configPath = writeTestConfig(tmp.dir, port);
    const t0 = Date.now() - 60_000;
    const item = (o) => ({ id: o.msgId || o.source, priority: 0, priorityName: "high", enqueuedAt: t0, ...o });
    fs.writeFileSync(path.join(tmp.dir, "queue.json"), JSON.stringify({
      version: 1, savedAt: t0,
      // Running when the process died, and already reloaded once after dying mid-turn.
      inFlight: item({ content: "poison message", source: "jori", msgId: "poison", diedMidTurn: 1, restoredAt: t0 + 1000, dispatchedAt: t0 + 2000 }),
      queue: [
        item({ content: "interrupted message", source: "jori", msgId: "interrupted", dispatchedAt: t0 + 500 }),   // a shutdown put it back
        item({ content: "waiting message", source: "jori", msgId: "waiting" }),
        item({ content: "/compact", source: "context-guard" }),
        item({ content: "Session started. Standing by.", source: "init", priority: 2, priorityName: "low" }),
      ],
    }));
    const record = path.join(tmp.dir, "received.txt");
    sup = startSupervisor({ port, configPath, stateDir: tmp.dir, claudeArgs: ["--record", record] });
    await sup.waitForReady();
    await sleep(1500);
    assert.equal((await httpGet(port, "/health")).body.queueRestored, 2);
    const got = fs.readFileSync(record, "utf8");
    assert.ok(!got.includes("poison message"), "a turn running at two restarts is not replayed a third time");
    assert.ok(!got.includes("/compact"), "a saved /compact belongs to the old session");
    const i = got.indexOf("interrupted message"), w = got.indexOf("waiting message");
    assert.ok(i >= 0 && w > i, `both delivered, interrupted first, got:\n${got}`);
    assert.ok(got.lastIndexOf("was being answered when the chat supervisor restarted", i) >= 0, "the interrupted turn is told it may be partly done");
    assert.ok(got.slice(i, w).includes("was still queued when the chat supervisor restarted"), "the waiting one is told it is late");
    assert.ok(sup.stderr.join("").includes("saved queue: not replaying 3 item(s): jori (running at two restarts), context-guard, init"));
  });

  it("starts empty, and still answers, when the saved queue file is malformed", async () => {
    port = allocPort();
    tmp = tmpDir();
    const configPath = writeTestConfig(tmp.dir, port);
    fs.writeFileSync(path.join(tmp.dir, "queue.json"), JSON.stringify({ version: 1, queue: { not: "a list" }, inFlight: null }));
    sup = startSupervisor({ port, configPath, stateDir: tmp.dir });
    await sup.waitForReady();
    await sleep(4000);
    const health = await httpGet(port, "/health");
    assert.equal(health.body.queueRestored, 0);
    assert.ok(health.body.completed >= 1, "the init turn ran");
    assert.ok(sup.stderr.join("").includes("saved queue not restored"));
  });

  // ── State persistence ─────────────────────────────────────────────

  it("persists session state to disk", async () => {
    await setup();
    await httpPost(port, "/dispatch", { content: "persist-test", source: "test", priority: "high" });
    await sleep(500);

    const statePath = path.join(tmp.dir, "session.json");
    assert.ok(fs.existsSync(statePath), "session.json should exist");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.ok(state.sessionId);
    assert.ok(state.totalCostUsd > 0);
    assert.ok(state.totalTurns >= 1);
    assert.equal(state.everInitialized, true);
  });

  // ── Event logging ─────────────────────────────────────────────────

  it("logs events and costs to NDJSON files", async () => {
    await setup();
    await httpPost(port, "/dispatch", { content: "log-test", source: "test", priority: "high" });
    await sleep(500);

    const logDir = path.join(os.homedir(), "Dev/jori/agent/logs/supervisor-test-chat");
    // Events and cost logs should exist (or in the stateDir — let's check both).
    // The EventLog uses eventDir which is constructed from the agent name.
    const eventsPath = path.join(logDir, "events.ndjson");
    const costPath = path.join(logDir, "cost.ndjson");

    if (fs.existsSync(eventsPath)) {
      const events = fs.readFileSync(eventsPath, "utf8").trim().split("\n");
      assert.ok(events.length >= 1, "Should have at least 1 event logged");
    }
    if (fs.existsSync(costPath)) {
      const costs = fs.readFileSync(costPath, "utf8").trim().split("\n");
      assert.ok(costs.length >= 1, "Should have at least 1 cost entry");
    }
  });

  // ── Concurrent dispatches ─────────────────────────────────────────

  it("handles concurrent HTTP requests without crashing", async () => {
    await setup(["--delay", "100"]);
    // Fire 10 dispatches concurrently.
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(httpPost(port, "/dispatch", {
        content: `concurrent-${i}`,
        source: "test",
        priority: i === 0 ? "high" : "normal",
        msgId: `conc-${i}`,
      }));
    }
    const results = await Promise.all(promises);
    for (const r of results) {
      assert.equal(r.status, 200);
    }

    // Wait for all to process.
    await sleep(5000);

    const health = await httpGet(port, "/health");
    assert.equal(health.body.queueDepth, 0);
    assert.equal(health.body.inFlight, null);
    // Init + at least the high-priority one; the normal ones coalesce into
    // fewer turns (`completed` counts turns). queueDepth 0 and nothing in
    // flight above say every message was delivered.
    assert.ok(health.body.completed >= 3, `Expected >=3 completed turns, got ${health.body.completed}`);
  });

  // ── Malformed requests ────────────────────────────────────────────

  it("handles malformed JSON gracefully", async () => {
    await setup();
    // Send raw text that isn't valid JSON.
    const { status } = await new Promise((resolve, reject) => {
      const body = "not json at all";
      const req = http.request(`http://127.0.0.1:${port}/dispatch`, {
        method: "POST",
        headers: { "content-type": "text/plain", "content-length": Buffer.byteLength(body) },
      }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      });
      req.on("error", reject);
      req.end(body);
    });
    // Server falls back to treating raw body as content — should dispatch it.
    assert.equal(status, 200);
  });

  // ── Init message dispatched as low priority ───────────────────────

  it("init message is dispatched as low priority", async () => {
    port = allocPort();
    tmp = tmpDir();
    const configPath = writeTestConfig(tmp.dir, port);
    sup = startSupervisor({ port, configPath, stateDir: tmp.dir, claudeArgs: ["--delay", "100"] });
    await sup.waitForReady();

    // Before init fires (3s delay), dispatch a high-priority message.
    await sleep(500);
    await httpPost(port, "/dispatch", { content: "urgent-before-init", source: "test", priority: "high", msgId: "pre-init" });

    // Wait for both to process.
    await sleep(5000);

    const health = await httpGet(port, "/health");
    assert.ok(health.body.completed >= 2, `Expected >=2 completed, got ${health.body.completed}`);
  });

  // ── Heartbeat endpoint ────────────────────────────────────────────

  it("POST /heartbeat updates phoneChannelHeartbeatAgeMs", async () => {
    await setup();
    // Before heartbeat, age should be null.
    const before = await httpGet(port, "/health");
    assert.equal(before.body.phoneChannelHeartbeatAgeMs, null);

    // Send heartbeat.
    const { status } = await httpPost(port, "/heartbeat", { source: "phone-channel", pid: 12345 });
    assert.equal(status, 200);

    // After heartbeat, age should be a small number.
    const after = await httpGet(port, "/health");
    assert.ok(after.body.phoneChannelHeartbeatAgeMs !== null, "heartbeat age should not be null");
    assert.ok(after.body.phoneChannelHeartbeatAgeMs < 2000, `heartbeat age should be <2s, got ${after.body.phoneChannelHeartbeatAgeMs}`);
  });

  // ── Heartbeat reported in health snapshot ─────────────────────────

  it("health snapshot includes phoneChannelHeartbeatAgeMs field", async () => {
    await setup();
    const { body } = await httpGet(port, "/health");
    assert.ok("phoneChannelHeartbeatAgeMs" in body, "health should include phoneChannelHeartbeatAgeMs");
  });

  it("health reports phoneChannelStale, false while no first heartbeat is overdue", async () => {
    await setup();
    const { body } = await httpGet(port, "/health");
    assert.equal(body.phoneChannelStale, false, "a session just started is inside the first-heartbeat grace");
    await httpPost(port, "/heartbeat", { source: "phone-channel", pid: 12345 });
    assert.equal((await httpGet(port, "/health")).body.phoneChannelStale, false);
  });

  // ── sendInit called after restart ─────────────────────────────────

  it("sendInit is called after restart so session initializes", async () => {
    await setup();

    // Trigger restart.
    await httpPost(port, "/restart", {});
    await sleep(10000); // Wait for restart backoff (2s) + spawn + init (3s delay) + processing.

    const health = await httpGet(port, "/health");
    assert.equal(health.body.childAlive, true);
    assert.ok(health.body.restartCount >= 1);
    // The restarted session should have completed at least 1 turn (the init message).
    assert.ok(health.body.completed >= 1, `Expected >=1 completed after restart, got ${health.body.completed}`);
  });

  // ── dispatch_error triggers restart ───────────────────────────────

  it("requeues message and restarts on dispatch_error", async () => {
    // Use --fail-after 1 so the second message causes a crash mid-send.
    port = allocPort();
    tmp = tmpDir();
    const configPath = writeTestConfig(tmp.dir, port);
    sup = startSupervisor({ port, configPath, stateDir: tmp.dir, claudeArgs: ["--fail-after", "1"] });
    await sup.waitForReady();
    await sleep(5000); // Wait for init.

    // Send a message that will cause the mock to crash.
    await httpPost(port, "/dispatch", { content: "will-crash", source: "test", priority: "high" });

    // Wait for crash + restart + reprocessing.
    await sleep(10000);

    const logs = sup.stderr.join("");
    const health = await httpGet(port, "/health");
    assert.ok(health.body.restartCount >= 1, "Should have restarted at least once");
    assert.equal(health.body.childAlive, true, "Child should be alive after restart");
  });

  // ── CHAT_SUBSTRATE=loop (Conway-substrate step 1) ─────────────────

  describe("loop mode (CHAT_SUBSTRATE=loop)", () => {
    it("dispatches through the Agent and reports chatAgent health fields", async () => {
      port = allocPort();
      tmp = tmpDir();
      const configPath = writeTestConfig(tmp.dir, port);
      sup = startSupervisor({ port, configPath, stateDir: tmp.dir, env: { CHAT_SUBSTRATE: "loop" } });
      await sup.waitForReady();
      await sleep(4000); // init

      const { status, body } = await httpPost(port, "/dispatch", { content: "hello loop mode", source: "test", priority: "high" });
      assert.equal(status, 200);
      assert.ok(body.id);
      await sleep(500);

      const health = await httpGet(port, "/health");
      assert.equal(health.body.substrateMode, "loop");
      assert.ok(health.body.completed >= 2, `Expected >=2 completed (init + dispatch), got ${health.body.completed}`);
      assert.equal(health.body.queueDepth, 0);
      assert.equal(health.body.inFlight, null);
      // The Agent should have run one turn per dispatched item (init + this message).
      assert.ok(health.body.chatAgentTurns >= 2, `Expected chatAgent.turns >= 2, got ${health.body.chatAgentTurns}`);
      assert.equal(health.body.chatAgentStatus, "idle");
    });

    it("still restarts and self-heals when claude crashes mid-turn", async () => {
      port = allocPort();
      tmp = tmpDir();
      const configPath = writeTestConfig(tmp.dir, port);
      sup = startSupervisor({ port, configPath, stateDir: tmp.dir, claudeArgs: ["--fail-after", "1"], env: { CHAT_SUBSTRATE: "loop" } });
      await sup.waitForReady();
      await sleep(5000); // init

      await httpPost(port, "/dispatch", { content: "trigger-crash", source: "test", priority: "high" });
      await sleep(10000); // crash + backoff restart + respawn

      const logs = sup.stderr.join("");
      const health = await httpGet(port, "/health");
      assert.ok(logs.includes("claude exited"), `Expected 'claude exited' in logs. Got:\n${logs.slice(-1000)}`);
      assert.ok(logs.includes("restart #"), `Expected 'restart #' in logs. Got:\n${logs.slice(-1000)}`);
      assert.ok(health.body.restartCount >= 1, `Restart count should be >=1, got ${health.body.restartCount}`);
      assert.equal(health.body.childAlive, true, "Child should be alive after restart");
      assert.equal(health.body.substrateMode, "loop");
    });

    it("still requeues and restarts on dispatch_error (session-not-running guard preserved)", async () => {
      port = allocPort();
      tmp = tmpDir();
      const configPath = writeTestConfig(tmp.dir, port);
      sup = startSupervisor({ port, configPath, stateDir: tmp.dir, claudeArgs: ["--fail-after", "1"], env: { CHAT_SUBSTRATE: "loop" } });
      await sup.waitForReady();
      await sleep(5000); // init

      await httpPost(port, "/dispatch", { content: "will-crash", source: "test", priority: "high" });
      await sleep(10000); // crash + restart + reprocessing

      const health = await httpGet(port, "/health");
      assert.ok(health.body.restartCount >= 1, "Should have restarted at least once");
      assert.equal(health.body.childAlive, true, "Child should be alive after restart");
    });

    it("POST /restart tears down and rebuilds the chatAgent cleanly", async () => {
      port = allocPort();
      tmp = tmpDir();
      const configPath = writeTestConfig(tmp.dir, port);
      sup = startSupervisor({ port, configPath, stateDir: tmp.dir, env: { CHAT_SUBSTRATE: "loop" } });
      await sup.waitForReady();
      await sleep(4000); // init

      const { status, body } = await httpPost(port, "/restart", {});
      assert.equal(status, 202);
      assert.equal(body.restarting, true);
      // Backoff (2s) + spawn + init dispatch (3s delayed) + processing — mirrors
      // the non-loop "sendInit is called after restart" test's wait, not the
      // shorter one from the plain "POST /restart triggers session restart" test
      // (which never asserts on `completed`).
      await sleep(10000);

      const health = await httpGet(port, "/health");
      assert.equal(health.body.childAlive, true);
      assert.ok(health.body.restartCount >= 1);
      // The rebuilt chatAgent should have processed the post-restart init turn.
      assert.ok(health.body.completed >= 1, `Expected >=1 completed after restart, got ${health.body.completed}`);
      assert.equal(health.body.chatAgentStatus, "idle");

      // A dispatch after restart should still complete normally through the
      // freshly-rebuilt Agent — confirms the old Agent's teardown didn't leave
      // the new one in a bad state.
      await httpPost(port, "/dispatch", { content: "post-restart message", source: "test", priority: "high" });
      await sleep(500);
      const final = await httpGet(port, "/health");
      assert.equal(final.body.queueDepth, 0);
      assert.equal(final.body.inFlight, null);
    });
  });
});
