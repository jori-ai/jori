// location — arrivals, departures and motion transitions.
//
// phone-channel's Supabase realtime subscription pushes arrival/departure into
// the spool the instant the row changes, which is the fast path. This sensor is
// the poll-side backstop for that (realtime websockets go quiet without saying
// so — see the note in phone-channel) AND the only source of motion
// transitions: stationary → walking → driving, which realtime doesn't carry.
//
// Dedup keys are deliberately identical to the ones phone-channel emits
// (`location:visit:<row-id>:arrival`), so whichever path notices first wins and
// the other is swallowed by the gate's cooldown instead of double-pinging.

// Off, not broken, without the location module: no `findme` bin (the motion
// source) means no events; no Supabase project means the visits read throws
// ("I can't see"), per the sensor contract.

import { event, shJson, sh, minsSince, BIN } from "./_common.mjs";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const { supabaseUrl } = createRequire(import.meta.url)("../../../lib/instance.cjs");
const SUPABASE_URL = process.env.SUPABASE_URL || supabaseUrl();
const FINDME = path.join(BIN, "findme");
const ASK_GATE = path.join(BIN, "ask-gate");
// How far back to look for a visit we haven't reacted to yet. Matches the
// lookback in hum-harvesters/location_context.mjs for the same reason: a visit
// row's arrived_at is confirmed well after the physical arrival.
const VISIT_LOOKBACK_MIN = 45;

/**
 * Recent visit rows, newest first.
 *
 * This exists because `findme activity` returns exactly ONE row — the most
 * recent segment — and in a city that is almost never the visit. Live failure:
 * a visit row (a vet appointment) was written at 17:07 with arrived_at 16:59,
 * and transit rows at 17:07, 17:08, 17:09 and 17:15 immediately outranked it
 * because GPS keeps jittering while the user stands inside a building. The
 * sensor looked at the newest row, saw `segment_type: "transit"`, and emitted
 * no arrival at all — for the single most useful stop of the afternoon.
 *
 * Querying the visits directly makes the detection independent of whatever
 * happens to be the newest row.
 *
 * THROWS on an unreachable source rather than returning [] — per the sensor
 * contract, "nothing happened" and "I can't see" must not look alike.
 */
async function recentVisits() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing — cannot see visits");
  if (!SUPABASE_URL) throw new Error("no Supabase project configured — cannot see visits");
  const since = new Date(Date.now() - VISIT_LOOKBACK_MIN * 60000).toISOString();
  const qs = new URLSearchParams({
    segment_type: "eq.visit",
    arrived_at: `gte.${since}`,
    order: "arrived_at.desc",
    limit: "6",
    select: "id,place_name,address,latitude,longitude,arrived_at,departed_at",
  });
  const raw = await sh("curl", [
    "-s", "--max-time", "8",
    "-H", `apikey: ${key}`, "-H", `Authorization: Bearer ${key}`,
    `${SUPABASE_URL}/rest/v1/location_history?${qs}`,
  ], { timeout: 10000 });
  if (!raw) throw new Error("location_history query returned nothing — source unreachable");
  let rows;
  try { rows = JSON.parse(raw); } catch { throw new Error(`location_history returned non-JSON: ${raw.slice(0, 80)}`); }
  if (!Array.isArray(rows)) throw new Error(`location_history returned ${typeof rows}, expected array`);
  return rows;
}

export const meta = {
  name: "location",
  lanes: ["nearby", "location_context", "meal_offer", "situation"],
};

const MOVING = new Set(["walking", "running", "cycling", "driving"]);

export default async function detect(ctx) {
  const { memo, setMemo, nowMs } = ctx;
  // findme activity returns the most recent location_history segment as-is.
  // It is the right source for MOTION (what is the user doing right now) and
  // the wrong source for arrivals — see recentVisits() above.
  if (!fs.existsSync(FINDME)) return []; // no location module installed: off
  const seg = await shJson(FINDME, ["activity", "--json"], { timeout: 12000 });
  if (!seg || !seg.id) return [];

  const out = [];
  const place = seg.place_name || seg.address || null;
  const activity = String(seg.activity || "unknown");
  const seen = Array.isArray(memo?.seen_visits) ? memo.seen_visits : [];
  const seenSet = new Set(seen);

  // ── arrival: a visit row we haven't seen, still open, arrived recently ──
  // Window widened 12→45 min: a "visit" row is only written once
  // location_history CONFIRMS a dwell, which regularly lags the actual
  // physical arrival by well over 12 minutes — so the old window routinely
  // expired before the row even existed, and the arrival was never emitted as
  // an event at all (an arrival at ~11:00 local was confirmed too late for
  // this check, and hum-sense sat idle with nothing to dispatch on). 45 min comfortably covers realistic confirmation lag while
  // dedup_key (keyed on the visit row id) still prevents any repeat ask.
  const visits = await recentVisits();
  for (const v of visits) {
    const vPlace = v.place_name || v.address || null;
    const arrivedKey = `${v.id}:arrival`;
    if (!v.departed_at && !seenSet.has(arrivedKey) && minsSince(v.arrived_at, nowMs) < VISIT_LOOKBACK_MIN) {
      seenSet.add(arrivedKey);
      out.push(event("location", "arrival", {
        subject: vPlace || "a new place",
        summary: `Arrived at ${vPlace || "a new place"}`,
        salience: vPlace ? 0.62 : 0.5,
        lanes: ["nearby", "location_context", "meal_offer", "situation"],
        dedup_key: `location:visit:${v.id}:arrival`,
        ttl_min: 25,
        cooldown_min: 30,
        // The single most perishable moment hum has: what is worth knowing
        // around the user is worth knowing BEFORE picking somewhere, not after.
        perishable: true,
        data: { row_id: v.id, place: vPlace, lat: v.latitude, lon: v.longitude, arrived_at: v.arrived_at },
      }));
    }

    // ── departure: a visit we already saw has now closed ──
    // A closed row is not proof the user left (a quiet slice of a rental stay
    // was written with an end time and announced as "Left the rental" while
    // the user sat there all evening). ask-gate --mode departure reads the raw
    // trace; a hold is NOT marked seen, so the next tick inside the lookback
    // re-checks. Fail-open: no answer (or no ask-gate installed) → emit as before.
    const departedKey = `${v.id}:departure`;
    if (v.departed_at && !seenSet.has(departedKey) && minsSince(v.departed_at, nowMs) < VISIT_LOOKBACK_MIN) {
      const proof = fs.existsSync(ASK_GATE)
        ? await shJson(ASK_GATE, ["--visit", v.id, "--mode", "departure", "--json"], { timeout: 30000 })
        : null;
      if (proof && proof.ask === false) continue;
      seenSet.add(departedKey);
      out.push(event("location", "departure", {
        subject: vPlace || "somewhere",
        summary: `Left ${vPlace || "somewhere"}`,
        salience: 0.5,
        lanes: ["location_context", "situation", "calendar"],
        dedup_key: `location:visit:${v.id}:departure`,
        ttl_min: 25,
        cooldown_min: 30,
        perishable: true,
        data: { row_id: v.id, place: vPlace, lat: v.latitude, lon: v.longitude, departed_at: v.departed_at },
      }));
    }
  }

  // ── motion transition: started moving / came to rest ──
  // The interesting edges are "was still, is now moving" (going somewhere —
  // routing, weather, what's on the way) and "was moving, is now still"
  // (arrived at something not yet closed into a visit row).
  const movingNow = MOVING.has(activity);
  if (memo?.moving !== undefined && memo.moving !== movingNow) {
    const kind = movingNow ? "started_moving" : "stopped_moving";
    out.push(event("location", kind, {
      subject: activity,
      summary: movingNow ? `On the move (${activity})` : `Stopped moving${place ? ` at ${place}` : ""}`,
      // Starting to move is a stronger moment than stopping: it precedes a
      // decision (where to, what's on the way) rather than following one.
      salience: movingNow ? 0.48 : 0.38,
      lanes: movingNow ? ["situation", "location_context", "weather", "calendar"] : ["nearby", "location_context", "situation"],
      dedup_key: `location:motion:${kind}:${seg.id}`,
      ttl_min: 20,
      cooldown_min: 40,
      // Coordinates ride along on motion edges too — coming to rest somewhere
      // that never becomes a confirmed "visit" row is still a place the user
      // is standing, and the `nearby` lane needs a fix to work from.
      data: { activity, place, segment_type: seg.segment_type, lat: seg.latitude, lon: seg.longitude },
    }));
  }

  setMemo({
    // Bounded: only the recent edges matter, and the lookback window means
    // anything older can never be re-emitted anyway.
    seen_visits: [...seenSet].slice(-40),
    moving: movingNow,
    place,
  });
  return out;
}
