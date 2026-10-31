// hum-finance-harvester.test.mjs — unit tests for the finance hum harvester's
// reconnect-artifact detection. A Plaid Item reconnect can mint a new
// account_id for the same physical card/account, mirroring every transaction
// under both account_ids — so a same-merchant/same-amount/same-date pair
// spanning that account_id pair is guaranteed to look like a duplicate charge
// under a naive merchant+amount match, even though nothing was charged twice.
// Confirmed 3-for-3 false positives in late August 2026 — all pairs of the
// same two account_ids on one card. Synthetic accounts below.
//
// Run: node --test tests/hum-finance-harvester.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { isReconnectArtifactPair } from "../agent/scripts/hum-harvesters/finance.mjs";

const BANK_A = { account_id: "acct-a", mask: "1234", institution_name: "Bank One" };
const BANK_B = { account_id: "acct-b", mask: "1234", institution_name: "Bank One" };
const CARDCO = { account_id: "acct-c", mask: "5678", institution_name: "Card Co" };
const BANK_DIFFERENT_MASK = { account_id: "acct-d", mask: "9012", institution_name: "Bank One" };

test("isReconnectArtifactPair: true for two account_ids sharing mask + institution", () => {
  const accounts = [BANK_A, BANK_B];
  assert.equal(isReconnectArtifactPair(accounts, "acct-a", "acct-b"), true);
  // Symmetric
  assert.equal(isReconnectArtifactPair(accounts, "acct-b", "acct-a"), true);
});

test("isReconnectArtifactPair: false for the same account_id twice", () => {
  const accounts = [BANK_A];
  assert.equal(isReconnectArtifactPair(accounts, "acct-a", "acct-a"), false);
});

test("isReconnectArtifactPair: false for different mask (real distinct cards)", () => {
  const accounts = [BANK_A, BANK_DIFFERENT_MASK];
  assert.equal(isReconnectArtifactPair(accounts, "acct-a", "acct-d"), false);
});

test("isReconnectArtifactPair: false for different institution, same mask (coincidence)", () => {
  const accounts = [BANK_A, { account_id: "acct-e", mask: "1234", institution_name: "Card Co" }];
  assert.equal(isReconnectArtifactPair(accounts, "acct-a", "acct-e"), false);
});

test("isReconnectArtifactPair: false (fail open to alerting) when an account_id is unknown", () => {
  const accounts = [BANK_A];
  assert.equal(isReconnectArtifactPair(accounts, "acct-a", "acct-does-not-exist"), false);
});

test("isReconnectArtifactPair: false (fail open) when mask or institution_name is missing", () => {
  const noMask = { account_id: "acct-f", mask: null, institution_name: "Bank One" };
  const noInst = { account_id: "acct-g", mask: "1234", institution_name: null };
  assert.equal(isReconnectArtifactPair([BANK_A, noMask], "acct-a", "acct-f"), false);
  assert.equal(isReconnectArtifactPair([BANK_A, noInst], "acct-a", "acct-g"), false);
});

test("isReconnectArtifactPair: unrelated accounts (different institutions) never match", () => {
  const accounts = [BANK_A, CARDCO];
  assert.equal(isReconnectArtifactPair(accounts, "acct-a", "acct-c"), false);
});

test("isReconnectArtifactPair: institution_name comparison is case-insensitive", () => {
  const accounts = [
    { account_id: "acct-x", mask: "1234", institution_name: "Bank One" },
    { account_id: "acct-y", mask: "1234", institution_name: "BANK ONE" },
  ];
  assert.equal(isReconnectArtifactPair(accounts, "acct-x", "acct-y"), true);
});

// Regression case mirroring the confirmed false positives, with account ids in
// Plaid's real shape.
test("isReconnectArtifactPair: regression — one card's reconnect-minted account_id pair", () => {
  const accounts = [
    { account_id: "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm", mask: "1234", institution_name: "Bank One" },
    { account_id: "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn", mask: "1234", institution_name: "Bank One" },
  ];
  assert.equal(
    isReconnectArtifactPair(accounts, "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm", "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn"),
    true
  );
});
