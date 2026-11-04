// purchase-approval.mjs — the pure core of Face-ID-approved purchases.
//
// Requirement: the agent may sign in to a merchant site on the host with the
// user's credentials and buy something on the user's behalf, but only after a
// Face ID approval on the client that clearly shows what is being bought, for
// how much, which card pays and the delivery address.
//
// The flow (agent/ops-agent/jobs/purchase.md):
//   1. The agent drives the SHOP Chrome (port 9224) to the final review page and
//      writes what it sees as a purchase item (normalizePurchaseItem's shape).
//   2. `purchase request` checks the live page shows that total + card, hashes
//      the item, and inserts a `purchase_approvals` row. The phone gets a
//      time-sensitive push and opens a full-screen review.
//   3. The app re-derives the hash from the fields it DISPLAYS (PurchaseApproval
//      .swift mirrors canonicalStringify byte for byte) and refuses to sign if it
//      differs — so the Face ID signature binds exactly what the user saw.
//   4. `purchase-approval-poll` (no LLM) verifies the signature against the
//      paired purchase key, re-checks the live page, and clicks Place Order.
//
// Signatures use their own domain (the signing context, `signing_domain` in
// agent/local/config/purchase.json; the client app signs with the same string)
// and their own Secure Enclave key, so a self-improvement approval can never
// authorize a purchase. An installation keeps its domain for good: changing it
// invalidates every paired client. The only I/O here is reading that one value
// at load; everything else is unit-tested with generated keys.

import { createRequire } from "node:module";
import { itemHash, buildApprovalRequest, checkApproval } from "../agent/core/app-approval.mjs";

const { localConfig } = createRequire(import.meta.url)("./instance.cjs");

export const PURCHASE_DOMAIN = String(localConfig("purchase", { signing_domain: "jori-purchase.v1" }).signing_domain || "jori-purchase.v1");
// Carts and seat holds go stale fast; trade approvals use 5 min. Ten gives the
// user time to find the phone without letting a price drift for long.
export const PURCHASE_TTL_MS = 10 * 60 * 1000;
// The poller ticks every few seconds; a signature made seconds before expiry
// may be picked up just after it. The live-page re-check guards staleness.
export const EXECUTE_GRACE_MS = 2 * 60 * 1000;

const HEX64 = /^[0-9a-f]{64}$/;

function str(v, field, { max = 300, optional = false } = {}) {
  if (v == null || v === "") {
    if (optional) return null;
    throw new Error(`purchase item: ${field} is required`);
  }
  const s = String(v).replace(/\s+/g, " ").trim();
  if (!s) {
    if (optional) return null;
    throw new Error(`purchase item: ${field} is required`);
  }
  if (s.length > max) throw new Error(`purchase item: ${field} longer than ${max} chars`);
  return s;
}

function cents(v, field, { optional = false, allowNegative = false, allowZero = true } = {}) {
  if (v == null) {
    if (optional) return null;
    throw new Error(`purchase item: ${field} is required`);
  }
  if (!Number.isInteger(v)) throw new Error(`purchase item: ${field} must be integer cents`);
  if (!allowNegative && v < 0) throw new Error(`purchase item: ${field} must not be negative`);
  if (!allowZero && v === 0) throw new Error(`purchase item: ${field} must not be zero`);
  if (Math.abs(v) > 1e11) throw new Error(`purchase item: ${field} out of range`);
  return v;
}

export function siteHost(input) {
  let s = String(input || "").trim().toLowerCase();
  if (!s) throw new Error("purchase item: site is required");
  if (s.includes("://")) s = new URL(s).hostname;
  s = s.replace(/^www\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) throw new Error(`purchase item: bad site '${input}'`);
  return s;
}

// Does a live tab's URL belong to the approved site? Subdomains count
// (smile.amazon.com for amazon.com); look-alikes (amazon.com.evil.io) do not.
export function hostMatchesSite(url, site) {
  let h;
  try { h = new URL(url).hostname.toLowerCase().replace(/\.$/, ""); } catch { return false; }
  h = h.replace(/^www\./, "");
  return h === site || h.endsWith("." + site);
}

/**
 * Validate + canonicalize what the agent read off the review page. Every field
 * here is rendered on the phone; nothing is hashed that the user does not see.
 * Money is integer cents only: a float would hash differently in Swift and JS.
 */
export function normalizePurchaseItem(input) {
  if (!input || typeof input !== "object") throw new Error("purchase item: expected an object");
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0) throw new Error("purchase item: items[] is empty");
  if (items.length > 50) throw new Error("purchase item: more than 50 line items");
  const card = input.card || {};
  const last4 = String(card.last4 || "").trim();
  if (!/^[0-9]{4}$/.test(last4)) throw new Error("purchase item: card.last4 must be 4 digits");
  const currency = String(input.currency || "USD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("purchase item: currency must be a 3-letter code");
  const shot = String(input.screenshot_sha256 || "").toLowerCase();
  if (!HEX64.test(shot)) throw new Error("purchase item: screenshot_sha256 missing");
  const ship = input.ship_to;
  return {
    v: 1,
    merchant: str(input.merchant, "merchant", { max: 80 }),
    site: siteHost(input.site),
    items: items.map((it, i) => ({
      title: str(it?.title, `items[${i}].title`, { max: 200 }),
      qty: (() => {
        const q = it?.qty;
        if (!Number.isInteger(q) || q < 1 || q > 10000) throw new Error(`purchase item: items[${i}].qty must be a positive integer`);
        return q;
      })(),
      line_cents: cents(it?.line_cents, `items[${i}].line_cents`, { optional: true }),
    })),
    subtotal_cents: cents(input.subtotal_cents, "subtotal_cents", { optional: true }),
    shipping_cents: cents(input.shipping_cents, "shipping_cents", { optional: true }),
    tax_cents: cents(input.tax_cents, "tax_cents", { optional: true }),
    discount_cents: cents(input.discount_cents, "discount_cents", { optional: true, allowNegative: true }),
    total_cents: cents(input.total_cents, "total_cents", { allowZero: false }),
    currency,
    card: { label: str(card.label, "card.label", { max: 80 }), last4 },
    ship_to: ship == null ? null : {
      name: str(ship.name, "ship_to.name", { max: 120 }),
      address: str(ship.address, "ship_to.address", { max: 300 }),
    },
    screenshot_sha256: shot,
  };
}

export function purchaseHash(item) {
  return itemHash(normalizePurchaseItem(item));
}

export function buildPurchaseRequest(id, item, { now = Date.now(), nonce = null, ttlMs = PURCHASE_TTL_MS } = {}) {
  const norm = normalizePurchaseItem(item);
  const req = buildApprovalRequest(id, norm, { now, nonce, ttlMs });
  return { ...req, domain: PURCHASE_DOMAIN, item: norm,
    message: `${PURCHASE_DOMAIN}\n${req.id}\n${req.hash}\n${req.nonce}\n${req.expiresAt}` };
}

/**
 * Verify a signed purchase row before anything is clicked. `row` is the
 * purchase_approvals row; `publicKeyRawB64` the paired device key for
 * row.signed_by. Returns {ok, reason}.
 */
export function verifyPurchaseRow(row, publicKeyRawB64, { now = Date.now() } = {}) {
  if (!row) return { ok: false, reason: "no row" };
  if (!row.signature || !row.signed_by) return { ok: false, reason: "unsigned" };
  if (!publicKeyRawB64) return { ok: false, reason: "signing device is not a paired purchase device" };
  let item;
  try { item = normalizePurchaseItem(row.item_json); } catch (e) { return { ok: false, reason: `item invalid: ${e.message}` }; }
  const expiresAt = Number(row.expires_at_ms);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: "no expiry" };
  if (now > expiresAt + EXECUTE_GRACE_MS) return { ok: false, reason: "expired" };
  const request = { id: row.id, hash: row.item_hash, nonce: row.nonce, expiresAt, domain: PURCHASE_DOMAIN };
  // checkApproval's own expiry check would refuse inside the grace window, so
  // it is handed a clock pinned at expiry when we are inside the grace.
  return checkApproval({ request, item, signatureB64: row.signature, publicKeyRawB64, now: Math.min(now, expiresAt) });
}

// The ways a review page can print an amount. Used to confirm, deterministically,
// that the page about to be submitted still shows the approved total.
export function amountRenderings(totalCents) {
  const neg = totalCents < 0;
  const abs = Math.abs(totalCents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  const grouped = (sep) => String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const out = new Set([
    `${grouped(",")}.${frac}`, `${whole}.${frac}`,        // 1,234.56 / 1234.56
    `${grouped(".")},${frac}`, `${whole},${frac}`,        // 1.234,56 / 1234,56
    `${grouped(" ")},${frac}`, `${grouped(" ")},${frac}`, // 1 234,56
  ]);
  return [...out].map((s) => (neg ? "-" + s : s));
}

/**
 * Check a review page's visible text against the approved item. The text is
 * the page's rendered DOM (machine output of a merchant site, not anything
 * the user wrote). Returns {ok, missing:[...]}: the total and the card's last 4
 * must both be on the page; the ship-to postcode too when one is present.
 */
export function pageMatchesItem(pageText, item) {
  const text = String(pageText || "").replace(/\s+/g, " ");
  const missing = [];
  // An amount must stand alone: "$1,234.56" passes, "$11,234.56" must not.
  const hasAmount = amountRenderings(item.total_cents).some((a) => {
    let i = text.indexOf(a);
    while (i !== -1) {
      const before = text[i - 1];
      const after = text[i + a.length];
      if (!(before && /[0-9.,]/.test(before)) && !(after && /[0-9]/.test(after))) return true;
      i = text.indexOf(a, i + 1);
    }
    return false;
  });
  if (!hasAmount) missing.push(`total ${formatMoney(item.total_cents, item.currency)}`);
  if (!text.includes(item.card.last4)) missing.push(`card ending ${item.card.last4}`);
  const postcode = item.ship_to ? shipPostcode(item.ship_to.address) : null;
  if (postcode && !text.includes(postcode)) missing.push(`ship-to postcode ${postcode}`);
  return { ok: missing.length === 0, missing };
}

// A US ZIP at the end of a postal address the agent copied off the page.
function shipPostcode(addr) {
  const m = String(addr || "").match(/\b(\d{5})(?:-\d{4})?\s*(?:,?\s*(?:USA|US|United States))?\s*$/i);
  return m ? m[1] : null;
}

export function formatMoney(c, currency = "USD") {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  const body = `${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
  return currency === "USD" ? `${sign}$${body}` : `${sign}${body} ${currency}`;
}

// One line for the push / chat: "$1,234.56 at Example Store — 2 items, Visa ••4242".
export function summarize(item) {
  const n = item.items.reduce((a, it) => a + it.qty, 0);
  const what = item.items.length === 1 && item.items[0].qty === 1 ? item.items[0].title : `${n} items`;
  return `${formatMoney(item.total_cents, item.currency)} at ${item.merchant} — ${what}, ${item.card.label} ••${item.card.last4}`;
}

/**
 * A page title the browser reported, made fit to quote in a chat line:
 * invisible code points (zero-width spaces and joiners, byte-order marks, bidi
 * marks, soft hyphens, control characters, blank filler letters) removed,
 * whitespace collapsed, long titles cut. "" when nothing visible is left, so a
 * caller never quotes an empty-looking title.
 */
export function cleanPageTitle(title, { max = 120 } = {}) {
  const s = String(title ?? "")
    // lang-regex-ok: drops invisible format code points from a browser-reported page title (structure, not meaning)
    .replace(/[\p{Cf}\u115F\u1160\u3164\uFFA0\u2800]/gu, "")
    // lang-regex-ok: turns control characters and runs of whitespace into single spaces
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max - 1).join("").trimEnd() + "…" : s;
}

/**
 * The chat confirmation once an approved order has gone through: one sentence
 * with the total, the card and what was bought, then the page's title when the
 * page reported a visible one. Each line keeps its own quantity ("2 × <title>");
 * lines are never summed into an "N items" count, because a fee or delivery
 * line on the review page is a line, not a thing bought.
 */
export function placedMessage(item, pageTitle) {
  const lines = item.items.map((it) => (it.qty > 1 ? `${it.qty} × ${it.title}` : it.title));
  const [first, ...rest] = lines;
  const others = rest.length === 0 ? ""
    : rest.length <= 2 ? `, plus ${rest.join(" and ")}`
    : `, plus ${rest[0]} and ${rest.length - 1} more`;
  const ship = item.ship_to ? `, shipping to ${item.ship_to.name}` : "";
  const title = cleanPageTitle(pageTitle);
  const after = title ? ` ${item.merchant}'s page now reads “${title}”.` : " The confirmation email should follow shortly.";
  return `Your ${item.merchant} order went through, ${formatMoney(item.total_cents, item.currency)} on your ${item.card.label} ending ${item.card.last4}, for ${first}${others}${ship}.${after}`;
}
