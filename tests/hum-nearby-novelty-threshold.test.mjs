// hum-nearby-novelty-threshold.test.mjs — tell a NEW fact about a landmark from
// a RESTATED one, without silencing the landmark.
//
// The `nearby` lane keys its dedup_key on a standing SUBJECT, so every fact about
// one place shares a key. That makes exit-8's time window the wrong instrument:
// it cannot see whether the second mention says anything new. One clock tower
// shipped three times (the user: "This is a repeat.") and widening the window
// to 168h was measured to suppress two sends the user had reacted "more" to.
//
// Exit-9 novelty can see it. The sims logged on five such sends, with the user's
// tapbacks, are the fixture below: the only send ignored is the only one above
// 0.90, and it missed the global 0.93 threshold by 0.025.
//
// Run: node --test tests/hum-nearby-novelty-threshold.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { THRESHOLD, THRESHOLD_BY_LANE, thresholdFor } from "../lib/hum-novelty.mjs";

// Rows shaped like data/hum-feedback.jsonl (synthetic subjects, logged sims).
const SENDS = [
  { at: "2026-10-02T08:38", key: "nearby:old-clock-tower", sim: 0.6446, reaction: "more" },
  { at: "2026-10-02T15:14", key: "nearby:harbour-street", sim: 0.6366, reaction: null },
  { at: "2026-10-03T08:58", key: "nearby:old-clock-tower", sim: 0.9047, reaction: null },
  { at: "2026-10-04T06:34", key: "nearby:harbour-street", sim: 0.8181, reaction: "more" },
  { at: "2026-10-04T16:13", key: "nearby:old-clock-tower", sim: 0.8597, reaction: "more" },
];
const blocked = (s, lane) => s.sim >= thresholdFor(lane);

test("nearby is tuned to 0.90; every other lane keeps the global default", () => {
  assert.equal(thresholdFor("nearby"), 0.90);
  assert.equal(thresholdFor("NEARBY"), 0.90, "lane match is case-insensitive");
  assert.equal(thresholdFor("dining"), THRESHOLD);
  assert.equal(thresholdFor(undefined), THRESHOLD);
  assert.equal(THRESHOLD_BY_LANE.nearby, 0.90);
});

test("it blocks the repeat and keeps everything the user reacted to", () => {
  const stopped = SENDS.filter((s) => blocked(s, "nearby"));
  assert.deepEqual(stopped.map((s) => s.at), ["2026-10-03T08:58"],
    "exactly the one send that was ignored");
  for (const s of SENDS.filter((s) => s.reaction)) {
    assert.ok(!blocked(s, "nearby"),
      `${s.at} ${s.key} carried reaction "${s.reaction}" and must still ship`);
  }
});

test("the old global threshold caught none of them — that is the bug", () => {
  assert.equal(SENDS.filter((s) => s.sim >= THRESHOLD).length, 0);
  assert.ok(0.9047 < THRESHOLD, "the repeat missed the global threshold by 0.025");
});

test("precedence is specific-beats-general", () => {
  const prev = { ...process.env };
  try {
    // A global tightening must NOT loosen a deliberately-tuned lane.
    process.env.HUM_NOVELTY_THRESHOLD = "0.80";
    assert.equal(thresholdFor("nearby"), 0.90, "the lane table outranks the global env");
    assert.equal(thresholdFor("dining"), 0.80, "an untuned lane follows the global env");
    // A per-lane env outranks everything.
    process.env.HUM_NOVELTY_THRESHOLD_NEARBY = "0.95";
    assert.equal(thresholdFor("nearby"), 0.95);
  } finally {
    for (const k of ["HUM_NOVELTY_THRESHOLD", "HUM_NOVELTY_THRESHOLD_NEARBY"]) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test("a junk override falls through instead of producing NaN", () => {
  const prev = { ...process.env };
  try {
    process.env.HUM_NOVELTY_THRESHOLD_NEARBY = "not-a-number";
    assert.equal(thresholdFor("nearby"), 0.90, "NaN must not become the threshold");
    process.env.HUM_NOVELTY_THRESHOLD = "also-junk";
    assert.equal(thresholdFor("dining"), 0.93, "nor for an untuned lane");
    // An EMPTY value is the dangerous one: Number("") is 0 and isFinite(0) is
    // true, so a bare `HUM_NOVELTY_THRESHOLD=` would make every candidate a
    // duplicate and silence hum on every lane, without throwing.
    delete process.env.HUM_NOVELTY_THRESHOLD_NEARBY;
    process.env.HUM_NOVELTY_THRESHOLD = "";
    assert.equal(thresholdFor("dining"), 0.93, "an empty global must not become 0");
    assert.equal(thresholdFor("nearby"), 0.90, "nor override a tuned lane");
    process.env.HUM_NOVELTY_THRESHOLD_NEARBY = "";
    assert.equal(thresholdFor("nearby"), 0.90, "an empty per-lane value must not become 0");
    process.env.HUM_NOVELTY_THRESHOLD_NEARBY = "0";
    assert.equal(thresholdFor("nearby"), 0.90, "an explicit 0 is refused — it would silence the lane");
  } finally {
    for (const k of ["HUM_NOVELTY_THRESHOLD", "HUM_NOVELTY_THRESHOLD_NEARBY"]) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test("a lane id with a hyphen maps to a legal env var name", () => {
  const prev = { ...process.env };
  try {
    process.env.HUM_NOVELTY_THRESHOLD_EVENT_PREP = "0.5";
    assert.equal(thresholdFor("event-prep"), 0.5,
      "hyphenated lanes really appear in the feedback log; their override must be reachable");
  } finally {
    delete process.env.HUM_NOVELTY_THRESHOLD_EVENT_PREP;
    Object.assign(process.env, prev);
  }
});
