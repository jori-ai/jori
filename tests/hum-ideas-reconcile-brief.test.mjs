// hum-ideas-reconcile-brief.test.mjs — the hum-idea ledger reconcile
// (bin/hum-ideas-reconcile `nextState`: the approval card's real status decides
// what the ledger says) and the weekly brief (bin/hum-ideas-brief: what
// landed, what waits, the structural ideas that need the user's call).
// Synthetic installation; no network, no model.
// Run: node --test tests/hum-ideas-reconcile-brief.test.mjs
import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { manualScope } from "../lib/hum-ideas.mjs";
import { nextState } from "../bin/hum-ideas-reconcile";
import { brief, text, answersById } from "../bin/hum-ideas-brief";

const MANUAL = manualScope();
const idea = (o) => ({ id: "i", scope: "jori_autonomous", risk: "low", effort: "quick", status: "proposed", ...o });
const NOW = Date.parse("2026-10-10T12:00:00Z");
const ask = (id, o) => idea({ id, scope: MANUAL, proposed_at: "2026-06-01", ...o });

test("reconcile: the card's real status decides what the ledger says", () => {
  assert.deepEqual(nextState({ status: "applied", applied_at: "2026-08-25T18:26:03Z" }), { status: "applied", applied_at: "2026-08-25T18:26:03Z" });
  assert.equal(nextState({ status: "failed" }).status, "proposed");
  assert.equal(nextState({ status: "pending", skipped: true }).status, "proposed");
  assert.equal(nextState({ status: "expired" }).status, "proposed");
  assert.equal(nextState({ status: "pending", expires_at: "2026-01-01T00:00:00Z" }, NOW).status, "proposed");
  assert.equal(nextState({ status: "pending", expires_at: "2099-01-01T00:00:00Z" }, NOW), null); // still live: leave it
  assert.equal(nextState(undefined), null);
});

test("weekly brief: what landed, what waits, and the big ones that need the user's call", () => {
  const ideas = [
    idea({ id: "new", status: "applied", applied_at: "2026-10-08T00:00:00Z", title: "Landed this week" }),
    idea({ id: "old", status: "applied", applied_at: "2026-08-01T00:00:00Z" }),
    idea({ id: "big", effort: "multi-day", title: "Rebuild the ranker", proposed_change: "A new ranking stage" }),
    idea({ id: "card", status: "awaiting_approval" }),
    ask("chat"),
  ];
  const b = brief(ideas, NOW);
  assert.deepEqual(b.landed.map((i) => i.id), ["new"]);
  assert.deepEqual(b.structural.map((i) => i.id), ["big"]);
  assert.deepEqual(b.asking_in_chat.map((i) => i.id), ["chat"]);
  assert.deepEqual(b.cards_waiting.map((i) => i.id), ["card"]);
  assert.ok(text(b).includes("Rebuild the ranker"));
  assert.ok(text(brief([], NOW)).includes("Landed: nothing this week."));
});

test("weekly brief: an answered ask is not 'being asked', and a row that is not an idea is not structural", () => {
  const ideas = [
    ask("open", { title: "Still waiting" }),
    ask("done", { title: "Answered already" }),
    { id: "resolved-question", consumed: true, consumed_at: "2026-10-09T00:00:00Z", resolution: "settled by email" },
  ];
  const answers = answersById([
    { ts: "2026-10-09T19:44:52Z", lane: "hum_improvement:done", disposition: "answered", reply_text: "Keep it as is." },
    { ts: "2026-10-09T19:50:00Z", lane: "hum_improvement:open", disposition: "deferred", reply_text: "later" },
    { ts: "2026-10-09T19:55:00Z", lane: "dining", disposition: "answered", reply_text: "not about an idea" },
  ]);
  const b = brief(ideas, NOW, 7, answers);
  assert.deepEqual(b.asking_in_chat.map((i) => i.id), ["open"]);
  assert.deepEqual(b.answered_not_acted_on.map((i) => [i.id, i.answer]), [["done", "Keep it as is."]]);
  assert.deepEqual(b.structural, []);
  assert.ok(text(b).includes("not yet recorded on the idea (1): Answered already"));
  // Without the answers log the brief reads as before.
  assert.deepEqual(brief(ideas, NOW).asking_in_chat.map((i) => i.id), ["open", "done"]);
});
