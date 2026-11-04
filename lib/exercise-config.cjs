"use strict";
// exercise-config.cjs — the exercise habit's per-installation settings, shared by
// bin/exercise-schedule (places the daily calendar block), the hum exercise
// harvester (nudges around it) and the workout sensor.
//
// Off unless agent/local/config/exercise.json sets `enabled: true`. Keys:
//   enabled               the habit is on
//   tracker_bin           CLI of the workout tracker (absolute, or relative to the
//                         install's kernel tree), answering `today|week|streak --json`:
//                           today  → {plan:{workoutType}, session:{all_today:[{id,
//                                     workout_type, started_at, finished_at}], completed,
//                                     in_progress}}
//                           week   → {rows:[{date, sessions:[…]}]}
//                           streak → {streak, last_active}
//                         "" = no tracker (sessions count as 0, the harvester is off)
//   calendar_account      account for the calendar read (default: the owner's email)
//   target_per_week       sessions a week
//   rest_days             days of week (0=Sun … 6=Sat) that are rest days
//   rest_day_on_track_min on a rest day, skip when this many sessions are done
//   preferred_slots       30-min slot starts ("HH:MM") tried first, in order
//   scan_window           ["HH:MM","HH:MM"] for the first-free-slot scan
//   fallback_slot         start of the state row written when the calendar read fails
//   lead_time_min         never place a block starting sooner than this
//   latest_reschedule     no auto-reschedule at or after this time
//   daily_ping_cap        sent exercise pings per day
//   hard_stop             no new exercise nudge at or after this time
//   far_km                a fresh fix this far from every home place suppresses nudges
//   texts_file            private JSON (path under agent/local/) with the wording:
//                           event_summary, event_match, event_description,
//                           reschedule_tail, progress_tail, home_place_names[],
//                           encourage_pools[[…]] (one pool picked per ping, then a line),
//                           backstop:{morning,afternoon,evening} ({workout} placeholder)
// Wording lives in a data file, not here, so its words are never read as
// kernel-guard tokens.

const fs = require("node:fs");
const path = require("node:path");
const { localConfig, localDir, instance } = require("./instance.cjs");
const { installTools } = require("./root.cjs");

const DEFAULT_TEXTS = {
  event_summary: "Exercise",
  event_match: "Exercise",
  event_description: "30 min workout.",
  reschedule_tail: "",
  progress_tail: "",
  home_place_names: ["home"],
  encourage_pools: [[
    "Thirty minutes is all it takes.",
    "Better mood for the rest of the day.",
    "Easier sleep tonight.",
  ]],
  backstop: {
    morning: "{workout} on the plan — 30 min in and out.",
    afternoon: "No {workout} on the books yet — 30 min this afternoon.",
    evening: "No {workout} yet — 30 min this evening still counts.",
  },
};

const DEFAULTS = {
  enabled: false,
  tracker_bin: "",
  calendar_account: "",
  target_per_week: 5,
  rest_days: [0],
  rest_day_on_track_min: 4,
  preferred_slots: [],
  scan_window: ["09:00", "18:00"],
  fallback_slot: "11:00",
  lead_time_min: 60,
  latest_reschedule: "20:30",
  daily_ping_cap: 2,
  hard_stop: "21:00",
  far_km: 8,
  texts_file: "",
};

function hhmmToMin(s, dflt = null) {
  const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return dflt;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return dflt;
  return h * 60 + mm;
}

function exerciseConfig() {
  const cfg = localConfig("exercise", DEFAULTS);
  let texts = { ...DEFAULT_TEXTS, backstop: { ...DEFAULT_TEXTS.backstop } };
  if (cfg.texts_file) {
    try {
      const file = JSON.parse(fs.readFileSync(path.join(localDir(), cfg.texts_file), "utf8"));
      texts = { ...texts, ...file, backstop: { ...texts.backstop, ...(file.backstop || {}) } };
    } catch { /* keep the generic wording */ }
  }
  const tracker = cfg.tracker_bin
    ? (path.isAbsolute(cfg.tracker_bin) ? cfg.tracker_bin : installTools(cfg.tracker_bin))
    : "";
  return {
    ...cfg,
    texts,
    tracker,
    tz: instance().tz,
    calendar_account: cfg.calendar_account || instance().owner_email,
  };
}

// Local wall-clock parts of `date` in `tz`.
function zonedParts(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const dows = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    dow: dows[get("weekday")],
  };
}

// "+HH:MM"/"-HH:MM" offset of `tz` at local noon on dateStr.
function tzOffset(dateStr, tz) {
  const noonUtc = new Date(`${dateStr}T12:00:00Z`);
  const p = zonedParts(noonUtc, tz);
  const asUtc = Date.UTC(...p.date.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))), p.hour, p.minute, p.second);
  const offMin = Math.round((asUtc - noonUtc.getTime()) / 60000);
  const sign = offMin < 0 ? "-" : "+";
  const a = Math.abs(offMin);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

module.exports = { exerciseConfig, DEFAULTS, DEFAULT_TEXTS, hhmmToMin, zonedParts, tzOffset };
