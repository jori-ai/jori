// plaid-webhook.mjs — Plaid's SYNC_UPDATES_AVAILABLE webhook, verified and
// turned into a plaid-sync run for the one Item that changed.
//
// WHY THIS EXISTS. plaid-sync used to run on a clock, just after midnight. That
// is the worst hour available: a US banking day posts in the hours AFTER
// midnight, and standard next-day ACH credits (which is what rent is) settle in
// the Fed's early-morning Eastern window. So a midnight pull always read the
// previous day's close and carried a structural ~24h lag on anything landing
// that morning — worse at banks that send Plaid no pending rows at all, where a
// deposit is invisible until it posts and then waited a further cycle to be seen.
//
// The clock was never the real signal. /transactions/sync returns Plaid's own
// CACHED copy of the Item, refreshed on Plaid's schedule, so any cron time is a
// guess about when that refresh happened. SYNC_UPDATES_AVAILABLE is Plaid
// saying "the cache you read has new rows in it" — the actual event. The cron
// stays on as a safety net for webhooks missed while the host is down.
//
// DETERMINISTIC, like plaid-sync itself: this dispatches to NO agent and calls
// no Anthropic API. It shells out to bin/plaid-sync. That is deliberate —
// the sync must keep working when the model budget is exhausted, and putting a
// public endpoint on the model's dispatch path would let anyone who can reach
// the tunnel spend tokens.
//
// READ-ONLY: the only thing a valid webhook can cause is a plaid-sync run, and
// plaid-sync has no code path that moves money (agent/CLAUDE.md
// § Financial Operations — Hard Limits).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// plaid-api.js is CJS and calls loadEnv() on import, which is how this module
// gets PLAID_CLIENT_ID/PLAID_SECRET without the supervisor having to know they
// exist. Imported lazily so a supervisor with no Plaid config still boots.
const require_ = createRequire(import.meta.url);

const { TOOLS_DIR, installTools } = require_(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../lib/root.cjs"));
const PLAID_API = path.join(TOOLS_DIR, "lib/plaid-api.js");
const PLAID_SYNC_BIN = path.join(TOOLS_DIR, "bin/plaid-sync");
// The investment-positions feed is a separate, optional tool: an installation
// without it simply ignores holdings webhooks (see handlePlaidWebhook).
const PLAID_HOLDINGS_BIN = path.join(TOOLS_DIR, "bin/plaid-holdings-sync");
const LOGFILE = installTools("agent/logs/plaid-sync.log");
// Two switches, on purpose: .plaid-sync-off stops the cron AND this (the sync
// is off entirely); .plaid-webhook-off stops only the event path, leaving the
// cron as the fallback while the endpoint is being worked on.
const SYNC_OFF = installTools("data/.plaid-sync-off");
const WEBHOOK_OFF = installTools("data/.plaid-webhook-off");

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // Plaid's own recommended replay window
const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEBOUNCE_MS = 5000;       // batch a burst of webhooks for one Item
const SYNC_TIMEOUT_MS = 10 * 60 * 1000;

function log(line) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const msg = `${stamp} [plaid-webhook] ${line}`;
  try { fs.appendFileSync(LOGFILE, msg + "\n"); } catch { /* log dir gone; stderr still has it */ }
  console.error(msg);
}

// ── Signature verification ──────────────────────────────────────────────────

// kid → { jwk } | { missing: true }. Negative entries are cached too, and
// briefly, so a flood of requests carrying invented kids cannot turn into a
// flood of outbound /webhook_verification_key/get calls.
const _keyCache = new Map();

async function getVerificationKey(kid) {
  const hit = _keyCache.get(kid);
  if (hit && Date.now() < hit.expiresAt) {
    if (hit.missing) throw new Error(`unknown signing key ${kid}`);
    return hit.jwk;
  }
  const plaid = require_(PLAID_API);
  let res;
  try {
    res = await plaid.getWebhookVerificationKey(kid);
  } catch (err) {
    _keyCache.set(kid, { missing: true, expiresAt: Date.now() + 60 * 1000 });
    throw new Error(`key lookup failed for ${kid}: ${err.message}`);
  }
  const jwk = res && res.key;
  if (!jwk || jwk.alg !== "ES256") {
    _keyCache.set(kid, { missing: true, expiresAt: Date.now() + 60 * 1000 });
    throw new Error(`key ${kid} is not an ES256 JWK`);
  }
  _keyCache.set(kid, { jwk, expiresAt: Date.now() + KEY_CACHE_TTL_MS });
  return jwk;
}

// Test seam, mirroring oidc-verify.mjs's _setJwksForTest: lets the suite inject
// a locally-minted public key so signature verification is proven offline, with
// no Plaid credentials and no network.
export function _setKeyForTest(kid, jwk) {
  if (jwk === null) _keyCache.clear();
  else _keyCache.set(kid, { jwk, expiresAt: Date.now() + KEY_CACHE_TTL_MS });
}

/**
 * Verify a Plaid webhook. Throws on ANY doubt — this endpoint is on the public
 * internet through the Cloudflare Tunnel, so it fails closed.
 *
 * @param {Buffer} rawBody  the bytes as received. NOT a re-serialized object:
 *                          request_body_sha256 is a hash of what Plaid sent,
 *                          and JSON.stringify(JSON.parse(x)) is not always x.
 * @param {string} verificationHeader  the Plaid-Verification header (a JWT)
 */
export async function verifyPlaidWebhook(rawBody, verificationHeader) {
  if (!verificationHeader) throw new Error("missing Plaid-Verification header");
  const parts = String(verificationHeader).split(".");
  if (parts.length !== 3) throw new Error("malformed verification JWT");
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  // Reject anything but ES256 explicitly. Accepting the token's own claim about
  // its algorithm is the classic JWT confusion bug; "none" and an HMAC alg keyed
  // on the public key are both forgeable.
  if (header.alg !== "ES256") throw new Error(`unexpected alg ${header.alg}`);
  if (!header.kid || typeof header.kid !== "string") throw new Error("missing kid");

  const jwk = await getVerificationKey(header.kid);
  const pubKey = crypto.createPublicKey({ key: jwk, format: "jwk" });

  // JOSE ES256 signatures are raw r||s, not the DER envelope Node assumes by
  // default — without ieee-p1363 every genuine signature fails to verify.
  const ok = crypto.verify(
    "sha256",
    Buffer.from(`${headerB64}.${payloadB64}`),
    { key: pubKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(sigB64, "base64url")
  );
  if (!ok) throw new Error("bad signature");

  const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));

  // Replay window. A signature stays valid forever otherwise, so a captured
  // webhook could be replayed indefinitely to force syncs.
  const iatMs = Number(claims.iat) * 1000;
  if (!Number.isFinite(iatMs)) throw new Error("missing iat");
  if (Date.now() - iatMs > MAX_CLOCK_SKEW_MS) throw new Error("stale webhook (iat outside 5m)");

  // Body integrity. The signature covers the JWT, not the body; this claim is
  // the only thing binding the two together.
  const expected = claims.request_body_sha256;
  if (typeof expected !== "string") throw new Error("missing request_body_sha256");
  const actual = crypto.createHash("sha256").update(rawBody).digest("hex");
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("body hash mismatch");
  }

  return JSON.parse(rawBody.toString("utf8"));
}

// ── Sync scheduling ─────────────────────────────────────────────────────────

// "<bin>\0<item_id>" → { running, dirty, timer }. One run per script per Item at
// a time: Plaid can fire several webhooks for the same Item seconds apart, and
// two concurrent plaid-sync runs on one Item would race on the stored cursor —
// the loser overwrites the winner's position and the rows between them are
// skipped until something resets the cursor. `dirty` is what makes coalescing
// safe: a webhook arriving mid-run is not dropped, it re-runs once the current
// run finishes.
//
// The key includes the BINARY, not just the Item, because bank and investment
// feeds are independent: an Item carrying both products can legitimately have a
// transactions sync and a holdings sync in flight together, and they touch
// different tables and different cursors. Keying on the Item alone would make
// one silently coalesce into the other and drop it.
const _state = new Map();
const keyOf = (bin, itemId) => `${bin}\u0000${itemId}`;
const nameOf = (bin) => path.basename(bin);

function runSync(bin, itemId) {
  const st = _state.get(keyOf(bin, itemId));
  st.running = true;
  st.dirty = false;
  log(`${nameOf(bin)} start item=${itemId}`);
  execFile(
    process.execPath,
    [bin, "--item", itemId],
    { timeout: SYNC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) log(`${nameOf(bin)} FAILED item=${itemId}: ${err.message}`);
      else log(`${nameOf(bin)} ok item=${itemId}`);
      if (stderr && stderr.trim()) {
        try { fs.appendFileSync(LOGFILE, stderr.endsWith("\n") ? stderr : stderr + "\n"); } catch {}
      }
      st.running = false;
      if (st.dirty) schedule(bin, itemId);
      else _state.delete(keyOf(bin, itemId));
    }
  );
}

function schedule(bin, itemId) {
  const key = keyOf(bin, itemId);
  let st = _state.get(key);
  if (!st) { st = { running: false, dirty: false, timer: null }; _state.set(key, st); }
  if (st.running) { st.dirty = true; log(`${nameOf(bin)} in flight item=${itemId} — coalescing`); return; }
  if (st.timer) return; // already waiting out the debounce
  st.timer = setTimeout(() => { st.timer = null; runSync(bin, itemId); }, DEBOUNCE_MS);
  if (st.timer.unref) st.timer.unref();
}

// ── Dispatch ────────────────────────────────────────────────────────────────

// Codes that mean "there is new transaction data for this Item".
// SYNC_UPDATES_AVAILABLE is the one that fires for /transactions/sync, which is
// the only read path plaid-sync uses; the other three belong to the legacy
// /transactions/get flow and are accepted so a stray one still triggers a pull
// rather than being silently discarded.
const SYNC_CODES = new Set([
  "SYNC_UPDATES_AVAILABLE",
  "DEFAULT_UPDATE",
  "INITIAL_UPDATE",
  "HISTORICAL_UPDATE",
  "TRANSACTIONS_REMOVED",
]);

// Codes that mean "this Item's investment positions moved".
//
// These route to plaid-holdings-sync, NOT plaid-sync — a different feed into a
// different table (plaid_holdings). An investments-only brokerage Item answers
// ADDITIONAL_CONSENT_REQUIRED for /transactions/sync, so sending these to
// plaid-sync would do nothing but log a consent error.
//
// Free to run as often as Plaid asks: Investments is billed on a subscription,
// unlike Balance, whose per-call charge was most of a month's invoice (see
// docs/plaid-setup.md § What this costs). The paid investment endpoint is
// /investments/refresh, which this integration does not call.
const HOLDINGS_TYPES = new Set(["HOLDINGS", "INVESTMENTS_TRANSACTIONS"]);

// Item trouble. These trigger a sync rather than their own alert: plaid-sync
// already recognises a broken Item and sends the re-auth push with a fresh
// Hosted Link. Duplicating that here
// would mean two alert paths to keep in step.
const ITEM_CODES = new Set([
  "ERROR",
  "LOGIN_REPAIRED",
  "PENDING_DISCONNECT",
  "PENDING_EXPIRATION",
  "USER_PERMISSION_REVOKED",
  "USER_ACCOUNT_REVOKED",
  "NEW_ACCOUNTS_AVAILABLE",
]);

/**
 * Act on a verified webhook. Never throws and never blocks: Plaid retries on a
 * non-2xx and gives up on a slow endpoint, so the caller acks immediately and
 * the sync happens on its own after the debounce.
 */
export function handlePlaidWebhook(payload) {
  const type = payload && payload.webhook_type;
  const code = payload && payload.webhook_code;
  const itemId = payload && payload.item_id;

  if (fs.existsSync(SYNC_OFF) || fs.existsSync(WEBHOOK_OFF)) {
    log(`kill switch present, ignoring ${type}/${code}`);
    return { action: "killswitch" };
  }
  if (!itemId) { log(`${type}/${code} with no item_id — ignored`); return { action: "ignored" }; }

  if (type === "TRANSACTIONS" && SYNC_CODES.has(code)) {
    schedule(PLAID_SYNC_BIN, itemId);
    return { action: "sync", item_id: itemId };
  }
  if (HOLDINGS_TYPES.has(type) && code === "DEFAULT_UPDATE") {
    if (!fs.existsSync(PLAID_HOLDINGS_BIN)) {
      log(`${type}/${code} item=${itemId} — no plaid-holdings-sync in this install, ignored`);
      return { action: "ignored" };
    }
    schedule(PLAID_HOLDINGS_BIN, itemId);
    return { action: "holdings", item_id: itemId };
  }
  if (type === "ITEM" && code === "WEBHOOK_UPDATE_ACKNOWLEDGED") {
    // Not noise: this is the receipt for /item/webhook/update, and seeing it
    // land is the proof the tunnel, route and signature check all work.
    log(`webhook registered for item=${itemId}`);
    return { action: "acknowledged", item_id: itemId };
  }
  if (type === "ITEM" && ITEM_CODES.has(code)) {
    log(`ITEM/${code} item=${itemId} — syncing so plaid-sync can raise it`);
    schedule(PLAID_SYNC_BIN, itemId);
    return { action: "sync", item_id: itemId };
  }

  log(`unhandled ${type}/${code} item=${itemId}`);
  return { action: "ignored" };
}
