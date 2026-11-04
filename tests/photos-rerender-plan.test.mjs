// photos-daily stale-render repair ladder: normal → silent → give up once.
// It once re-sent an old day's full summary three nights running
// because "has a prior attempt run?" was an agent `ls | grep` judgment.
// Run: node --test tests/photos-rerender-plan.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { plan } from "../lib/photos-rerender-ledger.mjs";

const day = 86400_000;
const t0 = Date.parse("2099-02-04T07:00:00Z");

test("ladder: normal, silent, give-up, then skip", () => {
  let led = {};
  const modes = [];
  for (let i = 0; i < 4; i++) {
    const r = plan(led, ["2099-01-10"], t0 + i * day);
    modes.push(r.plan[0].mode);
    led = r.ledger;
  }
  assert.deepEqual(modes, ["normal", "silent", "give-up", "skip"]);
});

test("attempts older than 7 days are forgotten", () => {
  const r1 = plan({}, ["2099-01-10"], t0);
  const r2 = plan(r1.ledger, ["2099-01-10"], t0 + 8 * day);
  assert.equal(r2.plan[0].mode, "normal");
});

test("dates are independent", () => {
  const r1 = plan({}, ["2099-01-10"], t0);
  const r2 = plan(r1.ledger, ["2099-01-10", "2099-01-11"], t0 + day);
  assert.deepEqual(r2.plan.map((p) => p.mode), ["silent", "normal"]);
});
