#!/usr/bin/env node
// decisions — one waiting decision a day, as a hum question.
//
// Requirement (2026-10-22): questions that waited at the bottom of the weekly
// review email (improvement planner + cost review) reach the user in chat
// instead, one a day, most important first, as a hum lane — so it shares hum's
// daily ping budget and quiet hours, waits while the user is moving and stays
// quiet mid-conversation. All of that is hum's existing
// machinery; this lane only nominates.
//
// The candidate carries no wording. When it wins, hum.md Step 4 sends it with
// `decision-ask --ref <ref>`, which builds the multiple-choice card (header
// chip, bold question, numbered options with a grey description, the
// recommended option first, "Type something") from the source entry. The
// ranker never rewrites it.
//
// Pacing is code (lib/decision-queue.mjs nextDecision): nothing once a
// decision was asked on the user's local today; one asked in the last 7 days and
// still open is skipped so it does not block the rest. No model call here.
// Fail-closed: any error → null, never blocks a tick.

import { readStdinJson, emit, emitNull, emitNoop, stampRun } from "./_common.mjs";
import { nextDecision } from "../../../lib/decision-queue.mjs";
import { userTz } from "../../../lib/hum-events.mjs";
import { loadOpen } from "../../../lib/decision-queue.mjs";
import { reportBacklog, currentScale, recentlyOffered } from "../../../lib/question-pacing.mjs";

await readStdinJson();

try {
  const items = loadOpen();
  reportBacklog("decisions", items.length);
  // More than one a day per pacing group when the question backlog is long.
  // One offered in the last few hours and held steps aside for the rest
  // (nextDecision orders by importance, so it is left out, not moved back).
  const offered = recentlyOffered("decisions");
  const fresh = items.filter((it) => !offered.has(`decision:${it.ref}`));
  let r = nextDecision({ items: fresh, tz: userTz(), perDay: currentScale() });
  if (!r.decision && fresh.length < items.length) r = nextDecision({ items, tz: userTz(), perDay: currentScale() });
  if (!r.decision) {
    stampRun("decisions", false);
    emitNoop(r.reason);
    process.exit(0);
  }
  const { ref, source, q } = r.decision;
  const ageDays = Math.max(0, Math.floor((Date.now() - (Date.parse(q.asked_at || "") || Date.now())) / 86400e3));
  const signal = [
    source === "people"
      ? `A question about someone the user knows, from the people tracker (open ${ageDays} day${ageDays === 1 ? "" : "s"}): whether to stay in touch, track their news, or act on a change in their life. The user asked to be asked about each person, never to have it done automatically.`
      : `A decision waiting on the user (from the ${source === "cost" ? "daily cost review" : "weekly self-improvement planner"}, open ${ageDays} day${ageDays === 1 ? "" : "s"}; ${r.waiting} waiting in all). The user asked for these one a day in chat instead of at the bottom of the weekly email.`,
    "If it wins, it is a QUESTION and code sends it as a multiple-choice card (`decision-ask --ref`); do not write or rewrite its text.",
    `The decision: ${String(q.question).slice(0, 700)}`,
  ].join("\n");

  stampRun("decisions", true);
  emit({
    topic: "decisions",
    signal,
    // A pending owner decision blocks a fix; time-sensitive ones more so. Still
    // below operational, health-urgent and time-critical candidates.
    // People questions are welcome but never pressing: below review decisions.
    urgency: source === "people" ? (q.time_sensitive ? 0.55 : 0.45) : q.time_sensitive ? 0.72 : 0.6,
    freshness_min: 0,
    dedup_key: `decision:${ref}`,
    act_fit: { effort_to_act: "quick_win", steps_to_act: ["tap an option, or type an answer"] },
    supporting_data: {
      kind: "decision",
      decision_ref: ref,
      source,
      waiting: r.waiting,
      // Rule #2: a stored question surfaces with the time it was first asked.
      evidence_as_of: q.asked_at || null,
    },
  });
} catch (err) {
  process.stderr.write(`decisions: ${err?.message || err}\n`);
  stampRun("decisions", false);
  emitNull("decisions failed");
}
