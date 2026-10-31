"use strict";
// spa-weather — historical hourly weather at the spa's location, from
// Open-Meteo's free archive API (no key, no billing — a public reanalysis
// dataset). The location is agent/local/config/spa.json `lat` / `lon` (and
// `tz`, the spa's own zone, default the installation's zone); without a
// location there is nothing to look up and every call returns null.
//
// WHY THIS EXISTS
// ----------------
// spa-heating-model-data needs an ambient air temperature per session to fit
// dT/dt = a - b*(T_water - T_air). The on-site sensor only logged air_temp_mean
// on a small fraction of sessions (SpaServer rarely captures it), which was the
// actual blocker to a real fit — not session count. A weather service supplies
// ambient temperature, and rain and wind with it.
//
// The spa's location is fixed (it never travels), so a historical weather
// lookup keyed on the session's date/hour is a reliable substitute for a
// missing sensor reading, and it's the only source that also gives us wind
// and precipitation — the sensor never captured either at all.

const { localConfig, instance } = require("./instance.cjs");

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

/** The spa's fixed location and zone, or null when none is configured. */
function spaLocation(cfg = localConfig("spa", { lat: null, lon: null, tz: "" })) {
  const lat = Number(cfg.lat), lon = Number(cfg.lon);
  if (cfg.lat == null || cfg.lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, tz: cfg.tz || instance().tz };
}

/**
 * Hourly temperature/precip/wind for one calendar date (the spa's zone), at
 * the spa's location. Returns null on any failure — the archive API also lags
 * a few days behind real time (ERA5 reanalysis), so a recent date returning
 * null is expected and the caller should just retry on a later run.
 *
 * @param {string} dateISO  "YYYY-MM-DD"
 * @param {object} [opts]
 * @param {{lat:number, lon:number, tz:string}|null} [opts.location]  default spaLocation()
 * @param {typeof fetch} [opts.fetchImpl]  default the global fetch (tests stub it)
 * @returns {Promise<{times: Date[], tempF: number[], precipIn: number[], windMph: number[]} | null>}
 */
async function fetchHourlyWeather(dateISO, { location = spaLocation(), fetchImpl = fetch } = {}) {
  if (!location) return null;
  const qs = new URLSearchParams({
    latitude: String(location.lat),
    longitude: String(location.lon),
    start_date: dateISO,
    end_date: dateISO,
    hourly: "temperature_2m,precipitation,wind_speed_10m",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    // The day is cut in the spa's zone; the hours come back as epoch seconds
    // so they do not depend on this host's zone.
    timezone: location.tz,
    timeformat: "unixtime",
  });
  try {
    const res = await fetchImpl(`${ARCHIVE_URL}?${qs}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const h = body.hourly;
    if (!h || !Array.isArray(h.time) || !h.time.length) return null;
    return {
      times: h.time.map((t) => new Date(typeof t === "number" ? t * 1000 : t)),
      tempF: h.temperature_2m,
      precipIn: h.precipitation,
      windMph: h.wind_speed_10m,
    };
  } catch {
    return null;
  }
}

/**
 * Pick the hourly reading closest to a session timestamp.
 * @param {ReturnType<typeof fetchHourlyWeather> extends Promise<infer T> ? T : never} hourly
 * @param {Date} at
 */
function nearestHour(hourly, at) {
  if (!hourly) return null;
  const target = at.getTime();
  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < hourly.times.length; i++) {
    const diff = Math.abs(hourly.times[i].getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  if (bestIdx === -1) return null;
  const tempF = hourly.tempF[bestIdx];
  const precipIn = hourly.precipIn[bestIdx];
  const windMph = hourly.windMph[bestIdx];
  if (tempF == null) return null;
  return { tempF, precipIn: precipIn ?? null, windMph: windMph ?? null };
}

module.exports = { spaLocation, fetchHourlyWeather, nearestHour };
