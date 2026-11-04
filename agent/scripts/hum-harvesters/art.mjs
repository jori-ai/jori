#!/usr/bin/env node
// Art — once-daily web search via `claude -p` subagent. Queries tailored to
// the user's art taste and current city. Cached 24h.
//
// Off until configured: agent/local/config/hum-art.json
//   taste              the user's art taste in words (context.tastes.art wins)
//   focus              what to search for, e.g. "photography exhibitions"
//   venues             galleries / institutions to favour (names)
//   editorial_sources  [{ city, url, note }] listings to mine first
//   cities             [{ match: [place words], city }] place → city, first match wins
//   default_city       the city when no place matches
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { readStdinJson, readCache, writeCache, emit, emitNull, emitNoop, stampRun, geoGate, localConfig } from "./_common.mjs";
import { recallForLane, shouldFilter } from "../../../lib/suggestion-recall.mjs";
import { canonicalKey } from "../../../lib/suggestion-key.mjs";
import { extractJsonObject } from "../../../lib/extract-json.mjs";

const { situation: sit, context } = await readStdinJson();
const TTL_MIN = 24 * 60;
const CFG = localConfig("hum-art", { taste: "", focus: "art exhibitions", venues: [], editorial_sources: [], cities: [], default_city: "" });
const { MODELS } = createRequire(import.meta.url)("../../../lib/models.cjs");
const CLAUDE = path.join(os.homedir(), ".local/bin/claude");

if (!(context?.tastes?.art || CFG.taste) || !CFG.default_city) {
  stampRun("art", false);
  emitNoop("not configured (agent/local/config/hum-art.json taste, default_city)");
  process.exit(0);
}

const recall = recallForLane({ lane: "art", max_rows: 40, window_days: 365 });

let cache = readCache("art");
if (!cache || cache._age_min >= TTL_MIN) {
  const city = inferCity(sit);
  const tasteDigest = (context?.tastes?.art || CFG.taste).slice(0, 1500);
  const recentLearnings = (context?.recent?.recent_learnings || [])
    .filter((l) => ["show_preference", "event_recap", "general_preference"].includes(l.memory_hook))
    .slice(0, 8);
  const venues = (CFG.venues || []).join(", ");
  const editorial = (CFG.editorial_sources || []).filter((s) => !s.city || String(city).toLowerCase().includes(String(s.city).toLowerCase()))
    .map((s) => `Trusted editorial source to mine first (${s.city || "any city"}): ${s.url}${s.note ? ` — ${s.note}` : ""}`).join("\n");
  const prompt = `You are harvesting art-world news for the user. The user's taste profile:
---
${tasteDigest}
---

${recall.block}

Recent preference answers (don't recommend anything matching these subjects — the user has already told us):
${recentLearnings.length ? recentLearnings.map(l => `  - ${l.subject}: ${l.answer_excerpt}`).join("\n") : "(none yet)"}

The user's current city: ${city}.
Today: ${new Date().toISOString().slice(0, 10)}.

Use web_search to find up to 5 notable ${CFG.focus || "art exhibitions"} / gallery openings happening NOW through the next 14 days within reasonable distance. Favor:
- Gallery openings${venues ? ` (${venues}, etc.)` : ""}
- Museum shows matching the taste profile
- Limited-run exhibitions with specific end dates
${editorial ? `\n${editorial}\nAlways check it (or its current week's listings page) before broad web search.` : ""} Local/buzzy > tourist blockbuster.

Output ONE JSON object on stdout, no prose:
{"items":[{"title":"...","venue":"...","location":"...","ends":"YYYY-MM-DD","why":"one-line match to taste","url":"..."}]}
If nothing new, return {"items":[]}.`;
  try {
    const out = execSync(
      `"${CLAUDE}" -p --model ${MODELS.sonnet} --effort low --allowedTools WebSearch --output-format text "${prompt.replace(/"/g, '\\"').replace(/\n/g, "\\n")}" 2>/dev/null`,
      { encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1024 * 1024 }
    );
    // Extract JSON from the text output
    const parsed = extractJsonObject(out, { requireKey: "items" });
    if (!parsed) { emitNull("no JSON in subagent output"); process.exit(0); }
    cache = { items: parsed.items || [], city };
    writeCache("art", cache);
  } catch (e) {
    emitNull(`subagent failed: ${e.message}`);
    process.exit(0);
  }
}

if (!cache.items || cache.items.length === 0) {
  stampRun("art", false);
  emitNull("no items in cache");
  process.exit(0);
}

const items = cache.items.filter((item) => {
  const key = canonicalKey("art", { topic: "art", supporting_data: { candidate: item } });
  if (!key) return true;
  return !shouldFilter(key).block;
});
if (items.length === 0) {
  stampRun("art", false);
  emitNull(`all ${cache.items.length} items history-blocked`);
  process.exit(0);
}

// Geo-gate: this lane recommends art in the city the items were fetched for
// (persisted on the cache). If the travel timeline says the user is NOT in that
// city right now, suppress — don't pitch a gallery in a city the user has left. Fail-open on
// unknown. NOTE: `city` is block-scoped to the refetch branch above, so resolve
// it here from the cache (with an inferCity fallback for pre-field caches) —
// referencing the inner `city` at top level threw ReferenceError every tick.
const city = cache?.city || inferCity(sit);
const artGate = geoGate(city, "now");
if (artGate.suppress) {
  stampRun("art", false);
  emitNoop(`art gated: ${artGate.reason}`);
  process.exit(0);
}

// Emit the first unseen item (check signal dedup via state elsewhere if needed).
// For now, emit the top candidate — Sonnet ranker dedups against recent runs.
const top = items[0];
stampRun("art", true);
emit({
  topic: "art",
  signal: `${top.title} @ ${top.venue}${top.ends ? " (ends " + top.ends + ")" : ""} — ${top.why || ""}`,
  urgency: 0.4,
  freshness_min: cache._age_min || 0,
  dedup_key: `art:${(top.url || top.title || "").slice(0, 60)}`,
  supporting_data: { candidate: top, others: items.slice(1, 4) },
  // hum-i-20260520-02: art shows almost always require research +
  // a neighborhood-aligned trip. Heavy lift → post-rank evaluator
  // produces an artist primer + decision_aids so the ping is yes/no.
  act_fit: { effort_to_act: "heavy_lift" },
});

// Place label → city, from config word lists (substring match on our own
// place labels, not language).
function inferCity(situation) {
  const place = String(situation?.where?.place || "").toLowerCase();
  for (const c of CFG.cities || []) {
    if ((c.match || []).some((w) => w && place.includes(String(w).toLowerCase()))) return c.city;
  }
  return `${CFG.default_city} (fallback)`;
}
