// finance-review-check: the code layer of the check run before the weekly
// finance review is sent. Bank wording shown as a name, breakdowns that do not
// add up, unknown deposits, act-on items with no action, repeated actions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { structural, emailText } = createRequire(import.meta.url)("../bin/finance-review-check");

const base = (over = {}) => ({
  attention: [], cash: { flow: { detail: {} }, upcoming_14d: [] }, spending: { largest: [], by_category: [], week_total_fmt: "$0" },
  recurring: { renewals_30d: [] }, deposits: { rows: [] }, ...over,
});

test("a bank description shown as a name is a high finding; a plain name is not", () => {
  const p = base({ cash: { upcoming_14d: [], flow: { detail: { income_in: { total: 2, total_fmt: "$2.00", rows: [
    { from: "ACME PAYOUTS INC DES:Rent-cr ID:7057", to: "Bank — 12 Oak St", amount: 1, count: 1 },
    { from: "Rent — Birch House", to: "Bank — Birch House", amount: 1, count: 1 }] } } } } });
  const f = structural(p, "");
  assert.equal(f.filter((x) => x.kind === "bank-wording").length, 1);
  assert.match(f[0].problem, /ACME PAYOUTS/);
});

test("rows that do not add up to their line, an unknown deposit, an act-on item with no action and a repeated action are findings", () => {
  const p = base({
    cash: { upcoming_14d: [], flow: { detail: { refunds: { total: 10, total_fmt: "$10.00", rows: [{ from: "Walmart", to: "Card", amount: 9, count: 1 }] } } } },
    deposits: { rows: [{ tenant: "Pat", location: "not known (no trail)" }] },
    attention: [
      { tag: "duplicate", priority: 75, text: "Two charges at a store." },
      { tag: "deposit-missing", priority: 86, text: "x", action: "Move $1 from A to B." },
      { tag: "deposit-missing", priority: 86, text: "y", action: "Move $1 from A to B." },
    ],
  });
  const kinds = structural(p, "").map((x) => x.kind).sort();
  assert.deepEqual(kinds, ["does-not-add-up", "duplicate", "no-action", "unknown"]);
});

test("the email text is what the reader sees", () => {
  assert.equal(emailText("<style>.x{}</style><div>A &amp; B</div><table><tr><td>1</td><td>2</td></tr></table>"), "A & B\n1 | 2 |");
});
