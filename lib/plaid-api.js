"use strict";
// plaid-api.js — minimal Plaid REST client for the bank-account integration.
//
// READ-ONLY by design: this client only ever calls the link / item / accounts /
// transactions endpoints. It deliberately does NOT implement any /transfer/*
// endpoint, so the integration cannot move money (see agent/CLAUDE.md
// § Financial Operations — Hard Limits). Do not add transfer endpoints here.
//
// Auth model: client_id + per-environment secret on every request body.
//   PLAID_CLIENT_ID  — public-ish app id (same across environments)
//   PLAID_SECRET     — environment-specific secret (sandbox vs production)
//   PLAID_ENV        — "sandbox" (default) | "production"
// All three come from .env (loadEnv) on the host; keep the canonical copy of
// the secrets in the operator's password manager.
//
// No SDK dependency — Plaid is a plain JSON-over-HTTPS API and global fetch
// (Node 18+) is all we need, matching supabase-rest.js's lightweight style.

const { loadEnv } = require("./load-env.js");
loadEnv();

const BASE_URLS = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

function env() {
  return process.env.PLAID_ENV === "production" ? "production" : "sandbox";
}

function baseUrl() {
  return BASE_URLS[env()];
}

function creds() {
  const client_id = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!client_id || !secret) {
    throw new Error(
      "PLAID_CLIENT_ID / PLAID_SECRET missing — set them in .env " +
        "(keep the canonical copy in your password manager)."
    );
  }
  return { client_id, secret };
}

/**
 * Low-level POST to a Plaid endpoint. Injects client_id+secret into the body.
 * On a Plaid API error (non-2xx with an error envelope), throws an Error whose
 * `.plaid` property is the parsed error body ({error_code, error_type, ...}) so
 * callers can branch on e.g. ITEM_LOGIN_REQUIRED without re-parsing.
 *
 * @param {string} path  e.g. "/transactions/sync"
 * @param {object} body  endpoint-specific fields
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]  balance pulls can be slow (p95 ~11s)
 */
async function post(path, body, { timeoutMs = 30000 } = {}) {
  const { client_id, secret } = creds();
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id, secret, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* fall through to the non-JSON error below */
  }
  if (!res.ok || (data && data.error_code)) {
    const code = data && data.error_code ? data.error_code : `HTTP ${res.status}`;
    const msg = data && data.error_message ? data.error_message : text.slice(0, 300);
    const err = new Error(`Plaid ${path}: ${code} — ${msg}`);
    err.plaid = data || { error_code: `HTTP_${res.status}`, error_message: text.slice(0, 300) };
    err.status = res.status;
    throw err;
  }
  return data;
}

/** True if a thrown error means the Item needs re-authentication (re-run Link in update mode). */
function isLoginRequired(err) {
  const code = err && err.plaid && err.plaid.error_code;
  return code === "ITEM_LOGIN_REQUIRED" || code === "PENDING_DISCONNECT" || code === "PENDING_EXPIRATION";
}

/**
 * True if the error is Plaid's problem rather than ours, and trying again may
 * simply work.
 *
 * `INTERNAL_SERVER_ERROR` is the one that mattered: on 2026-09-03 one bank's
 * balance call answered with it, and because nothing retried and nothing
 * isolated the failure, the three Items later in the same loop went a full
 * day without a refresh. Plaid documents this class as
 * retryable, and a second attempt a few seconds later is usually enough.
 *
 * Deliberately NOT retried: anything about consent, credentials or products.
 * ITEM_LOGIN_REQUIRED needs a human at a bank's login page, and hammering it
 * only delays the alert that says so.
 */
const RETRYABLE_CODES = new Set([
  "INTERNAL_SERVER_ERROR",
  "PLANNED_MAINTENANCE",
  "RATE_LIMIT_EXCEEDED",
  "INSTITUTION_DOWN",
  "INSTITUTION_NOT_RESPONDING",
]);

function isRetryable(err) {
  if (!err) return false;
  if (isLoginRequired(err)) return false;
  const code = err.plaid && err.plaid.error_code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  // A 5xx with no envelope, and a timeout or socket error from fetch itself:
  // both are "the request never got a real answer", which is the same case.
  if (typeof err.status === "number" && err.status >= 500) return true;
  return err.name === "TimeoutError" || err.name === "AbortError" || err.code === "ECONNRESET";
}

/**
 * Run `fn`, retrying a transient failure with a widening gap.
 *
 * Three attempts at 2s and 6s. Short enough that the nightly run does not
 * stretch — the whole sync takes about 45 seconds — and long enough to clear
 * the blip that a Plaid 500 usually is. `onRetry` exists so the log says a
 * retry happened; a silent retry turns a degrading connection into a mystery.
 */
async function withRetry(fn, { attempts = 3, delaysMs = [2000, 6000], onRetry } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt === attempts - 1 || !isRetryable(e)) throw e;
      if (onRetry) onRetry(e, attempt + 1);
      await new Promise((r) => setTimeout(r, delaysMs[attempt] ?? delaysMs[delaysMs.length - 1]));
    }
  }
  throw lastError;
}

// ── Link / connection setup ─────────────────────────────────────────────────

/**
 * How far back Plaid backfills transactions for a newly linked Item, in days.
 *
 * Plaid's own default is 90 days, and it is set ONCE at link time — an Item
 * linked at 90 days never learns about anything older, no matter how often it
 * syncs. 730 is Plaid's maximum and the only value that lets a year-end P&L
 * reach back into the previous tax year. Institutions may return less than they
 * are asked for (some card issuers routinely return less); the caller checks what actually
 * arrived rather than assuming two years.
 */
const TRANSACTION_HISTORY_DAYS = 730;

/**
 * Create a Link token configured for Hosted Link, so the one-time bank login
 * happens in a plain browser with no frontend to build. Returns the full
 * /link/token/create response, including `hosted_link_url` and `link_token`.
 *
 * @param {object} opts
 * @param {string} opts.userId            stable client_user_id (e.g. instance().owner_id)
 * @param {string[]} [opts.products=["transactions"]]  read-only products only
 * @param {string} [opts.redirectUri]     required for OAuth banks if NOT using
 *                                         hosted link; with hosted link Plaid
 *                                         supplies its own redirect, so omit.
 * @param {string} [opts.webhook]         optional webhook URL
 * @param {number} [opts.daysRequested=730]  how far back to backfill transactions
 */
async function createLinkToken({
  userId,
  products = ["transactions"],
  redirectUri,
  webhook,
  accessToken,
  daysRequested = TRANSACTION_HISTORY_DAYS,
} = {}) {
  if (!userId) throw new Error("createLinkToken: userId is required");
  const body = {
    user: { client_user_id: userId },
    client_name: "Jori",
    language: "en",
    country_codes: ["US"],
    hosted_link: {}, // enables Hosted Link → response includes hosted_link_url
    // How much history the Item will EVER hold. Plaid fixes this at link time
    // and silently defaults to 90 days — which is how the first year of Items
    // ended up unable to answer a tax question. Raising it on an existing Item
    // requires an update-mode re-link (see plaid-connect update).
    transactions: { days_requested: daysRequested },
  };
  // Update mode: pass the existing Item's access_token to re-consent / add a
  // product (e.g. add `liabilities` to a card linked with transactions-only).
  // In add-product update mode Plaid wants the NEW products listed alongside
  // the access_token; in plain re-auth mode products are omitted.
  if (accessToken) {
    body.access_token = accessToken;
    if (products && products.length) body.products = products;
  } else {
    body.products = products;
  }
  if (redirectUri) body.redirect_uri = redirectUri;
  if (webhook) body.webhook = webhook;
  return post("/link/token/create", body);
}

/** Credit-card (and loan/mortgage) liabilities: statement balance, due date,
 *  minimum payment, APRs, is_overdue, last payment. Requires the `liabilities`
 *  product consent on the Item (throws ADDITIONAL_CONSENT_REQUIRED otherwise). */
async function getLiabilities(accessToken) {
  return post("/liabilities/get", { access_token: accessToken });
}

/**
 * Fetch the state of a Link token. After the user finishes Hosted Link, the
 * response's `link_sessions` carry the `public_token`. Used to poll for
 * completion of the one-time browser step without any frontend callback.
 */
async function getLinkToken(linkToken) {
  return post("/link/token/get", { link_token: linkToken });
}

/**
 * Pull the public_token out of a /link/token/get response, or null if the user
 * hasn't completed Hosted Link yet. Plaid's hosted-link results live under
 * `link_sessions[].results.item_add_results[].public_token`.
 */
function extractPublicToken(linkTokenGetResponse) {
  const sessions = (linkTokenGetResponse && linkTokenGetResponse.link_sessions) || [];
  for (const s of sessions) {
    const adds = (s.results && s.results.item_add_results) || [];
    for (const a of adds) {
      if (a.public_token) return a.public_token;
    }
  }
  return null;
}

/** Exchange a short-lived public_token for the durable access_token + item_id. */
async function exchangePublicToken(publicToken) {
  return post("/item/public_token/exchange", { public_token: publicToken });
}

// ── Sandbox-only helpers ────────────────────────────────────────────────────

/**
 * Sandbox shortcut: mint a public_token directly for a test institution,
 * bypassing the browser Link step entirely. Only works in sandbox; lets us
 * prove the exchange → sync pipeline end-to-end without a human. BofA's
 * sandbox institution id is ins_127989.
 */
async function sandboxPublicToken({ institutionId = "ins_127989", products = ["transactions"] } = {}) {
  if (env() !== "sandbox") throw new Error("sandboxPublicToken is sandbox-only");
  return post("/sandbox/public_token/create", {
    institution_id: institutionId,
    initial_products: products,
  });
}

// ── Reading data ────────────────────────────────────────────────────────────

/** Accounts with a live balance refresh from the bank. Rate limit: 5/min, 30/hr per Item. */
async function getBalances(accessToken) {
  return post("/accounts/balance/get", { access_token: accessToken });
}

/**
 * Accounts + balances, CACHED and FREE — the default read for the sync.
 *
 * Same response shape as getBalances ({ accounts: [{ balances: {available,
 * current, limit, ...} }], item }), but Plaid serves it from its own last
 * successful Item update instead of dialling the bank. /accounts/balance/get is
 * a PAID endpoint ($0.10/call): in August 2026 it was 304 calls = $30.40 of a
 * $35.40 invoice, 86% of the bill, purely because the sync asked for a forced
 * refresh once per Item per run.
 *
 * The forced refresh stopped being worth paying for the moment the sync went
 * event-driven. We now run BECAUSE Plaid told us it just updated the Item, so
 * "the balance at the time of the last successful Item update" is the balance
 * from seconds ago — we were paying to redo a refresh Plaid had already done.
 * It also decouples cost from frequency: syncing more often is now free, which
 * is what makes the webhook design cheaper than the cron it replaced rather
 * than twice the price.
 *
 * Bonus over the paid call: balances carry `last_updated_datetime`, so a reader
 * can tell how stale a figure actually is instead of assuming.
 *
 * Use getBalances instead only when a caller genuinely needs the bank's
 * this-instant number — an interactive "what is my balance right now".
 */
async function getAccounts(accessToken) {
  return post("/accounts/get", { access_token: accessToken });
}

/**
 * Investment holdings for an Item — positions, not trades.
 *
 * Preferred over a broker's own OAuth: a broker refresh token that lapses every
 * few days pages the user to re-authorise by hand, while a Plaid Item
 * refreshes without a manual step.
 *
 * READ-ONLY, and structurally so: this is `/investments/holdings/get`. There is
 * no order-placement endpoint in this file and there must never be — the same
 * rule that keeps `/transfer/*` out of it (agent/CLAUDE.md § Financial
 * Operations, rules 1 and 5). Jori reads positions; it cannot trade.
 *
 * The response splits what belongs together: `holdings[]` carries quantity and
 * value keyed by `security_id`, while ticker and name live in `securities[]`.
 * Callers want them joined, so `holdingsJoined` below does that once rather
 * than in every consumer.
 */
async function getHoldings(accessToken) {
  return post("/investments/holdings/get", { access_token: accessToken });
}

/**
 * `getHoldings` with securities resolved onto each holding, shaped to match the
 * brokerage positions table's columns so downstream readers change as little as possible.
 */
async function holdingsJoined(accessToken) {
  const res = await getHoldings(accessToken);
  const securities = new Map((res.securities || []).map((s) => [s.security_id, s]));
  const accounts = new Map((res.accounts || []).map((a) => [a.account_id, a]));
  const rows = (res.holdings || []).map((h) => {
    const sec = securities.get(h.security_id) || {};
    const acct = accounts.get(h.account_id) || {};
    const qty = Number(h.quantity);
    const price = h.institution_price != null ? Number(h.institution_price) : null;
    return {
      account_id: h.account_id,
      account_name: acct.name || acct.official_name || null,
      account_mask: acct.mask || null,
      security_id: h.security_id,
      // Cash positions have no ticker; give them a stable one so a row is never
      // keyed on null and the portfolio math can see uninvested cash.
      ticker: sec.ticker_symbol || (sec.type === "cash" ? "CASH" : null),
      name: sec.name || null,
      asset_type: sec.type || null,
      shares: Number.isFinite(qty) ? qty : null,
      current_price: Number.isFinite(price) ? price : null,
      market_value: h.institution_value != null ? Number(h.institution_value) : null,
      cost_basis: h.cost_basis != null ? Number(h.cost_basis) : null,
      iso_currency_code: h.iso_currency_code || h.unofficial_currency_code || null,
      price_as_of: h.institution_price_as_of || sec.close_price_as_of || null,
    };
  });
  return { rows, accounts: res.accounts || [], item: res.item || null };
}

/** Item metadata (institution_id, available products, error state). */
async function getItem(accessToken) {
  return post("/item/get", { access_token: accessToken });
}

/**
 * Disconnect an Item at Plaid, invalidating its access token.
 *
 * The ONLY destructive call in this client, and it exists for exactly one
 * reason: an Item's transaction-history window is fixed when Transactions is
 * first added to it and cannot be widened afterwards. Plaid's documented remedy
 * is to remove the Item and link it again — so reaching further back than the
 * original `days_requested` is impossible without this.
 *
 * It still cannot move money. It destroys a *connection*, not funds, and the
 * rows already synced to Supabase are untouched — they are keyed by the old
 * account ids and survive until something deletes them deliberately.
 *
 * Removal is irreversible: the access token dies with the Item and re-linking
 * means sending the user through the bank login again. Callers must capture
 * whatever they need about the Item (account ids, masks) BEFORE calling this.
 */
async function removeItem(accessToken) {
  return post("/item/remove", { access_token: accessToken });
}

/**
 * Point an ALREADY-LINKED Item at a webhook URL (or clear it with null).
 *
 * This is what makes the sync event-driven without touching the link itself.
 * It matters that this is not `plaid-connect link`: an Item's transaction
 * history window is fixed at link time and cannot be widened (see removeItem),
 * so re-linking to attach a webhook would silently trade history depth for
 * timeliness. /item/webhook/update changes only the callback address.
 *
 * Plaid answers the call, then fires ITEM/WEBHOOK_UPDATE_ACKNOWLEDGED at the
 * NEW url — which doubles as the end-to-end proof that the tunnel, the route
 * and the signature check all work.
 */
async function updateItemWebhook(accessToken, webhook) {
  return post("/item/webhook/update", { access_token: accessToken, webhook: webhook || null });
}

/**
 * Fetch the public JWK for a webhook signature, by the `kid` in its header.
 *
 * Plaid rotates these keys, so the `kid` is looked up per unknown key rather
 * than pinned. Keys are cached by the caller (plaid-webhook.mjs).
 */
async function getWebhookVerificationKey(keyId) {
  return post("/webhook_verification_key/get", { key_id: keyId });
}

/** Institution display details (name, etc.) by id. */
async function getInstitution(institutionId) {
  return post("/institutions/get_by_id", {
    institution_id: institutionId,
    country_codes: ["US"],
  });
}

/**
 * One page of /transactions/sync. Cursor-based incremental sync (current best
 * practice; replaces /transactions/get). Returns { added, modified, removed,
 * next_cursor, has_more }. Caller loops while has_more, persisting next_cursor.
 *
 * @param {string} accessToken
 * @param {string|null} cursor   null/undefined for the first ever sync
 * @param {number} [count=250]
 */
async function syncTransactions(accessToken, cursor, count = 250) {
  const body = { access_token: accessToken, count };
  if (cursor) body.cursor = cursor;
  return post("/transactions/sync", body);
}

/**
 * Drain /transactions/sync to completion, following has_more. Returns the
 * merged { added, modified, removed, cursor } across all pages.
 */
async function syncAllTransactions(accessToken, cursor) {
  const added = [];
  const modified = [];
  const removed = [];
  let next = cursor || null;
  let hasMore = true;
  while (hasMore) {
    const page = await syncTransactions(accessToken, next);
    added.push(...(page.added || []));
    modified.push(...(page.modified || []));
    removed.push(...(page.removed || []));
    next = page.next_cursor;
    hasMore = page.has_more;
  }
  return { added, modified, removed, cursor: next };
}

module.exports = {
  env,
  baseUrl,
  isLoginRequired,
  isRetryable,
  withRetry,
  createLinkToken,
  getLinkToken,
  extractPublicToken,
  exchangePublicToken,
  sandboxPublicToken,
  getBalances,
  getAccounts,
  getLiabilities,
  getHoldings,
  holdingsJoined,
  getItem,
  removeItem,
  updateItemWebhook,
  getWebhookVerificationKey,
  getInstitution,
  syncTransactions,
  syncAllTransactions,
};
