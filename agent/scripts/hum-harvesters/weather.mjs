#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { readStdinJson, readCache, writeCache, emit, emitNull, stampRun } from "./_common.mjs";

import { installTools } from "../../../lib/root.cjs";
const { situation: sit, context } = await readStdinJson();

// Keyless fallback (Open-Meteo): same shape as the WeatherKit snapshot.
async function openMeteo(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code,uv_index&hourly=precipitation_probability` +
      `&temperature_unit=fahrenheit&forecast_hours=6&timezone=auto`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    const c = j?.current;
    if (!c || c.temperature_2m == null) return null;
    const probs = (j?.hourly?.precipitation_probability || []).filter((n) => typeof n === "number");
    return {
      temp_f: c.temperature_2m,
      condition: `wmo${c.weather_code}`,
      precip_chance: probs.length ? Math.max(...probs) / 100 : 0,
      uv: c.uv_index || 0,
      source: "open-meteo",
    };
  } catch { return null; }
}

// One line per local day in the log, not one per tick.
function noteFallbackOnce(msg) {
  try {
    const f = installTools("data/hum-cache/weather-fallback-noted.txt");
    const day = new Date().toISOString().slice(0, 10);
    if (fs.existsSync(f) && fs.readFileSync(f, "utf8").trim() === day) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, day);
    process.stderr.write(`weather: weatherkit_unavailable (${String(msg).split("\n")[0].slice(0, 120)}); using open-meteo\n`);
  } catch { /* logging only */ }
}


// Use cached weather if fresh (60m TTL); otherwise fetch
const TTL_MIN = 60;
let cur = readCache("weather");
let prev = cur; // for delta detection
if (!cur || cur._age_min >= TTL_MIN) {
  try {
    const out = execSync(`${installTools("bin/apple-weather")} --findme --json 2>/dev/null`, {
      encoding: "utf8", timeout: 10000,
    });
    const w = JSON.parse(out);
    const c = w?.currentWeather || w?.current || null;
    if (!c) { emitNull("no current weather in payload"); process.exit(0); }
    cur = {
      temp_f: c.temperature != null ? (c.temperature * 9) / 5 + 32 : null,
      condition: c.conditionCode,
      precip_chance: c.precipitationChance || 0,
      uv: c.uvIndex || 0,
    };
    writeCache("weather", cur);
  } catch (e) {
    // WeatherKit not enabled for the service id (401 NOT_ENABLED) or otherwise
    // down: fall back to the keyless Open-Meteo forecast for the same fix, and
    // note the fallback at most once a day instead of one error per tick.
    const lat = sit?.where?.lat, lon = sit?.where?.lon;
    cur = lat != null && lon != null ? await openMeteo(lat, lon) : null;
    if (!cur) {
      emitNull(`weather fetch: ${e.message}`);
      process.exit(0);
    }
    noteFallbackOnce(e.message);
    writeCache("weather", cur);
  }
}

// Check for significant change vs prior cached snapshot
const findings = [];
if (prev && prev._cached_at) {
  const dTemp = Math.abs((cur.temp_f ?? 0) - (prev.temp_f ?? 0));
  if (dTemp >= 10) findings.push(`Temp shifted ${dTemp.toFixed(0)}F`);
  if (prev.precip_chance < 0.3 && (cur.precip_chance || 0) >= 0.5) {
    findings.push(`Rain likely (${Math.round((cur.precip_chance || 0) * 100)}%)`);
  }
  if (cur.condition !== prev.condition && cur.condition) {
    findings.push(`Conditions: ${cur.condition}`);
  }
}

// Proactive "heading out with weather concern" trigger — only relevant if outside
// or about to go outside. Hum's Sonnet ranker can use the supporting data.
const rainSoon = (cur.precip_chance || 0) >= 0.5;
const extreme = cur.temp_f < 25 || cur.temp_f > 90;

if (findings.length === 0 && !rainSoon && !extreme) {
  stampRun("weather", false);
  emitNull("no material change");
  process.exit(0);
}

const urgency = rainSoon ? 0.6 : (extreme ? 0.5 : 0.3);
stampRun("weather", true);
emit({
  topic: "weather",
  signal: findings.length ? findings.join("; ") : `${cur.condition || "clear"}, ${cur.temp_f}F, rain ${Math.round((cur.precip_chance || 0) * 100)}%`,
  urgency,
  freshness_min: 0,
  dedup_key: `weather:${cur.condition}:${Math.round(cur.temp_f / 5)}`,
  supporting_data: { current: cur, findings, rain_soon: rainSoon, extreme },
});
