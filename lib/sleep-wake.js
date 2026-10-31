"use strict";
// sleep-wake — infer the user's actual wake-time today + sleep-time-estimate
// last night from existing signals. No new sensors; pure inference over
// what's already in Supabase.
//
// Sources, in priority order:
//   wake_time_today      = phone_unlocks.first_unlock_at for today (local)
//                          → fallback: earliest phone_context.ts today
//                          → fallback: earliest user message today
//   sleep_time_yesterday = max(last jori_messages.role=user yesterday,
//                              last phone_context.ts yesterday,
//                              last health_samples.start_date yesterday w/ relevant types)
//                          (i.e. latest interaction signal of yesterday)
//
// Since 2026-10-08 both are taken first from the night record
// (lib/sleep-night.js — phone last lock / first unlock + Apple Watch
// onset/wake); the chains above are the fallback when it has nothing.
//
// Used by:
//   bin/jori activity         — adaptive sleep/wake gate
//   lib/jori-context.js       — agent situation context
//   bin/sleep-wake               — ad-hoc query
//
// All times rendered as both ISO + "HH:MM" in the user's local TZ.
// Failures degrade to nulls — never throw, never block hum.

const fs = require("fs");
const { loadEnv } = require("./load-env.js");
const { supabaseUrl } = require("./instance.cjs");
const { installTools } = require("./root.cjs");
const { userTz } = require("./sleep-night.js");

loadEnv();

// This installation's project; none configured → every read is null.
const SUPABASE_URL = process.env.SUPABASE_URL || supabaseUrl();

function todayDateStr(tz) {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}

function addDaysStr(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function localHm(iso, tz) {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  return fmt.format(d);
}

async function sb(query) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || !SUPABASE_URL) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Convert a YYYY-MM-DD in `tz` to a UTC ISO instant for the start of that local day.
function dayStartUtcIso(dateStr, tz) {
  // Find the UTC offset for the target TZ at noon UTC on that day, then back-compute midnight.
  const noon = new Date(`${dateStr}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(noon).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  const localNoonAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMs = localNoonAsUtc - noon.getTime();
  return new Date(noon.getTime() - offsetMs - 12 * 3600 * 1000).toISOString();
}

async function fetchWakeForDate(dateStr, tz) {
  // 1. phone_unlocks (authoritative — set on first foreground of the day)
  const unlock = await sb(
    `phone_unlocks?select=first_unlock_at&date=eq.${dateStr}&order=first_unlock_at.asc&limit=1`,
  );
  if (unlock && unlock.length) {
    return { iso: unlock[0].first_unlock_at, hm: localHm(unlock[0].first_unlock_at, tz), source: "phone_unlocks" };
  }

  // 2. earliest phone_context.ts today
  const startIso = dayStartUtcIso(dateStr, tz);
  const endIso = dayStartUtcIso(addDaysStr(dateStr, 1), tz);
  const ctx = await sb(
    `phone_context?select=ts&ts=gte.${encodeURIComponent(startIso)}&ts=lt.${encodeURIComponent(endIso)}&order=ts.asc&limit=1`,
  );
  if (ctx && ctx.length) {
    return { iso: ctx[0].ts, hm: localHm(ctx[0].ts, tz), source: "phone_context" };
  }

  // 3. earliest user message today
  const msg = await sb(
    `jori_messages?select=created_at&role=eq.user&created_at=gte.${encodeURIComponent(startIso)}&created_at=lt.${encodeURIComponent(endIso)}&order=created_at.asc&limit=1`,
  );
  if (msg && msg.length) {
    return { iso: msg[0].created_at, hm: localHm(msg[0].created_at, tz), source: "user_message" };
  }

  return null;
}

async function fetchSleepForDate(dateStr, tz) {
  // Latest interaction signal anywhere in `dateStr` (the night before "today"
  // when called via inferToday). Pick the max of three sources.
  const startIso = dayStartUtcIso(dateStr, tz);
  const endIso = dayStartUtcIso(addDaysStr(dateStr, 1), tz);

  const candidates = await Promise.all([
    sb(`jori_messages?select=created_at&role=eq.user&created_at=gte.${encodeURIComponent(startIso)}&created_at=lt.${encodeURIComponent(endIso)}&order=created_at.desc&limit=1`)
      .then(rows => rows && rows.length ? { iso: rows[0].created_at, source: "user_message" } : null),
    sb(`phone_context?select=ts&ts=gte.${encodeURIComponent(startIso)}&ts=lt.${encodeURIComponent(endIso)}&order=ts.desc&limit=1`)
      .then(rows => rows && rows.length ? { iso: rows[0].ts, source: "phone_context" } : null),
  ]);

  const valid = candidates.filter(Boolean);
  if (valid.length === 0) return null;
  valid.sort((a, b) => Date.parse(b.iso) - Date.parse(a.iso));
  const best = valid[0];
  return { iso: best.iso, hm: localHm(best.iso, tz), source: best.source };
}

// Last night's record: the cron's state file when fresh and for that night,
// else a direct read. Never throws.
async function readNight(nightOf, tz) {
  try {
    const st = JSON.parse(fs.readFileSync(installTools("data/sleep-night-state.json"), "utf8"));
    if (st.night_of === nightOf && Date.now() - Date.parse(st.written_at) < 15 * 60_000) return st;
  } catch {}
  try {
    const n = await require("./sleep-night.js").fetchNight(nightOf, { tz });
    return n.fetch_errors ? null : n;
  } catch { return null; }
}

/**
 * Returns the user's wake/sleep snapshot for the current local day.
 * @param {object} [opts]
 * @param {string} [opts.tz]  Override timezone. Defaults to user-timezone.json, else the installation's zone.
 * @returns {Promise<{
 *   tz: string,
 *   today: string,
 *   wake_time_today:      {iso, hm, source} | null,
 *   sleep_time_yesterday: {iso, hm, source} | null,
 *   asleep_now: boolean,
 *   adaptive_window: {sleep_after_hm: string, wake_before_hm: string},
 * }>}
 */
async function inferToday(opts = {}) {
  const tz = opts.tz || userTz();
  const today = todayDateStr(tz);
  const yesterday = addDaysStr(today, -1);

  const [night, wakeFallback, sleepFallback] = await Promise.all([
    readNight(yesterday, tz),
    fetchWakeForDate(today, tz),
    fetchSleepForDate(yesterday, tz),
  ]);
  const fromNight = (isoTs, source) => (isoTs ? { iso: isoTs, hm: localHm(isoTs, tz), source } : null);
  const wake = (night && fromNight(night.wake_at, night.wake_source)) || wakeFallback;
  const sleep = (night && fromNight(night.sleep_at, night.sleep_source)) || sleepFallback;

  // Asleep now: the phone has been down since a bed-hours lock, or — without
  // a phone read — yesterday had a last sign and today has no wake signal yet.
  const asleep = night && night.phone_down_at ? Boolean(night.in_bed_now) : !!(sleep && !wake);

  // Adaptive window — used by hum gate to skip ticks during the inferred
  // sleep window. Defaults to the 00-09 hardcoded one when signals are absent.
  const adaptive = {
    sleep_after_hm: sleep ? sleep.hm : "00:00",
    wake_before_hm: wake ? wake.hm : "09:00",
  };

  return {
    tz,
    today,
    night: night || null,
    wake_time_today: wake,
    sleep_time_yesterday: sleep,
    asleep_now: asleep,
    adaptive_window: adaptive,
  };
}

module.exports = { inferToday, fetchWakeForDate, fetchSleepForDate };
