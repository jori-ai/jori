import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  positionFromRow, shouldEvaluate, withinSight, liveLaneActive, realtimeKeeper,
  LIVE_RADIUS_M, MAX_ACCURACY_M, MIN_MOVE_M, IDLE_REEVAL_S,
} from "../lib/local-history-live.mjs";
import { buildLocalHistoryPrompt } from "../lib/local-history-prompt.mjs";

const now = Date.parse("2026-11-06T19:16:00Z");
const at = (secAgo) => new Date(now - secAgo * 1000).toISOString();
const pos = (o = {}) => ({ lat: 45.0, lon: 7.0, accuracy_m: 10, motion: "walking", at: at(5), ...o });
const noSwitch = path.join(os.tmpdir(), "lhl-test-no-such-switch");

test("positionFromRow reads a live_position row and rejects a partial one", () => {
  const p = positionFromRow({ device_id: "d", latitude: 45.1, longitude: 7.1, accuracy_m: 8, motion: "walking", ts: "2026-11-06T19:15:48Z" });
  assert.equal(p.lat, 45.1);
  assert.equal(p.at, "2026-11-06T19:15:48.000Z");
  assert.equal(positionFromRow({ latitude: 45.1, ts: "2026-11-06T19:15:48Z" }), null);
  assert.equal(positionFromRow({ latitude: 45.1, longitude: 7.1 }), null);
});

test("a fresh, accurate fix is evaluated", () => {
  assert.equal(shouldEvaluate(pos(), null, { nowMs: now, hour: 14 }).ok, true);
});

test("stale, coarse and night-time fixes are not", () => {
  assert.equal(shouldEvaluate(pos({ at: at(200) }), null, { nowMs: now, hour: 14 }).ok, false);
  assert.equal(shouldEvaluate(pos({ accuracy_m: MAX_ACCURACY_M + 1 }), null, { nowMs: now, hour: 14 }).ok, false);
  assert.equal(shouldEvaluate(pos(), null, { nowMs: now, hour: 3 }).ok, false);
});

test("a fix barely moved from the last evaluation waits; a real step or a long pause does not", () => {
  const last = pos({ at: at(40) });
  const tiny = pos({ lat: last.lat + 0.00005 }); // ~5 m
  assert.equal(shouldEvaluate(tiny, last, { nowMs: now, hour: 14 }).ok, false);
  const step = pos({ lat: last.lat + (MIN_MOVE_M + 10) / 111_000 });
  assert.equal(shouldEvaluate(step, last, { nowMs: now, hour: 14 }).ok, true);
  const longAgo = pos({ at: at(IDLE_REEVAL_S + 70) });
  assert.equal(shouldEvaluate(pos({ at: at(5), lat: longAgo.lat }), longAgo, { nowMs: now, hour: 14 }).ok, true);
});

test("an older fix than the last evaluated one is ignored", () => {
  const last = pos({ at: at(5) });
  assert.equal(shouldEvaluate(pos({ at: at(30), lat: last.lat + 0.001 }), last, { nowMs: now, hour: 14 }).ok, false);
});

test("withinSight keeps near subjects with something to say, nearest first order preserved", () => {
  const items = [
    { title: "Church", distance_m: 16, summary: "built 1882" },
    { title: "Plaque", distance_m: 40, summary: "", facts: {} },
    { title: "Statue", distance_m: 60, summary: "", facts: { start_date: "1901" } },
    { title: "Far tower", distance_m: LIVE_RADIUS_M + 50, summary: "old" },
  ];
  assert.deepEqual(withinSight(items).map((i) => i.title), ["Church", "Statue"]);
});

test("liveLaneActive needs a live daemon AND a recent phone position", () => {
  const hb = new Date(now - 30_000).toISOString();
  assert.equal(liveLaneActive({ nowMs: now, state: {}, offSwitch: noSwitch }).active, false);
  assert.equal(liveLaneActive({ nowMs: now, state: { heartbeat_at: hb }, offSwitch: noSwitch }).active, false);
  assert.equal(liveLaneActive({ nowMs: now, state: { heartbeat_at: hb, last_position_at: at(60) }, offSwitch: noSwitch }).active, true);
  assert.equal(liveLaneActive({ nowMs: now, state: { heartbeat_at: hb, last_position_at: at(20 * 60) }, offSwitch: noSwitch }).active, false);
  assert.equal(liveLaneActive({ nowMs: now, state: { heartbeat_at: at(10 * 60), last_position_at: at(60) }, offSwitch: noSwitch }).active, false);
});

test("the off switch hands local history back to the hum lane", () => {
  const sw = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lhl-")), ".off");
  fs.writeFileSync(sw, "");
  const st = { heartbeat_at: new Date(now).toISOString(), last_position_at: at(10) };
  assert.equal(liveLaneActive({ nowMs: now, state: st, offSwitch: sw }).active, false);
});

test("the live prompt says the radius it was cut to and never claims a side", () => {
  const p = buildLocalHistoryPrompt({ hour: 14, moving: true, live: true, radiusM: 80, items: [{ title: "Church", distance_m: 16, summary: "built 1882", facts: {} }] });
  assert.match(p, /WITHIN 80m OF THE USER/);
  assert.match(p, /Never "on your left\/right"/);
  const hum = buildLocalHistoryPrompt({ hour: 14, moving: false, place: "a square", items: [{ title: "Church", distance_m: 16, summary: "x", facts: {} }] });
  assert.match(hum, /WITHIN 300m OF THE USER/);
  assert.doesNotMatch(hum, /on your left/);
});

// A fake supabase: removing channels makes every one of them report CLOSED,
// as supabase-js does, and timers run only when the test says so.
function fakeRealtime() {
  const channels = [];
  const timers = [];
  const seen = [];
  return {
    channels, timers, seen,
    open: (attempt, onStatus) => { channels.push({ attempt, onStatus }); },
    closeAll: () => { for (const c of channels.splice(0)) c.onStatus("CLOSED"); },
    report: (status, attempt) => seen.push(`${attempt}:${status}`),
    t: { set: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clear: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); } },
    async fire() { const h = timers.shift(); await h.fn(); return h.ms; },
  };
}

test("realtimeKeeper: one error is one reconnect, and the CLOSED our own removal causes is ignored", async () => {
  const f = fakeRealtime();
  const k = realtimeKeeper({ open: f.open, closeAll: f.closeAll, report: f.report, timers: f.t, minMs: 5000, maxMs: 300_000 });
  f.channels[0].onStatus("SUBSCRIBED");
  f.channels[0].onStatus("CHANNEL_ERROR");
  f.channels[0].onStatus("CLOSED");          // the same dead channel says it again
  assert.equal(f.timers.length, 1, "a second dead status must not queue a second reconnect");
  assert.equal(await f.fire(), 5000);
  assert.equal(k.attempt, 2);
  assert.equal(f.timers.length, 0, "the old channel's CLOSED on removal must not schedule anything");
  f.channels[0].onStatus("SUBSCRIBED");
  assert.deepEqual(f.seen, ["1:SUBSCRIBED", "1:CHANNEL_ERROR", "2:SUBSCRIBED"]);
  k.stop();
});

test("realtimeKeeper backs off while the channel keeps failing and resets only after it stayed up", async () => {
  const f = fakeRealtime();
  let t = 0;
  const k = realtimeKeeper({ open: f.open, closeAll: f.closeAll, report: f.report, timers: f.t, minMs: 5000, maxMs: 20_000, stableMs: 60_000, clock: () => t });
  const last = () => f.channels[f.channels.length - 1];
  const waits = [];
  for (let i = 0; i < 4; i++) {
    last().onStatus("CHANNEL_ERROR");
    waits.push(await f.fire());
  }
  assert.deepEqual(waits, [5000, 10_000, 20_000, 20_000]);
  last().onStatus("SUBSCRIBED");
  t += 2000;
  last().onStatus("CHANNEL_ERROR");                 // subscribed, then dropped at once
  assert.equal(await f.fire(), 20_000, "a flapping channel keeps backing off");
  last().onStatus("SUBSCRIBED");
  t += 120_000;
  last().onStatus("TIMED_OUT");                     // was up for two minutes
  assert.equal(await f.fire(), 5000);
  assert.equal(k.attempt, 7);
  k.stop();
});

test("realtimeKeeper retries when opening throws, and stop() cancels the pending reconnect", async () => {
  const f = fakeRealtime();
  let fail = true;
  const k = realtimeKeeper({
    open: (a, cb) => { if (fail) throw new Error("tried to subscribe multiple times"); f.open(a, cb); },
    closeAll: f.closeAll, report: f.report, timers: f.t,
  });
  assert.equal(f.timers.length, 1);
  assert.match(f.seen[0], /^1:OPEN_FAILED: tried to subscribe/);
  fail = false;
  await f.fire();
  assert.equal(f.channels.length, 1);
  f.channels[0].onStatus("CLOSED");
  assert.equal(f.timers.length, 1);
  k.stop();
  assert.equal(f.timers.length, 0);
  f.channels[0].onStatus("CLOSED");
  assert.equal(f.timers.length, 0, "a stopped keeper never reconnects");
});
