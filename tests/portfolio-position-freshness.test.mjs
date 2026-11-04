// lib/portfolio-position-freshness.mjs — the stale-positions wording, the
// preflight's paging window and the reconnect hint.
//
// The preflight gates on the PROJECTED age at run time (current age + lead
// time, assuming no further snapshot lands). Its alert used to report the
// OBSERVED age and claim that value was past the limit; whenever the two
// straddle the limit the sentence contradicts itself, which is precisely the
// case the check exists to catch.
import test from "node:test";
import assert from "node:assert/strict";
import {
  staleMessage, preflightShouldAlert, reconnectHint, PREFLIGHT_MAX_LEAD_H,
} from "../lib/portfolio-position-freshness.mjs";

const HINT = "Brokerage is not connected through Plaid, so `plaid-holdings-sync` cannot move this number";
const base = { runTimeLabel: "4:00 PM", hint: HINT, jobLabel: "weekly portfolio check", feedLabel: "brokerage" };

test("never attributes the limit crossing to the observed age", () => {
  const ageH = 10.8, asOf = "2026-01-11T21:45:01.279Z", limitH = 48;
  const msg = staleMessage({ ...base, ageH, asOf, projectedAgeH: 72.2, limitH });
  assert.ok(!msg.includes(`${ageH.toFixed(1)}h old (as of ${asOf}), past the ${limitH}h limit`), msg);
  assert.ok(!msg.includes(`already ${ageH.toFixed(1)}h old`), "the 'already Nh old' framing is the bug");
});

test("reports both the observed age and the projection it actually compared", () => {
  const msg = staleMessage({ ...base, ageH: 10.8, asOf: "2026-01-11T21:45:01.279Z", projectedAgeH: 72.2, limitH: 48 });
  assert.ok(msg.includes("10.8h old"));
  assert.ok(msg.includes("72.2h old at run time, past the 48h limit"));
  assert.ok(msg.includes("with no further snapshot before then"));
});

test("still reads correctly when the feed is genuinely dead, and keeps the hint", () => {
  const msg = staleMessage({ ...base, ageH: 88.0, asOf: "2026-01-07T21:45:00.729Z", projectedAgeH: 97.0, limitH: 48 });
  assert.ok(msg.includes("88.0h old"));
  assert.ok(msg.includes("97.0h old at run time, past the 48h limit"));
  assert.ok(msg.includes(HINT));
});

test("carries the run time and the job it is warning about", () => {
  const msg = staleMessage({ ...base, ageH: 50, asOf: "2026-01-10T21:45:00.000Z", projectedAgeH: 58, limitH: 48 });
  assert.ok(msg.includes("The upcoming 4:00 PM weekly portfolio check is on track to skip"));
  assert.ok(msg.includes("the newest brokerage positions"));
});

test("does not page from outside the window it was designed for", () => {
  // Run two days ahead of the job it warns about, against a healthy feed.
  assert.equal(preflightShouldAlert({ leadH: 61.4 }), false);
  assert.equal(preflightShouldAlert({ leadH: 61.0 }), false);
});

test("pages from its scheduled slot (evening before, or the same morning)", () => {
  assert.equal(preflightShouldAlert({ leadH: 22 }), true);
  assert.equal(preflightShouldAlert({ leadH: 8 }), true);
  assert.equal(preflightShouldAlert({ leadH: 0.1 }), true);
});

test("the window boundary is inclusive and derived, not incidental", () => {
  assert.equal(PREFLIGHT_MAX_LEAD_H, 24, "one full daily-snapshot cycle");
  assert.equal(preflightShouldAlert({ leadH: PREFLIGHT_MAX_LEAD_H }), true);
  assert.equal(preflightShouldAlert({ leadH: PREFLIGHT_MAX_LEAD_H + 0.1 }), false);
});

test("an unmeasurable lead does not page", () => {
  assert.equal(preflightShouldAlert({ leadH: NaN }), false);
  assert.equal(preflightShouldAlert({ leadH: undefined }), false);
});

test("the hint names the feed that produced the newest stamp", () => {
  const cfg = { label: "brokerage", snapshot_command: "broker-snapshot", app_label: "the bridge app", api_url: "https://bridge.example.test" };
  assert.match(reconnectHint("broker-plaid", true, cfg), /Re-link the brokerage item in Plaid/);
  assert.match(reconnectHint("broker-direct", true, cfg), /^Both brokerage feeds are behind/);
  const direct = reconnectHint("broker-direct", false, cfg);
  assert.match(direct, /^Brokerage is not connected through Plaid/);
  assert.match(direct, /`broker-snapshot`/);
  assert.match(direct, /\(bridge\.example\.test\)$/);
  assert.match(reconnectHint("??", false, cfg), /check both `broker-snapshot` and `plaid-holdings-sync`/);
});
