#!/usr/bin/env node
// talks — surfaces upcoming talks / lectures / storytelling events as
// proactive ideas. The user asked hum to "float ideas for talks" — this is the
// hook. Reads the `{ seen: [event] }` state files the installation's venue
// watch jobs write (agent/local/config/hum-talks.json `seen_files`, names
// under data/, all in one metro: `metro`) and emits the best upcoming event.
// No seen_files → the lane stays quiet.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { readStdinJson, readCache, writeCache, emit, emitNull, stampRun, geoGate, localConfig } from "./_common.mjs";

const DATA = path.join(createRequire(import.meta.url)("../../../lib/root.cjs").installRoot(), "data");
const CFG = localConfig("hum-talks", { seen_files: [], metro: "", default_price: "" });
const SEEN_FILES = (CFG.seen_files || []).map((f) => path.join(DATA, path.basename(String(f))));
const METRO = CFG.metro || "home";
const FEEDBACK_FILE = path.join(DATA, "hum-feedback.jsonl");

const TTL_MIN = 60;
const GATE_CAP = 15;

/**
 * Pick the first geo-reachable event from a sorted (dated-first, soonest-
 * first) candidate list, spending at most `gateCap` geoGate() calls total.
 * Undated venue-anchored events (no single scheduled date) are gated against
 * `todayStr` instead of bypassing the gate — "no date" means "ongoing,
 * happening now," not "nothing to check" (2026-10-04). Exported for
 * unit testing with a fake geoGateFn; the live caller passes the real
 * geoGate from _common.mjs.
 */
export function pickTopEvent(candidates, { geoGateFn, todayStr, gateCap = GATE_CAP, metro = METRO } = {}) {
  let gated = 0;
  for (const ev of candidates) {
    if (gated >= gateCap) continue;                   // past the spawn budget — skip further gate-eligible events
    gated++;
    const gateDate = ev.date || todayStr;              // undated → check against today (ongoing, venue-anchored)
    if (geoGateFn(metro, gateDate).suppress) continue; // the user is away that date
    return ev;                                          // first reachable event
  }
  return null;
}

/**
 * The events in the watch jobs' `{ seen: [] }` states. A venue-watch lane keys
 * its entries by `key` (older playbook-written ones by `id`) and also records
 * the candidates it judged and did NOT surface (`surfaced: false`): those are
 * not ideas to float. Exported for unit testing.
 */
export function seenEvents(states) {
  const out = [];
  for (const state of states) {
    for (const ev of state?.seen || []) {
      if (!ev || ev.surfaced === false) continue;
      out.push(ev.id ? ev : { ...ev, id: ev.key });
    }
  }
  return out;
}

function loadSkippedKeys() {
  const skipped = new Set();
  try {
    const lines = fs.readFileSync(FEEDBACK_FILE, "utf8").split("\n").filter(Boolean);
    for (const l of lines) {
      try {
        const r = JSON.parse(l);
        const key = String(r.dedup_key || "");
        if (!key.startsWith("talks-")) continue;
        const reaction = String(r.reaction || r.feedback || "").toLowerCase();
        if (["skip", "snooze", "👎", "💤", "down", "thumbs_down"].includes(reaction)) {
          skipped.add(key);
        }
      } catch { /* skip */ }
    }
  } catch { /* no feedback file */ }
  return skipped;
}

function run() {
  const cache = readCache("talks");
  if (cache && cache._age_min < TTL_MIN) {
    stampRun("talks", false);
    emitNull("cached (TTL not expired)");
    return;
  }

  // Merge events from all watched sources
  const states = [];
  for (const f of SEEN_FILES) {
    try { states.push(JSON.parse(fs.readFileSync(f, "utf8"))); }
    catch { /* source not yet initialized — skip */ }
  }
  const seen = seenEvents(states);
  if (seen.length === 0) {
    stampRun("talks", false);
    emitNull("no events in any state file");
    return;
  }
  const skipped = loadSkippedKeys();
  const now = Date.now();

  // Cheap filters first (NO subprocess): skipped / sold-out / past-date.
  const candidates = seen.filter(ev => {
    const key = `talks-${ev.id}`;
    if (skipped.has(key)) return false;
    if (ev.sold_out) return false;
    if (ev.date) {
      const d = new Date(`${ev.date}T23:59:00`).getTime();
      if (Number.isFinite(d) && d < now) return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    stampRun("talks", false);
    emitNull("no eligible upcoming events");
    return;
  }

  // Sort: dated events first (soonest), then undated.
  candidates.sort((a, b) => {
    if (a.date && b.date) return new Date(a.date).getTime() - new Date(b.date).getTime();
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });

  // Geo-gate LAZILY. talks only surfaces the top pick, and geoGate spawns a
  // `travel in-city` subprocess per call — gating all ~389 watched events up
  // front spawned a node process per event and blew the 15s harvest budget (the
  // recurring talks "timeout after 15000ms"). All talks venues are in METRO; walk
  // the sorted list and gate one at a time until the first reachable event.
  // GATE_CAP bounds the spawns so a long travel stretch (every dated event away)
  // can't run away either. See pickTopEvent() for why undated events are now
  // gated against today instead of bypassing the gate.
  const todayStr = new Date().toISOString().slice(0, 10);
  const top = pickTopEvent(candidates, { geoGateFn: geoGate, todayStr, gateCap: GATE_CAP });

  if (!top) {
    stampRun("talks", false);
    emitNull("no eligible upcoming events (all reachable dates gated away)");
    return;
  }
  const dedupKey = `talks-${top.id}`;

  // Urgency: higher as event date approaches
  let urgency = 0.35;
  if (top.date) {
    const daysOut = (new Date(top.date).getTime() - now) / 86400000;
    if (daysOut <= 3) urgency = 0.65;
    else if (daysOut <= 7) urgency = 0.5;
    else if (daysOut <= 14) urgency = 0.4;
  }

  writeCache("talks", { picked: top.id, ts: new Date().toISOString() });
  stampRun("talks", true);

  emit({
    topic: "talks",
    signal: `${top.title} — ${top.venue}${top.date ? `, ${top.date}` : ""}${top.price || CFG.default_price ? ` (${top.price || CFG.default_price})` : ""}${top.url ? `\n${top.url}` : ""}`,
    urgency,
    freshness_min: 60,
    dedup_key: dedupKey,
    supporting_data: {
      id: top.id,
      title: top.title,
      venue: top.venue,
      date: top.date || null,
      price: top.price,
      url: top.url,
      remaining_count: candidates.length - 1,
    },
    // hum-i-20260520-02: talks often feature unfamiliar speakers + need
    // ticketing + scheduling. Heavy lift → evaluator surfaces the
    // speaker-context primer + ticket flow.
    act_fit: { effort_to_act: "heavy_lift" },
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { situation: sit, context } = await readStdinJson(); void sit; void context;
  try { run(); } catch (e) {
    emitNull(`talks harvester failed: ${e.message}`);
  }
}
