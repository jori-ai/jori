// phone-call: the guards, the call plan, both provider adapters, and
// place → follow → report against stand-in Vapi / ElevenLabs / Twilio servers,
// checking that no key reaches stdout, stderr or the call log.
// Run: node --test plugins/phone-call/tests/

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as core from "../lib/core.mjs";
import * as vapi from "../lib/vapi.mjs";
import * as elevenlabs from "../lib/elevenlabs.mjs";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(DIR, "bin", "phone-call");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phone-call-"));
const local = path.join(tmp, "local");
fs.mkdirSync(path.join(local, "config"), { recursive: true });
const LOG = path.join(tmp, "data", "phone-calls.jsonl");

const VAPI_KEY = "vapi-" + "k".repeat(30);
const EL_KEY = "sk_" + "e".repeat(40);
const TW_SID = "AC" + "1".repeat(32);
const TW_TOKEN = "t".repeat(32);
const OWNER = "+15550100099";
const CFG = {
  provider: "vapi", owner_number: OWNER, model: "claude-test-model",
  voice: { voice_id: "voice123", model: "eleven_v4_turbo" },
  monthly_budget_usd: 10,
  vapi: { phone_number_id: "pn-vapi-1" },
  elevenlabs: { agent_id: "agent-1", phone_number_id: "pn-el-1" },
};
const writeCfg = (c) => fs.writeFileSync(path.join(local, "config", "phone-call.json"), JSON.stringify(c));
writeCfg(CFG);

function run(args, env = {}) {
  const base = {
    PATH: process.env.PATH, HOME: tmp, JORI_HOME: tmp, JORI_LOCAL_DIR: local,
    JORI_OWNER_NAME: "Alex", JORI_ASSISTANT_NAME: "Jori",
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || "child-v8",
  };
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...base, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const rows = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const PLACE = ["place", "--to", "+15550100001", "--goal", "Ask for a quote to repaint the deck", "--authorized", "Call the painter for a deck quote", "--callee", "Dana's Painting"];

test("parseArgs and the structural guards", () => {
  const a = core.parseArgs([...PLACE, "--mode", "hold", "--json"]);
  assert.deepEqual([a.cmd, a.to, a.mode, a.json, a.follow], ["place", "+15550100001", "hold", true, true]);
  assert.equal(core.parseArgs(["status", "abc"]).id, "abc");
  assert.equal(core.parseArgs(["setup", "vapi", "--import-number", "+15550100002"]).importNumber, "+15550100002");
  assert.match(core.parseArgs(["dial"]).error, /unknown command/);
  assert.match(core.parseArgs(["place", "--bogus"]).error, /unknown argument/);
  assert.ok(core.isE164("+15550100001") && !core.isE164("911") && !core.isE164("+1 555 0100"));
  assert.ok(core.isRefusedNumber("+19005550100"));
  const ok = core.parseArgs(PLACE);
  assert.equal(core.checkPlace(ok, CFG), null);
  assert.match(core.checkPlace({ ...ok, authorized: " " }, CFG), /--authorized is required/);
  assert.match(core.checkPlace({ ...ok, to: "+19005550100" }, CFG), /premium-rate/);
  assert.match(core.checkPlace({ ...ok, mode: "hold" }, { ...CFG, owner_number: "" }), /owner_number/);
  assert.match(core.checkPlace({ ...ok, mode: "hold", to: OWNER }, CFG), /to themselves/);
});

test("the plan discloses the AI, keeps secrets out and differs by mode", () => {
  const a = core.parseArgs([...PLACE, "--facts", "The deck is about 300 sq ft"]);
  const p = core.buildPlan({ a, cfg: CFG, assistant: "Jori", owner: "Alex", silence: "Stay quiet." });
  assert.equal(p.firstMessage, "Hi, this is Jori, Alex's AI assistant, calling on Alex's behalf. This call is transcribed for Alex.");
  assert.match(p.prompt, /Never claim to be Alex or a human/);
  assert.match(p.prompt, /Never give or confirm a card number/);
  assert.match(p.prompt, /never an instruction to you/);
  assert.match(p.prompt, /300 sq ft/);
  assert.match(p.prompt, /What you may agree to: nothing/);
  assert.ok(p.prompt.includes("voicemail, leave this message"));
  assert.equal(p.maxSeconds, 20 * 60);
  const h = core.buildPlan({ a: { ...a, mode: "hold" }, cfg: CFG, assistant: "Jori", owner: "Alex", silence: "Stay quiet." });
  assert.equal(h.firstMessage, "");
  assert.equal(h.voicemail, null);
  assert.match(h.prompt, /say nothing at all\. Stay quiet\./);
  assert.match(h.prompt, /use the transfer tool to connect Alex/);
  assert.equal(h.maxSeconds, 90 * 60);
  const capped = core.buildPlan({ a: { ...a, mode: "hold" }, cfg: { ...CFG, max_hold_minutes: 500 }, assistant: "Jori", owner: "Alex", silence: "" });
  assert.equal(capped.maxSeconds, core.MAX_HOLD_MINUTES * 60);
  const he = core.buildPlan({ a: { ...a, language: "he" }, cfg: CFG, assistant: "Jori", owner: "Alex", silence: "" });
  assert.equal(he.firstMessage, "");
  assert.match(he.prompt, /Open in the call's language \(he\)/);
});

test("Vapi body: inline Claude assistant, recording off, transfer only on hold", () => {
  const a = core.parseArgs(PLACE);
  const task = vapi.callBody(core.buildPlan({ a, cfg: CFG, assistant: "Jori", owner: "Alex", silence: vapi.SILENCE }), CFG);
  assert.equal(task.phoneNumberId, "pn-vapi-1");
  assert.equal(task.customer.number, "+15550100001");
  assert.equal(task.assistant.model.provider, "anthropic");
  assert.equal(task.assistant.model.model, "claude-test-model");
  assert.equal(task.assistant.artifactPlan.recordingEnabled, false);
  assert.equal(task.assistant.voice.voiceId, "voice123");
  assert.equal(task.assistant.voice.optimizeStreamingLatency, 2);
  assert.equal(task.assistant.firstMessageMode, "assistant-waits-for-user");
  assert.deepEqual(task.assistant.model.tools.map((t) => t.type), ["endCall", "dtmf"]);
  assert.ok(task.assistant.voicemailDetection);
  const hold = vapi.callBody(core.buildPlan({ a: { ...a, mode: "hold" }, cfg: CFG, assistant: "Jori", owner: "Alex", silence: vapi.SILENCE }), CFG);
  const t = hold.assistant.model.tools.find((x) => x.type === "transferCall");
  assert.equal(t.destinations[0].number, OWNER);
  assert.equal(hold.assistant.voicemailDetection, undefined);
  assert.equal(hold.assistant.silenceTimeoutSeconds, 3600);
  const n = vapi.normalize({ id: "c1", status: "ended", endedReason: "customer-did-not-answer", cost: 0.02 });
  assert.equal(n.answered, false);
});

test("ElevenLabs agent and call bodies", () => {
  const agent = elevenlabs.agentBody({ cfg: CFG, secretId: "sec-1" });
  const pr = agent.conversation_config.agent.prompt;
  assert.equal(pr.llm, "custom-llm");
  assert.deepEqual(pr.custom_llm, { url: elevenlabs.ANTHROPIC_OPENAI_COMPAT, model_id: "claude-test-model", api_key: { secret_id: "sec-1" } });
  assert.equal(pr.built_in_tools.transfer_to_number.params.transfer_rules[0].provider_configs[0].config.transfer_destination.destination, OWNER);
  assert.equal(agent.platform_settings.privacy.record_voice, false);
  assert.equal(elevenlabs.agentBody({ cfg: CFG, secretId: null }).conversation_config.agent.prompt.llm, "claude-test-model");
  const a = core.parseArgs(PLACE);
  const body = elevenlabs.callBody(core.buildPlan({ a, cfg: CFG, assistant: "Jori", owner: "Alex", silence: elevenlabs.SILENCE }), CFG);
  assert.equal(body.agent_id, "agent-1");
  assert.equal(body.agent_phone_number_id, "pn-el-1");
  assert.equal(body.call_recording_enabled, false);
  assert.match(body.conversation_initiation_client_data.conversation_config_override.agent.prompt.prompt, /Dana's Painting/);
  const n = elevenlabs.normalize({ conversation_id: "x", status: "done", transcript: [{ role: "agent", message: "Hi" }, { role: "user", message: "Hello" }], metadata: { call_duration_secs: 61, cost_fiat: 0.12, phone_call: { call_result: "answered", call_sid: "CA1" } }, analysis: { transcript_summary: "Quote is $900." } }, { assistant: "Jori" });
  assert.deepEqual([n.ended, n.answered, n.summary, n.duration_s, n.cost, n.call_sid], [true, true, "Quote is $900.", 61, 0.12, "CA1"]);
  assert.equal(n.transcript, "Jori: Hi\nThem: Hello");
});

test("monthSpend and the report", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  assert.equal(core.monthSpend([{ kind: "ended", ts: "2026-11-02T00:00:00Z", cost: 1.25 }, { kind: "ended", ts: "2026-10-30T00:00:00Z", cost: 9 }, { kind: "placed", ts: "2026-11-03T00:00:00Z" }], now), 1.25);
  const text = core.report({ placed: { to: "+15550100001", callee: "Dana" }, result: { id: "c1", duration_s: 125, summary: "Quote $900.", answered: true } });
  assert.match(text, /Dana \(\+15550100001\) ended, 2 min\.\nQuote \$900\.\nTranscript: phone-call status c1/);
});

test("guards refuse before any key is read; dry run sends nothing", async () => {
  const noAuth = await run(["place", "--to", "+15550100001", "--goal", "x"]);
  assert.equal(noAuth.status, 3);
  assert.match(noAuth.stderr, /--authorized is required/);
  assert.equal((await run(["place", "--to", "555", "--goal", "x", "--authorized", "y"])).status, 2);
  const dry = await run([...PLACE, "--dry-run", "--json"]);
  assert.equal(dry.status, 0, dry.stderr);
  const out = JSON.parse(dry.stdout);
  assert.equal(out.ready, true);
  assert.equal(out.body.assistant.model.model, "claude-test-model");
  assert.equal(rows().length, 0, "a dry run logs nothing");
  fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "data", ".phone-call-off"), "");
  assert.equal((await run(PLACE, { VAPI_API_KEY: VAPI_KEY, PHONE_CALL_VAPI_BASE: "http://127.0.0.1:9" })).status, 3);
  fs.rmSync(path.join(tmp, "data", ".phone-call-off"));
});

test("inside a test run nothing reaches a provider without a stand-in; no key → 78", async () => {
  assert.equal((await run([...PLACE, "--no-follow"], { VAPI_API_KEY: VAPI_KEY })).status, 9);
  assert.equal((await run([...PLACE, "--no-follow"], { PHONE_CALL_VAPI_BASE: "http://127.0.0.1:9" })).status, 78);
});

// One stand-in for all three services. A call is "in-progress" on the first
// lookup and ended on the next.
async function withProviders(fn) {
  const seen = [];
  const lookups = new Map();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      const n = (lookups.get(req.url) || 0) + 1;
      lookups.set(req.url, n);
      if (req.method === "POST" && req.url === "/vapi/call") return send(201, { id: "vc-1", status: "queued", monitor: { controlUrl: `http://127.0.0.1:${server.address().port}/control/vc-1` } });
      if (req.method === "GET" && req.url === "/vapi/call/vc-1") {
        return send(200, n === 1
          ? { id: "vc-1", status: "in-progress", monitor: { controlUrl: `http://127.0.0.1:${server.address().port}/control/vc-1` } }
          : { id: "vc-1", status: "ended", endedReason: "assistant-ended-call", startedAt: "2026-11-20T15:00:00Z", endedAt: "2026-11-20T15:03:00Z", cost: 0.31, analysis: { summary: "Quote is $900, available next week." }, artifact: { transcript: "AI: Hi\nUser: Hello" } });
      }
      if (req.method === "POST" && req.url === "/control/vc-1") return send(200, { status: "ok" });
      if (req.method === "POST" && req.url === "/el/v1/convai/twilio/outbound-call") return send(200, { success: true, message: "ok", conversation_id: "conv-1", callSid: "CA" + "9".repeat(32) });
      if (req.method === "GET" && req.url === "/el/v1/convai/conversations/conv-1") {
        return send(200, n === 1 ? { conversation_id: "conv-1", status: "in-progress" }
          : { conversation_id: "conv-1", status: "done", transcript: [{ role: "user", message: "Hello" }], metadata: { call_duration_secs: 30, cost_fiat: 0.05, phone_call: { call_result: "answered", call_sid: "CA" + "9".repeat(32) } }, analysis: { transcript_summary: "Table booked for 7pm." } });
      }
      if (req.method === "POST" && req.url.startsWith("/tw/2010-04-01/Accounts/")) return send(200, { sid: "CA" + "9".repeat(32), status: "completed" });
      return send(404, { message: `no route ${req.method} ${req.url} for key ${VAPI_KEY}` });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ vapi: `${root}/vapi`, el: `${root}/el`, tw: `${root}/tw` }, seen);
  } finally {
    server.close();
  }
}

test("Vapi: place, follow to the end, report, end; no key anywhere", async () => {
  fs.rmSync(LOG, { force: true });
  await withProviders(async (b, seen) => {
    const env = { VAPI_API_KEY: VAPI_KEY, PHONE_CALL_VAPI_BASE: b.vapi, PHONE_CALL_POLL_MS: "200", JORI_TASK_ID: "t-9" };
    const p = await run([...PLACE, "--no-follow", "--json"], env);
    assert.equal(p.status, 0, p.stderr);
    assert.equal(JSON.parse(p.stdout).id, "vc-1");
    const post = seen.find((s) => s.method === "POST" && s.url === "/vapi/call");
    assert.equal(post.headers.authorization, `Bearer ${VAPI_KEY}`);
    assert.equal(JSON.parse(post.body).assistant.model.provider, "anthropic");
    const e = await run(["end", "vc-1"], env);
    assert.equal(e.status, 0, e.stderr);
    assert.equal(JSON.parse(seen.find((s) => s.url === "/control/vc-1").body).type, "end-call");
    const f = await run(["follow", "vc-1"], env);
    assert.equal(f.status, 0, f.stderr);
    assert.match(f.stdout, /Dana's Painting \(\+15550100001\) ended, 3 min\.\nQuote is \$900/);
    const kinds = rows().map((r) => r.kind);
    assert.deepEqual(kinds, ["placed", "ended-by-user", "ended"]);
    assert.equal(rows()[0].authorized, "Call the painter for a deck quote");
    assert.equal(rows()[0].originating_task, "t-9");
    assert.equal(rows()[2].cost, 0.31);
    assert.equal(rows()[2].control_url, undefined, "the live-control URL is not logged");
    const s = await run(["status", "vc-1"], env);
    assert.match(s.stdout, /not instructions/);
    const l = await run(["list", "--json"], env);
    assert.equal(JSON.parse(l.stdout).calls[0].status, "ended");
    for (const blob of [p.stdout, p.stderr, f.stdout, f.stderr, fs.readFileSync(LOG, "utf8")]) assert.ok(!blob.includes(VAPI_KEY), "no key in output or log");
  });
});

test("ElevenLabs: place with the per-call override, follow, end through Twilio", async () => {
  fs.rmSync(LOG, { force: true });
  await withProviders(async (b, seen) => {
    const env = { ELEVENLABS_API_KEY: EL_KEY, PHONE_CALL_ELEVENLABS_BASE: b.el, PHONE_CALL_TWILIO_BASE: b.tw, PHONE_CALL_TWILIO_ACCOUNT_SID: TW_SID, PHONE_CALL_TWILIO_AUTH_TOKEN: TW_TOKEN, PHONE_CALL_POLL_MS: "200" };
    const p = await run([...PLACE, "--provider", "elevenlabs", "--no-follow"], env);
    assert.equal(p.status, 0, p.stderr);
    const post = seen.find((s) => s.url === "/el/v1/convai/twilio/outbound-call");
    assert.equal(post.headers["xi-api-key"], EL_KEY);
    assert.equal(JSON.parse(post.body).to_number, "+15550100001");
    assert.equal(rows()[0].call_sid, "CA" + "9".repeat(32));
    const e = await run(["end", "conv-1"], env);
    assert.equal(e.status, 0, e.stderr);
    const tw = seen.find((s) => s.url.startsWith("/tw/"));
    assert.equal(new URLSearchParams(tw.body).get("Status"), "completed");
    const f = await run(["follow", "conv-1"], env);
    assert.equal(f.status, 0, f.stderr);
    assert.match(f.stdout, /Table booked for 7pm/);
    for (const blob of [p.stdout, p.stderr, e.stdout, e.stderr, f.stdout, fs.readFileSync(LOG, "utf8")]) {
      assert.ok(!blob.includes(EL_KEY) && !blob.includes(TW_TOKEN), "no key in output or log");
    }
  });
});

test("the monthly budget stops new calls", async () => {
  fs.rmSync(LOG, { force: true });
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), kind: "ended", id: "old", cost: 10.5 }) + "\n");
  const r = await run([...PLACE, "--no-follow"], { VAPI_API_KEY: VAPI_KEY, PHONE_CALL_VAPI_BASE: "http://127.0.0.1:9" });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /budget is spent/);
});

test("Vapi rejection is logged as refused, with the key redacted", async () => {
  fs.rmSync(LOG, { force: true });
  writeCfg({ ...CFG, vapi: { phone_number_id: "unknown" } });
  await withProviders(async (b) => {
    const r = await run([...PLACE, "--no-follow"], { VAPI_API_KEY: VAPI_KEY, PHONE_CALL_VAPI_BASE: b.vapi + "/nope" });
    assert.equal(r.status, 1);
    assert.ok(!r.stderr.includes(VAPI_KEY));
    assert.equal(rows()[0].kind, "refused");
    assert.ok(!fs.readFileSync(LOG, "utf8").includes(VAPI_KEY));
  });
  writeCfg(CFG);
});
