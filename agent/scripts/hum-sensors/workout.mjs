// workout — a session in the workout tracker just finished.
//
// One of the highest-value curiosity moments hum has: the user has just done
// the thing, the details are still fresh, and one question ("how did the press
// feel?") buys a lot of future precision. It is also the moment when
// recovery/food/schedule suggestions actually land.
//
// The tracker is the CLI named by agent/local/config/exercise.json
// `tracker_bin` (lib/exercise-config.cjs); without one the sensor is off.

import { event, shJson, minsSince } from "./_common.mjs";
import { createRequire } from "node:module";

const { exerciseConfig } = createRequire(import.meta.url)("../../../lib/exercise-config.cjs");

export const meta = { name: "workout", lanes: ["exercise", "health", "situation", "dining"] };

export default async function detect(ctx) {
  const { memo, setMemo, nowMs } = ctx;
  const tracker = exerciseConfig().tracker;
  if (!tracker) return [];
  // `<tracker> today --json` returns {plan, session:{all_today, matching_plan,
  // completed, in_progress, last}} — NOT a bare array and NOT {sessions}.
  // The first version of this sensor guessed the latter two and would have
  // silently never fired (caught on first live verification).
  const today = await shJson(tracker, ["today", "--json"], { timeout: 12000 });
  const sessions = today?.session?.all_today
    ?? (Array.isArray(today) ? today : today?.sessions)
    ?? [];
  const finished = sessions.filter((s) => s?.finished_at).sort((a, b) => new Date(b.finished_at) - new Date(a.finished_at));
  const latest = finished[0] || null;
  // Distinguish "probed fine, nothing done today" from "the probe failed" —
  // otherwise a rest day is indistinguishable from a broken sensor in the
  // memo, which is exactly how the shape bug above stayed invisible.
  if (!latest) {
    if (today) setMemo({ session_id: null, probed_at: new Date(nowMs).toISOString(), sessions_today: sessions.length });
    return [];
  }

  const out = [];
  const isNew = latest.id !== memo?.session_id;
  // Only a genuinely fresh finish is a moment — a session that ended two hours
  // ago is history, and re-surfacing it after a daemon restart is noise.
  if (isNew && minsSince(latest.finished_at, nowMs) < 25) {
    out.push(event("workout", "finished", {
      subject: latest.workout_type || "workout",
      summary: `Just finished a ${String(latest.workout_type || "workout").replace(/_/g, " ")} session`,
      salience: 0.6,
      lanes: ["exercise", "health", "dining", "situation"],
      dedup_key: `workout:finished:${latest.id}`,
      ttl_min: 40,
      cooldown_min: 180,
      data: { id: latest.id, workout_type: latest.workout_type, gym_used: latest.gym_used ?? null, finished_at: latest.finished_at },
    }));
  }

  setMemo({ session_id: latest.id });
  return out;
}
