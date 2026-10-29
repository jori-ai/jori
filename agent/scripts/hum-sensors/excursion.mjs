// excursion — "the user is out, and there is something here not yet told."
//
// The location sensor answers "did the user arrive somewhere identifiable?".
// That is the wrong question for a walk through a neighbourhood, and it leaves
// hum silent for a whole afternoon out. Three failure modes:
//
//   * a `visit` row is only written once location_history CONFIRMS a dwell —
//     8+ minutes after the physical arrival, already past useful;
//   * walking a neighbourhood produces transit rows and often no visit at all;
//   * it needs a *place*, so it can say nothing until it knows where the user is.
//
// The requirement: no exact identification of a stop is needed — leaving the
// lodging and walking around a neighbourhood is trigger enough to ask or
// suggest something.
//
// So this sensor tracks a STATE (the user is out, away from wherever they have
// been sitting) rather than an EDGE, and it needs to identify nothing.
//
// ── Free sources only, history only ────────────────────────────────────────
//
// This sensor used to survey Google Places (two text searches) every 150 m /
// 12 min while the user was out — a large share of the lane's cost, mostly for
// surveys that woke nothing. Venue recommendations are ask-first now (the
// `meal_offer` lane; Google only after a yes), so the raw-material check is
// "is there a Wikipedia/OSM subject within 300 m not yet told"
// (lib/local-lore.mjs): free, cached per cell, and the same material the
// `nearby` lane will speak from. No Google call remains here;
// tests/hum-no-places.test.mjs enforces it.
//
// ── Why it looks up places, when sensors are supposed to be dumb ───────────
//
// The contract says a sensor reports that the world moved and never reasons
// about whether the user should be pinged. This one holds to that: "there are
// places within 400m that hum has not surfaced" IS a fact about the world
// moving — new ground with unexplored options — not a judgement about whether
// to speak. That judgement stays where it belongs, in the `nearby` harvester's
// model call, which is told to default to silence.
//
// The reason to do it here is cost, and it is the whole point of the design:
// what matters is not the number of pings but whether there is anything
// relevant to say, and checking on every GPS fix is fine. Checking every GPS
// fix is right and cheap. Waking an agent turn every GPS fix is not. Doing the
// geometry and the raw-material check here means the expensive half only runs
// when there is something to judge, and a walk with nothing worth saying costs
// nothing at all — no turn, no tokens, no ping.

import { createRequire } from "node:module";
import { event, shJson, sh, BIN, DATA } from "./_common.mjs";
import { localLore } from "../../../lib/local-lore.mjs";
import { PROXIMITY_M } from "../../../lib/local-history-ledger.mjs";

export const meta = {
  name: "excursion",
  lanes: ["nearby", "location_context", "situation"],
};

// The user is "out" once this far from the anchor. ~370m separated the airbnb from
// the vet, so 250 comfortably catches a walk of that shape while ignoring the
// GPS jitter that happens while the user sits still.
const OUT_RADIUS_M = 250;
// A place the user has been sitting for this long is a base, not a stop. Overnight
// that resolves to the airbnb; after lunch it becomes the restaurant — which is
// correct, and means this needs no notion of "home" while travelling.
const ANCHOR_DWELL_MIN = 30;
// How far the user must move before the surroundings are a genuinely different
// question. NOT a rate limit — standing still simply does not change the
// answer, so re-querying the same 400m circle would return the same places.
// Before 2026-10-20: 150 m / 12 min, sized for paid searches. The survey is
// free and cell-cached now, and the subjects are only worth telling within
// 300 m, so it looks again sooner.
const RESURVEY_M = 100;
// ...and a floor so a jittery fix can't re-survey in a tight loop.
const RESURVEY_MIN = 6;
// Beyond this the newest fix is not a position, it is a memory. Geometry over
// a stale fix silently produces confident nonsense.
const STALE_FIX_MIN = 25;

export default async function detect(ctx) {
  const { memo, setMemo, nowMs } = ctx;

  const rows = await recentRows();
  if (!rows.length) throw new Error("location_history returned no rows — source unreachable");

  // ── is the feed even alive? ──────────────────────────────────────────────
  //
  // Everything below is geometry over the newest fix, and geometry over an
  // hour-old fix is fiction. Once the feed went quiet while the user walked
  // back to the lodging — 370m, entirely unrecorded — and the sensor happily
  // reasoned from the stale position and reported no error at all.
  //
  // THROWS rather than returning [], per the sensor contract: "nothing
  // happened" and "I can't see" must not look alike, and a blind sensor that
  // reports success is exactly the failure mode that hid this.
  const lastFixMs = newestFixMs(rows);
  const staleMin = (nowMs - lastFixMs) / 60000;
  // Usually this is the phone having nothing new to say (asleep, an hour in a
  // cafe), so it recurs every minute until the user moves. `repeat_key` tells the
  // daemon each minute's throw is the same error despite the changing age, so
  // hum-sense.log records it once (plus an hourly reminder) instead of once a
  // minute; `last_error` in status still shows it on every run.
  if (!Number.isFinite(lastFixMs) || staleMin > STALE_FIX_MIN) {
    const err = new Error(`location feed stale — newest fix is ${Math.round(staleMin)}m old (> ${STALE_FIX_MIN}m); position unknown`);
    err.repeat_key = "location_feed_stale";
    throw err;
  }

  const now = rows[0];
  const lat = num(now.latitude), lon = num(now.longitude);
  if (lat == null || lon == null) {
    setMemo({ ...memo, probed_at: new Date(nowMs).toISOString() });
    return [];
  }

  // ── the anchor: the last place the user sat still ───────────────────────
  const anchor = findAnchor(rows, nowMs);
  const fromAnchor = anchor ? haversineM(lat, lon, anchor.lat, anchor.lon) : null;

  // Back at base → the outing is over. Reset so the next one starts clean.
  if (fromAnchor != null && fromAnchor < OUT_RADIUS_M * 0.6) {
    setMemo({ probed_at: new Date(nowMs).toISOString(), surveyed: memo?.surveyed || [] });
    return [];
  }
  if (fromAnchor == null || fromAnchor < OUT_RADIUS_M) {
    setMemo({ ...memo, probed_at: new Date(nowMs).toISOString() });
    return [];
  }

  // ── has anything actually changed since the last survey? ─────────────────
  const lastPos = memo?.last_survey;
  if (lastPos) {
    const moved = haversineM(lat, lon, lastPos.lat, lastPos.lon);
    const mins = (nowMs - new Date(lastPos.at).getTime()) / 60000;
    if (moved < RESURVEY_M || mins < RESURVEY_MIN) {
      // Same circle, same answer. Record that we DID look, so an idle sensor
      // can still be told from a broken one.
      setMemo({ ...memo, probed_at: new Date(nowMs).toISOString() });
      return [];
    }
  }

  // ── the free raw-material check ──────────────────────────────────────────
  // Subjects within PROXIMITY_M not yet told (the ledger already
  // removed what was already said), minus what this outing already raised.
  let found = [];
  try { found = localLore(lat, lon, { radiusM: PROXIMITY_M }).items; } catch { found = []; }
  const already = new Set(memo?.surveyed || []);
  const fresh = found.filter((p) => !p.ids.some((id) => already.has(id)));

  const survey = { lat, lon, at: new Date(nowMs).toISOString() };
  if (!fresh.length) {
    // Nothing here not already offered. No event, no agent turn,
    // no ping — and this is the common case, by design.
    setMemo({ ...memo, last_survey: survey, probed_at: survey.at });
    return [];
  }

  setMemo({
    last_survey: survey,
    probed_at: survey.at,
    surveyed: [...already, ...fresh.flatMap((p) => p.ids)].slice(-300),
  });

  const where = now.place_name || now.address || "the neighbourhood";
  return [event("excursion", "out_and_about", {
    subject: where,
    summary: `Out around ${where} — ${fresh.length} local subject${fresh.length === 1 ? "" : "s"} within ${PROXIMITY_M}m not yet told`,
    // Same weight as a confirmed arrival: it is the same moment, caught earlier
    // and without needing to name the destination.
    salience: 0.62,
    lanes: ["nearby", "location_context", "situation"],
    // Keyed on the rounded position, so wandering back through the same block
    // inside the cooldown doesn't re-ask.
    dedup_key: `excursion:${lat.toFixed(3)},${lon.toFixed(3)}`,
    ttl_min: 20,
    cooldown_min: 25,
    perishable: true,
    data: {
      lat, lon,
      place: now.place_name || now.address || null,
      metres_from_base: Math.round(fromAnchor),
      base: anchor ? (anchor.place || "where the user had been sitting") : null,
      // Inferred from displacement, not the `activity` column — half of the
      // rows on the vet walk said "unknown", so `walking` is not reliable
      // enough to gate on. The harvester raises its relevance bar when the user is
      // moving: interrupting a walk needs to be worth more than interrupting a
      // man sitting down.
      moving: isMoving(rows, nowMs),
      candidates: fresh.slice(0, 8).map((p) => ({ name: p.title, source: p.source, distance: p.distance_m })),
    },
  })];
}

// ── helpers ────────────────────────────────────────────────────────────────

const { supabaseUrl } = createRequire(import.meta.url)("../../../lib/instance.cjs");
const SUPABASE_URL = process.env.SUPABASE_URL || supabaseUrl();

async function recentRows() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing — cannot see location");
  if (!SUPABASE_URL) throw new Error("no Supabase project configured — cannot see location");
  const since = new Date(Date.now() - 8 * 3600 * 1000).toISOString();
  const qs = new URLSearchParams({
    or: `(arrived_at.gte.${since},created_at.gte.${since})`,
    order: "arrived_at.desc",
    limit: "120",
    select: "id,segment_type,place_name,address,latitude,longitude,arrived_at,departed_at",
  });
  const raw = await sh("curl", [
    "-s", "--max-time", "8",
    "-H", `apikey: ${key}`, "-H", `Authorization: Bearer ${key}`,
    `${SUPABASE_URL}/rest/v1/location_history?${qs}`,
  ], { timeout: 10000 });
  if (!raw) throw new Error("location_history query returned nothing — source unreachable");
  let rows;
  try { rows = JSON.parse(raw); } catch { throw new Error(`location_history returned non-JSON: ${raw.slice(0, 80)}`); }
  if (!Array.isArray(rows)) throw new Error("location_history returned a non-array");
  return rows.filter((r) => num(r.latitude) != null);
}

/**
 * The last position the user held for ANCHOR_DWELL_MIN or more. Prefers a real visit
 * row; falls back to the oldest fix on hand so a day with no confirmed visit
 * still has something to measure displacement against.
 */
function findAnchor(rows, nowMs) {
  // Dwell on an OPEN visit is measured to the last fix we actually have, never
  // to the wall clock. A visit row that is never closed otherwise accrues
  // unbounded dwell and eventually outranks everything: a stop opened at 16:59
  // and the feed died at 17:15, so by 18:25 it claimed an 85-minute dwell and
  // became "base" — while the user was back at the lodging, 370m away. The
  // honest figure was 16 minutes, which is under the threshold, and the lodging
  // (100 real minutes) would have stayed the anchor.
  const lastFixMs = newestFixMs(rows);
  for (const r of rows) {
    if (r.segment_type !== "visit") continue;
    const arrived = new Date(r.arrived_at).getTime();
    if (!Number.isFinite(arrived)) continue;
    const left = r.departed_at ? new Date(r.departed_at).getTime() : lastFixMs;
    if ((left - arrived) / 60000 < ANCHOR_DWELL_MIN) continue;
    return { lat: num(r.latitude), lon: num(r.longitude), place: r.place_name || r.address || null };
  }
  void nowMs;
  const oldest = rows[rows.length - 1];
  if (!oldest) return null;
  return { lat: num(oldest.latitude), lon: num(oldest.longitude), place: null };
}

/** The most recent moment we actually have a position for. */
function newestFixMs(rows) {
  let newest = -Infinity;
  for (const r of rows) {
    for (const t of [r.arrived_at, r.departed_at]) {
      const ms = new Date(t).getTime();
      if (Number.isFinite(ms) && ms > newest) newest = ms;
    }
  }
  return newest;
}

/** Has the user covered ground in the last ~6 minutes? Displacement, not the label. */
function isMoving(rows, nowMs) {
  const cur = rows[0];
  const curLat = num(cur?.latitude), curLon = num(cur?.longitude);
  if (curLat == null || curLon == null) return false;
  for (const r of rows) {
    const t = new Date(r.arrived_at).getTime();
    if (!Number.isFinite(t)) continue;
    const ageMin = (nowMs - t) / 60000;
    if (ageMin < 4 || ageMin > 12) continue;
    const la = num(r.latitude), lo = num(r.longitude);
    if (la == null || lo == null) continue;
    return haversineM(curLat, curLon, la, lo) > 120;
  }
  return false;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

void shJson; void DATA; void BIN;
