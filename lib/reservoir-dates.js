"use strict";
// reservoir-dates — resolve each trip area's dates from the canonical travel
// timeline (`travel_segments`), so a guide carries the dates it's actually
// visited (the wiki mirror and the guide's stored date_range read them; the
// travel-guide site builds its ribbon from the timeline live, through the same
// lib/trip-stays.mjs).
//
// The timeline is resolved into STAYS first (lib/trip-stays.mjs): overlapping
// segments go to the most specific one (the lib/presence.js rule), so a coarse
// flights row spanning a whole multi-city loop no longer swallows the stops
// inside it, and a city visited twice is two stays.
//
// Each stay is then matched to its guide (trip-stays guideFor): the guide keyed
// by the metro itself, else a combined guide whose key names it (a two-city
// guide covers both cities' stays — before this, such a guide never matched any
// metro and kept its placeholder dates forever).
//
// Result per area: { start, end, stays: [{metro, start, end}] } — start/end
// span its first to last stay (an open-ended last stay ends on its start date),
// in the home zone.

const { fetchJson } = require("./supabase-rest.js");
const { homeTz } = require("./presence.js");

/**
 * @param {string[]} areaKeys the guides (trip_reservoirs areas) to resolve for
 * @returns {Promise<Object<string, {start: string, end: string, stays: Array<{metro:string,start:string,end:string|null}>}>>}
 *          area -> range (YYYY-MM-DD). Empty object if the timeline is unreachable.
 */
async function areaDateRanges(areaKeys) {
  const rows = await fetchJson(
    "/rest/v1/travel_segments?select=metro,source,arrive_at,depart_at&order=arrive_at.asc",
    { timeoutMs: 15000 },
  );
  if (!rows) return {};
  const { resolveStays, guideFor } = await import("./trip-stays.mjs");

  const stays = resolveStays(rows, { tz: homeTz() });
  const out = {};
  for (const s of stays) {
    const area = guideFor(s.metro, areaKeys || []);
    if (!area) continue;
    const cur = out[area] || (out[area] = { start: s.start, end: s.end || s.start, stays: [] });
    cur.stays.push({ metro: s.metro, start: s.start, end: s.end });
    if (s.start < cur.start) cur.start = s.start;
    const e = s.end || s.start;
    if (e > cur.end) cur.end = e;
  }
  return out;
}

module.exports = { areaDateRanges };
