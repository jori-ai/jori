// travel — the city changed.
//
// The single biggest situational shift Jori can observe. Every place-bound
// lane (dining, art, talks, experiences, …) is scoped by "where is the user
// today", so a metro change invalidates and re-arms all of them at once — which
// is exactly what the `lanes` list on this event tells the playbook to do.
//
// Reads the canonical travel timeline (`travel where`), not GPS: the timeline
// is authoritative for presence, and it knows about a city change before the
// phone does. See the travel-schedule skill.

import { event, shJson, BIN } from "./_common.mjs";
import path from "node:path";
import { createRequire } from "node:module";

// The lanes a city change re-arms: the generic place-bound ones, plus any
// installation lane listed in agent/local/config/travel.json
// `extend_metro_change_lanes`.
const { localConfig } = createRequire(import.meta.url)("../../../lib/instance.cjs");
const METRO_CHANGE_LANES = localConfig("travel", {
  metro_change_lanes: ["travel", "dining", "experiences", "art", "talks", "situation"],
}).metro_change_lanes;

export const meta = { name: "travel", lanes: ["travel", "dining", "experiences", "art", "talks", "situation"] };

export default async function detect(ctx) {
  const { memo, setMemo } = ctx;
  const where = await shJson(path.join(BIN, "travel"), ["where", "now", "--json"], { timeout: 15000 });
  const metro = where?.metro || null;
  if (!metro) return [];

  const out = [];
  if (memo?.metro && memo.metro !== metro) {
    out.push(event("travel", "metro_change", {
      subject: metro,
      summary: `Now in ${metro} (was ${memo.metro})`,
      // High enough to clear the refractory window: everything hum knows about
      // where the user is has just changed, and stale place-bound suggestions are the
      // most embarrassing kind.
      salience: 0.85,
      lanes: METRO_CHANGE_LANES,
      dedup_key: `travel:metro:${metro}`,
      ttl_min: 180,
      cooldown_min: 12 * 60,
      data: { metro, previous: memo.metro, label: where.label || null, source: where.source || null },
    }));
  }

  setMemo({ metro, label: where.label || null });
  return out;
}
