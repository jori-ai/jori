// location-ask-timing.test.mjs — location questions reach the user while they
// can still answer them.
//
// The requirement: location questions arrive while the user is there or
// shortly after, not hours after the fact. The case: a 10:21–10:40 stop was
// asked about at 13:43, phrased as if the user were still there.
// Two fixes, both locked here:
//   (a) an age bound — late asks say they are late, too-old asks are not sent;
//   (b) a priority lane — a new ask wakes hum as a perishable `hum:moment`,
//       which the supervisor's dispatcher already puts ahead of cron work.
//
// Run: node --test tests/location-ask-timing.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ask-timing-test-"));
process.env.HOME = scratch;
fs.mkdirSync(path.join(scratch, "Dev/jori/data"), { recursive: true });

const q = await import("../lib/location-ask-queue.mjs");
const { askReadyEvent } = await import("../lib/location-enrich-compose.mjs");
const { normalizeEvent, buildPayload, evaluate, emptyState } = await import("../lib/hum-events.mjs");
const { isHighPriority, Dispatcher } = await import("../agent/supervisor/dispatcher.mjs");
const { handleChoiceReply, OTHER_VALUE } = await import("../lib/choice-reply.mjs");

const TZ = "Asia/Jerusalem";
// The 2026-10-03 stop: 10:21–10:40 IDT.
const STOP = { stop_started_at: "2026-10-03T07:21:45Z", stop_ended_at: "2026-10-03T07:40:03Z", message: "18m near Faruk BaShuk at 10:21 — a bite there?" };
const at = (iso) => Date.parse(iso);

test("an ask within 45 min of leaving is fresh and sent as composed", () => {
  const t = q.askTiming(STOP, { nowMs: at("2026-10-03T08:10:00Z"), tz: TZ });
  assert.equal(t.verdict, "fresh");
  assert.equal(q.timedMessage(STOP, t), STOP.message);
});

test("the 2026-10-03 ask (3h after) says it is looking back, with the time", () => {
  const t = q.askTiming(STOP, { nowMs: at("2026-10-03T10:43:24Z"), tz: TZ });
  assert.equal(t.verdict, "late");
  const msg = q.timedMessage(STOP, t);
  assert.ok(msg.startsWith("Looking back to this morning, around 10:21 — "), msg);
  assert.ok(msg.endsWith(STOP.message), "the composed words are kept");
});

test("past 4 hours, or on a later day, the ask is not sent", () => {
  assert.equal(q.askTiming(STOP, { nowMs: at("2026-10-03T11:45:00Z"), tz: TZ }).verdict, "drop");
  // An evening stop asked about next morning: dropped even though < 12h.
  const evening = { stop_started_at: "2026-10-04T19:00:00Z", stop_ended_at: "2026-10-04T19:40:00Z" };
  assert.equal(q.askTiming(evening, { nowMs: at("2026-10-04T21:10:00Z"), tz: TZ }).verdict, "drop");
});

test("legacy entries without a stop window fall back to composed_at", () => {
  const t = q.askTiming({ composed_at: "2026-10-03T08:00:00Z" }, { nowMs: at("2026-10-03T08:20:00Z"), tz: TZ });
  assert.equal(t.verdict, "fresh");
});

test("the queue keeps the stop window and reports whether a visit is queued", () => {
  try { fs.unlinkSync(q.QUEUE_PATH); } catch {}
  assert.equal(q.has("v1"), false);
  q.add({ visit_id: "v1", message: "x".repeat(30), stop_started_at: STOP.stop_started_at, stop_ended_at: STOP.stop_ended_at });
  assert.equal(q.has("v1"), true);
  assert.equal(q.peek().stop_ended_at, STOP.stop_ended_at);
});

test("a new ask wakes hum as a perishable hum:moment focused on location_context", () => {
  const raw = askReadyEvent({ visit_id: "6aec5c60", departed_local: "10:40" });
  const e = normalizeEvent(raw);
  assert.equal(e.type, "location.ask_ready");
  assert.equal(e.perishable, true);
  assert.deepEqual(e.lanes, ["location_context"]);
  assert.equal(e.data.visit_id, "6aec5c60");
  // The gate dispatches it at midday (outside quiet hours, nothing outstanding).
  const nowMs = Date.parse(e.ts) + 60_000;
  const verdict = evaluate({ events: [e], state: emptyState(), nowMs, gates: { local_hour: 13 } });
  assert.equal(verdict.decision, "dispatch", verdict.reason);
  const payload = buildPayload(verdict);
  assert.equal(payload.source, "hum:moment");
  assert.ok(isHighPriority(payload.source, "x"), "hum:* jumps the supervisor queue");
});

test("…and it is never dispatched during quiet hours", () => {
  const e = normalizeEvent(askReadyEvent({ visit_id: "v2" }));
  const verdict = evaluate({ events: [e], state: emptyState(), nowMs: Date.parse(e.ts) + 60_000, gates: { local_hour: 3 } });
  assert.notEqual(verdict.decision, "dispatch");
});

test("the dispatcher puts the hum:moment ahead of queued cron work, behind nothing else", () => {
  const session = { on() {}, send() { return true; } };
  const d = new Dispatcher(session);
  d.inFlight = { id: "busy", source: "cron", content: "running" };  // a turn is running
  d._drain = () => {};
  d.dispatch("marketing job", "cron-a");
  d.dispatch("another job", "cron-b");
  d.dispatch("hum turn", "hum:moment");
  assert.deepEqual(d.queue.map((i) => i.source), ["hum:moment", "cron-a", "cron-b"]);
});

test("a 'Somewhere else' tap is handed to the agent, never saved as a place", async () => {
  const prompt = { v: 1, kind: "location_stop", ref: "v1",
    options: [{ id: "o1", label: "Yes — the airbnb", value: "the airbnb" },
              { id: "o2", label: "No, somewhere else", value: OTHER_VALUE }] };
  const supabase = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { metadata: { choices: JSON.stringify(prompt) } } }) }) }) }) };
  const r = await handleChoiceReply(supabase, { reply_to: "p1", role: "user" }, "No, somewhere else");
  assert.equal(r.handled, false);
  // A prompt sent BEFORE the value existed (label only) is also handed over.
  prompt.options[1] = { id: "o2", label: "No, somewhere else" };
  const legacy = await handleChoiceReply(supabase, { reply_to: "p1", role: "user" }, "No, somewhere else");
  assert.equal(legacy.handled, false);
});

test("the enrich gate does not compose a stop too old to ask (no 15-min recompose loop)", async () => {
  const { decide } = await import("../lib/location-enrich-gate.mjs");
  const now = at("2026-10-03T12:00:00Z");   // 15:00 IDT
  const row = (id, departed) => ({ visit_id: id, asked: false, arrived_at: departed, departed_at: departed,
    ready_at: departed, candidates: [{ name: "Cafe A" }] });
  const r = decide({ pending: [row("old", "2026-10-03T07:40:00Z"), row("new", "2026-10-03T11:30:00Z")],
    queue: [], state: {}, now, tz: TZ });
  assert.deepEqual(r.askable, ["new"]);
});
