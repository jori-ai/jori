// push-relay/src/core.js — the relay's pure logic: request signing and
// verification, body validation, the APNs provider token and payload shape.
//
// No D1, no fetch, no Worker globals beyond WebCrypto (globalThis.crypto) and
// TextEncoder/btoa/atob, so node can import it too: tests/push-relay.test.mjs
// and lib/push-relay.mjs pin the same wire format against it.
// Protocol: docs/push-relay.md.

export const PROTOCOL_VERSION = "v1";
export const MAX_SKEW_MS = 5 * 60 * 1000;
export const MAX_PAIRING_TTL_MS = 15 * 60 * 1000;
export const MAX_ACTIVE_PAIRINGS = 10;
export const MAX_CIPHERTEXT_CHARS = 3500; // base64 characters (= bytes on the wire)
export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_DEVICES_PER_INSTANCE = 20;
export const HOUR_MS = 60 * 60 * 1000;
export const LIMITS = {
  instancesPerIpPerHour: 5,
  deviceRegistrationsPerIpPerHour: 20,
  pushesPerInstancePerHour: 600,
};
export const JWT_TTL_MS = 50 * 60 * 1000; // Apple: refresh between 20 and 60 min
// Smallest valid blob: ephemeral key (65) + nonce (12) + tag (16), empty plaintext.
export const MIN_BLOB_BYTES = 65 + 12 + 16;

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

// ── encodings ─────────────────────────────────────────────────────────────

export function toHex(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Lowercase or uppercase hex → bytes; null when not even-length hex. */
export function fromHex(hex) {
  if (typeof hex !== "string" || hex.length % 2 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToBinary(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

export function base64Encode(bytes) {
  return btoa(bytesToBinary(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
}

export function base64urlEncode(bytes) {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Standard base64 (with padding) → bytes; null when malformed. */
export function base64Decode(str) {
  if (typeof str !== "string" || str.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(str)) return null;
  try {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** A secret as issued: 32 random bytes, base64url without padding (43 chars). */
export function newSecret() {
  return base64urlEncode(randomBytes(32));
}

/** An id: a short prefix plus 16 random bytes base64url ("in_…", "dv_…"). */
export function newId(prefix) {
  return `${prefix}_${base64urlEncode(randomBytes(16))}`;
}

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ── signing ───────────────────────────────────────────────────────────────

export async function sha256Hex(data) {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return toHex(await subtle().digest("SHA-256", bytes));
}

/**
 * The string a request signature covers:
 *   METHOD "\n" PATH "\n" TIMESTAMP "\n" hex(SHA-256(body))
 * METHOD upper-case, PATH the URL path only (no host, no query), TIMESTAMP the
 * X-Jori-Timestamp header verbatim (ms since epoch), body the raw bytes sent
 * (empty for GET/DELETE without a body).
 */
export function canonicalString(method, path, timestamp, bodySha256Hex) {
  return `${String(method).toUpperCase()}\n${path}\n${timestamp}\n${bodySha256Hex}`;
}

async function hmacKey(secret, usages) {
  // The HMAC key is the secret's UTF-8 bytes exactly as issued (the base64url
  // text), not its decoded bytes.
  return subtle().importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

export async function hmacHex(secret, message) {
  const key = await hmacKey(secret, ["sign"]);
  return toHex(await subtle().sign("HMAC", key, enc.encode(message)));
}

/** Headers for a signed request. `who` is "instance" (X-Jori-Instance) or "device" (X-Jori-Device). */
export async function signRequest({ method, path, body = "", id, secret, timestamp = Date.now(), who = "instance" }) {
  const bodyBytes = typeof body === "string" ? enc.encode(body) : body;
  const ts = String(timestamp);
  const signature = await hmacHex(secret, canonicalString(method, path, ts, await sha256Hex(bodyBytes)));
  return {
    [who === "device" ? "X-Jori-Device" : "X-Jori-Instance"]: id,
    "X-Jori-Timestamp": ts,
    "X-Jori-Signature": signature,
  };
}

/**
 * Read the auth headers of a request. A request carrying X-Jori-Device is a
 * device request; otherwise X-Jori-Instance makes it a host request.
 * → { who, id, timestamp, signature } or { error }.
 */
export function readAuthHeaders(headers) {
  const get = (k) => (typeof headers.get === "function" ? headers.get(k) : headers[k] ?? headers[k.toLowerCase()]) || "";
  const device = get("X-Jori-Device");
  const instance = get("X-Jori-Instance");
  const who = device ? "device" : instance ? "instance" : "";
  const id = device || instance;
  const timestamp = get("X-Jori-Timestamp");
  const signature = get("X-Jori-Signature");
  if (!who || !timestamp || !signature) return { error: "missing_auth" };
  if (!ID_RE.test(id)) return { error: "bad_auth" };
  return { who, id, timestamp, signature };
}

/** The timestamp header must be integer ms within ±5 min of now. */
export function checkTimestamp(timestamp, now = Date.now()) {
  if (!/^\d{1,16}$/.test(String(timestamp))) return false;
  return Math.abs(now - Number(timestamp)) <= MAX_SKEW_MS;
}

/** Constant-time check of a hex signature over a request. */
export async function verifySignature({ secret, method, path, timestamp, bodyBytes, signature }) {
  const sig = fromHex(signature);
  if (!sig || sig.length !== 32) return false;
  const key = await hmacKey(secret, ["verify"]);
  const msg = canonicalString(method, path, timestamp, await sha256Hex(bodyBytes || new Uint8Array(0)));
  return subtle().verify("HMAC", key, sig, enc.encode(msg));
}

// ── validation ────────────────────────────────────────────────────────────
// Each returns { ok: true, value } or { ok: false, error, message }.

const bad = (message, error = "bad_request") => ({ ok: false, error, message });
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const APNS_TOKEN_RE = /^[0-9a-fA-F]{64,200}$/;
const ENVIRONMENTS = new Set(["production", "sandbox"]);

/** Raw uncompressed P-256 point, base64: 65 bytes, 0x04 prefix, on the curve. */
export async function validatePublicKey(b64) {
  const bytes = base64Decode(b64);
  if (!bytes || bytes.length !== 65 || bytes[0] !== 0x04) return false;
  try {
    await subtle().importKey("raw", bytes, { name: "ECDH", namedCurve: "P-256" }, true, []);
    return true;
  } catch {
    return false;
  }
}

/** POST /v1/pairings. expires_at is clamped to now + 15 min. */
export function validatePairing(body, now = Date.now()) {
  if (!isObj(body)) return bad("body must be a JSON object");
  const { token_hash, expires_at } = body;
  if (typeof token_hash !== "string" || !/^[0-9a-f]{64}$/.test(token_hash)) return bad("token_hash must be 64 lowercase hex chars");
  if (!Number.isSafeInteger(expires_at)) return bad("expires_at must be integer ms");
  if (expires_at <= now) return bad("expires_at is in the past");
  return { ok: true, value: { token_hash, expires_at: Math.min(expires_at, now + MAX_PAIRING_TTL_MS) } };
}

function cleanName(name) {
  // Control characters out, whitespace collapsed; it is shown back to the host.
  return String(name).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

/** POST /v1/devices. */
export async function validateDeviceRegistration(body) {
  if (!isObj(body)) return bad("body must be a JSON object");
  const { instance_id, pairing_token, apns_token, environment, device_name, public_key } = body;
  if (typeof instance_id !== "string" || !ID_RE.test(instance_id)) return bad("instance_id is invalid");
  if (typeof pairing_token !== "string" || pairing_token.length < 16 || pairing_token.length > 128) return bad("pairing_token is invalid");
  if (typeof apns_token !== "string" || !APNS_TOKEN_RE.test(apns_token)) return bad("apns_token must be hex");
  if (!ENVIRONMENTS.has(environment)) return bad('environment must be "production" or "sandbox"');
  if (typeof device_name !== "string" || !cleanName(device_name)) return bad("device_name is required");
  if (typeof public_key !== "string" || !(await validatePublicKey(public_key))) return bad("public_key must be base64 of a 65-byte uncompressed P-256 point");
  return {
    ok: true,
    value: { instance_id, pairing_token, apns_token: apns_token.toLowerCase(), environment, device_name: cleanName(device_name), public_key },
  };
}

/** PUT /v1/devices/:id — at least one of apns_token, environment. */
export function validateDeviceUpdate(body) {
  if (!isObj(body)) return bad("body must be a JSON object");
  const out = {};
  if (body.apns_token !== undefined) {
    if (typeof body.apns_token !== "string" || !APNS_TOKEN_RE.test(body.apns_token)) return bad("apns_token must be hex");
    out.apns_token = body.apns_token.toLowerCase();
  }
  if (body.environment !== undefined) {
    if (!ENVIRONMENTS.has(body.environment)) return bad('environment must be "production" or "sandbox"');
    out.environment = body.environment;
  }
  if (!Object.keys(out).length) return bad("nothing to update");
  return { ok: true, value: out };
}

/** POST /v1/push. */
export function validatePush(body) {
  if (!isObj(body)) return bad("body must be a JSON object");
  const { device_id, ciphertext, push_type, priority, collapse_id, thread_id, badge } = body;
  if (typeof device_id !== "string" || !ID_RE.test(device_id)) return bad("device_id is invalid");
  if (typeof ciphertext !== "string") return bad("ciphertext must be a base64 string");
  if (ciphertext.length > MAX_CIPHERTEXT_CHARS) return bad(`ciphertext over ${MAX_CIPHERTEXT_CHARS} chars`, "payload_too_large");
  const blob = base64Decode(ciphertext);
  if (!blob || blob.length < MIN_BLOB_BYTES || blob[0] !== 0x04) return bad("ciphertext is not a jori-push-v1 blob");
  if (push_type !== "alert" && push_type !== "background") return bad('push_type must be "alert" or "background"');
  let prio = priority ?? (push_type === "background" ? 5 : 10);
  if (prio !== 10 && prio !== 5) return bad("priority must be 10 or 5");
  if (push_type === "background" && prio !== 5) return bad("a background push must have priority 5");
  const value = { device_id, ciphertext, push_type, priority: prio };
  if (collapse_id !== undefined) {
    if (typeof collapse_id !== "string" || !collapse_id || enc.encode(collapse_id).length > 64) return bad("collapse_id must be 1–64 bytes");
    value.collapse_id = collapse_id;
  }
  if (thread_id !== undefined) {
    if (typeof thread_id !== "string" || !thread_id || thread_id.length > 64) return bad("thread_id must be 1–64 chars");
    value.thread_id = thread_id;
  }
  if (badge !== undefined) {
    if (!Number.isSafeInteger(badge) || badge < 0 || badge > 99999) return bad("badge must be a non-negative integer");
    value.badge = badge;
  }
  return { ok: true, value };
}

// ── APNs ──────────────────────────────────────────────────────────────────

export function apnsHost(environment) {
  return environment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
}

/** The JSON APNs gets. The relay never sees what the notification says. */
export function buildApnsPayload({ push_type, ciphertext, thread_id, badge }) {
  if (push_type === "background") return { aps: { "content-available": 1 }, enc: ciphertext };
  const aps = { alert: { title: "Jori", body: "New message" }, "mutable-content": 1, sound: "default" };
  if (thread_id !== undefined) aps["thread-id"] = thread_id;
  if (badge !== undefined) aps.badge = badge;
  return { aps, enc: ciphertext };
}

export function apnsHeaders({ push_type, priority, collapse_id, topic, jwt }) {
  const h = {
    authorization: `bearer ${jwt}`,
    "apns-topic": topic,
    "apns-push-type": push_type,
    "apns-priority": String(priority),
    "content-type": "application/json",
  };
  if (collapse_id) h["apns-collapse-id"] = collapse_id;
  return h;
}

/** APNs said this token will never work again: retire the device. */
export function isDeadToken(status, reason) {
  return status === 410 || reason === "BadDeviceToken" || reason === "Unregistered";
}

/** APNs rejected our provider token: re-sign and retry once. */
export function isProviderTokenError(status, reason) {
  return status === 403 && (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken");
}

export function pemToDer(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = base64Decode(b64);
  if (!der) throw new Error("APNS_KEY_P8 is not a PEM key");
  return der;
}

/** ES256 provider JWT. WebCrypto ECDSA already returns raw r‖s, which JWS wants. */
export async function signApnsJwt({ keyP8, keyId, teamId, nowSec = Math.floor(Date.now() / 1000) }) {
  const key = await subtle().importKey("pkcs8", pemToDer(keyP8), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = base64urlEncode(enc.encode(JSON.stringify({ alg: "ES256", kid: keyId })));
  const claims = base64urlEncode(enc.encode(JSON.stringify({ iss: teamId, iat: nowSec })));
  const input = `${header}.${claims}`;
  const sig = await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(input));
  return `${input}.${base64urlEncode(sig)}`;
}

/** A provider-token cache: one JWT reused for ~50 min (Apple throttles re-signing). */
export function createJwtCache(sign = signApnsJwt) {
  let cached = null;
  return {
    async get(env, now = Date.now()) {
      if (cached && now - cached.at < JWT_TTL_MS) return cached.jwt;
      const jwt = await sign({ keyP8: env.APNS_KEY_P8, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, nowSec: Math.floor(now / 1000) });
      cached = { jwt, at: now };
      return jwt;
    },
    reset() { cached = null; },
  };
}

export function windowStart(now, windowMs = HOUR_MS) {
  return Math.floor(now / windowMs) * windowMs;
}
