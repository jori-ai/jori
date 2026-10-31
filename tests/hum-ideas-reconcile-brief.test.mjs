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
import { brief, text } from "../bin/hum-ideas-brief";

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
