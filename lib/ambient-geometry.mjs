// ambient-geometry — the geometry half of location-ambient, in code.
//
// jobs/location-ambient.md used to have a small-model turn compute Step 1c
// (800m radius, straight-line vs path-length ratio, home proximity, the
// routine-walk windows) and Step 2.5's 150m haversine gate by hand. That is
// arithmetic over coordinates — Rule #0b: code owns geometry. The model keeps
// candidate quality and the wording.
//
// The routine walk (e.g. a dog's, from home) is one config shared with the
// hum location_context harvester — agent/local/config/routine-walk.json
// (optional; with none there is no routine walk: nothing is skipped as one and
// no walk is guessed to be one):
//   homes            names of the data/named-locations.json entries walks start
//                    from (default: every entry of kind "home")
//   companion        who the walk is with, as the location log names them
//                    (lib/companions.js); the harvester's guess names them
//   ambient_windows  [[fromHour, toHour), ...] in the home zone (instance().tz);
//                    toHour may pass 24 for a window past midnight. At home
//                    inside one, a stop is the routine walk, not an outing.
//   ask_morning_until_hour / ask_evening_hours  [from, to]  when a short loop
//                    from home is guessed to be the routine walk (harvester)

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { instance, localConfig } = require("./instance.cjs");
const { loadNamedLocations } = require("./named-locations.js");

export const HOME_RADIUS_M = 300;
export const WANDER_RADIUS_M = 800;
export const TRIGGER_RADIUS_M = 150;

/** The routine-walk config (agent/local/config/routine-walk.json), with generic defaults. */
export function routineWalkConfig() {
  return localConfig("routine-walk", {
    homes: null, companion: null, ambient_windows: [], ask_morning_until_hour: 10, ask_evening_hours: [17, 21],
  });
}

/** The homes routine walks start from: config `homes` by name, else named locations of kind "home". */
export function homes(entries = loadNamedLocations(), names = routineWalkConfig().homes) {
  const pick = Array.isArray(names) && names.length
    ? (entries || []).filter((e) => names.includes(e.name))
    : (entries || []).filter((e) => e.kind === "home");
  return pick.map((e) => ({ name: e.name, lat: e.lat, lon: e.lon }));
}

/** The ambient routine-walk windows, home-zone hours [from, to). */
export function routineWalkWindows() {
  const w = routineWalkConfig().ambient_windows;
  return Array.isArray(w) ? w.filter((x) => Array.isArray(x) && x.length === 2 && x.every(Number.isFinite)) : [];
}

export function haversineM(aLat, aLon, bLat, bLon) {
  const R = 6371000, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat), dLon = toR(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Wandering vs transit over the GPS points PRECEDING the stop (oldest first).
 * wandering: all within 800m of their centroid AND straight/arc < 0.6.
 * transit:   straight/arc > 0.75, or a single tight cluster (< 50m spread).
 * ambiguous: the band in between — the agent decides.
 */
export function classifyWander(points) {
  const pts = (points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (pts.length < 3) return { kind: "no-data", points: pts.length };
  const cLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const cLon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
  const radius = Math.max(...pts.map((p) => haversineM(cLat, cLon, p.lat, p.lon)));
  let arc = 0;
  for (let i = 1; i < pts.length; i++) arc += haversineM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  const straight = haversineM(pts[0].lat, pts[0].lon, pts.at(-1).lat, pts.at(-1).lon);
  const ratio = arc > 0 ? straight / arc : 1;
  const base = { points: pts.length, radius_m: Math.round(radius), arc_m: Math.round(arc), ratio: Math.round(ratio * 100) / 100 };
  if (radius < 50) return { kind: "transit", why: "single tight cluster", ...base };
  if (ratio > 0.75) return { kind: "transit", why: "linear path", ...base };
  if (radius <= WANDER_RADIUS_M && ratio < 0.6) return { kind: "wandering", ...base };
  if (radius > WANDER_RADIUS_M) return { kind: "transit", why: "spread beyond 800m", ...base };
  return { kind: "ambiguous", ...base };
}

/** The hour (0-23) of instant `ms` in zone `tz` (default the home zone). */
export function homeHour(ms, tz = instance().tz) {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  return Number(h);
}

/**
 * At home during a routine-walk window → this is the routine walk, not an
 * outing: the home's name, else null.
 */
export function routineWalk(lat, lon, nowMs, { homeList = homes(), windows = routineWalkWindows(), tz } = {}) {
  const home = homeList.find((h) => haversineM(lat, lon, h.lat, h.lon) <= HOME_RADIUS_M);
  if (!home || !windows.length) return null;
  const h = homeHour(nowMs, tz);
  const inWin = windows.some(([a, b]) => (h >= a && h < b) || (h + 24 >= a && h + 24 < b));
  return inWin ? home.name : null;
}

/** Step 2.5: candidates [{name, lat, lon, ...}] sorted by live distance; `fire` = closest within radius. */
export function proximity(candidates, lat, lon, radius = TRIGGER_RADIUS_M) {
  const ranked = (candidates || [])
    .filter((c) => Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lon)))
    .map((c) => ({ ...c, distance_m: Math.round(haversineM(lat, lon, Number(c.lat), Number(c.lon))) }))
    .sort((a, b) => a.distance_m - b.distance_m);
  return { ranked, fire: ranked[0] && ranked[0].distance_m <= radius ? ranked[0] : null, radius_m: radius };
}

// Step 2.0 (exclude places already on today's calendar / visited today) stays
// with the model on purpose: deciding that "Café X" and "Café X Bar" are the
// same place is reading names, not geometry.
