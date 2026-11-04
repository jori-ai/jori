// stop-passage-jev — layer 2 of the stop-or-passage check (layer 1:
// lib/stop-passage.mjs). Reached only when the geometry is INCONCLUSIVE.
//
// Jev is told the movement in WORDS ("about 250 m", "mostly walking") because
// numbers are a documented weak spot (docs/jev.md), and gets the evidence
// the geometry cannot read: the photos the user took, the user's calendar and
// the user's chat messages. The sunset walk that prompted this had five
// photos labelled sunset / sea / pier on the promenade and a sixth 140 m on —
// a walk, plainly, to anything that can read a label.
//
// Only `walk` at or above the site threshold (0.9) acts. `stop`, `unclear`,
// low confidence and every failure fall through to legacy = ask, which is the
// behaviour before this existed.

import { decide } from "./jev-shadow.mjs";
import { jevQuestions, answerConfidence } from "./jev.mjs";
import { createRequire } from "node:module";
const { haversineMeters } = createRequire(import.meta.url)("./stop-rests.js");
const distM = (a, b) => haversineMeters(Number(a.latitude), Number(a.longitude), Number(b.latitude), Number(b.longitude));

export const JEV_SITE = "stop-passage";

function about(m) {
  if (m == null) return "unknown";
  if (m < 20) return "a few metres";
  if (m < 1000) return `about ${Math.round(m / 10) * 10} m`;
  return `about ${(m / 1000).toFixed(1)} km`;
}
function minutes(x) {
  if (x == null) return "unknown";
  if (x < 1) return "under a minute";
  return `about ${Math.round(x)} min`;
}
function share(x) {
  if (x == null) return "no motion tags";
  if (x >= 0.8) return "mostly moving (walking)";
  if (x >= 0.5) return "mixed, leaning moving";
  if (x > 0.2) return "mixed, leaning still";
  return "mostly still";
}
const hhmm = (t, tz) => new Date(t).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });

/** Build the state Jev sees. Pure, so tests can pin it. */
export function buildState({ start, end, tz = "UTC", features, areaName = null, photos = [], calendar = [], messages = [] }) {
  const s = Date.parse(start), e = Date.parse(end);
  let prev = null;
  const ph = photos.map((p) => {
    const t = Date.parse(p.taken_at);
    const row = {
      at: hhmm(t, tz),
      when: t < s ? "just before" : t > e ? "just after" : "during",
      shows: Array.isArray(p.labels) ? p.labels.slice(0, 20) : [],
      text_in_photo: p.detected_text && typeof p.detected_text === "object" ? Object.values(p.detected_text).flat().join(" ").slice(0, 200) || null : (p.detected_text || null),
      kind: p.media_type || "photo",
    };
    if (prev && p.latitude != null && prev.latitude != null)
      row.distance_from_previous_photo = about(distM(prev, p));
    prev = p;
    return row;
  });
  return {
    window: { from: hhmm(s, tz), to: hhmm(e, tz), length: minutes(features.window_min) },
    area_name: areaName || null,
    movement: {
      motion_sensor: share(features.moving_share),
      ground_covered_during_window: about(features.spread_m),
      longest_pause_seen_in_one_spot: minutes(features.longest_rest_min),
      longest_gap_with_no_gps: features.longest_hidden ? `${minutes(features.longest_hidden_min)}, ending ${about(features.longest_hidden.apart_m)} from where it began` : "none",
      start_and_end_of_outing:
        features.before_after_apart_m == null ? "unknown"
          : features.before_after_apart_m < 100 ? "the user was at the same spot 15+ min before and 15+ min after (an out-and-back)"
          : `the spots 15+ min before and after are ${about(features.before_after_apart_m)} apart`,
    },
    photos: ph,
    calendar: calendar.map((c) => ({ title: c.summary, location: c.location || null, from: c.start, to: c.end })),
    messages: messages.map((m) => ({ at: m.at ? hhmm(Date.parse(m.at), tz) : null, text: String(m.body || "").slice(0, 300) })),
  };
}

/**
 * @returns {Promise<{decision:"passage"|"ask", source:string, confidence?:number}>}
 */
export async function judgeWindow({ id, state, decideImpl = decide }) {
  const { value, used, jev } = await decideImpl({
    site: JEV_SITE,
    id: id || null,
    state,
    questions: jevQuestions(JEV_SITE),
    interpret: (a) => ({
      value: { decision: a.kind?.choice === "walk" ? "passage" : "ask", pick: a.kind?.choice || null },
      confidence: answerConfidence(a.kind),
    }),
    legacy: async () => ({ decision: "ask", pick: null }),
    // Legacy is a constant, not a judgment — comparing against it would page a
    // "disagreement" for every walk Jev recognises. Deferred: the asks that
    // still go out (and the user's answers) are the ground truth.
    same: () => null,
  });
  if (used === "jev" && value.decision === "passage")
    return { decision: "passage", source: "jev", confidence: jev?.confidence };
  return { decision: "ask", source: used === "jev" ? `jev:${value.pick}` : "legacy", confidence: jev?.confidence };
}
