// Local explanations draw on their own pool (2026-10-20): they neither spend
// nor are blocked by the shared 6-a-day / 45-min budget.
import test from "node:test";
import assert from "node:assert/strict";
import { checkPingBudget, todaysPings, isLocalHistoryRow } from "../lib/ping-budget.mjs";

const tz = "UTC";
const now = new Date("2026-10-20T15:00:00Z");
const at = (min) => new Date(now.getTime() - min * 60000).toISOString();
const lh = (min) => ({ sent_at: at(min), lane: "nearby", budget_pool: "local_history" });
const other = (min) => ({ sent_at: at(min), lane: "ideas" });

test("pools are counted separately", () => {
  const rows = [lh(5), lh(30), other(10), other(120)];
  assert.equal(todaysPings({ rows, now, tz }).ledger_count, 2);
  assert.equal(todaysPings({ rows, now, tz, pool: "local_history" }).ledger_count, 2);
  assert.ok(isLocalHistoryRow(rows[0]));
  assert.ok(isLocalHistoryRow({ supporting_data: { budget_pool: "local_history" } }));
});

test("a factoid 5 min ago does not trip the shared 45-min spacing", () => {
  const rows = [lh(5), other(60)];
  const shared = checkPingBudget({ rows, now, tz, statePath: "/nonexistent" });
  assert.equal(shared.ok, true);
});

test("local-history pool: 15-min spacing and 10/day", () => {
  assert.equal(checkPingBudget({ rows: [lh(5)], now, tz, pool: "local_history", statePath: "/nonexistent" }).gate, "min_interval");
  assert.equal(checkPingBudget({ rows: [lh(20)], now, tz, pool: "local_history", statePath: "/nonexistent" }).ok, true);
  const ten = Array.from({ length: 10 }, (_, i) => lh(20 + i * 20));
  assert.equal(checkPingBudget({ rows: ten, now, tz, pool: "local_history", statePath: "/nonexistent" }).gate, "daily_cap");
  // Six shared pings do not block a factoid.
  const six = Array.from({ length: 6 }, (_, i) => other(50 + i * 50));
  assert.equal(checkPingBudget({ rows: six, now, tz, pool: "local_history", statePath: "/nonexistent" }).ok, true);
});
