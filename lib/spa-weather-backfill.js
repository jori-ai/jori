"use strict";
// spa-weather-backfill (lib) — fills spa_heating_sessions.weather_* for
// sessions the on-site sensor didn't capture ambient temp for. Shared by
// bin/spa-weather-backfill (standalone catch-up) and spa-heating-sync
// (so every daily sync backfills its own new sessions automatically).
//
// One archive-api call per distinct calendar date, not per session — Open-
// Meteo's archive endpoint returns a full day of hourly data per request.

const { fetchJson, request } = require("./supabase-rest.js");
const { fetchHourlyWeather, nearestHour, spaLocation } = require("./spa-weather.js");

// Session's own local calendar date in the spa's zone — the archive API's
// `timezone` param returns hourly buckets in that same zone.
function localDateISO(d, tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d); // en-CA formats as YYYY-MM-DD
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @param {object} [opts.deps]  injected for tests: { location, fetchJson, request, fetchHourlyWeather }
 * @returns {Promise<{ok: true, pending: number, filled: number, deferred: number, off?: string}>}
 */
async function runWeatherBackfill({ dryRun = false, deps = {} } = {}) {
  const location = "location" in deps ? deps.location : spaLocation();
  // No spa location configured: nothing to look up, and nothing to read.
  if (!location) return { ok: true, pending: 0, filled: 0, deferred: 0, off: "no spa location (agent/local/config/spa.json lat/lon)" };
  const getJson = deps.fetchJson || fetchJson;
  const write = deps.request || request;
  const hourlyFor = deps.fetchHourlyWeather || ((date) => fetchHourlyWeather(date, { location }));
  const sessions = await getJson(
    "/rest/v1/spa_heating_sessions?weather_fetched_at=is.null&select=session_id,started_at,ended_at&order=started_at.asc&limit=1000"
  );
  if (!Array.isArray(sessions) || !sessions.length) {
    return { ok: true, pending: 0, filled: 0, deferred: 0 };
  }

  const byDate = new Map();
  for (const s of sessions) {
    const dateISO = localDateISO(new Date(s.started_at), location.tz);
    if (!byDate.has(dateISO)) byDate.set(dateISO, []);
    byDate.get(dateISO).push(s);
  }

  let filled = 0;
  let deferred = 0;

  for (const [dateISO, rows] of byDate) {
    // Most-likely-too-recent dates (ERA5 reanalysis lags ~5 days) come back
    // null here; leave weather_fetched_at unset so the next run retries.
    const hourly = await hourlyFor(dateISO);
    if (!hourly) {
      deferred += rows.length;
      continue;
    }
    for (const s of rows) {
      const reading = nearestHour(hourly, new Date(s.started_at));
      if (!reading) {
        deferred++;
        continue;
      }
      filled++;
      if (dryRun) continue;
      await write(
        `/rest/v1/spa_heating_sessions?session_id=eq.${encodeURIComponent(s.session_id)}`,
        {
          method: "PATCH",
          body: {
            weather_air_temp_f: reading.tempF,
            weather_precip_in: reading.precipIn,
            weather_wind_mph: reading.windMph,
            weather_source: "open-meteo",
            weather_fetched_at: new Date().toISOString(),
          },
          prefer: "return=minimal",
        }
      );
    }
  }

  return { ok: true, pending: sessions.length, filled, deferred };
}

module.exports = { runWeatherBackfill, localDateISO };
