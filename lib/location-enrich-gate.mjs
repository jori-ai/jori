// location-enrich-gate — decides, in code, whether a location-enrich dispatch
// has anything to do. Called by agent/scripts/trigger-location-enrich.sh.
//
// WHY: the old inline gate counted a stop as askable when
// `!asked && ready_at<=now && ended<12h`. `asked` only flips when hum-ping
// actually SENDS the question, and a composed ask can sit in
// location-ask-queue.json for hours losing its hum tick (or be refused by
// hum-ping's 3/day cap). Every 15 minutes the gate therefore woke a full agent
// turn that read the ~140k-token floor, saw the stop was already queued, and
// did nothing — 165 dispatches / ~$61 in three days.
//
// A stop already sitting in the ask queue is only askable again when the
// signals the ask was composed from have CHANGED (a new candidate set, a
// different stage, a movement pattern flip). Those signals are machine-
// generated fields on the pending row, so hashing them is structure, not
// language. The hash recorded for each queued visit lives in
// location-enrich-gate-state.json.

import crypto from "node:crypto";
import { askTiming } from "./location-ask-queue.mjs";
import { instance, localConfig } from "./instance.cjs";

// The companion a question may name (agent/local/config/location-ask.json
// `partner`, see location-enrich-compose.mjs); none in a fresh install.
const PARTNER = String(localConfig("location-ask", { partner: "" }).partner || "").toLowerCase();

export const TWELVE_H_MS = 12 * 3600 * 1000;

/** The pending-row fields an ask is composed from. If none of these moved,
 *  recomposing produces the same question. */
export function signalHash(p) {
  const sig = {
    stage: p.stage || "confirm",
    candidates: (p.candidates || []).map((c) => [c.name || c.place_name || "", c.type || ""]),
    pattern: p.movement_evidence?.pattern || null,
    activity: p.movement_evidence?.dominant_activity || null,
    companions: [...(p.companions || [])].sort(),
    departed_at: p.departed_at || null,
  };
  return crypto.createHash("sha1").update(JSON.stringify(sig)).digest("hex").slice(0, 16);
}

/** Mirrors jobs/location-enrich.md's askable condition.
 *
 *  Also bounded by askTiming (2026-10-06): a stop too old to ask about (> 4h
 *  since the user left, or an earlier local day) is not composed at all. Without
 *  this the harvester would drop the stale ask from the queue, the pending row
 *  would still read asked:false within 12h, and this gate would recompose it
 *  every 15 minutes for the rest of the window. */
export function isAskable(p, now, tz = "UTC") {
  if (p.asked) return false;
  const ready = !p.ready_at || new Date(p.ready_at).getTime() <= now;
  if (!ready) return false;
  const endMs = p.departed_at
    ? new Date(p.departed_at).getTime()
    : (p.ready_at ? new Date(p.ready_at).getTime() - 15 * 60 * 1000 : now);
  if ((now - endMs) > TWELVE_H_MS) return false;
  const t = askTiming({ stop_started_at: p.arrived_at || null, stop_ended_at: new Date(endMs).toISOString() },
    { nowMs: now, tz });
  return t.verdict !== "drop";
}

/**
 * @param {object} a
 * @param {Array} a.pending   location-pending-enrich.json .pending
 * @param {Array} a.queue     location-ask-queue.json .queue
 * @param {object} a.state    { hashes: { visit_id: hash } }
 * @param {number} a.now
 * @param {string} a.tz       the user's IANA timezone (for askTiming's same-day test)
 * @returns {{ askable: string[], requeued: string[], skippedQueued: string[], state: object }}
 */
export function decide({ pending = [], queue = [], state = {}, now = Date.now(), tz = "UTC" }) {
  const queued = new Set(queue.map((e) => String(e.visit_id)));
  const prev = state.hashes || {};
  const hashes = {};
  const askable = [];
  const requeued = [];
  const skippedQueued = [];
  for (const p of pending) {
    const id = String(p.visit_id ?? p.id ?? "");
    if (!id || !isAskable(p, now, tz)) continue;
    const h = signalHash(p);
    if (!queued.has(id)) {
      askable.push(id);
      hashes[id] = h;               // remember what it will be composed from
      continue;
    }
    if (prev[id] && prev[id] !== h) {
      askable.push(id);             // signals moved since it was composed → recompose once
      requeued.push(id);
    } else {
      skippedQueued.push(id);
    }
    hashes[id] = h;
  }
  return { askable, requeued, skippedQueued, state: { hashes, updated_at: new Date(now).toISOString() } };
}

// ── Precomputed framing features ──────────────────────────────────────────
// The playbook used to have the model convert UTC → local HH:MM by hand (a
// recurring time-zone bug class) and bucket time-of-day / duration / movement
// itself. Those are arithmetic; code does them and the agent reads the brief.

/** The user's current tz: user-timezone.json unless missing or >30 days stale, else the home zone. */
export function resolveTz(tzFile, now = Date.now(), home = instance().tz) {
  const tz = tzFile?.timezone;
  if (!tz) return home;
  const upd = Date.parse(tzFile.updated_at || "");
  if (Number.isFinite(upd) && now - upd > 30 * 86400_000) return home;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return home; }
}

export function localHHMM(iso, tz) {
  const d = new Date(iso);
  if (!iso || !Number.isFinite(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

/** Playbook Step 2 signal 3 windows (local time). Overlaps resolve to the first match. */
export function timeOfDayBucket(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  const t = h * 60 + m;
  const inR = (a, b) => t >= a && t < b;
  if (inR(7 * 60, 9 * 60 + 30)) return "morning_coffee_or_walk";
  if (inR(12 * 60, 14 * 60 + 30)) return "lunch";
  if (inR(17 * 60 + 30, 20 * 60 + 30)) return "dinner";
  if (inR(20 * 60 + 30, 23 * 60)) return "show_bar_or_dinner";
  if (inR(9 * 60 + 30, 12 * 60) || inR(14 * 60 + 30, 17 * 60 + 30)) return "errand_appointment_or_visit";
  return "off_hours";
}

/** Playbook Step 2 signal 4. */
export function durationBucket(min) {
  if (!Number.isFinite(min)) return null;
  if (min < 20) return "errand_pickup_quick_coffee";
  if (min < 45) return "sit_down_coffee_quick_meal_haircut";
  if (min < 90) return "proper_meal_gym_appointment";
  return "full_visit_movie_long_meal";
}

const MOVING = new Set(["walking", "running", "cycling", "driving", "automotive"]);

/** Playbook Step 2 signal 7: either trigger flips the ask to walking-led. */
export function movementLed(me) {
  if (!me) return null; // no evidence either way
  return MOVING.has(me.dominant_activity) || me.pattern === "browse";
}

export function features(p, tz) {
  const arrived = localHHMM(p.arrived_at, tz);
  const top = (p.candidates || [])[0] || null;
  return {
    visit_id: String(p.visit_id),
    stage: p.stage || "confirm",
    tz,
    arrived_local: arrived,
    departed_local: localHHMM(p.departed_at, tz),
    duration_min: p.duration_min,
    time_of_day: timeOfDayBucket(arrived),
    duration_shape: durationBucket(p.duration_min),
    movement_led: movementLed(p.movement_evidence),
    drift_m: p.movement_evidence?.cluster_radius_m ?? null,
    with_partner: !!PARTNER && (p.companions || []).some((c) => String(c).toLowerCase() === PARTNER),
    food_heavy: !!p.food_heavy,
    top_candidate_confident: !!(top && Number(top.rating) >= 4.3 && Number(top.distance_m) <= 30),
  };
}
