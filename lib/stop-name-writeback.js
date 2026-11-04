"use strict";
// stop-name-writeback — carry a name the day's resolver EARNED back onto the
// visit row it stands on, so the rungs below the resolved day stop disagreeing
// with it.
//
// Why this exists: a named stop the resolved day knew was missing from the
// day's map. The resolved day had it: a 144-minute rest 6 m from the user's
// saved jazz club, corroborated by CLVisit, CoreMotion and four videos, named
// `saved_place` at 0.9. But the map is drawn by `day-path` from
// `location_history` visit rows, and the row under that rest still said
// "<street address>" / `address` — nothing ever told the row what the day had
// worked out. `findme enrich` reads the same row and would have asked about
// a stop the day already knew. One store had the answer and two readers of the
// other store did not.
//
// The write is deliberately narrow:
//   - only names from the two INFERRED-but-settled rungs, `saved_place` and
//     `photo_text` (the user's own label at the rest; the sign in the user's own photo). A
//     `user_confirmed` name already lives on the row — it came FROM the row —
//     and a resolver guess must never be promoted to a row fact;
//   - only onto rows whose `place_type` is a geocode or a machine label
//     (`address`, `stay-point`, `segment-derived`, empty). `user-confirmed`,
//     `named`, `non-stop` and `photo-synthesized` are somebody's verdict and
//     are left alone; a row already carrying this exact name is a no-op;
//   - only rows that overlap the stop's window AND sit within WRITEBACK_ROW_M
//     of the REST the name was earned at — not the stop's centroid, which
//     averages in the walk there, and not "any row in the window", which on
//     this day would have renamed the sweeper's 61-minute "<street address>"
//     twin 144 m up the block as well.
//
// The row gets `place_type='named'` — rank 2 in day-path's ladder (below
// `user-confirmed`, above `address`), and the type `findme enrich` treats as
// resolved — plus a `notes` line recording what it was, so the change is
// auditable and reversible. `findme resolve` still beats it: the user's own words
// arrive as `user-confirmed`, rank 3.
//
// Geometry is decided here; nothing in this file reads the user's language.

const path = require("node:path");
const { findRests, haversineMeters } = require(path.join(__dirname, "stop-rests.js"));

const WRITEBACK_SOURCES = new Set(["saved_place", "photo_text"]);
// Row types a resolver-earned name may replace. Anything else is a verdict.
// `default-applied` (2026-10-22): an unanswered card's default, a guess — a
// verified saved place or a sign in the user's photo at the rest replaces it.
const OVERWRITABLE_TYPES = new Set(["address", "stay-point", "segment-derived", "default-applied", "", null, undefined]);
// The row's own centroid must be this close to the REST the name was earned
// at. CLVisit centroids for a long indoor stay wander a few tens of metres;
// the twin row that must NOT be renamed on 2026-09-07 sat 144 m away.
const WRITEBACK_ROW_M = 75;
const PHOTO_OVERRIDES_TYPES = new Set(["user-confirmed", "named", "photo-synthesized"]);
const WRITTEN_TYPE = "named";

function stopRest(stop, pings) {
  const rests = findRests(pings || [], stop.start_ts_ms, stop.end_ts_ms);
  if (!rests.length) return null;
  return rests.reduce((a, b) => (b.minutes > a.minutes ? b : a));
}

/**
 * Decide which rows get which name. Pure: no I/O, so it is testable and so
 * the caller can print the plan before (or instead of) applying it.
 *
 * @param {object[]} stops  resolved-day stops (post naming passes)
 * @param {object[]} rows   location_history visit rows: {id, latitude, longitude,
 *                          arrived_at, departed_at, place_name, place_type}
 * @param {object[]} pings  the day's ping stream (for the rest)
 * @returns {{writes: object[], skipped: object[]}}
 */
function planNameWriteBack(stops, rows, pings) {
  const writes = [];
  const skipped = [];
  const claimed = new Set();
  for (const s of stops || []) {
    const src = (s.place && s.place.source) || "";
    const name = s.place && s.place.name;
    if (!WRITEBACK_SOURCES.has(src) || !name) continue;
    const rest = stopRest(s, pings);
    if (!rest) { skipped.push({ stop: s.id, name, reason: "no verified rest to anchor the row to" }); continue; }
    for (const r of rows || []) {
      if (!r || !r.id || claimed.has(r.id)) continue;
      if (r.latitude == null || r.longitude == null) continue;
      const a = Date.parse(r.arrived_at);
      const d = r.departed_at ? Date.parse(r.departed_at) : a;
      if (!Number.isFinite(a)) continue;
      if (Math.min(d, s.end_ts_ms) - Math.max(a, s.start_ts_ms) <= 0) continue;
      const dm = haversineMeters(rest.lat, rest.lon, r.latitude, r.longitude);
      if (dm > WRITEBACK_ROW_M) continue;
      if (r.place_type === WRITTEN_TYPE && r.place_name === name) continue;   // already done
      // A sign in the user's own photo that named somewhere else outranks any label
      // on the row (photo_overrode, photo-place-name.js) — except the user's "not a
      // stop", which is about the window, not the name.
      const overridable = OVERWRITABLE_TYPES.has(r.place_type)
        || (src === "photo_text" && s.photo_overrode && PHOTO_OVERRIDES_TYPES.has(r.place_type));
      if (!overridable) {
        skipped.push({ stop: s.id, row: r.id, name, reason: `row is ${r.place_type} ("${r.place_name || ""}") — a verdict, not a geocode` });
        continue;
      }
      claimed.add(r.id);
      writes.push({
        row: r.id, stop: s.id, name, source: src,
        was_name: r.place_name || null, was_type: r.place_type || null,
        rest_distance_m: Math.round(dm),
      });
    }
  }
  return { writes, skipped };
}

function noteLine(w, today) {
  const was = w.was_name ? `${w.was_name} (${w.was_type || "untyped"})` : (w.was_type || "untyped");
  return `[writeback ${today}] ${w.source} -> "${w.name}"; was: ${was}`;
}

/**
 * Apply a plan. `patch(rowId, body)` does the PATCH; `rowNotes(rowId)` returns
 * the row's existing notes so the audit line is appended, not overwritten.
 */
async function applyNameWriteBack(plan, { patch, rowNotes = () => null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const done = [];
  const failed = [];
  for (const w of plan.writes || []) {
    const prior = rowNotes(w.row);
    const notes = [prior, noteLine(w, today)].filter(Boolean).join("\n");
    try {
      await patch(w.row, { place_name: w.name, place_type: WRITTEN_TYPE, notes });
      done.push(w);
    } catch (e) {
      failed.push({ ...w, error: (e && e.message) || String(e) });
    }
  }
  return { done, failed };
}

module.exports = {
  planNameWriteBack, applyNameWriteBack,
  WRITEBACK_SOURCES, OVERWRITABLE_TYPES, WRITEBACK_ROW_M, WRITTEN_TYPE,
  _internal: { stopRest, noteLine },
};
