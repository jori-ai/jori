// question-route.test.mjs — urgent questions stay in chat, the rest go to the
// questions channel, location questions are always urgent.
//
// Pinned here:
//   1. What counts as a question, and as a location question, from structure
//      only (intent, hum context, flags).
//   2. routeQuestion: not a question → chat untouched; location → chat, urgent,
//      no judgment; judged urgent → chat; judged not urgent → questions;
//      judge failure and the off switch → chat.
//   3. The words check: a message whose label says "not a question" is read by
//      a model (Jev site `message-asks`) and, when it asks something, routed
//      like any question; a private-data intent, the off switches and a
//      labelled question never reach it; a failed check keeps chat.
//   4. jori-send-curl applies the route: the row's channel, no push for the
//      questions channel, the `.route` sidecar for a capturing caller, and the
//      router is told about tappable choices and private-data intents.
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
process.env.QUESTION_TEXT_CHECK_OFF = path.join(tmp, ".text-off");
const { isQuestion, isLocationQuestion, routeQuestion, rubricPrompt, asksPrompt, ASKS_DEF } = await import("../lib/question-route.mjs");

const KERNEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { underTestRunner } = require("../lib/load-env.js");
const { KERNEL_SUBDIR } = require("../lib/root.cjs");

const never = async () => { throw new Error("the judge must not run"); };
// The words check's stand-ins: every routeQuestion call below names one, so no
// test can reach a real model.
const says = (asks) => async () => ({ asks, reason: "test" });

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
  const r = await routeQuestion({ text: "The museum opens at 10.", intent: "hum:nearby:fact", judge: never, detector: says(false) });
  assert.deepEqual([r.channel, r.urgent, r.question], ["chat", false, false]);
});

// An info ping that closes with a question (the shape of the ping that prompted
// this check: labelled info, so structure alone sent it to chat).
const INFO_PING_ASKING = "Cancelling the spare phone line and choosing the order of the next three trips are both due Friday. "
  + "Your timeline has nothing yet on when the second trip comes. Want to settle the trip order first and cancel only if that trip is late or off?";
const INFO_CONTEXT = { kind: "ping", lane: "ideas", dedup_key: "idea-x", finding: { topic: "ideas", supporting_data: { confidence: "medium", verify_question: null } } };

test("a message labelled info that asks something is found from its words and routed as a question", async () => {
  assert.equal(isQuestion({ intent: "hum:ideas:idea-x", context: INFO_CONTEXT }), false, "structure alone does not see it");
  let read = null;
  const r = await routeQuestion({ text: INFO_PING_ASKING, intent: "hum:ideas:idea-x", context: INFO_CONTEXT,
    detector: async (s) => { read = s; return { asks: true }; }, judge: async () => ({ urgent: false }) });
  assert.deepEqual([r.channel, r.urgent, r.question, r.detected], ["questions", false, true, "text"]);
  assert.equal(read.message, INFO_PING_ASKING, "the model reads the whole message");
  assert.equal(read.intent, "hum:ideas:idea-x");
  assert.equal(read.lane, "ideas");
  const urgent = await routeQuestion({ text: INFO_PING_ASKING, intent: "hum:ideas:idea-x", context: INFO_CONTEXT,
    detector: says(true), judge: async () => ({ urgent: true }) });
  assert.deepEqual([urgent.channel, urgent.urgent, urgent.detected], ["chat", true, "text"], "an urgent one stays in chat");
});

test("the words check and the urgency judgment it leads to run on a tight budget", async () => {
  process.env.QUESTION_TEXT_CHECK_MS = "60";
  const hang = () => new Promise(() => {});
  try {
    const slowCheck = await routeQuestion({ text: INFO_PING_ASKING, intent: "hum:ideas:idea-x", context: INFO_CONTEXT, detector: hang, judge: never });
    assert.deepEqual([slowCheck.channel, slowCheck.question], ["chat", null]);
    assert.match(slowCheck.reason, /timed out/);
    const slowJudge = await routeQuestion({ text: INFO_PING_ASKING, intent: "hum:ideas:idea-x", context: INFO_CONTEXT, detector: says(true), judge: hang });
    assert.deepEqual([slowJudge.channel, slowJudge.question, slowJudge.detected], ["chat", true, "text"]);
    assert.match(slowJudge.reason, /timed out/);
    // A labelled question keeps the router's own (longer) deadline.
    const labelled = await routeQuestion({ text: "Q?", intent: "decision:ask", detector: never,
      judge: () => new Promise((resolve) => setTimeout(() => resolve({ urgent: false }), 120)) });
    assert.equal(labelled.channel, "questions");
  } finally { delete process.env.QUESTION_TEXT_CHECK_MS; }
});

test("the words check: a no stays in chat, a labelled question skips it, choices are passed on", async () => {
  const no = await routeQuestion({ text: "Your table is booked for 8.", intent: "booking-confirmation", detector: says(false), judge: never });
  assert.deepEqual([no.channel, no.question], ["chat", false]);
  const labelled = await routeQuestion({ text: "Q?", intent: "decision:ask", detector: never, judge: async () => ({ urgent: false }) });
  assert.equal(labelled.channel, "questions");
  assert.equal(labelled.detected, undefined, "a labelled question is not marked as found from its words");
  let seen = null;
  await routeQuestion({ text: "Pick one.", intent: "invite", choices: true, detector: async (s) => { seen = s; return { asks: false }; }, judge: never });
  assert.equal(seen.has_choices, true);
});

test("a private-data intent and the off switches are never read for an ask", async () => {
  const priv = await routeQuestion({ text: "A charge posted. Was it you?", intent: "bank-alert", privateData: true, detector: never, judge: never });
  assert.deepEqual([priv.channel, priv.question], ["chat", false]);
  for (const sw of [process.env.QUESTION_TEXT_CHECK_OFF, process.env.QUESTION_ROUTE_OFF]) {
    fs.writeFileSync(sw, "");
    try {
      const r = await routeQuestion({ text: INFO_PING_ASKING, intent: "hum:ideas:idea-x", context: INFO_CONTEXT, detector: never, judge: never });
      assert.deepEqual([r.channel, r.question], ["chat", false]);
    } finally { fs.unlinkSync(sw); }
  }
});

test("a failed words check keeps the message in chat and is logged", async () => {
  const r = await routeQuestion({ text: "Want me to?", intent: "hum:ideas:idea-y", detector: async () => { throw new Error("down"); }, judge: never });
  assert.deepEqual([r.channel, r.question], ["chat", null]);
  assert.match(r.reason, /text check failed/);
  const rows = fs.readFileSync(process.env.QUESTION_ROUTE_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(rows.some((x) => x.intent === "hum:ideas:idea-y" && x.question === null && x.detected === "text"));
});

test("the words check's Sonnet rung reads the site's own wording", () => {
  const p = asksPrompt({ message: "Want me to book it?" });
  assert.match(p, /asks=true/);
  assert.ok(p.includes('"message":"Want me to book it?"'));
  assert.ok(!p.includes("{{owner_name}}"), "the owner's name is filled in");
  assert.equal(ASKS_DEF.questions.asks.type, "boolean");
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
  assert.match(box.calls(), /"channel":"chat"/); // lang-regex-ok: the recorded insert's channel field, not the user's words
  assert.ok(box.argsSeen().includes("--location"));
});

test("jori-send-curl tells the router about tappable choices and private-data intents", needsRunner, () => {
  const box = sandbox({ channel: "chat", urgent: false, question: false });
  let r = box.run(["--skip-precheck", "--choices-json", '{"options":[]}', "Which one?"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(box.argsSeen().includes("--choices"));
  assert.ok(!box.argsSeen().includes("--private-data"));
  r = box.run(["--intent", "bank-alert", "A charge posted."]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(box.argsSeen().includes("--private-data"), "a bank intent is never read for an ask");
});

test("question-route (the CLI) passes --private-data through and stays in chat", () => {
  const out = spawnSync(process.execPath, [path.join(KERNEL, "bin/question-route"), "--intent", "bank-alert", "--private-data"], {
    input: "A charge posted. Was it you?", encoding: "utf8", timeout: 20_000,
    env: { ...process.env, QUESTION_ROUTE_LOG: path.join(tmp, "cli-log.jsonl") },
  });
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout.trim());
  assert.deepEqual([r.channel, r.question], ["chat", false]);
});

test("jori-send-curl never routes a message for another channel", needsRunner, () => {
  const box = sandbox({ channel: "questions", urgent: false, question: true });
  const r = box.run(["--channel", "system", "--skip-precheck", "⚠️ Something to look at."]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(box.calls(), /"channel":"system"/);
  assert.equal(box.argsSeen(), null, "the router ran for a system-channel message");
});
