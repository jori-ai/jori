// self-report-noise.test.mjs — the weekly "how often is Jori wrong about
// Jori" number (2026-10-06 Self Improvement Review, item 1).
//
// Run: node --test tests/self-report-noise.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSelfReportNoise } from "../lib/self-report-noise.mjs";

const NOW = Date.parse("2026-10-06T07:00:00Z");
const SINCE = NOW - 7 * 864e5;
const IN = "2026-10-03T12:00:00Z";
const OLD = "2026-09-01T12:00:00Z";

const CARD_NOISE = "aaaaaaaa-1111-4111-8111-111111111111";
const CARD_LABEL_T = "bbbbbbbb-2222-4222-8222-222222222222";
const CARD_LABEL_F = "cccccccc-3333-4333-8333-333333333333";
const CARD_OPEN = "dddddddd-4444-4444-8444-444444444444";
const CARD_OLD = "eeeeeeee-5555-4555-8555-555555555555";

const clusters = [
  { id: "sic-a", severity: "noise", last_seen: IN, attempts: [{ approval_id: CARD_NOISE }] },
  { id: "sic-b", severity: "noise", last_seen: OLD },
  { id: "sic-c", severity: "critical", last_seen: IN },
  { id: "sic-d", severity: "degraded", last_seen: IN },
];
const cards = [
  { id: CARD_NOISE, summary: "photo gap-recovery reports successes as failures", risk: "high", applied_at: IN },
  { id: CARD_LABEL_T, summary: "portfolio memo paged missing", risk: "moderate", applied_at: IN },
  { id: CARD_LABEL_F, summary: "add a new venue source", risk: "low", applied_at: IN },
  { id: CARD_OPEN, summary: "something else", risk: "high", applied_at: IN },
  { id: CARD_OLD, summary: "old fix", risk: "high", applied_at: OLD },
];

test("alert half: noise share of clusters active in the window, plus all time", () => {
  const r = computeSelfReportNoise({ clusters, cards: [], sinceMs: SINCE, nowMs: NOW });
  assert.equal(r.alerts.clusters_active, 3);
  assert.equal(r.alerts.noise_active, 1);
  assert.equal(r.alerts.noise_rate, 0.333);
  assert.deepEqual(r.alerts.noise_active_ids, ["sic-a"]);
  assert.equal(r.alerts.clusters_all_time, 4);
  assert.equal(r.alerts.noise_all_time, 2);
  assert.equal(r.alerts.noise_rate_all_time, 0.5);
});

test("fix half without labels: only the structural link counts, the rest is reported unlabelled", () => {
  const r = computeSelfReportNoise({ clusters, cards, sinceMs: SINCE, nowMs: NOW });
  assert.equal(r.fixes.applied, 4, "the out-of-window card is excluded");
  assert.equal(r.fixes.applied_signed, 2);
  assert.equal(r.fixes.applied_auto, 2);
  assert.deepEqual(r.fixes.linked_to_noise_cluster, [{ id: CARD_NOISE, cluster_id: "sic-a" }]);
  assert.equal(r.fixes.self_misreport, 1);
  assert.equal(r.fixes.complete, false);
  assert.deepEqual(r.fixes.unlabelled.map((u) => u.id), [CARD_LABEL_T, CARD_LABEL_F, CARD_OPEN]);
});

test("fix half with the model's labels (8-char prefixes accepted): final once nothing is unlabelled", () => {
  const labels = { [CARD_LABEL_T.slice(0, 8)]: true, [CARD_LABEL_F]: false, [CARD_OPEN]: true };
  const r = computeSelfReportNoise({ clusters, cards, labels, sinceMs: SINCE, nowMs: NOW });
  assert.equal(r.fixes.self_misreport, 3);
  assert.equal(r.fixes.self_misreport_rate, 0.75);
  assert.equal(r.fixes.complete, true);
  assert.deepEqual(r.fixes.labelled_not_misreport, [CARD_LABEL_F]);
});

test("a noise-cluster link outranks a false label — the structure already answered it", () => {
  const r = computeSelfReportNoise({ clusters, cards, labels: { [CARD_NOISE]: false }, sinceMs: SINCE, nowMs: NOW });
  assert.equal(r.fixes.linked_to_noise_cluster.length, 1);
  assert.equal(r.fixes.labelled_not_misreport.length, 0);
});

test("empty inputs give null rates, not NaN or a divide-by-zero", () => {
  const r = computeSelfReportNoise({ sinceMs: SINCE, nowMs: NOW });
  assert.equal(r.alerts.noise_rate, null);
  assert.equal(r.fixes.self_misreport_rate, null);
  assert.equal(r.fixes.complete, true);
});

test("non-boolean labels and too-short prefixes are ignored", () => {
  const r = computeSelfReportNoise({ clusters, cards, labels: { [CARD_OPEN]: "yes", [CARD_LABEL_T.slice(0, 4)]: true }, sinceMs: SINCE, nowMs: NOW });
  assert.equal(r.fixes.self_misreport, 1);
});
