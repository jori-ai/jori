"use strict";
// reservoir-dates — resolve each trip area's date range from the canonical
// travel timeline (`travel_segments`), so the area guides can be listed in the
// order they're actually visited, with their dates.
//
// Requirement: the area guides are listed on the site in visiting order, each
// with its dates (e.g. 7/10-7/19).
//
// Source of truth is travel_segments (see agent/CLAUDE.md § Travel Timeline).
// Two wrinkles it has to handle:
//
//  1. LODGING beats FLIGHTS. A flights-derived segment covers the whole
//     destination stay — Paris is one `source=flights` row spanning 2026-07-09 →
//     2026-08-12 (arrival at CDG through the final departure), even though the
//     Paris *leg* is only 08-06 → 08-12. Ordering on that row would sort Paris
//     first and label it with a five-week range. So prefer `source=lodging`
//     rows, which are the actual stays, and fall back to any segment only when
//     an area has no lodging at all.
//  2. An area can be visited more than once. Take the earliest arrival and the
//     latest departure across its lodging stays (a return leg widens the range
//     rather than creating a second entry, since the guide is per-area).

const { fetchJson } = require("./supabase-rest.js");

/**
 * @returns {Promise<Object<string, {start: string, end: string}>>} area -> range
 *          (YYYY-MM-DD). Empty object if the timeline is unreachable.
 */
async function areaDateRanges() {
  const rows = await fetchJson(
    "/rest/v1/travel_segments?select=metro,source,arrive_at,depart_at&order=arrive_at.asc",
    { timeoutMs: 15000 },
  );
  if (!rows) return {};

  const byArea = {};
  for (const r of rows) {
    if (!r.metro || r.metro === "transit" || !r.arrive_at) continue;
    const isLodging = r.source === "lodging";
    const cur = byArea[r.metro];
    // A lodging row always displaces a non-lodging one, however early it is.
    if (cur && cur.lodging && !isLodging) continue;
    if (cur && !cur.lodging && isLodging) {
      byArea[r.metro] = { lodging: true, start: r.arrive_at, end: r.depart_at };
      continue;
    }
    if (!cur) {
      byArea[r.metro] = { lodging: isLodging, start: r.arrive_at, end: r.depart_at };
      continue;
    }
    // Same tier — widen to cover a repeat visit.
    if (r.arrive_at < cur.start) cur.start = r.arrive_at;
    if (r.depart_at && (!cur.end || r.depart_at > cur.end)) cur.end = r.depart_at;
  }

  const out = {};
  for (const [area, v] of Object.entries(byArea)) {
    out[area] = { start: String(v.start).slice(0, 10), end: String(v.end || v.start).slice(0, 10) };
  }
  return out;
}

module.exports = { areaDateRanges };
