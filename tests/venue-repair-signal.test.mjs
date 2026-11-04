// venue-repair-signal.test.mjs — the venue-ingest signal that feeds the
// same-day skill-repair queue (lib/venue-events/store.mjs `repairSignal`): a
// source that produced real events and now returns none ("went_quiet"), or a
// parser throw ("parse_failed"), is a break; transport errors, thin sources,
// never-produced sources and an empty ticketing feed are not. The queue's
// admission rules are in skill-repair.test.mjs. Synthetic source keys.
// Run: node --test tests/venue-repair-signal.test.mjs

import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { repairSignal } from "../lib/venue-events/store.mjs";

test("venue-ingest signal: first empty run after a real one, or a non-transport throw", () => {
  const cdp = { kind: "cdp", key: "riverside-club" };
  assert.deepEqual(repairSignal(cdp, 139, { events: [], error: null }).error, "went_quiet");
  assert.equal(repairSignal(cdp, 2, { events: [], error: null }), null, "a thin source going empty is not a break");
  assert.equal(repairSignal(cdp, null, { events: [], error: null }), null, "never produced");
  assert.equal(repairSignal(cdp, 139, { events: [{}], error: null }), null);
  assert.equal(repairSignal(cdp, 139, { events: [], error: "runtime_exception" }).error, "parse_failed");
  for (const e of ["HTTP 403", "fetch failed", "request timed out after 25s", "ECONNRESET", "eval_timeout"]) {
    assert.equal(repairSignal(cdp, 139, { events: [], error: e }), null, e);
  }
  assert.equal(repairSignal({ kind: "tm", key: "tm-harbour-arena" }, 80, { events: [], error: null }), null, "TM empty = nothing listed");
});
