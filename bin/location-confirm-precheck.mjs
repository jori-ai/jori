#!/usr/bin/env node
// location-confirm-precheck — synchronous, programmatic context check that runs
// from `trigger-location-confirm.sh` before any user-facing ask is phrased.
//
// Stdin: detector ask JSON (the `ASK_JSON` the trigger builds — detector output
// plus ask_id / ask_key).
// Stdout: {decision: "auto_confirm"|"escalate"|"ask", venue?, reasoning}
//
//   auto_confirm — calendar event currently active whose title, location, OR
//                  description names a candidate. Caller saves directly via
//                  `location-confirm save`. No user ping. (2026-09-08: added
//                  description — many ticket/order confirmation events carry
//                  the venue name only in the description block, with no
//                  location field set at all; requiring a location field is
//                  the wrong lever when plenty of legitimate events never
//                  carry one. This scans everything on the event before
//                  giving up, not just the one field that happens to be
//                  present.)
//   escalate     — programmatic signal is weak but the dwell deserves a
//                  smarter lookup. Caller writes the ask to a pending state
//                  file and dispatches the ops-agent `location-confirm-resolve`
//                  job, which checks calendar + recent conversation + wiki
//                  memory before deciding to auto-confirm or to ask.
//   ask          — nothing more we can do here; fall through to the existing
//                  Gemma-phrase + jori-send path.
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

function norm(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

const STOP = new Set(["the","a","and","of","in","at","on","cafe","bar","restaurant","kitchen","co","grill","house","shop","store"]);
function tokensOf(s) {
  return norm(s).split(" ").filter(t => t.length >= 4 && !STOP.has(t));
}

for (const ev of active) {
  // Check title, location, AND description — a ticket/order confirmation
  // often names the venue only in its description block (2026-09-08).
  const haystack = (norm(ev.summary) + " " + norm(ev.location) + " " + norm(ev.description)).trim();
  if (!haystack) continue;
  for (const cand of candidates) {
    const toks = tokensOf(cand.name);
    if (toks.length === 0) continue;
    const hit = toks.some(t => haystack.includes(t));
    if (hit) {
      emit({
        decision: "auto_confirm",
        venue: cand.name,
        reasoning: `calendar:"${ev.summary || ev.location || "event"}"~"${cand.name}"`,
      });
    }
  }
}

emit({
  decision: "escalate",
  reasoning: active.length > 0 ? "active_event_no_match" : "no_active_event",
});
