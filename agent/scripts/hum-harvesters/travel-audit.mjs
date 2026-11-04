#!/usr/bin/env node
// travel-audit — hum lane that keeps the canonical travel timeline honest.
// The assistant maintains the timeline automatically from bookings
// (flights-scan → `travel sync`) + manual edits; this lane is the consistency
// check: it runs `travel audit` and, when the timeline and the bookings
// disagree, floats ONE question so the user can reconcile.
//
// Discrepancy kinds (from `travel audit --json`):
//   missing_segment  — a booked flight leg isn't in the timeline (sync stale)
//   stale_segment    — a flights segment with no live booking (canceled?)
//   lodging_conflict — lodging in a recognized metro that contradicts the timeline
//   overlap_flight   — a manual stay overlapping a flight (can't be both)
//
// Read-only: never mutates the timeline. It surfaces a question; the chat-agent
// applies the fix via `travel add|edit|rm|sync` after the user answers.
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emit, emitNull, stampRun } from "./_common.mjs";
import { extractJsonObject } from "../../../lib/extract-json.mjs";

const TRAVEL = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../bin/travel");

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

let report;
try {
  const out = execSync(`"${TRAVEL}" audit --json`, { encoding: "utf8", timeout: 15000 });
  report = JSON.parse(out);
} catch (e) {
  // `travel audit` can exit non-zero on environment trouble but still print
  // JSON; try to recover, else stay silent (don't nag on a plumbing hiccup).
  report = extractJsonObject(String(e.stdout || ""), { requireKey: "issues" });
  if (!report) { stampRun("travel_audit", false); emitNull(`travel audit failed: ${e.message}`); process.exit(0); }
}

const issues = (report && report.issues) || [];
if (!issues.length) { stampRun("travel_audit", false); emitNull("travel timeline consistent with bookings"); process.exit(0); }

// Stable dedup key over the current discrepancy set — a NEW/changed set re-asks;
// the same unresolved set rides hum's 3×/day silence cap instead of repeating.
const sig = issues.map(i => `${i.kind}:${i.ref || i.id || i.detail}`).sort().join("|");
const dedupKey = `travel-audit:${hash(sig)}`;

const head = issues[0].detail;
const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
const signal =
  `Heads up — your travel schedule and your bookings disagree in ${issues.length} spot${issues.length > 1 ? "s" : ""}. ` +
  `${head}${more}. Want me to reconcile the timeline, or is a booking wrong?`;

stampRun("travel_audit", true);
emit({
  topic: "travel_audit",
  signal,
  urgency: 0.55,
  freshness_min: 0,
  dedup_key: dedupKey,
  supporting_data: {
    branch: "consistency-audit",
    issue_count: issues.length,
    issues: issues.slice(0, 6),
    ask_kind: "travel_reconcile",
    fix_hint: "after the user answers, apply via `travel add|edit|rm` (manual) or `travel sync` (re-pull bookings)",
  },
  act_fit: { effort_to_act: "quick_win", steps_to_act: ["confirm which side is right", "run the matching `travel` command"] },
});
