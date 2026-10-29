"use strict";
// Passes 2 + 3 as one step, so a fresh build (the reservoir build) and a
// backfill of an existing area (the reservoir publish) do exactly the same
// thing to a reservoir. Keeping this here rather than in either script is what
// stops the two paths from drifting — the failure mode this pipeline already
// has three times over with its renderers.

const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { dedupeReservoir, applyVerdicts } = require("./reservoir-dedup.js");
const { clusterReservoir } = require("./reservoir-cluster.js");

const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), ".local/bin/claude");

function extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start];
  const close = open === "[" ? "]" : "}";
  const end = body.lastIndexOf(close);
  if (end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

// Pass 2's third tier: the pairs deterministic rules can't settle (same dish
// under different words), plus the full surviving dish roster for the
// same-food-different-name case that has no cheap signal at all. ONE bounded
// Sonnet call over names only — no web search, no reservoir body — so it costs
// a fraction of the research fork and can't stall a build. Any failure returns
// [] and the deterministic dedup stands on its own.
function resolveFuzzy(fuzzy, roster) {
  if (!fuzzy.length && (roster || []).length < 2) return [];
  const prompt = [
    "You are de-duplicating a travel food/place list. Decide which pairs refer to the SAME thing.",
    "Two entries are the SAME only if a traveller would consider eating/visiting one to make the other redundant.",
    "Different dishes at one restaurant are NOT the same. A dish and a sight at one venue are NOT the same.",
    "The same food named in French and English IS the same. A dish and a variant of it (sweet vs savoury) are NOT.",
    "",
    "CANDIDATE PAIRS:",
    JSON.stringify(fuzzy, null, 1),
    "",
    "ALL DISHES IN THIS AREA (check for same-food-different-wording pairs the list above missed):",
    JSON.stringify(roster || [], null, 1),
    "",
    'Reply with ONLY a JSON array: [{"a":"<id>","b":"<id>","same":true,"reason":"<short>"}]',
    "Include only pairs you judge the SAME. Empty array if none.",
  ].join("\n");
  const escaped = prompt.replace(/"/g, '\\"').replace(/\n/g, "\\n");
  try {
    const out = execFileSync("/bin/bash", ["-c",
      `${CLAUDE_BIN} -p --model claude-sonnet-5-5 --effort low --output-format text "${escaped}"`],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120000 });
    const parsed = extractJson(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    process.stderr.write(`[reservoir-refine] fuzzy resolver unavailable (${String(e.message).slice(0, 80)}) — deterministic dedup only\n`);
    return [];
  }
}

// Run both passes over a finished reservoir, mutating in place.
// `resolve: null` skips the model call (dry runs, offline backfills).
function refinePasses(reservoir, { resolve = resolveFuzzy, log = () => {} } = {}) {
  const { stats, fuzzy, dish_roster } = dedupeReservoir(reservoir);
  log(`pass 2 dedup: ${stats.venues} same-venue, ${stats.dishes} repeated dishes, ` +
      `${stats.linked} linked; ${fuzzy.length} uncertain`);
  let merged = 0;
  if (resolve) {
    const verdicts = resolve(fuzzy, dish_roster);
    merged = applyVerdicts(reservoir, verdicts).merged;
    if (merged) log(`pass 2 resolver: ${merged} further duplicate(s) merged`);
  }
  // Clustering runs AFTER the resolver so merged entries take no number and no
  // map pin — seq must not have holes the UI then renders.
  const c = clusterReservoir(reservoir);
  const walk = c.clusters.filter((x) => x.mode === "walk").length;
  log(`pass 3 clusters: ${c.clusters.length} (${walk} walk / ${c.clusters.length - walk} drive), ` +
      `${c.numbered} numbered, ${c.unplaced} unplaced, dont_miss=${c.dont_miss}`);
  return { stats, merged, clusters: c.clusters, numbered: c.numbered };
}

module.exports = { refinePasses, resolveFuzzy, extractJson };
