// Regression guard for cluster sic-20260725-generic-turn-hangs — the system-
// channel alert
//   "⚠️ <agent> turn from <source> hung for <N>min with no result — killing +
//    restarting to retry."
// The per-turn watchdog used to kill on a fixed ELAPSED window only, so a turn
// that was still working got SIGKILLed. Since 2026-10-08 it is hybrid (see
// turn-watchdog.mjs § Hybrid detection): an early kill on total silence, the
// old window deferred while progress is recent, and a 3x-window ceiling. These
// fixtures replay the shapes of the three real kills with fake timers.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TurnWatchdog,
  watchdogMsFor,
  hangReasonClause,
  isProgressEvent,
  TURN_WATCHDOG_IDLE_MS,
  TURN_WATCHDOG_MS_DEFAULT,
  TURN_WATCHDOG_MS_JOB_DEFAULT,
} from "../agent/supervisor/turn-watchdog.mjs";

const MIN = 60 * 1000;
const PROGRESS = { type: "user", message: { content: [] } };
const THINKING = { type: "system", subtype: "thinking_tokens", estimated_tokens: 50 };

// Minimal deterministic clock: setTimer/clearTimer/now, advanced by hand.
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: t + ms });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    pending: () => timers.size,
    // Move to absolute time `to`, running due timers in order (a timer may
    // schedule another, which also runs if it falls inside the window).
    advanceTo(to) {
      for (;;) {
        let next = null;
        for (const [id, tm] of timers) if (tm.at <= to && (!next || tm.at < next[1].at)) next = [id, tm];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = to;
    },
    advance(ms) { this.advanceTo(t + ms); },
  };
}

function makeWatchdog(opts = {}) {
  const clock = fakeClock();
  const fires = [];
  const wd = new TurnWatchdog({
    onFire: (item, ms, info) => fires.push({ item, ms, info, at: clock.now() }),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    ...opts,
  });
  return { wd, clock, fires };
}

// Replay [minute, event] pairs in time order, stopping early if it fires.
function replay(wd, clock, fires, events) {
  for (const [m, ev] of events) {
    clock.advanceTo(m * MIN);
    if (fires.length) return;
    wd.touch(ev);
  }
}

test("isProgressEvent: only system/thinking_tokens is a heartbeat", () => {
  assert.equal(isProgressEvent(THINKING), false);
  assert.equal(isProgressEvent(PROGRESS), true);
  assert.equal(isProgressEvent({ type: "assistant" }), true);
  assert.equal(isProgressEvent({ type: "system", subtype: "hook_response" }), true);
});

test("(a) 2026-10-04 shape: progress every minute is spared at 25 and only stopped at the ceiling", () => {
  const { wd, clock, fires } = makeWatchdog();
  const ms = wd.arm({ id: "a", source: "chat-agent" });
  assert.equal(ms, TURN_WATCHDOG_MS_JOB_DEFAULT);
  const evs = [];
  for (let m = 1; m <= 30; m++) evs.push([m, PROGRESS]);
  replay(wd, clock, fires, evs);
  assert.equal(fires.length, 0, "a turn making progress every minute must not be killed at the 25-min window");
  assert.equal(wd.armed, true);
  // If it never stops, the 3x ceiling still bounds it.
  const ceiling = 3 * ms;
  const more = [];
  for (let m = 31; m <= 80; m++) more.push([m, PROGRESS]);
  replay(wd, clock, fires, more);
  assert.equal(fires.length, 1);
  assert.equal(fires[0].at, ceiling);
  assert.equal(fires[0].info.reason, "ceiling");
  assert.equal(hangReasonClause(fires[0].info), " (still making progress, past the 75min ceiling)");
});

test("(a') 2026-10-04 shape that then goes quiet is stopped once progress is 3 min stale", () => {
  const { wd, clock, fires } = makeWatchdog();
  wd.arm({ id: "a2", source: "chat-agent" });
  const evs = [];
  for (let m = 1; m <= 26; m++) evs.push([m, PROGRESS]);
  replay(wd, clock, fires, evs);
  clock.advanceTo(40 * MIN);
  assert.equal(fires.length, 1);
  assert.equal(fires[0].at, 29 * MIN, "past the window, fire as soon as the last progress is 3 min old");
  assert.equal(fires[0].info.reason, "window");
});

test("(b) 2026-10-03 shape: progress until ~20 min, then only thinking_tokens every 4.5 min — killed at 25 with reason window", () => {
  const { wd, clock, fires } = makeWatchdog();
  const ms = wd.arm({ id: "b", source: "location-enrich" });
  assert.equal(ms, 25 * MIN);
  const evs = [];
  for (let m = 1; m <= 20; m++) evs.push([m, PROGRESS]);
  for (let m = 20.5; m <= 70; m += 4.5) evs.push([m, THINKING]);
  replay(wd, clock, fires, evs);
  assert.equal(fires.length, 1, "a stall trickling thinking_tokens must still be killed");
  const f = fires[0];
  assert.equal(f.at, 25 * MIN, "killed at the window exactly as before");
  assert.equal(f.info.reason, "window");
  assert.equal(f.info.silentMs, 4.5 * MIN, "the last (thinking) event was 4.5 min old");
  assert.equal(f.info.sinceProgressMs, 5 * MIN);
  assert.equal(hangReasonClause(f.info), "", "window keeps the alert text unchanged");
});

test("(c) 2026-09-29 shape: total silence fires at 12 min with reason idle", () => {
  const { wd, clock, fires } = makeWatchdog();
  const item = { id: "c", source: "jori" };
  wd.arm(item);
  clock.advance(TURN_WATCHDOG_IDLE_MS - 1);
  assert.equal(fires.length, 0);
  clock.advance(1);
  assert.equal(fires.length, 1);
  const f = fires[0];
  assert.equal(f.item, item);
  assert.equal(f.ms, TURN_WATCHDOG_MS_DEFAULT, "2nd onFire arg is still the source window");
  assert.equal(f.info.reason, "idle");
  assert.equal(f.info.silentMs, 12 * MIN);
  assert.equal(f.info.elapsedMs, 12 * MIN);
  assert.equal(wd.armed, false);
  assert.equal(hangReasonClause(f.info), " (no activity for 12min)");
});

test("(c') silence from minute 3 fires at 15 with reason idle", () => {
  const { wd, clock, fires } = makeWatchdog();
  wd.arm({ id: "c2", source: "jori" });
  replay(wd, clock, fires, [[1, PROGRESS], [2, PROGRESS], [3, PROGRESS]]);
  clock.advanceTo(30 * MIN);
  assert.equal(fires.length, 1);
  assert.equal(fires[0].at, 15 * MIN);
  assert.equal(fires[0].info.reason, "idle");
});

test("(d) clear() cancels", () => {
  const { wd, clock, fires } = makeWatchdog();
  wd.arm({ id: "d", source: "jori" });
  clock.advance(5 * MIN);
  wd.touch(PROGRESS);
  wd.clear();
  assert.equal(wd.armed, false);
  assert.equal(clock.pending(), 0);
  clock.advance(10 * 60 * MIN);
  assert.equal(fires.length, 0);
});

test("(e) touch() with nothing armed is a no-op", () => {
  const { wd, clock, fires } = makeWatchdog();
  wd.touch(PROGRESS);
  wd.touch(true);
  wd.touch();
  assert.equal(wd.armed, false);
  assert.equal(clock.pending(), 0);
  // And after a fire, a straggler event from the dying child arms nothing.
  wd.arm({ id: "e", source: "jori" });
  clock.advance(TURN_WATCHDOG_IDLE_MS);
  assert.equal(fires.length, 1);
  wd.touch(PROGRESS);
  assert.equal(wd.armed, false);
  assert.equal(wd.lastActivityAt, null);
  clock.advance(10 * 60 * MIN);
  assert.equal(fires.length, 1);
});

test("touch() never reschedules: one timer per turn regardless of event volume", () => {
  let sets = 0;
  const clock = fakeClock();
  const wd = new TurnWatchdog({
    setTimer: (fn, ms) => { sets++; return clock.setTimer(fn, ms); },
    clearTimer: clock.clearTimer,
    now: clock.now,
  });
  wd.arm({ id: "v", source: "jori" });
  for (let i = 0; i < 5000; i++) wd.touch(i % 2 ? PROGRESS : THINKING);
  assert.equal(sets, 1);
  assert.equal(clock.pending(), 1);
});

test("touch() accepts a boolean isProgress", () => {
  const { wd, clock } = makeWatchdog();
  wd.arm({ id: "bool", source: "jori" });
  clock.advance(MIN);
  wd.touch(false);
  assert.equal(wd.lastActivityAt, MIN);
  assert.equal(wd.lastProgressAt, 0);
  clock.advance(MIN);
  wd.touch(true);
  assert.equal(wd.lastProgressAt, 2 * MIN);
});

test("(f) watchdogMsFor is unchanged", () => {
  assert.equal(watchdogMsFor("jori"), 20 * MIN);
  assert.equal(watchdogMsFor("gmail:msg-0001"), 20 * MIN);
  assert.equal(watchdogMsFor("cron-some-unknown-job"), 25 * MIN);
  assert.equal(watchdogMsFor("nightly-review", { thresholds: { "nightly-review": 55 * MIN } }), 55 * MIN);
  assert.equal(watchdogMsFor(undefined), 20 * MIN);
});

test("(g) a short explicit window with no progress fires at that window with reason window", () => {
  const { wd, clock, fires } = makeWatchdog({ thresholds: { "quick-job": 5 * MIN } });
  const ms = wd.arm({ id: "g", source: "quick-job" });
  assert.equal(ms, 5 * MIN);
  replay(wd, clock, fires, [[1, THINKING], [2, THINKING], [3, THINKING], [4, THINKING]]);
  clock.advanceTo(5 * MIN - 1);
  assert.equal(fires.length, 0);
  clock.advance(1);
  assert.equal(fires.length, 1);
  assert.equal(fires[0].at, 5 * MIN);
  assert.equal(fires[0].info.reason, "window");
});

test("legacy two-argument fire produces no reason clause", () => {
  assert.equal(hangReasonClause(undefined), "");
});

// The alert wording system-issue-review clusters on must survive; the reason
// clause is appended after it, never spliced in. And both supervisors must feed
// the watchdog the child event from their child-event handler.
test("supervisors keep the clustered alert wording and touch(ev) on child events", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const f of ["index.mjs", "chat-supervisor.mjs"]) {
    const src = fs.readFileSync(path.join(root, "agent/supervisor", f), "utf8");
    assert.ok(src.includes("with no result — killing + restarting to retry${why}."), `${f}: hang alert wording changed`);
    const handler = src.indexOf('this.session.on("event", (ev) => {');
    assert.ok(handler > 0, `${f}: child event handler not found`);
    const body = src.slice(handler, handler + 700);
    assert.ok(body.includes("this.turnWatchdog.touch(ev);"), `${f}: child event handler does not touch(ev) the watchdog`);
    assert.ok(src.includes("onFire: (item, ms, info) => this._onTurnHang(item, ms, info)"), `${f}: onFire drops the reason info`);
  }
});

test("isProgressEvent: a partial-message thinking_delta is a heartbeat too (chat runs with partials)", () => {
  const delta = (type) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type } } });
  assert.equal(isProgressEvent(delta("thinking_delta")), false);
  assert.equal(isProgressEvent(delta("text_delta")), true);
  assert.equal(isProgressEvent(delta("input_json_delta")), true);
  assert.equal(isProgressEvent({ type: "stream_event", event: { type: "message_start" } }), true);
  assert.equal(isProgressEvent(null), true);
});
