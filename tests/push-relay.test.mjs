// push-relay.test.mjs — the push relay's wire format (docs/push-relay.md).
//
// Pins: the jori-push-v1 encryption (fixed test vector the app's Swift side
// tests against too, decrypted here the way CryptoKit would: ECDH → HKDF →
// AES-GCM), the request signature, the worker's validation and APNs payload
// (push-relay/src/core.js), the host client (lib/push-relay.mjs) and the relay
// route in lib/apns-push.mjs. Nothing here reaches a network.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as relay from "../lib/push-relay.mjs";
import * as core from "../push-relay/src/core.js";
import { sendApnsPush, sendSilentPush, sendPurchaseApprovalPush, sendClearPush, recordPushRecipients, pushRecipients, RELAY_CLASS } from "../lib/apns-push.mjs";

// ── the fixed test vector (docs/push-relay.md § Test vector) ───────────────
const V = {
  devicePrivateKey: "eb0d6b0bf7f9b0ccab93db17a79d3086924558805faba532046598df906a8cb2",
  devicePublicKeyB64: "BJYzW4B8Yfyw9IHFUdTavWneL7FVw2iMf36E/rZ4nr6g6qqScDVJf/UjuwmQcyjhym1WD7U4ln1YOMGIGvTmbUY=",
  ephemeralPrivateKey: "eb0fbfc69ad54040e850d4540543bbb2e164ffc918317022172a2afe56561596",
  ephemeralPublicKey: "04d841c11c4b4b550fa4a84f8aa42b90e06b28b23c422b2676ce1d84188c0d6de8d4730806fab8e671e6114345488ffc6d0cde64e7b80807e5b2896f912fca9745",
  nonce: "000102030405060708090a0b",
  sharedSecret: "66081ea6fd9afd60423eb6770910267685ccebd43de567c41ffbd8570eeed3c6",
  aesKey: "4de50aa9373518f43074567b90755f8e636cd4a3fe977005c57066410f49f167",
  plaintext: '{"aps":{"alert":{"title":"Jori","body":"Test vector"},"mutable-content":1},"message_id":"00000000-0000-0000-0000-000000000001"}',
  blob: "BNhBwRxLS1UPpKhPiqQrkOBrKLI8Qismds4dhBiMDW3o1HMIBvq45nHmEUNFSI/8bQzeZOe4CAflsolvkS/Kl0UAAQIDBAUGBwgJCguvGQ/EsE9TBjcnluiksrkgrh4TRQskSexT7Bv2Ce95aZ2jSbKCnas/xFz9a1dfCwiWgAJTrx5KbE+I4gXBFwFNgznnWoRhI1ZuMcYK6vf0dG19js0p58gAL4UxMfYVruQpNEIkE0FvbhBV9EPs1t7udVtiZaAyB7UQFddnNaKyOKj2UHIHMSDwk5ZqApG4sQ==",
};

const HKDF_INFO = Buffer.from("jori-push-v1", "utf8");

/**
 * The device side, step by step as the app's notification service extension
 * does it with CryptoKit:
 *   eph   = P256.KeyAgreement.PublicKey(x963Representation: blob[0..<65])
 *   z     = devicePriv.sharedSecretFromKeyAgreement(with: eph)
 *   key   = z.hkdfDerivedSymmetricKey(using: SHA256.self, salt: blob[0..<65],
 *                                     sharedInfo: "jori-push-v1", outputByteCount: 32)
 *   plain = AES.GCM.open(AES.GCM.SealedBox(combined: blob[65...]), using: key)
 */
function deviceDecrypt(devicePrivHex, blobB64) {
  const blob = Buffer.from(blobB64, "base64");
  const ephPub = blob.subarray(0, 65);
  const sealed = blob.subarray(65); // nonce(12) ‖ ciphertext ‖ tag(16) = CryptoKit's "combined"
  const nonce = sealed.subarray(0, 12);
  const tag = sealed.subarray(sealed.length - 16);
  const ct = sealed.subarray(12, sealed.length - 16);
  const dev = crypto.createECDH("prime256v1");
  dev.setPrivateKey(Buffer.from(devicePrivHex, "hex"));
  const z = dev.computeSecret(ephPub);
  const key = Buffer.from(crypto.hkdfSync("sha256", z, ephPub, HKDF_INFO, 32));
  const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(tag);
  return { z, key, plaintext: Buffer.concat([d.update(ct), d.final()]).toString("utf8") };
}

/** The same decrypt through WebCrypto, an implementation independent of node's ECDH/Cipher. */
async function webcryptoDecrypt(devicePrivHex, devicePubB64, blobB64) {
  const s = globalThis.crypto.subtle;
  const pub = Buffer.from(devicePubB64, "base64");
  const jwk = {
    kty: "EC", crv: "P-256",
    d: Buffer.from(devicePrivHex, "hex").toString("base64url"),
    x: pub.subarray(1, 33).toString("base64url"),
    y: pub.subarray(33, 65).toString("base64url"),
  };
  const priv = await s.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const blob = Buffer.from(blobB64, "base64");
  const ephPub = blob.subarray(0, 65);
  const eph = await s.importKey("raw", ephPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const z = await s.deriveBits({ name: "ECDH", public: eph }, priv, 256);
  const hk = await s.importKey("raw", z, "HKDF", false, ["deriveKey"]);
  const key = await s.deriveKey({ name: "HKDF", hash: "SHA-256", salt: ephPub, info: HKDF_INFO }, hk, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = await s.decrypt({ name: "AES-GCM", iv: blob.subarray(65, 77) }, key, blob.subarray(77));
  return Buffer.from(pt).toString("utf8");
}

function newDevice() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { privHex: ecdh.getPrivateKey("hex").padStart(64, "0"), pubB64: ecdh.getPublicKey().toString("base64") };
}

// ── encryption ────────────────────────────────────────────────────────────

test("vector: encryptForDevice with the fixed ephemeral key and nonce gives the published blob", () => {
  const blob = relay.encryptForDevice(V.devicePublicKeyB64, V.plaintext, {
    ephemeralPrivateKey: Buffer.from(V.ephemeralPrivateKey, "hex"),
    nonce: Buffer.from(V.nonce, "hex"),
  });
  assert.equal(blob, V.blob);
  const raw = Buffer.from(blob, "base64");
  assert.equal(raw.subarray(0, 65).toString("hex"), V.ephemeralPublicKey);
  assert.equal(raw.subarray(65, 77).toString("hex"), V.nonce);
  assert.equal(raw.length, 65 + 12 + Buffer.byteLength(V.plaintext) + 16);
});

test("vector: the device public key is the device private key's point", () => {
  const dev = crypto.createECDH("prime256v1");
  dev.setPrivateKey(Buffer.from(V.devicePrivateKey, "hex"));
  assert.equal(dev.getPublicKey().toString("base64"), V.devicePublicKeyB64);
});

test("vector: the device decrypts it (ECDH → HKDF → AES-GCM), intermediates match", () => {
  const r = deviceDecrypt(V.devicePrivateKey, V.blob);
  assert.equal(r.z.toString("hex"), V.sharedSecret);
  assert.equal(r.key.toString("hex"), V.aesKey);
  assert.equal(r.plaintext, V.plaintext);
});

test("vector: WebCrypto decrypts it too", async () => {
  assert.equal(await webcryptoDecrypt(V.devicePrivateKey, V.devicePublicKeyB64, V.blob), V.plaintext);
});

test("a fresh encryption round-trips, and two encryptions of one payload differ", async () => {
  const dev = newDevice();
  const payload = { aps: { alert: { title: "Jori", body: "Dinner at 8 — table for two" }, badge: 3 }, message_id: "m-1" };
  const a = relay.encryptForDevice(dev.pubB64, payload);
  const b = relay.encryptForDevice(dev.pubB64, payload);
  assert.notEqual(a, b);
  assert.deepEqual(JSON.parse(deviceDecrypt(dev.privHex, a).plaintext), payload);
  assert.deepEqual(JSON.parse(await webcryptoDecrypt(dev.privHex, dev.pubB64, b)), payload);
});

test("a tampered blob fails authentication", () => {
  const raw = Buffer.from(V.blob, "base64");
  raw[80] ^= 1;
  assert.throws(() => deviceDecrypt(V.devicePrivateKey, raw.toString("base64")));
});

test("encryptForDevice rejects a key that is not a 65-byte uncompressed point", () => {
  assert.throws(() => relay.encryptForDevice(Buffer.alloc(33, 2).toString("base64"), {}), /65-byte/);
});

test("fitPayload shortens a long body so the blob stays within 3500 chars", () => {
  const dev = newDevice();
  const long = { aps: { alert: { title: "Jori", body: "é".repeat(4000) } }, message_id: "m" };
  const fitted = relay.fitPayload(long);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= relay.MAX_PLAINTEXT_BYTES);
  assert.ok(fitted.aps.alert.body.endsWith("…"));
  assert.equal(fitted.message_id, "m");
  assert.ok(relay.encryptForDevice(dev.pubB64, fitted).length <= core.MAX_CIPHERTEXT_CHARS);
  const exact = Buffer.alloc(relay.MAX_PLAINTEXT_BYTES, "a");
  assert.equal(relay.encryptForDevice(dev.pubB64, exact).length, core.MAX_CIPHERTEXT_CHARS);
  const small = { aps: { alert: { body: "hi" } } };
  assert.equal(relay.fitPayload(small), small);
  assert.throws(() => relay.fitPayload({ aps: {}, junk: "x".repeat(5000) }), /over/);
});

// ── request signatures ────────────────────────────────────────────────────

const SIG_VECTOR = {
  host: {
    args: { method: "POST", path: "/v1/push", body: '{"device_id":"dv_test"}', id: "in_test", secret: "c2VjcmV0LWZvci10ZXN0cy1vbmx5LTAxMjM0NTY3ODk", timestamp: 1767225600000 },
    bodySha256: "95a6a4e68a01aa27d527588dd7771b5c96321f5cdd47570a122e133f7412bcdf",
    signature: "d5abcb96044b4f9bea0f36c47068f5f2b32d248bc33457374a076646ec103981",
  },
  device: {
    args: { method: "PUT", path: "/v1/devices/dv_test", body: `{"apns_token":"${"ab".repeat(32)}"}`, id: "dv_test", secret: "ZGV2aWNlLXNlY3JldC1mb3ItdGVzdHMtMDEyMzQ1Njc", timestamp: 1767225600000, who: "device" },
    signature: "eb4b1e705a185dfb933a6e44d40ce4cbfdd7242c4182971a464b9da8c575fcd0",
  },
};

test("signature vector: canonical string and HMAC (host and device)", async () => {
  const h = SIG_VECTOR.host;
  assert.equal(relay.sha256Hex(h.args.body), h.bodySha256);
  assert.equal(relay.canonicalString("post", "/v1/push", "1767225600000", h.bodySha256), `POST\n/v1/push\n1767225600000\n${h.bodySha256}`);
  assert.deepEqual(relay.signRequest(h.args), { "X-Jori-Instance": "in_test", "X-Jori-Timestamp": "1767225600000", "X-Jori-Signature": h.signature });
  const d = SIG_VECTOR.device;
  assert.deepEqual(relay.signRequest(d.args), { "X-Jori-Device": "dv_test", "X-Jori-Timestamp": "1767225600000", "X-Jori-Signature": d.signature });
  // The worker's WebCrypto signer agrees byte for byte.
  assert.deepEqual(await core.signRequest(h.args), relay.signRequest(h.args));
  assert.deepEqual(await core.signRequest(d.args), relay.signRequest(d.args));
  assert.equal(relay.sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("the worker verifies a host signature and rejects any change", async () => {
  const a = SIG_VECTOR.host.args;
  const base = { secret: a.secret, method: a.method, path: a.path, timestamp: String(a.timestamp), bodyBytes: Buffer.from(a.body), signature: SIG_VECTOR.host.signature };
  assert.equal(await core.verifySignature(base), true);
  assert.equal(await core.verifySignature({ ...base, bodyBytes: Buffer.from(a.body + " ") }), false);
  assert.equal(await core.verifySignature({ ...base, path: "/v1/pushx" }), false);
  assert.equal(await core.verifySignature({ ...base, method: "PUT" }), false);
  assert.equal(await core.verifySignature({ ...base, timestamp: "1767225600001" }), false);
  assert.equal(await core.verifySignature({ ...base, secret: a.secret + "x" }), false);
  assert.equal(await core.verifySignature({ ...base, signature: "zz" }), false);
});

test("timestamps: within ±5 min only", () => {
  const now = 1_767_225_600_000;
  assert.equal(core.checkTimestamp(String(now - 5 * 60e3), now), true);
  assert.equal(core.checkTimestamp(String(now + 5 * 60e3), now), true);
  assert.equal(core.checkTimestamp(String(now - 5 * 60e3 - 1), now), false);
  assert.equal(core.checkTimestamp(String(now + 5 * 60e3 + 1), now), false);
  assert.equal(core.checkTimestamp("12.5", now), false);
  assert.equal(core.checkTimestamp("", now), false);
});

test("auth headers: X-Jori-Device makes a device request, else X-Jori-Instance", () => {
  const H = (o) => new Headers(o);
  assert.equal(core.readAuthHeaders(H({ "X-Jori-Device": "dv_a", "X-Jori-Timestamp": "1", "X-Jori-Signature": "ab" })).who, "device");
  assert.equal(core.readAuthHeaders(H({ "X-Jori-Instance": "in_a", "X-Jori-Timestamp": "1", "X-Jori-Signature": "ab" })).who, "instance");
  assert.equal(core.readAuthHeaders(H({ "X-Jori-Instance": "in_a" })).error, "missing_auth");
  assert.equal(core.readAuthHeaders(H({ "X-Jori-Instance": "in a/..", "X-Jori-Timestamp": "1", "X-Jori-Signature": "ab" })).error, "bad_auth");
});

// ── worker validation and APNs shape ──────────────────────────────────────

test("pairings: hash format, past expiry rejected, TTL clamped to 15 min", () => {
  const now = 1_000_000_000;
  const hash = "a".repeat(64);
  assert.equal(core.validatePairing({ token_hash: hash, expires_at: now + 60e3 }, now).value.expires_at, now + 60e3);
  assert.equal(core.validatePairing({ token_hash: hash, expires_at: now + 3600e3 }, now).value.expires_at, now + 15 * 60e3);
  assert.equal(core.validatePairing({ token_hash: hash, expires_at: now - 1 }, now).ok, false);
  assert.equal(core.validatePairing({ token_hash: "A".repeat(64), expires_at: now + 1 }, now).ok, false);
  assert.equal(core.validatePairing(null, now).ok, false);
});

test("device registration: needs a real P-256 point, hex token, known environment", async () => {
  const good = {
    instance_id: "in_abc", pairing_token: "x".repeat(32), apns_token: "AB".repeat(32),
    environment: "sandbox", device_name: "  Test\nPhone ", public_key: V.devicePublicKeyB64,
  };
  const r = await core.validateDeviceRegistration(good);
  assert.equal(r.ok, true);
  assert.equal(r.value.apns_token, "ab".repeat(32));
  assert.equal(r.value.device_name, "Test Phone");
  const offCurve = Buffer.from(V.devicePublicKeyB64, "base64");
  offCurve[64] ^= 1;
  assert.equal((await core.validateDeviceRegistration({ ...good, public_key: offCurve.toString("base64") })).ok, false);
  assert.equal((await core.validateDeviceRegistration({ ...good, environment: "dev" })).ok, false);
  assert.equal((await core.validateDeviceRegistration({ ...good, apns_token: "xyz" })).ok, false);
  assert.equal((await core.validateDeviceRegistration({ ...good, device_name: "\n" })).ok, false);
});

test("device update: one of apns_token / environment", () => {
  assert.deepEqual(core.validateDeviceUpdate({ environment: "production" }).value, { environment: "production" });
  assert.equal(core.validateDeviceUpdate({}).ok, false);
  assert.equal(core.validateDeviceUpdate({ apns_token: "zz" }).ok, false);
});

test("push validation: size cap, blob shape, priorities", () => {
  const ct = V.blob;
  const ok = core.validatePush({ device_id: "dv_a", ciphertext: ct, push_type: "alert" });
  assert.equal(ok.value.priority, 10);
  assert.equal(core.validatePush({ device_id: "dv_a", ciphertext: ct, push_type: "background" }).value.priority, 5);
  assert.equal(core.validatePush({ device_id: "dv_a", ciphertext: ct, push_type: "background", priority: 10 }).ok, false);
  assert.equal(core.validatePush({ device_id: "dv_a", ciphertext: ct, push_type: "alert", priority: 7 }).ok, false);
  assert.equal(core.validatePush({ device_id: "dv_a", ciphertext: "A".repeat(3504), push_type: "alert" }).error, "payload_too_large");
  assert.equal(core.validatePush({ device_id: "dv_a", ciphertext: "not base64!", push_type: "alert" }).ok, false);
  assert.equal(core.validatePush({ device_id: "dv_a", ciphertext: Buffer.alloc(40).toString("base64"), push_type: "alert" }).ok, false);
  assert.equal(core.validatePush({ device_id: "dv_a", ciphertext: ct, push_type: "alert", collapse_id: "x".repeat(65) }).ok, false);
  assert.equal(core.validatePush({ device_id: "dv_a", ciphertext: ct, push_type: "alert", badge: -1 }).ok, false);
  assert.equal(core.validatePush({ device_id: "dv_a", ciphertext: ct, push_type: "loud" }).ok, false);
});

test("APNs payloads: the relay's outer shape, never the content", () => {
  assert.deepEqual(core.buildApnsPayload({ push_type: "alert", ciphertext: "CT" }), {
    aps: { alert: { title: "Jori", body: "New message" }, "mutable-content": 1, sound: "default" }, enc: "CT",
  });
  assert.deepEqual(core.buildApnsPayload({ push_type: "alert", ciphertext: "CT", thread_id: "t", badge: 0 }), {
    aps: { alert: { title: "Jori", body: "New message" }, "mutable-content": 1, sound: "default", "thread-id": "t", badge: 0 }, enc: "CT",
  });
  assert.deepEqual(core.buildApnsPayload({ push_type: "background", ciphertext: "CT", badge: 4 }), { aps: { "content-available": 1 }, enc: "CT" });
  const h = core.apnsHeaders({ push_type: "background", priority: 5, topic: "app.example", jwt: "J", collapse_id: "c" });
  assert.equal(h["apns-push-type"], "background");
  assert.equal(h["apns-priority"], "5");
  assert.equal(h["apns-collapse-id"], "c");
  assert.equal(h.authorization, "bearer J");
  assert.equal(core.apnsHost("sandbox"), "api.sandbox.push.apple.com");
  assert.equal(core.apnsHost("production"), "api.push.apple.com");
  assert.equal(core.isDeadToken(410, ""), true);
  assert.equal(core.isDeadToken(400, "BadDeviceToken"), true);
  assert.equal(core.isDeadToken(400, "BadTopic"), false);
});

test("the provider JWT is ES256 over {alg,kid}.{iss,iat} and is cached ~50 min", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyP8 = privateKey.export({ type: "pkcs8", format: "pem" });
  const jwt = await core.signApnsJwt({ keyP8, keyId: "KEY123", teamId: "TEAM456", nowSec: 1767225600 });
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "ES256", kid: "KEY123" });
  assert.deepEqual(JSON.parse(Buffer.from(c, "base64url")), { iss: "TEAM456", iat: 1767225600 });
  assert.equal(Buffer.from(s, "base64url").length, 64);
  assert.equal(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")), true);

  let signs = 0;
  const cache = core.createJwtCache(async () => `jwt${++signs}`);
  const env = { APNS_KEY_P8: keyP8, APNS_KEY_ID: "K", APNS_TEAM_ID: "T" };
  assert.equal(await cache.get(env, 0), "jwt1");
  assert.equal(await cache.get(env, 49 * 60e3), "jwt1");
  assert.equal(await cache.get(env, 50 * 60e3), "jwt2");
  cache.reset();
  assert.equal(await cache.get(env, 50 * 60e3), "jwt3");
});

// ── host client ───────────────────────────────────────────────────────────

/**
 * A fake relay: verifies each request's signature with the worker's own code
 * and answers like the worker. Devices hold real key pairs so pushes can be
 * decrypted.
 */
function fakeRelay({ instanceId = "in_test", secret = "s3cret-s3cret-s3cret-s3cret", devices = [], pushStatus = () => 200 } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const body = init.body || "";
    const headers = new Headers(init.headers || {});
    const call = { method, path: u.pathname, body: body ? JSON.parse(body) : null, headers };
    calls.push(call);
    const reply = (status, data) => ({ status, json: async () => data });
    if (u.pathname === "/v1/instances") return reply(201, { instance_id: instanceId, instance_secret: secret });
    const h = core.readAuthHeaders(headers);
    const good = !h.error && h.id === instanceId && (await core.verifySignature({
      secret, method, path: u.pathname, timestamp: h.timestamp, bodyBytes: Buffer.from(body), signature: h.signature,
    })) && core.checkTimestamp(h.timestamp);
    call.verified = Boolean(good);
    if (!good) return reply(401, { error: "unauthorized" });
    if (u.pathname === "/v1/devices" && method === "GET") {
      return reply(200, { devices: devices.map((d) => ({ device_id: d.id, public_key: d.pubB64, device_name: d.name, created_at: 1, last_seen_at: 2 })) });
    }
    if (u.pathname === "/v1/pairings") return reply(201, { expires_at: call.body.expires_at });
    if (u.pathname === "/v1/push") {
      const v = core.validatePush(call.body);
      if (!v.ok) return reply(400, { error: v.error });
      const st = pushStatus(call.body.device_id);
      return reply(st, st === 200 ? { ok: true } : { error: st === 410 ? "device_gone" : "apns_error" });
    }
    return reply(404, { error: "not_found" });
  };
  return { fetch, calls, config: { relayUrl: "https://relay.test", instanceId, secret } };
}

test("pushToAll encrypts the payload to each device and signs every request", async () => {
  const phone = { id: "dv_phone", name: "Phone", ...newDevice() };
  const mac = { id: "dv_mac", name: "Mac", ...newDevice() };
  const r = fakeRelay({ devices: [phone, mac], pushStatus: (id) => (id === "dv_mac" ? 410 : 200) });
  const payload = { aps: { alert: { title: "Jori", body: "Your table is ready" }, "interruption-level": "time-sensitive" }, message_id: "m-9" };
  const results = await relay.pushToAll(payload, { badge: 2, config: r.config, fetch: r.fetch });
  assert.deepEqual(results.map((x) => [x.device_id, x.status, x.ok]), [["dv_phone", 200, true], ["dv_mac", 410, false]]);
  assert.ok(r.calls.every((c) => c.verified));
  const pushes = r.calls.filter((c) => c.path === "/v1/push");
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0].body.push_type, "alert");
  assert.equal(pushes[0].body.badge, 2);
  assert.deepEqual(JSON.parse(deviceDecrypt(phone.privHex, pushes[0].body.ciphertext).plaintext), payload);
  assert.deepEqual(JSON.parse(deviceDecrypt(mac.privHex, pushes[1].body.ciphertext).plaintext), payload);
  // The plaintext never travels: nothing of the body is in the request.
  assert.ok(!JSON.stringify(pushes[0].body).includes("table is ready"));
});

test("a test run never reaches a relay without its own fetch", async () => {
  const cfg = { relayUrl: "https://relay.test", instanceId: "in_x", secret: "s" };
  await assert.rejects(relay.listDevices({ config: cfg }), /test run/);
  await assert.rejects(relay.pushToAll({ aps: {} }, { config: cfg }), /test run/);
  await assert.rejects(relay.registerInstance({ relayUrl: "https://relay.test", configPath: path.join(os.tmpdir(), "nope", "x.json") }), /test run/);
});

function tempLocal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-relay-"));
  return { dir, configPath: path.join(dir, "config", "push-relay.json"), envFile: path.join(dir, ".env") };
}

test("registerInstance writes the config and the secret, and refuses a second time", async () => {
  const t = tempLocal();
  fs.writeFileSync(t.envFile, "OTHER=1\n");
  const r = fakeRelay({ instanceId: "in_new", secret: "the-secret" });
  const before = process.env.JORI_PUSH_RELAY_SECRET;
  try {
    const out = await relay.registerInstance({ relayUrl: "https://relay.test/", fetch: r.fetch, configPath: t.configPath, envFile: t.envFile });
    assert.deepEqual(out, { relayUrl: "https://relay.test", instanceId: "in_new" });
    assert.deepEqual(JSON.parse(fs.readFileSync(t.configPath, "utf8")), { relay_url: "https://relay.test", instance_id: "in_new" });
    assert.equal(fs.readFileSync(t.envFile, "utf8"), "OTHER=1\nJORI_PUSH_RELAY_SECRET=the-secret\n");
    assert.equal(process.env.JORI_PUSH_RELAY_SECRET, "the-secret");
    await assert.rejects(relay.registerInstance({ relayUrl: "https://relay.test", fetch: r.fetch, configPath: t.configPath, envFile: t.envFile }), /already registered/);
    await assert.rejects(relay.registerInstance({ relayUrl: "https://relay.test/v1", fetch: r.fetch, configPath: t.configPath + "2", envFile: t.envFile }), /origin only/);
  } finally {
    if (before === undefined) delete process.env.JORI_PUSH_RELAY_SECRET; else process.env.JORI_PUSH_RELAY_SECRET = before;
  }
});

test("relayConfig: null until url, instance id and secret all exist; env URL wins", () => {
  const t = tempLocal();
  const prev = process.env.JORI_LOCAL_DIR;
  process.env.JORI_LOCAL_DIR = t.dir;
  try {
    assert.equal(relay.relayConfig({ env: {}, envFile: t.envFile }), null);
    fs.mkdirSync(path.dirname(t.configPath), { recursive: true });
    fs.writeFileSync(t.configPath, JSON.stringify({ relay_url: "https://relay.test", instance_id: "in_1" }));
    assert.equal(relay.relayConfig({ env: {}, envFile: t.envFile }), null);
    fs.writeFileSync(t.envFile, "JORI_PUSH_RELAY_SECRET=from-file\n");
    assert.deepEqual(relay.relayConfig({ env: {}, envFile: t.envFile }), { relayUrl: "https://relay.test", instanceId: "in_1", secret: "from-file" });
    assert.deepEqual(relay.relayConfig({ env: { JORI_PUSH_RELAY_URL: "https://other.test", JORI_PUSH_RELAY_SECRET: "env" }, envFile: t.envFile }),
      { relayUrl: "https://other.test", instanceId: "in_1", secret: "env" });
    assert.equal(relay.relayConfig({ env: { JORI_PUSH_RELAY_URL: "https://other.test/path" }, envFile: t.envFile }), null);
  } finally {
    if (prev === undefined) delete process.env.JORI_LOCAL_DIR; else process.env.JORI_LOCAL_DIR = prev;
  }
});

test("createPairing posts only the token's hash and caps the TTL at 15 min", async () => {
  const r = fakeRelay();
  const t0 = Date.now();
  const p = await relay.createPairing({ ttlMs: 60 * 60e3, config: r.config, fetch: r.fetch });
  assert.equal(Buffer.from(p.token, "base64url").length, 24);
  const call = r.calls.find((c) => c.path === "/v1/pairings");
  assert.equal(call.body.token_hash, relay.sha256Hex(p.token));
  assert.ok(!JSON.stringify(call.body).includes(p.token));
  assert.ok(p.expiresAt <= Date.now() + 15 * 60e3 && p.expiresAt >= t0 + 15 * 60e3 - 1000);
});

test("listDevices returns the relay's devices", async () => {
  const d = { id: "dv_1", name: "Phone", ...newDevice() };
  const r = fakeRelay({ devices: [d] });
  assert.deepEqual(await relay.listDevices({ config: r.config, fetch: r.fetch }), [
    { device_id: "dv_1", public_key: d.pubB64, device_name: "Phone", created_at: 1, last_seen_at: 2 },
  ]);
});

// ── lib/apns-push.mjs through the relay ───────────────────────────────────

const noTokens = () => {
  const seen = { tokens: 0 };
  return { seen, from: (t) => { if (t === "device_tokens") seen.tokens++; return { select: async () => ({ data: [], error: null }) }; } };
};

test("sendApnsPush via the relay: no device_tokens read, full payload encrypted, badge outside", async () => {
  const phone = { id: "dv_phone", name: "Phone", ...newDevice() };
  const r = fakeRelay({ devices: [phone] });
  const supa = noTokens();
  const out = await sendApnsPush(supa, { body: "Leave in 10", title: "Jori", channel: "system", skipMotionGate: true, relay: { config: r.config, fetch: r.fetch } });
  assert.deepEqual(out, { delivered: true });
  assert.equal(supa.seen.tokens, 0);
  const push = r.calls.find((c) => c.path === "/v1/push");
  assert.equal(push.body.push_type, "alert");
  assert.equal(push.body.badge, undefined, "system channel leaves the badge alone");
  const inner = JSON.parse(deviceDecrypt(phone.privHex, push.body.ciphertext).plaintext);
  assert.equal(inner.aps.alert.body, "Leave in 10");
  assert.equal(inner.aps.alert.title, "Jori");
});

test("sendApnsPush via the relay with no devices reports it, and a down relay does not throw", async () => {
  const r = fakeRelay({ devices: [] });
  assert.deepEqual(await sendApnsPush(noTokens(), { body: "x", title: "Jori", channel: "system", skipMotionGate: true, relay: { config: r.config, fetch: r.fetch } }),
    { delivered: false, reason: "no relay devices" });
  const down = async () => { throw new Error("connect ECONNREFUSED"); };
  const res = await sendApnsPush(noTokens(), { body: "x", title: "Jori", channel: "system", skipMotionGate: true, relay: { config: r.config, fetch: down } });
  assert.equal(res.delivered, false);
  assert.match(res.reason, /relay: .*ECONNREFUSED/);
});

test("sendSilentPush via the relay is a priority-5 background push to every device", async () => {
  const a = { id: "dv_aaaaaaaa1", name: "Phone", ...newDevice() };
  const b = { id: "dv_bbbbbbbb2", name: "Mac", ...newDevice() };
  const r = fakeRelay({ devices: [a, b] });
  const out = await sendSilentPush(noTokens(), { kind: "sync_probe", probe_id: "p1" }, { relay: { config: r.config, fetch: r.fetch } });
  assert.equal(out.delivered, true);
  assert.equal(out.sent, 2);
  assert.deepEqual(out.results, [{ token: "dv_aaaaa", status: 200 }, { token: "dv_bbbbb", status: 200 }]);
  const pushes = r.calls.filter((c) => c.path === "/v1/push");
  assert.ok(pushes.every((p) => p.body.push_type === "background" && p.body.priority === 5 && p.body.badge === undefined));
  assert.deepEqual(JSON.parse(deviceDecrypt(a.privHex, pushes[0].body.ciphertext).plaintext), { kind: "sync_probe", probe_id: "p1", aps: { "content-available": 1 } });
});

test("sendPurchaseApprovalPush via the relay keeps time-sensitive inside the ciphertext", async () => {
  const d = { id: "dv_1", name: "Phone", ...newDevice() };
  const r = fakeRelay({ devices: [d] });
  const out = await sendPurchaseApprovalPush(noTokens(), { purchaseId: "p-1", body: "2 items, $41.20", relay: { config: r.config, fetch: r.fetch } });
  assert.deepEqual(out, { delivered: true, sent: 1, ok: 1 });
  const inner = JSON.parse(deviceDecrypt(d.privHex, r.calls.find((c) => c.path === "/v1/push").body.ciphertext).plaintext);
  assert.equal(inner.aps["interruption-level"], "time-sensitive");
  assert.equal(inner.aps.category, "JORI_PURCHASE_APPROVAL");
  assert.equal(inner.purchase_id, "p-1");
});

test("inside a test run a configured relay is not used unless the test hands one in", async () => {
  const t = tempLocal();
  fs.mkdirSync(path.dirname(t.configPath), { recursive: true });
  fs.writeFileSync(t.configPath, JSON.stringify({ relay_url: "https://relay.test", instance_id: "in_1" }));
  const prev = { dir: process.env.JORI_LOCAL_DIR, sec: process.env.JORI_PUSH_RELAY_SECRET };
  process.env.JORI_LOCAL_DIR = t.dir;
  process.env.JORI_PUSH_RELAY_SECRET = "s";
  try {
    assert.ok(relay.relayConfig(), "the relay is configured");
    const out = await sendSilentPush(noTokens(), {});
    assert.match(out.reason, /no iOS device tokens/, "took the direct path (which refuses to send in a test run)");
  } finally {
    if (prev.dir === undefined) delete process.env.JORI_LOCAL_DIR; else process.env.JORI_LOCAL_DIR = prev.dir;
    if (prev.sec === undefined) delete process.env.JORI_PUSH_RELAY_SECRET; else process.env.JORI_PUSH_RELAY_SECRET = prev.sec;
  }
});

test("read on one device clears the banner everywhere: a relay push's recipients drive sendClearPush", async () => {
  const a = { id: "dv_phone", name: "Phone", ...newDevice() };
  const b = { id: "dv_mac", name: "Mac", ...newDevice() };
  const r = fakeRelay({ devices: [a, b] });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "push-recipients-")), "push-recipients.json");
  recordPushRecipients("m-1", [RELAY_CLASS], { file });
  assert.deepEqual(pushRecipients("m-1", { file }), ["relay"]);
  const out = await sendClearPush(noTokens(), ["m-1", "never-pushed"], { file, badge: 0, relay: { config: r.config, fetch: r.fetch } });
  assert.equal(out.delivered, true);
  assert.equal(out.sent, 2);
  const pushes = r.calls.filter((c) => c.path === "/v1/push");
  assert.deepEqual(pushes.map((p) => p.body.device_id), ["dv_phone", "dv_mac"]);
  assert.ok(pushes.every((p) => p.body.push_type === "background" && p.body.priority === 5));
  assert.deepEqual(JSON.parse(deviceDecrypt(b.privHex, pushes[1].body.ciphertext).plaintext),
    { kind: "clear_notifications", message_ids: ["m-1"], badge: 0, aps: { "content-available": 1 } });
});
