// push-relay.mjs — the host side of the Jori push relay (docs/push-relay.md).
//
// A host on the shared Jori app holds no Apple key: it encrypts each push to
// every paired device's public key and hands the ciphertext to the relay
// (push-relay/), which signs APNs with the one shared key.
//
// Setup:
//   agent/local/config/push-relay.json  { relay_url, instance_id }
//   .env                                JORI_PUSH_RELAY_SECRET=<instance secret>
//   JORI_PUSH_RELAY_URL (env) overrides relay_url.
// registerInstance() writes both. relayConfig() is null until all three exist,
// and lib/apns-push.mjs then keeps pushing directly with its own key.
//
// A test run (node --test) never reaches a relay: every network call refuses
// unless the test hands in its own `fetch` (as sendOne does in apns-push).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { underTestRunner, DEFAULT_ENV_PATH } = require("./load-env.js");
const instanceLib = () => require("./instance.cjs");

export const SECRET_ENV = "JORI_PUSH_RELAY_SECRET";
export const URL_ENV = "JORI_PUSH_RELAY_URL";
export const HKDF_INFO = "jori-push-v1";
export const MAX_CIPHERTEXT_CHARS = 3500;
// ephemeral key 65 + nonce 12 + tag 16
export const BLOB_OVERHEAD = 93;
// The largest plaintext whose base64 blob fits MAX_CIPHERTEXT_CHARS: 2532 bytes.
export const MAX_PLAINTEXT_BYTES = Math.floor(MAX_CIPHERTEXT_CHARS / 4) * 3 - BLOB_OVERHEAD;
export const MAX_PAIRING_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

// ── config ────────────────────────────────────────────────────────────────

export function configFile() {
  return path.join(instanceLib().localDir(), "config", "push-relay.json");
}

/** One KEY=VALUE from a .env file, without loading the rest into process.env. */
function readEnvFileKey(file, key) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (t.startsWith(`${key}=`)) return t.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
  return "";
}

/** The relay origin ("https://push.example.com"), or throw: a path would break the signed PATH. */
export function relayOrigin(url) {
  const u = new URL(String(url));
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) {
    throw new Error(`push-relay: relay_url must be https (${u.origin})`);
  }
  if ((u.pathname && u.pathname !== "/") || u.search) throw new Error("push-relay: relay_url must be an origin only, no path");
  return u.origin;
}

/**
 * { relayUrl, instanceId, secret } when this host pushes through the relay,
 * else null. Read at call time, so a host can turn it on without a restart.
 */
export function relayConfig({ env = process.env, envFile = DEFAULT_ENV_PATH } = {}) {
  const cfg = instanceLib().localConfig("push-relay", { relay_url: "", instance_id: "" });
  const url = String(env[URL_ENV] || cfg.relay_url || "").trim();
  const instanceId = String(cfg.instance_id || "").trim();
  const secret = String(env[SECRET_ENV] || readEnvFileKey(envFile, SECRET_ENV) || "").trim();
  if (!url || !instanceId || !secret) return null;
  try {
    return { relayUrl: relayOrigin(url), instanceId, secret };
  } catch (e) {
    console.error(`[push-relay] ${e.message}; not using the relay`);
    return null;
  }
}

// ── request signing ───────────────────────────────────────────────────────

export function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** METHOD "\n" PATH "\n" TIMESTAMP "\n" hex(SHA-256(body)) */
export function canonicalString(method, pathname, timestamp, bodySha256Hex) {
  return `${String(method).toUpperCase()}\n${pathname}\n${timestamp}\n${bodySha256Hex}`;
}

/**
 * Auth headers for one request. The HMAC key is the secret's UTF-8 bytes as
 * issued (the base64url text). `who` "device" signs as a phone (X-Jori-Device).
 */
export function signRequest({ method, path: pathname, body = "", id, secret, timestamp = Date.now(), who = "instance" }) {
  const ts = String(timestamp);
  const signature = crypto
    .createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(canonicalString(method, pathname, ts, sha256Hex(Buffer.from(body))))
    .digest("hex");
  return { [who === "device" ? "X-Jori-Device" : "X-Jori-Instance"]: id, "X-Jori-Timestamp": ts, "X-Jori-Signature": signature };
}

async function relayRequest({ relayUrl, method, path: pathname, body, auth = null, fetch: f = null }) {
  if (!f && underTestRunner()) {
    throw new Error("push-relay: not sent — this is a test run (NODE_TEST_CONTEXT is set), and a test never reaches the relay");
  }
  const text = body === undefined ? "" : JSON.stringify(body);
  const headers = text ? { "content-type": "application/json" } : {};
  if (auth) Object.assign(headers, signRequest({ method, path: pathname, body: text, id: auth.instanceId, secret: auth.secret }));
  const res = await (f || globalThis.fetch)(`${relayUrl}${pathname}`, {
    method,
    headers,
    body: text || undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

function needConfig(config) {
  if (!config) throw new Error("push-relay: not set up (agent/local/config/push-relay.json + JORI_PUSH_RELAY_SECRET)");
  return config;
}

function relayError(what, r) {
  return new Error(`push-relay: ${what} failed (${r.status}${r.data?.error ? ` ${r.data.error}` : ""})`);
}

// ── host operations ───────────────────────────────────────────────────────

/**
 * Register this host with a relay: POST /v1/instances, then write
 * push-relay.json { relay_url, instance_id } and JORI_PUSH_RELAY_SECRET to
 * .env. Refuses when already registered (a second instance would orphan every
 * paired device) unless `force`.
 */
export async function registerInstance({ relayUrl, force = false, fetch: f = null, configPath = configFile(), envFile = DEFAULT_ENV_PATH } = {}) {
  const origin = relayOrigin(relayUrl);
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch {}
  if (existing.instance_id && !force) {
    throw new Error(`push-relay: already registered as ${existing.instance_id}; pass force to replace it (paired devices must pair again)`);
  }
  const r = await relayRequest({ relayUrl: origin, method: "POST", path: "/v1/instances", fetch: f });
  if (r.status !== 201 && r.status !== 200) throw relayError("register", r);
  const { instance_id, instance_secret } = r.data || {};
  if (!instance_id || !instance_secret) throw new Error("push-relay: register returned no instance");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ ...existing, relay_url: origin, instance_id }, null, 2) + "\n");
  const { setEnv } = await import("./onboarding/core.mjs");
  setEnv(envFile, SECRET_ENV, instance_secret);
  process.env[SECRET_ENV] = instance_secret;
  return { relayUrl: origin, instanceId: instance_id };
}

/**
 * Mint a one-time pairing token for the app's QR code. Only its SHA-256 goes
 * to the relay. ttlMs is capped at 15 min.
 * → { token, expiresAt }
 */
export async function createPairing({ ttlMs = 10 * 60e3, config = relayConfig(), fetch: f = null } = {}) {
  const c = needConfig(config);
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + Math.max(1000, Math.min(ttlMs, MAX_PAIRING_TTL_MS));
  const r = await relayRequest({ ...authArgs(c, f), method: "POST", path: "/v1/pairings", body: { token_hash: sha256Hex(token), expires_at: expiresAt } });
  if (r.status !== 201 && r.status !== 200) throw relayError("pairing", r);
  return { token, expiresAt: r.data?.expires_at || expiresAt };
}

function authArgs(c, f) {
  return { relayUrl: c.relayUrl, auth: c, fetch: f };
}

/** The live paired devices: [{ device_id, public_key, device_name, created_at, last_seen_at }]. */
export async function listDevices({ config = relayConfig(), fetch: f = null } = {}) {
  const c = needConfig(config);
  const r = await relayRequest({ ...authArgs(c, f), method: "GET", path: "/v1/devices" });
  if (r.status !== 200) throw relayError("list devices", r);
  return Array.isArray(r.data?.devices) ? r.data.devices : [];
}

/** Unpair one device. */
export async function deleteDevice(deviceId, { config = relayConfig(), fetch: f = null } = {}) {
  const c = needConfig(config);
  const r = await relayRequest({ ...authArgs(c, f), method: "DELETE", path: `/v1/devices/${encodeURIComponent(deviceId)}` });
  if (r.status !== 200 && r.status !== 404) throw relayError("delete device", r);
  return r.status === 200;
}

// ── encryption ────────────────────────────────────────────────────────────

/**
 * ECIES to one device (jori-push-v1; must match the app's decrypt exactly):
 *   eph   = fresh P-256 key pair
 *   z     = ECDH(eph.priv, devicePub)                 (32-byte x coordinate)
 *   key   = HKDF-SHA256(ikm=z, salt=eph.pubRaw(65), info="jori-push-v1", L=32)
 *   ct,tag= AES-256-GCM(key, nonce(12 random), plaintext, no AAD)
 *   blob  = base64( eph.pubRaw(65) ‖ nonce(12) ‖ ct ‖ tag(16) )
 * plaintext = UTF-8 JSON of the full APNs payload (a string or Buffer is used as is).
 * `ephemeralPrivateKey` and `nonce` exist only for the fixed test vector.
 */
export function encryptForDevice(publicKeyB64, payloadObject, { ephemeralPrivateKey = null, nonce = null } = {}) {
  const devicePub = Buffer.from(String(publicKeyB64), "base64");
  if (devicePub.length !== 65 || devicePub[0] !== 0x04) throw new Error("push-relay: device public key must be a 65-byte uncompressed P-256 point");
  const ecdh = crypto.createECDH("prime256v1");
  if (ephemeralPrivateKey) ecdh.setPrivateKey(Buffer.from(ephemeralPrivateKey));
  else ecdh.generateKeys();
  const ephPub = ecdh.getPublicKey(); // uncompressed, 65 bytes
  const shared = ecdh.computeSecret(devicePub);
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, ephPub, Buffer.from(HKDF_INFO, "utf8"), 32));
  const iv = nonce ? Buffer.from(nonce) : crypto.randomBytes(12);
  if (iv.length !== 12) throw new Error("push-relay: nonce must be 12 bytes");
  const plaintext = Buffer.isBuffer(payloadObject)
    ? payloadObject
    : Buffer.from(typeof payloadObject === "string" ? payloadObject : JSON.stringify(payloadObject), "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ephPub, iv, ct, cipher.getAuthTag()]).toString("base64");
}

/**
 * Shorten aps.alert.body until the payload fits MAX_PLAINTEXT_BYTES, so a long
 * ping is cut rather than dropped. Throws when it cannot fit.
 */
export function fitPayload(payload, maxBytes = MAX_PLAINTEXT_BYTES) {
  const size = (p) => Buffer.byteLength(JSON.stringify(p), "utf8");
  if (size(payload) <= maxBytes) return payload;
  const body = payload?.aps?.alert?.body;
  if (typeof body !== "string") throw new Error(`push-relay: payload is ${size(payload)} bytes, over ${maxBytes}`);
  const chars = [...body];
  const withBody = (n) => ({ ...payload, aps: { ...payload.aps, alert: { ...payload.aps.alert, body: chars.slice(0, n).join("") + "…" } } });
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(withBody(mid)) <= maxBytes) lo = mid; else hi = mid - 1;
  }
  const out = withBody(lo);
  if (size(out) > maxBytes) throw new Error(`push-relay: payload over ${maxBytes} bytes even with an empty body`);
  return out;
}

/**
 * Encrypt `payloadObject` (the full APNs payload the host would have sent
 * directly) to every paired device and push it through the relay.
 * → [{ device_id, device_name, status, ok, error? }], one per device; never
 * throws for one device's failure (a relay that cannot list devices throws).
 */
export async function pushToAll(payloadObject, { pushType = "alert", priority, collapseId, threadId, badge, config = relayConfig(), fetch: f = null } = {}) {
  const c = needConfig(config);
  const devices = await listDevices({ config: c, fetch: f });
  const payload = fitPayload(payloadObject);
  const results = [];
  for (const d of devices) {
    const body = { device_id: d.device_id, push_type: pushType };
    try {
      body.ciphertext = encryptForDevice(d.public_key, payload);
    } catch (e) {
      results.push({ device_id: d.device_id, device_name: d.device_name, status: 0, ok: false, error: e.message });
      continue;
    }
    if (priority !== undefined) body.priority = priority;
    if (collapseId) body.collapse_id = collapseId;
    if (threadId) body.thread_id = threadId;
    if (pushType === "alert" && Number.isInteger(badge)) body.badge = badge;
    try {
      const r = await relayRequest({ ...authArgs(c, f), method: "POST", path: "/v1/push", body });
      const ok = r.status === 200;
      results.push({ device_id: d.device_id, device_name: d.device_name, status: r.status, ok, ...(ok ? {} : { error: r.data?.error || `http ${r.status}` }) });
    } catch (e) {
      results.push({ device_id: d.device_id, device_name: d.device_name, status: 0, ok: false, error: e.message });
    }
  }
  return results;
}
