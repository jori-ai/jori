// question-route.test.mjs — urgent questions stay in chat, the rest go to the
// questions channel, location questions are always urgent.
//
// Pinned here:
//   1. What counts as a question, and as a location question, from structure
//      only (intent, hum context, flags).
//   2. routeQuestion: not a question → chat untouched; location → chat, urgent,
//      no judgment; judged urgent → chat; judged not urgent → questions;
//      judge failure and the off switch → chat.
//   3. jori-send-curl applies the route: the row's channel, no push for the
//      questions channel, the `.route` sidecar for a capturing caller.
//
// Run: node --test tests/question-route.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "question-route-"));
process.env.QUESTION_ROUTE_LOG = path.join(tmp, "log.jsonl");
process.env.QUESTION_ROUTE_OFF = path.join(tmp, ".off");
const { isQuestion, isLocationQuestion, routeQuestion, rubricPrompt } = await import("../lib/question-route.mjs");

const KERNEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { underTestRunner } = require("../lib/load-env.js");
const { KERNEL_SUBDIR } = require("../lib/root.cjs");

const never = async () => { throw new Error("the judge must not run"); };

test("a question is recognised from structure only", () => {
  assert.equal(isQuestion({ intent: "hum:dream_asks:question" }), true);
  assert.equal(isQuestion({ intent: "decision:ask" }), true);
  assert.equal(isQuestion({ explicit: true }), true);
  assert.equal(isQuestion({ context: { kind: "question" } }), true);
  assert.equal(isQuestion({ context: { finding: { topic: "hum_asks" } } }), true);
  assert.equal(isQuestion({ context: { finding: { dedup_key: "location_ask:v1" } } }), true);
  assert.equal(isQuestion({ intent: "hum:nearby:fact", context: { kind: "ping", finding: { topic: "nearby" } } }), false);
  assert.equal(isQuestion({ intent: "p1-email" }), false);
  assert.equal(isQuestion({}), false);
});

test("a location question is recognised from structure only", () => {
  assert.equal(isLocationQuestion({ context: { dedup_key: "location_ask:v1" } }), true);
  assert.equal(isLocationQuestion({ context: { finding: { supporting_data: { ask_kind: "retrospective_confirmation" } } } }), true);
  assert.equal(isLocationQuestion({ context: { lane: "location_context" } }), true);
  assert.equal(isLocationQuestion({ intent: "location:edge:ask" }), true);
  assert.equal(isLocationQuestion({ intent: "hum:location_context:question" }), true);
  assert.equal(isLocationQuestion({ location: true }), true);
  assert.equal(isLocationQuestion({ intent: "hum:dream_asks:question" }), false);
  assert.equal(isLocationQuestion({ intent: "decision:ask" }), false);
});

test("a message that is not a question stays in chat and is never judged", async () => {
  const r = await routeQuestion({ text: "The museum opens at 10.", intent: "hum:nearby:fact", judge: never });
  assert.deepEqual([r.channel, r.urgent, r.question], ["chat", false, false]);
});

test("a location question is urgent and stays in chat without a judgment", async () => {
  const r = await routeQuestion({ text: "Were you at the bakery?", context: { kind: "ping", dedup_key: "location_ask:v9" }, judge: never });
  assert.deepEqual([r.channel, r.urgent, r.question], ["chat", true, true]);
});

test("Jev decides the rest: urgent stays in chat, the others go to the questions channel", async () => {
  const urgent = await routeQuestion({ text: "Tonight's table is at 7 or 8?", intent: "decision:ask", judge: async () => ({ urgent: true }) });
  assert.deepEqual([urgent.channel, urgent.urgent], ["chat", true]);
  const later = await routeQuestion({ text: "Do you prefer window seats?", intent: "hum:dream_asks:question", judge: async () => ({ urgent: false }) });
  assert.deepEqual([later.channel, later.urgent], ["questions", false]);
});

test("the judge sees the question, its kind, lane and local time", async () => {
  let seen = null;
  await routeQuestion({ text: "Q?", intent: "hum:hum_asks:question", context: { kind: "question", lane: "hum_asks" }, tz: "UTC",
    judge: async (s) => { seen = s; return { urgent: false }; } });
  assert.equal(seen.question, "Q?");
  assert.equal(seen.kind, "question");
  assert.equal(seen.lane, "hum_asks");
  assert.ok(seen.local_time);
});

test("a failed judgment and the off switch both keep the question in chat", async () => {
  const failed = await routeQuestion({ text: "Q?", intent: "decision:ask", judge: async () => { throw new Error("down"); } });
  assert.equal(failed.channel, "chat");
  fs.writeFileSync(process.env.QUESTION_ROUTE_OFF, "");
  try {
    const off = await routeQuestion({ text: "Q?", intent: "decision:ask", judge: never });
    assert.equal(off.channel, "chat");
    const loc = await routeQuestion({ text: "Where?", intent: "location:edge:ask", judge: never });
    assert.equal(loc.urgent, true, "the off switch does not make a location question non-urgent");
  } finally { fs.unlinkSync(process.env.QUESTION_ROUTE_OFF); }
});

test("routed questions are logged", () => {
  const rows = fs.readFileSync(process.env.QUESTION_ROUTE_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.channel === "questions"));
  assert.ok(rows.some((r) => r.reason === "location question"));
  assert.ok(!rows.some((r) => r.question === false), "a non-question is not logged");
});

test("the legacy rung reads the site's own wording", () => {
  const p = rubricPrompt({ question: "Q?" });
  assert.match(p, /urgent=true/);
  assert.match(p, /"question":"Q\?"/);
});

// ─── jori-send-curl applies the route ───────────────────────────────────

const needsRunner = { skip: !underTestRunner() && "run under node --test with its default process isolation (NODE_TEST_CONTEXT is unset)" };

function sandbox(route) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "question-route-send-"));
  fs.mkdirSync(path.join(h, KERNEL_SUBDIR, "data"), { recursive: true });
  fs.writeFileSync(path.join(h, KERNEL_SUBDIR, ".env"), "SUPABASE_SERVICE_ROLE_KEY=fake\n");
  const fakeBin = path.join(h, "fakebin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "curl"), `#!/bin/sh\necho "$@" >> "$CURL_RECORD"\nprintf '%s' 201\n`);
  fs.chmodSync(path.join(fakeBin, "curl"), 0o755);
  // A stand-in router: records its arguments, prints the given route.
  const router = path.join(fakeBin, "question-route");
  fs.writeFileSync(router, `process.stdin.resume();process.stdin.on("end",()=>{require("fs").writeFileSync(process.env.ROUTER_ARGS, JSON.stringify(process.argv.slice(2)));console.log(process.env.ROUTE_JSON)});`);
  const record = path.join(h, "curl.txt");
  const routerArgs = path.join(h, "router-args.json");
  const run = (args) => spawnSync(path.join(KERNEL, "bin/jori-send-curl"), args, {
    encoding: "utf8", timeout: 20_000,
    env: { ...process.env, HOME: h, JORI_HOME: h, PATH: `${fakeBin}:${process.env.PATH}`, CURL_RECORD: record,
      JORI_SEND_TEST_CURL: path.join(fakeBin, "curl"), JORI_QUESTION_ROUTE_BIN: router, ROUTER_ARGS: routerArgs,
      ROUTE_JSON: JSON.stringify(route), JORI_PRECHECK_BYPASS: "1", SUPABASE_SERVICE_ROLE_KEY: "fake" },
  });
  const calls = () => { try { return fs.readFileSync(record, "utf8"); } catch { return ""; } };
  const argsSeen = () => { try { return JSON.parse(fs.readFileSync(routerArgs, "utf8")); } catch { return null; } };
  return { h, run, calls, argsSeen };
}

test("jori-send-curl posts a non-urgent question to the questions channel and leaves a route sidecar", needsRunner, () => {
  const box = sandbox({ channel: "questions", urgent: false, question: true });
  const capture = path.join(box.h, "capture");
  const r = box.run(["--skip-precheck", "--question", "--capture-id", capture, "Which beach do you like best?"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(box.calls(), /"channel":"questions"/);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${capture}.route`, "utf8")).channel, "questions");
  assert.ok(box.argsSeen().includes("--question"));
});

test("jori-send-curl keeps an urgent question in chat", needsRunner, () => {
  const box = sandbox({ channel: "chat", urgent: true, question: true });
  const r = box.run(["--skip-precheck", "--location-question", "Where are you off to?"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(box.calls(), /"channel":"chat"/);
  assert.ok(box.argsSeen().includes("--location"));
});

test("jori-send-curl never routes a message for another channel", needsRunner, () => {
  const box = sandbox({ channel: "questions", urgent: false, question: true });
  const r = box.run(["--channel", "system", "--skip-precheck", "⚠️ Something to look at."]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(box.calls(), /"channel":"system"/);
  assert.equal(box.argsSeen(), null, "the router ran for a system-channel message");
});
