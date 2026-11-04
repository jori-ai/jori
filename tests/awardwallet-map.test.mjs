// awardwallet-map: AwardWallet account → loyalty_accounts row.
// Fixture is a synthetic /connectedUser/{id} response with the real API's shape.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { toRow, isReadable } = require("../lib/awardwallet-map.js");
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/awardwallet-connected-user.json", import.meta.url), "utf8"));
const rows = fixture.accounts.map((a) => toRow(a, "connectedUser", 285462, "2026-10-21T12:00:00.000Z"));
const by = (code) => rows.find((r) => r.provider_code === code);

test("balances and owner come through", () => {
  const card = by("cardpoints");
  assert.equal(card.balance_raw, 123456);
  assert.equal(card.owner_name, "Test Owner");
  assert.equal(card.kind, "Credit Cards");
  assert.ok(isReadable(card));
});

test("'never expires' far-future date is stored as null", () => {
  assert.equal(by("hotelrewards").expiration_date, null);
});

test("real sub-account expiration survives", () => {
  assert.equal(by("cardpoints").sub_accounts[0].expiration_date, "2026-12-31T00:00:00.000Z");
});

test("HTML entities in names are decoded", () => {
  assert.equal(by("milesgo").display_name, "Example Airways (Miles&Go)");
});

test("elite status comes from the kind-3 property", () => {
  assert.equal(by("hotelrewards").elite_status, "Platinum Elite");
  assert.equal(by("cardpoints").elite_status, null);
});

test("negative balance shows as zero, zero is not treated as missing", () => {
  assert.equal(by("milesgo").balance_raw, 0);
  assert.equal(by("milesgo").balance, "0");
  assert.equal(by("airclub").balance_raw, 0);
});

test("unreadable programs are flagged", () => {
  assert.equal(isReadable(by("airclub")), false);
  assert.equal(isReadable(by("hotelrewards")), false);
});

// ── disconnect detection (requirement: warn when anything disconnects) ──
const { diffHealth, unhealthyReason, LOCKOUT_RISK_CODES } = require("../lib/awardwallet-map.js");
const NOW = new Date("2026-10-21T12:00:00Z");
const prog = (id, fields) => ({ account_id: id, display_name: `P${id}`, owner_name: "Test Owner", error_code: 1, last_retrieve_date: "2026-10-18T00:00:00Z", ...fields });

test("a read error or a 3-week-old read is not current; a recent clean read is", () => {
  assert.equal(unhealthyReason(prog(1), NOW), null);
  assert.match(unhealthyReason(prog(2, { error_code: 8, error_message: "bad password" }), NOW), /bad password/);
  // The silent case: errorCode 1 but AwardWallet stopped reading it (seen: a card program frozen at a years-old balance).
  assert.match(unhealthyReason(prog(3, { last_retrieve_date: "2022-10-24T16:19:15Z" }), NOW), /not updated in \d+ days/);
  assert.equal(unhealthyReason(prog(4, { last_retrieve_date: "2026-10-01T00:00:00Z" }), NOW), null); // 20 days: fine
});

test("needs-you errors are disconnected at once; provider hiccups get 21 days", () => {
  assert.match(unhealthyReason(prog(5, { error_code: 2, error_message: "Invalid logon" }), NOW), /Invalid logon/);
  assert.match(unhealthyReason(prog(6, { error_code: 10, error_message: "security code" }), NOW), /security code/);
  // A provider "try again later" (4) with a good read 5 days ago: still current.
  assert.equal(unhealthyReason(prog(7, { error_code: 4 }), NOW, "2026-10-16T00:00:00Z"), null);
  // ...but a hiccup that never clears is a disconnect.
  assert.match(unhealthyReason(prog(7, { error_code: 4 }), NOW, "2026-09-01T00:00:00Z"), /no successful read in \d+ days/);
});

test("a transient error with no record starts its grace period now, not 'dead on sight'", () => {
  const { unhealthy, lastOk } = diffHealth({}, [prog(8, { error_code: 6 })], NOW, {});
  assert.equal(unhealthy[8], undefined);
  assert.equal(lastOk[8], NOW.toISOString());
});

test("refresh never retries a stored password the provider rejects", () => {
  for (const c of [2, 3, 7, 8]) assert.ok(LOCKOUT_RISK_CODES.has(c));
  for (const c of [1, 4, 6, 10]) assert.ok(!LOCKOUT_RISK_CODES.has(c));
});

test("first run seeds silently — no alert storm for already-known problems", () => {
  const { unhealthy, newly } = diffHealth(null, [prog(1, { error_code: 2 }), prog(2)], NOW);
  assert.deepEqual(Object.keys(unhealthy), ["1"]);
  assert.equal(newly.length, 0);
});

test("only a current→not-current transition alerts, and only once", () => {
  const prev = { 1: "AwardWallet error 3" };
  const rows = [prog(1, { error_code: 3 }), prog(2, { error_code: 2, error_message: "connection lost" })];
  const first = diffHealth(prev, rows, NOW);
  assert.deepEqual(first.newly.map((n) => n.row.account_id), [2]);
  const second = diffHealth(first.unhealthy, rows, NOW);
  assert.equal(second.newly.length, 0);
});

test("a program that comes back is reported recovered and can alert again later", () => {
  const { unhealthy, recovered } = diffHealth({ 2: "x" }, [prog(2)], NOW);
  assert.deepEqual(recovered.map((r) => r.account_id), [2]);
  assert.equal(unhealthy[2], undefined);
});
