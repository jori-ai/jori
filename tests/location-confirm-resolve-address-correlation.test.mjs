// location-confirm-resolve-address-correlation.test.mjs — the comedy-show
// incident (the user, replying to that day's daily summary: "We were at the
// comedy show from 7:10 to 9:15pm or so. The other 'stops' are incorrect.").
//
// Root cause: localResolve()'s tier 2b ("calendar-title fallback") treats an
// event's location/description as correlating with a GPS candidate's address
// whenever they share ANY token >=4 chars not in ADDR_STOP. The city's name
// is >=4 chars and every address in the city contains it, so tier 2b
// degenerated to "any dwell in the city that overlaps the event's time window"
// with zero distance evidence. The show's calendar event auto-confirmed FOUR
// unrelated GPS-noise dwells that evening purely on the city token: one near a
// hospital, one at a doctor's office half a mile off, and one 1.3km away near
// home on the walk back — none of which share anything about the venue
// itself. That fragmented the evening into "four stops" instead of the one
// real, continuous 91-minute visit.
//
// Fix: the installation's metro names and aliases (travel.json) join
// ADDR_STOP, so a shared city/borough token no longer counts as "the same
// place." A genuine street-level match (shared building number, shared street
// name) still correlates. A synthetic city ("Sampleton") and installation.
//
// Run: node --test tests/location-confirm-resolve-address-correlation.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "bin/location-confirm-resolve.mjs");

// A synthetic installation: one metro whose alias is the city in every address
// below, and an empty install root (no confirmed stops, no keys).
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "lc-resolve-addr-"));
fs.mkdirSync(path.join(SANDBOX, "local", "config"), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, "home", "data"), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, "local", "config", "travel.json"),
  JSON.stringify({ metros: [{ key: "sampleton", aliases: ["sampleton", "eastside"] }] }));
const ENV = { ...process.env, JORI_LOCAL_DIR: path.join(SANDBOX, "local"), JORI_HOME: path.join(SANDBOX, "home"),
  JEV_QUESTIONS_DIR: path.join(ROOT, "agent/config/jev-questions"), TYPESAFE_API_KEY: "" };

const EVENT = {
  summary: "Comedy Night: Three Example Comics",
  location: "Sampleton Comedy Club, 241 Example Street, Sampleton, ZZ",
  description: "",
  start: "2026-09-14T19:00:00-04:00",
  end: "2026-09-14T21:30:00-04:00",
};

function resolve(payload) {
  const res = spawnSync(process.execPath, [SCRIPT, "--resolve-only"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: ENV,
    timeout: 20000,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

test("a dwell 1.3km away near home no longer auto-confirms off the shared city token", () => {
  // The worst of the four: centroid near home, ~1.3km from the actual club.
  const out = resolve({
    centroid: { lat: 12.3456, lon: -65.4321 },
    candidates: [
      { name: "Example Vegan Bistro", address: "199 Oak Avenue, Sampleton", source: "osm_overpass" },
      { name: "el ejemplo", address: "200 Oak Avenue", source: "osm_overpass" },
      { name: "Example Pizza", address: "211 Oak Avenue, Sampleton", source: "osm_overpass" },
    ],
    calendarEvents: [EVENT],
    messages: [],
    // 21:20:55-21:50:01, the ask's real dwell window that night.
    dwellWindow: { startMs: Date.parse(EVENT.end) - 9 * 60 * 1000, endMs: Date.parse(EVENT.end) + 20 * 60 * 1000 },
  });
  assert.equal(out.decision, "ask", "no real correlation to the venue -- must not auto-confirm");
  assert.notEqual(out.source, "local:calendar_title");
});

test("a dwell near a hospital, half a mile off, no longer auto-confirms either", () => {
  const out = resolve({
    centroid: { lat: 12.3333, lon: -65.4444 },
    candidates: [
      { name: "Sampleton General Hospital (Eastside)", address: "462 Elm Avenue, Eastside, Sampleton, Sampleton", source: "reverse_geocode" },
      { name: "General South Lot", address: "458 Shore Dr, Sampleton, ZZ 10010, USA", source: "google_places" },
    ],
    calendarEvents: [EVENT],
    messages: [],
    dwellWindow: { startMs: Date.parse(EVENT.start) - 23 * 60 * 1000, endMs: Date.parse(EVENT.start) },
  });
  assert.equal(out.decision, "ask");
  assert.notEqual(out.source, "local:calendar_title");
});

test("a candidate actually on the venue's block still correlates and auto-confirms", () => {
  // 300-302 Example Street, a few doors from the club's 241 Example Street --
  // shares a real street-level token ("example"), not just the city name.
  const out = resolve({
    centroid: { lat: 12.3444, lon: -65.4444 },
    candidates: [
      { name: "300-302 Example St", address: "300-302 Example Street, Sampleton, ZZ", source: "reverse_geocode" },
    ],
    calendarEvents: [EVENT],
    messages: [],
    dwellWindow: { startMs: Date.parse(EVENT.start) + 10 * 60 * 1000, endMs: Date.parse(EVENT.start) + 90 * 60 * 1000 },
  });
  assert.equal(out.decision, "auto_confirm");
  assert.equal(out.source, "local:calendar_title");
  assert.equal(out.venue, EVENT.summary);
});

test("no shared street token and no time overlap still just asks", () => {
  const out = resolve({
    centroid: { lat: 12.3333, lon: -65.4111 },
    candidates: [
      { name: "Some Random Deli", address: "50 Main St, Sampleton, ZZ", source: "osm_overpass" },
    ],
    calendarEvents: [EVENT],
    messages: [],
    dwellWindow: { startMs: Date.parse(EVENT.end) + 2 * 3600 * 1000, endMs: Date.parse(EVENT.end) + 3 * 3600 * 1000 },
  });
  assert.equal(out.decision, "ask");
});
