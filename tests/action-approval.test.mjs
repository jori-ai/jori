// Face-ID approval for plugin actions: lib/action-approval.mjs (+ the manifest
// rules in lib/plugins.cjs). Signatures use generated P-256 keys, exactly the
// shape the app's Secure Enclave key produces (DER ECDSA over SHA-256).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import {
  ACTION_DOMAIN, normalizeActionItem, buildActionRequest, verifyActionRow, actionHash,
  expandRun, resultMessage, summarize, EXECUTE_GRACE_MS,
} from "../lib/action-approval.mjs";

const { validate } = createRequire(import.meta.url)("../lib/plugins.cjs");

const ITEM = {
  plugin: "tide-check", action: "send-alert", title: "Text the crew about the low tide",
  fields: [{ label: "To", value: "Beach group" }, { label: "When", value: "Sat 07:10" }],
  params: { group: "beach", minutes: 25, urgent: false, note: null },
};

function keypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  return { privateKey, rawB64: raw.toString("base64") };
}
const sign = (privateKey, message) => crypto.sign("sha256", Buffer.from(message, "utf8"), { key: privateKey, dsaEncoding: "der" }).toString("base64");

function signedRow({ now = 1_800_000_000_000, item = ITEM, message = null, keys = keypair() } = {}) {
  const req = buildActionRequest("act_20261109_abcd1234", item, { now, nonce: "n".repeat(32), ttlMs: 15 * 60000 });
  const row = {
    id: req.id, plugin: req.item.plugin, action: req.item.action, item_json: req.item, item_hash: req.hash,
    nonce: req.nonce, expires_at_ms: req.expiresAt, signed_by: "dev-1",
    signature: sign(keys.privateKey, message ?? req.message),
  };
  return { row, req, keys, now };
}

describe("normalizeActionItem", () => {
  it("keeps exactly the shown keys", () => {
    const n = normalizeActionItem({ ...ITEM, extra: "hidden" });
    assert.deepEqual(Object.keys(n).sort(), ["action", "fields", "params", "plugin", "title", "v"]);
  });
  it("refuses what Swift and JS would hash differently, or the card could not show", () => {
    for (const bad of [
      { params: { amount: 12.5 } }, { params: { nested: { a: 1 } } }, { params: { list: [1] } },
      { params: { BadKey: 1 } }, { params: [] }, { plugin: "Bad Name" }, { action: "" },
      { title: "" }, { fields: [{ label: "x" }] }, { fields: [], params: {} },
      { params: { big: Number.MAX_SAFE_INTEGER + 2 } },
    ]) assert.throws(() => normalizeActionItem({ ...ITEM, ...bad }), undefined, JSON.stringify(bad));
  });
  it("collapses whitespace in fields but keeps param strings verbatim", () => {
    const n = normalizeActionItem({ ...ITEM, fields: [{ label: " To ", value: "a\n b" }], params: { body: "line 1\nline 2" } });
    assert.deepEqual(n.fields, [{ label: "To", value: "a b" }]);
    assert.equal(n.params.body, "line 1\nline 2");
  });
});

describe("verifyActionRow", () => {
  it("accepts the signature the app makes", () => {
    const { row, keys, now } = signedRow();
    assert.deepEqual(verifyActionRow(row, keys.rawB64, { now: now + 1000 }), { ok: true });
  });
  it("signs this domain, never the purchase or self-improvement one", () => {
    const { req } = signedRow();
    assert.ok(req.message.startsWith(`${ACTION_DOMAIN}\n`));
    const keys = keypair();
    const purchaseSig = signedRow({ keys, message: req.message.replace(ACTION_DOMAIN, "jori-purchase.v1") });
    assert.equal(verifyActionRow(purchaseSig.row, keys.rawB64, { now: purchaseSig.now }).reason, "bad signature");
  });
  it("refuses a changed item, a renamed action, another key, an unsigned row and an old one", () => {
    const { row, keys, now } = signedRow();
    const changed = { ...row, item_json: { ...row.item_json, params: { ...row.item_json.params, minutes: 26 } } };
    assert.equal(verifyActionRow(changed, keys.rawB64, { now }).reason, "item changed since request");
    assert.match(verifyActionRow({ ...row, action: "other" }, keys.rawB64, { now }).reason, /different actions/);
    assert.equal(verifyActionRow(row, keypair().rawB64, { now }).reason, "bad signature");
    assert.equal(verifyActionRow({ ...row, signature: null }, keys.rawB64, { now }).reason, "unsigned");
    assert.match(verifyActionRow(row, null, { now }).reason, /not a paired device/);
    assert.equal(verifyActionRow(row, keys.rawB64, { now: row.expires_at_ms + EXECUTE_GRACE_MS + 1 }).reason, "expired");
    assert.deepEqual(verifyActionRow(row, keys.rawB64, { now: row.expires_at_ms + 1000 }), { ok: true }, "inside the grace");
  });
});

describe("expandRun", () => {
  it("fills placeholders and plugin-relative paths, nothing from the request", () => {
    const cmd = expandRun("{node} bin/tide-check-send-alert --root {root}", "/x/plugins/tide-check", { node: "/n/node", sysnode: "/s/node", root: "/x", home: "/h" });
    assert.equal(cmd, "/n/node /x/plugins/tide-check/bin/tide-check-send-alert --root /x");
  });
});

describe("resultMessage", () => {
  const n = normalizeActionItem(ITEM);
  it("uses the action's own say: line, else a plain sentence", () => {
    assert.equal(resultMessage(n, { ok: true, stdout: "log\nsay: Sent to the beach group." }), "Sent to the beach group.");
    assert.equal(resultMessage(n, { ok: true, stdout: "{}" }), "Done: Text the crew about the low tide.");
    assert.equal(resultMessage(n, { ok: false, exitCode: 3, stderr: "boom\nno signal" }), "Text the crew about the low tide didn't go through (no signal).");
    assert.match(resultMessage(n, { ok: false, timedOut: true }), /didn't finish in time/);
  });
  it("summarizes for the push", () => {
    assert.equal(summarize(n), "Text the crew about the low tide — To: Beach group, When: Sat 07:10");
  });
});

describe("manifest approvals", () => {
  const base = { name: "tide-check", title: "T", description: "D" };
  it("accepts a declared action", () => {
    assert.deepEqual(validate({ ...base, approvals: { "send-alert": { title: "Send", run: "{node} bin/x", ttl_minutes: 10, timeout_seconds: 60 } } }), []);
  });
  it("refuses malformed ones", () => {
    assert.ok(validate({ ...base, approvals: [] }).length);
    assert.ok(validate({ ...base, approvals: { "Bad Name": { title: "x", run: "y" } } }).length);
    assert.ok(validate({ ...base, approvals: { a: { title: "x" } } }).length);
    assert.ok(validate({ ...base, approvals: { a: { title: "x", run: "y # z" } } }).length);
    assert.ok(validate({ ...base, approvals: { a: { title: "x", run: "y", ttl_minutes: 0 } } }).length);
  });
});

describe("Swift parity vector", () => {
  // ActionApproval.swift's canonicalJSON() must produce exactly this string for
  // this item (pinned so a change on either side fails a test, not an
  // approval): non-ASCII, a quote, a slash, a control character, a newline in a
  // param, a negative integer, true, false and null.
  it("canonical JSON + hash are stable", () => {
    const n = normalizeActionItem({
      plugin: "tide-check", action: "send-alert", title: "Café \"quote\" / slash",
      fields: [{ label: "To", value: "Beach\u0007 group" }],
      params: { body: "line 1\nline 2 é", minutes: -25, urgent: true, quiet: false, note: null },
    });
    assert.equal(actionHash(n), "3ef0a360612132d25a9fc3032ba1f8459a10f916b7d7b92b0a549370adda2036");
  });
});
