// daily-summary-leg-modes.test.mjs — a riding leg the pace could not name is
// bus, cab or subway; a tap on the day settles it only when there is one such
// leg to settle. Never a bike without a micromobility charge or the user's words.
//
// 2026-09-08: the spine said riding/uncertain for the 13-minute trip home from
// the Lower East Side, mobility[] carried an MTA $3 tap, and the summary said
// "Biked back home".
//
// Run: node --test tests/daily-summary-leg-modes.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { _internal } = require("../lib/daily-summary-render.js");
const { settleLegModes } = _internal;

const ride = (id, over = {}) => ({ type: "leg", id, mode: "riding", mode_uncertain: true, ...over });
const walk = id => ({ type: "leg", id, mode: "walking", mode_uncertain: false });
const dwell = id => ({ type: "dwell", id });

test("one uncertain riding leg + one MTA tap → subway, settled, with the tap as evidence", () => {
  const out = settleLegModes([dwell("d0"), walk("l0"), dwell("d1"), ride("l1")],
    [{ merchant: "MTA", mode: "subway", amount_usd: "$3" }]);
  const leg = out[3];
  assert.equal(leg.mode, "subway");
  assert.equal(leg.mode_uncertain, false);
  assert.deepEqual(leg.mode_evidence, ["MTA $3"]);
  assert.deepEqual(leg.mode_candidates, []);
  assert.equal(out[1].mode, "walking");   // walking legs untouched
});

test("no tap → stays uncertain and lists the candidates; bike is not one of them", () => {
  const out = settleLegModes([ride("l1")], []);
  assert.equal(out[0].mode, "riding");
  assert.equal(out[0].mode_uncertain, true);
  assert.deepEqual(out[0].mode_candidates, ["subway", "bus", "cab"]);
  assert.ok(!out[0].mode_candidates.includes("bike"));
});

test("two uncertain legs and one tap → neither is settled, both carry the evidence", () => {
  const out = settleLegModes([ride("l1"), dwell("d"), ride("l2")], [{ merchant: "MTA", mode: "subway", amount_usd: "$3" }]);
  for (const leg of [out[0], out[2]]) {
    assert.equal(leg.mode, "riding");
    assert.equal(leg.mode_uncertain, true);
    assert.deepEqual(leg.mode_evidence, ["MTA $3"]);
    assert.equal(leg.mode_candidates[0], "subway");
  }
});

test("a Citi Bike charge is the only thing that makes a riding leg a bike", () => {
  const out = settleLegModes([ride("l1")], [{ merchant: "Citi Bike", mode: "micromobility", amount_usd: "$4.79" }]);
  assert.equal(out[0].mode, "bike");
  assert.equal(out[0].mode_uncertain, false);
});

test("taps of two different kinds cannot settle one leg", () => {
  const out = settleLegModes([ride("l1")], [
    { merchant: "MTA", mode: "subway", amount_usd: "$3" }, { merchant: "Uber", mode: "rideshare", amount_usd: "$22" },
  ]);
  assert.equal(out[0].mode, "riding");
  assert.deepEqual(out[0].mode_candidates.slice(0, 2), ["subway", "cab"]);
});

test("a parking or fuel charge says nothing about a riding leg", () => {
  const out = settleLegModes([ride("l1")], [{ merchant: "Icon Parking", mode: "parking", amount_usd: "$40" }]);
  assert.equal(out[0].mode, "riding");
  assert.deepEqual(out[0].mode_evidence, []);
});
