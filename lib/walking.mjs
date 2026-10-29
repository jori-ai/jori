// walking.mjs — what "walking distance" means, in one place.
//
// Lanes that suggest going somewhere on foot import this instead of inventing
// a radius each (they used to, and no two agreed). The limit is the user's:
// agent/local/config/walking.json `max_minutes` (default 20).
//
// Distances here are straight-line (haversine, or a Places search radius); a
// walk follows streets. ROUTE_FACTOR converts one to the other — about 1.25 on
// a city grid — so a 20-minute walk is ~1,600m on foot and ~1,280m as the crow
// flies. The `nearby` lane's 200m is a different promise ("what is right here")
// and deliberately does not use this.

import { createRequire } from "node:module";
const { localConfig } = createRequire(import.meta.url)("./instance.cjs");

export const WALK_MAX_MIN = Number(localConfig("walking", { max_minutes: 20 }).max_minutes) || 20;
export const WALK_M_PER_MIN = 80; // ~4.8 km/h
export const ROUTE_FACTOR = 1.25;

/** Straight-line radius, in metres, that fits inside a WALK_MAX_MIN walk. */
export const WALK_MAX_M = Math.round((WALK_MAX_MIN * WALK_M_PER_MIN) / ROUTE_FACTOR);

/** Estimated walking minutes for a straight-line distance in metres (at least 1). */
export function walkMinutes(straightLineM) {
  return Math.max(1, Math.round((Number(straightLineM) * ROUTE_FACTOR) / WALK_M_PER_MIN));
}
