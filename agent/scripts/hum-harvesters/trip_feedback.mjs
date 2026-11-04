#!/usr/bin/env node
// trip_feedback — ask what the user actually thought of a place the trip
// reservoir already knows they visited.
//
// `trip-reservoir-mark-done` (nightly) strikes reservoir entries the user has
// been to, using the daily summary + GPS visits + travel path as evidence. That
// closes the "stop suggesting what's been seen" loop but says nothing about
// whether the user LIKED it — and done != loved. Without that, Phase-2 daily planning
// (see the `itinerary-planning` skill) keeps drawing from the reservoir with no
// signal about which picks landed, so every area's plan is as naive as the
// first. The skill names this feedback loop as the open frontier; this is it.
//
// Shape: a hum harvester, deliberately NOT a new cron job. Hum already owns
// question-asking (ASK-FIRST), answer capture to hum-responses.jsonl, the
// LEARNINGS/wiki gates that stop re-asking a settled subject, and the overnight
// consolidation that folds durable answers into the wiki travel profile. A
// parallel asker would duplicate all of it. This harvester only supplies the
// candidate; `trip-feedback-apply` writes the answer back onto the entry.
//
// Emits at most ONE candidate per tick — the most recently struck entry that
// has no feedback yet. dedup_key is stable per entry so hum's own dedup and
// the 3-strikes-silenced rule in _common.mjs stop it nagging.
//
// Fail-closed: any error → "null" + stderr warning, never blocks a tick.

import fs from "node:fs";
import { installTools } from "../../../lib/root.cjs";
import { createRequire } from "node:module";
import { readStdinJson, emit, emitNull, stampRun } from "./_common.mjs";

const require = createRequire(import.meta.url);
const { listAreas, pullReservoir } = require("../../../lib/reservoir-store.js");

const { situation: sit, context } = await readStdinJson(); void sit; void context;

// Lane cooldown. The per-entry dedup_key stops us re-asking about the SAME
// place, but not about 74 different ones: a single mark-done pass over a live
// trip strikes a large backlog at once (observed 2026-07-20 — 74 entries
// pending on first run), and one candidate per 20-min tick would turn that
// backlog into dozens of questions a day. The standing licence to ask often covers
// asking freely, not draining a queue at the user. So: at most one trip_feedback
// question per COOLDOWN_H, enforced here rather than left to Sonnet's judgment,
// because the backlog regenerates every night and a soft rule would erode.
const COOLDOWN_H = 12;
const RUNS_FILE = installTools("data/hum-runs.jsonl");

function hoursSinceLastAsk() {
  let raw;
  try { raw = fs.readFileSync(RUNS_FILE, "utf8"); } catch { return Infinity; }
  const lines = raw.split("\n");
  // Newest last — walk backwards and stop at the first sent trip_feedback ping.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes("trip_feedback")) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.outcome?.sent !== true) continue;
    const cands = row?.harvest?.candidates || [];
    const wasTrip = cands.some((c) => String(c?.topic || "") === "trip_feedback"
      && String(row?.sonnet?.dedup_key || row?.outcome?.dedup_key || c.dedup_key || "").startsWith("trip_feedback:"));
    if (!wasTrip) continue;
    const ts = Date.parse(row.ts || "");
    if (!Number.isFinite(ts)) continue;
    return (Date.now() - ts) / 3600000;
  }
  return Infinity;
}

const sinceAsk = hoursSinceLastAsk();
if (sinceAsk < COOLDOWN_H) {
  stampRun("trip_feedback", false);
  emitNull(`asked ${Math.round(sinceAsk)}h ago (cooldown ${COOLDOWN_H}h)`);
  process.exit(0);
}

// Only ask while the memory is fresh. Beyond ~4 days the answer is worth less
// than the interruption, and mark-done's 60-day rescan would otherwise make
// every old strike a fair question forever.
const MAX_AGE_H = 96;
const BUCKETS = ["must_see", "optional", "food_specialties", "unique_experiences", "time_sensitive"];

function entryLabel(e) {
  return e?.name || e?.dish || e?.best_place || null;
}

// Stable identity for an entry across rebuilds. carryAnnotations keys off the
// same name/dish fields, so this survives a reservoir rebuild the way the
// done/photo annotations do.
function entryKey(area, bucket, e) {
  const label = entryLabel(e) || "";
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `${area}:${bucket}:${slug}`;
}

let areas = [];
try {
  areas = await listAreas();
} catch (err) {
  process.stderr.write(`trip_feedback: listAreas failed: ${err?.message || err}\n`);
  stampRun("trip_feedback", false);
  emitNull("reservoir unavailable");
  process.exit(0);
}

if (!Array.isArray(areas) || areas.length === 0) {
  stampRun("trip_feedback", false);
  emitNull("no reservoirs");
  process.exit(0);
}

const now = Date.now();
const candidates = [];

for (const area of areas) {
  let res = null;
  try {
    res = await pullReservoir(area);
  } catch (err) {
    // One unreadable area must not blind the others.
    process.stderr.write(`trip_feedback: pullReservoir(${area}) failed: ${err?.message || err}\n`);
    continue;
  }
  const buckets = res?.buckets || {};
  for (const bucket of BUCKETS) {
    const list = Array.isArray(buckets[bucket]) ? buckets[bucket] : [];
    for (const e of list) {
      if (e?.state !== "done") continue;
      if (e?.feedback) continue; // already answered — never re-ask
      const label = entryLabel(e);
      if (!label) continue;
      const doneAt = Date.parse(e.done_at || e.done_date || "");
      if (!Number.isFinite(doneAt)) continue;
      const ageH = (now - doneAt) / 3600000;
      if (ageH < 0 || ageH > MAX_AGE_H) continue;
      candidates.push({
        area,
        bucket,
        label,
        ageH,
        doneAt,
        key: entryKey(area, bucket, e),
        area_label: res?.label || area,
        done_source: e.done_source || null,
        why: e.why || e.why_authentic || null,
        dish: e.dish || null,
        best_place: e.best_place || null,
      });
    }
  }
}

if (candidates.length === 0) {
  stampRun("trip_feedback", false);
  emitNull("no recently-visited entries awaiting feedback");
  process.exit(0);
}

// With a 12h cooldown we get ~2 questions a day against a backlog that can run
// to dozens, so WHICH one we ask about matters more than draining the queue.
// Weight by how much the answer would change a future plan: a signature meal or
// a must-see teaches us something reusable about the user's taste; a weekly market is
// mostly interchangeable with the next town's. Recency breaks ties within a
// tier, since the user can only speak to what they still remember.
const BUCKET_WEIGHT = {
  food_specialties: 3,     // taste signal generalizes hardest
  must_see: 3,
  unique_experiences: 2,
  optional: 1,
  time_sensitive: 0,       // markets/events — least transferable
};
candidates.sort((a, b) => {
  const w = (BUCKET_WEIGHT[b.bucket] ?? 0) - (BUCKET_WEIGHT[a.bucket] ?? 0);
  if (w !== 0) return w;
  return b.doneAt - a.doneAt;
});
const top = candidates[0];

// Ask for the two things that actually change tomorrow's plan: how it landed,
// and whether it's worth more time. "Loved but rushed" is a return, not a done.
// Food entries carry both a dish and the venue it's best eaten at, but either
// can be missing and entryLabel() falls back to the other — so naively joining
// them yields "Gâteau nantais at Gâteau nantais" (observed on the first live
// run). Only join when they're genuinely two different things.
const venue = top.bucket === "food_specialties" ? (top.best_place || null) : null;
const subject = top.dish && venue && venue !== top.dish
  ? `${top.dish} at ${venue}`
  : top.label;
const question = `You made it to ${subject}. Worth it — and would you go back, or was once enough?`;

// Older strikes get slightly less urgency: still worth asking, but shouldn't
// outrank a fresh one or an operational lane.
const urgency = top.ageH <= 24 ? 0.55 : (top.ageH <= 48 ? 0.45 : 0.35);

stampRun("trip_feedback", true);
emit({
  topic: "trip_feedback",
  signal: question,
  urgency,
  freshness_min: Math.round(top.ageH * 60),
  dedup_key: `trip_feedback:${top.key}`,
  supporting_data: {
    area: top.area,
    area_label: top.area_label,
    bucket: top.bucket,
    entry_key: top.key,
    entry_label: top.label,
    dish: top.dish,
    why: top.why,
    done_at: new Date(top.doneAt).toISOString(),
    done_source: top.done_source,
    hours_since_visit: Math.round(top.ageH),
    pending_count: candidates.length,
    // Consumed by trip-feedback-apply to write the answer back onto the entry.
    feedback_target: { area: top.area, bucket: top.bucket, entry_key: top.key },
  },
});
