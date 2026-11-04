// plaid-merchant-history-alert.test — a charge alert may only say "well above"
// what the user has paid a merchant before when it actually is, and a charge never
// counts as its own history.
//
// 2026-10-17: a card-charge alert told the user a charge was "well above" their
// earlier payment to that merchant when it was about a fifth of it. With
// exactly one prior charge, buildAlerts skipped the familiar-merchant check
// (it required two) and fell through to the "well above" wording regardless of
// the amount. Now one prior charge is judged like several: at or within 25% of
// the user's high-water mark with them is expected and does not alert; only a charge
// more than 25% above it alerts, and only then says "well above".
//
// The two-charge rule had also been hiding a second fault. The history counted
// pending rows, and Plaid sometimes delivers a posted charge one sync before it
// removes the pending copy that charge replaces — so a merchant never seen
// before looked like one with a single prior charge of exactly this amount.
// History is now posted charges only, minus the charge itself and its own
// pending copy (by pending_transaction_id).
//
// Everything here is synthetic — invented merchants, ids and amounts, no bank
// rows. No network: the Supabase REST helper is replaced in-process before
// plaid-sync loads, so merchantHistory() reads the fixture table below (with
// PostgREST's filters applied as the real table would) and the
// transfer-pairing lookup finds nothing. Only GETs are expected; anything
// else, or a filter the fake does not understand, fails the test.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Pin the thresholds this file's amounts are chosen against. load-env never
// overrides a value already set, so .env cannot move them.
process.env.PLAID_ALERT_LARGE_TXN = "500";
process.env.PLAID_ALERT_LARGE_DEPOSIT = "1000";

// Stored rows by merchant: { id, amount, pending }. The charge being judged is
// in here too, because in production upsertTransactions() has already stored
// it — merchantHistory() must exclude it, and the fake honours that exclusion.
let TABLE = {};
const calls = [];
const rest = require("../lib/supabase-rest.js");
const realRequest = rest.request;
let stubbed = false;

const KNOWN = new Set(["select", "date", "merchant_name", "pending", "transaction_id", "limit"]);
const op = (v, prefix) => {
  if (!v.startsWith(prefix)) throw new Error(`fake PostgREST: expected ${prefix} in ${v}`);
  return v.slice(prefix.length);
};

async function fakeRequest(pathAndQuery, opts = {}) {
  const method = opts.method || "GET";
  calls.push({ method, pathAndQuery });
  if (method !== "GET") throw new Error(`unexpected ${method} ${pathAndQuery}`);
  const [route, query = ""] = pathAndQuery.split("?");
  if (route !== "/rest/v1/plaid_transactions") throw new Error(`unexpected route ${route}`);
  const qs = new URLSearchParams(query);
  // Transfer-pairing lookup (select=transaction_id,...): no other leg exists.
  if (qs.get("select") !== "amount") return [];
  for (const k of qs.keys()) if (!KNOWN.has(k)) throw new Error(`fake PostgREST: unhandled filter ${k}`);
  for (const d of qs.getAll("date")) op(d, "gte.");
  const merchant = op(qs.get("merchant_name") || "eq.", "eq.");
  const exclude = qs.getAll("transaction_id").map((v) => op(v, "neq."));
  const pendingFilter = qs.get("pending"); // null = no filter
  const wantPending = pendingFilter === null ? null
    : ({ "is.false": false, "eq.false": false, "is.true": true, "eq.true": true })[pendingFilter];
  if (wantPending === undefined) throw new Error(`fake PostgREST: unhandled pending=${pendingFilter}`);
  return (TABLE[merchant] || [])
    .filter((r) => !exclude.includes(r.id))
    .filter((r) => wantPending === null || r.pending === wantPending)
    .map((r) => ({ amount: r.amount }));
}

// The fake answers only while one of this file's buildAlerts calls is in
// flight; otherwise it delegates to the real helper, so a shared-process run
// (--test-isolation=none) leaves the other plaid tests exactly as they were.
rest.request = (p, o) => (stubbed ? fakeRequest(p, o) : realRequest(p, o));

// plaid-sync takes its `request` when it loads, so it must load after the
// swap — and as a fresh copy, in case another test file in the same process
// already loaded it holding the real helper.
const syncPath = require.resolve("../bin/plaid-sync");
delete require.cache[syncPath];
const { buildAlerts } = require(syncPath);
// And with no key, nothing that slips past the fake can reach the live table.
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;

beforeEach(() => { TABLE = {}; calls.length = 0; });

// A posted charge as Plaid delivers it. `pendingId` is the pending copy it
// replaces (Plaid's pending_transaction_id), when there was one.
const charge = (id, merchant, amount, { pendingId = null, date = "2026-10-17" } = {}) => ({
  transaction_id: id, pending_transaction_id: pendingId, account_id: "card", amount, date, pending: false,
  name: merchant.toUpperCase(), merchant_name: merchant,
  personal_finance_category: { primary: "GENERAL_SERVICES", detailed: "GENERAL_SERVICES_OTHER" },
});

// priorAmounts: earlier POSTED charges at this merchant. extraRows: anything
// else sitting in the table (a pending copy, say). The charge itself is always
// stored too, as it is in production by the time alerts are built.
async function alertFor(t, priorAmounts, extraRows = []) {
  TABLE[t.merchant_name] = [
    ...priorAmounts.map((amount, i) => ({ id: `prior-${i}`, amount, pending: false })),
    ...extraRows,
    { id: t.transaction_id, amount: t.amount, pending: false },
  ];
  stubbed = true;
  let alerts;
  try {
    alerts = await buildAlerts("Card", [t], [], [t], new Set(), { card: "credit" });
  } finally {
    stubbed = false;
  }
  assert.ok(calls.length > 0, "the fake answered: stored rows were consulted");
  assert.ok(calls.every((c) => c.method === "GET"), "buildAlerts only reads");
  return alerts;
}

test("one prior charge, this one about a fifth of it: no alert, and never 'well above'", async () => {
  const t = charge("c1", "Harbor Light Studio", 812.4);
  const alerts = await alertFor(t, [4100]);
  assert.deepEqual(alerts, [], alerts.join(" | "));
});

test("one prior charge, this one a little above it but within 25%: no alert", async () => {
  const t = charge("c2", "Quarry Lane Builders", 1150);
  assert.deepEqual(await alertFor(t, [1000]), []);
});

test("one prior charge, exactly 25% above it: still expected, no alert", async () => {
  const t = charge("c3", "Fennel & Oak Catering", 1250);
  assert.deepEqual(await alertFor(t, [1000]), []);
});

test("one prior charge, this one far above it: alerts and the comparison is true", async () => {
  const t = charge("c4", "Northgate Glassworks", 2600);
  const [line, ...rest] = await alertFor(t, [1000]);
  assert.equal(rest.length, 0);
  assert.equal(line, "Card: Charge: $2,600.00 at Northgate Glassworks (2026-10-17) — well above the $1,000.00 you've paid them before.");
});

test("several prior charges keep working as before: in line is silent, far above alerts", async () => {
  assert.deepEqual(await alertFor(charge("c5", "Pine Hollow Electric", 900), [700, 850, 600]), []);
  const [line] = await alertFor(charge("c6", "Pine Hollow Electric", 1400), [700, 850, 600]);
  assert.ok(line.includes("well above the $850.00 you've paid them before"), line);
});

test("a merchant never seen before still alerts as a first charge", async () => {
  const [line] = await alertFor(charge("c7", "Saltmarsh Outfitters", 950), []);
  assert.ok(line.endsWith("— first charge from this merchant."), line);
});

test("the posted row itself, already stored, is not its own history", async () => {
  // Only the new charge is stored: after excluding it there is no history.
  const t = charge("c8", "Bellwether Tiles", 3000);
  const [line] = await alertFor(t, []);
  assert.ok(line.includes("first charge from this merchant"), line);
});

// ── The charge's own pending copy (the critic's finding on this fix) ─────────

test("a first charge whose pending copy is still stored alerts as a first charge", async () => {
  const t = charge("c9", "Tidewater Roofing", 1840, { pendingId: "c9-pending" });
  const [line, ...rest] = await alertFor(t, [], [{ id: "c9-pending", amount: 1840, pending: true }]);
  assert.equal(rest.length, 0);
  assert.equal(line, "Card: Charge: $1,840.00 at Tidewater Roofing (2026-10-17) — first charge from this merchant.");
});

test("the pending copy is left out even when the posted charge does not name it", async () => {
  // Plaid does not always fill pending_transaction_id; the pending flag alone
  // has to keep the copy out of the history.
  const t = charge("c10", "Larkspur Moving Co", 2210);
  const [line] = await alertFor(t, [], [{ id: "c10-pending", amount: 2210, pending: true }]);
  assert.ok(line.endsWith("— first charge from this merchant."), line);
});

test("the pending copy named by pending_transaction_id is left out even if stored as posted", async () => {
  const t = charge("c11", "Crestview Kennels", 760, { pendingId: "c11-pending" });
  const [line] = await alertFor(t, [], [{ id: "c11-pending", amount: 760, pending: false }]);
  assert.ok(line.endsWith("— first charge from this merchant."), line);
});

test("a big jump is not hidden by its own pending copy", async () => {
  // One real earlier charge of $1,000; the new $3,000 charge's pending copy is
  // still stored. Counting the copy made the high-water mark $3,000 and the
  // jump looked ordinary.
  const t = charge("c12", "Meadowbrook Pools", 3000, { pendingId: "c12-pending" });
  const [line] = await alertFor(t, [1000], [{ id: "c12-pending", amount: 3000, pending: true }]);
  assert.ok(line && line.includes("well above the $1,000.00 you've paid them before"), String(line));
});

test("the history query asks for posted rows and excludes the charge and its pending copy", async () => {
  const t = charge("c13", "Ashgrove Surveyors", 990, { pendingId: "c13-pending" });
  await alertFor(t, []);
  const q = new URLSearchParams(calls.find((c) => c.pathAndQuery.includes("select=amount")).pathAndQuery.split("?")[1]);
  assert.equal(q.get("pending"), "is.false");
  assert.deepEqual(q.getAll("transaction_id").sort(), ["neq.c13", "neq.c13-pending"]);
});

// The invariant behind the incident, swept: whatever the history, an alert that
// says "well above the $X" is about a charge more than 25% above X.
test("'well above the $X' only ever appears when the charge is more than 25% above X", async () => {
  const ratios = [0.3, 0.5, 0.9, 1, 1.1, 1.25, 1.26, 1.5, 3];
  let checked = 0;
  for (const priorCount of [1, 2, 3]) {
    for (const r of ratios) {
      const max = 2000;
      const prior = Array.from({ length: priorCount }, (_, i) => max - i * 100);
      const amount = Math.round(max * r * 100) / 100;
      const id = `sweep-${priorCount}-${r}`;
      const t = charge(id, `Sweep Merchant ${priorCount}`, amount, { pendingId: `${id}-p` });
      // Every sweep charge also has its pending copy still stored.
      const alerts = await alertFor(t, prior, [{ id: `${id}-p`, amount, pending: true }]);
      const claims = alerts.filter((a) => a.includes("well above"));
      if (amount > max * 1.25) {
        assert.equal(claims.length, 1, `count=${priorCount} ratio=${r}: expected an alert`);
        assert.ok(claims[0].includes("$2,000.00"), claims[0]);
      } else {
        assert.deepEqual(alerts, [], `count=${priorCount} ratio=${r}: ${alerts.join(" | ")}`);
      }
      checked++;
    }
  }
  assert.equal(checked, 27);
});
