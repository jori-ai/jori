// location-ask-filter — geometry/clock/id gates for a queued retrospective
// location ask (hum idea hum-i-20261018-03). Rule #0b: no text is read here.
// Every gate fails OPEN: a missing field means "cannot tell", never "drop".
//
// 1. isDriftStop     — radius < 100 m AND dwell < 20 min is GPS drift, not a stop.
// 2. answeredAskIds  — location asks already answered, from hum-learnings rows
//                      that carry the visit id (visit_id / ref / location_ask_id)
//                      and, optionally, an explicit stop window.
//    Whether a free-text answer covers an id-less stop stays with the model at
//    outbound-precheck.

import fs from "node:fs";
import { installTools } from "./root.cjs";

export const LEARNINGS_PATH = installTools("data", "hum-learnings.jsonl");
export const DRIFT_MAX_RADIUS_M = 100;
export const DRIFT_MAX_DWELL_MIN = 20;

function num(v) { const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v); return Number.isFinite(n) ? n : null; }

export function dwellMinutes(entry) {
  const a = Date.parse(entry?.stop_started_at || "");
  const b = Date.parse(entry?.stop_ended_at || "");
  if (Number.isFinite(a) && Number.isFinite(b) && b >= a) return (b - a) / 60000;
  return num(entry?.signals?.duration_min);
}

export function stopRadiusM(entry) {
  const s = entry?.signals || {};
  return num(s.drift_m ?? s.cluster_radius_m ?? s.radius_m);
}

/** True only when BOTH radius and dwell are known and both are under the limits. */
export function isDriftStop(entry) {
  const r = stopRadiusM(entry);
  const d = dwellMinutes(entry);
  return r != null && d != null && r < DRIFT_MAX_RADIUS_M && d < DRIFT_MAX_DWELL_MIN;
}

export function readLearnings(file = LEARNINGS_PATH) {
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return rows;
}

/** Is this queued ask's stop already covered by an answered location_ask row?
 *  Joined by id; a row that also carries a stop window overlapping this one counts too. */
export function alreadyAnswered(entry, rows) {
  const id = String(entry?.visit_id || "");
  if (!id) return false;
  const a = Date.parse(entry?.stop_started_at || "");
  const b = Date.parse(entry?.stop_ended_at || "");
  for (const r of rows || []) {
    if (!r || !r.answered_at) continue;
    const rid = r.visit_id ?? r.location_ask_id ?? r.ref ?? null;
    if (rid != null && String(rid) === id) return true;
    const ra = Date.parse(r.stop_started_at || "");
    const rb = Date.parse(r.stop_ended_at || "");
    const isLoc = r.kind === "location_ask" || r.category === "location_ask";
    if (isLoc && [a, b, ra, rb].every(Number.isFinite) && ra < b && rb > a) return true;
  }
  return false;
}
