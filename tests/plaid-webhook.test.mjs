// plaid-webhook.test.mjs — offline unit tests for the Plaid webhook verifier
// that guards the public :9090 /plaid-webhook path
// (agent/supervisor/plaid-webhook.mjs).
//
// Same shape as oidc-verify.test.mjs: generate an EC P-256 keypair, mint Plaid-
// shaped JWTs locally, inject the public JWK via the _setKeyForTest seam. No
// network, no Plaid credentials, no npm deps.
//
// What makes this worth testing rather than eyeballing: a webhook that verifies
// too loosely lets anyone who can reach the public webhook host drive bank syncs, and
// the two subtle failure modes (a DER-vs-P1363 signature encoding, and hashing
// re-serialized JSON instead of the wire bytes) both fail SILENTLY in the
// direction of "accept" or "always reject" rather than loudly.
//
// Run: node --test tests/plaid-webhook.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyPlaidWebhook, _setKeyForTest } from "../agent/supervisor/plaid-webhook.mjs";

const KID = "test-key-1";
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const JWK = { ...publicKey.export({ format: "jwk" }), alg: "ES256", kid: KID, use: "sig" };

const b64 = (buf) => Buffer.from(buf).toString("base64url");

/** Mint a webhook exactly as Plaid does: ES256 JWT + the body it commits to. */
function mint(bodyObj, { iatOffsetSec = 0, alg = "ES256", kid = KID, bodyHash } = {}) {
  const raw = Buffer.from(JSON.stringify(bodyObj), "utf8");
  const header = b64(JSON.stringify({ alg, kid, typ: "JWT" }));
  const claims = b64(JSON.stringify({
    iat: Math.floor(Date.now() / 1000) + iatOffsetSec,
    request_body_sha256: bodyHash ?? crypto.createHash("sha256").update(raw).digest("hex"),
  }));
  // JOSE uses raw r||s, not DER — the same encoding the verifier must ask for.
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${claims}`),
    { key: privateKey, dsaEncoding: "ieee-p1363" });
  return { raw, token: `${header}.${claims}.${b64(sig)}` };
}

const BODY = { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-abc" };

test("setup: inject the local public key", () => {
  _setKeyForTest(KID, JWK);
});

test("accepts a genuine webhook and returns the parsed payload", async () => {
  const { raw, token } = mint(BODY);
  const payload = await verifyPlaidWebhook(raw, token);
  assert.equal(payload.webhook_code, "SYNC_UPDATES_AVAILABLE");
  assert.equal(payload.item_id, "item-abc");
});

test("rejects a tampered body even though the JWT itself is valid", async () => {
  // The attack this stops: replay a real signed header against a swapped body.
  const { token } = mint(BODY);
  const tampered = Buffer.from(JSON.stringify({ ...BODY, item_id: "item-attacker" }), "utf8");
  await assert.rejects(() => verifyPlaidWebhook(tampered, token), /body hash mismatch/);
});

test("rejects a bad signature", async () => {
  const { raw, token } = mint(BODY);
  const [h, c, s] = token.split(".");
  const flipped = Buffer.from(s, "base64url");
  flipped[0] ^= 0xff;
  await assert.rejects(() => verifyPlaidWebhook(raw, `${h}.${c}.${b64(flipped)}`), /bad signature/);
});

test("rejects a signature from the wrong key", async () => {
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const raw = Buffer.from(JSON.stringify(BODY), "utf8");
  const header = b64(JSON.stringify({ alg: "ES256", kid: KID, typ: "JWT" }));
  const claims = b64(JSON.stringify({
    iat: Math.floor(Date.now() / 1000),
    request_body_sha256: crypto.createHash("sha256").update(raw).digest("hex"),
  }));
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${claims}`),
    { key: other, dsaEncoding: "ieee-p1363" });
  await assert.rejects(() => verifyPlaidWebhook(raw, `${header}.${claims}.${b64(sig)}`), /bad signature/);
});

test("rejects alg=none and alg confusion", async () => {
  for (const alg of ["none", "HS256", "RS256"]) {
    const { raw, token } = mint(BODY, { alg });
    await assert.rejects(() => verifyPlaidWebhook(raw, token), /unexpected alg/);
  }
});

test("rejects a stale webhook (replay outside the 5 minute window)", async () => {
  const { raw, token } = mint(BODY, { iatOffsetSec: -6 * 60 });
  await assert.rejects(() => verifyPlaidWebhook(raw, token), /stale webhook/);
});

test("accepts one just inside the replay window", async () => {
  const { raw, token } = mint(BODY, { iatOffsetSec: -4 * 60 });
  const payload = await verifyPlaidWebhook(raw, token);
  assert.equal(payload.item_id, "item-abc");
});

test("rejects a missing or malformed header", async () => {
  const { raw } = mint(BODY);
  await assert.rejects(() => verifyPlaidWebhook(raw, ""), /missing Plaid-Verification/);
  await assert.rejects(() => verifyPlaidWebhook(raw, "not.a.jwt.at.all"), /malformed verification JWT/);
});

test("rejects a body hash of the right shape but the wrong value", async () => {
  const { raw, token } = mint(BODY, { bodyHash: "0".repeat(64) });
  await assert.rejects(() => verifyPlaidWebhook(raw, token), /body hash mismatch/);
});

test("hashes wire bytes, not re-serialized JSON", async () => {
  // Plaid's hash covers what it sent. A verifier that parsed first and re-
  // stringified would reject this genuine webhook, because the whitespace does
  // not survive the round trip.
  const spaced = Buffer.from('{"webhook_type": "ITEM",  "webhook_code": "ERROR", "item_id": "i1"}', "utf8");
  const header = b64(JSON.stringify({ alg: "ES256", kid: KID, typ: "JWT" }));
  const claims = b64(JSON.stringify({
    iat: Math.floor(Date.now() / 1000),
    request_body_sha256: crypto.createHash("sha256").update(spaced).digest("hex"),
  }));
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${claims}`),
    { key: privateKey, dsaEncoding: "ieee-p1363" });
  const payload = await verifyPlaidWebhook(spaced, `${header}.${claims}.${b64(sig)}`);
  assert.equal(payload.webhook_code, "ERROR");
});
