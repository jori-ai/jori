// finance-loyalty: the weekly review's miles & points section — values only
// where a rate is configured, the week's change from history, an unread
// balance shown "as of", expiring card credits, header tiles per provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { loyaltySection, cardOf } = require("../lib/finance-loyalty.js");
const { renderReview } = require("../lib/finance-review-render.js");

const rows = [
  { account_id: 1, provider_code: "bankx", display_name: "BankX (Rewards)", kind: "Credit Cards", owner_name: "Ada Lee", owner_kind: "connectedUser", balance_raw: 100000, error_code: 4, last_retrieve_date: "2026-11-08T12:00:00Z",
    sub_accounts: [{ display_name: "BankX (Rewards) - Gold Card® (...1234)", balance_raw: 100000 }, { display_name: "BankX (Rewards) - Dining Credit *1234", balance: "$50", balance_raw: 50, expiration_date: "2026-11-30T00:00:00.000Z" }, { display_name: "BankX (Rewards) - Hotel Credit *1234", balance: "$300", balance_raw: 300, expiration_date: "2026-12-31T00:00:00.000Z" }, { display_name: "BankX (Rewards) - Far Credit *1234", balance: "$10", balance_raw: 10, expiration_date: "2027-09-01T00:00:00.000Z" }] },
  { account_id: 2, provider_code: "bankx", display_name: "BankX (Rewards)", kind: "Credit Cards", owner_name: "Ada Lee", owner_kind: "connectedUser", balance_raw: 20000, error_code: 1, last_retrieve_date: "2026-11-08T12:00:00Z", sub_accounts: [] },
  { account_id: 3, provider_code: "air", display_name: "Air (Miles)", kind: "Airlines", owner_name: "Bo Lee", owner_kind: "connectedUser", balance_raw: 5000, error_code: 1, last_retrieve_date: "2026-11-08T12:00:00Z", elite_status: "Gold", sub_accounts: [] },
  { account_id: 4, provider_code: "hotel", display_name: "Hotel (Club)", kind: "Hotels", owner_name: "Ada Lee", owner_kind: "connectedUser", balance_raw: 0, error_code: 1, sub_accounts: [] },
];
const args = {
  rows, today: "2026-11-09", weekStart: "2026-11-02", ownerName: "Ada Lee", tz: "America/New_York",
  history: [{ account_id: 2, as_of_date: "2026-11-01", balance_raw: 18000 }, { account_id: 2, as_of_date: "2026-11-08", balance_raw: 20000 }],
  lastOk: { 1: "2026-10-21T15:00:00Z", 2: "2026-11-08T12:00:00Z", 3: "2026-11-08T12:00:00Z" },
  config: { cents_per_point: { bankx: { travel: 1.5, cash: 1 } }, review_tiles: ["bankx"] },
};

test("totals, values only where a rate is configured, week change from history", () => {
  const l = loyaltySection(args);
  assert.equal(l.total.points_fmt, "125,000");
  assert.equal(l.total.value_fmt, "$1,800");
  assert.equal(l.total.cash_fmt, "$1,200");
  assert.equal(l.total.week_delta_fmt, "+2,000");
  const air = l.groups.find((g) => g.title === "Airline miles").programs[0];
  assert.equal(air.value_fmt, null);
  assert.equal(air.holder, "Bo");
  assert.ok(!l.groups.some((g) => g.title === "Hotel points"), "a zero balance is not listed");
});

test("an unreadable balance is 'as of' its last read and counted in the stale share", () => {
  const l = loyaltySection(args);
  const gold = l.groups[0].programs.find((p) => p.label === "BankX Gold Card ••1234");
  assert.ok(gold.stale);
  assert.equal(gold.as_of, "Oct 21");
  assert.equal(l.stale.share_pct, 83);
  assert.deepEqual(l.stale.reasons, [{ reason: "AwardWallet cannot read it", programs: ["BankX Gold Card ••1234"] }]);
});

test("card credits inside the window, soonest first; tiles group a provider's accounts", () => {
  const l = loyaltySection(args);
  assert.equal(l.credits.total_fmt, "$350");
  assert.equal(l.credits.by_fmt, "Dec 31");
  assert.deepEqual(l.credits.soonest, { amount_fmt: "$50", by_fmt: "Nov 30", names: "Dining" });
  assert.deepEqual(l.tiles, [{ label: "BankX points", points_fmt: "120,000", value_fmt: "$1,800", week_delta_fmt: "+2,000" }]);
});

test("cardOf only names a card whose sub-account carries the whole balance", () => {
  assert.deepEqual(cardOf(rows[0]), { name: "Gold Card", mask: "1234" });
  assert.equal(cardOf({ balance_raw: 5, sub_accounts: [{ display_name: "X - Card (...9999)", balance_raw: 4 }] }), null);
});

test("render: header tiles and a Miles & points card after Cards", () => {
  const html = renderReview({
    meta: { week_end: "2026-11-08", generated_at: "now", ledger_available: true },
    attention: [], cash: { position: null, flow: {}, upcoming_14d: [], unconfirmed_card_payments: [] },
    income: { registered: [], rent: [], note: "" }, invoices: null, real_estate: null, deposits: null,
    spending: { week_total_fmt: "$0", prior_week_total_fmt: "$0", by_category: [], largest: [], leakage: [] },
    cards: { items: [], aggregate_utilization_fmt: "0%", utilization_basis: "x", interest: [] },
    recurring: { active_count: 0, monthly_equivalent_fmt: "$0", undecided_count: 0, source: "x", price_changes: [], renewals_30d: [] },
    networth: { lines: [], net_worth_fmt: "$0", note: "" }, tax: {}, questions: [],
    loyalty: loyaltySection(args),
  }, null);
  const header = html.slice(0, html.indexOf('class="card"'));
  assert.match(header, /BankX points/);
  assert.match(header, /Total miles &amp; points/);
  assert.ok(html.indexOf(">Cards<") < html.indexOf(">Miles &amp; points<") && html.indexOf(">Miles &amp; points<") < html.indexOf(">Recurring<"));
  assert.match(html, /As of Oct 21/);
  assert.match(html, /\$350 card credits expire by Dec 31/);
});
