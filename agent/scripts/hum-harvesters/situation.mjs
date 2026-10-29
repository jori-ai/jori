#!/usr/bin/env node
// situation — the timeliness lane (added 2026-05-20).
//
// Reasons over the CURRENT moment (live-day, calendar, working_on, recent
// chat, today's stops) and emits a candidate ONLY when there's a
// timely-fit suggestion no domain harvester would catch. The three target
// classes (2026-05-20):
//
//   NOW           — what the user is in the middle of (deep work, walk, transit)
//   NEXT          — what's coming up (the 3pm meeting, dinner at 7)
//   SHOULD-BE-DOING — commitments not yet honored, prep that needs to
//                     happen, free windows aligned with open items — but only
//                     with a fact about the item the user may not have (2026-10-09)
//
// This lane is generative: candidates aren't pulled from a feed, they're
// reasoned from situation. As a result it runs on every hum turn; a Sonnet
// --effort low subagent does the reasoning. Cost is bounded by the input memo
// (step 4 below: unchanged inputs + a prior reject → no call), the tight prompt
// and the low effort tier.
//
// Output (when non-null) carries temporal_fit aggressively so the ranker
// knows these are time-anchored, not domain rarities.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readStdinJson, readCache, writeCache, emit, emitNull, emitNoop, stampRun } from "./_common.mjs";
import { extractJsonObject } from "../../../lib/extract-json.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MODELS } = require("../../../lib/models.cjs");
const HOME = os.homedir();
const DATA = path.join(require("../../../lib/root.cjs").installRoot(), "data");
const LEARNINGS = path.join(DATA, "hum-learnings.jsonl");
const LIVE_DAY = path.join(DATA, "live-day.json");
const FEEDBACK = path.join(DATA, "hum-feedback.jsonl");
const CLAUDE_BIN = path.join(HOME, ".local/bin/claude");

const { situation: sit, context } = await readStdinJson();

// Cheap escape hatches — skip the LLM call entirely when there's nothing to
// reason about. The harvester pays Sonnet only when situation has substance.

// 1. Sleeping / no-typing-no-location windows: no point reasoning.
const audio = (sit.environment || {}).audio_class || "unknown";
const hour = (sit.time || {}).local_hour;
if (hour !== undefined && (hour < 7 || hour >= 23)) {
  stampRun("situation", false);
  emitNull("outside active hours");
  process.exit(0);
}

// 2. If there's literally no calendar, no recent activity, no live-day
//    intervals, no working_on, the lane has nothing to offer.
const calNext = ((sit.next || {}).upcoming_events || []).slice(0, 5);
const calNow = (sit.now || {}).current_event || null;
const working = ((sit.working_on || {}).week_commit_topics || []).slice(0, 5);
const liveDay = safeReadJson(LIVE_DAY) || {};
const intervals = (liveDay.intervals || []).slice(-8);  // last 8 intervals of today
const recentLearnings = readTailJsonl(LEARNINGS, 20);
const recentFeedback = readTailJsonl(FEEDBACK, 12);

// Deterministic time-math table (Rule #0b: code owns arithmetic, the model
// only phrases it). Built here rather than left to the model because the
// obvious-looking source — sit.next.upcoming_events — is capped to a 2h
// horizon (bin/jori cmdHumSituation), so anything further out (a 7pm
// dinner spotted at 4pm) never appears there at all. live-day.json's
// calendar-seeded intervals carry the real ISO start/end for the whole day,
// which is what actually caused the 2026-09-24 bug: Sonnet had the raw
// timestamps in LIVE-DAY and still free-handed "40 minutes free" against a
// dinner that was 2h54m out. Handing it a pre-subtracted number instead of
// raw timestamps closes that gap.
const nowMs = Date.now();
const timeMath = [];
for (const iv of intervals) {
  const startMs = Date.parse(iv.start);
  const endMs = Date.parse(iv.end);
  const anchor = iv.calendar?.summary || iv.place?.name || iv.id;
  if (Number.isFinite(startMs) && startMs > nowMs) {
    timeMath.push({ anchor, starts_in_min: Math.round((startMs - nowMs) / 60000) });
  } else if (Number.isFinite(endMs) && endMs > nowMs) {
    timeMath.push({ anchor, ends_in_min: Math.round((endMs - nowMs) / 60000) });
  }
}
for (const e of calNext) {
  if (typeof e.in_min === "number") timeMath.push({ anchor: e.summary, starts_in_min: e.in_min });
}

if (calNext.length === 0 && !calNow && working.length === 0 && intervals.length === 0) {
  stampRun("situation", false);
  emitNull("situation too thin to reason on");
  process.exit(0);
}

// 3. Dedup: this lane is generative, so it can collide with itself if
//    the situation hasn't moved. Bucket by hour + the dominant anchor.
const anchorHint = (calNow && calNow.id) || (calNext[0] && calNext[0].id)
  || (working[0]) || "free-window";
const hourBucket = (sit.time || {}).local_iso?.slice(0, 13) || "unknown";

// 4. Input memo (2026-10-04 determinism review). Every hum turn runs this lane
//    and it used to pay a Sonnet call each time even when nothing it reasons
//    over had moved since the last call — which had already said "nothing
//    timely" (emit:false). Hash the structural inputs; if they match the last
//    call AND that call rejected, the answer cannot have changed, so reuse it.
//    The hour bucket is in the hash, so the memo expires on its own every hour
//    (time-of-day is an input: "you've been at the desk 3h" needs the clock).
//    A memo only ever caches a REJECT — an emit is never replayed, so a stale
//    memo can at worst cost one extra Sonnet call, never send anything.
const MEMO_TOPIC = "situation-memo";
const memoHash = createHash("sha256").update(JSON.stringify({
  hour: hourBucket,
  cal_now: calNow ? [calNow.id ?? null, calNow.summary ?? null] : null,
  cal_next: calNext.map((e) => [e.id ?? null, e.summary ?? null, e.in_min ?? null]),
  intervals: intervals.map((iv) => [iv.id ?? null, iv.start ?? null, iv.end ?? null, iv.place?.name ?? null, iv.activity ?? null]),
  working,
  learnings_tail: recentLearnings.map((l) => [l.answered_at ?? null, l.subject ?? null]),
  feedback_tail: recentFeedback.map((f) => [f.sent_at ?? null, f.reaction ?? null]),
  where: [sit.where?.place ?? null, sit.where?.activity ?? null],
  activity_state: sit.time?.activity_state ?? null,
})).digest("hex");
const memo = readCache(MEMO_TOPIC);
if (memo && memo.hash === memoHash && memo.emit === false) {
  stampRun("situation", false);
  emitNoop(`memo: inputs unchanged since ${memo._cached_at} reject (${String(memo.reason || "no reason").slice(0, 100)})`);
  process.exit(0);
}

// Build the reasoning prompt. Kept tight — Sonnet should reason fast and
// reject most ticks. The output schema is rigid so we can parse without
// re-reading the model.
//
// Class C needs a new fact (2026-10-09). Requirement: never send progress-free
// nudges for items the user is actively working on. Of the 7 SHOULD pings sent
// over four months, the 6 that only said "X is due, you're free now" drew no
// reaction; the one the user engaged with ('more') carried a fact the user
// lacked (someone missing from a trip itinerary). Over three days this lane
// emitted "the tour build is still on today's list" on four ticks, for a task
// the user re-dates each morning; none reached the user (the precheck
// suppressed the three sent to it, but on a misread reply, not for this).
const prompt = `You are the SITUATION harvester for the user's hum. Your one job: notice when a TIMELY suggestion is more valuable than any pre-prepared content could be. You may emit AT MOST one candidate.

Three valid classes of timely suggestion:
  A. NOW — the user is mid-something and there's a small useful nudge (e.g. "you've been at desk 3h; take 10")
  B. NEXT — something is coming up where preparation now matters (e.g. "3pm broker call; 30 min free now to review prep notes")
  C. SHOULD-BE-DOING — a commitment of the user's that lines up with a free window in the user's next 4h AND something about it the user may not know: a problem, a missing piece, a dependency, a deadline that moved (e.g. "the Aug 12 flight itinerary lists you and your partner but not the dog; you have 45 min free now to sort it out")

TIME MATH — never compute a time gap yourself. TIME_MATH below is code-computed and authoritative: minutes-until-start or minutes-until-end for every anchor with a known clock time, subtracted from the real current time. If your "signal" states any number of minutes or hours, it MUST be quoted from TIME_MATH — do not subtract, round, or estimate from timestamps you see elsewhere in SITUATION or LIVE-DAY, even though they're right there. If the anchor you want to reference isn't listed in TIME_MATH, do not state a specific duration at all — describe it without a number ("before dinner", "later tonight") or drop the timing framing.

REJECT (emit null) when:
- Situation is uneventful (no calendar, idle, nothing recent worth flagging)
- Any timely suggestion would just restate visible info (next meeting, weather)
- The same suggestion has already fired in RECENT_FEEDBACK (same anchor in last 24h)
- The anchor is an event the user has already prepped for or done (check LEARNINGS)
- The 'should-be-doing' commitment can't be matched to a specific calendar window
- All a SHOULD would say is that an item on the user's own task list (or a commitment the user made) is due, overdue or still open and that the user has time free now. The user keeps their own list and knows what is on it; "X is due today and you have an hour, good time to do it" is a progress-free reminder the user has said adds nothing. A SHOULD must carry a fact the user may not have.

Output a strict JSON object — pick exactly one shape, no prose, no markdown:

  {"emit":false,"reason":"<one phrase>"}

  OR

  {"emit":true,
   "class":"NOW"|"NEXT"|"SHOULD",
   "signal":"<≤2 lines, Jori voice; lead with the anchor + the timely ask>",
   "urgency":0.55-0.95,
   "anchor":"<event-id or commitment phrase or HH:MM window>",
   "dedup_key":"situation:<class>:<short anchor>:<YYYY-MM-DD>",
   "boost_during":["pre_event_30min"|"post_event_15min"|"evening_wind_down"|"free_block_aligned"|...],
   "rationale":"<one line why timely now>"}

SITUATION (the moment to reason on):
${JSON.stringify({
  now: sit.now,
  next: sit.next,
  where: sit.where,
  environment: sit.environment,
  time: sit.time,
  working_on: sit.working_on,
}, null, 2)}

LIVE-DAY (today's intervals + activity hints):
${JSON.stringify({ intervals }, null, 2)}

TIME_MATH (code-computed minutes from right now — the ONLY source for any number you state):
${JSON.stringify(timeMath, null, 2)}

RECENT LEARNINGS (last 20 answered Q&A — commitments mentioned here are SHOULD-BE-DOING candidates):
${recentLearnings.map(l => `- [${(l.answered_at || "").slice(0,10)}] ${l.subject}: A: ${(l.answer || "").slice(0,140)}`).join("\n") || "(none)"}

RECENT FEEDBACK (last 12 — don't repeat a recently-pinged anchor):
${recentFeedback.map(f => `- ${f.sent_at || ""} ${f.lane || ""} ${(f.findings || []).map(x => x.summary || "").join("; ").slice(0,120)} reaction=${f.reaction || "null"}`).join("\n") || "(none)"}`;

// Spawn Sonnet --effort low (cheap, fast). Per agent/CLAUDE.md
// § Effort Policy, fork-per-invocation subagents use --effort low inline.
// Inherit parent env unchanged — the supervisor has already stripped
// ANTHROPIC_API_KEY at spawn time per the Max-only auth invariant in
// agent/CLAUDE.md § Auth Model. Re-setting the var to "" here
// confused the Max-auth check and failed every call.
const r = spawnSync(CLAUDE_BIN, [
  "-p",
  "--model", MODELS.sonnet,
  "--effort", "low",
  "--output-format", "text",
  prompt,
], {
  encoding: "utf8",
  timeout: 30000,
});

if (r.status !== 0) {
  stampRun("situation", false);
  emitNull(`sonnet exit=${r.status}: ${(r.stderr || "").slice(0,200)}`);
  process.exit(0);
}

let parsed;
try {
  // Sonnet sometimes wraps JSON in prose; take the first balanced object that
  // carries the `emit` key (a greedy {...} match broke on any brace in prose).
  parsed = extractJsonObject(String(r.stdout || "").trim(), { requireKey: "emit" });
  if (!parsed) throw new Error("no JSON object");
} catch {
  stampRun("situation", false);
  emitNull(`sonnet output non-JSON: ${String(r.stdout || "").slice(0,200)}`);
  process.exit(0);
}

if (!parsed || parsed.emit !== true) {
  // Only a clean model reject is memoized — never a parse failure or a crash.
  writeCache(MEMO_TOPIC, { hash: memoHash, emit: false, reason: (parsed && parsed.reason) || null });
  stampRun("situation", false);
  emitNull(`sonnet rejected: ${(parsed && parsed.reason) || "no reason"}`);
  process.exit(0);
}

// Build the candidate. temporal_fit is the headline — this lane exists to
// carry that signal.
const today = new Date().toISOString().slice(0, 10);
const candidate = {
  topic: "situation",
  signal: String(parsed.signal || "").slice(0, 1500),
  urgency: Math.max(0.5, Math.min(0.95, Number(parsed.urgency) || 0.6)),
  freshness_min: 0,  // by definition this is RIGHT NOW
  dedup_key: parsed.dedup_key || `situation:${parsed.class || "X"}:${anchorHint}:${today}`,
  supporting_data: {
    class: parsed.class || "NOW",
    anchor: parsed.anchor || anchorHint,
    rationale: parsed.rationale || "",
    hour_bucket: hourBucket,
  },
  temporal_fit: {
    relative_to: parsed.class === "NEXT" ? "calendar_event"
              : parsed.class === "NOW" ? "transition"
              : "commitment",
    anchor: parsed.anchor || anchorHint,
    boost_during: Array.isArray(parsed.boost_during) ? parsed.boost_during : ["free_block_aligned"],
    expires_after_iso: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
  },
  // Situation candidates are about acting on something the user already
  // knows. By class:
  //   NOW = quick_win (a transition nudge — "take a break", "leave for X")
  //   NEXT = quick_win (preparing for an event the user scheduled)
  //   SHOULD = moderate (a commitment requiring work the user already committed
  //            to do; not heavy because the user already chose it, but >quick because
  //            it requires a block of time + focus shift)
  act_fit: {
    effort_to_act: parsed.class === "SHOULD" ? "moderate" : "quick_win",
  },
};

stampRun("situation", true);
emit(candidate);

// ─── helpers ───────────────────────────────────────────────────────────
function safeReadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function readTailJsonl(p, n) {
  try {
    const lines = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
