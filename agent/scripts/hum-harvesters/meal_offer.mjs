#!/usr/bin/env node
// meal_offer — ASK before recommending anywhere to eat.
//
// The requirement: ask generically ("would you like a restaurant
// recommendation for lunch?") and search for one only on a yes. Unprompted
// restaurant picks were mostly snoozed, deferred or ignored, while the Places
// searches that fed them on every hum tick were most of the Places bill.
//
// So this lane makes NO Google call. It offers, at most once per meal window,
// when the user is out (not home) at a mealtime. A yes is read by the chat-agent
// (a language judgment, Rule #0b) which runs `bin/meal-pick --ping-id
// <id>` — the only hum-adjacent path allowed to search Places — and replies
// with one to three picks.
//
// Code decides only: is it a meal window, is the user away from home with a
// fresh enough fix, was this window already offered today. Whether it is a
// good moment (mid-meeting, already eaten) is the ranker's call.
//
// Per installation (agent/local/config/meals.json): `windows` (meal, local
// hours from/to, the offer's wording), `offer_wording` ({meal: text}, to
// reword a default window's offer) and `home_labels` (lowercase substrings of
// the situation's place label that mean "at home": no offer there).

import path from "node:path";
import { createRequire } from "node:module";
import { readStdinJson, emit, emitNoop, emitNull } from "./_common.mjs";
import { readFeedbackRows, localDateIn } from "../../../lib/ping-budget.mjs";

const { instance, localConfig } = createRequire(import.meta.url)("../../../lib/instance.cjs");
const CFG = localConfig("meals", {
  windows: [
    { meal: "lunch", from: 11.75, to: 14.5, ask: "Want a lunch spot nearby? Say yes and I'll find a couple within walking distance." },
    { meal: "dinner", from: 18.0, to: 20.5, ask: "Want a dinner spot nearby, within a short walk?" },
  ],
  home_labels: ["home ("],
  offer_wording: {},
});

const TOPIC = "meal_offer";
const MAX_FIX_AGE_MIN = 45;

// Local-hour windows (default: lunch and dinner; no breakfast offer).
export const MEAL_WINDOWS = (Array.isArray(CFG.windows) ? CFG.windows : [])
  .filter((w) => w && w.meal && Number.isFinite(Number(w.from)) && Number.isFinite(Number(w.to)))
  .map((w) => ({ meal: w.meal, from: Number(w.from), to: Number(w.to),
    ask: CFG.offer_wording?.[w.meal] || w.ask || `Want a ${w.meal} spot nearby?` }));

export function mealWindow(hourFloat) {
  return MEAL_WINDOWS.find((w) => hourFloat >= w.from && hourFloat < w.to) || null;
}

export function alreadyOffered(rows, { date, meal, tz }) {
  return (rows || []).some((r) => r?.lane === TOPIC
    && (r.findings?.[0]?.supporting_data?.meal === meal)
    && r.sent_at && localDateIn(tz, r.sent_at) === date);
}

export function isHome(p, labels = CFG.home_labels) {
  const s = String(p || "").toLowerCase();
  // The installation's own canonical place labels (code-assigned), not anything the user typed.
  return (Array.isArray(labels) ? labels : []).some((l) => l && s.includes(String(l).toLowerCase()));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const { situation: sit } = await readStdinJson();
  const tz = sit?.time?.tz || instance().tz;
  const now = new Date();
  const hm = Number(now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }))
    + Number(now.toLocaleString("en-US", { timeZone: tz, minute: "numeric" })) / 60;
  const w = mealWindow(hm);
  if (!w) { emitNoop(`not a meal window (${hm.toFixed(2)} local)`); process.exit(0); }

  const place = sit?.where?.place || "";
  if (isHome(place)) { emitNoop(`at home (${place}) — no offer`); process.exit(0); }
  const lat = Number(sit?.where?.lat), lon = Number(sit?.where?.lon);
  const fixAge = Number(sit?.environment?.phone_context_age_min);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) { emitNull("no position"); process.exit(0); }
  if (!Number.isFinite(fixAge) || fixAge > MAX_FIX_AGE_MIN) { emitNoop(`fix too old (${fixAge}m)`); process.exit(0); }

  const date = localDateIn(tz, now);
  if (alreadyOffered(readFeedbackRows(), { date, meal: w.meal, tz })) {
    emitNoop(`${w.meal} already offered today`);
    process.exit(0);
  }

  emit({
    topic: TOPIC,
    signal: w.ask,
    urgency: 0.5,
    freshness_min: Math.round(fixAge),
    dedup_key: `meal_offer:${date}:${w.meal}`,
    supporting_data: {
      kind: "offer",
      meal: w.meal,
      lat, lon, near_place: place || null,
      // For the chat-agent: what a yes means. No search has run; none runs
      // unless the user says yes.
      on_yes: "bin/meal-pick --ping-id <this ping id>",
      evidence_as_of: "live",
      // geo-gate-ok: an offer about wherever the user is right now.
    },
    act_fit: { effort_to_act: "quick_win" },
    temporal_fit: {
      relative_to: "daypart",
      anchor: `meal:${w.meal}`,
      expires_after_iso: new Date(Date.now() + 45 * 60000).toISOString(),
    },
  });
}
