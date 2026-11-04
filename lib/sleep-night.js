"use strict";
// sleep-night — one night's sleep, from the phone and the Watch together.
// The last lock of the night is the sleep signal: the phone often goes to bed
// with the user, who reads before falling asleep.
//
// Two witnesses with opposite strengths:
//   - the PHONE (`phone_lock_events`) is live — a lock/unlock transition lands
//     in Supabase within a second — but only says when the phone was put down
//     and picked up, and only while the app is running;
//   - the WATCH (`health_samples`, HKCategoryTypeIdentifierSleepAnalysis) says
//     exactly when the user fell asleep and woke, but the whole night is written in
//     one batch after waking and has reached us 11 min – 17 h later.
//
// So a night is read in two passes over the same model:
//   phone_down_at  last lock before the night's long locked stretch  (live)
//   phone_up_at    first unlock after it                              (live)
//   watch_onset_at / watch_wake_at  first / last asleep segment       (late)
//   sleep_at / wake_at  the best of each — the Watch when it has arrived,
//                       otherwise the phone (sleep_at then = phone_down plus
//                       the user's measured reading latency, when we have enough
//                       nights with both to know it).
//
// `night_of` is the EVENING's local date: night_of 2026-10-08 is the sleep
// that starts the evening of the 8th and ends the morning of the 9th.
//
// The core (`resolveNight`) is pure — data in, night out — so it is tested
// without Supabase. Code owns this geometry; nothing here reads language.

const path = require("node:path");

const SLEEP_HK = "HKCategoryTypeIdentifierSleepAnalysis";
// HKCategoryValueSleepAnalysis: 0 inBed, 1 asleepUnspecified, 2 awake,
// 3 asleepCore, 4 asleepDeep, 5 asleepREM.
const ASLEEP_VALUES = new Set([1, 3, 4, 5]);

const NIGHT = {
  windowFromHour: 18,      // evening of night_of …
  windowToHour: 14,        // … to 14:00 the next day
  bedStartFromHour: 19,    // the long locked stretch must START in [19:00, 05:00)
  bedStartToHour: 5,
  minMainGapMin: 120,      // shorter than this is not a night
  // No rows at all for this long after an unlocked row: the phone went down
  // and iOS suspended the app before it could write the lock (2026-10-22:
  // last row an unlock at 00:22, next 07:29). Read the silence as locked,
  // bounded from its first row — the lock happened somewhere inside it.
  silenceAsLockedMin: 120,
  // A brief unlock in the small hours (checking the time, the bathroom) does
  // not end the night: merged when it is this short and starts in [00:00, 05:00).
  mergeBurstMaxMin: 5,
  mergeBurstToHour: 5,
  // …and a longer one (awake ≤45 min) still doesn't, when the user goes back down
  // for ≥60 min starting before 06:00.
  chainMaxBreakMin: 45,
  chainMinStretchMin: 60,
  chainStartToHour: 6,
  watchMergeGapMin: 60,    // asleep segments closer than this are one session
  minWatchSessionMin: 90,
  // The night's wake-ups, for the daily summary (watchNight):
  minWakeupSec: 30,        // a gap between asleep segments shorter than this is a seam, not a wake-up
  notableWakeMin: 5,       // awake this long is worth naming; shorter is a brief stirring
  finalDozeMin: 30,        // the last wake-up, back asleep this briefly before getting up
};

// ---------- time helpers (zone-aware, no deps) ----------

function tzOffsetMs(tz, ms) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).filter(x => x.type !== "literal").map(x => [x.type, +x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// Local wall-clock `hour` on `dateStr` in `tz` → epoch ms. Hours ≥ 24 roll over.
function localMs(dateStr, hour, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d) + hour * 3600_000;
  let ms = guess - tzOffsetMs(tz, guess);
  ms = guess - tzOffsetMs(tz, ms); // second pass settles a DST edge
  return ms;
}

function localHour(ms, tz) {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  return parseInt(h, 10);
}

function localHm(ms, tz) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(ms));
}

function localDate(ms, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(ms));
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// [from, to) on a wrapping 24 h clock (19→5 wraps midnight).
function hourIn(h, from, to) {
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const minutes = (ms) => Math.round(ms / 60_000);

// ---------- phone: locked stretches ----------

// Lock events → locked intervals. A transition is exact; a sample only proves
// the state at that moment, so an interval opened or closed by a sample is
// bounded, not exact (the change happened between the previous row and it).
function lockedIntervals(events, { nowMs = Date.now() } = {}) {
  const ev = events
    .map(e => ({ ms: Date.parse(e.ts), state: e.state }))
    .filter(e => Number.isFinite(e.ms) && e.state)
    .sort((a, b) => a.ms - b.ms);
  const out = [];
  let open = null;
  let prevMs = null;
  let prevLocked = null;
  for (const e of ev) {
    const locked = e.state === "locked" || e.state === "sample_locked";
    const silent = !open && prevLocked === false && (e.ms - prevMs) / 60_000 >= NIGHT.silenceAsLockedMin;
    if (silent) {
      open = { start_ms: prevMs, start_exact: false, start_after_ms: prevMs, silent: true };
    }
    if (locked && !open) {
      open = e.state === "locked"
        ? { start_ms: e.ms, start_exact: true }
        : { start_ms: e.ms, start_exact: false, start_after_ms: prevMs };
    } else if (!locked && open) {
      out.push({ ...open, end_ms: e.ms, end_exact: e.state === "unlocked",
                 ...(e.state === "unlocked" ? {} : { end_after_ms: prevMs }) });
      open = null;
    }
    prevMs = e.ms;
    prevLocked = locked;
  }
  if (open) out.push({ ...open, end_ms: nowMs, end_exact: false, ongoing: true });
  return out;
}

// Join locked stretches split by a brief small-hours unlock.
function mergeNightBursts(intervals, tz) {
  const out = [];
  for (const iv of intervals) {
    const last = out[out.length - 1];
    if (last && !last.ongoing) {
      const burstMin = (iv.start_ms - last.end_ms) / 60_000;
      if (burstMin <= NIGHT.mergeBurstMaxMin && hourIn(localHour(last.end_ms, tz), 0, NIGHT.mergeBurstToHour)) {
        out[out.length - 1] = {
          ...last, end_ms: iv.end_ms, end_exact: iv.end_exact, end_after_ms: iv.end_after_ms,
          ongoing: iv.ongoing, night_wakes: (last.night_wakes || 0) + 1,
        };
        continue;
      }
    }
    out.push({ ...iv });
  }
  return out;
}

function mainLockedGap(events, tz, { nowMs } = {}) {
  const ivs = mergeNightBursts(lockedIntervals(events, { nowMs }), tz)
    .filter(iv => hourIn(localHour(iv.start_ms, tz), NIGHT.bedStartFromHour, NIGHT.bedStartToHour));
  // An ongoing stretch is a night in progress as soon as it starts in bed hours;
  // a closed one must be long enough to be a night.
  const cands = ivs.filter(iv => iv.ongoing || (iv.end_ms - iv.start_ms) / 60_000 >= NIGHT.minMainGapMin);
  if (!cands.length) return null;
  cands.sort((a, b) => (b.end_ms - b.start_ms) - (a.end_ms - a.start_ms));
  let main = cands[0];
  // Insomnia: up for a while in the small hours, then back down for a real
  // stretch — the night goes on. Chain FORWARD only: the phone-down is the
  // last lock before sleep, so an earlier stretch never moves it back.
  const all = mergeNightBursts(lockedIntervals(events, { nowMs }), tz);
  for (const iv of all) {
    if (iv.start_ms <= main.end_ms || main.ongoing) continue;
    const breakMin = (iv.start_ms - main.end_ms) / 60_000;
    const longEnough = iv.ongoing || (iv.end_ms - iv.start_ms) / 60_000 >= NIGHT.chainMinStretchMin;
    if (breakMin > NIGHT.chainMaxBreakMin || !longEnough) break;
    if (!hourIn(localHour(iv.start_ms, tz), 0, NIGHT.chainStartToHour)) break;
    main = { ...main, end_ms: iv.end_ms, end_exact: iv.end_exact, end_after_ms: iv.end_after_ms,
             ongoing: iv.ongoing, night_wakes: (main.night_wakes || 0) + (iv.night_wakes || 0) + 1 };
  }
  return main;
}

// Longest silence (no lock rows at all) inside [from, to] — a long one means
// the app was not running and a missed unlock could hide in it.
function maxSilenceMin(events, fromMs, toMs) {
  const ts = events.map(e => Date.parse(e.ts)).filter(ms => ms > fromMs && ms < toMs).sort((a, b) => a - b);
  let prev = fromMs, max = 0;
  for (const t of [...ts, toMs]) { max = Math.max(max, t - prev); prev = t; }
  return minutes(max);
}

// ---------- watch: the night's sleep session ----------

// Watch rows by start. A row is OPEN when it has no usable end (null,
// unreadable, or not after its start). HealthKit closes every segment, but a
// row can still reach us zero-length, and the health MCP shows start times
// only. Either way an open row says "asleep from here for some unknown while",
// never "woke at its start".
function watchRows(samples) {
  return samples
    .map(s => ({ start: Date.parse(s.start_date), end: Date.parse(s.end_date), value: Number(s.value) }))
    .filter(s => Number.isFinite(s.start))
    .map(s => ({ ...s, open: !(Number.isFinite(s.end) && s.end > s.start) }))
    .sort((a, b) => a.start - b.start);
}

// The night's main session: closed asleep segments joined across short gaps,
// the one with the most sleep.
function mainSession(rows) {
  const sessions = [];
  for (const s of rows) {
    if (s.open || !ASLEEP_VALUES.has(s.value)) continue;
    const cur = sessions[sessions.length - 1];
    if (cur && s.start - cur.end <= NIGHT.watchMergeGapMin * 60_000) {
      cur.end = Math.max(cur.end, s.end);
      cur.asleep_ms += s.end - s.start;
      cur.segs.push(s);
    } else {
      sessions.push({ start: s.start, end: s.end, asleep_ms: s.end - s.start, segs: [s] });
    }
  }
  const main = sessions.sort((a, b) => b.asleep_ms - a.asleep_ms)[0];
  return main && main.asleep_ms >= NIGHT.minWatchSessionMin * 60_000 ? main : null;
}

function watchSession(samples) {
  const main = mainSession(watchRows(samples));
  return main ? { onset_ms: main.start, wake_ms: main.end, asleep_min: minutes(main.asleep_ms) } : null;
}

// The Watch's whole night, for the daily summary (a night read from these
// segments is accurate enough to state there). Same session as watchSession, plus what
// the saved row leaves out:
//   wakeups[]  every gap between asleep segments inside the session, whether
//              the Watch wrote it as `awake` or wrote nothing. `final_doze`
//              marks the last one when the user fell back asleep only briefly
//              before getting up.
//   wake_open  the session ends in an open asleep row, so there is no wake
//              time to state. The honest answer is a range: from the start of
//              the wake-up just before that row (or the row's own start when
//              there isn't one) to "a little after" the row's start.
// Read-only: the saved night row keeps its own shape.
function watchNight(samples) {
  const rows = watchRows(samples);
  const main = mainSession(rows);
  if (!main) return null;
  const tail = rows.filter(s => s.open && ASLEEP_VALUES.has(s.value) && s.start >= main.end
    && s.start - main.end <= NIGHT.watchMergeGapMin * 60_000).pop() || null;
  const asleep = tail ? [...main.segs, { start: tail.start, end: tail.start }] : main.segs;
  const wakeups = [];
  let reach = asleep[0].end;
  for (const s of asleep.slice(1)) {
    if (s.start - reach >= NIGHT.minWakeupSec * 1000) {
      wakeups.push({ start_ms: reach, end_ms: s.start, min: Math.max(1, minutes(s.start - reach)) });
    }
    reach = Math.max(reach, s.end);
  }
  // With an open tail, only a wake-up that runs right into it bounds the range.
  const last = wakeups[wakeups.length - 1];
  if (last && (tail ? last.end_ms === tail.start : main.end - last.end_ms <= NIGHT.finalDozeMin * 60_000)) {
    last.final_doze = true;
  }
  return {
    onset_ms: main.start,
    wake_ms: tail ? null : main.end,
    wake_open: Boolean(tail),
    ...(tail ? { wake_from_ms: last && last.final_doze ? last.start_ms : tail.start, wake_to_ms: tail.start } : {}),
    // Without the open row, whose length nobody knows: a floor when wake_open.
    asleep_min: minutes(main.asleep_ms),
    wakeups,
  };
}

// The same night as local wall-clock "HH:MM" in `tz`, the shape resolve-day
// hands the summary. Every conversion happens here, through the zone database,
// never a hand-applied offset: 04:11Z in a UTC+3 zone is 07:11, and a
// hand-applied offset once called it 06:11.
function describeNight(w, tz) {
  if (!w) return null;
  const hm = (ms) => localHm(ms, tz);
  return {
    source: "watch",
    tz,
    fell_asleep: hm(w.onset_ms),
    woke: w.wake_ms != null ? hm(w.wake_ms) : null,
    woke_range: w.wake_open ? { from: hm(w.wake_from_ms), to: hm(w.wake_to_ms) } : null,
    asleep_min: w.asleep_min,
    wakeups: w.wakeups.map(x => ({
      at: hm(x.start_ms), min: x.min,
      ...(x.min >= NIGHT.notableWakeMin ? { notable: true } : {}),
      ...(x.final_doze ? { final_doze: true } : {}),
    })),
    onset_at: iso(w.onset_ms),
    wake_at: iso(w.wake_ms),
  };
}

// The Watch rows fetchNight reads for a night, as a PostgREST query string, so
// the daily summary reads exactly the same rows the saved night was built from.
function watchSamplesQuery(nightOf, tz) {
  const q = encodeURIComponent;
  const from = localMs(nightOf, NIGHT.windowFromHour, tz);
  const to = localMs(addDays(nightOf, 1), NIGHT.windowToHour, tz);
  return `select=start_date,end_date,value,source_name&hk_type=eq.${SLEEP_HK}`
    + `&start_date=gte.${q(iso(from - 6 * 3600_000))}&start_date=lt.${q(iso(to))}`
    + `&source_name=ilike.*watch*&order=start_date.asc`;
}

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * PURE. One night from its raw rows.
 * @param {object} a
 * @param {string} a.nightOf         YYYY-MM-DD, the evening's local date
 * @param {string} a.tz              IANA zone the night is read in
 * @param {Array}  a.lockEvents      phone_lock_events rows {ts, state}
 * @param {Array}  a.watchSamples    health_samples sleep rows {start_date, end_date, value}
 * @param {Array}  [a.priorLatencies]  latency_min of earlier nights (for the estimate)
 * @param {number} [a.nowMs]
 */
function resolveNight({ nightOf, tz, lockEvents = [], watchSamples = [], priorLatencies = [], nowMs = Date.now() }) {
  const fromMs = localMs(nightOf, NIGHT.windowFromHour, tz);
  const toMs = Math.min(localMs(addDays(nightOf, 1), NIGHT.windowToHour, tz), nowMs);
  const inWin = (ms) => ms >= fromMs && ms < toMs;

  // The state carried INTO the window matters (phone already locked at 18:00),
  // so the caller passes one row before it; keep it, drop the rest outside.
  const evs = lockEvents.filter(e => Date.parse(e.ts) < toMs);
  const gap = mainLockedGap(evs, tz, { nowMs: toMs });
  const gapInWin = gap && inWin(gap.start_ms) ? gap : null;

  const watch = watchSession(watchSamples.filter(s => {
    const st = Date.parse(s.start_date);
    return st >= fromMs - 6 * 3600_000 && st < toMs; // a nap-into-night start before 18:00 still counts
  }));

  const phoneDown = gapInWin ? gapInWin.start_ms : null;
  const phoneUp = gapInWin && !gapInWin.ongoing ? gapInWin.end_ms : null;

  const latency = watch && gapInWin && gapInWin.start_exact && watch.onset_ms >= phoneDown
    ? minutes(watch.onset_ms - phoneDown) : null;
  const typicalLatency = median(priorLatencies);
  const haveTypical = typicalLatency != null && priorLatencies.filter(Number.isFinite).length >= 3;

  let sleep = null;
  if (watch) sleep = { ms: watch.onset_ms, source: "watch" };
  else if (phoneDown != null && haveTypical) sleep = { ms: phoneDown + typicalLatency * 60_000, source: "phone_down+typical_latency" };
  else if (phoneDown != null) sleep = { ms: phoneDown, source: "phone_down" };

  // The Watch wins whenever it has arrived: a 06:10 glance at the phone
  // outside the small-hours merge window ends the locked stretch, but if the
  // Watch has the user asleep until 07:40, that is the wake time.
  let wake = null;
  if (watch) wake = { ms: watch.wake_ms, source: "watch" };
  else if (phoneUp != null) wake = { ms: phoneUp, source: "phone_up" };

  return {
    night_of: nightOf,
    tz,
    phone_down_at: iso(phoneDown),
    phone_down_exact: gapInWin ? gapInWin.start_exact : null,
    phone_up_at: iso(phoneUp),
    phone_up_exact: phoneUp != null ? gapInWin.end_exact : null,
    in_bed_now: Boolean(gapInWin && gapInWin.ongoing),
    night_wakes: gapInWin ? gapInWin.night_wakes || 0 : null,
    watch_onset_at: iso(watch && watch.onset_ms),
    watch_wake_at: iso(watch && watch.wake_ms),
    watch_asleep_min: watch ? watch.asleep_min : null,
    latency_min: latency,
    typical_latency_min: haveTypical ? Math.round(typicalLatency) : null,
    sleep_at: iso(sleep && sleep.ms),
    sleep_source: sleep ? sleep.source : null,
    wake_at: iso(wake && wake.ms),
    wake_source: wake ? wake.source : null,
    max_silence_min: gapInWin ? maxSilenceMin(evs, gapInWin.start_ms, gapInWin.end_ms) : null,
    lock_rows: evs.filter(e => inWin(Date.parse(e.ts))).length,
  };
}

// ---------- I/O ----------

function sb() { return require(path.join(__dirname, "supabase-rest.js")); }

// The phone-reported zone (data/user-timezone.json), else the installation's.
function userTz() {
  try {
    const fs = require("node:fs");
    const { installTools } = require("./root.cjs");
    const j = JSON.parse(fs.readFileSync(installTools("data/user-timezone.json"), "utf8"));
    if (j.timezone) return j.timezone;
  } catch {}
  return require("./instance.cjs").instance().tz;
}

// The zone the phone itself reported around that evening; else the current one.
async function zoneForNight(nightOf) {
  const q = encodeURIComponent;
  const probe = new Date(Date.parse(`${addDays(nightOf, 1)}T06:00:00Z`)).toISOString();
  try {
    const rows = await sb().request(`/rest/v1/phone_lock_events?select=tz&ts=lt.${q(probe)}&order=ts.desc&limit=1`);
    if (rows && rows[0] && rows[0].tz) return rows[0].tz;
  } catch {}
  return userTz();
}

async function fetchNight(nightOf, { tz, nowMs = Date.now(), withHistory = true } = {}) {
  tz = tz || await zoneForNight(nightOf);
  const q = encodeURIComponent;
  const from = iso(localMs(nightOf, NIGHT.windowFromHour, tz));
  const to = iso(localMs(addDays(nightOf, 1), NIGHT.windowToHour, tz));
  const { request, requestAll } = sb();
  // A failed read degrades to "no rows" so a caller never blocks, but it is
  // reported — an empty night and an unreadable one must not look the same.
  const errors = [];
  const safe = (p) => p.catch((e) => { errors.push(e.message); return []; });
  const [before, inside, watch, history] = await Promise.all([
    safe(request(`/rest/v1/phone_lock_events?select=ts,state&ts=lt.${q(from)}&ts=gte.${q(iso(Date.parse(from) - 12 * 3600_000))}&order=ts.desc&limit=1`)),
    safe(requestAll(`/rest/v1/phone_lock_events?select=ts,state&ts=gte.${q(from)}&ts=lt.${q(to)}&order=ts.asc`)),
    safe(requestAll(`/rest/v1/health_samples?${watchSamplesQuery(nightOf, tz)}`)),
    withHistory
      ? safe(request(`/rest/v1/sleep_nights?select=latency_min&night_of=lt.${nightOf}&latency_min=not.is.null&order=night_of.desc&limit=14`))
      : Promise.resolve([]),
  ]);
  const night = resolveNight({
    nightOf, tz, nowMs,
    lockEvents: [...(before || []), ...(inside || [])],
    watchSamples: watch || [],
    priorLatencies: (history || []).map(r => r.latency_min),
  });
  if (errors.length) night.fetch_errors = errors;
  return night;
}

const SAVE_COLS = ["night_of", "tz", "phone_down_at", "phone_down_exact", "phone_up_at", "phone_up_exact",
  "night_wakes", "watch_onset_at", "watch_wake_at", "watch_asleep_min", "latency_min", "sleep_at",
  "sleep_source", "wake_at", "wake_source", "max_silence_min"];

async function saveNight(night) {
  const row = Object.fromEntries(SAVE_COLS.map(k => [k, night[k] ?? null]));
  row.updated_at = new Date().toISOString();
  await sb().request("/rest/v1/sleep_nights?on_conflict=night_of", {
    method: "POST", body: [row], prefer: "resolution=merge-duplicates,return=minimal",
  });
  return row;
}

// The night that is current at `nowMs`: before 14:00 local it is last
// evening's, after it tonight's.
function currentNightOf(tz, nowMs = Date.now()) {
  const today = localDate(nowMs, tz);
  return localHour(nowMs, tz) < NIGHT.windowToHour ? addDays(today, -1) : today;
}

module.exports = {
  NIGHT, resolveNight, lockedIntervals, mergeNightBursts, watchSession, watchNight, describeNight, watchSamplesQuery,
  fetchNight, saveNight, currentNightOf, zoneForNight, userTz, localHm, localMs, addDays,
};
