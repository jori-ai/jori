#!/usr/bin/env node
// Exercise harvester — nudges around the daily exercise block.
//
// Habit settings (sessions a week, rest days, caps, wording) come from
// agent/local/config/exercise.json via lib/exercise-config.cjs; off unless it
// is enabled and names a workout tracker CLI (`today|week|streak --json`).
//
// Today's calendar slot lives at data/exercise-today.json, written by
// bin/exercise-schedule each morning. Branches key off that slot.
//
// **Behavioural-science choices**:
//   - Cap at ~3 touches per slot per day (Kim & So 2018 message-fatigue research).
//     Drop slot-start + mid-slot info pings — they're the nag tier.
//   - Pre-slot uses if-then framing + yes/no Q (Gollwitzer 1999;
//     question-behaviour effect, Wood et al. 2016).
//   - Post-slot-miss asks "when instead?" — a recommit implementation intention,
//     never "why didn't you?" (forward-looking, no excuse-generation).
//   - Self-compassion framing after a miss (Semenchuk 2018, Neff 2023). No
//     guilt, no "you slipped again", no perfectionism.
//   - Identity language + gain framing + temptation bundling (Milkman 2014:
//     pair workout with podcast queue), from the configured encouragement
//     pools. Rotated to avoid habituation.
//   - Show weekly progress (3/5 this week), never a streak counter in the
//     reminder branches — broken-streak/what-the-hell effect cuts adherence.
//     Streak only appears in the post-session celebration.
//   - Suppress later branches when chat-agent recorded an acknowledgment
//     (slot.last_response) — respect the user's "I'm on it" / "skip today" reply.
//
// **Daily lane cap** (the user's choice: cap the exercise lane, keep the ranking)
// Capped at `daily_ping_cap` SENT exercise pings/day (counted from hum-runs.jsonl,
// not just candidates emitted) plus a hard stop at `hard_stop` local time for
// any new nudge. Applies uniformly to every branch below, including the
// post-session celebration. Enforced here, deterministically, before any branch
// runs — not left to the Step 3 ranker's judgment, so jobs/hum.md's "no
// self-imposed caps" volume policy stays correct for every other lane while
// this one is bounded by construction. The ranking threshold itself is unchanged.
//
// Branches (priority order — first match wins):
//   POST-SESSION          within 3h of finishing: celebrate (low urgency)
//   POST-SLOT MISS        slot ended 15–90 min ago, not done, not "skip"'d (Q: when instead?)
//   PRE-SLOT              slot.start-25..-10, not acked (Q: heading to the block?)
//   EVENING RECOVERY      19:00 to the hard stop, not done, not "skip"'d (single soft nudge)
//   BACKSTOP MORNING/AFT/EVE  no slot file fallbacks (10–12 / 14:30–16 / 17:30–19:30)
//
// Urgency 0.85-0.95 throughout. The ranker brief in jobs/hum.md gives exercise
// findings preference over other candidates.
import fs from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { readStdinJson, readCache, writeCache, emit, emitNull, emitNoop, stampRun } from "./_common.mjs";

const require = createRequire(import.meta.url);
const { installTools } = require("../../../lib/root.cjs");
const { exerciseConfig, hhmmToMin } = require("../../../lib/exercise-config.cjs");
const CFG = exerciseConfig();
const TZ = CFG.tz;
const TEXTS = CFG.texts;
const BIN = CFG.tracker;
const SLOT_FILE = installTools("data/exercise-today.json");
const RUNS_FILE = installTools("data/hum-runs.jsonl");
const DAILY_PING_CAP = Number(CFG.daily_ping_cap) || 0;
const HARD_STOP_MIN = hhmmToMin(CFG.hard_stop, 21 * 60);
const HARD_STOP_LABEL = CFG.hard_stop || "21:00";

const { situation: sit } = await readStdinJson();

if (!CFG.enabled || !BIN) {
  stampRun("exercise", false);
  emitNoop("not configured (agent/local/config/exercise.json: enabled + tracker_bin)");
  process.exit(0);
}

// Compute the local minute-of-day directly — the situation snapshot only carries
// `local_hour` (no minute), but pre/mid/post-slot windows need 15-min precision.
function etNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit", minute: "2-digit", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value;
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  // "24" rolls to "00" on the day boundary in some locales — coerce.
  const h = Number.isFinite(hour) ? hour % 24 : 0;
  const m = Number.isFinite(minute) ? minute : 0;
  return { hour: h, minute: m, dateKey: `${get("year")}-${get("month")}-${get("day")}` };
}
const _now = etNow();
const minutesOfDay = _now.hour * 60 + _now.minute;
const todayKey = sit?.time?.date_local || _now.dateKey;
const cache = readCache("exercise") || {};

function etDateKeyOf(isoTs) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(isoTs));
    const get = (t) => parts.find(p => p.type === t)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch { return null; }
}

// Count exercise-topic pings that actually SENT today (not just candidates
// this harvester emitted — a candidate can lose the tick to another lane).
// Read from hum-runs.jsonl, which is the durable record of what shipped.
function countSentExercisePingsToday() {
  let raw;
  try { raw = fs.readFileSync(RUNS_FILE, "utf8"); } catch { return 0; }
  let count = 0;
  for (const line of raw.split("\n")) {
    if (!line || !line.includes('"exercise"')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.sonnet?.based_on_topic !== "exercise") continue;
    const dec = row?.sonnet?.decision;
    if (dec !== "info" && dec !== "question") continue;
    if (row?.outcome?.sent !== true) continue;
    if (etDateKeyOf(row.ts) !== todayKey) continue;
    count++;
  }
  return count;
}

function run(cmd) {
  return execSync(`"${BIN}" ${cmd}`, { encoding: "utf8", timeout: 8000 });
}
function runJson(cmd) {
  return JSON.parse(run(`${cmd} --json`));
}

const WORKOUT_NAMES = {
  strengthA: "Strength A", strengthB: "Strength B",
  bodyweightA: "Bodyweight A", bodyweightB: "Bodyweight B",
  minimumEffective: "Minimum Effective",
  cardioSteady: "Cardio (steady)", cardioIntervals: "Cardio intervals",
  rest: "Rest",
};
const display = (t) => WORKOUT_NAMES[t] || t;

let today, streak, weekData;
try {
  today = runJson("today");
  streak = runJson("streak");
  weekData = runJson("week");
} catch (e) {
  stampRun("exercise", false);
  emitNull(`tracker query failed: ${e.message}`);
  process.exit(0);
}

const planType = today.plan.workoutType;
const isRestDay = planType === "rest";
// `completed` / `inProgress` from the tracker only count sessions matching the
// PLANNED workout_type. That's the right answer for the celebration branch
// ("you did Strength A as planned"), but the WRONG answer for the miss-ping
// gates: if the user went to the gym and did cardio when strength was planned,
// those flags stay false and the harvester fires "15:00 slid by — when do you
// want to do it?" even though they exercised. The right question for the miss
// branches is "was there ANY workout today?" — derive that from `all_today`.
const completed = today.session.completed;
const inProgress = today.session.in_progress;
const allToday = today.session.all_today || [];
const anyCompletedToday = allToday.some(s => !!s.finished_at);
const anyInProgressToday = allToday.some(s => !s.finished_at);
const exercisedToday = anyCompletedToday || anyInProgressToday;

// Weekly tracking
const TARGET_PER_WEEK = Number(CFG.target_per_week) || 5;
const sessionsThisWeek = (weekData?.rows || []).filter(r => (r.sessions?.length || 0) > 0).length;
const sessionsNeeded = Math.max(0, TARGET_PER_WEEK - sessionsThisWeek);
const todayDow = new Date(todayKey + "T12:00:00").getDay();
const daysLeftInWeek = 6 - todayDow;
const totalDaysRemaining = 1 + daysLeftInWeek;
const behindWeekly = sessionsNeeded > 0 && sessionsNeeded >= totalDaysRemaining;
const slightlyBehind = sessionsNeeded > 0 && sessionsNeeded < totalDaysRemaining;
const mustOverrideRestDay = isRestDay && sessionsNeeded >= totalDaysRemaining;

function loadSlot() {
  try {
    const slot = JSON.parse(fs.readFileSync(SLOT_FILE, "utf8"));
    if (slot?.date !== todayKey) return null;
    if (!slot?.slot?.start_min) return null;
    return slot;
  } catch { return null; }
}
const slotInfo = loadSlot();
const slotStart = slotInfo?.slot?.start_min ?? null;
const slotEnd = slotInfo?.slot?.end_min ?? null;
const slotLabel = slotInfo ? `${slotInfo.slot.start_hhmm}` : null;

function urgencyFor(base) {
  let u = base;
  if (behindWeekly) u += 0.05;
  return Math.min(0.95, u);
}

function weeklyStatus() {
  // Weekly-rolling progress, not a streak counter. 4/5 is framed as a win to
  // pre-empt the "what-the-hell" effect on one miss (Silverman 2023).
  if (exercisedToday && sessionsThisWeek >= TARGET_PER_WEEK) return `${sessionsThisWeek}/${TARGET_PER_WEEK} this week ✓`;
  if (sessionsNeeded === 0) return `${sessionsThisWeek}/${TARGET_PER_WEEK} this week ✓`;
  return `${sessionsThisWeek}/${TARGET_PER_WEEK} this week`;
}

// Identity-, gain-, and temptation-bundling-framed lines (configured pools; a
// pool listed twice is weighted twice). Rotated by seed to avoid habituation
// (banner blindness sets in fast with identical copy).
const ENCOURAGE_POOLS = (TEXTS.encourage_pools || []).filter((p) => Array.isArray(p) && p.length);
function pickEncourage(seed) {
  if (!ENCOURAGE_POOLS.length) return "";
  const pool = ENCOURAGE_POOLS[Math.abs(hashStr(seed)) % ENCOURAGE_POOLS.length];
  return pool[Math.abs(hashStr(seed + ":line")) % pool.length];
}
const fillWorkout = (tpl) => String(tpl || "").split("{workout}").join(display(planType));
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// Recognised acknowledgment kinds (chat-agent writes these into the slot file).
const ACK_GOING = new Set(["yes", "yes_will_go", "going_now", "on_my_way", "going"]);
const ACK_SKIP = new Set(["skip", "skip_today", "cant_today", "done_for_today", "no"]);
const lastResponse = String(slotInfo?.last_response || "").toLowerCase();
const userSaidGoing = ACK_GOING.has(lastResponse);
const userSaidSkip = ACK_SKIP.has(lastResponse);

// --- BRANCH: post-session celebration ---
// Fires after ANY finished workout today, not just the planned type. A cardio
// session on a strength day still earned the day; withholding praise because
// it didn't match the plan is exactly the kind of moralizing the
// behavioural-science rewrite tried to remove.
function tryProgressBranch() {
  const finishedSessions = allToday
    .filter(s => !!s.finished_at)
    .sort((a, b) => new Date(b.finished_at) - new Date(a.finished_at));
  if (finishedSessions.length === 0) return null;
  const last = finishedSessions[0];
  const finishedMs = new Date(last.finished_at).getTime();
  const hoursSince = (Date.now() - finishedMs) / 3_600_000;
  if (hoursSince > 3) return null;
  if (cache.last_progress_session_id === last.id) return null;

  const streakN = streak?.streak || 0;
  writeCache("exercise", { ...cache, last_progress_session_id: last.id });
  const streakNote = streakN >= 2 ? ` ${streakN}-day streak.` : "";
  const weekNote = sessionsThisWeek >= TARGET_PER_WEEK
    ? ` ${TARGET_PER_WEEK}/${TARGET_PER_WEEK} this week — done.`
    : ` ${weeklyStatus()}.`;
  const tail = TEXTS.progress_tail ? ` ${TEXTS.progress_tail}` : "";
  // Use the actual workout_type that landed, not the planned one — accurate
  // for off-plan sessions and identical for matching ones.
  const doneType = last.workout_type || planType;
  return {
    topic: "exercise",
    signal: `${display(doneType)} done.${streakNote}${tail}${weekNote}`,
    urgency: 0.35,
    freshness_min: 0,
    dedup_key: `exercise-progress:${todayKey}:${last.id}`,
    supporting_data: { branch: "progress", streak: streakN, session_id: last.id, workout_type: doneType, planned_type: planType, sessions_this_week: sessionsThisWeek },
  };
}

// --- BRANCH: post-slot miss (auto-reschedule + confirm) ---
// Proactively picks the next open slot (≥1h from now, before 20:30, on a
// 30-min boundary), moves the calendar block, and tells the user what it did.
// The user can reply yes (confirm as-is), a different time, or skip.
// Suppressed if user already replied "skip" or "going" — those signals honored.
function suggestNextSlot() {
  // Round up to next 30-min boundary, at least 1h from now.
  const minStart = minutesOfDay + 60;
  const rounded = Math.ceil(minStart / 30) * 30;
  // Cap at the configured latest reschedule time.
  if (rounded >= hhmmToMin(CFG.latest_reschedule, 20 * 60 + 30)) return null;
  const hh = String(Math.floor(rounded / 60)).padStart(2, "0");
  const mm = String(rounded % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function tryPostSlotMissBranch() {
  if (!slotInfo || slotEnd == null) return null;
  if (exercisedToday) return null;
  if (userSaidSkip) return null;
  // 15 min grace (maybe they went but haven't logged yet), 90 min outer window.
  const minutesSinceEnd = minutesOfDay - slotEnd;
  if (minutesSinceEnd < 15 || minutesSinceEnd > 90) return null;
  if (cache.miss_slot_key === `${todayKey}:${slotLabel}`) return null;
  writeCache("exercise", { ...cache, miss_slot_key: `${todayKey}:${slotLabel}` });

  const nextSlot = suggestNextSlot();
  let signal;
  let rescheduleHHMM = null;
  if (nextSlot) {
    // Auto-reschedule the calendar block. --no-notify because the signal we
    // return below already tells the user what moved and to what, and it asks
    // the question as well; without it exercise-schedule sends its own
    // "Rescheduled to HH:MM" confirmation and the user gets two buzzes about
    // one decision roughly a minute apart.
    try {
      execSync(
        `"${installTools("bin/exercise-schedule")}" --reschedule ${nextSlot} --no-notify`,
        { encoding: "utf8", timeout: 15000 }
      );
      rescheduleHHMM = nextSlot;
    } catch (_) {
      // If reschedule fails, fall back to the suggestion-only form.
    }
    const displaySlot = nextSlot.replace(/^0/, "");
    if (rescheduleHHMM) {
      signal = `${slotLabel} came and went — I moved your block to ${displaySlot}, which looks open. Does that work, or do you want a different time? ${weeklyStatus()}.`;
    } else {
      signal = `${slotLabel} came and went. How about ${displaySlot}? ${weeklyStatus()}.`;
    }
  } else {
    // Too late in the day for another slot — soft nudge only.
    signal = `${slotLabel} slid by. Bodies have off days — pick it up tomorrow. ${weeklyStatus()}.`;
  }

  return {
    topic: "exercise",
    signal,
    urgency: urgencyFor(0.92),
    freshness_min: 0,
    dedup_key: `exercise-miss:${todayKey}:${slotLabel}`,
    supporting_data: {
      branch: "post-slot-miss",
      slot_start: slotInfo.slot.start_hhmm,
      slot_end: slotInfo.slot.end_hhmm,
      workout_type: planType,
      sessions_this_week: sessionsThisWeek,
      sessions_needed: sessionsNeeded,
      rescheduled_to: rescheduleHHMM,
      ask_kind: "exercise_reschedule",
      memory_hook: "exercise_recommit",
    },
  };
}

// --- BRANCH: pre-slot (if-then question with gain framing) ---
// Encodes an implementation intention ("at HH:MM, leave the desk") + asks a
// yes/no question (commitment effect) + gain frame in the encouragement line.
// Suppressed if user already acked going/skip for this slot.
function tryPreSlotBranch() {
  if (!slotInfo || slotStart == null) return null;
  if (exercisedToday) return null;
  if (userSaidGoing || userSaidSkip) return null;
  if (minutesOfDay < slotStart - 25 || minutesOfDay > slotStart - 10) return null;
  if (cache.pre_slot_key === `${todayKey}:${slotLabel}`) return null;
  writeCache("exercise", { ...cache, pre_slot_key: `${todayKey}:${slotLabel}` });

  const enc = pickEncourage(`pre:${todayKey}:${slotLabel}`);
  return {
    topic: "exercise",
    signal: `${slotLabel} is coming up — ${display(planType)}, 30 min.${enc ? ` ${enc}` : ""} You going? (${weeklyStatus()})`,
    urgency: urgencyFor(0.9),
    freshness_min: 0,
    dedup_key: `exercise-pre-slot:${todayKey}:${slotLabel}`,
    supporting_data: {
      branch: "pre-slot",
      slot_start: slotInfo.slot.start_hhmm,
      workout_type: planType,
      sessions_this_week: sessionsThisWeek,
      ask_kind: "exercise_attendance",
      memory_hook: "exercise_attendance",
    },
  };
}

// --- BRANCH: evening recovery (single soft nudge) ---
// One forward-looking line per day. No guilt. Suppressed if user already
// "skip"'d today.
function tryEveningRecoveryBranch() {
  if (exercisedToday) return null;
  if (userSaidSkip) return null;
  if (isRestDay && !mustOverrideRestDay) return null;
  if (minutesOfDay < 19 * 60 || minutesOfDay >= HARD_STOP_MIN) return null;
  if (cache.evening_recovery_date === todayKey) return null;
  writeCache("exercise", { ...cache, evening_recovery_date: todayKey });

  // Frame around what's still possible, not what's been missed.
  const tail = behindWeekly
    ? "There's still time tonight — even 20 minutes counts."
    : "A quick 30 tonight keeps the week on track.";
  return {
    topic: "exercise",
    signal: `${tail} ${weeklyStatus()}.`,
    urgency: urgencyFor(behindWeekly ? 0.9 : 0.82),
    freshness_min: 0,
    dedup_key: `exercise-evening-recovery:${todayKey}`,
    supporting_data: { branch: "evening-recovery", workout_type: planType, sessions_this_week: sessionsThisWeek, behind_weekly: behindWeekly },
  };
}

// --- BACKSTOPS (only when no slot file — e.g. exercise-schedule didn't run) ---
function tryBackstopAfternoon() {
  if (slotInfo) return null;
  if (userSaidSkip) return null;
  if (isRestDay && !mustOverrideRestDay) return null;
  if (exercisedToday) return null;
  if (minutesOfDay < 14 * 60 + 30 || minutesOfDay >= 16 * 60) return null;
  if (cache.afternoon_date === todayKey) return null;
  writeCache("exercise", { ...cache, afternoon_date: todayKey });
  const enc = pickEncourage(`aft:${todayKey}`);
  return {
    topic: "exercise",
    signal: `${fillWorkout(TEXTS.backstop?.afternoon)}${enc ? ` ${enc}` : ""} (${weeklyStatus()})`,
    urgency: urgencyFor(0.85),
    freshness_min: 0,
    dedup_key: `exercise-afternoon:${todayKey}`,
    supporting_data: { branch: "afternoon-backstop", workout_type: planType, sessions_this_week: sessionsThisWeek, behind_weekly: behindWeekly },
  };
}
function tryBackstopEvening() {
  if (slotInfo) return null;
  if (userSaidSkip) return null;
  if (isRestDay && !mustOverrideRestDay) return null;
  if (exercisedToday) return null;
  if (minutesOfDay < 17 * 60 + 30 || minutesOfDay >= 19 * 60 + 30) return null;
  if (cache.evening_date === todayKey) return null;
  writeCache("exercise", { ...cache, evening_date: todayKey });
  const enc = pickEncourage(`eve:${todayKey}`);
  return {
    topic: "exercise",
    signal: `${fillWorkout(TEXTS.backstop?.evening)}${enc ? ` ${enc}` : ""} (${weeklyStatus()})`,
    urgency: urgencyFor(0.88),
    freshness_min: 0,
    dedup_key: `exercise-evening:${todayKey}`,
    supporting_data: { branch: "evening-backstop", workout_type: planType, sessions_this_week: sessionsThisWeek, behind_weekly: behindWeekly },
  };
}
function tryBackstopMorning() {
  if (slotInfo) return null;
  if (userSaidSkip) return null;
  if (isRestDay && !mustOverrideRestDay) return null;
  if (exercisedToday) return null;
  if (minutesOfDay < 10 * 60 || minutesOfDay >= 12 * 60) return null;
  if (cache.morning_date === todayKey) return null;
  writeCache("exercise", { ...cache, morning_date: todayKey });
  const enc = pickEncourage(`morn:${todayKey}`);
  return {
    topic: "exercise",
    signal: `${fillWorkout(TEXTS.backstop?.morning)}${enc ? ` ${enc}` : ""} (${weeklyStatus()})`,
    urgency: urgencyFor(0.85),
    freshness_min: 0,
    dedup_key: `exercise-morning:${todayKey}`,
    supporting_data: { branch: "morning-backstop", workout_type: planType, sessions_this_week: sessionsThisWeek, must_override_rest: mustOverrideRestDay },
  };
}

// Capture a command's stdout even when it exits non-zero (home-presence exits 1
// when away but still prints its JSON to stdout).
function execCapture(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 8000 });
  } catch (e) {
    return (e.stdout || "").toString();
  }
}

// Day-level travel gate — same source the morning placement uses. On a flight /
// trip / hotel day there's no point nudging toward the gym. Fail-open
// (home) on any error so a flaky read never silences the habit.
function isAwayTravelToday() {
  try {
    const out = execCapture(`"${installTools("bin/home-presence")}" "${todayKey}" --json`);
    return JSON.parse(out).at_home === false;
  } catch {
    return false;
  }
}

// Real-time location gate — catches the ad-hoc "in the car / out for the day"
// case the calendar can't know about (home-base per flights.json but
// physically across town right now). Only suppresses when CONFIDENT: a fresh
// fix well outside every home place. Fail-open on stale/missing GPS.
function isCurrentlyFarFromHome() {
  // Named locations whose name contains one of the configured home place names.
  const homeNames = (TEXTS.home_place_names || []).map((n) => String(n).toLowerCase()).filter(Boolean);
  const isHomeName = (name) => homeNames.some((h) => String(name || "").toLowerCase().includes(h));
  const FAR_KM = Number(CFG.far_km) || 8; // clearly not home and not a neighborhood gym
  const MAX_AGE_MIN = 90;  // only trust a reasonably fresh fix
  try {
    const out = execCapture(`"${installTools("bin/geofence-check")}" --all`);
    const j = JSON.parse(out);
    if (!j || j.ok === false || !j.current) return false;
    if (!(j.current.age_minutes <= MAX_AGE_MIN)) return false;
    const homes = (j.locations || []).filter(l => isHomeName(l.name));
    if (!homes.length) return false;
    const nearest = Math.min(...homes.map(l => Number(l.distance_km)));
    return Number.isFinite(nearest) && nearest > FAR_KM;
  } catch {
    return false;
  }
}

try {
  // Daily lane cap — sent pings/day, hard stop time. Checked first,
  // unconditionally, before any branch (including celebration) gets a chance
  // to run. See the header comment for why this lives here and not in the
  // Step 3 ranker.
  const sentToday = countSentExercisePingsToday();
  if (sentToday >= DAILY_PING_CAP) {
    stampRun("exercise", false);
    emitNoop(`daily exercise ping cap reached (${sentToday}/${DAILY_PING_CAP} sent today)`);
    process.exit(0);
  }
  if (minutesOfDay >= HARD_STOP_MIN) {
    stampRun("exercise", false);
    emitNoop(`past ${HARD_STOP_LABEL} hard stop — no new exercise pings today`);
    process.exit(0);
  }

  // Celebrating a finished workout is always welcome (even a hotel-gym session
  // while traveling). Every other branch is a "go to the gym" nudge — suppress
  // those when traveling or clearly away from home, so we never nag toward
  // an impossible slot.
  const suppressNudges = isAwayTravelToday() || isCurrentlyFarFromHome();
  const branches = suppressNudges
    ? [tryProgressBranch]
    : [
        tryProgressBranch,
        tryPostSlotMissBranch,
        tryPreSlotBranch,
        tryEveningRecoveryBranch,
        tryBackstopAfternoon,
        tryBackstopEvening,
        tryBackstopMorning,
      ];
  for (const b of branches) {
    const r = b();
    if (r) {
      stampRun("exercise", true);
      emit(r);
      process.exit(0);
    }
  }
  stampRun("exercise", false);
  emitNull(suppressNudges
    ? "away (travel or far from home) — exercise nudges suppressed"
    : "no eligible branch (done, in progress, rest day on track, or outside all windows)");
} catch (e) {
  stampRun("exercise", false);
  emitNull(`exercise failed: ${e.message}`);
}
