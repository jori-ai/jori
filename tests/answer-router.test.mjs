// answer-router.test.mjs — an answer to an open question registers in whatever conversation it is typed.
//
// The shape of the failure: the daily summary's questions about a day were sent into a team role's
// conversation; the user answered there; the role session had no step to file it, so the day stayed
// "awaiting" with no answers and the summary stayed held. The filing is now code
// (lib/answer-router.mjs), called for every inbound message whatever the conversation.
//
// Run: node --test tests/answer-router.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const AWAITING = `awaiting_${createRequire(import.meta.url)("../lib/instance.cjs").instance().owner_id}`;
const BIN = path.resolve(import.meta.dirname, "..", "bin", "daily-summary-fix");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "answer-router-"));
const local = path.join(tmp, "local");
fs.mkdirSync(path.join(local, "config"), { recursive: true });
// Every store the router and the fixer touch lives in the sandbox, never the real one.
process.env.DS_FIX_DIR = path.join(tmp, "dsfix");
process.env.DS_FIX_SEND_BIN = "/bin/true";
process.env.DS_FIX_TMP = tmp;
process.env.DS_FIX_LAST_USER_MSG = "";
process.env.JORI_LOCAL_DIR = local;
process.env.JORI_DATA_DIR = path.join(tmp, "data");
process.env.ANSWER_ROUTER_DIR = path.join(tmp, "ledger");
delete process.env.DS_FIX_NOW;
fs.mkdirSync(process.env.DS_FIX_DIR, { recursive: true });
fs.mkdirSync(process.env.JORI_DATA_DIR, { recursive: true });

const AR = await import("../lib/answer-router.mjs");
const { cardReplyHint } = await import("../lib/card-reply-hint.mjs");

const iso = (minAgo) => new Date(Date.now() - minAgo * 60e3).toISOString();
const writeDay = (d, s) => fs.writeFileSync(path.join(process.env.DS_FIX_DIR, `${d}.json`), JSON.stringify({ date: d, requests: [], answers: [], log: [], rounds: 0, ...s }, null, 2));
const readDay = (d) => JSON.parse(fs.readFileSync(path.join(process.env.DS_FIX_DIR, `${d}.json`), "utf8"));
const fixer = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: process.env, timeout: 30000 });
const askOf = (asks) => async () => JSON.stringify({ answers: asks });

let n = 0;
const mid = () => `msg-${Date.now()}-${++n}`;

// ── the model's reading ─────────────────────────────────────────────────────

test("parseReading accepts question numbers in range and nothing else", () => {
  assert.deepEqual(AR.parseReading('{"answers":[1,2]}', 3), [1, 2]);
  assert.deepEqual(AR.parseReading('Sure: {"answers":[]}', 3), []);
  assert.deepEqual(AR.parseReading('{"answers":[2,2]}', 3), [2]);
  for (const bad of ['{"answers":[4]}', '{"answers":[0]}', '{"answers":["1"]}', '{"answers":1}', "no json", "", null, '{"ans":[1]}']) {
    assert.equal(AR.parseReading(bad, 3), null, String(bad));
  }
});

test("the ladder climbs a rung only when the one below throws or gives no valid reading", async () => {
  const asks = [{ question: "Where were you?", asked_at: iso(30) }];
  const tiers = [];
  const r = await AR.readAnswers({ asks, text: "Home", ask: async (_p, tier) => { tiers.push(tier); if (tier === "haiku") throw new Error("not logged in"); if (tier === "sonnet") return "I think so"; return '{"answers":[1]}'; } });
  assert.deepEqual(tiers, ["haiku", "sonnet", "opus"]);
  assert.deepEqual(r.numbers, [1]);
  assert.equal(r.tier, "opus");

  const first = [];
  const r2 = await AR.readAnswers({ asks, text: "Home", ask: async (_p, tier) => { first.push(tier); return '{"answers":[1]}'; } });
  assert.deepEqual(first, ["haiku"], "a valid first reading stops the climb");
  assert.equal(r2.tier, "haiku");

  const r3 = await AR.readAnswers({ asks, text: "Home", ask: async () => { throw new Error("down"); } });
  assert.equal(r3.numbers, null, "no rung gave a reading");
  assert.equal(r3.attempts.length, 3);
});

test("the prompt carries the open questions, the message and the conversation before it", () => {
  const p = AR.answerPrompt({ asks: [{ question: "Where were you at 11pm?", asked_at: iso(10), about: "the daily summary of 2026-11-20" }], text: "the dog's walk", history: [{ who: "Assistant", text: "Where were you at 11pm?" }] });
  assert.ok(p.includes("[1]") && p.includes("Where were you at 11pm?") && p.includes("the dog's walk") && p.includes("the daily summary of 2026-11-20"));
});

// ── routing, with stand-in flows ─────────────────────────────────────────────

function fakeFlow(asks) {
  const filed = [];
  return { filed, id: "fake", list: async () => asks.map((a, i) => ({ flow: "fake", ref: `r${i}`, group: `g${i}`, asked_at: iso(60 - i), ...a })), file: async (x) => { filed.push(x); return { ok: true, note: "filed" }; } };
}

test("an answer is filed once, verbatim, whichever caller gets there first", async () => {
  const f = fakeFlow([{ question: "Where were you?" }]);
  const id = mid();
  const text = "This was the evening walk with the dog.";
  const a = await AR.routeAnswer({ messageId: id, text, conversationId: "role:software-engineer", flows: [f], ask: askOf([1]) });
  assert.equal(a.status, "filed");
  assert.equal(f.filed.length, 1);
  assert.equal(f.filed[0].text, text, "the user's words, untouched");
  assert.equal(f.filed[0].conversationId, "role:software-engineer");
  // The role session's prepare, and the coordinator, call it for the same message.
  const b = await AR.routeAnswer({ messageId: id, text, flows: [f], ask: askOf([1]) });
  assert.equal(b.status, "already_routed");
  assert.equal(b.previous.status, "filed");
  assert.equal(f.filed.length, 1, "filed once");
  assert.match(AR.routingBlock(b), /Answer already filed/);
  assert.match(AR.routingBlock(b), /Do NOT file it again/);
});

test("a message that answers nothing files nothing and costs no second reading", async () => {
  const f = fakeFlow([{ question: "Where were you?" }]);
  const id = mid();
  assert.equal((await AR.routeAnswer({ messageId: id, text: "What's the weather tomorrow?", flows: [f], ask: askOf([]) })).status, "none");
  assert.equal(f.filed.length, 0);
  let called = 0;
  const again = await AR.routeAnswer({ messageId: id, text: "What's the weather tomorrow?", flows: [f], ask: async () => { called++; return '{"answers":[]}'; } });
  assert.equal(again.status, "already_routed");
  assert.equal(called, 0);
  assert.equal(AR.routingBlock(again), "");
});

test("with nothing open there is no model call at all", async () => {
  let called = 0;
  const r = await AR.routeAnswer({ messageId: mid(), text: "hello there", flows: [fakeFlow([])], ask: async () => { called++; return "{}"; } });
  assert.equal(r.status, "no_open_questions");
  assert.equal(called, 0);
});

test("too-short messages and missing ids are skipped", async () => {
  const f = fakeFlow([{ question: "q" }]);
  assert.equal((await AR.routeAnswer({ messageId: mid(), text: "k", flows: [f], ask: askOf([1]) })).status, "skipped");
  assert.equal((await AR.routeAnswer({ text: "yes please", flows: [f], ask: askOf([1]) })).status, "skipped");
});

test("an unreadable message, or a flow that fails to file, is retried by the next caller, not lost", async () => {
  const f = fakeFlow([{ question: "Where were you?" }]);
  const id = mid();
  const down = await AR.routeAnswer({ messageId: id, text: "Home with Sam", flows: [f], ask: async () => { throw new Error("not logged in"); } });
  assert.equal(down.status, "unreadable");
  assert.equal(f.filed.length, 0);
  const ok = await AR.routeAnswer({ messageId: id, text: "Home with Sam", flows: [f], ask: askOf([1]) });
  assert.equal(ok.status, "filed", "the claim was dropped, so the role session's attempt goes through");

  const bad = { ...fakeFlow([{ question: "q" }]), file: async () => { throw new Error("cli exploded"); } };
  const id2 = mid();
  const e = await AR.routeAnswer({ messageId: id2, text: "an answer", flows: [bad], ask: askOf([1]) });
  assert.equal(e.status, "error");
  assert.equal(AR.routedOutcome(id2), null, "no claim left behind: nothing is marked answered");
});

test("a message answering two flows' questions reaches each flow once", async () => {
  const a = { ...fakeFlow([{ question: "A?" }]), id: "alpha" };
  const b = { ...fakeFlow([{ question: "B?" }]), id: "beta" };
  const wrap = (fl, name) => ({ ...fl, list: async () => (await fl.list()).map((x) => ({ ...x, flow: name })) });
  const A = wrap(a, "alpha"), B = wrap(b, "beta");
  const r = await AR.routeAnswer({ messageId: mid(), text: "A is yes and B is no", flows: [A, B], ask: askOf([1, 2]) });
  assert.equal(r.status, "filed");
  assert.equal(a.filed.length + b.filed.length, 2);
});

test("waitForOutcome returns what the first caller decided, or null for an unknown message", async () => {
  const f = fakeFlow([{ question: "Where?" }]);
  const id = mid();
  const first = AR.routeAnswer({ messageId: id, text: "home", flows: [f], ask: async () => { await new Promise((r) => setTimeout(r, 150)); return '{"answers":[1]}'; } });
  await new Promise((r) => setTimeout(r, 30));
  const waited = await AR.waitForOutcome(id, { timeoutMs: 5000, pollMs: 20 });
  assert.equal(waited.status, "filed");
  await first;
  assert.equal(await AR.waitForOutcome("never-seen", { timeoutMs: 50 }), null);
});

test("the kill switch turns the router off", async () => {
  fs.writeFileSync(path.join(process.env.JORI_DATA_DIR, ".answer-router-off"), "");
  try {
    const r = await AR.routeAnswer({ messageId: mid(), text: "home with Sam", flows: [fakeFlow([{ question: "q" }])], ask: askOf([1]) });
    assert.equal(r.status, "skipped");
  } finally { fs.rmSync(path.join(process.env.JORI_DATA_DIR, ".answer-router-off")); }
});

// ── the daily summary's fix loop, end to end ──────────────

const DAY = "2099-03-04";
function incidentDay() {
  writeDay(DAY, {
    status: AWAITING,
    created_at: iso(600),
    questions: [
      { n: 1, at: iso(300), text: "Around 11:01 to 11:38pm you were away from the house. Where were you?", held_until: iso(310), sent_at: iso(290) },
      { n: 2, at: iso(295), text: "Around 5:29 to 5:45pm you stopped about a five-minute walk from the house. Where were you?", held_until: iso(310), sent_at: iso(289) },
    ],
  });
}

test("open-asks lists what the user was asked and owes: not answered, not held, not dropped, not stale", () => {
  writeDay("2099-03-01", { status: "confirmed", questions: [
    { n: 1, at: iso(50), text: "answered already", answered_at: iso(40) },
    { n: 2, at: iso(50), text: "held for the quiet hours", held_until: iso(30), sent_at: null },
    { n: 3, at: iso(50), text: "dropped", dropped_at: iso(20) },
    { n: 4, at: iso(5000), text: "asked days ago, the sweep's business now" },
    { n: 5, at: iso(50), text: "an evening one, still open", evening: true },
  ] });
  const out = JSON.parse(fixer("open-asks").stdout);
  assert.deepEqual(out.filter((r) => r.date === "2099-03-01").map((r) => r.text), ["an evening one, still open"]);
  fs.rmSync(path.join(process.env.DS_FIX_DIR, "2099-03-01.json"));
});

test("the answer in a ROLE conversation registers on the day and queues the fixer", async () => {
  incidentDay();
  const flows = await AR.loadFlows();
  const id = mid();
  const text = "This was the evening walk with the dog. / I wasn't away from the house for that long. It was a short walk, not 40 minutes";
  const r = await AR.routeAnswer({
    messageId: id, text, conversationId: "role:software-engineer", flows: flows.filter((f) => f.id === "daily-summary-fix"),
    ask: async (prompt) => { assert.ok(prompt.includes("Where were you?") && prompt.includes(`the daily summary of ${DAY}`)); return '{"answers":[1,2]}'; },
  });
  assert.equal(r.status, "filed");
  assert.deepEqual(r.filed[0].asks, [`${DAY}#1`, `${DAY}#2`]);
  const s = readDay(DAY);
  assert.equal(s.answers.length, 1, "two matched questions of one day: one filing");
  assert.equal(s.answers[0].text, text);
  assert.equal(s.answers[0].message_id, id);
  assert.equal(s.status, "queued");
  assert.ok(fs.existsSync(path.join(process.env.DS_FIX_DIR, "queue", DAY)), "the fixer is queued (launchd QueueDirectories)");
});

test("the coordinator's own filing of the same reply is a no-op, by message id and by words", () => {
  const s = readDay(DAY);
  const text = s.answers[0].text;
  assert.match(fixer("request", DAY, "--answer", text, "--message-id", s.answers[0].message_id).stdout, /already recorded/);
  assert.match(fixer("request", DAY, "--answer", text).stdout, /already recorded/, "the chat agent passes the words without the id");
  assert.equal(readDay(DAY).answers.length, 1);
  assert.equal(readDay(DAY).requests.length, s.requests.length, "no second run queued");
  // A genuinely new answer to the same day still files.
  assert.match(fixer("request", DAY, "--answer", "And Sam stayed home").stdout, /queued/);
  assert.equal(readDay(DAY).answers.length, 2);
});

test("the same words well after the window are a new answer, not a repeat", () => {
  writeDay("2099-03-05", { status: AWAITING, questions: [], answers: [{ at: iso(60), text: "yes" }] });
  assert.match(fixer("request", "2099-03-05", "--answer", "yes").stdout, /queued/);
  assert.equal(readDay("2099-03-05").answers.length, 2);
});

// ── hum's open questions ─────────────────────────────────────────────────────

test("hum's flow lists only the plain questions: not location, not self-re-asking, not improvement offers", async () => {
  const OQ = await import("../lib/open-questions.mjs");
  const base = { at: iso(30) };
  OQ.recordAsked({ id: "q-plain", question: "Do you like long train rides?", lane: "taste", memory_hook: "taste", ...base });
  OQ.recordAsked({ id: "q-loc", question: "Where were you at 3pm?", lane: "location_context", ...base });
  OQ.recordAsked({ id: "q-fin", question: "What was that charge?", lane: "finance-review", ...base });
  OQ.recordAsked({ id: "q-imp", question: "Want me to change how hum works?", lane: "dream_asks", memory_hook: "hum_improvement:idea-1", ...base });
  const asks = await AR.humQuestionFlow.list();
  assert.deepEqual(asks.map((a) => a.ref), ["q-plain"]);
});

// ── card replies ─────────────────────────────────────────────────────────────

test("a typed reply to a decision card or a build question gets its filing line in a role session too", () => {
  const card = { metadata: { choices: JSON.stringify({ kind: "decision", ref: "dec-1", options: [{ label: "Yes" }, { label: "No" }] }) } };
  assert.match(cardReplyHint(card), /Decision card dec-1/);
  assert.match(cardReplyHint(card), /decision-answer --ref dec-1/);
  const build = { metadata: { choices: { handler: "build-park", ref: "20261121-1", options: [{ label: "A" }] } } };
  assert.match(cardReplyHint(build), /Build question 20261121-1/);
  assert.equal(cardReplyHint({ metadata: {} }), "");
  assert.equal(cardReplyHint(null), "");
  const ext = { metadata: { choices: { kind: "mine", ref: "x1" } } };
  assert.equal(cardReplyHint(ext, { mine: (p) => `hint for ${p.ref}` }), "hint for x1");
});
