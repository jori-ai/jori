"use strict";
// reservoir-target — how many entries a trip reservoir should aim for, given
// the length of the stay.
//
// Requirement: the number of items researched and listed tracks the number of
// days, with the number per day decreasing the longer the stay — 10-15 items
// for a one-day stay, around 120 for a 30-day stay, the actual number depending
// on how much a location offers.
//
// A power law through those two anchors: total = 12.5 · days^0.665.
//   1 day ≈ 12 (11–14) · 3 ≈ 26 · 7 ≈ 46 · 14 ≈ 72 · 30 ≈ 120 (102–138)
// Per-day density falls as the stay grows (12.5/day → 4/day), which is the
// point: a short stay needs a dense shortlist, a long one draws on the same
// area's finite supply. It is a TARGET, not a quota — the prompt tells the
// research fork never to pad, and Places verification drops what won't resolve.

const ANCHOR_ONE_DAY = 12.5;
const EXPONENT = Math.log(120 / ANCHOR_ONE_DAY) / Math.log(30); // ≈ 0.665
const BAND = 0.15; // ± around the center → the low/high range given to the model

/** Whole days in a stay window. A same-day visit (from === to) counts as 1. */
function stayDays(from, to) {
  if (!from || !to) return null;
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.max(1, Math.round(ms / 86400000));
}

/**
 * @returns {{days:number,total:number,low:number,high:number,
 *            split:{must_see:number,optional:number,food_specialties:number,
 *                   unique_experiences:number,time_sensitive:number}}|null}
 *          null when there is no usable stay window.
 */
function reservoirTarget(from, to) {
  const days = stayDays(from, to);
  if (!days) return null;
  const total = Math.round(ANCHOR_ONE_DAY * Math.pow(days, EXPONENT));
  const share = (f, min) => Math.max(min, Math.round(total * f));
  return {
    days,
    total,
    low: Math.round(total * (1 - BAND)),
    high: Math.round(total * (1 + BAND)),
    // Rough guidance only. Food and the deeper-cut places carry the bulk;
    // must-see stays a short list however long the stay; time_sensitive is
    // whatever is actually on during the window.
    split: {
      must_see: share(0.10, 2),
      optional: share(0.35, 3),
      food_specialties: share(0.35, 4),
      unique_experiences: share(0.10, 1),
      time_sensitive: share(0.10, 1),
    },
  };
}

module.exports = { reservoirTarget, stayDays };
