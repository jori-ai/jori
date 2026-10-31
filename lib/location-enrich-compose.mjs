// location-enrich-compose — the composition half of location-enrich, moved out
// of the agent turn.
//
// WHY: the location-enrich agent turn re-read the ~140k-token context floor to
// write ONE sentence per stop, ~32 times a day ($188 in 14 days). Everything around that sentence is arithmetic the gate already
// does (lib/location-enrich-gate.mjs writes local times, buckets and the
// movement flag into location-enrich-brief.json). What is left is language:
// turn a stop's signals into a human question. That is one batched,
// schema-validated model call — house ladder, local Gemma first, Sonnet low
// only for what fails validation — not an agent session.
//
// Division of labour (Rule #0b):
//   CODE   — which stops to compose, calendar overlap (time arithmetic), the
//            stage-`identify` list (a fixed template), grounding: the model's
//            hypothesis must be one of the candidate ids we gave it, the
//            framing must agree with the movement flag, the HH:MM it quotes must
//            be one we computed. Code queues the result.
//   MODEL  — the sentence.
//   AGENT  — only the residue: a stop with a calendar event in its window (the
//            ticket / confirmation-email lookup in jobs/location-enrich.md needs
//            Gmail and judgment), or a stop no rung could phrase validly.
//
// Nothing here sends. Composed asks go to location-ask-queue.json and hum
// decides whether they ship, exactly as the agent path did.
//
// Config — agent/local/config/location-ask.json (optional; with none, no
// companion is named in a question):
//   partner        the companion a question may name naturally ("lunch with
//                  <partner>?") when the stop's companions include them
//   never_mention  companions a question never names (e.g. a pet)

import { instance, localConfig } from "./instance.cjs";

export const ASK_CONFIG = localConfig("location-ask", { partner: "", never_mention: [] });

export const MAX_CANDIDATES = 5;
export const MIN_MSG_CHARS = 20;
export const MAX_MSG_CHARS = 320;
// A calendar block longer than this is a container ("<island day trip>"
// 09:45–12:45, "Stay at X"), background context rather than a candidate answer
// — narrating one produced a wrong question. Shorter timed events are specific
// enough that the agent should look at them (a concert ticket, for one).
export const CONTAINER_EVENT_MIN = 180;
export const CAL_PAD_MS = 15 * 60 * 1000;

export const FRAMINGS = ["venue", "walking", "neutral"];

// ── The priority lane ─────────────────────────────────────────────────────
//
// Composing an ask used to end at the queue, and the queue only drained when
// SOMETHING ELSE woke hum: an arrival, a meeting ending, or the idle tick that
// "has waited 75 minutes already" (hum-events buildPayload). On a quiet
// afternoon nothing did, so a question composed 20 minutes after the user left
// a café sat until the next unrelated tick — a breakfast ask (stop
// 10:21–10:40) went out at 13:43. The queue was never the slow part; the
// missing wake-up was.
//
// So a NEW ask now wakes hum itself: one perishable `location.ask_ready` event
// into the hum-sense spool. Perishable is what makes buildPayload send it as
// `hum:moment`, and `hum:*` is what the supervisor's dispatcher already
// inserts ahead of every queued cron job (supervisor/dispatcher.mjs
// isHighPriority) — the existing priority lane, reused rather than duplicated;
// nothing else's ordering changes. The event names only `location_context`, so
// the harvest focuses on the queued question, and the harvester marks the
// candidate `priority_lane` so the ranker ships it rather than letting it lose
// a tie to a factoid (jobs/hum.md rule 3a).
//
// Urgent since 2026-10-29 (the user: "Location questions are always urgent - I
// should receive those as soon as they're conceived"): the salience is the
// gate's urgent level (hum-events DEFAULT_CONFIG.urgent_salience), so a meeting,
// an outstanding hum question and the refractory no longer hold it. Quiet hours
// still do; nothing here can wake the user at night.
export const ASK_READY_SALIENCE = 0.9;
export const ASK_READY_TTL_MIN = 40;

export function askReadyEvent(item) {
  const id = String(item?.visit_id ?? "");
  const when = item?.departed_local || item?.arrived_local || null;
  return {
    sensor: "location",
    type: "location.ask_ready",
    subject: id,
    summary: `A question is ready about the stop${when ? ` that ended ${when}` : ""}`,
    salience: ASK_READY_SALIENCE,
    lanes: ["location_context"],
    // One wake per stop: a re-compose of the same visit is not a new moment.
    dedup_key: `location:ask_ready:${id}`,
    ttl_min: ASK_READY_TTL_MIN,
    cooldown_min: 24 * 60,
    perishable: true,
    data: { visit_id: id },
  };
}

/** Candidate list with stable ids the model must cite. */
export function candidateList(p) {
  return (p?.candidates || [])
    .filter((c) => c && (c.name || c.place_name))
    .slice(0, MAX_CANDIDATES)
    .map((c, i) => ({
      id: `c${i + 1}`,
      name: String(c.name || c.place_name),
      type: c.type || c.primary_type || null,
      rating: Number.isFinite(Number(c.rating)) ? Number(c.rating) : null,
      distance_m: Number.isFinite(Number(c.distance_m)) ? Math.round(Number(c.distance_m)) : null,
    }));
}

/** Join the gate's brief (code-computed features) with the pending rows. */
export function buildItems(brief, pending) {
  const byId = new Map((pending || []).map((p) => [String(p.visit_id ?? p.id ?? ""), p]));
  const items = [];
  for (const s of brief?.stops || []) {
    const p = byId.get(String(s.visit_id));
    if (!p) continue;
    items.push({
      ...s,
      arrived_at: p.arrived_at || null,
      departed_at: p.departed_at || null,
      companions: p.companions || [],
      candidates: candidateList(p),
    });
  }
  return items;
}

function evTime(v) {
  const t = Date.parse(v?.dateTime || "");
  return Number.isFinite(t) ? t : null;
}

/**
 * Timed, opaque events overlapping the stop window (±15 min) that are not
 * containers. All-day events have no dateTime and drop out here.
 */
export function calendarBlockers(item, events) {
  const a = Date.parse(item.arrived_at || "");
  const d = Date.parse(item.departed_at || "");
  if (!Number.isFinite(a) || !Number.isFinite(d)) return [];
  const lo = a - CAL_PAD_MS;
  const hi = d + CAL_PAD_MS;
  return (events || []).filter((e) => {
    const s = evTime(e.start);
    const en = evTime(e.end);
    if (s == null || en == null) return false;
    if ((e.transparency || "opaque") === "transparent") return false;
    if ((en - s) / 60000 > CONTAINER_EVENT_MIN) return false;
    return s < hi && en > lo;
  });
}

/** Stage `identify` (he already said yes): the fixed list from the playbook. */
export function identifyMessage(item) {
  const when = item.arrived_local || "then";
  const head = item.food_heavy
    ? `Which place did you stop at around ${when}? And what did you order / how was it?`
    : `Which place did you stop at around ${when}?`;
  const lines = item.candidates.map((c, i) => {
    const bits = [c.type, c.rating != null ? `${c.rating}★` : null, c.distance_m != null ? `${c.distance_m}m` : null]
      .filter(Boolean).join(" · ");
    return `${i + 1}. ${c.name}${bits ? ` — ${bits}` : ""}`;
  });
  const tail = item.food_heavy
    ? `Reply with the number, a name, or "none of the above".`
    : `Which one, and what were you up to?`;
  return [head, "", ...lines, "", tail].join("\n");
}

export const ASK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["asks"],
  properties: {
    asks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["visit_id", "hypothesis_candidate_id", "framing", "message"],
        properties: {
          visit_id: { type: "string" },
          hypothesis_candidate_id: { type: ["string", "null"] },
          framing: { type: "string", enum: FRAMINGS },
          message: { type: "string" },
        },
      },
    },
  },
};

/** The companion rule lines for the prompt, from the config. */
function companionRules({ partner, never_mention: never } = ASK_CONFIG) {
  const lines = [];
  if (partner) lines.push(`- with_partner true → mention ${partner} naturally ("lunch with ${partner}?").`);
  const quiet = (Array.isArray(never) ? never : []).filter(Boolean);
  if (quiet.length) lines.push(`- Never mention ${quiet.join(" or ")}.`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function systemPrompt({ who = instance().owner_name, config = ASK_CONFIG } = {}) {
  return `You write the one-sentence question Jori asks ${who} (below: "the user") about a place the user just stopped at, shortly after leaving it. Jori is the user's assistant and sounds like a caring, observant person who noticed — never a sensor that logged. Each question states a real hypothesis and gives the user a cheap out.

For each stop you get code-computed facts: arrived_local / departed_local (HH:MM, already in the user's timezone), duration_min, time_of_day, meal_word, duration_shape, movement_led, drift_m, with_partner, food_heavy, top_candidate_confident, and candidates (id, name, type, rating, distance_m).

Rules:
- Quote time ONLY as the exact arrived_local or departed_local string given. Never convert or reformat it.
- Grounding: every specific detail must come from the given facts. Never invent what the user was doing, waiting for, or headed to. If nothing explains the stop, ask neutrally: "<M>m near <candidate> at <HH:MM> — what was that?"
- movement_led true: lead with the walking-around hypothesis and offer the top candidate as the alternative ("…GPS shows you drifting ~<drift_m>m the whole time — just walking around, or did you actually stop (say, for <candidate>)?"). framing must be "walking".
- top_candidate_confident true: state the top candidate as the hypothesis. Otherwise soften: "near <candidate> — was that it, or somewhere nearby?".
- Use the candidate type for framing: restaurant/cafe/bar → the meal; museum/gallery/garden/theater → the visit; doctor/dentist/hospital → neutral "appointment?"; train/bus station → transit or a real stop.
- meal_word: if set, that is the only meal word you may use (it comes from the stop's own start time); if null, name no meal at all (no breakfast/lunch/dinner/brunch) and ask about the place or visit instead.
${companionRules(config)}- food_heavy true → lead with the meal question.
- No "Reply: yes / no" menus, no bullet lists, no emoji, no markdown, no exclamation marks, no coordinates. One or two sentences, under 300 characters.
- Never the generic "You appeared stationary ~X near Y — real stop or just a pause?".

Return JSON only: {"asks":[{"visit_id":"…","hypothesis_candidate_id":"c1" or null,"framing":"venue"|"walking"|"neutral","message":"…"}]} — one entry per stop given, visit_id copied exactly. hypothesis_candidate_id is the id of the candidate your question proposes, or null for a neutral or walking-led question that proposes none. If you name a candidate as the hypothesis, its name must appear in the message.

Examples of the tone (do not copy):
- 55 min, lunch, Noodle Village (Restaurant, 4.5★, 12m), confident: "Was Noodle Village your 13:10 lunch? ~55m there. If not, what was it — or just a pause?"
- 22 min, 15:40, East 233rd Dental (Dentist, 18m): "22m near East 233rd Dental at 15:40 — appointment? If not, what were you up to?"
- 24 min, movement_led, drift 129m, Le Petit Marché: "24m near the market around 10:56, but GPS shows you drifting ~130m the whole time — just walking around, or did you actually stop somewhere (Le Petit Marché, maybe)?"`;
}

export const SYSTEM_PROMPT = systemPrompt();

/** Meal word from the stop's OWN start time (the gate's time_of_day bucket,
 *  itself computed from arrived_local). Anything outside lunch/dinner gets no
 *  meal word, so the model cannot name a meal that does not fit the clock. */
export function mealWord(item) {
  if (item?.time_of_day === "lunch") return "lunch";
  if (item?.time_of_day === "dinner") return "dinner";
  return null;
}

/** The compact per-stop facts handed to the model — nothing it could misuse. */
export function promptFacts(item) {
  return {
    visit_id: item.visit_id,
    arrived_local: item.arrived_local,
    departed_local: item.departed_local,
    duration_min: Number.isFinite(item.duration_min) ? Math.round(item.duration_min) : item.duration_min,
    time_of_day: item.time_of_day,
    meal_word: mealWord(item),
    duration_shape: item.duration_shape,
    movement_led: item.movement_led,
    drift_m: item.drift_m != null ? Math.round(item.drift_m) : null,
    with_partner: !!item.with_partner,
    food_heavy: !!item.food_heavy,
    top_candidate_confident: !!item.top_candidate_confident,
    candidates: item.candidates,
  };
}

export function userPrompt(items) {
  return `Stops to ask about:\n${JSON.stringify(items.map(promptFacts), null, 1)}\n\nReturn the JSON object now.`;
}

/**
 * Structural validation of one model answer against the stop it claims to be
 * about. Returns null when valid, else the reason. No language interpretation:
 * id membership, an enum, lengths, and whether two strings we produced appear.
 */
export function checkAsk(ask, item) {
  if (!ask || typeof ask !== "object") return "not an object";
  const msg = typeof ask.message === "string" ? ask.message.trim() : "";
  if (msg.length < MIN_MSG_CHARS) return "message too short";
  if (msg.length > MAX_MSG_CHARS) return "message too long";
  if (!FRAMINGS.includes(ask.framing)) return "framing not in enum";
  const hyp = ask.hypothesis_candidate_id ?? null;
  if (hyp !== null) {
    const c = item.candidates.find((x) => x.id === hyp);
    if (!c) return `hypothesis ${hyp} is not one of the candidates`;
    if (!msg.toLowerCase().includes(c.name.toLowerCase())) return "hypothesis candidate not named in message";
  }
  if (item.movement_led === true && ask.framing !== "walking") return "movement_led stop not framed as walking";
  const times = [item.arrived_local, item.departed_local].filter(Boolean);
  if (times.length && !times.some((t) => msg.includes(t))) return "message does not quote the computed local time";
  return null;
}

/**
 * @returns {{ valid: Map<string, object>, invalid: Map<string, string> }}
 *   keyed by visit_id; a stop the model skipped is invalid ("missing").
 */
export function validateAsks(raw, items) {
  const valid = new Map();
  const invalid = new Map();
  const byId = new Map(items.map((i) => [String(i.visit_id), i]));
  const asks = Array.isArray(raw?.asks) ? raw.asks : [];
  for (const a of asks) {
    const id = String(a?.visit_id ?? "");
    const item = byId.get(id);
    if (!item || valid.has(id)) continue;
    const why = checkAsk(a, item);
    if (why) invalid.set(id, why);
    else valid.set(id, { ...a, visit_id: id, message: a.message.trim() });
  }
  for (const id of byId.keys()) {
    if (!valid.has(id) && !invalid.has(id)) invalid.set(id, "missing from model output");
  }
  return { valid, invalid };
}
