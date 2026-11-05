#!/usr/bin/env node
// location-confirm-precheck — synchronous, programmatic context check that runs
// from `trigger-location-confirm.sh` before any user-facing ask is phrased.
//
// Stdin: detector ask JSON (the `ASK_JSON` the trigger builds — detector output
// plus ask_id / ask_key).
// Stdout: {decision: "escalate"|"ask", reasoning}
//
//   escalate     — the ask has candidates. Caller runs the
//                  `location-confirm-resolve` step, which checks calendar +
//                  recent conversation + wiki memory before deciding to
//                  auto-confirm or to ask. `reasoning` says whether a busy
//                  calendar event overlaps the dwell.
//   ask          — nothing more we can do here; fall through to the existing
//                  Gemma-phrase + queue path.
//
// It never names a stop. Whether an event's title, location or description
// names one of the candidates is a reading (Rule #0b), and a fragment match
// gets it wrong: this step used to auto-confirm when any 4+-character piece of
// a candidate's name appeared anywhere in the event's text, and a piece of one
// word in a venue's name matched a different word in the event's address. The
// resolver reads the event instead (its calendar tiers, then its model tail).
//
// Failure modes are non-blocking: any exception writes a `{decision: "ask"}`
// object so the existing flow proceeds unchanged.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { instance } from "../lib/instance.cjs";

// gog: $GOG_BIN, else a package-manager install (launchd's PATH has neither), else PATH.
const GOG = process.env.GOG_BIN || ["/opt/homebrew/bin/gog", "/usr/local/bin/gog"].find((p) => existsSync(p)) || "gog";
const TZ_DEFAULT = instance().tz;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

let raw = "";
try { raw = readFileSync(0, "utf8"); } catch {}
let ask;
try { ask = JSON.parse(raw); } catch { emit({ decision: "ask", reasoning: "invalid_input" }); }
if (!ask || typeof ask !== "object") emit({ decision: "ask", reasoning: "empty_input" });

const candidates = [];
if (ask.primary && ask.primary.name) candidates.push(ask.primary);
for (const c of (ask.alternatives || [])) if (c && c.name) candidates.push(c);
for (const c of (ask.candidates || [])) if (c && c.name && !candidates.some(x => x.name === c.name)) candidates.push(c);
if (candidates.length === 0) emit({ decision: "ask", reasoning: "no_candidates" });

const centroid = ask.centroid || {};
// Anchor to the actual dwell window (same fields location-confirm-resolve.mjs
// uses), not "now": dwell detection is inherently retrospective, so by the
// time a 20+ min dwell is flagged and this precheck runs, a tightly-scheduled
// event (e.g. a 35-min coffee stop) has often already ended — an "active at
// this instant" filter almost never fires for a legitimate match and always
// escalates to resolve.mjs instead (2026-07-24 root cause).
const dwellStart = ask.first_sample_ts ? new Date(ask.first_sample_ts) : new Date(Date.now() - 30 * 60 * 1000);
const dwellEnd   = ask.last_sample_ts  ? new Date(ask.last_sample_ts)  : new Date();
const fromIso = new Date(dwellStart.getTime() - 30 * 60 * 1000).toISOString();
const toIso   = new Date(dwellEnd.getTime()   + 30 * 60 * 1000).toISOString();

let events = [];
try {
  const res = spawnSync(GOG, [
    "calendar", "list", "--json", "--results-only",
    "--from", fromIso, "--to", toIso, "--all",
  ], { encoding: "utf8", timeout: 8000 });
  if (res.status === 0 && res.stdout) {
    const parsed = JSON.parse(res.stdout);
    if (Array.isArray(parsed)) events = parsed;
  }
} catch {}

const active = events.filter(e => {
  const s  = e.start && e.start.dateTime ? new Date(e.start.dateTime) : null;
  const en = e.end   && e.end.dateTime   ? new Date(e.end.dateTime)   : null;
  if (!s || !en) return false;
  if ((e.transparency || "opaque") === "transparent") return false;
  return s < dwellEnd && en > dwellStart; // overlaps the actual dwell window, not the instant this script runs
});

emit({
  decision: "escalate",
  reasoning: active.length > 0 ? "active_event" : "no_active_event",
});
