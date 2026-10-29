#!/usr/bin/env node
// Health — Apple Health signals from Supabase (health_samples).
// Surfaces:
//   - last night's sleep under the short-sleep line
//   - weight not logged for N days, or a shift vs the 30d avg
//   - resting HR elevated vs its 30d baseline (last 7d avg)
//   - step count low by evening — everyday nudge
// Picks the highest-urgency finding, emits one candidate. Fail-closed.
// Every line is a pattern in the user's own numbers, never a diagnosis.
//
// Thresholds: agent/local/config/health.json `hum` (defaults below). No
// Supabase project configured = the lane is off (emits null).

import fs from "node:fs";
import { createRequire } from "node:module";
import { readStdinJson, emit, emitNull, stampRun, HOME_TZ, localConfig } from "./_common.mjs";
import presence from "../../../lib/presence.js";

const require = createRequire(import.meta.url);
const { installTools } = require("../../../lib/root.cjs");
const { loadEnv } = require("../../../lib/load-env.js");
const { supabaseUrl } = require("../../../lib/instance.cjs");

const { situation: sit, context } = await readStdinJson(); void sit; void context;

const CFG = {
  sleep_target_h: 7,
  short_sleep_h: 6,
  weight_stale_days: 7,
  weight_shift_pct: 2,
  rhr_rise_pct: 10,
  steps_low: 5000,
  steps_goal: 7000,
  steps_nudge_from_hour: 19,
  steps_nudge_to_hour: 22,
  // Who the evening walk is with, named in the nudge ("A short walk with …").
  walk_companion: "",
  ...(localConfig("health", { hum: {} }).hum || {}),
};

// The user's current zone, from the phone-reported value the phone channel
// persists to data/user-timezone.json; else the installation's zone. The day
// boundaries and the time-of-day gates below must track the user's actual
// local day, so they follow the user when travelling.
function userTz() {
  try {
    const tz = JSON.parse(fs.readFileSync(installTools("data/user-timezone.json"), "utf8"))?.timezone;
    if (tz && Intl.DateTimeFormat("en-US", { timeZone: tz })) return tz;
  } catch {}
  return HOME_TZ;
}
const TZ = userTz();

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || supabaseUrl();
if (!SUPABASE_URL) { stampRun("health", false); emitNull("no Supabase project configured"); process.exit(0); }
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!KEY) { stampRun("health", false); emitNull("no SUPABASE key in .env"); process.exit(0); }

async function sb(p, opts = {}) {
  const res = await fetch(SUPABASE_URL + p, {
    method: opts.method || "GET",
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`sb ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

// Resolve "now" and recent day boundaries in local TZ.
function localDate(d = new Date()) {
  return new Date(d.toLocaleString("en-US", { timeZone: TZ }));
}
const nowLocal = localDate();
const todayStart = new Date(nowLocal); todayStart.setHours(0, 0, 0, 0);
const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
const hour = nowLocal.getHours();

// Sum numeric samples for a quantity type over a window
async function dailySum(hkType, fromIso, toIso) {
  try {
    const rows = await sb("/rest/v1/rpc/health_bucketed", {
      method: "POST",
      body: { p_type: hkType, p_from: fromIso, p_to: toIso, p_bucket: "day", p_agg: "sum" },
    });
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}
async function dailyAvg(hkType, fromIso, toIso) {
  try {
    const rows = await sb("/rest/v1/rpc/health_bucketed", {
      method: "POST",
      body: { p_type: hkType, p_from: fromIso, p_to: toIso, p_bucket: "day", p_agg: "avg" },
    });
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}
async function latest(hkType, limit = 1) {
  // Try health_aggregates first (covers quantity types like body mass, HR),
  // fall back to health_samples (covers category types like sleep).
  try {
    const agg = await sb(`/rest/v1/health_aggregates?hk_type=eq.${encodeURIComponent(hkType)}&stat=eq.avg&select=bucket_start,value,unit&order=bucket_start.desc&limit=${limit}`);
    if (agg && agg.length) return agg.map(r => ({ start_date: r.bucket_start, value: r.value, unit: r.unit }));
    return await sb(`/rest/v1/health_samples?hk_type=eq.${encodeURIComponent(hkType)}&select=start_date,end_date,value,unit&order=start_date.desc&limit=${limit}`);
  } catch { return []; }
}
async function rawWindow(hkType, fromIso, toIso) {
  try {
    return await sb(`/rest/v1/health_samples?hk_type=eq.${encodeURIComponent(hkType)}&start_date=gte.${encodeURIComponent(fromIso)}&start_date=lt.${encodeURIComponent(toIso)}&select=start_date,end_date,value&order=start_date.asc&limit=2000`);
  } catch { return []; }
}

function mean(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null; }

// === CHECKS ===
const findings = [];

// 1. Sleep last night — sum "asleep" category samples (values 3,4,5 in HK) that end in the
//    window [yesterday 18:00, today 12:00]. Falls back to value>=1 if none match.
try {
  const fromIso = new Date(yesterdayStart.getTime() + 18 * 3600 * 1000).toISOString();
  const toIso = new Date(todayStart.getTime() + 12 * 3600 * 1000).toISOString();
  const samples = await rawWindow("HKCategoryTypeIdentifierSleepAnalysis", fromIso, toIso);
  if (samples && samples.length) {
    const asleep = samples.filter(s => Number(s.value) >= 3);
    const use = asleep.length ? asleep : samples.filter(s => Number(s.value) >= 1);
    let ms = 0;
    for (const s of use) ms += new Date(s.end_date) - new Date(s.start_date);
    const hours = ms / 3600000;
    if (hours > 0 && hours < CFG.short_sleep_h && hour >= 7 && hour <= 12) {
      findings.push({
        urgency: 0.5,
        signal: `Slept ${hours.toFixed(1)}h last night (target ≥${CFG.sleep_target_h}). Worth a nap window today or an earlier wind-down tonight.`,
        dedup_key: `health:sleep:${todayStart.toISOString().slice(0, 10)}`,
        supporting_data: { sleep_hours: +hours.toFixed(2), samples: use.length },
      });
    }
  }
} catch (e) { console.error(`[health] sleep check failed: ${e.message}`); }

// 2. Weight — latest body mass + 30d avg
try {
  const latestWt = await latest("HKQuantityTypeIdentifierBodyMass", 1);
  if (latestWt && latestWt.length) {
    const last = latestWt[0];
    const daysSince = (Date.now() - new Date(last.start_date).getTime()) / 86400000;
    const unit = last.unit || "kg";
    if (daysSince >= CFG.weight_stale_days) {
      // Away from home, skip it: a home scale isn't expected to travel, and a
      // "leave it until I'm back" said in chat is backed by nothing this lane
      // reads (the dedup_key is dated, so it is a new key every day). So ask
      // the presence data (lib/presence.js, the stays table) whether the user
      // is away from every home metro; the
      // nag stops while away and resumes on its own on return. No state file,
      // no promise to keep.
      let awayFromHome = false;
      try {
        const pres = await presence.resolvePresence("now");
        awayFromHome = !!(pres.metro && pres.metro !== "transit" && !presence.HOME_METROS.has(pres.metro));
      } catch { /* fail-open: unknown presence behaves like the pre-fix always-nag path */ }

      if (!awayFromHome) {
      // Device-pairing diagnostic — query last 30d of weight samples by source
      // to distinguish "scale paired but the user skipped" from "scale not
      // syncing" (without it a weight-sync question takes several turns).
      let deviceStatus = "unknown";
      let lastScaleSource = null;
      let lastScaleAt = null;
      try {
        const from30 = new Date(todayStart.getTime() - 30 * 86400 * 1000).toISOString();
        const raw30 = await sb(`/rest/v1/health_samples?hk_type=eq.HKQuantityTypeIdentifierBodyMass&start_date=gte.${encodeURIComponent(from30)}&select=start_date,source_name,source_bundle_id&order=start_date.desc&limit=200`);
        if (!raw30 || raw30.length === 0) {
          deviceStatus = "no-data-30d";
        } else {
          // Non-phone source = a scale (Withings, Renpho, iHealth, Eufy, etc.).
          // Phone-only sources (Health app, iPhone, manual-entry) don't count as a paired scale.
          const phonePattern = /health|iphone|ipad|apple watch|manual/i;
          const scaleSample = raw30.find(r => r.source_name && !phonePattern.test(r.source_name));
          if (scaleSample) {
            deviceStatus = "scale-active";
            lastScaleSource = scaleSample.source_name;
            lastScaleAt = scaleSample.start_date;
          } else {
            deviceStatus = "manual-only";
            lastScaleSource = raw30[0].source_name || null;
          }
        }
      } catch { /* leave deviceStatus=unknown */ }

      let signal;
      if (deviceStatus === "scale-active") {
        const scaleAgeDays = lastScaleAt ? (Date.now() - new Date(lastScaleAt).getTime()) / 86400000 : null;
        signal = `Haven't logged weight in ${Math.floor(daysSince)} days (last: ${Number(last.value).toFixed(1)} ${unit}). Scale (${lastScaleSource}) last synced ${scaleAgeDays !== null ? Math.floor(scaleAgeDays) + "d ago" : "recently"} — paired and working. Quick weigh-in this morning?`;
      } else if (deviceStatus === "manual-only" || deviceStatus === "no-data-30d") {
        signal = `Haven't logged weight in ${Math.floor(daysSince)} days (last: ${Number(last.value).toFixed(1)} ${unit}). No scale source detected in last 30d${lastScaleSource ? ` (only "${lastScaleSource}" — manual entry)` : ""} — scale may be unpaired. Check Health app > Sources, or weigh in manually.`;
      } else {
        signal = `Haven't logged weight in ${Math.floor(daysSince)} days (last: ${Number(last.value).toFixed(1)} ${unit}). Quick weigh-in this morning?`;
      }

      findings.push({
        urgency: 0.45,
        signal,
        dedup_key: `health:weight-stale:${todayStart.toISOString().slice(0, 10)}`,
        supporting_data: {
          days_since: +daysSince.toFixed(1),
          last_value: +Number(last.value).toFixed(2),
          unit,
          device_status: deviceStatus,
          last_scale_source: lastScaleSource,
          last_scale_at: lastScaleAt,
        },
      });
      }
    } else {
      // Shift vs 30d avg
      const from = new Date(todayStart.getTime() - 30 * 86400 * 1000).toISOString();
      const to = new Date(todayStart.getTime() + 86400 * 1000).toISOString();
      const series = await dailyAvg("HKQuantityTypeIdentifierBodyMass", from, to);
      const vals = series.map(r => Number(r.val ?? r.value ?? r.avg)).filter(Number.isFinite);
      const avg30 = mean(vals);
      if (avg30 && Math.abs(Number(last.value) - avg30) / avg30 >= CFG.weight_shift_pct / 100) {
        const dir = Number(last.value) > avg30 ? "up" : "down";
        const pct = Math.abs(Number(last.value) - avg30) / avg30 * 100;
        findings.push({
          urgency: 0.6,
          signal: `Weight ${dir} ${pct.toFixed(1)}% vs 30d avg (${Number(last.value).toFixed(1)} vs ${avg30.toFixed(1)} ${unit}).`,
          dedup_key: `health:weight-shift:${todayStart.toISOString().slice(0, 10)}`,
          supporting_data: { latest: +Number(last.value).toFixed(2), avg_30d: +avg30.toFixed(2), pct: +pct.toFixed(2), unit },
        });
      }
    }
  }
} catch (e) { console.error(`[health] weight check failed: ${e.message}`); }

// 3. Resting HR — 7d avg vs 30d baseline
try {
  const from30 = new Date(todayStart.getTime() - 30 * 86400 * 1000).toISOString();
  const from7 = new Date(todayStart.getTime() - 7 * 86400 * 1000).toISOString();
  const to = new Date(todayStart.getTime() + 86400 * 1000).toISOString();
  const [all30, last7Only] = await Promise.all([
    dailyAvg("HKQuantityTypeIdentifierRestingHeartRate", from30, to),
    dailyAvg("HKQuantityTypeIdentifierRestingHeartRate", from7, to),
  ]);
  const nums30 = all30.map(r => Number(r.val ?? r.value ?? r.avg)).filter(Number.isFinite);
  const nums7 = last7Only.map(r => Number(r.val ?? r.value ?? r.avg)).filter(Number.isFinite);
  const baseline = mean(nums30);
  const recent = mean(nums7);
  if (baseline && recent && (recent - baseline) / baseline >= CFG.rhr_rise_pct / 100) {
    const pct = (recent - baseline) / baseline * 100;
    findings.push({
      urgency: 0.75,
      signal: `Resting HR trending up: ${recent.toFixed(0)} bpm over last 7d vs ${baseline.toFixed(0)} bpm over 30d (+${pct.toFixed(1)}%). Often stress, under-recovery or a cold coming on; worth mentioning to a doctor if it persists.`,
      dedup_key: `health:rhr:${todayStart.toISOString().slice(0, 10)}`,
      supporting_data: { recent_7d_bpm: +recent.toFixed(1), baseline_30d_bpm: +baseline.toFixed(1), pct: +pct.toFixed(2) },
    });
  }
} catch (e) { console.error(`[health] RHR check failed: ${e.message}`); }

// 4. Steps — evening nudge only
try {
  if (hour >= CFG.steps_nudge_from_hour && hour <= CFG.steps_nudge_to_hour) {
    const series = await dailySum(
      "HKQuantityTypeIdentifierStepCount",
      todayStart.toISOString(),
      new Date(todayStart.getTime() + 86400 * 1000).toISOString(),
    );
    const today = series[0] ? Number(series[0].val ?? series[0].value ?? series[0].sum) : 0;
    if (Number.isFinite(today) && today > 0 && today < CFG.steps_low) {
      const walk = CFG.walk_companion ? `A short walk with ${CFG.walk_companion}` : "A short walk";
      const goal = CFG.steps_goal >= 1000 ? `${Math.round(CFG.steps_goal / 1000)}k` : String(CFG.steps_goal);
      findings.push({
        urgency: 0.35,
        signal: `Only ${Math.round(today).toLocaleString()} steps so far today. ${walk} could still land you near ${goal} before bed.`,
        dedup_key: `health:steps-low:${todayStart.toISOString().slice(0, 10)}`,
        supporting_data: { steps: Math.round(today) },
      });
    }
  }
} catch (e) { console.error(`[health] steps check failed: ${e.message}`); }

// Pick highest urgency
findings.sort((a, b) => b.urgency - a.urgency);
const top = findings[0];
if (!top) {
  stampRun("health", false);
  emitNull("no signal");
  process.exit(0);
}

stampRun("health", true);
emit({
  topic: "health",
  signal: top.signal,
  urgency: top.urgency,
  freshness_min: 0,
  dedup_key: top.dedup_key,
  supporting_data: { ...top.supporting_data, all_findings: findings.length },
});
