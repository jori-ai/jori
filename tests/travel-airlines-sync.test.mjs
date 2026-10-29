// travel-airlines-sync.test.mjs — airline codes in trip pages become airline
// links, and a configured service animal is marked on the flights it took
// (and only those: a per-leg opt-out wins over the trip-level flag).
//
// Run: node --test tests/travel-airlines-sync.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), "../bin/travel-airlines-sync");

function run(expr, config) {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "tas-"));
  if (config) {
    fs.mkdirSync(path.join(local, "config"));
    fs.writeFileSync(path.join(local, "config", "travel-wiki.json"), JSON.stringify(config));
  }
  const code = `const m = require(${JSON.stringify(BIN)}); console.log(JSON.stringify((${expr})(m)));`;
  return JSON.parse(execFileSync(process.execPath, ["-e", code], { env: { ...process.env, JORI_LOCAL_DIR: local }, encoding: "utf8" }));
}

const TRIP = [
  "- Title: Example trip",
  "- Shared with: [[user_pet_example|Biscuit]]",
  "### 2026-03-01",
  "- London (LHR) → Paris (CDG)",
  "- Flight Number AF 1234",
  "### 2026-03-05",
  "- Paris (CDG) → London (LHR)",
  "- Flight Number BA 305 (Biscuit did not fly)",
].join("\n");

const CONFIG = { service_animal: { name: "Biscuit", wiki_ids: ["user_pet_example"], page: "travel_pet_example" } };

test("a configured animal on the trip marks every leg but the opted-out one", () => {
  const out = run(`(m) => m.replaceFlightLinks(${JSON.stringify(TRIP)}, m.extractTripSummary(${JSON.stringify(TRIP)}).hasAnimal)`, CONFIG);
  assert.match(out, /Flight Number \[\[travel_airline_air_france_af\|Air France \(AF\)\]\] 🐕‍🦺 1234/);
  assert.match(out, /Flight Number \[\[travel_airline_british_airways_ba\|British Airways \(BA\)\]\] 305/);
  assert.doesNotMatch(out, /BA\)\]\] 🐕‍🦺/);
  const flights = run(`(m) => m.extractFlights(${JSON.stringify(TRIP)})`, CONFIG);
  assert.deepEqual(flights.map((f) => [f.code, f.animalOptOut, f.route]), [["AF", false, "London (LHR) → Paris (CDG)"], ["BA", true, "Paris (CDG) → London (LHR)"]]);
});

test("the airline page credits the animal by its configured page", () => {
  const page = run(`(m) => {
    const trip = { id: "travel_trip_2026-03-01_example", title: "Example trip", summary: m.extractTripSummary(${JSON.stringify(TRIP)}), flights: m.extractFlights(${JSON.stringify(TRIP)}) };
    return m.renderAirlinePage(m.buildAirlineRecords([trip]).find((r) => r.code === "AF"));
  }`, CONFIG);
  assert.match(page, /accepted \[\[user_pet_example\|Biscuit\]\] on 1 trip — see \[\[travel_pet_example\]\]/);
  assert.match(page, /service_dog_friendly: true/);
});

test("no config: nothing is marked (fresh install)", () => {
  const summary = run(`(m) => m.extractTripSummary(${JSON.stringify(TRIP)})`, null);
  assert.equal(summary.hasAnimal, false);
  const out = run(`(m) => m.replaceFlightLinks(${JSON.stringify(TRIP)}, false)`, null);
  assert.doesNotMatch(out, /🐕‍🦺/);
});
