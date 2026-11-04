// lib/broker-token-clock.js — the snapshot's evidence that a sign-in window
// has actually run out.
//
// The case it exists for: the token watch runs in the morning and sees
// "expiring, 0.1 days left"; the window lapses a couple of hours later; the
// after-close snapshot then comes back empty. Read flat, 0.1 days says "not
// lapsed" and the alert reassures the user there is nothing to do. Projected
// forward from observedAt, it is lapsed. The rest pin the other half of the
// contract: stay SILENT on anything unprovable, because a wrong "go re-link"
// sends the user to a browser for nothing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { lapsedTokenSlots } = require("../lib/broker-token-clock.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-clock-"));
const STATE = path.join(dir, "token-watch-state.json");
const opts = { stateFile: STATE };
const write = (o) => fs.writeFileSync(STATE, JSON.stringify(o));

// The after-close snapshot, ~8h after the morning watch observation.
const NOW = Date.parse("2026-01-13T20:45:00.900Z");
const observed = "2026-01-13T12:39:02.000Z";

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("a window that ran out between watch runs is caught", () => {
  write({ tokens: {
    primary: { state: "expiring", daysRemaining: 0.1, observedAt: observed },
    secondary: { state: "expiring", daysRemaining: 0.1, observedAt: observed },
  } });
  const lapsed = lapsedTokenSlots(NOW, opts);
  assert.equal(lapsed.length, 2, "both slots lapsed before the snapshot ran");
  assert.equal(lapsed[0].tokenId, "primary");
  // Hours before the snapshot — the point of projecting from observedAt.
  assert.ok(Date.parse(lapsed[0].since) < NOW);
});

test("an explicit expired state needs no projection", () => {
  write({ tokens: { primary: { state: "expired", observedAt: observed } } });
  assert.equal(lapsedTokenSlots(NOW, opts).length, 1);
});

test("silent while the window is genuinely still open", () => {
  write({ tokens: { primary: { state: "ok", daysRemaining: 5, observedAt: observed } } });
  assert.equal(lapsedTokenSlots(NOW, opts).length, 0);
  write({ tokens: { primary: { state: "expiring", daysRemaining: 2, observedAt: observed } } });
  assert.equal(lapsedTokenSlots(NOW, opts).length, 0, "expiring is a warning, not a lapse");
});

test("silent on anything unprovable — never guess the user into a browser", () => {
  const unprovable = [
    { tokens: { primary: { state: "unknown", daysRemaining: null, observedAt: observed } } },
    { tokens: { primary: { state: "expiring", daysRemaining: null, observedAt: observed } } },
    { tokens: { primary: { state: "expiring", daysRemaining: 0.1, observedAt: "not-a-date" } } },
    { tokens: { primary: { fingerprint: "abc", notified: {} } } }, // state file from before observations
    { tokens: "nope" },
    {},
  ];
  for (const state of unprovable) {
    write(state);
    assert.equal(lapsedTokenSlots(NOW, opts).length, 0, JSON.stringify(state));
  }
  fs.rmSync(STATE, { force: true });
  assert.equal(lapsedTokenSlots(NOW, opts).length, 0, "missing state file");
});
