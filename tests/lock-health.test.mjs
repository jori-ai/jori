// lock-health — the rules behind bin/lock-health (lib/lock-health.js) and the
// read-only TTLock client (lib/ttlock.js). Run: node --test tests/lock-health.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lh = require("../lib/lock-health.js");
const { TTLockClient, TTLockError, ERR, borrowedToken } = require("../lib/ttlock.js");

const NOW = Date.parse("2026-11-04T15:00:00Z");
const HOUR = 3600e3;
const cfg = { battery_low_pct: 20, probe_every_hours: 6, preflight_hours: 36, confirm_runs: 2 };

const ttl = (over = {}) => ({
  key: "ttlock:1", provider: "ttlock", name: "Back door", property: "P1", units: ["u1"],
  battery: 80, has_gateway: true, gateway: { id: 9, name: "GW", online: true }, probe: { at: new Date(NOW).toISOString(), ok: true }, ...over,
});
const sch = (over = {}) => ({ key: "schlage:front", provider: "schlage", name: "Front", property: "P2", units: ["P2"], online: true, battery: 70, battery_low: false, ...over });

// ── conditions ──────────────────────────────────────────────────────────────

test("a healthy lock has no conditions", () => {
  assert.deepEqual(lh.conditionsOf(ttl(), cfg), []);
  assert.deepEqual(lh.conditionsOf(sch(), cfg), []);
});

test("TTLock: dead lock (-2012) is unreachable, busy gateway (-3003) is its own kind", () => {
  const dead = ttl({ probe: { ok: false, errcode: ERR.NOT_CONNECTED_TO_GATEWAY, errmsg: "The Device is not connected to any Gateway." } });
  assert.deepEqual(lh.conditionsOf(dead, cfg), ["unreachable"]);
  assert.match(lh.conditionText("unreachable", dead), /dead batteries or out of range/);
  const busy = ttl({ probe: { ok: false, errcode: ERR.GATEWAY_BUSY, errmsg: "busy" } });
  assert.deepEqual(lh.conditionsOf(busy, cfg), ["gateway_busy"]);
});

test("TTLock: gateway offline outranks a stale probe; no gateway is stated outright", () => {
  assert.deepEqual(lh.conditionsOf(ttl({ gateway: { id: 9, name: "GW", online: false }, probe: null }), cfg), ["gateway_offline"]);
  assert.deepEqual(lh.conditionsOf(ttl({ has_gateway: false, gateway: null, probe: null }), cfg), ["no_gateway"]);
});

test("battery: at or under the threshold alerts; TTLock's 0 is not a reading", () => {
  assert.deepEqual(lh.conditionsOf(ttl({ battery: 20 }), cfg), ["battery_low"]);
  assert.deepEqual(lh.conditionsOf(ttl({ battery: 0 }), cfg), []);
  assert.deepEqual(lh.conditionsOf(sch({ battery: 60, battery_low: true }), cfg), ["battery_low"]);
});

test("Schlage offline; an unreadable provider is one condition and nothing else", () => {
  assert.deepEqual(lh.conditionsOf(sch({ online: false }), cfg), ["offline"]);
  assert.deepEqual(lh.conditionsOf({ key: "provider:ttlock", provider: "ttlock", name: "TTLock account", error: "token expired" }, cfg), ["unreadable"]);
});

// ── probing ─────────────────────────────────────────────────────────────────

test("a healthy lock is probed only every probe_every_hours; an open problem every run; a needed lock if over an hour stale", () => {
  const st = (agoH, open = false) => ({
    probes: { "ttlock:1": { at: new Date(NOW - agoH * HOUR).toISOString(), ok: true } },
    conditions: open ? { "ttlock:1|unreachable": {} } : {},
  });
  assert.equal(lh.shouldProbe("ttlock:1", st(2), { nowMs: NOW, cfg }), false);
  assert.equal(lh.shouldProbe("ttlock:1", st(6), { nowMs: NOW, cfg }), true);
  assert.equal(lh.shouldProbe("ttlock:1", st(0.1, true), { nowMs: NOW, cfg }), true);
  assert.equal(lh.shouldProbe("ttlock:1", st(2), { needed: true, nowMs: NOW, cfg }), true);
  assert.equal(lh.shouldProbe("ttlock:1", st(0.5), { needed: true, nowMs: NOW, cfg }), false);
  assert.equal(lh.shouldProbe("ttlock:1", {}, { nowMs: NOW, cfg }), true);
});

// ── alert once, recover once ────────────────────────────────────────────────

const dead = ttl({ probe: { ok: false, errcode: -2012, errmsg: "not connected" } });

test("a probe failure alerts on the second run in a row, then stays quiet, then recovers once", () => {
  let r = lh.plan({ readings: [dead], state: {}, nowMs: NOW, cfg });
  assert.equal(r.alerts.length, 0, "one bad probe may be a blip");
  r = lh.plan({ readings: [dead], state: r.state, nowMs: NOW + HOUR, cfg });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].kind, "unreachable");
  r = lh.plan({ readings: [dead], state: r.state, nowMs: NOW + 2 * HOUR, cfg });
  assert.equal(r.alerts.length, 0, "never twice for the same condition");
  r = lh.plan({ readings: [ttl()], state: r.state, nowMs: NOW + 3 * HOUR, cfg });
  assert.equal(r.recoveries.length, 1);
  assert.deepEqual(r.state.conditions, {});
  r = lh.plan({ readings: [ttl()], state: r.state, nowMs: NOW + 4 * HOUR, cfg });
  assert.equal(r.recoveries.length, 0);
});

test("a blip that clears before confirming says nothing either way", () => {
  let r = lh.plan({ readings: [dead], state: {}, nowMs: NOW, cfg });
  r = lh.plan({ readings: [ttl()], state: r.state, nowMs: NOW + HOUR, cfg });
  assert.equal(r.alerts.length + r.recoveries.length, 0);
});

test("a low battery alerts on first sight", () => {
  const r = lh.plan({ readings: [ttl({ battery: 12 })], state: {}, nowMs: NOW, cfg });
  assert.equal(r.alerts.length, 1);
});

test("a lock someone needs soon alerts on the first bad reading (the pre-flight)", () => {
  const needs = new Map([["ttlock:1", [{ property: "P1", unit: "u1", atMs: NOW + 20 * HOUR, why: "check-in" }]]]);
  const r = lh.plan({ readings: [dead], state: {}, needs, nowMs: NOW, cfg });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].needs.length, 1);
});

test("an unreadable provider keeps its locks' conditions: no data is not a recovery", () => {
  let r = lh.plan({ readings: [dead], state: {}, nowMs: NOW, cfg });
  r = lh.plan({ readings: [dead], state: r.state, nowMs: NOW + HOUR, cfg });
  const acct = { key: "provider:ttlock", provider: "ttlock", name: "TTLock account", error: "HTTP 502" };
  r = lh.plan({ readings: [acct], state: r.state, nowMs: NOW + 2 * HOUR, cfg, unread: new Set(["provider:ttlock"]) });
  assert.equal(r.recoveries.length, 0);
  assert.ok(r.state.conditions["ttlock:1|reach"].alerted_at);
});

// Guards the "🔐 Lock problem … no gateway paired" row that also said "✅ … no
// longer gateway … offline" for the same lock: one gateway dropping in and out
// is one problem, whichever layer reports it on a given run.
test("a lock's reach problem changing layer is one condition: no recovery, no second alert, words follow the layer", () => {
  const needs = new Map([["ttlock:1", [{ property: "P1", unit: "u1", atMs: null, why: "code-pending" }]]]);
  const gwOff = ttl({ gateway: { id: 9, name: "Main GW", online: false }, probe: null });
  const noGw = ttl({ has_gateway: false, gateway: null, probe: null });
  const failed = ttl({ probe: { ok: false, errcode: ERR.FAILED, errmsg: "failed or means no" } });
  let r = lh.plan({ readings: [gwOff], state: {}, needs, nowMs: NOW, cfg });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].kind, "gateway_offline");
  for (const [i, reading] of [noGw, failed].entries()) {
    r = lh.plan({ readings: [reading], state: r.state, needs, nowMs: NOW + (i + 1) * HOUR, cfg });
    assert.equal(r.alerts.length + r.recoveries.length, 0, "a change of layer says nothing");
  }
  assert.deepEqual(Object.keys(r.state.conditions), ["ttlock:1|reach"]);
  assert.equal(r.state.conditions["ttlock:1|reach"].text, "the gateway can't reach the lock (the lock didn't answer it)");
  r = lh.plan({ readings: [ttl()], state: r.state, needs, nowMs: NOW + 3 * HOUR, cfg });
  assert.equal(r.recoveries.length, 1, "one recovery when it is really back");
  assert.match(lh.compose({ alerts: [], recoveries: r.recoveries }).text, /no longer the gateway can't reach the lock$/);
});

test("state written under the old per-layer keys folds into the reach key: no spurious recovery on deploy", () => {
  const old = { conditions: { "ttlock:1|gateway_offline": { lock: "ttlock:1", kind: "gateway_offline", name: "Back door", property: "P1", first_seen: new Date(NOW).toISOString(), runs: 3, alerted_at: new Date(NOW).toISOString(), text: "gateway GW offline" } } };
  const r = lh.plan({ readings: [ttl({ has_gateway: false, gateway: null, probe: null })], state: old, nowMs: NOW + HOUR, cfg });
  assert.equal(r.alerts.length + r.recoveries.length, 0);
  assert.equal(r.state.conditions["ttlock:1|reach"].runs, 4);
  assert.equal(lh.plan({ readings: [ttl()], state: old, nowMs: NOW + HOUR, cfg }).recoveries.length, 1);
});

// ── needs ───────────────────────────────────────────────────────────────────

test("upcoming needs: a signed lease starting inside the window, and a code the hub has not set", () => {
  const leases = [
    { status: "completed", terms: { propertySlug: "P1", unitId: "u1", startDate: "2026-11-05T00:00:00Z" } },
    { status: "completed", terms: { propertySlug: "P1", unitId: "u2", startDate: "2026-12-01T00:00:00Z" } }, // too far
    { status: "sent", terms: { propertySlug: "P1", unitId: "u3", startDate: "2026-11-05T00:00:00Z" } },      // unsigned
    { status: "completed", terms: { propertySlug: "P1", unitId: "u4", startDate: "2026-10-01T00:00:00Z" } }, // long started
  ];
  const tenants = [
    { propertySlug: "P1", unitId: "u5", status: "future", leaseStartDate: "2026-11-05T00:00:00Z", ttlockError: "E118 Back: error -2012" },
    { propertySlug: "P1", unitId: "u6", status: "former", leaseStartDate: "2026-11-05T00:00:00Z", ttlockError: "old" },
    { propertySlug: "P1", unitId: "u7", status: "current", leaseStartDate: "2026-11-05T00:00:00Z" },
    // Guards the 'Lock problem … needed: 2 codes waiting to be set' alert that
    // fired on every one-hour reach blip: a door error on a tenant who checked
    // in months ago is past the hub's retry, so it is not a need.
    { propertySlug: "P1", unitId: "u8", status: "current", leaseStartDate: "2026-08-01T00:00:00Z", ttlockError: "window not moved, error -2012" },
    { propertySlug: "P1", unitId: "u9", status: "current", ttlockError: "no lease start: the hub does not retry it either" },
    // Check-in today at the property (Berlin, 16:00 on Nov 4) is still retried.
    { propertySlug: "P1", unitId: "u10", status: "future", leaseStartDate: "2026-11-04T00:00:00Z", schlageError: "busy" },
  ];
  const needs = lh.upcomingNeeds({ leases, tenants, nowMs: NOW, cfg, tz: "Europe/Berlin" });
  assert.deepEqual(needs.map((n) => `${n.unit}:${n.why}`), ["u1:check-in", "u5:code-pending", "u10:code-pending"]);
  // 15:00 at the property's wall clock (Berlin in November = UTC+1).
  assert.equal(new Date(needs[0].atMs).toISOString(), "2026-11-05T14:00:00.000Z");
});

test("a need touches its unit's locks, or the whole property when the unit is unknown", () => {
  const readings = [ttl({ key: "ttlock:1", units: ["u1"] }), ttl({ key: "ttlock:2", units: ["u2"] }), sch()];
  assert.deepEqual(lh.locksForNeed({ property: "P1", unit: "u1" }, readings), ["ttlock:1"]);
  assert.deepEqual(lh.locksForNeed({ property: "P1", unit: null }, readings), ["ttlock:1", "ttlock:2"]);
  assert.deepEqual(lh.locksForNeed({ property: "P1", unit: "nope" }, readings), ["ttlock:1", "ttlock:2"]);
});

// ── words ───────────────────────────────────────────────────────────────────

test("compose: one bullet per lock, property name first, push only for new problems", () => {
  const needs = [{ why: "check-in", atMs: Date.parse("2026-11-05T14:00:00Z") }, { why: "code-pending" }];
  const a = [
    { lock: "ttlock:1", kind: "unreachable", name: "Back door", property: "P1", text: "the gateway can't reach the lock (dead batteries or out of range)", needs },
    { lock: "ttlock:1", kind: "battery_low", name: "Back door", property: "P1", text: "battery 8%", needs: [] },
  ];
  const m = lh.compose({ alerts: a, recoveries: [], propertyNames: { P1: "Oak House" }, tz: "Europe/Berlin" });
  assert.equal(m.text.split("\n").length, 2);
  assert.match(m.text, /^🔐 Lock problem, before anyone needs the door\n- Oak House · Back door: the gateway can't reach the lock .*; battery 8% · needed: check-in Thu, Nov 5, 3 PM, 1 code waiting to be set$/);
  assert.equal(m.push, "Lock problem: Oak House · Back door");

  const rec = lh.compose({ alerts: [], recoveries: [{ lock: "schlage:front", kind: "offline", name: "Front", property: "P2", text: "offline (its cloud can't reach it)" }], propertyNames: {} });
  assert.equal(rec.push, null, "a recovery posts silently");
  assert.equal(rec.text, "✅ Lock back to normal\n- P2 · Front: no longer offline");
  assert.equal(lh.compose({ alerts: [], recoveries: [] }), null);
});

test("preflightVerdict reports blips too, and an unknown property as not ok", () => {
  const busy = ttl({ probe: { ok: false, errcode: -3003, errmsg: "busy" } });
  const v = lh.preflightVerdict({ need: { property: "P1", unit: "u1" }, readings: [busy], cfg });
  assert.equal(v.ok, false);
  assert.match(v.locks[0].problems[0], /busy/);
  assert.equal(lh.preflightVerdict({ need: { property: "ZZ" }, readings: [busy], cfg }).ok, false);
  assert.equal(lh.preflightVerdict({ need: { property: "P1", unit: "u1" }, readings: [ttl()], cfg }).ok, true);
});

// ── the TTLock client ───────────────────────────────────────────────────────

test("TTLock client signs every call with clientId/token/date and surfaces errcodes", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const p = Object.fromEntries(new URLSearchParams(init.body.toString()));
    calls.push({ url, p });
    if (url.endsWith("/v3/lock/queryOpenState")) return { ok: true, json: async () => ({ errcode: -2012, errmsg: "The Device is not connected to any Gateway." }) };
    return { ok: true, json: async () => ({ list: [{ lockId: 1 }] }) };
  };
  const c = new TTLockClient({ clientId: "cid", accessToken: "tok", base: "https://x.test/", fetchImpl });
  assert.deepEqual(await c.listLocks(), [{ lockId: 1 }]);
  assert.equal(calls[0].url, "https://x.test/v3/lock/list");
  assert.equal(calls[0].p.clientId, "cid");
  assert.equal(calls[0].p.accessToken, "tok");
  assert.ok(Number(calls[0].p.date) > 0);
  await assert.rejects(c.queryOpenState(1), (e) => e instanceof TTLockError && e.errcode === -2012);
});

test("TTLock client has no write path", () => {
  const methods = Object.getOwnPropertyNames(TTLockClient.prototype);
  assert.deepEqual(methods.filter((m) => /^(add|delete|change|set|unlock|lock\b)|passcode/i.test(m)), []);
});

test("borrowedToken reads the hub's token and never accepts an expired one", async () => {
  const DOC = "auth_store/current";
  const db = (doc) => ({ get: async (col, id) => (`${col}/${id}` === DOC ? doc : null) });
  assert.equal((await borrowedToken(db({ accessToken: "a", expiresAt: NOW + HOUR }), DOC, NOW)).accessToken, "a");
  assert.match((await borrowedToken(db({ accessToken: "a", expiresAt: NOW - 1 }), DOC, NOW)).error, /expired/);
  assert.match((await borrowedToken(db(null), DOC, NOW)).error, /no TTLock token/);
  assert.match((await borrowedToken(db(null), "", NOW)).error, /no token doc/);
});
