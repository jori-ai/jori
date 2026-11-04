#!/usr/bin/env node
// Crossref — meta-harvester. Looks at the current situation and reaches
// across jori's knowledge sources (notes, iMessage, email, drive, past
// trips, meeting notes, memory files) to find NON-OBVIOUS signals that connect
// to what the user is doing right now.
//
// Example: the user has "weekly sync in 20 min" in situation.next → crossref
// searches meeting notes + recent Slack/email for unresolved items and emits
// a candidate like "You have 3 open items in the agenda from last meeting."
//
// Places that count as home (never a search focus, never "away") start with
// one of agent/local/config/hum-crossref.json `home_place_prefixes`
// (default: "Home (").
//
// Runs as the last harvester in parallel with the rest. If no topical "now"
// focus exists (quiet situation), returns null.
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { readStdinJson, emit, emitNull, stampRun, readTopicState, writeTopicState, localConfig } from "./_common.mjs";

const { situation: sit, context } = await readStdinJson();
const BIN = createRequire(import.meta.url)("../../../lib/root.cjs").installTools("bin/context-search");
const HOME_PREFIXES = (localConfig("hum-crossref", { home_place_prefixes: ["Home ("] }).home_place_prefixes || [])
  .map((p) => String(p).toLowerCase()).filter(Boolean);
// String prefix test on our own place labels, not language.
const isHomePlace = (p) => { const s = String(p || "").toLowerCase(); return HOME_PREFIXES.some((x) => s.startsWith(x) || s.includes(` ${x}`)); };

// Pick one focus keyword from the situation. Priority:
//   1. upcoming calendar event (title)
//   2. current place (if named and non-home)
//   3. companion name
//   4. top week_commit_topic
const upcoming = sit?.next?.upcoming_events?.[0];
const place = sit?.where?.place || "";
const companions = sit?.where?.companions || [];
const weekTopics = sit?.working_on?.week_commit_topics || [];

let focus = null;
if (upcoming?.summary && /[a-z]/i.test(upcoming.summary)) {
  // Strip common noise words from titles to improve search
  focus = upcoming.summary.replace(/\b(meeting|call|sync|1:1|with|the|a|an)\b/gi, " ").replace(/\s+/g, " ").trim().split(" ")[0];
} else if (place && !isHomePlace(place)) {
  focus = place.split(",")[0].trim();
} else if (companions.length) {
  focus = companions[0];
} else if (weekTopics.length) {
  focus = weekTopics[0];
}

// A focus that is just the address of the current scheduled stay (place comes
// from the travel timeline) can only return facts the user lives in: never news.
const placeHead = place.split(",")[0].trim();
const stayFocus = place && sit?.where?.place_source === "travel_timeline" && focus === placeHead;
if (stayFocus) {
  stampRun("crossref", false);
  emitNull(`focus "${focus}" is the current stay`);
  process.exit(0);
}

if (!focus || focus.length < 3) {
  stampRun("crossref", false);
  emitNull("no focus keyword");
  process.exit(0);
}

// Search cross-source index
let hits = [];
try {
  const out = execSync(`"${BIN}" "${focus.replace(/"/g, '\\"')}"`, {
    encoding: "utf8", timeout: 6000,
  });
  // context-search emits `[source] id — summary` lines
  for (const line of out.split("\n")) {
    const m = line.match(/^\[([^\]]+)\]\s+(\S+)(?:\s+—\s+(.+))?$/);
    if (m) hits.push({ source: m[1], id: m[2], summary: m[3] || "" });
  }
} catch (e) {
  emitNull(`context-search failed for ${focus}: ${e.message}`);
  process.exit(0);
}

if (hits.length === 0) {
  stampRun("crossref", false);
  emitNull(`no cross-source hits for "${focus}"`);
  process.exit(0);
}

// Prefer the most informative hit: notes > email > drive > imessage. Take
// the first from the highest-priority bucket.
const buckets = { notes: [], email: [], gdrive: [], imessage: [], other: [] };
for (const h of hits) {
  const k = buckets[h.source] ? h.source : "other";
  buckets[k].push(h);
}
const top = buckets.notes[0] || buckets.email[0] || buckets.gdrive[0] || buckets.imessage[0] || buckets.other[0];
if (!top) { stampRun("crossref", false); emitNull("no usable hit"); process.exit(0); }

// Per-hit cooldown: the same dedup_key is not re-emitted within 7 days.
const COOLDOWN_MS = 7 * 24 * 3600 * 1000;
const dedupKey = `crossref:${focus}:${top.id}`;
const seen = readTopicState("crossref").emitted || {};
const nowMs = Date.now();
const lastMs = Date.parse(seen[dedupKey] || "");
if (Number.isFinite(lastMs) && nowMs - lastMs < COOLDOWN_MS) {
  stampRun("crossref", false);
  emitNull(`${dedupKey} emitted within 7d`);
  process.exit(0);
}
const pruned = {};
for (const [k, v] of Object.entries(seen)) {
  const t = Date.parse(v);
  if (Number.isFinite(t) && nowMs - t < COOLDOWN_MS) pruned[k] = v;
}
pruned[dedupKey] = new Date(nowMs).toISOString();
writeTopicState("crossref", { emitted: pruned });

// Urgency scales with how tight the "now" coupling is:
//   - upcoming event in <30 min → 0.75
//   - at a non-home place / with companion → 0.55
//   - general focus → 0.4
let urgency = 0.4;
if (upcoming?.in_min !== undefined && upcoming.in_min >= 0 && upcoming.in_min <= 30) urgency = 0.75;
else if (place && !isHomePlace(place)) urgency = 0.55;
else if (companions.length) urgency = 0.55;

stampRun("crossref", true);
emit({
  topic: "crossref",
  signal: `Context about "${focus}": ${top.summary.slice(0, 200)}`,
  urgency,
  freshness_min: 0,
  dedup_key: dedupKey,
  supporting_data: {
    focus,
    primary_hit: top,
    related: hits.filter((h) => h !== top).slice(0, 4),
    focus_source: upcoming ? "upcoming_event" : (place ? "place" : companions.length ? "companion" : "week_topic"),
  },
});
