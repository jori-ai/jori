// day-statements-self-messages.test.mjs — the user's sent iMessages are read by a
// model (stubbed here) as correction / declarative / chatter, on the same ladder as
// the places, with each quote checked against the message it names. They replaced
// the regex lib/message-classifier.js (Rule #0b, 2026-10-29).
//
// Run: node --test tests/day-statements-self-messages.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { classifySelfMessages, validateSelfMessages, selfMessagesPrompt } = require(path.join(ROOT, "bin/day-statements"));

// The shape `imsg sent --json` prints.
const MSGS = [
  { date: "2026-04-16 20:46:00", contact: "Sam", is_group: false, text: "that's the dog's wash - the time stamps are wrong" },
  { date: "2026-04-16 13:10:00", contact: "Alex", is_group: false, text: "Had lunch with Dana at Cafe Example, so good" },
  { date: "2026-04-16 09:02:00", contact: "Sam", is_group: false, text: "ok \u{1F44D}" },
];

const OPTS = { date: "2026-04-16", tz: "Europe/Lisbon" };
const reply = (obj) => "Here you go:\n" + JSON.stringify(obj);

test("a valid reading becomes one entry per message, in order, with time and text from code", async () => {
  const calls = [];
  const ask = async (p, tier) => {
    calls.push(tier);
    return reply({ self_messages: [
      { i: 0, kind: "correction", quote: "the time stamps are wrong" },
      { i: 1, kind: "declarative", quote: "Had lunch with Dana at Cafe Example" },
      { i: 2, kind: "chatter", quote: null },
    ] });
  };
  const r = await classifySelfMessages(MSGS, { ...OPTS, ask });
  assert.deepEqual(calls, ["local"]);
  assert.equal(r.tier, "local");
  assert.deepEqual(r.self_messages, [
    { at: "2026-04-16 20:46:00", text: "that's the dog's wash - the time stamps are wrong", kind: "correction", quote: "the time stamps are wrong" },
    { at: "2026-04-16 13:10:00", text: "Had lunch with Dana at Cafe Example, so good", kind: "declarative", quote: "Had lunch with Dana at Cafe Example" },
    { at: "2026-04-16 09:02:00", text: "ok \u{1F44D}", kind: "chatter", quote: null },
  ]);
});

test("a message the model leaves out is chatter", async () => {
  const ask = async () => reply({ self_messages: [{ i: 0, kind: "correction", quote: "time stamps are wrong" }] });
  const r = await classifySelfMessages(MSGS, { ...OPTS, ask });
  assert.deepEqual(r.self_messages.map((m) => m.kind), ["correction", "chatter", "chatter"]);
});

test("an invented quote fails validation and the next rung is asked", async () => {
  const calls = [];
  const ask = async (p, tier) => {
    calls.push(tier);
    if (tier === "local") return reply({ self_messages: [{ i: 1, kind: "declarative", quote: "had dinner at Dr Shakshuka" }] });
    return reply({ self_messages: [{ i: 1, kind: "declarative", quote: "lunch with Dana at Cafe Example" }] });
  };
  const r = await classifySelfMessages(MSGS, { ...OPTS, ask });
  assert.deepEqual(calls, ["local", "sonnet"]);
  assert.equal(r.tier, "sonnet");
  assert.match(r.attempts[0].error, /quote is not in the message/); // lang-regex-ok: matches our own validation error text, not user language
  assert.equal(r.self_messages[1].kind, "declarative");
});

test("every rung failing gives no reading at all, never a guess", async () => {
  const ask = async (p, tier) => {
    if (tier === "opus") throw new Error("claude exited 1");
    return tier === "local" ? "not json" : reply({ self_messages: [{ i: 9, kind: "correction", quote: "x" }] });
  };
  const r = await classifySelfMessages(MSGS, { ...OPTS, ask });
  assert.equal(r.self_messages, null);
  assert.deepEqual(r.attempts.map((a) => a.tier), ["local", "sonnet", "opus"]);
});

test("no sent messages: an empty reading and no model call", async () => {
  const r = await classifySelfMessages([], { ...OPTS, ask: async () => { throw new Error("must not be called"); } });
  assert.deepEqual(r.self_messages, []);
});

test("validation: unknown kind, missing quote, chatter needs no quote", () => {
  assert.match(validateSelfMessages({ self_messages: [{ i: 0, kind: "fact", quote: "x" }] }, MSGS), /not one of/);
  assert.match(validateSelfMessages({ self_messages: [{ i: 0, kind: "correction" }] }, MSGS), /no quote/);
  assert.equal(validateSelfMessages({ self_messages: [{ i: 2, kind: "chatter" }] }, MSGS), null);
  assert.match(validateSelfMessages({ places: [] }, MSGS), /not an array/);
});

test("the prompt numbers each message so the answer names it by index", () => {
  const p = selfMessagesPrompt(OPTS.date, OPTS.tz, MSGS);
  assert.ok(p.includes("[0] 2026-04-16 20:46:00 to Sam: that's the dog's wash"));
  assert.ok(p.includes("[2] 2026-04-16 09:02:00 to Sam: ok"));
});
