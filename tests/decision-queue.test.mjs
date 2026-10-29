// decision-queue.test.mjs — the hum `decisions` lane (2026-10-22): one waiting
// decision a day in chat, most important first, as an AskUserQuestion-style
// card with the recommended option first, and the user's answer written back to the planner / cost review source entry.
// Run: node --test tests/decision-queue.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.resolve(HERE, "..");
const { REPO_ROOT } = createRequire(import.meta.url)("../lib/root.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "decision-queue-"));
process.env.JORI_DATA_DIR = tmp;
const dq = await import("../lib/decision-queue.mjs");
const { humStateBlock } = await import("../lib/hum-reply-target.mjs");

const IMP = path.join(tmp, "improvement-plan-state.json");
const COST = path.join(tmp, "cost-efficiency-review-state.json");
const LANE = path.join(tmp, "decision-lane-state.json");

function seed() {
  fs.writeFileSync(IMP, JSON.stringify({
    schema_version: 1,
    plan: ["untouched"],
    questions: [
      { source: "si-1", rank: 3, question: "Ranked three?", options: ["A", "B"], asked_at: "2026-10-06T08:00:00Z", status: "open" },
      { source: "si-2", rank: 1, question: "Ranked one?", options: ["Yes, do it", "No"], recommended: 0, asked_at: "2026-10-13T08:00:00Z", status: "open" },
      { source: "si-3", question: "Answered already", options: ["x", "y"], asked_at: "2026-10-01T00:00:00Z", status: "answered" },
      { source: "si-4", question: "One option only", options: ["only"], asked_at: "2026-10-01T00:00:00Z", status: "open" },
    ],
  }));
  fs.writeFileSync(COST, JSON.stringify({
    history: [],
    questions: [
      { id: "q-urgent", asked_at: "2026-10-19T06:50Z", question: "Urgent cost call?", options: ["Keep", "Trim", "Cap"], recommendation: "Keep it a week", time_sensitive: true, status: "open" },
    ],
  }));
  try { fs.unlinkSync(LANE); } catch {}
}

test("loads open decisions from both sources, skipping answered and single-option ones", () => {
  seed();
  const items = dq.loadOpen();
  assert.equal(items.length, 3);
  assert.ok(items.some((i) => i.ref === "cost:q-urgent"));
  assert.ok(items.every((i) => i.ref.startsWith("cost:") || i.ref.startsWith("imp:")));
});

test("refs are stable for the same entry", () => {
  const q = { asked_at: "2026-10-06T08:00:00Z", question: "Ranked three?" };
  assert.equal(dq.refFor("improvement", q), dq.refFor("improvement", { ...q, options: ["changed"] }));
});

test("most important first: time-sensitive, then planner rank, then oldest", () => {
  seed();
  const order = dq.orderDecisions(dq.loadOpen()).map((i) => i.q.question);
  assert.deepEqual(order, ["Urgent cost call?", "Ranked one?", "Ranked three?"]);
});

test("one a day, and a decision asked this week is not re-asked", () => {
  seed();
  const now = Date.parse("2026-10-22T15:00:00Z");
  const first = dq.nextDecision({ now, tz: "UTC" });
  assert.equal(first.decision.ref, "cost:q-urgent");
  assert.equal(first.waiting, 3);
  const laneToday = { asked: [{ ref: "cost:q-urgent", at: "2026-10-22T09:00:00Z" }] };
  assert.equal(dq.nextDecision({ now, tz: "UTC", lane: laneToday }).decision, null);
  const laneYesterday = { asked: [{ ref: "cost:q-urgent", at: "2026-10-21T09:00:00Z" }] };
  assert.equal(dq.nextDecision({ now, tz: "UTC", lane: laneYesterday }).decision.q.question, "Ranked one?");
  const laneOld = { asked: [{ ref: "cost:q-urgent", at: "2026-10-10T09:00:00Z" }] };
  assert.equal(dq.nextDecision({ now, tz: "UTC", lane: laneOld }).decision.ref, "cost:q-urgent");
});

test("the card: recommended option first and marked, numbered, with Type something", async () => {
  seed();
  const item = dq.loadOpen().find((i) => i.ref === "cost:q-urgent");
  const judgeFn = async () => ({
    header: "Cost",
    question: "Keep the summary fix loop running as it is?",
    options: [
      { source_index: 0, label: "Keep it a week", description: "Re-check on Oct 26" },
      { source_index: 1, label: "Trim effort", description: "About a third cheaper" },
      { source_index: 2, label: "Cap at two runs", description: "Leftovers wait a day" },
    ],
    recommended_source_index: 1,
  });
  const card = await dq.buildCard(item, { lane: { cards: {} }, judgeFn });
  const { choices, text } = dq.renderDecision(item, card, { now: Date.parse("2026-10-22T15:00:00Z"), promptId: "p1" });
  assert.equal(choices.kind, "decision");
  assert.equal(choices.ref, "cost:q-urgent");
  assert.equal(choices.header, "Cost");
  assert.equal(choices.options[0].label, "Trim effort");
  assert.equal(choices.recommended_id, "o1");
  assert.equal(choices.options[0].value, "Trim");
  assert.equal(choices.options[0].sublabel, "About a third cheaper");
  assert.equal(choices.free_text, true);
  assert.equal(choices.v, 1);
  assert.ok(text.startsWith("❓ Cost"));
  assert.ok(text.includes("**Keep the summary fix loop running as it is?**"));
  assert.ok(text.includes("1. Trim effort (Recommended)"));
  assert.ok(text.includes("   About a third cheaper"));
  assert.ok(text.includes("4. Type something"));
});

test("a card that drops or duplicates an option falls back to the source wording", async () => {
  seed();
  const item = dq.loadOpen().find((i) => i.ref === "cost:q-urgent");
  const bad = async () => ({ header: "x", question: "q", options: [{ source_index: 0, label: "a", description: "" }, { source_index: 0, label: "b", description: "" }], recommended_source_index: 0 });
  const card = await dq.buildCard(item, { lane: { cards: {} }, judgeFn: bad });
  assert.equal(card.fallback, true);
  assert.deepEqual(card.options.map((o) => o.label), ["Keep", "Trim", "Cap"]);
  const thrown = await dq.buildCard(item, { lane: { cards: {} }, judgeFn: async () => { throw new Error("Not logged in"); } });
  assert.equal(thrown.fallback, true);
});

test("the fallback uses the planner's given recommended index", () => {
  seed();
  const item = dq.loadOpen().find((i) => i.q.question === "Ranked one?");
  const { choices, text } = dq.renderDecision(item, dq.fallbackCard(item), { promptId: "p" });
  assert.equal(choices.options[0].label, "Yes, do it");
  assert.equal(choices.recommended_id, "o1");
  assert.ok(text.includes("1. Yes, do it (Recommended)"));
});

test("recordAnswer writes back to the source entry and leaves the rest of the file alone", () => {
  seed();
  const imp = dq.loadOpen().find((i) => i.q.question === "Ranked one?");
  fs.writeFileSync(LANE, JSON.stringify({ asked: [{ ref: imp.ref, at: new Date().toISOString() }], cards: {} }));
  const r = dq.recordAnswer({ ref: imp.ref, answer: "Yes, do it", kind: "option", now: new Date("2026-10-22T16:00:00Z") });
  assert.equal(r.ok, true);
  const doc = JSON.parse(fs.readFileSync(IMP, "utf8"));
  const q = doc.questions.find((x) => x.source === "si-2");
  assert.equal(q.status, "answered");
  assert.equal(q.answer, "Yes, do it");
  assert.equal(q.answered_at, "2026-10-22T16:00:00.000Z");
  assert.equal(q.answered_via, "chat-decision");
  assert.deepEqual(doc.plan, ["untouched"]);
  assert.ok(JSON.parse(fs.readFileSync(LANE, "utf8")).asked[0].answered_at);
  assert.equal(dq.recordAnswer({ ref: imp.ref, answer: "No", kind: "option" }).already, true);

  const c = dq.recordAnswer({ ref: "cost:q-urgent", answer: "keep it, but look again Monday", kind: "text" });
  assert.equal(c.ok, true);
  const cq = JSON.parse(fs.readFileSync(COST, "utf8")).questions[0];
  assert.equal(cq.status, "answered:keep it, but look again Monday");
  assert.equal(cq.answer_kind, "own_words");
  assert.equal(dq.recordAnswer({ ref: "imp:nope", answer: "x", kind: "text" }).ok, false);
});

test("decision-answer CLI: exact option or card label only; --text for the user's words", () => {
  seed();
  const env = { ...process.env, JORI_DATA_DIR: tmp };
  const bin = path.join(TOOLS, "bin/decision-answer");
  const imp = dq.loadOpen().find((i) => i.q.question === "Ranked three?");
  fs.writeFileSync(LANE, JSON.stringify({ asked: [], cards: { [imp.ref]: { card: { options: [{ source_index: 1, label: "Go with B" }] } } } }));
  const refused = spawnSync(process.execPath, [bin, "--ref", imp.ref, "--option", "b"], { env, encoding: "utf8" });
  assert.equal(refused.status, 4, "no case folding or fuzzy match");
  const ok = spawnSync(process.execPath, [bin, "--ref", imp.ref, "--option", "Go with B"], { env, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).answer, "B", "a card label files the source option's text");
  const text = spawnSync(process.execPath, [bin, "--ref", "cost:q-urgent", "--text", "cap it"], { env, encoding: "utf8" });
  assert.equal(text.status, 0, text.stderr);
});

test("decision-ask --dry-run renders the lane's pick (no model: source wording)", () => {
  seed();
  const env = { ...process.env, JORI_DATA_DIR: tmp, CLAUDE_BIN: "/nonexistent/claude" };
  const r = spawnSync(process.execPath, [path.join(TOOLS, "bin/decision-ask"), "--next", "--dry-run"], { env, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ref, "cost:q-urgent");
  assert.equal(out.choices.kind, "decision");
  assert.ok(out.text.includes("Type something"));
});

test("the harvester nominates the top decision as a decisions candidate, then goes quiet for the day", () => {
  seed();
  const env = { ...process.env, JORI_DATA_DIR: tmp, HUM_HARVEST_PREVIEW: "1" };
  const script = path.join(TOOLS, "agent/scripts/hum-harvesters/decisions.mjs");
  const r = spawnSync(process.execPath, [script], { env, input: "{}", encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(c.topic, "decisions");
  assert.equal(c.supporting_data.kind, "decision");
  assert.equal(c.supporting_data.decision_ref, "cost:q-urgent");
  assert.equal(c.dedup_key, "decision:cost:q-urgent");
  fs.writeFileSync(LANE, JSON.stringify({ asked: [{ ref: "cost:q-urgent", at: new Date().toISOString() }] }));
  const r2 = spawnSync(process.execPath, [script], { env, input: "{}", encoding: "utf8" });
  assert.equal(r2.stdout.trim().split("\n").pop(), "null");
});

test("[Hum state] tells the chat agent about an unanswered decision card", () => {
  seed();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decision-humstate-"));
  fs.writeFileSync(path.join(dir, "decision-lane-state.json"), JSON.stringify({ asked: [{ ref: "cost:q-urgent", at: new Date(Date.now() - 30 * 60000).toISOString() }] }));
  assert.ok(humStateBlock(dir).includes("decision-answer --ref cost:q-urgent"));
  fs.writeFileSync(path.join(dir, "decision-lane-state.json"), JSON.stringify({ asked: [{ ref: "cost:q-urgent", at: new Date().toISOString(), answered_at: new Date().toISOString() }] }));
  assert.ok(!humStateBlock(dir).includes("Decision card"));
});

// ─── the reply after a tap: what the answer leads to, and by when ─────────
// (2026-10-27: every tap got the same "recorded, I'll act on it at the
// next review run", which said nothing about what happens or when.)
const NY = "US/Eastern"; // EST after Nov 1
const SCHED = { "nightly-review": "0 5 * * 2", "cost-efficiency-review": "37 2 * * *", "people-watch": "5 3 * * *" };
const TUE_3PM = Date.parse("2026-10-27T19:00:00Z");

test("nextRun reads a cron schedule in the scheduler's zone, across a clock change", () => {
  assert.equal(new Date(dq.nextRun("0 5 * * 2", TUE_3PM, NY)).toISOString(), "2026-11-03T10:00:00.000Z", "EST after Nov 1");
  assert.equal(new Date(dq.nextRun("37 2 * * *", TUE_3PM, NY)).toISOString(), "2026-10-28T06:37:00.000Z");
  assert.equal(new Date(dq.nextRun("41 9-21 * * *", TUE_3PM, NY)).toISOString(), "2026-10-27T19:41:00.000Z");
  assert.equal(dq.nextRun("0 0 1 * *", TUE_3PM, NY), null, "day-of-month schedules are not guessed");
  assert.equal(dq.nextRun(null, TUE_3PM, NY), null);
});

test("followUp names the job that acts on the answer and when, from the registry schedule", () => {
  const at = (ref, now) => dq.followUp(ref, { now, tz: NY, schedTz: NY, scheduleOf: (n) => SCHED[n] });
  const imp = at("imp:abc", TUE_3PM);
  assert.equal(imp.who, "the weekly improvement planner");
  assert.equal(imp.when, "by next Tuesday morning");
  assert.equal(imp.after, "right after the weekly review");
  assert.equal(at("imp:abc", Date.parse("2026-10-31T16:00:00Z")).when, "by Tuesday morning");
  assert.equal(at("cost:q", TUE_3PM).when, "by tomorrow morning");
  assert.equal(at("cost:q", Date.parse("2026-10-28T05:00:00Z")).when, "by this morning", "1am: tonight's run");
  assert.equal(at("ppl:x", TUE_3PM).who, "the people tracker");
  assert.equal(dq.followUp("imp:abc", { now: TUE_3PM, scheduleOf: () => null }).when, null, "no schedule, no promised time");
  assert.equal(dq.followUp("zzz:1", { now: TUE_3PM }), null);
});

test("the reply says what happens next and when, never the old canned line or 'undefined'", async () => {
  const { decisionReply } = await import("../lib/choice-reply.mjs");
  const cost = decisionReply({ next: { who: "the nightly cost review", does: "acts on it", after: null, when: "by tomorrow morning", changes_nothing: null } }, "cost:q");
  assert.ok(cost.endsWith("The nightly cost review picks it up by tomorrow morning and acts on it."), cost);
  const imp = decisionReply({ next: { ...dq.followUp("imp:abc", { now: TUE_3PM, tz: NY, schedTz: NY, scheduleOf: (n) => SCHED[n] }), changes_nothing: false } }, "imp:abc");
  assert.ok(imp.endsWith("The weekly improvement planner picks it up by next Tuesday morning, right after the weekly review, and plans whatever your answer unblocks."), imp);
  assert.equal(decisionReply({ next: { who: "the nightly cost review", changes_nothing: true } }), "Okay, we'll leave it as it is, so nothing changes.");
  assert.ok(decisionReply({ already_answered: true }).includes("already settled"));
  for (const r of [decisionReply({}), decisionReply(null), decisionReply({ next: { who: "the people tracker" } })]) {
    assert.ok(r.includes("next run") && !r.includes("undefined"), r);
  }
  const src = fs.readFileSync(path.join(TOOLS, "lib/choice-reply.mjs"), "utf8");
  assert.ok(!src.includes("act on it at the next review run"));
});

test("a tapped decision answers in code with the job, the time and the option's own effect", async () => {
  seed();
  process.env.JORI_HOME = REPO_ROOT;
  process.env.JORI_CHOICE_HANDLERS = path.join(tmp, "no-overlay.mjs");
  const { handleChoiceReply } = await import("../lib/choice-reply.mjs");
  const item = dq.loadOpen().find((i) => i.ref === "cost:q-urgent");
  const judgeFn = async () => ({
    header: "Cost", question: "Keep the fix loop?", recommended_source_index: 1,
    options: [
      { source_index: 0, label: "Keep it a week", description: "", changes_nothing: true },
      { source_index: 1, label: "Trim effort", description: "", changes_nothing: false },
      { source_index: 2, label: "Cap at two runs", description: "" },
    ],
  });
  const card = await dq.buildCard(item, { lane: { cards: {} }, judgeFn });
  assert.equal(card.options[0].changes_nothing, true);
  assert.ok(!("changes_nothing" in card.options[2]), "an option without the flag stays unflagged");
  const { choices } = dq.renderDecision(item, card, { promptId: "p" });
  assert.ok(choices.options.every((o) => !("changes_nothing" in o)), "the flag never reaches the card");
  const tap = async (label) => {
    fs.writeFileSync(LANE, JSON.stringify({ asked: [], cards: { [item.ref]: { question_hash: dq.hashQuestion(item.q), card } } }));
    const supabase = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: "m1", metadata: { choices } } }) }) }) }) };
    return handleChoiceReply(supabase, { reply_to: "m1", role: "user" }, label);
  };
  const trim = await tap("Trim effort");
  assert.equal(trim.handled, true);
  assert.ok(trim.reply.includes("The nightly cost review picks it up by ") && trim.reply.endsWith("and acts on it."), trim.reply);
  assert.ok(!trim.reply.includes("undefined"));
  assert.ok(JSON.parse(fs.readFileSync(COST, "utf8")).questions[0].status.startsWith("answered:Trim"));
  seed();
  assert.equal((await tap("Keep it a week")).reply, "Okay, we'll leave it as it is, so nothing changes.");
});
