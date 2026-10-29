#!/usr/bin/env node
// Music — once-daily web search via `claude -p` subagent. Queries tailored to
// the user's tracked artists + tastes (context.tastes.music). Cached 24h.
// City-aware (2026-08-08): scans wherever the user currently is per
// `travel where`, not only the home city — a trip abroad once got no
// live-music surfacing while the scan kept searching home.
//
// Optional agent/local/config/hum-music.json:
//   home_metro / home_label  the home metro key (as `travel where` names it) and its name
//   extra_taste              taste notes added to the profile (e.g. genres shared with a partner)
//   extra_taste_file         or the same notes in a private text file (path under agent/local/), so
//                            words in them are not read as kernel-guard tokens
//   home_sources             extra prompt text used only at home (editorial sources, groups to watch)
// Off when there is neither a music profile nor extra_taste.
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { readStdinJson, readCache, writeCache, emit, emitNull, emitNoop, stampRun, geoGate, localConfig } from "./_common.mjs";
import { recallForLane, shouldFilter } from "../../../lib/suggestion-recall.mjs";
import { canonicalKey } from "../../../lib/suggestion-key.mjs";
import { extractJsonObject } from "../../../lib/extract-json.mjs";

const require = createRequire(import.meta.url);
const BIN_DIR = require("../../../lib/root.cjs").installTools("bin");
const { MODELS } = require("../../../lib/models.cjs");
const CLAUDE = path.join(os.homedir(), ".local/bin/claude");
const CFG = localConfig("hum-music", { home_metro: "", home_label: "", extra_taste: "", home_sources: "" });
if (!CFG.extra_taste && CFG.extra_taste_file) {
  try { CFG.extra_taste = fs.readFileSync(path.join(require("../../../lib/instance.cjs").localDir(), CFG.extra_taste_file), "utf8").trim(); } catch {}
}

function currentCity() {
  try {
    const out = execFileSync(path.join(BIN_DIR, "travel"), ["where", "now", "--json"], { encoding: "utf8", timeout: 10000 });
    const { metro, label } = JSON.parse(out);
    if (metro && label) return { metro, label };
  } catch { /* fall through to default */ }
  return { metro: CFG.home_metro || "home", label: `${CFG.home_label || "the user's home city"} (home base — current city unknown)` };
}

const { situation: sit, context } = await readStdinJson(); void sit;
if (!(context?.tastes?.music || CFG.extra_taste)) {
  stampRun("music", false);
  emitNoop("not configured (no music profile, no hum-music extra_taste)");
  process.exit(0);
}
const TTL_MIN = 24 * 60;

const recall = recallForLane({ lane: "music", max_rows: 40, window_days: 365 });

let cache = readCache("music");
if (!cache || cache._age_min >= TTL_MIN) {
  const city = currentCity();
  const profile = (context?.tastes?.music || "").slice(0, 4000);
  const recentLearnings = (context?.recent?.recent_learnings || [])
    .filter((l) => ["general_preference", "event_recap", "show_preference"].includes(l.memory_hook))
    .slice(0, 8);
  const extraTaste = String(CFG.extra_taste || "").trim();
  const atHome = !!CFG.home_metro && city.metro === CFG.home_metro;
  const homeLabel = CFG.home_label || "the home city";
  const prompt = `You are harvesting music news for the user. The user's taste profile:
---
${profile || "(no profile captured yet — assume adult-contemporary listener with interest in jazz, world music, quality new releases)"}
---
${extraTaste ? `\n${extraTaste}\n` : ""}
${recall.block}

Recent preference answers (don't recommend anything matching these — the user has already weighed in):
${recentLearnings.length ? recentLearnings.map(l => `  - ${l.subject}: ${l.answer_excerpt}`).join("\n") : "(none yet)"}

Today: ${new Date().toISOString().slice(0, 10)}. The user is currently in ${city.label}.

Use web_search to find up to 5 notable items from the last 14 days:
- New album or EP releases by artists the user follows or would likely enjoy (not location-tied)
- Tour dates, notable club sets and live shows happening in ${city.label} — this is wherever the user currently is, not always ${homeLabel}, so search for what's actually on there
${CFG.home_metro && !atHome ? `- The user is away from ${homeLabel}: also flag any big ${homeLabel} tour announcement worth knowing about before the user is back\n` : ""}- Noteworthy music-industry news matching the user's taste

${atHome ? (CFG.home_sources || "") : `Search local sources (city listings, venue sites, local editorial "things to do") for ${city.label}.`}

Output ONE JSON object on stdout, no prose:
{"items":[{"title":"...","artist":"...","kind":"album|tour|news","city":"city of the show for tour/concert (else null)","date":"YYYY-MM-DD of the show for tour/concert (else null)","url":"...","why":"one-line match to profile"}]}
If nothing new, return {"items":[]}.`;
  try {
    const out = execSync(
      `"${CLAUDE}" -p --model ${MODELS.sonnet} --effort low --allowedTools WebSearch --output-format text "${prompt.replace(/"/g, '\\"').replace(/\n/g, "\\n")}" 2>/dev/null`,
      { encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1024 * 1024 }
    );
    const parsed = extractJsonObject(out, { requireKey: "items" });
    if (!parsed) { emitNull("no JSON in subagent output"); process.exit(0); }
    cache = { items: parsed.items || [] };
    writeCache("music", cache);
  } catch (e) {
    emitNull(`subagent failed: ${e.message}`);
    process.exit(0);
  }
}

if (!cache.items || cache.items.length === 0) {
  stampRun("music", false);
  emitNull("no items in cache");
  process.exit(0);
}

// Drop history-blocked items (the user already rejected them).
const items = cache.items.filter((item) => {
  const key = canonicalKey("music", { topic: "music", supporting_data: { candidate: item } });
  if (!key) return true;
  return !shouldFilter(key).block;
});
if (items.length === 0) {
  stampRun("music", false);
  emitNull(`all ${cache.items.length} items history-blocked`);
  process.exit(0);
}

// Geo-gate dated location events: drop tours/concerts on dates the user won't be
// in that city — unless the artist is a tier-1 headliner (worth traveling for).
// Albums / news / undated items have no location to gate, so they pass through.
const geoItems = items.filter((item) => {
  const isEvent = /tour|concert|show|festival|gig/i.test(item.kind || "");
  if (!isEvent || !item.date) return true;
  return !geoGate(item.city || currentCity().metro, item.date, item.artist).suppress;
});
if (geoItems.length === 0) {
  stampRun("music", false);
  emitNoop(`all ${items.length} items gated out (away on the event dates)`);
  process.exit(0);
}

const top = geoItems[0];
stampRun("music", true);
emit({
  topic: "music",
  signal: `${top.artist || "?"} — ${top.title} (${top.kind}) — ${top.why || ""}`,
  urgency: 0.35,
  freshness_min: cache._age_min || 0,
  dedup_key: `music:${(top.url || `${top.artist}:${top.title}`).slice(0, 60)}`,
  supporting_data: { candidate: top, others: geoItems.slice(1, 4) },
  // hum-i-20260520-02: unknown artists need a primer; ticketing requires
  // research. Heavy lift → evaluator builds the artist-context bundle.
  act_fit: { effort_to_act: "heavy_lift" },
});
