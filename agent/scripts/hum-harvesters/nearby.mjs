#!/usr/bin/env node
// nearby — a local explanation of the ground the user is standing on.
//
// Local history only. Venue suggestions from Google Places were dropped from
// this lane: history and name-origin facts are what users react to, and the
// Places searches were most of the lane's cost. Venue recommendations are
// ASK-FIRST instead — the `meal_offer` lane asks, and only a yes runs a search
// (bin/meal-pick). Local explanations stay unprompted (as long as they are
// never repeats) and only while the user is within reach of the subject.
//
// So this lane makes ZERO Google Places calls. Its material is Wikipedia and
// OpenStreetMap within PROXIMITY_M of the user (lib/local-lore.mjs), with
// everything already told removed by identity and by position
// (lib/local-history-ledger.mjs). hum-ping re-checks the 300 m rule
// against the newest fix at send time, and ping-flush again if the motion gate
// parked the alert.
//
// Rule #0b: code resolves where the user is, what is within reach, how far,
// and what has already been said. The model decides whether any of it is worth
// saying and how to say it.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { readStdinJson, emit, emitNull, emitNoop, stampRun, localConfig, OWNER_NAME } from "./_common.mjs";
import { installTools } from "../../../lib/root.cjs";
import { localLore, renderLocalLoreBlock } from "../../../lib/local-lore.mjs";
import { PROXIMITY_M } from "../../../lib/local-history-ledger.mjs";
import { stashMedia } from "../../../lib/ping-media.mjs";
import { extractJsonObject } from "../../../lib/extract-json.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MODELS } = require("../../../lib/models.cjs");
const { textSync } = require("../../../lib/max-judge.js");

const TOPIC = "nearby";
const BIN = installTools("bin");
// Lowercase substrings of the situation's place label that mean "at home"
// (shared with meal_offer: agent/local/config/meals.json `home_labels`).
const HOME_LABELS = localConfig("meals", { home_labels: ["home ("] }).home_labels || ["home ("];

// Two clocks. An ARRIVAL moment is about the spot just reached; an AREA
// moment is about the neighbourhood the user has been in a while. Either way the
// 300 m delivery check is what actually keeps it current, so these only stop
// the harvester working from a fix that is plainly old.
// With the delivery-time distance check guarding relevance, a 15-minute
// arrival clock is safe (a tighter one left the lane structurally silent).
const MAX_ARRIVAL_AGE_MIN = 15;
const MAX_AREA_AGE_MIN = 45;

// The bar, in code. Lower than when this lane competed with venue suggestions
// for a shared slot: walking past the thing is the point.
const RELEVANCE_FLOOR = 0.55;

const { situation: sit, context: _context, moment, intent } = await readStdinJson();

// ── 1. Is there a moment? ───────────────────────────────────────────────
const events = Array.isArray(moment?.events) ? moment.events : [];
const locEvent = events.find((e) => e.type === "excursion.out_and_about")
  || events.find((e) => e.type === "location.arrival")
  || events.find((e) => e.type === "location.stopped_moving")
  || events.find((e) => String(e.type || "").startsWith("location."));
const areaMoment = locEvent ? null : areaMomentFrom(sit);
if (!locEvent && !areaMoment) {
  emitNoop("no location event and no fresh enough fix to call this an area moment");
  process.exit(0);
}
const IS_ARRIVAL = Boolean(locEvent);
const MOVING = IS_ARRIVAL ? locEvent?.data?.moving === true : areaMoment.moving;

const MAX_MOMENT_AGE_MIN = IS_ARRIVAL ? MAX_ARRIVAL_AGE_MIN : MAX_AREA_AGE_MIN;
if (moment?.perishable && Number.isFinite(moment.perishable_age_min)
    && moment.perishable_age_min > MAX_MOMENT_AGE_MIN) {
  emitNoop(`moment is ${Math.round(moment.perishable_age_min)}m old (> ${MAX_MOMENT_AGE_MIN}m) — too late to be useful`);
  process.exit(0);
}

// ── 2. Where, exactly ────────────────────────────────────────────────────
const lat = num(locEvent?.data?.lat) ?? num(sit?.where?.lat);
const lon = num(locEvent?.data?.lon) ?? num(sit?.where?.lon);
const place = locEvent?.data?.place || sit?.where?.place || locEvent?.subject || "";
if (lat == null || lon == null) { emitNull("no coordinates on the location event"); process.exit(0); }

// Home is not a discovery problem.
if (isHome(place)) { emitNoop(`at home (${place}) — nothing to explain`); process.exit(0); }

const hour = Number.isFinite(sit?.time?.local_hour) ? sit.time.local_hour : new Date().getHours();

// ── 3. What is within 300 m that has not been told yet (free, code) ──────
const lore = localLore(lat, lon, { radiusM: PROXIMITY_M, country: sit?.where?.country || null });
if (!lore.items.length) {
  stampRun(TOPIC, false);
  emitNoop(lore.told.length
    ? `everything within ${PROXIMITY_M}m already told (${lore.told.slice(0, 3).map((t) => t.title).join("; ")})`
    : `no Wikipedia/OSM subjects within ${PROXIMITY_M}m`);
  process.exit(0);
}
const sayable = lore.items.filter((i) => i.summary || Object.keys(i.facts || {}).length);
if (!sayable.length) {
  stampRun(TOPIC, false);
  emitNoop(`subjects within ${PROXIMITY_M}m have no material (${lore.items.slice(0, 3).map((i) => i.title).join("; ")})`);
  process.exit(0);
}

// ── 4. Is any of it worth saying? (the model's call) ─────────────────────
const prompt = buildPrompt({ place, hour, moving: MOVING, items: sayable.slice(0, 8), intent, event: locEvent });
let verdict;
try {
  // Lean tool-less call (no tools, MCP servers, skills, memory or hooks; the
  // verdict needs none of them), with the run's cost row.
  const r = textSync({ model: MODELS.sonnet, effort: "low", prompt, timeoutMs: 60000, maxBuffer: 2 * 1024 * 1024, job: "hum-harvester:nearby" });
  if (r.error) throw r.error;
  if (r.status !== 0 || r.isError) throw new Error(`claude exit ${r.status}: ${(r.text || r.stderr || "").slice(0, 160)}`);
  verdict = extractJsonObject(r.text, { requireKey: "say" });
  if (!verdict) { stampRun(TOPIC, false); emitNull("no JSON in subagent output"); process.exit(0); }
} catch (e) {
  stampRun(TOPIC, false);
  emitNull(`subagent failed: ${e.message}`);
  process.exit(0);
}
if (verdict.say !== true || !verdict.signal) {
  stampRun(TOPIC, false);
  emitNoop(`nothing worth saying here: ${String(verdict?.why_not || "no reason given").slice(0, 160)}`);
  process.exit(0);
}
const relevance = Number(verdict.relevance);
if (!Number.isFinite(relevance) || relevance < RELEVANCE_FLOOR) {
  stampRun(TOPIC, false);
  emitNoop(`relevance ${Number.isFinite(relevance) ? relevance.toFixed(2) : "unscored"} < ${RELEVANCE_FLOOR} — "${String(verdict.signal).slice(0, 80)}"`);
  process.exit(0);
}
// The subject is resolved by EXACT title against the list code built — never
// by reading the sentence. No match means we do not know what it is about,
// so we cannot place it, check distance at delivery, or dedup it: say nothing.
const subject = sayable.find((i) => i.title === verdict.source) || null;
if (!subject) {
  stampRun(TOPIC, false);
  emitNoop(`source "${String(verdict.source || "(none)").slice(0, 60)}" is not a subject on the list — refusing to send an unplaced factoid`);
  process.exit(0);
}

// ── 5. Picture and map, then the candidate ───────────────────────────────
const media = resolveMedia(subject);
// Identity, not wording: the Wikidata QID when there is one (it joins the
// en/he/fr articles about one tower), else the page / OSM id.
const identity = subject.qid || subject.ids[0] || subject.title;
const dedupKey = `nearby:${slugish(identity)}`;
stashMedia(dedupKey, media);

stampRun(TOPIC, true);
emit({
  topic: TOPIC,
  signal: String(verdict.signal).slice(0, 400),
  urgency: Math.min(0.95, relevance),
  freshness_min: Math.round(moment?.perishable_age_min ?? moment?.age_min ?? 0),
  dedup_key: dedupKey,
  supporting_data: {
    kind: "factoid",
    // Its own daily allowance, outside the shared 6-a-day hum budget
    // (lib/ping-budget.mjs localHistoryCaps).
    budget_pool: "local_history",
    relevance,
    relevance_floor: RELEVANCE_FLOOR,
    moving: MOVING,
    // What hum-ping and ping-flush measure the user's distance to before delivering.
    subject: {
      title: subject.title, lat: subject.lat, lon: subject.lon, ids: subject.ids,
      distance_m: subject.distance_m, source: subject.source,
    },
    harvested_at: { lat, lon, at: new Date().toISOString() },
    proximity_m: PROXIMITY_M,
    why_now: String(verdict.why_now || "").slice(0, 300),
    moment_kind: IS_ARRIVAL ? "arrival" : "area",
    fix_age_min: areaMoment?.fix_age_min ?? null,
    near_place: place,
    evidence_as_of: "live",
    // geo-gate-ok: every subject is within 300 m of the live position, checked
    // in code here and again at delivery.
    media,
  },
  act_fit: { effort_to_act: "quick_win" },
  temporal_fit: {
    relative_to: "transition",
    anchor: `${IS_ARRIVAL ? "arrival" : "area"}:${place || "here"}`,
    boost_during: ["post_event_15min"],
    expires_after_iso: new Date(Date.now() + (IS_ARRIVAL ? 25 : 60) * 60000).toISOString(),
  },
});

// ── helpers ──────────────────────────────────────────────────────────────

function resolveMedia(s) {
  // `subject` also carries the ids: hum-ping recovers it from this stash by
  // dedup_key if the tick's composed findings dropped supporting_data, and
  // needs lat/lon for the 300 m delivery check and ids for the ledger.
  const out = { image_url: s.image || null, map_url: null, subject: { title: s.title, lat: s.lat, lon: s.lon, ids: s.ids } };
  try {
    const raw = execFileSync(path.join(BIN, "place-map"), [
      "--from", `${lat},${lon}`, "--to", `${s.lat},${s.lon}`, "--label", s.title, "--upload", "--json",
    ], { encoding: "utf8", timeout: 90000, stdio: ["ignore", "pipe", "ignore"] });
    const parsed = JSON.parse(raw || "{}");
    if (parsed.url) out.map_url = parsed.url;
  } catch { /* a missing picture must never cost the ping */ }
  return out;
}

function num(v) {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
}

function areaMomentFrom(s) {
  if (num(s?.where?.lat) == null || num(s?.where?.lon) == null) return null;
  const fixAge = num(s?.environment?.phone_context_age_min);
  if (fixAge == null || fixAge > MAX_AREA_AGE_MIN) return null;
  // CoreMotion's own labels, not anything the user typed.
  const activity = String(s?.where?.activity || s?.environment?.motion_class || "").toLowerCase();
  return {
    moving: ["walking", "running", "cycling", "driving", "moving", "automotive"].includes(activity),
    fix_age_min: Math.round(fixAge),
  };
}

function isHome(p) {
  const s = String(p || "").toLowerCase();
  // The installation's own canonical place labels, not something the user typed.
  return HOME_LABELS.some((l) => l && s.includes(String(l).toLowerCase()));
}

function slugish(s) {
  // lang-regex-ok: building a dedup key from an id (QID / page id / OSM id) —
  // machine data, no meaning inferred.
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
}

function buildPrompt({ place, hour, moving, items, intent, event }) {
  const chatLines = (intent?.recent_chat || []).slice(-10).map((c) => `  - ${c.text}`).join("\n");
  const who = OWNER_NAME === "the user" ? "The user" : OWNER_NAME;
  return `${who} is out around ${place || "a spot"} and it is ${hour}:00 local, ${moving ? "walking" : "stopped"}. You may tell them ONE thing about the ground they are standing on, or say nothing.

These are the pings that land: what stood here before, what a street or building is named after, when something was cut or built and why — specific and human. "named after a sign showing a Moor's head that hung on the old rue du Maure" is worth saying; "a street in the 3rd arrondissement" is the definition, not the fact.

${renderLocalLoreBlock(items)}

RULES:
1. The fact MUST come from the list above, not from memory. If nothing above is interesting, say nothing.
2. Pick ONE subject. Copy its title into "source" EXACTLY as written above — code uses it to place the subject on a map, check the user is still near it, and make sure it is never told again.
3. No venue recommendations, no "you should visit", no opening hours, nothing to book. This is an explanation, not a suggestion.
4. Read past the opening definition of an article; the story is usually under history / name-origin.
5. If the user's own recent words show they are busy with something (a meeting, a call, a meal), keep it short or say nothing.

RELEVANCE 0.0-1.0, honestly — ${RELEVANCE_FLOOR.toFixed(2)} is the floor:
  0.9  genuinely surprising and right in front of them
  0.75 a good story about something within sight
  0.6  mildly interesting
  <0.55 filler — say nothing

WHAT THE USER HAS SAID IN CHAT RECENTLY:
${chatLines || "  (nothing recent)"}

${event ? `What woke you: ${event.summary || "the user arrived somewhere"}.` : "Nothing woke you; the user has been in this area a while."}

Reply with ONE JSON object and nothing else:
{"say": true|false, "relevance": 0.0-1.0, "source": "<exact title from the list>", "signal": "<what the user reads, under 220 chars, specific, no preamble>", "why_now": "<one line>", "why_not": "<if say is false, one line>"}`;
}
