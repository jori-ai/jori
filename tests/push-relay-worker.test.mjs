// push-relay-worker.test.mjs — the relay Worker (push-relay/src/index.js) end
// to end: the host client (lib/push-relay.mjs) talks to the Worker's fetch
// handler, the Worker runs its real SQL on node:sqlite behind a small D1 shim
// (push-relay/schema.sql), and APNs is a stub. Nothing reaches a network.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import worker from "../push-relay/src/index.js";
import * as core from "../push-relay/src/core.js";
import * as relay from "../lib/push-relay.mjs";

const SCHEMA = fs.readFileSync(new URL("../push-relay/schema.sql", import.meta.url), "utf8");
const BASE = "https://relay.test";

/** The slice of the D1 API the Worker uses, over an in-memory SQLite. */
function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return {
    db,
    prepare: (sql) => stmt(sql),
    batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; },
  };
}

function setup({ apns = () => ({ status: 200 }) } = {}) {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const DB = d1();
  const env = { DB, APNS_KEY_P8: privateKey.export({ type: "pkcs8", format: "pem" }), APNS_KEY_ID: "KEYID", APNS_TEAM_ID: "TEAMID", APNS_TOPIC: "app.example.jori" };
  const apnsCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    apnsCalls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    const r = apns(apnsCalls.at(-1));
    return new Response(r.reason ? JSON.stringify({ reason: r.reason }) : "", { status: r.status, headers: { "apns-id": "apns-1" } });
  };
  const restore = () => { globalThis.fetch = realFetch; };
  // The host client's fetch: straight into the Worker.
  const call = (ip = "198.51.100.7") => async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("CF-Connecting-IP", ip);
    return worker.fetch(new Request(url, { method: init.method, headers, body: init.body }), env);
  };
  return { env, DB, apnsCalls, restore, fetch: call(), callFrom: call };
}

function device() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { priv: ecdh.getPrivateKey(), pubB64: ecdh.getPublicKey().toString("base64") };
}

function open(priv, blobB64) {
  const blob = Buffer.from(blobB64, "base64");
  const eph = blob.subarray(0, 65);
  const dev = crypto.createECDH("prime256v1");
  dev.setPrivateKey(priv);
  const key = Buffer.from(crypto.hkdfSync("sha256", dev.computeSecret(eph), eph, Buffer.from("jori-push-v1"), 32));
  const d = crypto.createDecipheriv("aes-256-gcm", key, blob.subarray(65, 77));
  d.setAuthTag(blob.subarray(blob.length - 16));
  return JSON.parse(Buffer.concat([d.update(blob.subarray(77, blob.length - 16)), d.final()]).toString("utf8"));
}

async function newInstance(fetch) {
  const res = await fetch(`${BASE}/v1/instances`, { method: "POST" });
  assert.equal(res.status, 201);
  const { instance_id, instance_secret } = await res.json();
  return { relayUrl: BASE, instanceId: instance_id, secret: instance_secret };
}

async function pairDevice(t, config, { apnsToken = "a1".repeat(32), environment = "sandbox", name = "Test Phone" } = {}) {
  const dev = device();
  const { token } = await relay.createPairing({ config, fetch: t.fetch });
  const res = await t.fetch(`${BASE}/v1/devices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instance_id: config.instanceId, pairing_token: token, apns_token: apnsToken, environment, device_name: name, public_key: dev.pubB64 }),
  });
  assert.equal(res.status, 201);
  const { device_id, device_secret } = await res.json();
  return { ...dev, id: device_id, secret: device_secret, token };
}

/** A request signed as a device, with the worker's own signer. */
async function asDevice(t, d, method, path, bodyObj) {
  const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  const headers = await core.signRequest({ method, path, body, id: d.id, secret: d.secret, who: "device" });
  return t.fetch(`${BASE}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body || undefined });
}

test("pair, list, push: the relay forwards ciphertext and APNs gets the outer placeholder", async () => {
  const t = setup();
  try {
    const config = await newInstance(t.fetch);
    assert.match(config.instanceId, /^in_[A-Za-z0-9_-]{22}$/);
    assert.equal(Buffer.from(config.secret, "base64url").length, 32);
    const phone = await pairDevice(t, config);

    const listed = await relay.listDevices({ config, fetch: t.fetch });
    assert.equal(listed.length, 1);
    assert.deepEqual(Object.keys(listed[0]).sort(), ["created_at", "device_id", "device_name", "last_seen_at", "public_key"]);
    assert.equal(listed[0].device_name, "Test Phone");

    const payload = { aps: { alert: { title: "Jori", body: "Dinner is at 8" }, "interruption-level": "time-sensitive" }, message_id: "m-1" };
    const results = await relay.pushToAll(payload, { badge: 3, collapseId: "c-1", config, fetch: t.fetch });
    assert.deepEqual(results.map((r) => [r.device_id, r.status, r.ok]), [[phone.id, 200, true]]);

    assert.equal(t.apnsCalls.length, 1);
    const a = t.apnsCalls[0];
    assert.equal(a.url, `https://api.sandbox.push.apple.com/3/device/${"a1".repeat(32)}`);
    assert.equal(a.headers["apns-topic"], "app.example.jori");
    assert.equal(a.headers["apns-push-type"], "alert");
    assert.equal(a.headers["apns-priority"], "10");
    assert.equal(a.headers["apns-collapse-id"], "c-1");
    assert.match(a.headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.deepEqual(a.body.aps, { alert: { title: "Jori", body: "New message" }, "mutable-content": 1, sound: "default", badge: 3 });
    assert.deepEqual(open(phone.priv, a.body.enc), payload);
    assert.ok(!JSON.stringify(a.body).includes("Dinner"));

    const bg = await relay.pushToAll({ kind: "probe", aps: { "content-available": 1 } }, { pushType: "background", priority: 5, config, fetch: t.fetch });
    assert.equal(bg[0].status, 200);
    assert.deepEqual(t.apnsCalls[1].body.aps, { "content-available": 1 });
    assert.equal(t.apnsCalls[1].headers["apns-push-type"], "background");
    assert.equal(t.apnsCalls[1].headers["apns-priority"], "5");
  } finally {
    t.restore();
  }
});

test("a pairing token works once, and only for its own instance", async () => {
  const t = setup();
  try {
    const config = await newInstance(t.fetch);
    const other = await newInstance(t.fetch);
    const { token } = await relay.createPairing({ config, fetch: t.fetch });
    const reg = (instance_id, apns) => t.fetch(`${BASE}/v1/devices`, {
      method: "POST",
      body: JSON.stringify({ instance_id, pairing_token: token, apns_token: apns, environment: "production", device_name: "P", public_key: device().pubB64 }),
    });
    assert.equal((await reg(other.instanceId, "b2".repeat(32))).status, 403);
    assert.equal((await reg(config.instanceId, "b2".repeat(32))).status, 201);
    assert.equal((await reg(config.instanceId, "c3".repeat(32))).status, 403);
  } finally {
    t.restore();
  }
});

test("at most 10 live pairings per instance", async () => {
  const t = setup();
  try {
    const config = await newInstance(t.fetch);
    for (let i = 0; i < 10; i++) await relay.createPairing({ config, fetch: t.fetch });
    await assert.rejects(relay.createPairing({ config, fetch: t.fetch }), /429 too_many_pairings/);
  } finally {
    t.restore();
  }
});

test("bad signatures, stale timestamps and other instances' devices are refused", async () => {
  const t = setup();
  try {
    const config = await newInstance(t.fetch);
    const other = await newInstance(t.fetch);
    const phone = await pairDevice(t, config);
    await assert.rejects(relay.listDevices({ config: { ...config, secret: "wrong" }, fetch: t.fetch }), /401 unauthorized/);
    await assert.rejects(relay.listDevices({ config: { ...config, instanceId: "in_nobody" }, fetch: t.fetch }), /401 unauthorized/);

    const body = JSON.stringify({ device_id: phone.id, ciphertext: relay.encryptForDevice(phone.pubB64, {}), push_type: "alert" });
    const stale = relay.signRequest({ method: "POST", path: "/v1/push", body, id: config.instanceId, secret: config.secret, timestamp: Date.now() - 6 * 60e3 });
    const r1 = await t.fetch(`${BASE}/v1/push`, { method: "POST", headers: stale, body });
    assert.equal(r1.status, 401);
    assert.equal((await r1.json()).error, "stale_timestamp");

    // Signed for one path, sent to another.
    const h = relay.signRequest({ method: "GET", path: "/v1/devices", id: config.instanceId, secret: config.secret });
    assert.equal((await t.fetch(`${BASE}/v1/pairings`, { method: "POST", headers: h })).status, 401);

    // Another instance cannot push to (or delete) this instance's device.
    const signed = relay.signRequest({ method: "POST", path: "/v1/push", body, id: other.instanceId, secret: other.secret });
    assert.equal((await t.fetch(`${BASE}/v1/push`, { method: "POST", headers: signed, body })).status, 404);
    assert.equal(await relay.deleteDevice(phone.id, { config: other, fetch: t.fetch }), false);
    assert.equal(t.apnsCalls.length, 0);
  } finally {
    t.restore();
  }
});

test("APNs 410 retires the device; a new token from the device revives it", async () => {
  let gone = true;
  const t = setup({ apns: () => (gone ? { status: 410, reason: "Unregistered" } : { status: 200 }) });
  try {
    const config = await newInstance(t.fetch);
    const phone = await pairDevice(t, config, { environment: "production" });
    const r = await relay.pushToAll({ aps: { alert: { body: "x" } } }, { config, fetch: t.fetch });
    assert.equal(r[0].status, 410);
    assert.equal(t.apnsCalls[0].url, `https://api.push.apple.com/3/device/${"a1".repeat(32)}`);
    assert.deepEqual(await relay.listDevices({ config, fetch: t.fetch }), []);

    // Pushing straight at a dead device: 410 without calling APNs.
    const body = JSON.stringify({ device_id: phone.id, ciphertext: relay.encryptForDevice(phone.pubB64, {}), push_type: "alert" });
    const h = relay.signRequest({ method: "POST", path: "/v1/push", body, id: config.instanceId, secret: config.secret });
    assert.equal((await t.fetch(`${BASE}/v1/push`, { method: "POST", headers: h, body })).status, 410);
    assert.equal(t.apnsCalls.length, 1);

    gone = false;
    assert.equal((await asDevice(t, phone, "PUT", `/v1/devices/${phone.id}`, { apns_token: "d4".repeat(32) })).status, 200);
    const back = await relay.pushToAll({ aps: { alert: { body: "y" } } }, { config, fetch: t.fetch });
    assert.equal(back[0].status, 200);
    assert.equal(t.apnsCalls.at(-1).url, `https://api.push.apple.com/3/device/${"d4".repeat(32)}`);
  } finally {
    t.restore();
  }
});

test("a device may update and delete only itself; the host may delete its devices", async () => {
  const t = setup();
  try {
    const config = await newInstance(t.fetch);
    const a = await pairDevice(t, config, { apnsToken: "aa".repeat(32) });
    const b = await pairDevice(t, config, { apnsToken: "bb".repeat(32) });
    assert.equal((await asDevice(t, a, "PUT", `/v1/devices/${b.id}`, { environment: "production" })).status, 403);
    assert.equal((await asDevice(t, a, "PUT", `/v1/devices/${a.id}`, {})).status, 400);
    assert.equal((await asDevice(t, a, "DELETE", `/v1/devices/${b.id}`)).status, 403);
    assert.equal((await asDevice(t, a, "DELETE", `/v1/devices/${a.id}`)).status, 200);
    assert.equal(await relay.deleteDevice(b.id, { config, fetch: t.fetch }), true);
    assert.deepEqual(await relay.listDevices({ config, fetch: t.fetch }), []);
  } finally {
    t.restore();
  }
});

test("re-pairing the same APNs token replaces the old device instead of doubling pushes", async () => {
  const t = setup();
  try {
    const config = await newInstance(t.fetch);
    await pairDevice(t, config, { apnsToken: "ee".repeat(32) });
    const again = await pairDevice(t, config, { apnsToken: "ee".repeat(32) });
    const list = await relay.listDevices({ config, fetch: t.fetch });
    assert.deepEqual(list.map((d) => d.device_id), [again.id]);
  } finally {
    t.restore();
  }
});

test("rate limits: 5 instances per IP per hour; oversize and malformed pushes refused", async () => {
  const t = setup();
  try {
    const from = t.callFrom("203.0.113.9");
    for (let i = 0; i < 5; i++) assert.equal((await from(`${BASE}/v1/instances`, { method: "POST" })).status, 201);
    assert.equal((await from(`${BASE}/v1/instances`, { method: "POST" })).status, 429);
    assert.equal((await t.callFrom("203.0.113.10")(`${BASE}/v1/instances`, { method: "POST" })).status, 201);
    // The relay keeps no raw IPs.
    const keys = t.DB.db.prepare("SELECT key FROM rate_limits").all().map((r) => r.key);
    assert.ok(keys.every((k) => !k.includes("203.0.113")));

    const config = await newInstance(t.fetch);
    const phone = await pairDevice(t, config);
    const send = async (obj) => {
      const body = JSON.stringify(obj);
      const h = relay.signRequest({ method: "POST", path: "/v1/push", body, id: config.instanceId, secret: config.secret });
      return t.fetch(`${BASE}/v1/push`, { method: "POST", headers: h, body });
    };
    assert.equal((await send({ device_id: phone.id, ciphertext: "A".repeat(3504), push_type: "alert" })).status, 413);
    assert.equal((await send({ device_id: phone.id, ciphertext: "nope", push_type: "alert" })).status, 400);
    assert.equal((await t.fetch(`${BASE}/v1/nothing`, { method: "GET" })).status, 404);
    assert.equal((await t.fetch(`${BASE}/v1/push`, { method: "GET" })).status, 405);
  } finally {
    t.restore();
  }
});

test("the hourly sweep drops expired pairings and stale rate windows", async () => {
  const t = setup();
  try {
    const now = Date.now();
    t.DB.db.prepare("INSERT INTO pairings VALUES (?, ?, ?, ?)").run("f".repeat(64), "in_x", now - 1, now - 10);
    t.DB.db.prepare("INSERT INTO rate_limits VALUES (?, ?, ?)").run("push:in_x", now - 3 * 3600e3, 4);
    await worker.scheduled({}, t.env);
    assert.equal(t.DB.db.prepare("SELECT COUNT(*) AS n FROM pairings").get().n, 0);
    assert.equal(t.DB.db.prepare("SELECT COUNT(*) AS n FROM rate_limits").get().n, 0);
  } finally {
    t.restore();
  }
});
