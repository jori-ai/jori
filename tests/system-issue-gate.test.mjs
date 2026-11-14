// Tests for the same-day critical-escalation gate.
//
// Fixtures are shaped like real system-channel alerts, because the bug this
// gate prevents is a duplicate-volume bug that only shows up against real
// repeat text: in a sampled two-week window, about half of all 🔴 alerts were
// one "auth is DOWN" condition re-firing, and a second condition repeated
// several more times.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCritical,
  isBeingWorked,
  matchesCluster,
  signature,
  selectCriticalEscalations,
  pruneDispatched,
  mergeGateHeldAlerts,
} from "../lib/system-issue-gate.mjs";

const MAXAUTH = (d) => ({
  role: "assistant",
  created_at: d,
  content:
    "🔴 Max auth is DOWN — a supervisor is logging 'Not logged in' and the keychain self-heal did not clear it. The whole Jori backend (email triage, hum, watchers) is offline until it clears.",
});
const EPISODE = (d, day) => ({
  role: "assistant",
  created_at: d,
  content: `🔴 Episode-archive missing for ${day} — the 02:00 cron didn't produce a day_${day} wiki page and a watchdog-backfill is required.`,
});
const WARN = (d) => ({
  role: "assistant",
  created_at: d,
  content: "⚠️ unstar-scan: Gmail fetch failed (3 attempts) — retrying next sweep.",
});
const RECOVERY = (d) => ({ role: "assistant", created_at: d, content: "✅ Recovered: Max auth restored." });

test("isCritical keys on the 🔴 marker only", () => {
  assert.equal(isCritical(MAXAUTH("2026-07-24T00:00:00Z").content), true);
  assert.equal(isCritical(WARN("2026-07-24T00:00:00Z").content), false);
  assert.equal(isCritical(RECOVERY("2026-07-24T00:00:00Z").content), false);
  assert.equal(isCritical(null), false);
});

test("signature collapses the 17 near-identical Max-auth firings to one identity", () => {
  const sigs = new Set(
    ["2026-07-23T22:30:00Z", "2026-07-24T00:48:00Z", "2026-07-24T06:50:00Z"].map((d) => signature(MAXAUTH(d).content)),
  );
  assert.equal(sigs.size, 1, "same condition must share one signature");
});

test("signature separates genuinely different conditions", () => {
  assert.notEqual(
    signature(MAXAUTH("2026-07-24T00:00:00Z").content),
    signature(EPISODE("2026-07-24T08:22:00Z", "2026-07-23").content),
  );
});

test("signature ignores the varying date inside otherwise-identical alerts", () => {
  assert.equal(
    signature(EPISODE("2026-07-15T08:22:00Z", "2026-07-14").content),
    signature(EPISODE("2026-07-20T08:22:00Z", "2026-07-19").content),
  );
});

test("a brand-new critical alert escalates", () => {
  const { escalate } = selectCriticalEscalations({
    rows: [MAXAUTH("2026-07-24T00:00:00Z")],
    cursor: "2026-07-23T00:00:00Z",
    clusters: [],
  });
  assert.equal(escalate.length, 1);
});

test("THE REGRESSION GUARD: a burst of the same condition escalates exactly once", () => {
  const rows = [
    "2026-07-23T22:30:00Z", "2026-07-23T23:00:00Z", "2026-07-24T00:00:00Z", "2026-07-24T00:48:00Z",
    "2026-07-24T04:46:00Z", "2026-07-24T05:30:00Z", "2026-07-24T06:00:00Z", "2026-07-24T06:30:00Z",
    "2026-07-24T06:50:00Z", "2026-07-24T07:00:00Z",
  ].map(MAXAUTH);
  const { escalate, suppressed } = selectCriticalEscalations({
    rows,
    cursor: "2026-07-23T00:00:00Z",
    clusters: [],
    max: 1,
  });
  assert.equal(escalate.length, 1, "10 firings of one condition must yield 1 dispatch, not 10");
  assert.equal(suppressed.already_dispatched, 9);
});

test("an alert matching a cluster already awaiting Face-ID approval does not escalate", () => {
  // A real auth-flap cluster sat in exactly this state.
  const clusters = [{ id: "sic-max-auth-flap", status: "awaiting_approval", match_patterns: ["max auth is down"] }];
  const { escalate, suppressed } = selectCriticalEscalations({
    rows: [MAXAUTH("2026-07-24T09:00:00Z")],
    cursor: "2026-07-24T00:00:00Z",
    clusters,
  });
  assert.equal(escalate.length, 0);
  assert.equal(suppressed.being_worked, 1);
});

test("an open cluster nobody has attempted yet still escalates", () => {
  const clusters = [{ id: "sic-x", status: "open", attempts: [], match_patterns: ["max auth is down"] }];
  const { escalate } = selectCriticalEscalations({
    rows: [MAXAUTH("2026-07-24T09:00:00Z")],
    cursor: "2026-07-24T00:00:00Z",
    clusters,
  });
  assert.equal(escalate.length, 1, "open + zero attempts means nobody has looked — same-day review is the point");
});

test("an open cluster with a prior attempt is treated as in flight", () => {
  const clusters = [{ id: "sic-x", status: "open", attempts: [{ commit: "abc1234" }], match_patterns: ["max auth is down"] }];
  const { escalate, suppressed } = selectCriticalEscalations({
    rows: [MAXAUTH("2026-07-24T09:00:00Z")],
    cursor: "2026-07-24T00:00:00Z",
    clusters,
  });
  assert.equal(escalate.length, 0);
  assert.equal(suppressed.being_worked, 1);
});

test("warnings and recoveries never escalate same-day", () => {
  const { escalate, suppressed } = selectCriticalEscalations({
    rows: [WARN("2026-07-24T01:00:00Z"), RECOVERY("2026-07-24T02:00:00Z")],
    cursor: "2026-07-24T00:00:00Z",
    clusters: [],
  });
  assert.equal(escalate.length, 0);
  assert.equal(suppressed.not_critical, 2);
});

test("alerts at or before the cursor are not fresh", () => {
  const { escalate, suppressed } = selectCriticalEscalations({
    rows: [MAXAUTH("2026-07-23T00:00:00Z")],
    cursor: "2026-07-24T00:00:00Z",
    clusters: [],
  });
  assert.equal(escalate.length, 0);
  assert.equal(suppressed.not_fresh, 1);
});

test("a signature dispatched inside the dedup window is suppressed, and re-escalates after it", () => {
  const row = MAXAUTH("2026-07-24T12:00:00Z");
  const dispatched = { [signature(row.content)]: "2026-07-24T06:00:00Z" };
  const now = Date.parse("2026-07-24T12:00:00Z");

  const inside = selectCriticalEscalations({ rows: [row], cursor: "2026-07-24T00:00:00Z", clusters: [], dispatched, now });
  assert.equal(inside.escalate.length, 0);
  assert.equal(inside.suppressed.already_dispatched, 1);

  const outside = selectCriticalEscalations({
    rows: [row], cursor: "2026-07-24T00:00:00Z", clusters: [], dispatched,
    now: Date.parse("2026-07-25T07:00:00Z"),
  });
  assert.equal(outside.escalate.length, 1, "a condition still firing a day later deserves another look");
});

test("user rows in the system channel are never escalated", () => {
  const { escalate } = selectCriticalEscalations({
    rows: [{ role: "user", created_at: "2026-07-24T09:00:00Z", content: "🔴 review these please" }],
    cursor: "2026-07-24T00:00:00Z",
    clusters: [],
  });
  assert.equal(escalate.length, 0, "the operator typing in-channel is a priority signal, not an alert");
});

test("a malformed match_pattern falls back to substring instead of throwing", () => {
  const clusters = [{ id: "bad", status: "verifying", match_patterns: ["max auth ("] }];
  assert.doesNotThrow(() =>
    selectCriticalEscalations({ rows: [MAXAUTH("2026-07-24T09:00:00Z")], cursor: "2026-07-24T00:00:00Z", clusters }),
  );
  assert.equal(matchesCluster("Max auth ( is weird", { match_patterns: ["max auth ("] }), true);
});

test("isBeingWorked handles junk input", () => {
  for (const junk of [null, undefined, 42, "open", {}]) assert.equal(isBeingWorked(junk), false);
});

test("pruneDispatched drops stale entries and keeps recent ones", () => {
  const now = Date.parse("2026-07-25T00:00:00Z");
  const out = pruneDispatched({ old: "2026-07-01T00:00:00Z", recent: "2026-07-24T00:00:00Z", junk: "nope" }, now);
  assert.deepEqual(Object.keys(out), ["recent"]);
});

// The speak gate never inserts a system message it holds (drop / digest /
// resolve); the jori_gate_reviews row is the only record. The review reads the
// channel, so without this join the alerts the gate calls "plumbing" (a
// gate-blind page, a low-disk page, a failed job) never reach it.
const HELD = (id, at, original, verdict = "drop") => ({ id, judged_at: at, original, verdict });

test("mergeGateHeldAlerts folds held system alerts into the batch in time order", () => {
  const rows = [
    { id: "a", role: "assistant", content: "\u26a0\ufe0f Mac mini disk space low: 24.6 GiB free", created_at: "2026-11-13T10:00:00+00:00" },
    { id: "b", role: "assistant", content: "\u2705 later row", created_at: "2026-11-13T20:00:00+00:00" },
  ];
  const held = [HELD("g1", "2026-11-13T18:44:23.276+00:00", "\ud83d\udfe0 Truth gate partly blind: the claim-freshness extractor failed 11 of the last 50 checks")];
  const out = mergeGateHeldAlerts(rows, held, "2026-11-10T00:00:00Z");
  assert.deepEqual(out.map((r) => r.id), ["a", "gate-held:g1", "b"]);
  const h = out[1];
  assert.equal(h.role, "assistant");
  assert.equal(h.content, held[0].original, "text stays verbatim so cluster patterns and the severity marker still match");
  assert.equal(h.held_by, "speak-gate");
  assert.equal(h.held_verdict, "drop");
  assert.equal(matchesCluster(h.content, { match_patterns: ["truth gate partly blind"] }), true);
});

test("mergeGateHeldAlerts skips old, empty and malformed held rows and never throws", () => {
  const rows = [{ id: "a", role: "assistant", content: "x", created_at: "2026-11-13T10:00:00Z" }];
  const held = [
    HELD("old", "2026-10-01T00:00:00Z", "\ud83d\udfe0 too old"),
    HELD("empty", "2026-11-13T11:00:00Z", "   "),
    { id: "nodate", original: "\ud83d\udfe0 no timestamp" },
    { id: "notext", judged_at: "2026-11-13T11:00:00Z", original: null },
    null,
    42,
  ];
  assert.deepEqual(mergeGateHeldAlerts(rows, held, "2026-11-10T00:00:00Z"), rows);
  assert.deepEqual(mergeGateHeldAlerts(rows, undefined, "2026-11-10T00:00:00Z"), rows);
  assert.deepEqual(mergeGateHeldAlerts(rows, [], "2026-11-10T00:00:00Z"), rows);
  assert.deepEqual(mergeGateHeldAlerts(null, null, "2026-11-10T00:00:00Z"), []);
});

test("a held alert that repeats one already delivered within 30 minutes is not counted twice", () => {
  const LOCK = "\ud83d\udd10 Lock problem, before anyone needs the door\n- Rental unit \u00b7 Back door: the gateway can't reach the lock";
  const rows = [{ id: "a", role: "assistant", content: LOCK, created_at: "2026-11-12T04:43:27Z" }];
  const held = [
    HELD("twin", "2026-11-12T04:45:30Z", LOCK, "digest"),
    HELD("later", "2026-11-12T16:47:20Z", LOCK, "drop"),
  ];
  const out = mergeGateHeldAlerts(rows, held, "2026-11-10T00:00:00Z");
  assert.deepEqual(out.map((r) => r.id), ["a", "gate-held:later"], "same text hours later is a new occurrence; minutes later is the same one");
});

test("a held critical alert reaches the same-day escalation like a delivered one", () => {
  const held = [HELD("g2", "2026-11-13T09:48:55Z", "\ud83d\udd34 Max auth is DOWN on ops-light. Captured error: nothing usable")];
  const rows = mergeGateHeldAlerts([], held, "2026-11-10T00:00:00Z");
  const { escalate } = selectCriticalEscalations({ rows, cursor: "2026-11-13T00:00:00Z", clusters: [] });
  assert.equal(escalate.length, 1);
});
