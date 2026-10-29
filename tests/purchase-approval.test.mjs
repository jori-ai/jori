// purchase-approval.test.mjs — the trust core of Face-ID-approved purchases.
// Generated P-256 keys stand in for the phone's Secure Enclave.
//
// Run: node --test tests/purchase-approval.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  normalizePurchaseItem, purchaseHash, buildPurchaseRequest, verifyPurchaseRow,
  pageMatchesItem, hostMatchesSite, amountRenderings, summarize, PURCHASE_DOMAIN, EXECUTE_GRACE_MS,
  cleanPageTitle, placedMessage,
} from "../lib/purchase-approval.mjs";
import { itemHash, buildApprovalRequest } from "../agent/core/app-approval.mjs";

function makeDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const pad = (b64) => { const b = Buffer.from(b64, "base64url"); return b.length === 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b]); };
  return {
    pub: Buffer.concat([Buffer.from([0x04]), pad(jwk.x), pad(jwk.y)]).toString("base64"),
    sign: (m) => crypto.sign("sha256", Buffer.from(m, "utf8"), { key: privateKey, dsaEncoding: "der" }).toString("base64"),
  };
}

const ITEM = {
  merchant: "Example Store", site: "https://www.example-store.com/checkout/review",
  items: [{ title: "Acme  USB-C cable", qty: 2, line_cents: 2598 }],
  subtotal_cents: 2598, shipping_cents: 0, tax_cents: 231, total_cents: 2829,
  card: { label: "Visa Signature", last4: "4242" },
  ship_to: { name: "Alex Sample", address: "100 Main St Apt 2B, Springfield, IL 62701" },
  screenshot_sha256: "a".repeat(64),
};

function signedRow(dev, { now = Date.now(), item = ITEM, tamper } = {}) {
  const req = buildPurchaseRequest("pur_1", item, { now });
  const row = { id: req.id, item_json: req.item, item_hash: req.hash, nonce: req.nonce, expires_at_ms: req.expiresAt,
    signed_by: "dev1", signature: dev.sign(req.message) };
  return tamper ? tamper(row) : row;
}

describe("normalizePurchaseItem", () => {
  it("canonicalizes site, whitespace and currency", () => {
    const n = normalizePurchaseItem(ITEM);
    assert.equal(n.site, "example-store.com");
    assert.equal(n.items[0].title, "Acme USB-C cable");
    assert.equal(n.currency, "USD");
    assert.deepEqual(normalizePurchaseItem(n), n, "idempotent: the stored row re-normalizes to itself");
  });
  it("refuses floats, bad last4 and missing totals", () => {
    assert.throws(() => normalizePurchaseItem({ ...ITEM, total_cents: 28.29 }), /integer cents/);
    assert.throws(() => normalizePurchaseItem({ ...ITEM, card: { label: "x", last4: "10" } }), /last4/);
    assert.throws(() => normalizePurchaseItem({ ...ITEM, total_cents: undefined }), /total_cents/);
    assert.throws(() => normalizePurchaseItem({ ...ITEM, items: [] }), /empty/);
  });
  it("drops unknown fields, so nothing hidden is ever hashed", () => {
    assert.equal(purchaseHash({ ...ITEM, secret: "x" }), purchaseHash(ITEM));
  });
});

describe("verifyPurchaseRow", () => {
  const dev = makeDevice();
  it("accepts a correctly signed row", () => {
    assert.deepEqual(verifyPurchaseRow(signedRow(dev), dev.pub), { ok: true });
  });
  it("rejects a changed total after signing", () => {
    const row = signedRow(dev, { tamper: (r) => ({ ...r, item_json: { ...r.item_json, total_cents: 282900 } }) });
    assert.equal(verifyPurchaseRow(row, dev.pub).reason, "item changed since request");
  });
  it("rejects a swapped card or address", () => {
    const card = signedRow(dev, { tamper: (r) => ({ ...r, item_json: { ...r.item_json, card: { label: "Visa Signature", last4: "9999" } } }) });
    assert.equal(verifyPurchaseRow(card, dev.pub).ok, false);
    const addr = signedRow(dev, { tamper: (r) => ({ ...r, item_json: { ...r.item_json, ship_to: { name: "X", address: "1 Elm St 02139" } } }) });
    assert.equal(verifyPurchaseRow(addr, dev.pub).ok, false);
  });
  it("rejects another device's key", () => {
    assert.equal(verifyPurchaseRow(signedRow(dev), makeDevice().pub).reason, "bad signature");
  });
  it("rejects a self-improvement signature replayed as a purchase", () => {
    const req = buildPurchaseRequest("pur_1", ITEM);
    const si = buildApprovalRequest("pur_1", req.item, { nonce: req.nonce, now: req.expiresAt - 24 * 3600 * 1000 });
    assert.notEqual(si.message, req.message);
    const row = { id: req.id, item_json: req.item, item_hash: req.hash, nonce: req.nonce, expires_at_ms: req.expiresAt,
      signed_by: "dev1", signature: dev.sign(si.message) };
    assert.equal(verifyPurchaseRow(row, dev.pub).reason, "bad signature");
    assert.ok(req.message.startsWith(PURCHASE_DOMAIN + "\n"));
  });
  it("honours the execute grace window, then expires", () => {
    const now = Date.now();
    const row = signedRow(dev, { now });
    assert.equal(verifyPurchaseRow(row, dev.pub, { now: row.expires_at_ms + EXECUTE_GRACE_MS - 1 }).ok, true);
    assert.equal(verifyPurchaseRow(row, dev.pub, { now: row.expires_at_ms + EXECUTE_GRACE_MS + 1 }).reason, "expired");
  });
  it("refuses an unpaired signer and an unsigned row", () => {
    assert.equal(verifyPurchaseRow(signedRow(dev), null).ok, false);
    assert.equal(verifyPurchaseRow({ ...signedRow(dev), signature: null }, dev.pub).reason, "unsigned");
  });
});

describe("pageMatchesItem", () => {
  const item = normalizePurchaseItem(ITEM);
  const page = "Review your order  Order total: $28.29  Paying with Visa ending in 4242  Ship to Alex Sample, Springfield, IL 62701";
  it("passes when total, card and ZIP are on the page", () => {
    assert.deepEqual(pageMatchesItem(page, item), { ok: true, missing: [] });
  });
  it("fails when the total changed", () => {
    const r = pageMatchesItem(page.replace("28.29", "31.07"), item);
    assert.equal(r.ok, false);
    assert.match(r.missing[0], /total/);
  });
  it("does not accept the total inside a larger number", () => {
    assert.equal(pageMatchesItem(page.replace("$28.29", "$128.29"), item).ok, false);
  });
  it("fails on a different card or address", () => {
    assert.equal(pageMatchesItem(page.replace("4242", "4421"), item).ok, false);
    assert.equal(pageMatchesItem(page.replace("62701", "33161"), item).ok, false);
  });
  it("renders thousands in US and EU styles", () => {
    assert.ok(amountRenderings(123456).includes("1,234.56"));
    assert.ok(amountRenderings(123456).includes("1.234,56"));
  });
});

describe("hostMatchesSite", () => {
  it("accepts subdomains, refuses look-alikes", () => {
    assert.equal(hostMatchesSite("https://smile.example-store.com/x", "example-store.com"), true);
    assert.equal(hostMatchesSite("https://www.example-store.com/x", "example-store.com"), true);
    assert.equal(hostMatchesSite("https://example-store.com.evil.io/x", "example-store.com"), false);
    assert.equal(hostMatchesSite("https://notexample-store.com/x", "example-store.com"), false);
  });
});

describe("Swift parity vector", () => {
  // PurchaseApproval.swift's canonicalJSON() must produce exactly this string for
  // this item (pinned so a change on either side fails a test, not a purchase).
  // Non-ASCII, a quote, a slash (Foundation escapes it, JSON.stringify doesn't),
  // a control character, a null, a negative and a null ship_to.
  it("canonical JSON + hash are stable", () => {
    const n = normalizePurchaseItem({ ...ITEM, site: "example-store.com", ship_to: null, discount_cents: -500,
      items: [{ title: "Café \"quote\" / slash\u0007", qty: 1, line_cents: null }] });
    assert.equal(itemHash(n), "446259767bfbd83aa1476e5a81ec1926e33e5e461ac55a239772d0853a5011ae");
    assert.match(summarize(n), /^\$28\.29 at Example Store — Café/);
  });
});

describe("placedMessage", () => {
  // A ticket order shaped like a real stored purchase_approvals row: two seats
  // on one line plus a fee line. The confirmation once read "3 items" and quoted
  // the confirmation page's title as empty quotes (its title was "").
  const TWO_SEATS = normalizePurchaseItem({
    merchant: "Example Tickets", site: "example-tickets.com",
    items: [
      { title: "Comedy Night: An Evening of Stand-Up, City Theatre, Sun Nov 8 7:30pm: Orchestra 4, Row P, seats 40, 42", qty: 2, line_cents: 12300 },
      { title: "Service fees", qty: 1, line_cents: 4180 },
    ],
    subtotal_cents: 12300, shipping_cents: 0, tax_cents: 0, total_cents: 16480,
    card: { label: "Mastercard World", last4: "5100" }, ship_to: null,
    screenshot_sha256: "b".repeat(64),
  });
  const FALLBACK = " The confirmation email should follow shortly.";

  it("says two seats for the two-seat order, never a summed item count", () => {
    const m = placedMessage(TWO_SEATS, "");
    assert.equal(m, "Your Example Tickets order went through, $164.80 on your Mastercard World ending 5100, "
      + "for 2 × Comedy Night: An Evening of Stand-Up, City Theatre, Sun Nov 8 7:30pm: Orchestra 4, Row P, seats 40, 42, "
      + "plus Service fees." + FALLBACK);
    assert.doesNotMatch(m, /\bitems?\b/);
    assert.doesNotMatch(m, /\b3\b/);
  });
  it("falls back to a plain sentence when the title is empty, blank or invisible, never empty quotes", () => {
    for (const t of ["", "   ", "\u200B", "\u200B\u200C\u200D\uFEFF", " \n\t\u00A0\u2060\u200E ", "\u3164\u2800", "\u00AD", null, undefined]) {
      const m = placedMessage(TWO_SEATS, t);
      assert.ok(m.endsWith("." + FALLBACK), `title ${JSON.stringify(t)} -> ${m}`);
      assert.ok(!m.includes("“") && !m.includes("”"), `title ${JSON.stringify(t)} quoted`);
      assert.equal(cleanPageTitle(t), "");
    }
  });
  it("quotes a visible title with the invisible characters and extra spaces taken out", () => {
    const m = placedMessage(TWO_SEATS, "\u200B  Order\u00A0 Confirmed \u200D| Example Tickets\uFEFF\n");
    assert.ok(m.endsWith(" Example Tickets's page now reads “Order Confirmed | Example Tickets”."), m);
  });
  it("cuts a very long title", () => {
    const t = cleanPageTitle("x".repeat(500));
    assert.equal([...t].length, 120);
    assert.ok(t.endsWith("…"));
  });
  it("names a single line, its quantity and the ship-to", () => {
    const m = placedMessage(normalizePurchaseItem(ITEM), "Thank you, your order has been placed");
    assert.equal(m, "Your Example Store order went through, $28.29 on your Visa Signature ending 4242, for 2 × Acme USB-C cable, "
      + "shipping to Alex Sample. Example Store's page now reads “Thank you, your order has been placed”.");
    const one = normalizePurchaseItem({ ...ITEM, items: [{ title: "Acme USB-C cable", qty: 1, line_cents: 1299 }] });
    assert.match(placedMessage(one, ""), /, for Acme USB-C cable, shipping to/);
  });
  it("names the first line and counts the rest on a long order", () => {
    const many = normalizePurchaseItem({ ...ITEM, items: ["A", "B", "C", "D"].map((t) => ({ title: t, qty: 1, line_cents: 100 })) });
    assert.match(placedMessage(many, ""), /, for A, plus B and 2 more, shipping to /);
    const three = normalizePurchaseItem({ ...ITEM, items: ["A", "B", "C"].map((t) => ({ title: t, qty: 1, line_cents: 100 })) });
    assert.match(placedMessage(three, ""), /, for A, plus B and C, shipping to /);
  });
});
