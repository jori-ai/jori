// hum-ideas-travel-premise.test.mjs — regression test for the ideas hum
// harvester's travel-location premise check.
//
// Root cause: an idea ("A guest checks into the apartment Jul 31 — you're in
// <City A> till Aug 6") was generated while City A was still on the itinerary.
// The City A leg was later swapped for an extended stay in City B, but nothing
// in the ideas harvester re-validated the cached "you're in City A" claim
// against the travel timeline the way premiseValid() re-checks calendar-cited
// premises and flightDateValid() re-checks flight dates. The stale idea
// re-dispatched its original wording across five ticks and eventually reached
// the user in chat still naming the wrong city, days after travel_segments was
// corrected.
//
// travelPremiseValid() closes that gap: any idea whose text asserts
// "you're in <City>" is checked against the live travel timeline via
// `travel in-city` before the idea is allowed to be nominated. Fail-open
// throughout — no claim, or a lookup failure, passes the idea through.
//
// The timeline is a fixed fixture (City B Jul 28 - Aug 6, 2026, plus an
// earlier City A stay so the gazetteer knows the city). Reading the live
// travel_segments timeline instead made the test fail once the trip aged out
// of `travel list`: with no segment covering Jul 31 the check fails open and
// the stale claim passes.
//
// Run: node --test tests/hum-ideas-travel-premise.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { travelPremiseValid as check } from "../agent/scripts/hum-harvesters/ideas.mjs";
import { buildGazetteer, presenceProvider, NO_PRESENCE } from "../lib/claim-facts.mjs";

// Resolving where the user was on a date is the installation's presence hook
// (lib/_ext/presence.mjs); the kernel ships none, and without one every claim
// passes (fail-open), so the contradiction case needs the hook.
const NO_HOOK = presenceProvider() === NO_PRESENCE ? "no presence provider installed (lib/_ext/presence.mjs)" : false;

const segments = [
  { metro: "northport", place_label: "Northport", arrive_at: "2026-06-01T12:00:00+00:00", depart_at: "2026-06-04T09:00:00+00:00", source: "manual" },
  { metro: "southvale", place_label: "Southvale", arrive_at: "2026-07-28T12:00:00+00:00", depart_at: "2026-08-06T09:00:00+00:00", source: "manual" },
];
const TIMELINE = { segments, flights: [], gazetteer: buildGazetteer(segments, []) };
const travelPremiseValid = (idea) => check(idea, TIMELINE);

function idea(overrides = {}) {
  return {
    id: "idea-test",
    created_at: "2026-07-20T18:02:23.000Z",
    subject: "A guest checks into the apartment Jul 31 — you're in Northport till Aug 6",
    rationale: "A guest checking into the apartment while you're overseas needs someone local for keys/access.",
    why_now: "Task confirms check-in Jul 31 3pm; your Northport stay runs through Aug 6.",
    time_sensitive_until: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

test("travelPremiseValid: rejects a stale city claim (Northport, swapped for Southvale)", { skip: NO_HOOK }, () => {
  assert.equal(travelPremiseValid(idea()), false);
});

test("travelPremiseValid: accepts the corrected city claim (Southvale)", () => {
  assert.equal(
    travelPremiseValid(idea({
      subject: "A guest checks into the apartment Jul 31 — you're in Southvale till Aug 6",
      why_now: "Task confirms check-in Jul 31 3pm; your Southvale stay runs through Aug 6.",
    })),
    true
  );
});

test("travelPremiseValid: fails open when the idea makes no location claim", () => {
  assert.equal(
    travelPremiseValid({
      subject: "Renew passport before the trip",
      rationale: "Expires within 6 months of travel.",
      why_now: "Trip departs soon.",
    }),
    true
  );
});

test("travelPremiseValid: fails open when presence at the claimed date is unresolvable", () => {
  // A date far outside the known travel timeline resolves metro=null,
  // unknown=true — nothing to contradict the claim, so don't block it.
  assert.equal(
    travelPremiseValid(idea({
      subject: "Package delivery — you're in Northport till Aug 6",
      why_now: "Delivery scheduled while away.",
      time_sensitive_until: "2020-01-01T00:00:00.000Z",
      created_at: "2020-01-01T00:00:00.000Z",
    })),
    true
  );
});
