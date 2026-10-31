// spa-weather + spa-weather-backfill: the spa's location comes from config
// (none = off), the archive call asks for the spa's zone and epoch hours, the
// nearest hour is picked, and the backfill groups sessions by the spa's local
// date, patches what it can and defers what the archive has not got yet.
// Synthetic location and stubs only — no network, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { spaLocation, fetchHourlyWeather, nearestHour } = require("../lib/spa-weather.js");
const { runWeatherBackfill, localDateISO } = require("../lib/spa-weather-backfill.js");

const LOC = { lat: 10.5, lon: -20.25, tz: "Pacific/Honolulu" };

test("spaLocation: null without coordinates, the installation zone by default", () => {
  assert.equal(spaLocation({ lat: null, lon: null, tz: "" }), null);
  assert.equal(spaLocation({ lat: "x", lon: 1 }), null);
  const loc = spaLocation({ lat: 10.5, lon: -20.25, tz: "" });
  assert.equal(loc.lat, 10.5);
  assert.equal(typeof loc.tz, "string");
  assert.ok(loc.tz.length > 0);
  assert.equal(spaLocation({ lat: 1, lon: 2, tz: "Europe/Paris" }).tz, "Europe/Paris");
});

test("fetchHourlyWeather: no location → null without calling out", async () => {
  let called = false;
  const r = await fetchHourlyWeather("2026-01-02", { location: null, fetchImpl: async () => { called = true; } });
  assert.equal(r, null);
  assert.equal(called, false);
});

test("fetchHourlyWeather: asks for the spa's zone and epoch hours, parses them", async () => {
  let url = null;
  const t0 = Date.UTC(2026, 0, 2, 6, 0) / 1000;
  const fetchImpl = async (u) => {
    url = new URL(u);
    return { ok: true, json: async () => ({ hourly: { time: [t0, t0 + 3600], temperature_2m: [70, 72], precipitation: [0, 0.1], wind_speed_10m: [5, 7] } }) };
  };
  const h = await fetchHourlyWeather("2026-01-02", { location: LOC, fetchImpl });
  assert.equal(url.searchParams.get("timezone"), "Pacific/Honolulu");
  assert.equal(url.searchParams.get("timeformat"), "unixtime");
  assert.equal(url.searchParams.get("latitude"), "10.5");
  assert.equal(h.times[0].toISOString(), "2026-01-02T06:00:00.000Z");
  assert.deepEqual(h.tempF, [70, 72]);
});

test("fetchHourlyWeather: an HTTP error or a throw is null", async () => {
  assert.equal(await fetchHourlyWeather("2026-01-02", { location: LOC, fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await fetchHourlyWeather("2026-01-02", { location: LOC, fetchImpl: async () => { throw new Error("down"); } }), null);
});

test("nearestHour picks the closest reading", () => {
  const hourly = { times: [new Date("2026-01-02T06:00:00Z"), new Date("2026-01-02T07:00:00Z")], tempF: [70, 72], precipIn: [0, null], windMph: [5, 7] };
  assert.deepEqual(nearestHour(hourly, new Date("2026-01-02T06:40:00Z")), { tempF: 72, precipIn: null, windMph: 7 });
  assert.equal(nearestHour(null, new Date()), null);
});

test("localDateISO cuts the day in the given zone", () => {
  // 03:00 UTC is still the previous afternoon in Honolulu.
  assert.equal(localDateISO(new Date("2026-01-03T03:00:00Z"), "Pacific/Honolulu"), "2026-01-02");
  assert.equal(localDateISO(new Date("2026-01-03T03:00:00Z"), "UTC"), "2026-01-03");
});

test("runWeatherBackfill: off without a location, reads nothing", async () => {
  let read = false;
  const r = await runWeatherBackfill({ deps: { location: null, fetchJson: async () => { read = true; return []; } } });
  assert.equal(r.ok, true);
  assert.equal(r.pending, 0);
  assert.ok(r.off);
  assert.equal(read, false);
});

test("runWeatherBackfill: one archive call per local date; fills and defers", async () => {
  const sessions = [
    { session_id: "a", started_at: "2026-01-03T01:00:00Z" }, // Jan 2 in Honolulu
    { session_id: "b", started_at: "2026-01-02T20:00:00Z" }, // Jan 2
    { session_id: "c", started_at: "2026-01-09T15:00:00Z" }, // Jan 9: too recent
  ];
  const asked = [], patched = [];
  const deps = {
    location: LOC,
    fetchJson: async () => sessions,
    request: async (p, opts) => { patched.push({ p, body: opts.body }); },
    fetchHourlyWeather: async (date) => {
      asked.push(date);
      if (date !== "2026-01-02") return null;
      return { times: [new Date("2026-01-02T20:00:00Z"), new Date("2026-01-03T01:00:00Z")], tempF: [61, 58], precipIn: [0, 0], windMph: [3, 4] };
    },
  };
  const r = await runWeatherBackfill({ deps });
  assert.deepEqual(asked.sort(), ["2026-01-02", "2026-01-09"]);
  assert.deepEqual({ pending: r.pending, filled: r.filled, deferred: r.deferred }, { pending: 3, filled: 2, deferred: 1 });
  assert.equal(patched.length, 2);
  const a = patched.find((x) => x.p.includes("eq.a"));
  assert.equal(a.body.weather_air_temp_f, 58);
  assert.equal(a.body.weather_source, "open-meteo");

  patched.length = 0;
  const dry = await runWeatherBackfill({ dryRun: true, deps });
  assert.equal(dry.filled, 2);
  assert.equal(patched.length, 0);
});
