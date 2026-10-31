// The partial-fetch guard in bin/broker-snapshot (lib/broker-partial-fetch.js).
//
// A bridge holding several OAuth grants degrades by answering HTTP 200 with
// only the surviving grants' accounts. The predicate has to separate that from
// the two benign shapes that look like it — a cosmetic account-list change and
// a market crash — so each is pinned below with synthetic figures of the same
// shape as the cases that motivated it.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  isPartialFetch, missingAccountNames, formatAccountList, PARTIAL_DROP_VALUE_PCT,
} = require("../lib/broker-partial-fetch.js");

test("blocks a lapsed grant: 5 of 8 accounts back, about half the value gone", () => {
  const baseline = { num_accounts: 8, total_value: 1_000_000 };
  const v = isPartialFetch(baseline, 5, 480_000);
  assert.equal(v.partial, true);
  assert.equal(v.missingAccounts, 3);
  assert.ok(v.valueDropPct > 0.5);
});

test("blocks every day of a multi-day run, not just the first", () => {
  const baseline = { num_accounts: 8, total_value: 1_000_000 };
  for (const total of [480_000, 473_000, 457_000, 479_000, 482_000]) {
    assert.equal(isPartialFetch(baseline, 5, total).partial, true);
  }
});

test("allows a cosmetic account-list change (10 -> 8, -2.4%)", () => {
  const baseline = { num_accounts: 10, total_value: 1_000_000 };
  const v = isPartialFetch(baseline, 8, 976_000);
  assert.equal(v.partial, false, "two near-empty accounts leaving the list is not a partial fetch");
  assert.equal(v.missingAccounts, 2);
});

test("allows a market crash when the account set is intact", () => {
  const baseline = { num_accounts: 8, total_value: 1_000_000 };
  assert.equal(isPartialFetch(baseline, 8, 600_000).partial, false);
});

test("allows a run with MORE accounts than the baseline", () => {
  assert.equal(isPartialFetch({ num_accounts: 8, total_value: 1_000_000 }, 10, 1_017_000).partial, false);
});

test("no baseline means no judgement (first ever run)", () => {
  assert.equal(isPartialFetch(null, 5, 480_000).partial, false);
  assert.equal(isPartialFetch({ num_accounts: 8, total_value: 0 }, 5, 0).partial, false);
});

test("threshold sits above every recorded single-session move and below a lapsed grant", () => {
  assert.ok(PARTIAL_DROP_VALUE_PCT > 0.205, "must not fire on a 1987-scale (-20.5%) crash");
  assert.ok(PARTIAL_DROP_VALUE_PCT < 0.52, "must fire on a ~-52% partial fetch");
});

// Naming: the alert says WHICH accounts did not come back, from the last good
// roster it already holds.
const ROSTER = [
  { hash: "h-hsa", name: "HSA" },
  { hash: "h-joint", name: "Joint Taxable" },
  { hash: "h-a401r", name: "Owner 401k Roth" },
  { hash: "h-aroth", name: "Owner Roth" },
  { hash: "h-atrad", name: "Owner Trad 401k" },
  { hash: "h-broth", name: "Spouse Roth" },
  { hash: "h-broth401", name: "Spouse Roth 401k" },
  { hash: "h-btrad", name: "Spouse Trad 401k" },
];

test("3 of 8 back names the 5 that did not", () => {
  const incoming = [{ accountHash: "h-hsa" }, { accountHash: "h-joint" }, { accountHash: "h-aroth" }];
  assert.deepEqual(missingAccountNames(ROSTER, incoming), [
    "Owner 401k Roth", "Owner Trad 401k", "Spouse Roth", "Spouse Roth 401k", "Spouse Trad 401k",
  ]);
});

test("one grant's worth missing reads as a sentence", () => {
  const incoming = ROSTER.filter((r) => !r.name.startsWith("Spouse")).map((r) => ({ accountHash: r.hash }));
  assert.equal(formatAccountList(missingAccountNames(ROSTER, incoming)), "Spouse Roth, Spouse Roth 401k and Spouse Trad 401k");
});

test("identity is the hash, never the display label", () => {
  const roster = [{ hash: "a", name: "Brokerage" }, { hash: "b", name: "Brokerage" }];
  assert.deepEqual(missingAccountNames(roster, [{ accountHash: "a" }]), ["Brokerage"]);
});

test("an unnamed account still points at something", () => {
  assert.deepEqual(missingAccountNames([{ hash: "abcdef123456", name: null }], []), ["account abcdef"]);
});

test("a failed roster read degrades to counts-only, never to a false roster", () => {
  assert.deepEqual(missingAccountNames([], [{ accountHash: "h-hsa" }]), []);
  assert.deepEqual(missingAccountNames(null, []), []);
});

test("a whole fetch names nothing", () => {
  assert.deepEqual(missingAccountNames(ROSTER, ROSTER.map((r) => ({ accountHash: r.hash }))), []);
});

test("formatAccountList reads as a sentence at 1, 2 and 3", () => {
  assert.equal(formatAccountList(["A"]), "A");
  assert.equal(formatAccountList(["A", "B"]), "A and B");
  assert.equal(formatAccountList(["A", "B", "C"]), "A, B and C");
  assert.equal(formatAccountList([]), "");
});
