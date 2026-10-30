"use strict";
// resolve-day.js — build a deterministic ResolvedDay for a given date.
//
// As of 2026-04-25, the underlying GPS resolver is `location-segment` (Li/Zheng
// anchor-walk + OSM Overpass primary + Google Places enrichment + tie-aware
// confidence). The legacy `location-stops` is no longer called from here — see
// the migration notes in system/changelog.md (2026-04-25).
//
// The classification ladder is now mostly resolved INSIDE location-segment via
// resolve_place's tier order: named_location → confirmed_stop → known_recurring →
// wifi_ssid → osm_overpass / google_places (merged) → reverse_geocode → coordinate.
// The post-processing in this file:
//   - re-applies known_recurring + user-confirmed (Supabase) on top, in case
//     an OSM venue resolved past a recurring stop (defensive)
//   - merges Supabase `location_history` companions[] onto matching segments
//     (segment doesn't fetch them yet)
//   - adds inferred "calendar" stops for events with physical locations not
//     already overlapping a GPS stop (port from old location-stops)
//
// Adds:
//   - wake/sleep signals (phone_unlocks first_unlock_at + last jori_messages)
//   - travel_legs between consecutive stops (legacy field — still produced)
//   - routes[] (NEW) — segment's per-route output with multi-leg mode classification
//   - gaps[] (NEW)   — segment's no-GPS windows
//   - summary{} (NEW) — segment's aggregate stats
//   - corrections[] — self-sent iMessages a model read as retroactive meta-signals
//                     (NOT to be treated as declarative facts by the narrator);
//                     read by bin/day-statements, never by a pattern here
//
// Emails / commits / tasks are NOT anchored here — the playbook still harvests
// those and weaves them into the narrative using resolve-day's stops as the
// source of truth for when/where.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const { loadKnownStops, matchStop, haversineMeters, entriesMissingCoords } = require(path.join(__dirname, "known-stops.js"));
const { loadNamedLocations, matchNamedLocation, loadAddressHomes, addressCandidates } = require(path.join(__dirname, "named-locations.js"));
const { writeCalendarFile } = require(path.join(__dirname, "location-calendar-fuse.js"));
const { loadEnv } = require(path.join(__dirname, "load-env.js"));
const { detectExcursions, detectGapLoops, titleStretch } = require(path.join(__dirname, "day-excursions.js"));
const { findRests, restAt, splitStopOnRests, preciseCount, usablePings } = require(path.join(__dirname, "stop-rests.js"));
const { nameStopsFromPhotoText } = require(path.join(__dirname, "photo-place-name.js"));
const { planNameWriteBack, applyNameWriteBack } = require(path.join(__dirname, "stop-name-writeback.js"));
const { request: supabaseRequest } = require(path.join(__dirname, "supabase-rest.js"));
const { timezoneForCoords, tzAbbr, tzAtMs: tzAtMsIn, crossesZones } = require(path.join(__dirname, "geo-timezone.js"));
const sleepNight = require(path.join(__dirname, "sleep-night.js"));
const { zonedMidnightMs } = require(path.join(__dirname, "day-window.js"));
const tzAtMs = (stops, ms) => tzAtMsIn(stops, ms, DISPLAY_TZ);

loadEnv();

const { instance, supabaseUrl, localConfig } = require(path.join(__dirname, "instance.cjs"));
const { installRoot, installTools } = require(path.join(__dirname, "root.cjs"));
const { canonicalCompanions, canonicalName, companionNames } = require(path.join(__dirname, "companions.js"));
// The installation (its data/ and the bins this spawns by path).
const JORI = installRoot();
const LOCATION_SEGMENT_BIN = installTools("bin", "location-segment");
const IMSG_BIN = installTools("bin", "imsg");
const SUPABASE_URL = process.env.SUPABASE_URL || supabaseUrl();
// The home zone (instance().tz): the day's zone and display zone when nothing
// says the user was elsewhere.
const HOME_TZ = instance().tz;
// Day-boundary anchor -- which UTC window counts as "date X" for pulling raw
// samples/messages. The day is midnight-to-midnight in the ORIGIN timezone --
// the zone the user was in when the day began -- and never re-anchors on a zone
// crossing mid-day. This was once fixed to the home zone, which put a travel
// day's boundaries in the wrong place and made the clock jump mid-report.
// resolveDay() sets it from the day-path, which asks the travel timeline
// (travel-timezone.js: the metro slug, then a country in the label); it stays
// the home zone when the user is home. Every day seven hours east of home had
// been cut at home midnight (07:00 local) because the label named no country.
// The window arithmetic lives in day-window.js, shared with the harvest and the
// chat fetch.
let DAY_BOUNDARY_TZ = HOME_TZ;
// Display timezone — the day's default zone for HH:MM strings. Defaults to the
// home zone but resolveDay({ displayTz }) can override it to the day's actual
// local timezone (see lib/travel-timezone.js): the daily summary is always in
// the user's local time.
//
// PER-STOP LOCAL TIME (reverses the earlier "the clock never jumps
// mid-narrative" display rule): each location shows the local time there.
// A long-haul flight day rendered the departure city's evening as 12am–5am
// because everything was in the destination's time. applyPerStopTz()
// re-formats every stop in the zone at its own coordinates; DISPLAY_TZ stays
// the fallback for anything with no position. The day WINDOW is unchanged.
let DISPLAY_TZ = HOME_TZ;

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function formatET(dateMs, opts = {}, tz = DISPLAY_TZ) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...opts,
  }).format(new Date(dateMs));
}

function hmFromMs(dateMs, tz = DISPLAY_TZ) {
  // en-US with hour12:false still emits "24:xx" at midnight — normalize.
  const s = formatET(dateMs, {}, tz);
  return s.replace(/^24:/, "00:");
}

// Stamp each stop with the zone at its own coordinates and re-format its
// HH:MM there. Returns the distinct zones in stop order — more than one means
// the day crossed zones and every rendered time needs its label. Pure apart
// from mutating the stops it is handed.
function applyPerStopTz(stops, displayTz = DISPLAY_TZ, lookup = timezoneForCoords) {
  const tzs = [];
  for (const s of stops || []) {
    const tz = lookup(s.lat, s.lon) || displayTz;
    s.tz = tz;
    if (tz !== displayTz) {
      if (Number.isFinite(s.start_ts_ms)) s.start = hmFromMs(s.start_ts_ms, tz);
      if (Number.isFinite(s.end_ts_ms)) s.end = hmFromMs(s.end_ts_ms, tz);
    }
    if (!tzs.includes(tz)) tzs.push(tz);
  }
  if (crossesZones(tzs, displayTz)) {
    for (const s of stops) s.tz_abbr = tzAbbr(s.tz, s.start_ts_ms);
  }
  return tzs.length ? tzs : [displayTz];
}

// Hour [0,23] of a timestamp in the DAY's own zone (where the user woke), not
// the display zone. When the summary rendered in the home zone, the 04:00–13:00
// gate ran on home hours — 09:00 seven hours east was 02:00 at home and
// rejected, 11:20 was 04:20 at home and became "Woke 11:20".
// The zone is WHERE THE USER WAS (the day's first stop for wake, last for
// sleep): the day boundary itself can stay the home zone on a trip, which put
// 07:00 local at "midnight" and kept the gate on home hours.
function localHour(dateMs, tz = DAY_BOUNDARY_TZ) {
  return parseInt(hmFromMs(dateMs, tz).slice(0, 2), 10);
}

// Plausible wake window, local hours. Without a phone_unlocks row we only trust a
// phone_context / first-message proxy if it lands here — a stray late-evening or
// pre-dawn reading must never become "wake".
const WAKE_WINDOW = { minHour: 4, maxHour: 13 }; // [04:00, 13:00)

// Pure wake-time selector (exported for tests). phone_unlocks.first_unlock_at is
// authoritative at ANY hour — it IS the day's first unlock = wake. Without it,
// estimate from the EARLIEST phone_context or user-message timestamp that falls
// inside WAKE_WINDOW; if none does, return null rather than fabricate a wake.
//
// This fixes the 2026-06-27 "Woke 23:26" bug: phone_unlocks was empty and the
// old fallback returned the earliest phone_context row of the day — which was a
// single stray 23:26 reading — as the wake time. A pre-sleep 00:39 chat or a
// lone evening ping is no longer mistaken for waking up.
// Sources that observe the PHONE being used (a lock-screen unlock, a Screen
// Time usage window) say "woke"; everything else only proves he was up by then.
const PHONE_USE_SOURCES = new Set(["phone_unlocks", "phone_lock_event", "phone_usage"]);

function pickWake({ unlockMs = null, ctxMs = [], msgMs = [], extra = [], tz = DAY_BOUNDARY_TZ } = {}) {
  if (unlockMs != null && Number.isFinite(unlockMs)) {
    return { at: hmFromMs(unlockMs), source: "phone_unlocks", ts_ms: unlockMs, phone_use: true };
  }
  const inWindow = [
    ...ctxMs.map(ms => ({ ms, source: "phone_context" })),
    ...msgMs.map(ms => ({ ms, source: "first_user_message" })),
    ...extra,
  ].filter(c => {
    if (!Number.isFinite(c.ms)) return false;
    const h = localHour(c.ms, tz);
    return h >= WAKE_WINDOW.minHour && h < WAKE_WINDOW.maxHour;
  });
  if (!inWindow.length) return null;
  inWindow.sort((a, b) => a.ms - b.ms);
  const w = inWindow[0];
  return { at: hmFromMs(w.ms), source: w.source, ts_ms: w.ms, phone_use: PHONE_USE_SOURCES.has(w.source),
           ...(w.detail ? { detail: w.detail } : {}) };
}

// Local wall-clock hour on dateStr in the day's zone → UTC ISO. (Midnight from
// etBoundaryUtcIso, which already follows DAY_BOUNDARY_TZ, plus h hours.)
function localHourIso(dateStr, h, tz = DAY_BOUNDARY_TZ) {
  return new Date(Date.parse(etBoundaryUtcIso(dateStr, tz)) + h * 3600_000).toISOString();
}
const SLEEP_WINDOW = { fromHour: 17, toNextDayHour: 5 }; // [17:00, next day 05:00)
const rowsOr = (r) => (Array.isArray(r) ? r : []);

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function etBoundaryUtcIso(dateStr, tz = DAY_BOUNDARY_TZ) {
  // Midnight on dateStr in the day's zone -> UTC ISO. The shared helper reads
  // the offset at the midnight itself, so DST-change days land true.
  return new Date(zonedMidnightMs(dateStr, tz)).toISOString();
}

// ---------------------------------------------------------------------------
// location-segment wrapper + schema adapter
// ---------------------------------------------------------------------------

// Convert location-segment's stop shape (ISO timestamps, cluster_radius_m,
// `place` field) into the legacy resolve-day shape (ts_ms, cluster_radius_km,
// `primary` field) so classifyStops + buildTravelLegs work unchanged.
function adaptSegmentStop(s) {
  const start_ts_ms = Date.parse(s.start);
  const end_ts_ms = Date.parse(s.end);
  return {
    start_ts_ms,
    end_ts_ms,
    duration_minutes: s.duration_min,
    centroid: s.centroid,
    cluster_radius_km: s.cluster_radius_m != null ? s.cluster_radius_m / 1000 : null,
    sample_count: s.sample_count,
    primary: s.place ? {
      name: s.place.name,
      address: s.place.address,
      source: s.place.source,
      confidence: s.place.confidence,
      // Legacy classifier expects distance_km; segment emits distance_m on candidates.
      distance_km: s.place.distance_m != null ? s.place.distance_m / 1000 : null,
    } : null,
    alternatives: (s.alternatives || []).map(a => ({
      name: a.name,
      address: a.address,
      source: a.source,
      confidence: a.confidence,
      distance_km: a.distance_m != null ? a.distance_m / 1000 : null,
    })),
    photos: s.photos || [],
    pattern: s.pattern || "dwell",
    // calendar_event is added by enrichStopsWithCalendar below if applicable.
    calendar_event: null,
    // companions are merged from Supabase later in resolveDay.
    companions: [],
  };
}

async function runLocationSegment(dateStr) {
  // The day's own window, as explicit instants -- the same one every other fetch
  // in resolveDay uses. Bare dates are NOT safe here: location-segment reads
  // them as home-zone days, so a day cut at local midnight got raw stops from
  // 07:00 to 07:00 instead (2026-10-15: a stop after midnight leaked into Oct
  // 11 and the evening Airbnb block lost its name).
  const asOffset = (iso) => iso.replace("Z", "+00:00");
  const args = ["--start", asOffset(etBoundaryUtcIso(dateStr)), "--end", asOffset(etBoundaryUtcIso(addDays(dateStr, 1)))];
  const res = spawnSync(LOCATION_SEGMENT_BIN, args, { encoding: "utf8" });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`location-segment exited ${res.status}: ${res.stderr?.slice(0, 400)}`);
  }
  const seg = JSON.parse(res.stdout);
  // Adapt + return both the legacy-shape stops AND the rich segment payload so
  // resolveDay can pass routes/gaps/summary through to consumers.
  return {
    raw_segment: seg,
    stops: (seg.stops || []).map(adaptSegmentStop),
    sample_count: (seg.stops || []).reduce((a, s) => a + (s.sample_count || 0), 0),
    stop_count: (seg.stops || []).length,
  };
}

// Calendar fusion. Calendar events ANNOTATE GPS stops (attach calendar_event
// to the overlapping stop) but never become stops themselves — GPS is the only
// source of truth for whether the user was somewhere. Events without a GPS
// overlap are returned in `unmatched_calendar_events[]` so the narrator can
// surface them in a separate "scheduled, not at" section.
//
// Pre-2026-04-30 this function injected synthetic "calendar"-source stops with
// centroid (0,0) and confidence 0.75 for unmatched events, which polluted the
// timeline with fictional visits. Removed per the user's "GPS always wins,
// calendar only supports" rule.
//
// 2026-07-22 (the user): time-overlap alone is a background CUE, not proof the
// event happened at that stop — a multi-day "Stay at <Airbnb>" block (all-day,
// spans the whole trip) or an ordinary meeting overlaps every stop in its
// window trivially. Every calendar event (all-day or timed) is still attached
// here so the narrator has it as context, but each carries `location_match` —
// a word-overlap check between the event's own `location` field and this
// stop's independently GPS/OSM-resolved place — as the "gps" half of the
// corroboration the user asked for. The renderer (daily-summary-render.js
// `calendarCorroborated`) combines this with the "answer" half (an
// independently chat/txn-confirmed venue that agrees with the event) to decide
// whether the event is ever printed verbatim; plain time-overlap never is.
function normLocationWords(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length >= 4);
}

function calendarLocationMatchesStop(evLocation, stop) {
  if (!evLocation) return false;
  const stopText = [stop.primary?.name, stop.primary?.address].filter(Boolean).join(" ");
  if (!stopText) return false;
  const evWords = new Set(normLocationWords(evLocation));
  if (evWords.size === 0) return false;
  return normLocationWords(stopText).some(w => evWords.has(w));
}

async function enrichStopsWithCalendar(adaptedStops, dateStr) {
  const empty = { stops: adaptedStops, unmatched_calendar_events: [] };
  let calendarPath = null;
  try { calendarPath = await writeCalendarFile(dateStr, addDays(dateStr, 1)); }
  catch (err) {
    process.stderr.write(`[resolve-day] calendar fetch failed: ${err.message}\n`);
    return empty;
  }
  if (!calendarPath) return empty;

  let cal;
  try { cal = JSON.parse(fs.readFileSync(calendarPath, "utf8")); }
  catch { return empty; }
  const events = Array.isArray(cal) ? cal : (cal.events || []);

  const URL_PREFIXES = ["http://", "https://", "zoom.", "meet.google"];
  const isPhysical = loc => loc && !URL_PREFIXES.some(p => loc.startsWith(p));
  // Distance as well as shared words (2026-10-08): the event's location,
  // geocoded once and cached, within CAL_MATCH_M of the stop. "Example Blvd
  // 37" and a stop the geocoder called "32–34 Example Boulevard" share a
  // word; a print shop and a stop named for the café next
  // door might not. Timed events only — a day-long block locates nothing.
  let calPlace = null;
  try { calPlace = await import("./calendar-place.mjs"); } catch { /* words only */ }
  const geoMatch = (ev, s) => {
    if (!calPlace || !ev.location || !isPhysical(ev.location) || s.lat == null || s.lon == null) return false;
    if (!calPlace.placeEvents([ev], s.start_ts_ms, s.end_ts_ms).length) return false;
    const g = calPlace.geocodeLocation(ev.location, s.lat, s.lon);
    return !!g && haversineMeters(s.lat, s.lon, g.lat, g.lon) <= calPlace.CAL_MATCH_M;
  };

  const unmatched = [];
  const overlappedTimed = [];
  for (const ev of events) {
    const start = ev.start?.dateTime || ev.start?.date;
    const end = ev.end?.dateTime || ev.end?.date;
    if (!start || !end) continue;
    const sMs = Date.parse(start);
    const eMs = Date.parse(end);
    if (!sMs || !eMs) continue;
    const durationMin = (eMs - sMs) / 60_000;
    if (durationMin < 5) continue;
    // Find GPS stops that overlap this event by time (all-day AND timed
    // events both attach — see the comment above this function for why
    // overlap alone no longer means "assert this verbatim").
    const overlapping = adaptedStops.filter(s => s.start_ts_ms < eMs && s.end_ts_ms > sMs);
    if (overlapping.length > 0) {
      if (ev.start?.dateTime) {
        overlappedTimed.push({ summary: ev.summary || "", location: ev.location || null, start, end,
                               duration_min: Math.round(durationMin), physical: isPhysical(ev.location) });
      }
      for (const s of overlapping) {
        const share = Math.max(0, Math.min(eMs, s.end_ts_ms) - Math.max(sMs, s.start_ts_ms)) / (eMs - sMs);
        const cur = s.calendar_event;
        // Keep the MOST SPECIFIC event, not the first one seen. First-wins let
        // the multi-day "Stay at Example Town / a nearby city" accommodation block
        // claim every stop of every day, so a real event that overlapped an
        // already-claimed stop attached nowhere AND wasn't recorded as
        // unmatched — it vanished from the summary entirely. That is how the
        // 2026-07-26 concert had no calendar trace even once its
        // stop existed (2026-07-27). Two events of the same length: the one that
        // covers more of this stop (first-wins on a tie gave the stop to whichever
        // event the calendar listed first).
        if (!cur || durationMin < cur.duration_min
            || (durationMin === cur.duration_min && share > (cur.event_share || 0))) {
          s.calendar_event = {
            summary: ev.summary || "",
            location: ev.location,
            location_match: calendarLocationMatchesStop(ev.location, s) || geoMatch(ev, s),
            start, end,
            duration_min: durationMin,
            physical: isPhysical(ev.location),
            // What share of the EVENT this stop accounts for. A timed event that
            // a stop covers 7% of is one the stop passed through, not attended
            // — that's how an 11-minute pause on the drive home ended up
            // captioned "cal: <artist> — <festival>".
            event_share: share,
          };
        }
      }
      continue;
    }
    // No GPS overlap — record as unmatched. Includes Zoom/Meet/URL-only events
    // (the user may have taken them from any GPS stop) and physical events with
    // no GPS evidence.
    unmatched.push({
      summary: ev.summary || "",
      location: ev.location || null,
      start,
      end,
      duration_min: Math.round(durationMin),
      physical: isPhysical(ev.location),
    });
  }
  // A timed event that overlapped stops but lost every one of them to a more
  // specific event is still on the calendar that day: unmatched, never dropped.
  const onStops = new Set(adaptedStops.map(s => s.calendar_event).filter(Boolean).map(c => `${c.summary}|${c.start}`));
  for (const o of overlappedTimed) if (!onStops.has(`${o.summary}|${o.start}`)) unmatched.push(o);
  return { stops: adaptedStops, unmatched_calendar_events: unmatched };
}

// The calendar pass above runs on the raw stops, before addSpineDwells and the
// other late passes build stops from the trace. A stop built there never met the
// day's events: an evening at a ticketed show that only the spine found kept no
// event, and the show was listed as "not matched to a location" right under the
// stop that held it (2026-10-29). Once every edge has moved, each timed event
// still unmatched goes on the final stops it overlaps, by the rule above (the
// most specific event wins); an event it displaces is unmatched again, never
// dropped. Attaching settles nothing by itself: the renderer still decides
// whether the event corroborates the stop. JORI_LATE_CALENDAR=0 turns it off.
function attachCalendarToFinalStops(stops, unmatched) {
  if (process.env.JORI_LATE_CALENDAR === "0" || !Array.isArray(unmatched) || !unmatched.length) {
    return { unmatched: unmatched || [], attached: [] };
  }
  const left = [], attached = [], displaced = [];
  for (const ev of unmatched) {
    const timed = ev && typeof ev.start === "string" && ev.start.includes("T");
    const sMs = timed ? Date.parse(ev.start) : NaN;
    const eMs = timed ? Date.parse(ev.end) : NaN;
    if (!Number.isFinite(sMs) || !Number.isFinite(eMs) || eMs <= sMs) { left.push(ev); continue; }
    const durationMin = (eMs - sMs) / 60_000;
    let on = 0;
    for (const s of stops) {
      if (!(s.start_ts_ms < eMs && s.end_ts_ms > sMs)) continue;
      const share = (Math.min(eMs, s.end_ts_ms) - Math.max(sMs, s.start_ts_ms)) / (eMs - sMs);
      const cur = s.calendar_event;
      if (cur && !(durationMin < cur.duration_min
          || (durationMin === cur.duration_min && share > (cur.event_share || 0)))) continue;
      if (cur) displaced.push(cur);
      s.calendar_event = {
        summary: ev.summary || "",
        location: ev.location,
        location_match: calendarLocationMatchesStop(ev.location, { primary: s.primary || s.place }),
        start: ev.start, end: ev.end,
        duration_min: durationMin,
        physical: ev.physical,
        event_share: share,
        attached_late: true,
      };
      on += 1;
      attached.push({ id: s.id || null, start: s.start, end: s.end, event: ev.summary || "",
                      event_share: Math.round(share * 100) / 100 });
    }
    if (!on) left.push(ev);
  }
  const onStops = new Set(stops.map(s => s.calendar_event).filter(Boolean).map(c => `${c.summary}|${c.start}`));
  const listed = new Set(left.map(e => `${e.summary}|${e.start}`));
  for (const c of displaced) {
    const k = `${c.summary}|${c.start}`;
    if (!String(c.start || "").includes("T") || onStops.has(k) || listed.has(k)) continue;
    listed.add(k);
    left.push({ summary: c.summary, location: c.location || null, start: c.start, end: c.end,
                duration_min: Math.round(c.duration_min), physical: c.physical });
  }
  return { unmatched: left, attached };
}

// ---------------------------------------------------------------------------
// Supabase REST helpers (service role key from .env)
// ---------------------------------------------------------------------------

// A Supabase edge connection has been observed establishing TCP and then never
// answering — 0% CPU, no stderr, no response (daily-summary-run 2026-09-28,
// a resolve-day fetch with no timeout). A bare fetch() has no
// timeout, so the whole nightly summary hung on three consecutive attempts
// (~16min, ~1min, ~1min) and shipped the data-incomplete fallback anyway. Fail
// fast instead: that fallback is the documented outcome for missing location
// data, and reaching it in seconds rather than a quarter of an hour is the
// entire fix. 20s is far above any normal per-day select here and is
// overridable for a slow link.
// Guarded rather than `Number(x) || 20000`: a negative override would make
// AbortSignal.timeout throw RangeError *inside* the try, turning every read
// into null and degrading the whole day silently.
const SUPABASE_FETCH_TIMEOUT_MS = (() => {
  const n = Number(process.env.RESOLVE_DAY_FETCH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20000;
})();

async function supabaseSelect(table, query) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  try {
    const r = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(SUPABASE_FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (err) {
    // Named on the way out. The bare `catch { return null }` made a hang, a
    // network error and a genuinely empty result indistinguishable, which is
    // why three nights of this looked like missing data rather than a stall.
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      process.stderr.write(`[resolve-day] supabaseSelect(${table}) timed out after ${SUPABASE_FETCH_TIMEOUT_MS}ms\n`);
    }
    return null;
  }
}

async function fetchWakeSignal(dateStr, tz = DAY_BOUNDARY_TZ) {
  // Tiered, but selected by pickWake (above), NOT first-non-null-tier:
  //   1. phone_unlocks.first_unlock_at — authoritative (set on first foreground)
  //   2. else the EARLIEST phone_context OR user message inside the plausible
  //      wake window [04:00, 13:00) home-zone — fetch a small batch of the earliest of
  //      each (not just limit 1) so a pre-dawn insomnia ping doesn't hide the
  //      real morning signal, and so a single stray late reading can be skipped.
  //   3. else null (don't fabricate — a day with no unlock and no morning
  //      activity genuinely has no clean wake signal; render omits the line).
  // The fallback (tiers 2-3) was added to stop wake going null
  // when phone_unlocks didn't fire; the window guard here keeps that benefit
  // while killing the 2026-06-27 "Woke 23:26" failure (see pickWake).

  const wFrom = localHourIso(dateStr, WAKE_WINDOW.minHour, tz), wTo = localHourIso(dateStr, WAKE_WINDOW.maxHour, tz);
  const q = encodeURIComponent;
  // More witnesses than the chat (2026-10-08): the first photo he took, the
  // moment he left where he slept, and — once the app ships them — the phone's
  // own unlocks and Screen Time usage windows. Missing tables read as [].
  const [photos, leftBed, unlocked, used] = await Promise.all([
    supabaseSelect("photos", `select=taken_at&self_captured=is.true&taken_at=gte.${q(wFrom)}&taken_at=lt.${q(wTo)}&order=taken_at.asc&limit=1`),
    supabaseSelect("location_history", `select=departed_at,place_name&segment_type=eq.visit&arrived_at=lt.${q(wFrom)}`
      + `&departed_at=gte.${q(wFrom)}&departed_at=lt.${q(wTo)}&order=departed_at.asc&limit=1`),
    supabaseSelect("phone_lock_events", `select=ts&state=in.(unlocked,sample_unlocked)&ts=gte.${q(wFrom)}&ts=lt.${q(wTo)}&order=ts.asc&limit=1`),
    supabaseSelect("phone_usage_windows", `select=reached_at,window_start&used=is.true&window_start=gte.${q(wFrom)}&window_start=lt.${q(wTo)}&order=window_start.asc&limit=1`),
  ]);
  const extra = [
    ...rowsOr(photos).map(r => ({ ms: Date.parse(r.taken_at), source: "first_photo" })),
    ...rowsOr(leftBed).map(r => ({ ms: Date.parse(r.departed_at), source: "left_overnight_place", detail: r.place_name || null })),
    ...rowsOr(unlocked).map(r => ({ ms: Date.parse(r.ts), source: "phone_lock_event" })),
    ...rowsOr(used).map(r => ({ ms: Date.parse(r.reached_at || r.window_start), source: "phone_usage" })),
  ];

  const [unlock, ctx, msg] = await Promise.all([
    supabaseSelect(
      "phone_unlocks",
      `select=first_unlock_at&date=eq.${dateStr}&order=first_unlock_at.asc&limit=1`,
    ),
    supabaseSelect(
      "phone_context",
      `select=ts&ts=gte.${encodeURIComponent(wFrom)}&ts=lt.${encodeURIComponent(wTo)}&order=ts.asc&limit=20`,
    ),
    supabaseSelect(
      "jori_messages",
      `select=created_at&role=eq.user&created_at=gte.${encodeURIComponent(wFrom)}&created_at=lt.${encodeURIComponent(wTo)}&order=created_at.asc&limit=20`,
    ),
  ]);

  // The night record (lib/sleep-night.js) outranks every proxy: the
  // Watch's wake, else the first unlock after the night's long locked stretch.
  const night = await fetchNightRow(addDays(dateStr, -1));
  if (night && night.wake_at) {
    const ms = Date.parse(night.wake_at);
    return { at: hmFromMs(ms), source: `night_${night.wake_source}`, ts_ms: ms, phone_use: true,
             ...(night.watch_asleep_min ? { asleep_min: night.watch_asleep_min } : {}) };
  }

  return pickWake({
    unlockMs: (unlock && unlock.length) ? Date.parse(unlock[0].first_unlock_at) : null,
    ctxMs: (ctx || []).map(r => Date.parse(r.ts)),
    msgMs: (msg || []).map(r => Date.parse(r.created_at)),
    extra,
    tz,
  });
}

// One saved night from `sleep_nights` (night_of = the evening's date).
async function fetchNightRow(nightOf) {
  const rows = await supabaseSelect("sleep_nights",
    `select=sleep_at,sleep_source,wake_at,wake_source,phone_down_at,watch_asleep_min&night_of=eq.${nightOf}&limit=1`);
  return rowsOr(rows)[0] || null;
}

// The Watch's own account of a night (2026-10-10): fell asleep, woke (or a
// range when its last stretch has no end), hours asleep, every wake-up — read
// from the same rows the saved night was built from, and stated in `tz`.
// No Watch night → null, and the summary keeps its one-line night.
async function fetchNightDetail(nightOf, tz) {
  const rows = await supabaseSelect("health_samples", sleepNight.watchSamplesQuery(nightOf, tz));
  return sleepNight.describeNight(sleepNight.watchNight(rowsOr(rows)), tz);
}

// When the Watch had him asleep, as epoch ms, or null when it recorded no night
// (or the read failed -- the guard that uses this simply stays off). The wake is
// the earliest the Watch allows when its last stretch has no end.
async function fetchAsleepWindow(nightOf, tz) {
  if (process.env.JORI_SLEEP_GUARD === "0") return null;   // kill switch, like JORI_NAME_WRITEBACK
  try {
    const rows = await supabaseSelect("health_samples", sleepNight.watchSamplesQuery(nightOf, tz));
    const w = sleepNight.watchNight(rowsOr(rows));
    if (!w) return null;
    const to = w.wake_ms != null ? w.wake_ms : w.wake_from_ms;
    return Number.isFinite(to) && Number.isFinite(w.onset_ms) ? { from_ms: w.onset_ms, to_ms: to } : null;
  } catch {
    return null;
  }
}

// `dateStr` is the EVENING whose bedtime is wanted — resolveDay passes the
// day before, so a day's summary opens with the night that led into it.
async function fetchSleepSignal(dateStr, tz = DAY_BOUNDARY_TZ) {
  // The night record first: the Watch's onset, else the phone's last lock
  // before the night (shifted by his usual reading time once that is known).
  const night = await fetchNightRow(dateStr);
  if (night && night.sleep_at) {
    const ms = Date.parse(night.sleep_at);
    return { at: hmFromMs(ms), source: `night_${night.sleep_source}`, ts_ms: ms, phone_use: true };
  }

  // The LAST sign he was up, in [17:00, next day 05:00) of the day's own zone.
  // Until 2026-10-08 this read the calendar day only (so anything after
  // midnight was invisible) and only chat + phone_context. Now also photos and
  // — once the app ships them — phone unlocks and Screen Time usage windows.
  const q = encodeURIComponent;
  const from = localHourIso(dateStr, SLEEP_WINDOW.fromHour, tz);
  const to = localHourIso(addDays(dateStr, 1), SLEEP_WINDOW.toNextDayHour, tz);
  const [msgRows, ctxRows, photos, unlocked, used] = await Promise.all([
    supabaseSelect("jori_messages", `select=created_at&role=eq.user&created_at=gte.${q(from)}&created_at=lt.${q(to)}&order=created_at.desc&limit=1`),
    supabaseSelect("phone_context", `select=ts&ts=gte.${q(from)}&ts=lt.${q(to)}&order=ts.desc&limit=1`),
    supabaseSelect("photos", `select=taken_at&self_captured=is.true&taken_at=gte.${q(from)}&taken_at=lt.${q(to)}&order=taken_at.desc&limit=1`),
    supabaseSelect("phone_lock_events", `select=ts&state=in.(unlocked,sample_unlocked)&ts=gte.${q(from)}&ts=lt.${q(to)}&order=ts.desc&limit=1`),
    supabaseSelect("phone_usage_windows", `select=reached_at,window_end&used=is.true&window_start=gte.${q(from)}&window_start=lt.${q(to)}&order=window_start.desc&limit=1`),
  ]);
  const candidates = [
    ...rowsOr(msgRows).map(r => ({ ms: Date.parse(r.created_at), source: "last_user_message" })),
    ...rowsOr(ctxRows).map(r => ({ ms: Date.parse(r.ts), source: "phone_context" })),
    ...rowsOr(photos).map(r => ({ ms: Date.parse(r.taken_at), source: "last_photo" })),
    ...rowsOr(unlocked).map(r => ({ ms: Date.parse(r.ts), source: "phone_lock_event" })),
    // A usage window says the phone was used SOMEWHERE inside it — its end is
    // the honest "last seen" bound.
    ...rowsOr(used).map(r => ({ ms: Date.parse(r.window_end || r.reached_at), source: "phone_usage" })),
  ].filter(c => Number.isFinite(c.ms));
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.ms - a.ms);
  const c = candidates[0];
  return { at: hmFromMs(c.ms), source: c.source, ts_ms: c.ms, phone_use: PHONE_USE_SOURCES.has(c.source) };
}

// Every window the user has personally settled — the ones he NAMED
// (`user-confirmed` / `named`) and the ones he told us weren't stops at all
// (`non-stop`, written by `findme resolve`). Both are answers; only the first
// kind used to be fetched, so a window he had explicitly answered came back
// through the OSM guesser and shipped in the daily summary as a hedged venue
// guess (2026-07-26: "~Cafe Example? · unconfirmed (also: two other venues)"
// for a stretch he'd already told us was a coastline walk).
async function fetchUserConfirmedStops(dateStr) {
  const startIso = etBoundaryUtcIso(dateStr);
  const endIso = etBoundaryUtcIso(addDays(dateStr, 1));
  // PostgREST filter notes:
  //   place_type=in.(user-confirmed,named,non-stop)  — unquoted tokens in in.(…)
  // The place_name=not.is.null filter moved into JS: a `non-stop` row is
  // meaningful with OR without a name (the name, when present, is the user's own
  // description of the window — "Walking along the coastline in the
  // park" — which `findme` now preserves instead of nulling).
  const rows = await supabaseSelect(
    "location_history",
    `select=id,arrived_at,departed_at,latitude,longitude,place_name,place_type,companions,notes` +
      `&segment_type=eq.visit` +
      `&arrived_at=gte.${encodeURIComponent(startIso)}` +
      `&arrived_at=lt.${encodeURIComponent(endIso)}` +
      `&place_type=in.(user-confirmed,named,non-stop)` +
      `&order=arrived_at.asc`,
  );
  const judged = loadPassageWindows();
  return (rows || [])
    .map(r => (r.place_type === "non-stop" && machineNonStop(r))
      ? { ...r, place_name: null, judged_window: judged.get(r.id) || null } : r)
    .filter(r => r.place_type === "non-stop" || r.place_name);
}

// An unanswered "where was this?" card's default, applied as a GUESS
// (2026-10-22). the user: apply it "as a low-confidence guess that never names
// nearby future stops and that any later tap or correction overrides".
// `choice sweep --apply` → `findme guess` writes the card's own visit row as
// place_type='default-applied'. These rows are deliberately NOT in
// fetchUserConfirmedStops: that list is his answers, and every consumer of it
// treats a row as something he said.
async function fetchDefaultGuesses(dateStr) {
  const startIso = etBoundaryUtcIso(dateStr);
  const endIso = etBoundaryUtcIso(addDays(dateStr, 1));
  try {
    const rows = await supabaseSelect(
      "location_history",
      `select=id,arrived_at,departed_at,latitude,longitude,place_name,place_type` +
        `&segment_type=eq.visit` +
        `&arrived_at=gte.${encodeURIComponent(startIso)}` +
        `&arrived_at=lt.${encodeURIComponent(endIso)}` +
        `&place_type=eq.default-applied` +
        `&order=arrived_at.asc`,
    );
    return (rows || []).filter(r => r.place_name);
  } catch (e) {
    process.stderr.write(`[resolve-day] default guesses unavailable: ${e.message}\n`);
    return [];
  }
}

// How far a guess reaches: ONE stop, the one its own row describes. Each row
// names at most the single stop it overlaps most, only when the two share most
// of the shorter window and sit close together, and only a stop nothing better
// has named — his answers, a saved place, a sign in his photo, a known place,
// the lodging, a calendar event all outrank it, and a stretch that is movement
// or a non-stop is never renamed. It is never written anywhere (no
// confirmed-stops.json, no row PATCH), so it cannot reach a later stop.
const DEFAULT_GUESS_SHARE = 0.5;
const DEFAULT_GUESS_MAX_M = 150;
const DEFAULT_GUESS_CONF = 0.4;
const DEFAULT_GUESS_FILLS = new Set(["osm_overpass", "google_places", "reverse_geocode",
  "coordinate", "unknown", "neighborhood", "address", "photo_gps", "spine_dwell", "movement"]);
function applyDefaultGuesses(stops, rows) {
  const applied = [];
  const taken = new Set();
  for (const r of rows || []) {
    const ra = Date.parse(r.arrived_at);
    const rd = r.departed_at ? Date.parse(r.departed_at) : NaN;
    if (!Number.isFinite(ra) || !Number.isFinite(rd) || rd <= ra || r.latitude == null) continue;
    let best = null, bestOv = 0;
    for (const s of stops) {
      if (taken.has(s) || !Number.isFinite(s.start_ts_ms) || !Number.isFinite(s.end_ts_ms)) continue;
      const ov = Math.min(rd, s.end_ts_ms) - Math.max(ra, s.start_ts_ms);
      if (ov <= 0) continue;
      if (ov < DEFAULT_GUESS_SHARE * Math.min(rd - ra, s.end_ts_ms - s.start_ts_ms)) continue;
      if (s.lat == null || s.lon == null || haversineMeters(s.lat, s.lon, r.latitude, r.longitude) > DEFAULT_GUESS_MAX_M) continue;
      if (ov > bestOv) { best = s; bestOv = ov; }
    }
    if (!best) continue;
    const src = (best.place && best.place.source) || "unknown";
    if (best.is_movement || best.user_non_stop || best.excursion || best.merged_walk
        || best.is_home || best.known_recurring || !DEFAULT_GUESS_FILLS.has(src)
        || (src === "spine_dwell" && best.spine_tier === "user-confirmed")) continue;
    taken.add(best);
    best.default_guess = { row_id: r.id, name: r.place_name, displaced: (best.place && best.place.name) || null };
    best.place = { ...(best.place || {}), name: r.place_name, source: "default_applied",
                   confidence: DEFAULT_GUESS_CONF };
    applied.push({ stop: best.id, row: r.id, name: r.place_name, displaced: best.default_guess.displaced });
  }
  return applied;
}

// The window stop-passage actually judged (2026-10-19). Its verdict is about
// the minutes it read, and a visit row keeps growing after it: the stadium
// Stadium row was judged 19:04-19:24 on two fixes, while the sweeper's early
// departure stood; iOS then delivered the real departure, 22:20, and "not a
// stop" covered a three-hour football game, which became "Walk around <a neighbourhood>".
// The log is the only record of that window (the row's notes carry the verdict,
// not its span). The latest applied verdict per row wins; no log, old behaviour.
const PASSAGE_LOG = path.join(__dirname, "..", "data", "stop-passage-log.jsonl");
function loadPassageWindows(file = PASSAGE_LOG) {
  const out = new Map();
  if (process.env.JORI_PASSAGE_WINDOW === "0") return out;
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || r.verdict !== "passage" || !r.applied || !r.visit_id || !r.window) continue;
    const a = Date.parse(r.window.start), d = Date.parse(r.window.end);
    if (!Number.isFinite(a) || !Number.isFinite(d) || d <= a) continue;
    out.set(r.visit_id, { start_ms: a, end_ms: d });
  }
  return out;
}

// The minutes a non-stop row speaks for: its own window, or, for a pipeline
// verdict whose judged window is known, only the part of the row it judged.
function nonStopSpan(r) {
  const a = Date.parse(r.arrived_at);
  const d = r.departed_at ? Date.parse(r.departed_at) : a + 30 * 60_000;
  const j = r.judged_window;
  if (!j) return { a, d };
  return { a: Math.max(a, j.start_ms), d: Math.min(d, j.end_ms) };
}

// A `non-stop` the PIPELINE wrote (stop-passage, ask-gate) is a verdict, not
// his words. Until 2026-10-08 those rows kept the geocoder's street name, and
// this file read any non-stop name as his description: the withdrawn 09:28
// print-shop window came back as "32–34 Example Boulevard", source
// user_confirmed, confidence 1. Tags are our own strings (set membership).
const MACHINE_NON_STOP_TAGS = ["[passage-auto", "[ask-gate same-stay]"];
function machineNonStop(row) {
  const notes = row.notes || "";
  return MACHINE_NON_STOP_TAGS.some(t => notes.includes(t));
}

// ---------------------------------------------------------------------------
// Classification ladder — upgrade each stop's primary label
// ---------------------------------------------------------------------------

function classifyStops(stops, ctx) {
  // `stops` is the raw stops[] from location-stops output.
  // ctx: { date, knownStopsEntries, userConfirmed }
  const out = [];
  let idx = 0;
  for (const s of stops) {
    idx += 1;
    const start = s.start_ts_ms;
    const end = s.end_ts_ms;
    const lat = s.centroid?.lat ?? 0;
    const lon = s.centroid?.lon ?? 0;
    const hmStart = hmFromMs(start);
    const hmEnd = hmFromMs(end);

    // location-stops already applied (1) named and, when available,
    // calendar + photo_gps enrichment. We re-apply the ladder on top
    // so known_recurring and user-confirmed can override lower-priority
    // labels (e.g., a reverse_geocode primary that should really be
    // "a neighbourhood grocery" via proximity to a known stop).
    let place = {
      name: s.primary?.name ?? null,
      address: s.primary?.address ?? null,
      source: s.primary?.source ?? "unknown",
      confidence: s.primary?.confidence ?? 0,
      distance_m: s.primary?.distance_km != null ? Math.round(s.primary.distance_km * 1000) : null,
    };

    // Source ordering weight — higher wins. user_confirmed is ABSOLUTE: when
    // The user tells us where he was, that overrides every algorithmic resolution
    // including named_location. (Pre-2026-04-30 user_confirmed sat at 95 below
    // named_location 100, which silently lost the joust on stops the segment
    // resolved confidently — drift documented in the 2026-04-29 self-improvement
    // review and a 4/28 café episode.)
    const WEIGHT = {
      user_confirmed: 110,
      named_location: 100,
      // Where he's staying on this trip (travel_segments lodging). Above a
      // recurring stop, below a place he named himself.
      accommodation: 95,
      // A physical calendar event that covers an iOS visit we had no other
      // evidence for — the schedule and the phone agreeing.
      calendar_corroborated: 98,
      known_recurring: 90,
      calendar: 85,
      photo_gps: 70,
      neighborhood: 50,   // gap-fill stop named to its neighborhood
      reverse_geocode: 40,
      coordinate: 30,
      unknown: 0,
    };
    function maybeUpgrade(next) {
      const currentW = WEIGHT[place.source] ?? 0;
      const nextW = WEIGHT[next.source] ?? 0;
      if (nextW > currentW) place = next;
    }

    // (2) user-confirmed DB match — pick the candidate row with the LARGEST
    // time-overlap against this stop's window, not the first one in
    // arrived_at order. Every row that clears the overlap+distance gate is
    // hardcoded to the SAME weight (user_confirmed, 110) below, so
    // maybeUpgrade's strict "> currentW" only lets the first match in ever
    // win — a sweeper-synthesized departed_at can manufacture a sliver of
    // overlap (well under a minute) at the leading edge of a stop it isn't
    // really describing, and that sliver then blocks a same-tier match
    // moments later with the real, much larger overlap. Concretely (2026-08-30):
    // a dim sum restaurant's row whose departed_at was synthesized 224m from the
    // actual table matched the first 84s of the following 9h40m "Home" stop and won by iteration order, silently erasing the whole
    // evening from the resolved day.
    let userNonStop = false;
    let bestUc = null, bestOverlapMs = 0, bestDistM = Infinity;
    for (const uc of ctx.userConfirmed) {
      const ucStart = Date.parse(uc.arrived_at);
      const ucEnd = uc.departed_at ? Date.parse(uc.departed_at) : ucStart + 30 * 60_000;
      const overlapMs = Math.min(end, ucEnd) - Math.max(start, ucStart);
      if (overlapMs <= 0) continue;
      if (uc.latitude == null || uc.longitude == null) continue;
      const distM = haversineMeters(lat, lon, uc.latitude, uc.longitude);
      if (distM > 300) continue;
      // "Not a stop" is an ANSWER, not an absence of one: the user settled this
      // window. Flag it so nothing downstream re-asserts a venue for it, and
      // take his description as the label when the row carries one.
      if (uc.place_type === "non-stop") {
        // Two kinds of non-stop row do NOT say "he didn't stop here" about
        // THIS window (2026-10-12, a library: 136 min, erased):
        //  - `[ask-gate same-stay]` says the row CONTINUES an earlier stay —
        //    he was still there. It marks a redundant row, not a passage.
        //  - a non-stop row covering a sliver of a long stop speaks for its
        //    own window, not the stop's. The library's 22-min same-stay row
        //    flagged all 136 minutes.
        if ((uc.notes || "").includes("[ask-gate same-stay]")) continue;   // our own tag
        const ns = nonStopSpan(uc);
        const nsOverlapMs = Math.min(end, ns.d) - Math.max(start, ns.a);
        if (nsOverlapMs < NON_STOP_COVER_SHARE * Math.max(1, end - start)) continue;
        userNonStop = true;
        if (!uc.place_name) continue;
      }
      // A covering calendar event already named this orphan visit and recorded
      // what it displaced; re-applying the same row would undo it.
      if (s._calendar_named) continue;
      if (overlapMs > bestOverlapMs || (overlapMs === bestOverlapMs && distM < bestDistM)) {
        bestUc = uc; bestOverlapMs = overlapMs; bestDistM = distM;
      }
    }
    let confirmedRow = null;
    if (bestUc) {
      maybeUpgrade({
        name: bestUc.place_name,
        address: null,
        source: "user_confirmed",
        confidence: 1.0,
        distance_m: Math.round(bestDistM),
      });
      // The row's own window travels with the name: his confirmation covers
      // THIS span, not the whole cluster it happened to overlap (see
      // splitConfirmedStopOnEvent).
      confirmedRow = {
        id: bestUc.id, name: bestUc.place_name,
        start_ms: Date.parse(bestUc.arrived_at),
        end_ms: bestUc.departed_at ? Date.parse(bestUc.departed_at) : null,
        // `named` = the app recognised a saved place on arrival; `user-confirmed`
        // = he answered. splitWideStopsOnRests only honours the second as final.
        place_type: bestUc.place_type || null,
      };
    }

    // (3) known-recurring-stops
    const match = matchStop(ctx.knownStopsEntries, {
      date: ctx.date,
      stopStartHM: hmStart,
      stopEndHM: hmEnd,
      lat, lon,
    });
    if (match) {
      maybeUpgrade({
        name: match.entry.name,
        address: match.entry.address || null,
        source: "known_recurring",
        confidence: match.coords_matched ? 0.95 : 0.8,
        distance_m: match.distance_m != null ? Math.round(match.distance_m) : null,
      });
    }

    // (4) calendar — already applied by location-stops when source === "calendar"
    // (5) photo_gps — already applied by location-stops when source === "photo_gps"
    // (6) reverse_geocode — already applied when source === "reverse_geocode"

    const companions = (s.companions && Array.isArray(s.companions)) ? s.companions : [];
    out.push({
      id: `s-${ctx.date.replace(/-/g, "")}-${idx}`,
      start: hmStart,
      end: hmEnd,
      start_ts_ms: start,
      end_ts_ms: end,
      duration_min: Math.round(s.duration_minutes ?? ((end - start) / 60_000)),
      place,
      companions,
      // where the companions above came from (pruneShrunkCompanions; never in the output)
      companion_merge_window: s.companion_merge_window || undefined,
      activity: null, // segment doesn't expose per-stop activity yet
      lat, lon,
      cluster_radius_km: s.cluster_radius_km ?? null,
      sample_count: s.sample_count ?? null,
      pattern: s.pattern || "dwell",  // NEW: "dwell" | "browse"
      // The user answered "not a stop" for this window (location-enrich reply →
      // place_type='non-stop'). Downstream: no venue guess, no alternatives,
      // no "which stop was this?" follow-up.
      user_non_stop: userNonStop,
      // Present when this stop exists only because iOS recorded a visit that
      // breadcrumb clustering missed; `displaced_label` is a conflicting label
      // the calendar event outranked, kept visible rather than dropped.
      orphan_visit: s.orphan_visit || null,
      displaced_label: s.displaced_label || null,
      photos: s.photos || [],
      calendar_event: s.calendar_event || null,
      alternatives: s.alternatives || [],
      confirmed_row: confirmedRow,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// A confirmed name covers the row it was written on, not the whole cluster
// ---------------------------------------------------------------------------
//
// 2026-09-08: a movie gets its own location even when it is next door to the
// market before it. The market hall and the cinema share one building, so the
// trace is one 167-minute cluster and nothing geometric can cut it. The user's
// answer "Market Example" sat on a 42-minute row (18:09-18:51, note: "Before the
// movie"); the calendar held "<film> (Cinema Example)" 18:45-21:15 with a
// location that matched the stop.
// classifyStops applied the confirmed name to the whole cluster, and the
// movie became a clause inside the market's paragraph.
//
// The split is decided by TIME, from two facts about the same window: the
// confirmed row ends well before the stop does, and a physical calendar event
// whose location independently matches this place covers most of what is
// left. The boundary is the row's departure -- a recorded fact -- not the
// event's start, which is a schedule. The tail takes the venue named in the
// event's location field (its first comma-segment; the summary is the title
// of the outing, the film's title, and belongs to calendar_event for the prose).
const CONFIRMED_TAIL_MIN_MIN = 20;      // the uncovered remainder must be a stop's worth
const CONFIRMED_TAIL_EVENT_SHARE = 0.6; // and mostly inside the event
const CONFIRMED_TAIL_EVENT_LEAD_MS = 45 * 60_000; // event may start this far before the row ends

function decodeEntities(str) {
  return String(str || "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

function venueFromEventLocation(location) {
  const first = decodeEntities(location).split(",")[0].trim();
  return first || null;
}

function splitConfirmedStopOnEvent(stops) {
  const out = [];
  const splits = [];
  for (const s of stops) {
    const row = s.confirmed_row;
    const ev = s.calendar_event;
    const src = s.place && s.place.source;
    if (src !== "user_confirmed" || !row || !row.end_ms || !ev || !ev.physical || !ev.location_match) {
      out.push(s); continue;
    }
    const evStart = Date.parse(ev.start), evEnd = Date.parse(ev.end);
    if (!Number.isFinite(evStart) || !Number.isFinite(evEnd)) { out.push(s); continue; }
    const cut = row.end_ms;
    const tailMs = s.end_ts_ms - cut;
    if (tailMs < CONFIRMED_TAIL_MIN_MIN * 60_000) { out.push(s); continue; }
    if (evStart > cut + CONFIRMED_TAIL_EVENT_LEAD_MS) { out.push(s); continue; }   // event is not about this tail
    if (evStart < s.start_ts_ms + 60_000 && evEnd >= s.end_ts_ms) { out.push(s); continue; } // covers the whole stop: nothing to split
    const covered = Math.min(evEnd, s.end_ts_ms) - Math.max(evStart, cut);
    if (covered / tailMs < CONFIRMED_TAIL_EVENT_SHARE) { out.push(s); continue; }
    const venue = venueFromEventLocation(ev.location) || ev.summary;
    if (!venue || venue === s.place.name) { out.push(s); continue; }

    const head = { ...s, end_ts_ms: cut, end: hmFromMs(cut),
                   duration_min: Math.round((cut - s.start_ts_ms) / 60_000),
                   photos: (s.photos || []).filter(ph => Date.parse(ph.taken_at || ph.ts) < cut) };
    const tail = { ...s, id: `${s.id}b`, start_ts_ms: cut, start: hmFromMs(cut),
                   duration_min: Math.round(tailMs / 60_000),
                   place: { name: venue, address: decodeEntities(ev.location), source: "calendar_corroborated",
                            confidence: 0.9, distance_m: null },
                   confirmed_row: null, split_from_confirmed: s.place.name,
                   alternatives: [],
                   photos: (s.photos || []).filter(ph => Date.parse(ph.taken_at || ph.ts) >= cut) };
    out.push(head, tail);
    splits.push({ was: `${s.start}-${s.end} ${s.place.name}`,
                  head: `${head.start}-${head.end} ${head.place.name}`,
                  tail: `${tail.start}-${tail.end} ${venue}`,
                  event: ev.summary, cut_at: "confirmed row departure" });
  }
  out.forEach((x, i) => { x.id = x.id.replace(/-\d+b?$/, `-${i + 1}`); });
  return { stops: out, splits };
}

// ---------------------------------------------------------------------------
// Accommodation — where he's staying is a place, not a street address
// ---------------------------------------------------------------------------
//
// 2026-07-27: a stop less than 100 m from the rental the user was staying at
// came back as a street address instead of the rental. Because nothing here had
// ever read the travel timeline. `travel_segments` knew exactly what that stop was —
// `[lodging] "Example Town, France — holiday house (host
// name)"`, 2026-07-19 → 07-28 — but only presence/timezone tools consult it;
// the location resolver had no concept of "where he's staying right now". So
// the label came from a reverse-geocode Jori itself proposed in chat ("At 8
// Example Lane?"), got saved as a `confirmed_stop`, and every visit since
// resolved to a neighbouring street address.
//
// `travel_segments` carries no coordinates, so the match is BEHAVIOURAL: the
// day's base is where he both starts and ends the day. That centroid, plus the
// lodging segment covering the date, names the stop.

const ACCOMMODATION_MATCH_M = 150;

async function fetchLodgingSegment(dateStr) {
  const startIso = etBoundaryUtcIso(dateStr);
  const endIso = etBoundaryUtcIso(addDays(dateStr, 1));
  try {
    const rows = await supabaseSelect(
      "travel_segments",
      `select=metro,place_label,arrive_at,depart_at,source,ref` +
        `&source=eq.lodging` +
        `&arrive_at=lt.${encodeURIComponent(endIso)}` +
        `&depart_at=gt.${encodeURIComponent(startIso)}` +
        `&order=arrive_at.asc&limit=5`,
    );
    return (rows && rows[0]) || null;
  } catch (e) {
    process.stderr.write(`[resolve-day] lodging lookup skipped: ${(e && e.message) || e}\n`);
    return null;
  }
}

// `place_label` is usually the raw rental listing headline — the exact shape
// filtered out of POI candidates for being marketing copy, so it must not become
// a title either. A real hotel name is used verbatim; a listing becomes "our
// Airbnb in <city>", carrying the host through when the label names one.
function accommodationName(seg) {
  const label = String(seg.place_label || "").trim();
  if (!label) return null;
  const dash = label.search(/[—–]/);
  const city = (dash >= 0 ? label.slice(0, dash) : String(seg.metro || "")).split(",")[0].trim();
  const listing = (dash >= 0 ? label.slice(dash + 1) : label).trim();
  const host = /\(host ([^)]+)\)/i.exec(listing);
  const listingShaped =
    /\b(sleeps?\s*\d|\d+\s*(pers|guests?|bedrooms?|chambres?|pi[eè]ces?)|\bT[1-6]\b)/i.test(listing) ||
    /\b(appartement|apartment|studio|maison|villa|g[iî]te|cottage|loft|r[ée]sidence)\b/i.test(listing) ||
    listing.length > 40;
  if (!listingShaped) return listing;
  const where = city ? ` in ${city.replace(/\b\w/g, c => c.toUpperCase())}` : "";
  return `our Airbnb${where}${host ? ` (host ${host[1]})` : ""}`;
}

// The day's base: the first and last stops, when they're the same place. A day
// that starts and ends somewhere else (travel days, an overnight out) yields no
// base and nothing is renamed — fail-safe by construction.
function applyAccommodation(stops, seg) {
  if (!seg || stops.length < 2) return stops;
  const name = accommodationName(seg);
  if (!name) return stops;
  const first = stops[0], last = stops[stops.length - 1];
  if (first.lat == null || last.lat == null) return stops;
  if (haversineMeters(first.lat, first.lon, last.lat, last.lon) > ACCOMMODATION_MATCH_M) return stops;
  const baseLat = (first.lat + last.lat) / 2, baseLon = (first.lon + last.lon) / 2;
  for (const s of stops) {
    if (s.lat == null) continue;
    if (haversineMeters(s.lat, s.lon, baseLat, baseLon) > ACCOMMODATION_MATCH_M) continue;
    // Keep whatever the resolver had as the street-level detail; the TITLE
    // becomes the accommodation.
    s.accommodation = { name, was: s.place && s.place.name, ref: seg.ref || null };
    s.place = { ...s.place, name, source: "accommodation", confidence: 0.95 };
  }
  return stops;
}

// ---------------------------------------------------------------------------
// Duplicate stops — the same place recorded twice
// ---------------------------------------------------------------------------
//
// `location_history` is written by two producers, so the same visit lands twice;
// promoting orphan visits and photo-synthesized rows can also place a stop right
// alongside the GPS-clustered one for the same place. The 2026-07-26 day showed
// both: "Bridge Example" twice at 17:22-17:27, and "Beach Bar Example" at 13:27-13:47
// immediately followed by "Beach Bar Example" at 13:47-14:02.
//
// Merge consecutive stops that are the same place: touching or overlapping
// windows, centroids within 150 m, and one name containing the other (so
// "Bridge Example (North)" absorbs "Bridge Example"). The longer
// name wins — it's the more specific one.
// 400 m, not the tighter geometric bound used elsewhere: the NAME carries the
// identity here (one label contains the other), and duplicate records of the
// same place routinely sit a few hundred metres apart because each producer
// centroids a different subset of samples — the 2026-07-26 beach-bar pair was
// 280 m apart, the bridge pair 380 m.
const DUP_MERGE_M = 400;
const DUP_MERGE_GAP_MIN = 5;

// One venue reached the day twice under two spellings -- "Cafe Republic" at
// 11:58 and "Cafe Republique" at 12:21 (2026-07-30). Exact/substring
// matching on lowercased names could not see it: the accent differs, neither
// contains the other, and the 23-minute gap exceeded DUP_MERGE_GAP_MIN. Fold
// accents and compare by edit distance, and allow a longer gap when the names
// are strongly alike -- that gap is usually the phone going quiet indoors, not
// a second outing.
const NAME_SIM_MIN = 0.80;
const DUP_MERGE_GAP_MIN_FUZZY = 45;
// One venue can produce two clusters further apart than DUP_MERGE_M when GPS
// drifts indoors: the Jul 29 lunch split into a 6-minute cluster at the
// restaurant and a 49-minute one 431 m away, both named Cafe Republic(que).
// A strong name match earns a wider radius than an unnamed coincidence would.
const DUP_MERGE_M_FUZZY = 700;

function normName(n) {
  return String(n || "")
    .normalize("NFD").replace(/\p{M}/gu, "")   // strip diacritics (Hebrew niqqud too)
    .toLowerCase()
    // Letters and digits of ANY script (2026-10-13): "[^a-z0-9 ]" emptied
    // every Hebrew name, so "אישטבח" never matched itself and its twin stops
    // were never merged.
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\b(the|le|la|les|el|il|a|an|de|du|des|of)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function nameSimilarity(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.95;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

function sameplace(a, b) {
  if (a.lat == null || b.lat == null) return false;
  const dist = haversineMeters(a.lat, a.lon, b.lat, b.lon);
  if (dist > DUP_MERGE_M_FUZZY) return false;
  const an = a.place && a.place.name, bn = b.place && b.place.name;
  if (!an || !bn) return false;
  const sim = nameSimilarity(an, bn);
  const gapMin = (b.start_ts_ms - a.end_ts_ms) / 60_000;
  if (sim < NAME_SIM_MIN) return false;
  if (dist > DUP_MERGE_M && sim < 0.84) return false;   // far apart needs a firmer match
  return gapMin <= DUP_MERGE_GAP_MIN_FUZZY;
}

// A gap between two same-place fragments can look like ordinary GPS noise and
// still hide a real trip: the day-path spine independently reconstructs
// dwells from raw pings, bypassing iOS's own visit clustering (see
// addSpineDwells below), so it can know about an outing the stop list above
// never saw. Bridging the gap here would make Home APPEAR to cover a window
// the spine proves he wasn't there for -- and since addSpineDwells runs last
// and only fills windows no *existing* stop already claims, a bridge made
// here is invisible to it: the swallowed dwell never comes back.
// (2026-09-18: a 12-minute "Home ... Home" bridge across 10:02-10:14 quietly
// absorbed a 33-minute, GPS-corroborated dwell at a street address/a food hall
// the spine had already found -- the user saw the walk on the map but the
// narrative never mentioned it.)
//
// Overlap, not containment: the neighbouring stop's own boundary can itself
// be imprecise (a `user_confirmed` row here started at 10:14, 25 minutes
// before the spine dwell actually ended at 10:39), so a spine dwell that
// only partly falls inside [prev.end, next.start) still proves the merge
// wrong for however much of it does.
function spineExcursionInGap(prev, next, dayPath) {
  const spine = (dayPath && dayPath.spine) || [];
  if (!spine.length || prev.lat == null) return false;
  for (const n of spine) {
    if (n.type !== "dwell" || !n.major || !n.start_ms || !n.end_ms) continue;
    if (n.start_ms >= next.start_ts_ms || n.end_ms <= prev.end_ts_ms) continue; // no overlap with the gap
    if (!n.place || n.place.lat == null) continue;
    if (haversineMeters(prev.lat, prev.lon, n.place.lat, n.place.lon) > SPINE_SAME_PLACE_M) return true;
  }
  return false;
}

// The joined stop is pinned where he spent longest (2026-10-17). It kept the
// first piece's position, so on 2026-10-16 "August" (17:57-18:10 where he
// parked, then 18:15-19:16 at the bar) sat 291 m from the bar and from his photo
// of its sign. Every piece's own position stays on the stop as `piece_points`,
// so a photo taken at the other piece (18:04, by the car) still finds it.
// JORI_MERGE_PIN_LONGEST=0 keeps the first piece's pin and records no points.
function mergeDuplicateStops(stops, dayPath) {
  const out = [];
  const pinnedMs = new Map();   // merged stop -> length of the piece its pin came from
  const pinLongest = process.env.JORI_MERGE_PIN_LONGEST !== "0";
  for (const s of stops) {
    const prev = out[out.length - 1];
    if (prev && sameplace(prev, s) && !spineExcursionInGap(prev, s, dayPath)) {
      const pieceMs = s.end_ts_ms - s.start_ts_ms;
      if (!pinnedMs.has(prev)) pinnedMs.set(prev, prev.end_ts_ms - prev.start_ts_ms);
      if (pinLongest) {
        prev.piece_points = [...(prev.piece_points || [{ lat: prev.lat, lon: prev.lon }]),
                             ...(s.piece_points || [{ lat: s.lat, lon: s.lon }])];
        if (s.lat != null && pieceMs > pinnedMs.get(prev)) {
          prev.lat = s.lat; prev.lon = s.lon;
          pinnedMs.set(prev, pieceMs);
        }
      }
      prev.end = s.end;
      prev.end_ts_ms = Math.max(prev.end_ts_ms, s.end_ts_ms);
      prev.duration_min = Math.round((prev.end_ts_ms - prev.start_ts_ms) / 60_000);
      prev.sample_count = (prev.sample_count || 0) + (s.sample_count || 0);
      const seen = new Set((prev.photos || []).map(p => p.uuid));
      prev.photos = [...(prev.photos || []), ...(s.photos || []).filter(p => !seen.has(p.uuid))];
      prev.companions = [...new Set([...(prev.companions || []), ...(s.companions || [])])];
      prev.calendar_event = prev.calendar_event || s.calendar_event;
      // Keep the more specific label.
      if ((s.place.name || "").length > (prev.place.name || "").length) prev.place = s.place;
      continue;
    }
    out.push(s);
  }
  out.forEach((s, i) => { s.id = s.id.replace(/-\d+$/, `-${i + 1}`); });
  return out;
}

// ---------------------------------------------------------------------------
// Walk merging — adjacent browse clusters joined at walking pace are ONE walk
// ---------------------------------------------------------------------------
//
// 2026-07-27, on the previous day's summary: a restaurant the walk passed was
// listed as a stop instead of a continuation of the walk along the coastline.
// It wasn't a stop.
// The 13:13-13:27 cluster drifted 165 m on 3 GPS fixes, 415 m from the stretch
// he had just told us was a walk (11 min earlier, ~2.3 km/h) and 425 m before
// the next one (20 min, ~1.3 km/h) — walking pace in, walking pace out.
//
// The pipeline already KNEW: `location-segment` classifies drift-per-minute and
// had marked both clusters `browse`. But `browse` only ever changed how hard the
// name was hedged, never whether the thing was a stop at all, and no code
// anywhere looked at two adjacent browse clusters and asked whether they were
// the same walk. So one continuous stroll became walk / stop / walk, and the
// middle got titled with whatever restaurant was 43 m away.
//
// Merging here (before travel legs are built) also means a "not a stop" answer
// about any part of the walk now covers all of it — the settle layer binds the
// ask by time, and the merged block spans the whole stretch.

const WALK_MERGE_MAX_GAP_MIN = 20;      // longer than this and it's two outings
const WALK_MERGE_MAX_LEG_M = 800;       // further and he travelled, not strolled
const WALK_MERGE_MAX_KMH = 5;           // above walking pace = a vehicle leg

// A stop whose identity is settled is a real stop, however much it drifts —
// never absorb one into a walk.
function isSettledIdentity(stop) {
  const src = stop.place && stop.place.source;
  return src === "user_confirmed" || src === "named_location"
    || src === "known_recurring" || src === "wifi_ssid" || src === "accommodation";
}

function walkMergeable(a, b) {
  if (a.pattern !== "browse" || b.pattern !== "browse") return false;
  if (isSettledIdentity(a) || isSettledIdentity(b)) return false;
  const gapMin = (b.start_ts_ms - a.end_ts_ms) / 60_000;
  if (!(gapMin >= 0 && gapMin <= WALK_MERGE_MAX_GAP_MIN)) return false;
  if (a.lat == null || b.lat == null) return false;
  const m = haversineMeters(a.lat, a.lon, b.lat, b.lon);
  if (m > WALK_MERGE_MAX_LEG_M) return false;
  // Pace over the connecting leg. A zero-minute gap can't be measured, so treat
  // it as walking (the clusters are adjacent in time and close in space).
  const kmh = gapMin > 0 ? (m / 1000) / (gapMin / 60) : 0;
  return kmh <= WALK_MERGE_MAX_KMH;
}

function mergeWalkChains(stops) {
  const out = [];
  let i = 0;
  while (i < stops.length) {
    let j = i;
    while (j + 1 < stops.length && walkMergeable(stops[j], stops[j + 1])) j += 1;
    if (j === i) { out.push(stops[i]); i += 1; continue; }

    const members = stops.slice(i, j + 1);
    const first = members[0], last = members[members.length - 1];
    // An honest area label from any member beats a POI guess for a walk; the
    // POI guesses themselves are dropped outright (they're what made this a
    // "stop" in the reader's eyes in the first place).
    const areaMember = members.find(s => ["neighborhood", "reverse_geocode"].includes(s.place && s.place.source));
    out.push({
      ...first,
      start: first.start, end: last.end,
      start_ts_ms: first.start_ts_ms, end_ts_ms: last.end_ts_ms,
      duration_min: Math.round((last.end_ts_ms - first.start_ts_ms) / 60_000),
      lat: members.reduce((t, s) => t + s.lat, 0) / members.length,
      lon: members.reduce((t, s) => t + s.lon, 0) / members.length,
      sample_count: members.reduce((t, s) => t + (s.sample_count || 0), 0),
      cluster_radius_km: Math.max(...members.map(s => s.cluster_radius_km || 0)),
      pattern: "browse",
      user_non_stop: members.some(s => s.user_non_stop),
      photos: members.flatMap(s => s.photos || []),
      companions: [...new Set(members.flatMap(s => s.companions || []))],
      calendar_event: members.map(s => s.calendar_event).find(Boolean) || null,
      alternatives: [],
      place: { name: areaMember ? areaMember.place.name : null, address: null,
               source: "movement", confidence: 0.5, distance_m: null },
      merged_walk: {
        members: members.length,
        from: first.start, to: last.end,
        dropped_guesses: members.map(s => s.place && s.place.name).filter(Boolean),
      },
    });
    i = j + 1;
  }
  // Ids are positional, so renumber after merging to keep them contiguous.
  out.forEach((s, idx) => { s.id = s.id.replace(/-\d+$/, `-${idx + 1}`); });
  return out;
}

// ---------------------------------------------------------------------------
// Short stops — under 10 minutes isn't a stop (2026-07-27)
// ---------------------------------------------------------------------------
//
// A 5-minute cluster on a bridge and a 6-minute one outside a bar are GPS
// artefacts of a drive, not places he went, and each arrived with a nearest-POI
// guess attached ("~SHOP?", "Bridge Example" twice). They pad the
// timeline and generate follow-up questions about nothing.
//
// Runs AFTER the merges on purpose: two 13-minute browse clusters that make one
// 38-minute walk must be judged as the walk, not as their parts.
//
// A stop we actually KNOW is kept at any length — dropping a 6-minute espresso
// he confirmed by name, or a card charge, would be losing information rather
// than noise. So the filter only removes stops whose identity is a guess.
//
// Photos are never lost: an absorbed stop's photos move to the nearest
// surviving stop in time, which is where they belong narratively anyway (shots
// taken on the way somewhere), and that stop records what it absorbed.
const SHORT_STOP_MIN = 10;

// ...but a cluster's span is a LOWER BOUND on a stop, not a measurement. The
// phone samples while you walk in and stops the moment you stand still, so a
// real errand can leave fewer minutes of fixes than it took. iOS's own CLVisit
// row is the better bound, and it was sitting unread right next to the cluster.
//
// The second chain store of 2026-08-14 is the case (two stores, the second in
// the next town, a fairly short time in each). iOS
// logged 18:49:50-19:04:10, a 14-minute visit. The clustering saw fixes only
// from 18:54 to 19:02 and produced 8 minutes, which fell under the floor above
// and was absorbed into its neighbour — so the last stop of the day disappeared
// on a technicality of when the GPS happened to be awake.
//
// A visit row is only allowed to widen a stop when it is plainly THAT stop's
// own row: same place, overlapping in time, and — the guard that matters —
// **containing no other stop**. Visit rows are routinely far larger than the
// place they name (a 569-minute overnight row with a 305 m radius, or the
// 1340-minute one on 2026-08-14 that spanned into the next evening), and such a
// container would otherwise swallow an errand whole.
// 250 m, matching CONFIRMED_MATCH_M, and it is not a round number chosen for
// comfort: a CLVisit anchor is one raw coordinate whose own accuracy has been
// measured at 106 m (which is why `visit-anchor` exists at all), so a cluster
// centroid sitting 176 m from it — the second store — is ordinary GPS noise,
// not a different place. The time overlap and the container guard below are
// what make the match safe; the radius is not load-bearing on its own.
const BACKING_VISIT_MATCH_M = 250;

// ...and a visit row is not allowed to widen a venue back through his sleep
// (2026-10-14). The rented flat and the café are 93 m apart, so iOS filed the
// whole night's visit 8 m from the café, day-path's "one place, one identity"
// renamed it for the café, and this widening then pulled the café stop's start
// from the 07:38 first fix back to the day window's start -- "7:00am at the
// coffee shop" when the Watch had the user asleep until 07:29. A name that came from nearness (a confirmed-stop or POI match)
// does not outweigh the Watch; his own answer about the window, and the places
// he sleeps (lodging, named homes, recurring stops), are exempt, because
// widening those through the night is the correct overnight block.
const SLEEP_EXEMPT_SOURCES = new Set(["user_confirmed", "named_location", "known_recurring", "accommodation"]);
// ...and a geofence name is not his answer (2026-10-19). classifyStops lifts a
// `named` row (the app recognising a saved place as he arrived) to
// user_confirmed, so the 44-minute the café arrival row (09:10-09:54) named
// the whole night at the flat 100 m away and, exempt as "his answer", the day
// opened "12:00am · the café" with the Watch asleep until 08:35. Only an
// answer is final, the same test splitWideStopsOnRests and the spine carve use.
// ...and his answer covers its own row's window (2026-10-24). His "the bakery"
// named the 08:49-09:01 bakery rows; the spine's dwell ran from midnight at the
// flat 244 m away, and, exempt as "his answer", the day opened "12:00am ·
// the bakery" and the café he named for 07:56-08:47 had no window left. A row
// that began after he woke says nothing about the night, and neither does a
// window he named (addSavedAtStops): the café then ran back to 03:56 on a night
// fix at the flat 80 m away. Either way a window that began in the night is
// never held, since widensThroughSleep needs the stop itself to begin after the wake.
function sleepExempt(s, asleep = null) {
  const src = s.place && s.place.source;
  if (!SLEEP_EXEMPT_SOURCES.has(src)) return false;
  if (src === "user_confirmed" && s.from_saved_at) return false;
  if (src !== "user_confirmed" || !s.confirmed_row) return true;
  if (s.confirmed_row.place_type === "named") return false;
  const rowStart = s.confirmed_row.start_ms;
  return !(asleep && Number.isFinite(asleep.to_ms) && Number.isFinite(rowStart) && rowStart >= asleep.to_ms);
}

// True when stretching stop `s` back to `fromMs` would drag a venue through his
// sleep: the stop itself begins after he woke, the stretch reaches back before
// it. Shared by every pass that widens a stop's start (widenToBackingVisits,
// addSpineDwells) so a second widening cannot undo what the first one held.
function widensThroughSleep(s, fromMs, asleep) {
  return Boolean(asleep && Number.isFinite(asleep.to_ms) && fromMs < asleep.to_ms
    && s.start_ts_ms >= asleep.to_ms && !s.accommodation
    && !sleepExempt(s, asleep));
}

function widenToBackingVisits(stops, dayPath, asleep = null, held = []) {
  const visits = (dayPath && dayPath.visits) || [];
  if (!visits.length) return [];
  const widened = [];
  for (const s of stops) {
    if (!Number.isFinite(s.lat)) continue;
    let best = null, bestOv = 0;
    for (const v of visits) {
      if (!v.start_ms || !v.end_ms) continue;
      const ov = Math.min(s.end_ts_ms, v.end_ms) - Math.max(s.start_ts_ms, v.start_ms);
      if (ov <= 0) continue;
      const dm = haversineMeters(s.lat, s.lon, v.lat, v.lon);
      const container = stops.some(o => o !== s &&
            Math.min(o.end_ts_ms, v.end_ms) - Math.max(o.start_ts_ms, v.start_ms) > 0);
      if (dm > BACKING_VISIT_MATCH_M) continue;
      // a row that also covers a different stop is a container, not this window
      if (container) continue;
      if (ov > bestOv) { best = v; bestOv = ov; }
    }
    if (!best) continue;
    let from = Math.min(s.start_ts_ms, best.start_ms);
    const to = Math.max(s.end_ts_ms, best.end_ms);
    if (widensThroughSleep(s, from, asleep)) {
      held.push({ id: s.id, name: (s.place && s.place.name) || null, source: (s.place && s.place.source) || null,
                  kept_start: s.start, visit_started: hmFromMs(best.start_ms), woke: hmFromMs(asleep.to_ms) });
      from = s.start_ts_ms;
    }
    if (from === s.start_ts_ms && to === s.end_ts_ms) continue;
    widened.push({ was: `${s.start}-${s.end}`, now: `${hmFromMs(from)}-${hmFromMs(to)}`,
                   from_min: Math.round((s.end_ts_ms - s.start_ts_ms) / 60_000),
                   to_min: Math.round((to - from) / 60_000),
                   name: (s.place && s.place.name) || null });
    s.start_ts_ms = from; s.end_ts_ms = to;
    s.start = hmFromMs(from); s.end = hmFromMs(to);
    s.duration_min = Math.round((to - from) / 60_000);
    s.backed_by_visit = true;
  }
  return widened;
}

function dropShortStops(stops) {
  const keep = [], dropped = [];
  for (const s of stops) {
    const short = (s.duration_min != null ? s.duration_min : (s.end_ts_ms - s.start_ts_ms) / 60_000) < SHORT_STOP_MIN;
    if (short && !isSettledIdentity(s)) dropped.push(s); else keep.push(s);
  }
  if (!dropped.length) return stops;
  if (!keep.length) return stops;   // a day of nothing but short stops: keep them

  for (const d of dropped) {
    const mid = (d.start_ts_ms + d.end_ts_ms) / 2;
    let nearest = keep[0], best = Infinity;
    for (const k of keep) {
      const dist = Math.min(Math.abs(mid - k.start_ts_ms), Math.abs(mid - k.end_ts_ms));
      if (dist < best) { best = dist; nearest = k; }
    }
    if ((d.photos || []).length) {
      const seen = new Set((nearest.photos || []).map(p => p.uuid));
      nearest.photos = [...(nearest.photos || []), ...(d.photos || []).filter(p => !seen.has(p.uuid))];
    }
    // CONSOLIDATE when the short stop is really part of the neighbour — close in
    // time and space. Then it isn't a separate stop, it's a few minutes of the
    // same one, so the neighbour's window grows to include it. Otherwise the
    // entry just goes (its photos have already moved) — extending a stop across
    // a 40-minute gap and 15 km would invent a dwell that never happened.
    const nearM = d.lat != null && nearest.lat != null
      ? haversineMeters(d.lat, d.lon, nearest.lat, nearest.lon) : Infinity;
    const gapMin = best / 60_000;
    const consolidated = nearM <= 400 && gapMin <= 20;
    if (consolidated) {
      nearest.start_ts_ms = Math.min(nearest.start_ts_ms, d.start_ts_ms);
      nearest.end_ts_ms = Math.max(nearest.end_ts_ms, d.end_ts_ms);
      if (nearest.start_ts_ms === d.start_ts_ms) nearest.start = d.start;
      if (nearest.end_ts_ms === d.end_ts_ms) nearest.end = d.end;
      nearest.duration_min = Math.round((nearest.end_ts_ms - nearest.start_ts_ms) / 60_000);
    }
    nearest.absorbed_short_stops = [...(nearest.absorbed_short_stops || []), {
      start: d.start, end: d.end,
      minutes: Math.round((d.end_ts_ms - d.start_ts_ms) / 60_000),
      was: (d.place && d.place.name) || null,
      photos: (d.photos || []).length,
      consolidated,
    }];
  }
  keep.forEach((s, i) => { s.id = s.id.replace(/-\d+$/, `-${i + 1}`); });
  return keep;
}

// ---------------------------------------------------------------------------
// The follow-up list obeys the same rule (2026-10-07)
// ---------------------------------------------------------------------------
//
// dropShortStops judges each stop by its widened window, and it runs well
// before reconcileStopTimeline, which then takes the travel time between two
// stops out of whichever one the trace contradicts, down to a 60-second floor.
// So a guess can pass the drop at 12 minutes, come out of reconcile at 3, and
// land in unknown_stops[] as a question. On 2026-10-06 that was the whole of the
// day's follow-up list: "you paused right by the Airbnb just before the walk to
// lunch. Was that just stepping out?", about the minutes it took to leave the
// house. That is the flat "pause or stop?" ask retired on 2026-04-19, about a
// window the rule above says isn't a stop, on the day he had asked of an
// 8-minute one "why is this a question? did I actually linger at a specific
// spot?". Measured over the stored summaries from 2026-08-01: 22 of 118
// follow-ups were under 10 minutes, 15 of them reconcile-trimmed (most to the
// 1-minute floor), and on 2026-08-25, 08-31, 09-11 and 10-06 one of them was
// the phone pointer's only reason to be sent.
//
// The stop stays in the timeline; only the question goes. Three things keep a
// short one askable. A name we actually know (the same exemption the drop
// gives). An iOS visit row behind it, because that row is the better bound on
// how long the user was there (the 2026-08-14 store, above). And fragments under
// the floor that touch each other are judged as the run they make, the way the
// drop judges a walk rather than its parts. A short fragment touching a LONG
// stop is that stop's edge (the 2026-10-06 one sat 4 m from the Airbnb and
// began the minute the Airbnb stop ended), so it is judged on its own.
// Missing timestamps or durations fail open: the stop stays askable.
const FOLLOW_UP_TOUCH_MS = 2 * 60_000;

function askableStops(stops) {
  const minutes = (s) => (s.duration_min != null ? s.duration_min : (s.end_ts_ms - s.start_ts_ms) / 60_000);
  const short = (s) => minutes(s) < SHORT_STOP_MIN && !isSettledIdentity(s) && !s.backed_by_visit;
  const timed = (s) => Number.isFinite(s.start_ts_ms) && Number.isFinite(s.end_ts_ms);
  const ordered = stops.filter(timed).sort((a, b) => a.start_ts_ms - b.start_ts_ms);
  const unaskable = new Set();
  for (let i = 0; i < ordered.length; ) {
    if (!short(ordered[i])) { i++; continue; }
    let j = i;
    while (j + 1 < ordered.length && short(ordered[j + 1])
           && ordered[j + 1].start_ts_ms - ordered[j].end_ts_ms <= FOLLOW_UP_TOUCH_MS) j++;
    if ((ordered[j].end_ts_ms - ordered[i].start_ts_ms) / 60_000 < SHORT_STOP_MIN) {
      for (let k = i; k <= j; k++) unaskable.add(ordered[k]);
    }
    i = j + 1;
  }
  // No timestamps means no runs to judge, but a recorded duration still counts.
  for (const s of stops) if (!timed(s) && short(s)) unaskable.add(s);
  return stops.filter(s => !unaskable.has(s));
}

function buildTravelLegs(stops) {
  const legs = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    const gapMin = Math.round((b.start_ts_ms - a.end_ts_ms) / 60_000);
    if (gapMin < 0) continue;
    let distKm = null;
    if (a.lat && a.lon && b.lat && b.lon) {
      distKm = +(haversineMeters(a.lat, a.lon, b.lat, b.lon) / 1000).toFixed(3);
    }
    legs.push({
      from: a.id,
      to: b.id,
      duration_min: gapMin,
      distance_km: distKm,
      mode: null, // left for narrator/playbook to infer from distance+duration
    });
  }
  return legs;
}

// ---------------------------------------------------------------------------
// Self-sent iMessages: corrections + declarative facts
// ---------------------------------------------------------------------------

// Which of the user's sent iMessages are corrections and which are facts about the
// day is a reading of language, so a model does it, in `bin/day-statements`
// (`self_messages[]`, Rule #0b). This only sorts that reading into the two lists
// the day has always carried. No reading (day-statements has not run, or could not
// read the messages) means no corrections and no facts for the day: there is no
// string-matching fallback (lib/message-classifier.js, retired 2026-10-29).
function selfMessageSignals(statements) {
  const list = statements && Array.isArray(statements.self_messages) ? statements.self_messages : null;
  const corrections = [], declarative = [];
  for (const m of list || []) {
    if (!m || (m.kind !== "correction" && m.kind !== "declarative")) continue;
    const rec = { at: m.at || null, channel: "imsg_self", text: m.text || "", quote: m.quote || null,
                  markers: [], reason: "day-statements" };
    (m.kind === "correction" ? corrections : declarative).push(rec);
  }
  return { corrections, declarative, total: list ? list.length : null };
}

// Kept for debuggers (`imsg sent` for the day's window); resolve-day itself no
// longer reads the messages.
function fetchImsgSent(dateStr) {
  // The day's own window. `imsg sent` compares these as UTC wall-clock strings
  // (SQLite strftime), so pass the window's instants, not "<date> 00:00:00" --
  // that was a UTC day, neither the home-zone day nor the day abroad.
  const utcClock = (ms) => new Date(ms).toISOString().slice(0, 19).split("T").join(" ");
  const since = utcClock(Date.parse(etBoundaryUtcIso(dateStr)));
  const until = utcClock(Date.parse(etBoundaryUtcIso(addDays(dateStr, 1))) - 1000);
  const res = spawnSync(IMSG_BIN, ["sent", "--since", since, "--until", until, "--json"], { encoding: "utf8" });
  if (res.status !== 0) return [];
  try { return JSON.parse(res.stdout || "[]"); }
  catch { return []; }
}

// ---------------------------------------------------------------------------
// Photo-GPS gap-fill (the user 2026-06-21): the phone GPS frequently dies, leaving
// hours unrepresented (e.g. 2026-06-20 a beach neighbourhood afternoon). photos-
// synthesize-stops reconstructs those windows from the GPS embedded in photos
// The user TOOK (camera-captured), which is *stronger* evidence than the phone's
// own pings. Those rows live in location_history (place_type=photo-synthesized)
// but were never read here. Ingest them into real GPS gaps, attach their photos,
// and name them by the confidence-gated ladder (reliable venue, else
// neighborhood). resolve_place's dense-area POI guesses are NOT trusted for
// these (a photo cluster in a city block can't pin a venue) — only named/
// confirmed/recurring tiers yield a venue; everything else falls to neighborhood.
// ---------------------------------------------------------------------------

// Name a single point via `location-segment resolve-point`. Returns
// { name, source, confidence, neighborhood } or null on failure.
function resolvePointName(lat, lon, atIso) {
  const args = ["resolve-point", String(lat), String(lon)];
  if (atIso) args.push("--at", atIso);
  const res = spawnSync(LOCATION_SEGMENT_BIN, args, { encoding: "utf8", timeout: 30_000 });
  if (res.status !== 0 || !res.stdout) return null;
  try { return JSON.parse(res.stdout); } catch { return null; }
}

// Confidence-gated label for a weak/gap-fill point: trust a venue name only from
// the reliable tiers; otherwise use the neighborhood. Returns a `primary`-shaped
// object or null.
function gatedPlaceFromPoint(lat, lon, atIso) {
  const r = resolvePointName(lat, lon, atIso);
  if (!r) return null;
  const RELIABLE = new Set(["named_location", "confirmed_stop", "known_recurring", "wifi_ssid"]);
  if (r.name && RELIABLE.has(r.source)) {
    return { name: r.name, address: r.address || null, source: r.source, confidence: r.confidence, distance_km: null };
  }
  if (r.neighborhood) {
    // 0.6 keeps a neighborhood-named gap-fill stop out of unknown_stops[] (its
    // threshold is <0.6) — we DID label it, just not to a venue.
    return { name: r.neighborhood, address: r.address || null, source: "neighborhood", confidence: 0.6, distance_km: null };
  }
  // last resort: whatever name we got, but flag it low-confidence
  if (r.name) return { name: r.name, address: r.address || null, source: "neighborhood", confidence: 0.5, distance_km: null };
  return null;
}

// Attach the day's located photos to a stop by time-window + ≤200m proximity
// (mirrors location-segment's attach_photos_to_stop). `photos` rows carry
// uuid/taken_at/latitude/longitude. Produces the resolved-stop photo shape.
function attachPhotosToStop(stop, photos, radiusM = 200) {
  const out = [];
  for (const p of photos) {
    if (p.latitude == null || p.longitude == null) continue;
    const t = Date.parse(p.taken_at);
    if (!(t >= stop.start_ts_ms - 5 * 60_000 && t <= stop.end_ts_ms + 5 * 60_000)) continue;
    const d = haversineMeters(stop.centroid.lat, stop.centroid.lon, p.latitude, p.longitude);
    if (d > radiusM) continue;
    // lat/lon travel with the photo because the camera fix is frequently the
    // most precise thing in the window, and because the DIFFERENCE between it
    // and the stop's centroid is the evidence that the stop is mislocated —
    // 65 m of it on 2026-09-05, recorded nowhere and read by nobody.
    out.push({ uuid: p.uuid, ts: p.taken_at, media_type: p.media_type, favorite: !!p.favorite,
               persons: p.persons || [], lat: p.latitude, lon: p.longitude,
               self_captured: p.self_captured !== false,
               centroid_offset_m: Math.round(d) });
  }
  return out;
}

async function fetchDayPhotos(dateStr) {
  const startIso = etBoundaryUtcIso(dateStr);
  const endIso = etBoundaryUtcIso(addDays(dateStr, 1));
  // self_captured filter (photos.self_captured column, added 2026-06-21): the
  // caller keeps only photos the user took (received ones carry the sender's GPS).
  // A null value (older row not yet re-synced) reads as self-captured so no
  // history is lost.
  const rows = await supabaseSelect(
    "photos",
    `select=uuid,taken_at,latitude,longitude,media_type,favorite,persons,self_captured,detected_text,labels` +
      `&taken_at=gte.${encodeURIComponent(startIso)}` +
      `&taken_at=lt.${encodeURIComponent(endIso)}` +
      `&latitude=not.is.null` +
      `&order=taken_at.asc`,
  );
  return rows || [];
}

// ---------------------------------------------------------------------------
// Orphan iOS visits — a visit iOS recorded that GPS clustering never saw
// ---------------------------------------------------------------------------
//
// 2026-07-27: an evening concert was missing from the day though it had photos
// and a calendar entry. iOS had it exactly right — `location_history` held a
// **101-minute** visit, 19:44:41 → 21:25:42, already `user-confirmed`. Seven
// geotagged photos and videos sat inside that window within ~20 m of each other,
// and a physical calendar event covered it.
//
// It never became a stop because `location-segment` clusters RAW BREADCRUMBS and
// the phone stopped emitting them the moment he sat still — so with no samples
// there was nothing to cluster, and it emitted one 38.7 km *route* spanning
// 19:44→22:28 (drive out, concert, drive back) as continuous movement. Every
// downstream net then declined for a defensible reason: the photo-stop synthesizer
// requires NO existing visit row within 300 m and there was one (0 m away);
// `classifyStops` only ever RENAMES a stop, it cannot create one, so a
// user-confirmed 101-minute visit with no GPS cluster was dropped silently; and
// with no stop the calendar event had nothing to overlap, so it fell to
// `unmatched_calendar_events` — correct under "calendar without GPS evidence is
// NOT a visit", a rule written to prevent fabricated visits, here demoting a
// real one.
//
// iOS deciding "this was a visit" IS GPS evidence. Promote it.

const ORPHAN_VISIT_MIN_MIN = 10;      // shorter reads as a transient CLVisit blip
const ORPHAN_VISIT_DEDUP_M = 300;     // an existing stop this close already covers it

async function mergeOrphanVisitStops(adaptedStops, dateStr) {
  const startIso = etBoundaryUtcIso(dateStr);
  const endIso = etBoundaryUtcIso(addDays(dateStr, 1));
  let rows;
  try {
    rows = await supabaseSelect(
      "location_history",
      `select=id,arrived_at,departed_at,latitude,longitude,place_name,place_type,companions` +
        `&segment_type=eq.visit` +
        `&arrived_at=gte.${encodeURIComponent(startIso)}` +
        `&arrived_at=lt.${encodeURIComponent(endIso)}` +
        `&order=arrived_at.asc`,
    );
  } catch (e) {
    process.stderr.write(`[resolve-day] orphan-visit lookup skipped: ${(e && e.message) || e}\n`);
    return;
  }
  if (!rows || !rows.length) return;

  const allPhotos = await fetchDayPhotos(dateStr);
  const photos = allPhotos.filter(p => p.self_captured !== false);

  // The table holds each visit twice (two writers). Collapse by window+centroid,
  // keeping the richest row — the labelled one, when there is one.
  const byKey = new Map();
  for (const v of rows) {
    if (v.latitude == null || v.longitude == null) continue;
    if (v.place_type === "non-stop") continue;          // he told us it wasn't one
    if (v.place_type === "photo-synthesized") continue; // mergePhotoSynthesizedStops owns these
    const key = `${v.arrived_at}|${v.latitude.toFixed(4)}|${v.longitude.toFixed(4)}`;
    const prev = byKey.get(key);
    const rank = (r) => (r.place_type === "user-confirmed" ? 3 : r.place_name ? 2 : 1);
    if (!prev || rank(v) > rank(prev)) byKey.set(key, v);
  }

  for (const v of byKey.values()) {
    const vStart = Date.parse(v.arrived_at);
    const vEnd = v.departed_at ? Date.parse(v.departed_at) : vStart + 30 * 60_000;
    if (!(vEnd - vStart >= ORPHAN_VISIT_MIN_MIN * 60_000)) continue;
    // Already represented by a GPS-clustered stop? Then it isn't an orphan.
    const covered = adaptedStops.some(s =>
      s.start_ts_ms < vEnd && s.end_ts_ms > vStart &&
      haversineMeters(s.centroid.lat, s.centroid.lon, v.latitude, v.longitude) <= ORPHAN_VISIT_DEDUP_M);
    if (covered) continue;

    const stop = {
      start_ts_ms: vStart,
      end_ts_ms: vEnd,
      duration_minutes: Math.round((vEnd - vStart) / 60_000),
      centroid: { lat: v.latitude, lon: v.longitude },
      cluster_radius_km: null,
      sample_count: null,
      primary: null,
      alternatives: [],
      photos: [],
      pattern: "dwell",
      calendar_event: null,
      companions: Array.isArray(v.companions) ? v.companions : [],
      _orphan_visit: true,
    };
    stop.photos = attachPhotosToStop(stop, photos);

    // Name it: what he confirmed, else the confidence-gated point lookup. The
    // calendar event is attached later by enrichStopsWithCalendar, which is why
    // this runs before it.
    if (v.place_name && (v.place_type === "user-confirmed" || v.place_type === "named")) {
      stop.primary = { name: v.place_name, address: null, source: "user_confirmed", confidence: 1.0, distance_km: null };
    } else {
      stop.primary = gatedPlaceFromPoint(v.latitude, v.longitude, v.arrived_at) || null;
    }

    stop.orphan_visit = {
      minutes: stop.duration_minutes,
      photos: stop.photos.length,
      label_was: v.place_name || null,
      label_type: v.place_type || null,
    };
    // A stop we only know about because iOS said so has no venue evidence of
    // its own, so a PHYSICAL calendar event covering it is the best identity
    // available — two independent signals (the visit + the schedule) rather
    // than a guess. This is also the one case where a calendar event may
    // outrank a `user-confirmed` label: that label got here by the chat-agent
    // binding a free-text answer to the nearest unresolved visit, which is
    // exactly how the 2026-07-26 concert ended up titled "Dinner in <a village>
    // — stopped at a restaurant for a cheese and wine plate" (the dinner was
    // 5 km away and 90 minutes earlier, with its own card charge). The
    // displaced label is kept in `orphan_visit.label_was` and the stop is
    // flagged so the conflict is visible rather than silently resolved.
    stop._calendar_may_name = true;
    adaptedStops.push(stop);
    process.stderr.write(`[resolve-day] promoted orphan iOS visit ${hmFromMs(vStart)}-${hmFromMs(vEnd)}`
      + ` (${stop.duration_minutes}min, ${stop.photos.length} photo(s))`
      + ` — no GPS cluster covered it\n`);
  }
  adaptedStops.sort((a, b) => a.start_ts_ms - b.start_ts_ms);
}

async function mergePhotoSynthesizedStops(adaptedStops, dateStr) {
  const startIso = etBoundaryUtcIso(dateStr);
  const endIso = etBoundaryUtcIso(addDays(dateStr, 1));
  const rows = await supabaseSelect(
    "location_history",
    `select=id,arrived_at,departed_at,latitude,longitude,place_name,companions` +
      `&segment_type=eq.visit&place_type=eq.photo-synthesized` +
      `&arrived_at=gte.${encodeURIComponent(startIso)}` +
      `&arrived_at=lt.${encodeURIComponent(endIso)}` +
      `&order=arrived_at.asc`,
  );
  if (!rows || !rows.length) return;

  // Photos for attachment — self-captured only (received photos carry the
  // sender's GPS, not the user's). Treat a missing self_captured flag as true
  // (older rows predate the column) so we don't lose history.
  const allPhotos = await fetchDayPhotos(dateStr);
  const photos = allPhotos.filter(p => p.self_captured !== false);

  for (const v of rows) {
    if (v.latitude == null || v.longitude == null) continue;
    const vStart = Date.parse(v.arrived_at);
    const vEnd = v.departed_at ? Date.parse(v.departed_at) : vStart + 30 * 60_000;
    // Dedup: drop if an existing GPS stop already covers this window within
    // 300m — the phone-tracked, already-named stop wins (e.g. a concert hall vs the
    // airport photo-synth). Attach any of its photos to that stop instead.
    const covering = adaptedStops.find(s =>
      s.start_ts_ms < vEnd && s.end_ts_ms > vStart &&
      haversineMeters(s.centroid.lat, s.centroid.lon, v.latitude, v.longitude) <= 300);
    if (covering) {
      const add = attachPhotosToStop(covering, photos).filter(np => !(covering.photos || []).some(ep => ep.uuid === np.uuid));
      covering.photos = [...(covering.photos || []), ...add];
      continue;
    }
    const stop = {
      start_ts_ms: vStart,
      end_ts_ms: vEnd,
      duration_minutes: Math.round((vEnd - vStart) / 60_000),
      centroid: { lat: v.latitude, lon: v.longitude },
      cluster_radius_km: null,
      sample_count: null,
      primary: null, // named below
      alternatives: [],
      photos: [],
      pattern: "dwell",
      calendar_event: null,
      companions: Array.isArray(v.companions) ? v.companions : [],
      _photo_synth: true,
    };
    // Attach self-captured photos and GROW the window to the full contiguous
    // run within the neighborhood (synthesize captures only the densest core —
    // a beach parade was a ~45-min boardwalk walk recorded as a 12-min
    // cluster). 400m radius spans a walked block without reaching the next
    // neighborhood (two neighbourhoods are 3.9km apart); 45-min max gap bridges
    // the walk. The stop's displayed span becomes first→last photo.
    const NEIGH_R = 400, MAX_GAP = 45 * 60_000;
    const near = photos
      .filter(p => p.latitude != null &&
        haversineMeters(v.latitude, v.longitude, p.latitude, p.longitude) <= NEIGH_R)
      .sort((a, b) => Date.parse(a.taken_at) - Date.parse(b.taken_at));
    let lo = vStart, hi = vEnd, changed = true;
    while (changed) {
      changed = false;
      for (const p of near) {
        const t = Date.parse(p.taken_at);
        if (t < lo && t >= lo - MAX_GAP) { lo = t; changed = true; }
        if (t > hi && t <= hi + MAX_GAP) { hi = t; changed = true; }
      }
    }
    stop.start_ts_ms = lo;
    stop.end_ts_ms = hi;
    stop.duration_minutes = Math.round((hi - lo) / 60_000);
    stop.photos = near
      .filter(p => { const t = Date.parse(p.taken_at); return t >= lo - 1 && t <= hi + 1; })
      .map(p => ({ uuid: p.uuid, ts: p.taken_at, media_type: p.media_type, favorite: !!p.favorite, persons: p.persons || [] }));
    // Name it: confidence-gated. Skip the centroid's POI guess; reliable venue
    // or neighborhood only.
    stop.primary = gatedPlaceFromPoint(v.latitude, v.longitude, v.arrived_at)
      || { name: v.place_name && v.place_name !== "(photo-inferred)" ? v.place_name : null, address: null, source: "photo_gps", confidence: 0.5, distance_km: null };
    adaptedStops.push(stop);
  }
  adaptedStops.sort((a, b) => a.start_ts_ms - b.start_ts_ms);
}

// Name any remaining weak GPS stops (coordinate/unknown fallback) by neighborhood
// so the report never shows a bare "(40.7, -73.9)" or an unnamed stop.
function nameWeakStops(adaptedStops) {
  for (const s of adaptedStops) {
    const src = s.primary?.source;
    const nm = s.primary?.name;
    if (nm && src && !["coordinate", "unknown"].includes(src)) continue;
    if (nm && nm !== "(photo-inferred)" && src !== "coordinate" && src !== "unknown") continue;
    const gated = gatedPlaceFromPoint(s.centroid.lat, s.centroid.lon, new Date(s.start_ts_ms).toISOString());
    if (gated) s.primary = gated;
  }
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The path spine
// ---------------------------------------------------------------------------

// `day-path` owns the day's continuous, street-matched trace. Every GPS point is
// snapped to the network and a real route is drawn between consecutive points --
// no straight lines, nothing dropped (2026-07-30). It also owns the day
// WINDOW, so this is what makes the origin-timezone rule real rather than a
// renderer detail.
const DAY_PATH_BIN = path.join(JORI, "bin/day-path");

function runDayPath(dateStr, tz) {
  try {
    const args = [dateStr, "--json"];
    if (tz) args.push("--tz", tz);
    // The daily summary leads with the map, so resolve-day renders + uploads it
    // in the same invocation. JORI_DAY_MAP=0 skips it for callers that only
    // want the geometry (and so a map outage can never fail a day's resolve).
    if (process.env.JORI_DAY_MAP !== "0") args.push("--png", "--upload");
    const out = execFileSync(DAY_PATH_BIN, args, {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000,
    });
    return JSON.parse(out);
  } catch (e) {
    process.stderr.write(`[resolve-day] day-path failed (${e.message}) — continuing without the path spine\n`);
    return null;
  }
}

// A routed path finally makes the timeline checkable: two stops cannot overlap
// in time AND sit apart on the map, because getting between them costs time.
// 19 of the 31 days to 2026-07-30 carry at least one such pair (79 pairs, 19 of
// them >5 km apart and outright impossible). Left alone they eat the travel time
// between the places they claim -- Jul 29 reported 15.7 km walked against 1.8 h
// of movement, an 8.6 km/h "walking" pace.
//
// We reconcile rather than discard: a record the user confirmed himself is not
// something to throw away because a second record disagrees. Instead we shrink
// the overlap until the gap covers the travel the route actually requires,
// taking the time from the less-trustworthy stop first.
const RECONCILE_PACE_M_PER_H = 4800;   // ordinary walking
const ROUTE_DETOUR = 1.3;              // measured street/straight ratio in a dense old city

// Walking is the FLOOR, not the assumption. In a walkable city the user walked between stops and
// 4800 m/h was right; where the user drives, and charging a 5.9 km hop at walking
// pace bills 96 minutes for a 10-minute drive. On 2026-08-15 that manufactured a
// conflict out of nothing: the beach sat 78 minutes after home, the reconciler
// demanded 96, and took the difference out of the beach -- 18 minutes down to
// the 60-second floor below, which then failed the renderer's 30-minute
// main-stop test. The stop was deleted twice over, by two rules that each
// assumed he was on foot.
//
// The trace already knows how he travelled. The fastest routed leg around the
// transition is what was physically available to him, so use it whenever it
// beats walking. With no legs to read there is no evidence and we fall back to
// walking -- silence must not buy a stop a free pass.
//
// The two moments are deliberately sorted before use. The pair that triggers
// this is usually OVERLAPPING (on 2026-08-15 the home stop claimed until 22:32
// while the beach started at 18:01, a 270-minute overlap), and an inverted
// window matches no legs at all -- which silently returned the walking floor and
// left the bug in place on the first attempt at this fix.
function crossingPaceMPerH(dayPath, aEndMs, bStartMs) {
  const from = Math.min(aEndMs, bStartMs);
  const to = Math.max(aEndMs, bStartMs);
  const fastest = fastestKmh(legsIn(dayPath, from, to));
  if (fastest == null) return RECONCILE_PACE_M_PER_H;
  return Math.max(RECONCILE_PACE_M_PER_H, fastest * 1000);
}

function stopTrust(s) {
  const src = (s.place && s.place.source) || "";
  if (src === "user_confirmed") return 3;
  if (src === "named_location" || src === "known_recurring") return 2;
  if (src === "confirmed_stop" || src === "calendar_corroborated") return 1;
  return 0;
}

// How long the routed trace was actually near a stop's own coordinates during a
// window. A stop's time bounds are only as good as the fixes underneath them.
const PRESENCE_R_M = 250;

// Past this, he flew. A straight line this long is not a gap ground pace can
// price, and pretending otherwise is what produced the 2026-08-12 trim.
const AIR_TRAVEL_M = 300_000;
// And no honest reconciliation of two stops inside one day can demand more
// travel than the day holds.
const MAX_RECONCILE_TRAVEL_MS = 6 * 3600_000;

function tracePresenceMs(dayPath, stop, fromMs, toMs) {
  if (!Number.isFinite(stop.lat)) return 0;
  let ms = 0;
  for (const leg of legsIn(dayPath, fromMs, toMs)) {
    const ov = Math.min(toMs, leg.t1) - Math.max(fromMs, leg.t0);
    if (ov <= 0) continue;
    const near = Math.min(haversineMeters(stop.lat, stop.lon, leg.lat0, leg.lon0),
                          haversineMeters(stop.lat, stop.lon, leg.lat1, leg.lon1));
    if (near <= PRESENCE_R_M) ms += ov;
  }
  return ms;
}

// Of two overlapping stops, which one is the trace standing against? Returns
// "a", "b", or null when the path cannot tell them apart -- one stop has to be
// clearly corroborated over the contested window and the other clearly absent.
function contradictedByTrace(dayPath, a, b) {
  if (!dayPath) return null;
  const from = Math.max(a.start_ts_ms, b.start_ts_ms);
  const to = Math.min(a.end_ts_ms, b.end_ts_ms);
  if (to <= from) return null;                       // no overlap to arbitrate
  const pa = tracePresenceMs(dayPath, a, from, to);
  const pb = tracePresenceMs(dayPath, b, from, to);
  const span = to - from;
  const CORROBORATED = 0.5, ABSENT = 0.1;            // shares of the overlap
  if (pb >= span * CORROBORATED && pa <= span * ABSENT) return "a";
  if (pa >= span * CORROBORATED && pb <= span * ABSENT) return "b";
  return null;
}

function reconcileStopTimeline(stops, dayPath) {
  const adjustments = [];
  const conflicts = [];
  const ordered = [...stops].sort((a, b) => a.start_ts_ms - b.start_ts_ms);
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i], b = ordered[i + 1];
    if (!Number.isFinite(a.lat) || !Number.isFinite(b.lat)) continue;
    const straightM = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    if (straightM < 60) continue;                       // same place, not a conflict
    // Beyond a few hundred km he flew, and a ground-pace model has nothing to
    // say about the gap. On 2026-08-12 two stops 1449 km apart (home ->
    // abroad) were billed at walking pace: the reconciler demanded 23,547
    // minutes of travel — sixteen days — and took 23,328 of them out of the
    // earlier stop, silently, on a day nobody looked at. Surface it instead;
    // "unresolved conflicts are surfaced, not hidden" was always the rule here.
    if (straightM > AIR_TRAVEL_M) {
      conflicts.push({ between: [a.place?.name || a.id, b.place?.name || b.id],
                       apart_m: Math.round(straightM), reason: "too far apart to be ground travel" });
      continue;
    }
    const pace = crossingPaceMPerH(dayPath, a.end_ts_ms, b.start_ts_ms);
    const travelMs = (straightM * ROUTE_DETOUR) / pace * 3600_000;
    const slack = b.start_ts_ms - a.end_ts_ms;
    if (slack >= travelMs) continue;                    // timeline already works
    // A demand the day itself cannot contain is a broken model, not a broken
    // timeline. Trimming to satisfy it destroys real hours to protect a guess.
    if (travelMs > MAX_RECONCILE_TRAVEL_MS) {
      conflicts.push({ between: [a.place?.name || a.id, b.place?.name || b.id],
                       apart_m: Math.round(straightM),
                       needed_travel_min: Math.round(travelMs / 60000),
                       reason: "required travel exceeds the day" });
      continue;
    }
    const need = travelMs - slack;
    const ta = stopTrust(a), tb = stopTrust(b);
    // Take the time from the stop the trace CONTRADICTS, and only when the trace
    // has nothing to say fall back to which name we trust more. `stopTrust`
    // ranks provenance of the NAME, but the conflict here is over a TIME BOUND,
    // and the two are not the same question -- on 2026-08-15 it handed the whole
    // overlap to the beach (5 fixes, 5.9 km from home, unnamed) to protect the
    // end of a home stop that no fix supported, leaving the beach at the
    // 60-second floor below.
    const payer = contradictedByTrace(dayPath, a, b);
    let fromA = payer === "a" ? need : payer === "b" ? 0
      : ta < tb ? need : ta > tb ? 0 : need / 2;
    let fromB = need - fromA;
    const roomA = Math.max(0, (a.end_ts_ms - a.start_ts_ms) - 60_000);
    const roomB = Math.max(0, (b.end_ts_ms - b.start_ts_ms) - 60_000);
    if (fromA > roomA) { fromB += fromA - roomA; fromA = roomA; }
    if (fromB > roomB) { fromA = Math.min(roomA, fromA + (fromB - roomB)); fromB = roomB; }
    if (fromA <= 0 && fromB <= 0) continue;
    a.end_ts_ms -= fromA;
    b.start_ts_ms += fromB;
    a.end = hmFromMs(a.end_ts_ms);
    b.start = hmFromMs(b.start_ts_ms);
    a.duration_min = Math.round((a.end_ts_ms - a.start_ts_ms) / 60000);
    b.duration_min = Math.round((b.end_ts_ms - b.start_ts_ms) / 60000);
    a.timeline_reconciled = b.timeline_reconciled = true;
    adjustments.push({
      between: [a.place?.name || a.id, b.place?.name || b.id],
      apart_m: Math.round(straightM),
      needed_travel_min: Math.round(travelMs / 60000),
      crossing_kmh: Math.round(pace / 100) / 10,
      slack_min: Math.round(slack / 60000),
      paid_by: payer ? (payer === "a" ? "earlier (trace contradicts it)" : "later (trace contradicts it)") : "trust",
      // what the two windows claimed BEFORE this trim
      earlier_claimed_until: hmFromMs(a.end_ts_ms + fromA),
      later_claimed_from: hmFromMs(b.start_ts_ms - fromB),
      trimmed_min: Math.round(need / 60000),
      took_from: fromA > fromB ? "earlier" : fromB > fromA ? "later" : "both",
    });
  }
  return { adjustments, conflicts };
}

// ---------------------------------------------------------------------------
// the user's own answers are the stop list
// ---------------------------------------------------------------------------
//
// The stop set came from location-segment breadcrumb clustering, which never
// consults what he actually told us. On 2026-07-29 that dropped two stops he
// named outright -- "Morning coffee at a café" and the drink by the covered
// market -- while inventing six venues (a circus, two bistros, a church, a tea
// shop, a chain café) for windows the user had explicitly called walking. His answers were
// captured correctly in location_history the whole time; nothing downstream
// read them.
//
// So: every user-confirmed visit becomes a stop, and a resolver guess may never
// displace one.
const CONFIRMED_MATCH_M = 250;

function overlayConfirmedVisits(stops, dayPath) {
  // One-to-one assignment, largest confirmed visit first. Matching each visit
  // independently let several of them claim the SAME clustering stop -- the
  // apartment took the 07:47 block, so a café (100 m away, overlapping)
  // found it already confirmed and was dropped without trace.
  // "His window" is the CONFIRMED row's span, which day-path carries as
  // confirmed_start_ms/end_ms; the dwell's own span is the merged place's whole
  // stay and can be far wider (2026-09-08: a 42-minute "Market Example" row inside
  // a 171-minute dwell for the same building — applying the dwell's window
  // renamed the movie next door and re-merged the two stops).
  const visits = ((dayPath && dayPath.visits) || [])
    .filter(v => v.ptype === "user-confirmed" && v.name && v.start_ms)
    // ...within the dwell: when day-path splits a stay around a stop he named inside
    // it (2026-10-16, the flat's 05:39-14:20 answer around the café 10:18-10:57),
    // both pieces carry the row's whole span, and applying it to each crushed the café
    // to one minute. The part of his window this dwell covers (JORI_CONFIRMED_SPAN_CLIP=0
    // restores the row's whole span).
    .map(v => process.env.JORI_CONFIRMED_SPAN_CLIP === "0"
      ? ({ ...v, start_ms: v.confirmed_start_ms || v.start_ms, end_ms: v.confirmed_end_ms || v.end_ms })
      : ({ ...v, start_ms: Math.max(v.confirmed_start_ms || v.start_ms, v.start_ms),
           end_ms: Math.min(v.confirmed_end_ms || v.end_ms, v.end_ms) }))
    .filter(v => v.end_ms > v.start_ms)
    .sort((x, y) => (y.end_ms - y.start_ms) - (x.end_ms - x.start_ms));
  const claimed = new Set();
  const added = [];
  for (const v of visits) {
    let best = null, bestOv = 0;
    for (const s2 of stops) {
      if (claimed.has(s2.id)) continue;
      const ov = Math.min(s2.end_ts_ms, v.end_ms) - Math.max(s2.start_ts_ms, v.start_ms);
      if (ov <= 0) continue;
      if (haversineMeters(s2.lat, s2.lon, v.lat, v.lon) >= CONFIRMED_MATCH_M) continue;
      if (ov > bestOv) { best = s2; bestOv = ov; }
    }
    if (best) {
      claimed.add(best.id);
      best.place = { ...best.place, name: v.name, source: "user_confirmed", confidence: 1 };
      // A later confirmation that names a venue overrides an earlier
      // "not a stop" on the same window -- otherwise the drink by the covered
      // market renames the walk-through but stays filtered out.
      best.user_non_stop = false;
      best.is_movement = false;
      // his window, not the cluster's approximation of it
      best.start_ts_ms = v.start_ms; best.end_ts_ms = v.end_ms;
      best.start = hmFromMs(v.start_ms); best.end = hmFromMs(v.end_ms);
      best.duration_min = Math.round((v.end_ms - v.start_ms) / 60000);
      best.lat = v.lat; best.lon = v.lon;
      continue;
    }
    const ns = {
      id: `s-${dateKeyOf(v.start_ms)}-c${added.length + 1}`,
      start: hmFromMs(v.start_ms), end: hmFromMs(v.end_ms),
      start_ts_ms: v.start_ms, end_ts_ms: v.end_ms,
      duration_min: Math.round((v.end_ms - v.start_ms) / 60000),
      lat: v.lat, lon: v.lon,
      place: { name: v.name, source: "user_confirmed", confidence: 1, address: null },
      companions: [], photos: [], alternatives: [], pattern: "dwell",
      calendar_event: null, from_confirmed_visit: true,
    };
    claimed.add(ns.id);
    stops.push(ns);
    added.push(v.name);
  }
  // an unconfirmed cluster fully inside a confirmed window is the same visit
  const conf = stops.filter(s2 => (s2.place.source === "user_confirmed"));
  const drop = new Set();
  for (const s2 of stops) {
    if (s2.place.source === "user_confirmed") continue;
    for (const c of conf) {
      if (s2.start_ts_ms >= c.start_ts_ms - 60000 && s2.end_ts_ms <= c.end_ts_ms + 60000) {
        drop.add(s2.id); break;
      }
    }
  }
  const kept = stops.filter(s2 => !drop.has(s2.id));
  stops.length = 0; stops.push(...kept);
  stops.sort((x, y) => x.start_ts_ms - y.start_ts_ms);
  return added;
}

// A place he named for a past window (`location-confirm save-at`: a Maps link,
// "we had dinner at X") is a stop even where the phone never paused, so no visit
// row or dwell exists for it to name. 2026-10-16: he picked a family member up at the airport
// inside a 56-minute drive the phone saw once every five minutes, and his emailed
// "This is missing a family member's pickup at the airport" had nowhere to land. Only save-at
// entries (our own `lc-at-` ask_id), only at least SHORT_STOP_MIN long inside the
// day, and only where no stop already claims any of the window. A stop there is
// either the same visit or a conflict to look at, never something to overwrite:
// the same visit (within SAVED_AT_SAME_M, and mostly inside his window) is his
// answer about it, so it is marked his (2026-10-16: the restaurant dinner, named
// from the entry he made with his Maps link, read as "auto-matched to a place he
// confirmed on an earlier day"). The people his words put there ride along.
//
// The 10-minute floor is for windows the resolver infers, not for one he named
// (2026-10-18: "I stopped for gas after the family visit, close to the supermarket", saved 19:55-20:03
// after he corrected "the gas stop is in the drive", and dropped for being 8
// minutes). It still applies to the part of a window that the day's edge cut off,
// which is the neighbouring day's stop, not this one.
//
// One longer stop at ANOTHER place that claims his window is cut around it, but
// only when the fixes of his window rest at the place he named (2026-10-18: "We
// (the three of us) had our morning coffee at the café, then took the dog for a long
// walk along the beach". Every fix from 09:00 to 09:50 sat within 4 m of Café
// the café, yet the flat's overnight row, which he had confirmed with "I was
// sleeping at the airbnb", ran on to 09:56 and swallowed the café 65 m away).
// Without those fixes the stop that claims the window keeps it.
// JORI_SAVED_AT_STOPS=0 turns it all off; JORI_SAVED_AT_CARVE=0 only the cut.
const SAVED_AT_ASK_PREFIX = "lc-at-";
const SAVED_AT_SAME_M = 60;
const SAVED_AT_CARVE_MIN_FIXES = 2;

// Do the fixes inside [from, to] put him at `c` rather than at the stop `t`?
// Most of at least SAVED_AT_CARVE_MIN_FIXES usable fixes, each within
// SAVED_AT_SAME_M of `c` and nearer `c` than `t`'s own point.
// ...and a silent window (2026-10-24): a still phone emits nothing, so the coffee
// he named for 07:56-08:47 on Oct 23 had no fix inside it, only two at 08:47, 36-46 m
// from the café as he left, and it could not be carved out of the night at the flat.
// With no usable fix inside, the first ones within SAVED_AT_EXIT_MS after it stand in.
const SAVED_AT_EXIT_MS = 5 * 60_000;
function fixesRestAtSavedPlace(pings, from, to, c, t) {
  if (t.lat == null || t.lon == null) return false;
  let fixes = usablePings(pings, from, to);
  if (!fixes.length) fixes = usablePings(pings, to, to + SAVED_AT_EXIT_MS).slice(0, SAVED_AT_CARVE_MIN_FIXES);
  if (fixes.length < SAVED_AT_CARVE_MIN_FIXES) return false;
  const there = fixes.filter(p => {
    const d = haversineMeters(p.lat, p.lon, c.lat, c.lon);
    return d <= SAVED_AT_SAME_M && d < haversineMeters(p.lat, p.lon, t.lat, t.lon);
  });
  return there.length * 2 > fixes.length;
}

// `t` without [from, to]: the piece before keeps its id, a piece under
// SHORT_STOP_MIN is a moment at the door and goes. Photos taken inside the window
// are returned for the stop he named; the rest stay on the nearest piece.
// A piece whose own fixes all sit away from the stop is not time spent there
// either: on 2026-10-18 the flat's row ran to 10:06 and its last ten minutes were
// the walk out (every fix 200-420 m off), so a "flat" stop at 09:56 would sit where
// the beach walk begins. A silent piece keeps its time (silence is stillness).
const SAVED_AT_PIECE_AWAY_M = 150;

function cutAroundSavedWindow(t, from, to, pings = null) {
  const pieces = [];
  for (const [ps, pe] of [[t.start_ts_ms, from], [to, t.end_ts_ms]]) {
    if ((pe - ps) / 60_000 < SHORT_STOP_MIN) continue;
    const own = usablePings(pings, ps, pe);
    if (own.length && own.every(p => haversineMeters(p.lat, p.lon, t.lat, t.lon) > SAVED_AT_PIECE_AWAY_M)) continue;
    pieces.push({ ...t, id: pieces.length ? `${t.id}-r${pieces.length}` : t.id,
                  start_ts_ms: ps, end_ts_ms: pe, start: hmFromMs(ps), end: hmFromMs(pe),
                  duration_min: Math.round((pe - ps) / 60000), photos: [], cut_for_saved_at: true });
  }
  // Each photo goes to whichever is nearest in time: his window or a piece.
  const inside = [];
  const gapTo = (ts, a, b) => (ts < a ? a - ts : ts > b ? ts - b : 0);
  for (const ph of t.photos || []) {
    const ts = Date.parse(ph.ts);
    const near = pieces.reduce((best, p) => {
      const gap = gapTo(ts, p.start_ts_ms, p.end_ts_ms);
      return gap < best.gap ? { p, gap } : best;
    }, { p: null, gap: gapTo(ts, from, to) });
    if (near.p) near.p.photos.push(ph); else inside.push(ph);
  }
  return { pieces, inside };
}

function addSavedAtStops(stops, entries, dayFromMs, dayToMs, pings = null) {
  if (process.env.JORI_SAVED_AT_STOPS === "0") return [];
  const added = [];
  for (const e of entries || []) {
    if (!e || !e.name || !String(e.ask_id || "").startsWith(SAVED_AT_ASK_PREFIX)) continue;
    const w = e.stop_window || {};
    const ws = Date.parse(w.start), we = Date.parse(w.end);
    const from = Math.max(ws, dayFromMs), to = Math.min(we, dayToMs);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from < 60_000) continue;
    if ((from > ws || to < we) && to - from < SHORT_STOP_MIN * 60_000) continue;
    const c = e.centroid || {};
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    const who = Array.isArray(e.companions) ? e.companions.filter(Boolean) : [];
    const touching = stops.filter(s => Math.min(s.end_ts_ms, to) > Math.max(s.start_ts_ms, from));
    let photos = [], cut = null;
    if (touching.length) {
      const same = touching.length === 1 && touching[0].lat != null
        && haversineMeters(touching[0].lat, touching[0].lon, c.lat, c.lon) <= SAVED_AT_SAME_M
        && (Math.min(touching[0].end_ts_ms, to) - Math.max(touching[0].start_ts_ms, from))
           >= 0.5 * (touching[0].end_ts_ms - touching[0].start_ts_ms);
      if (same) {
        const t = touching[0];
        t.place = { ...t.place, name: e.name, source: "user_confirmed", confidence: 1 };
        t.companions = [...new Set([...(t.companions || []), ...who])];
        added.push({ id: t.id, name: e.name, start: t.start, end: t.end, ask_id: e.ask_id, same_visit: true });
        continue;
      }
      const t = touching[0];
      const carvable = touching.length === 1 && process.env.JORI_SAVED_AT_CARVE !== "0"
        && !t.excursion && !t.is_movement && !t.user_non_stop
        && fixesRestAtSavedPlace(pings, from, to, c, t);
      if (!carvable) continue;
      const res = cutAroundSavedWindow(t, from, to, pings);
      stops.splice(stops.indexOf(t), 1, ...res.pieces);
      photos = res.inside;
      cut = { id: t.id, name: t.place && t.place.name, was: `${t.start}–${t.end}`,
              now: res.pieces.map(p => `${p.start}–${p.end}`).join(", ") };
    }
    const ns = {
      id: `s-${dateKeyOf(from)}-a${added.filter(x => !x.same_visit).length + 1}`,
      start: hmFromMs(from), end: hmFromMs(to),
      start_ts_ms: from, end_ts_ms: to,
      duration_min: Math.round((to - from) / 60000),
      lat: c.lat, lon: c.lon,
      place: { name: e.name, source: "user_confirmed", confidence: 1, address: e.address || null },
      companions: [...who], photos, alternatives: [], pattern: "dwell",
      calendar_event: null, from_confirmed_visit: true, from_saved_at: e.ask_id,
    };
    stops.push(ns);
    added.push({ id: ns.id, name: e.name, start: ns.start, end: ns.end, ask_id: e.ask_id,
                 ...(cut ? { cut_from: cut } : {}) });
  }
  if (added.length) stops.sort((x, y) => x.start_ts_ms - y.start_ts_ms);
  return added;
}

// ---------------------------------------------------------------------------
// Stops from the spine
// ---------------------------------------------------------------------------
//
// `day-path` reconciles every visit row against the fixes and finds dwells the
// visit table never wrote (stay points), so its dwell sequence is the day's
// frame. The stop set above is cut from the same rows by a different route
// and can lose a dwell into a gap: on 2026-09-06 the 10:07–13:18 stint at home
// between the morning walk and the matinee vanished, and the summary printed
// "4h 30m (2.4 km) to next" for a 29-minute walk up 8th Avenue. A major dwell
// (>=10 min or one he confirmed) that no stop covers by half becomes a stop,
// clipped to the window the existing stops leave free. It borrows the place
// object of a same-named stop on the day (so Home stays `known_recurring`
// and renders as home), else carries `spine_dwell` with the tier's confidence.
const SPINE_COVER_MIN = 0.5;
const SPINE_TIER_CONF = { "user-confirmed": 1, corroborated: 0.85, recorded: 0.7, "stay-point": 0.5, unwitnessed: 0.4 };

// An unnamed stop that is the only stop at a dwell takes the dwell's name, but
// only a name the spine itself stands behind (his answer, or an address/saved-
// place match), and only when exactly one stop is bare there.
function nameBareStopFromDwell(stops, n) {
  const name = n.place && n.place.name;
  const tier = n.place && n.place.tier;
  if (!name || (tier !== "user-confirmed" && tier !== "corroborated")) return null;
  const bare = stops.filter(s => !s.user_non_stop && !s.is_movement && s.lat != null && s.lon != null
    && !(s.place && s.place.name)
    && s.end_ts_ms > n.start_ms && s.start_ts_ms < n.end_ms
    && haversineMeters(s.lat, s.lon, n.place.lat, n.place.lon) <= SPINE_SAME_PLACE_M);
  if (bare.length !== 1) return null;
  const s = bare[0];
  s.place = { ...(s.place || {}), name, source: "spine_dwell", confidence: SPINE_TIER_CONF[tier] ?? 0.5 };
  s.spine_tier = tier;
  s.named_by_spine = n.id;
  s.unnamed = false;
  return s;
}

// A window dropUnrestedStops already found he was only passing through is not
// handed back as a stop by its dwell (2026-10-21). 14:29-14:44 on the walk
// home from הקוסם: seven precise fixes strolling about 370 m through the market, no
// rest, so the stop was dropped; the spine still had a dwell there (a day-segments row
// named for a stall he confirmed on Oct 4, every fix within its 150 m), and this pass
// rebuilt it as "a coffee stand", a stop between the lunch and the walk he
// described as "we simply walked back to the apartment stopping for a few minutes at
// different places along the way". the user, 2026-09-01: "it shouldn't be an unlabeled
// stop even if it's a favorited place". A dwell he answered for is still a stop.
// JORI_SPINE_NO_REST=0 disables.
function passedThrough(n, noRest) {
  if (process.env.JORI_SPINE_NO_REST === "0" || (n.place && n.place.tier) === "user-confirmed") return null;
  const span = n.end_ms - n.start_ms;
  return (noRest || []).find(r => !r.kept_as_unknown && r.start_ts_ms != null && r.end_ts_ms != null
    && Math.min(n.end_ms, r.end_ts_ms) - Math.max(n.start_ms, r.start_ts_ms) >= SPINE_COVER_MIN * span) || null;
}

function addSpineDwells(stops, dayPath, asleep = null, held = [], noRest = []) {
  const spine = (dayPath && dayPath.spine) || [];
  const added = [];
  for (const n of spine) {
    if (n.type !== "dwell" || !n.major || !n.start_ms || !n.end_ms) continue;
    const span = n.end_ms - n.start_ms;
    if (span <= 0) continue;
    let covered = 0;
    for (const s of stops) {
      const ov = Math.min(n.end_ms, s.end_ts_ms) - Math.max(n.start_ms, s.start_ts_ms);
      if (ov > 0) covered += ov;
    }
    if (covered / span >= SPINE_COVER_MIN) {
      // Already covered, but by a stop with no name at all: the dwell's name is
      // the only one this window has. Same rule as the widening branch below
      // (an unnamed touching stop takes the spine's name), for a stop that needs
      // no widening. 2026-10-15: cut at local midnight, Oct 11's evening at the
      // flat was one raw stop covering the whole dwell, its café guess stripped,
      // and the spine's "The Rented Flat" (address match) was never used.
      const named = nameBareStopFromDwell(stops, n);
      if (named) {
        added.push({ id: named.id, spine_id: n.id, name: named.place.name, start: named.start, end: named.end,
                     tier: n.place.tier, named_only: true });
      }
      continue;
    }
    const passing = passedThrough(n, noRest);
    if (passing) { passing.spine_dwell_not_restored = n.id; continue; }
    // A same-place stop already touching the dwell (a clipped ghost remnant,
    // a cluster that caught the tail of it) is widened to the dwell rather than
    // given a neighbour: two stops at one place two minutes apart is the
    // fragmentation this pass exists to remove, not add.
    const touching = stops.find(s => s.end_ts_ms > n.start_ms && s.start_ts_ms < n.end_ms
      && s.lat != null && haversineMeters(s.lat, s.lon, n.place.lat, n.place.lon) <= SPINE_SAME_PLACE_M);
    if (touching) {
      const others = stops.filter(s => s !== touching);
      let ws = n.start_ms, we = n.end_ms;
      for (const s of others) { if (s.start_ts_ms < ws && s.end_ts_ms > ws) ws = s.end_ts_ms; }
      for (const s of others) { if (s.start_ts_ms > ws && s.start_ts_ms < we) we = s.start_ts_ms; }
      ws = Math.min(ws, touching.start_ts_ms); we = Math.max(we, touching.end_ts_ms);
      // The dwell's start can be the overnight visit's, clipped to the day
      // window: a venue stop is not stretched back through his sleep to it.
      if (widensThroughSleep(touching, ws, asleep)) {
        held.push({ id: touching.id, name: (touching.place && touching.place.name) || null,
                    source: (touching.place && touching.place.source) || null, kept_start: touching.start,
                    visit_started: hmFromMs(ws), woke: hmFromMs(asleep.to_ms), by: "spine" });
        ws = touching.start_ts_ms;
      }
      if (we > ws) {
        const was = `${touching.start}–${touching.end}`;
        touching.start_ts_ms = ws; touching.end_ts_ms = we;
        touching.start = hmFromMs(ws); touching.end = hmFromMs(we);
        touching.duration_min = Math.round((we - ws) / 60000);
        touching.widened_by_spine = n.id;
        if (!(touching.place && touching.place.name) && n.place.name) {
          touching.place = { ...(touching.place || {}), name: n.place.name, source: "spine_dwell",
                             confidence: SPINE_TIER_CONF[(n.place && n.place.tier) || "recorded"] ?? 0.5 };
          touching.spine_tier = n.place && n.place.tier;
        }
        added.push({ id: touching.id, spine_id: n.id, name: touching.place && touching.place.name,
                     start: touching.start, end: touching.end, widened_from: was, tier: n.place && n.place.tier });
      }
      continue;
    }
    // the free window: push the start past any stop it begins inside, pull the
    // end before any stop it runs into
    let start = n.start_ms, end = n.end_ms;
    for (const s of stops) {
      if (s.start_ts_ms <= start && s.end_ts_ms > start) start = s.end_ts_ms;
    }
    for (const s of stops) {
      if (s.start_ts_ms > start && s.start_ts_ms < end) end = s.start_ts_ms;
    }
    if (end - start < 5 * 60_000) continue;
    const name = n.place && n.place.name;
    const twin = name && stops.find(s => s.place && s.place.name
      && nameSimilarity(s.place.name, name) >= 0.8 && !s.user_non_stop);
    const place = twin
      ? { ...twin.place }
      : { name: name || null, source: "spine_dwell", address: null,
          confidence: SPINE_TIER_CONF[(n.place && n.place.tier) || "recorded"] ?? 0.5 };
    const ns = {
      id: `s-${dateKeyOf(start)}-p${added.length + 1}`,
      start: hmFromMs(start), end: hmFromMs(end),
      start_ts_ms: start, end_ts_ms: end,
      duration_min: Math.round((end - start) / 60000),
      lat: n.place.lat, lon: n.place.lon,
      place,
      companions: [], photos: [], alternatives: [], pattern: "dwell",
      calendar_event: null, from_spine: true, spine_id: n.id,
      spine_tier: n.place && n.place.tier, witnessed_min: n.witnessed_min,
    };
    stops.push(ns);
    const entry = { id: ns.id, spine_id: n.id, name: place.name, start: ns.start, end: ns.end,
                    tier: ns.spine_tier, borrowed_place_from: twin ? twin.id : null };
    // A borrow is a MOVE when the twin's own answer is about THIS window.
    // 2026-10-05: "the café — coffee this morning" was confirmed on the
    // 09:04–09:24 row; a cluster that ran 08:14–09:24 carried it, the spine
    // clipped that cluster to its 08:14 tail and rebuilt 09:04–09:24 here —
    // and the name was copied, so the email listed the café twice. When the
    // confirmed row overlaps the new stop and not what is left of the twin,
    // the name leaves the twin; a sliver too short to be a stop goes with it.
    const row = twin && twin.confirmed_row;
    if (row && row.start_ms && row.end_ms) {
      const ov = (a0, a1) => Math.max(0, Math.min(a1, row.end_ms) - Math.max(a0, row.start_ms));
      if (ov(start, end) > 0 && ov(twin.start_ts_ms, twin.end_ts_ms) === 0) {
        // What is left was only ever there because the answer was; without it
        // a short photo-less remnant is not a stop worth an "unlabeled" line.
        if (twin.end_ts_ms - twin.start_ts_ms < MOVED_REMNANT_KEEP_MS && !(twin.photos || []).length) {
          stops.splice(stops.indexOf(twin), 1);
          entry.moved_from = { id: twin.id, dropped: true };
        } else {
          twin.place = { name: null, address: null, source: "unknown", confidence: 0, distance_m: null };
          twin.confirmed_row = null;
          twin.unnamed = true;
          entry.moved_from = { id: twin.id, dropped: false };
        }
        ns.confirmed_row = row;
      }
    }
    added.push(entry);
  }
  if (added.length) stops.sort((a, b) => a.start_ts_ms - b.start_ts_ms);
  return added;
}

// A stop the spine built still goes through the naming ladder.
//
// 2026-10-14: a 71-minute stop at a family home came back as "12 Example
// Alley", though the home's address was known and should have been identified
// automatically. The house was in the wiki and the user had named it on 10-03,
// but the stop reached the day here: addSpineDwells copies
// the spine's own label (the visit row's reverse-geocoded street address) and
// no rung was ever asked. So a stop it added, or widened and named, is named
// from its own point by the same ladder location-segment uses, in the same
// order: a named location (his homes and family homes), then a place he
// confirmed (30 m), then a known-recurring entry. A stop whose name is already
// settled (RESOLVER_SETTLED: his answer, a lodging, a sign he photographed) or
// that he said was not a stop is left alone. So is a spine name from a dwell
// whose tier is `user-confirmed`: it arrives as `spine_dwell` but it is his
// answer, and his answer outranks a named location (110 over 100 in
// classifyStops) — "Notary" at a family home stays "Notary". Local files
// only, no geocoder.
function nameSpineDwells(stops, ctx) {
  const named = [];
  for (const s of stops) {
    const fromSpine = s.from_spine
      || ((s.widened_by_spine || s.named_by_spine) && s.place && s.place.source === "spine_dwell");
    if (!fromSpine || s.user_non_stop || s.lat == null || s.lon == null) continue;
    const src = (s.place && s.place.source) || "unknown";
    if (RESOLVER_SETTLED.has(src) || src === "calendar_corroborated") continue;
    if (src === "spine_dwell" && s.spine_tier === "user-confirmed") continue;
    let place = null;
    const home = matchNamedLocation(ctx.namedLocations, s.lat, s.lon);
    if (home) {
      place = { name: home.entry.name, address: home.entry.address || null, source: "named_location",
                confidence: 0.95, distance_m: Math.round(home.distance_m) };
    }
    if (!place) {
      const conf = matchConfirmedRest(ctx.confirmedStopsEntries, s.lat, s.lon);
      if (conf) {
        place = { name: conf.entry.name, address: conf.entry.address || null, source: "confirmed_stop",
                  confidence: 0.95, distance_m: Math.round(conf.distance_m) };
      }
    }
    if (!place) {
      const m = matchStop(ctx.knownStopsEntries || [], {
        date: ctx.date, stopStartHM: s.start, stopEndHM: s.end, lat: s.lat, lon: s.lon,
      });
      if (m) {
        place = { name: m.entry.name, address: m.entry.address || null, source: "known_recurring",
                  confidence: 0.95, distance_m: m.distance_m != null ? Math.round(m.distance_m) : null };
      }
    }
    if (!place) continue;
    named.push({ id: s.id, name: place.name, source: place.source,
                 was: (s.place && s.place.name) || null, was_source: src });
    s.place = place;
    s.unnamed = false;
  }
  return named;
}

// A stop whose only name is a geocoder's street address can still be one of his
// homes by that address (2026-10-14). A street can be written in Hebrew or in an
// English transliteration or translation, so address matching must be
// transliteration/translation-aware, nearby house numbers on the same street
// count as the same home, and a model makes the name match. nameSpineDwells
// matches a home by its recorded spot (150 m); this pass covers the rest: a
// centroid further off the door, and a home known only by its address. Code
// picks the homes a stop could be (addressCandidates, no network); the model in
// lib/address-match.mjs reads the addresses, once per question. Only a
// stop still carrying a guess is considered (GUESS_SOURCES, or a spine label
// that isn't his answer), so his words, a lodging, a sign he photographed or a
// confirmed place are never renamed. At most ADDRESS_ASKS_PER_RUN fresh model
// calls a resolve; remembered answers are free.
const ADDRESS_ASKS_PER_RUN = 6;

async function nameStopsByAddress(stops, { homes = loadAddressHomes(), match = null, tzFor = timezoneForCoords } = {}) {
  const named = [];
  if (!homes.length) return named;
  let asks = 0;
  for (const s of stops) {
    if (s.is_movement || s.user_non_stop || s.lat == null || s.lon == null) continue;
    const src = (s.place && s.place.source) || "unknown";
    if (!GUESS_SOURCES.has(src) && src !== "spine_dwell") continue;
    if (src === "spine_dwell" && s.spine_tier === "user-confirmed") continue;
    const tz = tzFor(s.lat, s.lon);
    if (!addressCandidates(homes, s.lat, s.lon, tz).length) continue;
    const labels = [s.place && s.place.name, s.guessed_name, s.place && s.place.address].filter(Boolean);
    const allowAsk = asks < ADDRESS_ASKS_PER_RUN;
    let hit = null;
    try {
      const run = match || (await import("./address-match.mjs")).matchHomeByAddress;
      hit = await run({ lat: s.lat, lon: s.lon, labels }, { entries: homes, tz, allowAsk, onAsk: () => { asks += 1; } });
    } catch (_) { hit = null; }
    if (!hit) continue;
    named.push({ id: s.id, name: hit.entry.name, was: (s.place && s.place.name) || s.guessed_name || null,
                 was_source: src, by: hit.stop_addresses || labels });
    s.place = { name: hit.entry.name, address: hit.entry.address || null, source: "named_location",
                confidence: 0.9, distance_m: hit.distance_m == null ? null : Math.round(hit.distance_m),
                matched_by: "address" };
    s.unnamed = false;
  }
  return named;
}

// dropShortStops (way earlier in the pipeline, before a spine dwell exists to
// receive them) ships a dropped stop's photos to whichever SURVIVING stop is
// nearest in TIME, with no distance check — "photos are never lost" was
// written assuming the nearest-in-time stop is a reasonable narrative home
// ("shots taken on the way somewhere"). That assumption breaks when the real
// place the photo belongs to shows up here, minutes later in the pipeline, as
// a spine dwell: the photo already travelled to whatever was chronologically
// closest at drop-time, which can be a stop kilometres away. Confirmed
// 2026-09-13: a photo taken 67s before the "E 27th St" spine dwell's own end
// landed on the evening "Home" stop instead — 2.4km and 25 minutes away,
// because dropShortStops ran before this dwell existed as a candidate and
// Home was simply the nearest thing in time.
//
// Runs once, right after addSpineDwells, against every OTHER stop's photos:
// a photo moves here only if it fits this stop's own window (+/-5min, same
// buffer as attachPhotosToStop) AND is within range of it. Range is
// CONFIRMED_MATCH_M (250m), not attachPhotosToStop's tighter 200m: that 200m
// was calibrated for a multi-fix GPS cluster's averaged centroid, but a spine
// dwell's lat/lon here is typically a single CLVisit fix (E 27th St's was
// exactly its location_history row's own point, 224m from the photo that
// belongs to it) — CONFIRMED_MATCH_M is this file's existing tolerance for
// that same comparison (a confirmed/spine visit's coordinate vs. an
// independently-derived point), used a few dozen lines up by
// overlayConfirmedVisits for the identical reason. Either gate alone still
// keeps a correctly-placed photo from qualifying for an unrelated dwell by
// coincidence.
const RECLAIM_WINDOW_BUFFER_MS = 5 * 60 * 1000;
const RECLAIM_RADIUS_M = CONFIRMED_MATCH_M;

// Stops built empty of photos late in the pipeline: by the spine, or from his answer.
function reclaimTargetIds(stops, stopsFromSpine) {
  return new Set([...(stopsFromSpine || []).map(x => x.id), ...stops.filter(s => s.from_confirmed_visit).map(s => s.id)]);
}

function reclaimMisplacedPhotos(stops, addedIds, photoRows) {
  if (!addedIds || !addedIds.size) return [];
  const byUuid = new Map((photoRows || []).map(p => [p.uuid, p]));
  const targets = stops.filter(s => addedIds.has(s.id));
  if (!targets.length) return [];
  const reclaimed = [];
  // near the stop's pin, or any piece a merge joined into it (mergeDuplicateStops)
  const near = (a, lat, lon) => [a, ...(a.piece_points || [])]
    .some(q => q.lat != null && q.lon != null && haversineMeters(q.lat, q.lon, lat, lon) <= RECLAIM_RADIUS_M);
  const homeFor = (t, lat, lon) => (Number.isFinite(t) && lat != null && lon != null
    ? targets.find(a => t >= a.start_ts_ms - RECLAIM_WINDOW_BUFFER_MS
                      && t <= a.end_ts_ms + RECLAIM_WINDOW_BUFFER_MS
                      && near(a, lat, lon))
    : null);
  for (const s of stops) {
    if (addedIds.has(s.id) || !(s.photos || []).length) continue;
    const keep = [];
    for (const p of s.photos) {
      const row = byUuid.get(p.uuid);
      const home = homeFor(Date.parse(row ? row.taken_at : p.ts), row ? row.latitude : p.lat, row ? row.longitude : p.lon);
      if (home) {
        home.photos = [...(home.photos || []), p];
        reclaimed.push({ uuid: p.uuid, from: s.id, to: home.id });
      } else {
        keep.push(p);
      }
    }
    s.photos = keep;
  }
  // A photo on no stop at all goes to the late stop it fits, by the same window
  // and radius: it fell in the travel around a stop that only existed once his
  // answer built it. 2026-10-16: IMG_7728 at 18:04, 90 m from August (built from
  // his answer, 17:57-19:26), sat on no stop and never reached the email. Only his
  // own photos: a received one carries the sender's GPS.
  const onStop = new Set(stops.flatMap(s => (s.photos || []).map(p => p.uuid)));
  for (const row of photoRows || []) {
    if (!row || !row.uuid || onStop.has(row.uuid) || row.self_captured === false) continue;
    const home = homeFor(Date.parse(row.taken_at), row.latitude, row.longitude);
    if (!home) continue;
    home.photos = [...(home.photos || []), { uuid: row.uuid, ts: row.taken_at, filename: row.original_filename || null }];
    onStop.add(row.uuid);
    reclaimed.push({ uuid: row.uuid, from: null, to: home.id });
  }
  return reclaimed;
}

// A stop is a claim about time at a place; the spine's dwells are what the
// fixes support for that place. Clip the claim to the dwells within
// SPINE_SAME_PLACE_M of the stop; drop a stop with no such dwell when the
// spine positively places him elsewhere for most of its window; leave alone
// a stop the trace has nothing to say about (phone dead, calendar-only).
const SPINE_SAME_PLACE_M = 150;
const SPINE_CLIP_MIN_MS = 5 * 60_000;
const MOVED_REMNANT_KEEP_MS = 15 * 60_000;

function applySpineVerdicts(stops, dayPath) {
  const dwells = ((dayPath && dayPath.spine) || [])
    .filter(n => n.type === "dwell" && n.start_ms && n.end_ms && n.place && n.place.lat != null);
  const clipped = [], dropped = [];
  if (!dwells.length) return { stops, clipped, dropped };
  const out = [];
  for (const s of stops) {
    if (s.lat == null || s.lon == null) { out.push(s); continue; }
    // A stop dropUnrestedStops kept unnamed (s.unrested) already IS the case
    // this function's own doc comment describes as "a big-box store or a
    // beach — walked around the whole time you're there" (see MOVING_KMH):
    // the fixes can't prove he stood still because he was moving around
    // inside one place, not passing through it. Clipping it to whatever
    // sliver the spine's dwell-detector also managed to pin down would
    // reproduce the same mistake pace-based demotion was fixed to avoid
    // (2026-09-14: a 38-minute hospital visit clipped to 1 minute).
    if (s.unrested) { out.push(s); continue; }
    const overlapping = dwells.filter(d => d.end_ms > s.start_ts_ms && d.start_ms < s.end_ts_ms);
    // Same NAME within the fuzzy radius is the same place too (2026-10-12):
    // twin rows of one meal sit 175 m apart, day-path keeps the longer row's
    // coordinates, and the stop built from the other one was dropped as
    // "elsewhere: אישטבח" — elsewhere being itself.
    const stopName = s.place && s.place.name;
    const same = overlapping.filter(d => {
      const m = haversineMeters(s.lat, s.lon, d.place.lat, d.place.lon);
      return m <= SPINE_SAME_PLACE_M
        || (m <= DUP_MERGE_M_FUZZY && stopName && d.place.name && nameSimilarity(stopName, d.place.name) >= 0.9);
    });
    if (!same.length) {
      const span = Math.max(1, s.end_ts_ms - s.start_ts_ms);
      let elsewhere = 0;
      for (const d of overlapping) elsewhere += Math.min(d.end_ms, s.end_ts_ms) - Math.max(d.start_ms, s.start_ts_ms);
      if (elsewhere / span >= 0.5 && !s.user_non_stop) {
        dropped.push({ id: s.id, name: s.place && s.place.name, start: s.start, end: s.end,
                       elsewhere: overlapping.map(d => d.place.name || "unlabelled") });
        continue;
      }
      out.push(s);
      continue;
    }
    // A stay elsewhere BETWEEN two of this place's dwells is a departure, not a
    // detail of the stay (2026-10-16: the flat 20:13-20:18, dinner at the restaurant
    // 20:38-21:42 250 m away, the flat again from 21:44; the stop ran 20:12 to
    // midnight because only its outer edges were clipped). Cut it there. A
    // window he answered for is his and stays whole (day-path never cuts one).
    const answered = s.place && s.place.source === "user_confirmed"
      && !(s.confirmed_row && s.confirmed_row.place_type === "named");
    if (process.env.JORI_SPINE_CARVE !== "0" && !answered && !s.user_non_stop) {
      const pieces = carveAroundElsewhere(s, overlapping);
      if (pieces) {
        clipped.push({ id: s.id, name: s.place && s.place.name, was: `${s.start}–${s.end}`,
                       now: pieces.map(p => `${p.start}–${p.end}`).join(", "),
                       carved_around: pieces.carved, dwells: same.map(d => d.id) });
        out.push(...pieces);
        continue;
      }
    }
    const lo = Math.min(...same.map(d => d.start_ms)), hi = Math.max(...same.map(d => d.end_ms));
    const ns = Math.max(s.start_ts_ms, lo), ne = Math.min(s.end_ts_ms, hi);
    const trimmed = (ns - s.start_ts_ms) + (s.end_ts_ms - ne);
    if (trimmed >= SPINE_CLIP_MIN_MS && ne > ns) {
      clipped.push({ id: s.id, name: s.place && s.place.name, was: `${s.start}–${s.end}`,
                     now: `${hmFromMs(ns)}–${hmFromMs(ne)}`, trimmed_min: Math.round(trimmed / 60000),
                     dwells: same.map(d => d.id) });
      s.start_ts_ms = ns; s.end_ts_ms = ne;
      s.start = hmFromMs(ns); s.end = hmFromMs(ne);
      s.duration_min = Math.round((ne - ns) / 60000);
      s.clipped_by_spine = true;
    }
    out.push(s);
  }
  return { stops: out, clipped, dropped };
}

// The pieces of `s` either side of each major dwell at ANOTHER place that sits
// between two of its own dwells, or null when there is none. "Its own" are the
// dwells carrying its name; "another place" is day-path's verdict (place_id), not
// a distance from the stop's centroid: a cluster that swallowed the dinner has its
// centroid halfway to the restaurant (2026-10-16: 120 m from it, 150 m from the
// flat). Each piece is held to its own dwells, the first keeps the id, a piece
// under SHORT_STOP_MIN is a moment at the door and is dropped, and every photo
// stays on the piece nearest in time (the stop elsewhere is added later by
// addSpineDwells, and reclaimMisplacedPhotos moves its photos there).
function carveAroundElsewhere(s, overlapping) {
  const name = s.place && s.place.name;
  if (!name) return null;
  const isOwn = (d) => d.place.name && nameSimilarity(d.place.name, name) >= 0.9;
  const own = overlapping.filter(isOwn).sort((a, b) => a.start_ms - b.start_ms);
  const ownPlaces = new Set(own.map(d => d.place.place_id));
  if (!own.length || ownPlaces.has(undefined) || ownPlaces.has(null)) return null;
  const inner = overlapping.filter(d => d.major && !isOwn(d)
    && d.place.place_id != null && !ownPlaces.has(d.place.place_id)
    && own.some(o => o.end_ms <= d.start_ms + 60_000) && own.some(o => o.start_ms >= d.end_ms - 60_000))
    .sort((a, b) => a.start_ms - b.start_ms);
  if (!inner.length) return null;
  const groups = [[]];
  for (const o of own) {
    if (inner.some(d => d.start_ms >= (groups.at(-1).at(-1) || o).end_ms - 60_000 && d.end_ms <= o.start_ms + 60_000)
        && groups.at(-1).length) groups.push([]);
    groups.at(-1).push(o);
  }
  if (groups.length < 2) return null;
  const pieces = [];
  for (const g of groups) {
    const ps = Math.max(s.start_ts_ms, g[0].start_ms), pe = Math.min(s.end_ts_ms, g.at(-1).end_ms);
    if ((pe - ps) / 60_000 < SHORT_STOP_MIN) continue;
    pieces.push({ ...s, id: pieces.length ? `${s.id}-r${pieces.length}` : s.id,
                  start_ts_ms: ps, end_ts_ms: pe, start: hmFromMs(ps), end: hmFromMs(pe),
                  duration_min: Math.round((pe - ps) / 60000), clipped_by_spine: true, photos: [] });
  }
  if (!pieces.length) return null;
  // Every photo stays on a piece, the nearest in time, so none is lost: one
  // taken during the stay elsewhere is moved to that stop by reclaimMisplacedPhotos
  // once addSpineDwells has built it (it only moves photos some stop holds).
  for (const ph of s.photos || []) {
    const t = Date.parse(ph.ts);
    const near = pieces.reduce((b, p) => {
      const gap = t < p.start_ts_ms ? p.start_ts_ms - t : t > p.end_ts_ms ? t - p.end_ts_ms : 0;
      return !b || gap < b.gap ? { p, gap } : b;
    }, null);
    near.p.photos.push(ph);
  }
  pieces.carved = inner.map(d => ({ dwell: d.id, start: d.start, end: d.end }));
  return pieces;
}

function dateKeyOf(ms) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

// The deterministic stop test (2026-07-30): "if the average speed
// between points is walking speed - it means there were no other stops."
// Measured on 2026-07-29 with per-leg routed distance: real dwells run
// 0.00-1.31 km/h (apartment 0.08 over 400 min, a bouillon 0.74, cocktails 0.91)
// while every invented venue runs 2.40-4.36 km/h. 1.8 km/h sits in the gap.
// Applied ONLY to resolver guesses -- it can never demote something he named.
const MOVING_KMH = 1.8;

// ...but pace alone was the wrong discriminator, and it took until 2026-08-16 to
// see why (the user: "the last activity/drive never registered... even though
// they're clearly visible on the map"). Every dwell in the calibration set above
// is a place where you SIT -- a flat, a bouillon, a cocktail bar. Two
// evenings were deleted by the same rule:
//
//   Fri 2026-08-14  14075 Main St       23 min  3.09 km/h  -> demoted
//   Sat 2026-08-15  9501 Oak Ave          18 min  3.39 km/h  -> demoted
//
// A big-box store and a beach are places you walk around for the whole visit, so
// 1.8 km/h had stopped separating "real place" from "invented place" and started
// separating "sat down" from "walked around". The proof is on that same Friday:
// A supermarket logged 3.23 km/h -- FASTER than the demoted stop -- and survived only
// because he had confirmed it by hand. The filter had narrowed to removing
// exactly the stops he had not already told us about, which is the whole point
// of the summary.
//
// Distance cannot fix this; the two cases cover the same metres at the same
// pace. Direction can. A pass-through ENDS SOMEWHERE ELSE; browsing a store or
// walking a beach returns you to the door you came in by. So a walking-pace
// window is only movement if the walking actually took him somewhere.
const RETURN_DISPLACEMENT_M = 150;   // ended where he started: never movement
const RETURN_RATIO = 0.35;           // net displacement under a third of the
                                     // routed distance: he doubled back, i.e.
                                     // he was inside a place, not crossing one

// The second thing a pass-through cannot look like: walking pace sandwiched
// between two drives. You do not arrive somewhere at 60 km/h, cover a kilometre
// at 3 km/h, and leave at 60 km/h without having got out of the car.
// Gridlock is the trap here -- a 3 km/h crawl is also bracketed by driving -- so
// the window itself must contain no leg faster than a person can run.
const VEHICLE_KMH = 25;              // no one walks or cycles a leg this fast
const ON_FOOT_MAX_KMH = 12;          // a leg above this had an engine under it
const BRACKET_LOOK_MIN = 45;         // how far either side to look for the drive
const BRACKET_MIN_MIN = 8;           // too short to have been anywhere

// What the user SAID is read by a model, never by a pattern (2026-07-30:
// "NEVER use regex. always use a model for language based answers"). This file
// stays deterministic -- it must run from cron, where a `claude -p` fork cannot
// authenticate -- so `bin/day-statements` does the reading in its own step
// and leaves its result here. If that file is absent we simply have no
// interpretation for the day; we do NOT fall back to matching strings.
function readDayStatements(dateStr) {
  const f = `/tmp/day-statements-${dateStr}.json`;
  try {
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    process.stderr.write(`[resolve-day] day-statements unreadable (${e.message})\n`);
    return null;
  }
}

function routedMetersIn(dayPath, fromMs, toMs) {
  let m = 0;
  for (const seg of (dayPath && dayPath.segments) || []) {
    for (const leg of seg.legs || []) {
      const span = leg.t1 - leg.t0;
      if (span <= 0) continue;
      const ov = Math.min(toMs, leg.t1) - Math.max(fromMs, leg.t0);
      if (ov > 0) m += leg.m * (ov / span);
    }
  }
  return m;
}

// Every routed leg overlapping a window, in time order. Legs written before
// 2026-08-16 carry no endpoints; those windows simply have no direction and the
// guards below abstain rather than guess.
function legsIn(dayPath, fromMs, toMs) {
  const out = [];
  for (const seg of (dayPath && dayPath.segments) || []) {
    for (const leg of seg.legs || []) {
      if (leg.t1 <= fromMs || leg.t0 >= toMs) continue;
      if (leg.lat0 == null || leg.lat1 == null) continue;
      out.push(leg);
    }
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

function legKmh(leg) {
  const h = (leg.t1 - leg.t0) / 3600_000;
  return h > 0 ? (leg.m / 1000) / h : 0;
}

// Deferred uploads put fixes seconds apart that belong minutes apart, so the
// short legs carry impossible speeds -- 2026-08-15 alone has a 3-second 195 m
// leg (234 km/h) and a zero-duration 510 m one. Any judgement about how FAST he
// was moving reads only legs long enough to mean something; the endpoints of
// short legs are still fine for judging WHERE he was.
const MIN_SPEED_LEG_MS = 60_000;
const MAX_GROUND_KMH = 130;          // nothing he travels in goes faster

function fastestKmh(legs) {
  const usable = legs.filter(l => (l.t1 - l.t0) >= MIN_SPEED_LEG_MS);
  if (!usable.length) return null;
  return Math.min(MAX_GROUND_KMH, Math.max(...usable.map(legKmh)));
}

// How far the window MOVED HIM, as opposed to how far he walked. Null when the
// path has no endpoints to measure between.
function netDisplacementM(dayPath, fromMs, toMs) {
  const legs = legsIn(dayPath, fromMs, toMs);
  if (legs.length < 1) return null;
  const a = legs[0], b = legs[legs.length - 1];
  return haversineMeters(a.lat0, a.lon0, b.lat1, b.lon1);
}

// Did he arrive by vehicle and leave by vehicle, with only on-foot legs in
// between? That is a destination, whatever the average pace inside it says.
function vehicleBracketed(dayPath, fromMs, toMs) {
  const insideFastest = fastestKmh(legsIn(dayPath, fromMs, toMs));
  if (insideFastest == null) return false;
  if (insideFastest > ON_FOOT_MAX_KMH) return false;                 // gridlock, not a stop
  const look = BRACKET_LOOK_MIN * 60_000;
  const fast = (from, to) => (fastestKmh(legsIn(dayPath, from, to)) || 0) >= VEHICLE_KMH;
  return fast(fromMs - look, fromMs) && fast(toMs, toMs + look);
}

function markMovementByPace(stops, dayPath) {
  const demoted = [];
  const kept = [];
  for (const s of stops) {
    const src = (s.place && s.place.source) || "";
    const confirmed = src === "user_confirmed" || src === "accommodation"
      || src === "named_location" || src === "known_recurring" || src === "confirmed_stop";
    const mins = (s.end_ts_ms - s.start_ts_ms) / 60000;
    if (mins <= 0) continue;
    const routedM = routedMetersIn(dayPath, s.start_ts_ms, s.end_ts_ms);
    const kmh = (routedM / 1000) / (mins / 60);
    s.pace_kmh = Math.round(kmh * 100) / 100;
    // A stop dropUnrestedStops chose to KEEP unnamed (s.unrested) survived on
    // exactly the finding that the trace can't tell standing from moving here —
    // demoting it to movement on the strength of that same ambiguous trace
    // would erase the very thing UNRESTED_KEEP_MIN exists to protect.
    if (confirmed || s.user_non_stop || s.unrested) continue;
    if (kmh < MOVING_KMH) continue;

    // Walking pace on its own is no longer enough to delete a stop.
    const netM = netDisplacementM(dayPath, s.start_ts_ms, s.end_ts_ms);
    s.net_displacement_m = netM == null ? null : Math.round(netM);
    let spared = null;
    if (netM != null && netM <= RETURN_DISPLACEMENT_M) {
      spared = `returned to within ${Math.round(netM)}m of where the window started`;
    } else if (netM != null && routedM > 0 && netM / routedM <= RETURN_RATIO) {
      spared = `walked ${Math.round(routedM)}m to end up ${Math.round(netM)}m away — doubling back inside a place, not crossing one`;
    } else if (mins >= BRACKET_MIN_MIN && vehicleBracketed(dayPath, s.start_ts_ms, s.end_ts_ms)) {
      spared = "arrived by vehicle and left by vehicle, on foot in between";
    }
    if (spared) {
      s.movement_spared_reason = spared;
      kept.push({ name: s.place.name, kmh: s.pace_kmh, min: Math.round(mins),
                  net_m: s.net_displacement_m, routed_m: Math.round(routedM), reason: spared });
      continue;
    }
    s.is_movement = true;
    demoted.push({ name: s.place.name, kmh: s.pace_kmh, min: Math.round(mins),
                   net_m: s.net_displacement_m, routed_m: Math.round(routedM) });
  }
  return { demoted, kept };
}

// ---------------------------------------------------------------------------
// Closing the review loop mechanically
// ---------------------------------------------------------------------------
//
// `daily-summary-review` correctly flagged three defects in the 2026-07-30
// report and the forked agent shipped them anyway, because Step 4.6 is prose
// and prose does not hold (the lesson of every other gate in this repo). These
// three corrections are therefore applied in code, before the report is built.

// (1) One visit split in two. The Jul 30 lunch appeared at 11:11am and again at
// 11:55am under two labels. mergeDuplicateStops only merges ADJACENT stops, and
// the market drink sat between the halves.
const SPLIT_VISIT_MAX_MIN = 120;

// A split visit is ONE place recorded twice, so its two halves are in the same
// place. Matching on the name alone merged the two chain stores of 2026-08-14 — 8 km
// and 16 minutes apart, two suburbs ("we went to two
// stores, the second in the next town") — into a single stop, and the reconciler
// then crushed the result to one minute. A chain has branches; a name is not a
// location.
const SPLIT_VISIT_MAX_M = 400;

// ...and in the same place between them too. 2026-10-16: the night at the rented
// flat (to 04:43) and the morning there from 05:39 were merged over the 34 km
// drive to the airport that separated them, and the airport pickup vanished. A
// trace that went this far from the place between the halves is two visits.
const SPLIT_VISIT_AWAY_M = 1000;

function mergeSplitVisits(stops, pings = null) {
  const merged = [];
  const out = [];
  const isHome = (x) => ["accommodation", "named_location", "known_recurring", "wifi_ssid"]
    .includes((x.place && x.place.source) || "");
  for (const s of stops) {
    // Home is visited several times a day on purpose; merging those windows
    // claims he never left. Only real venues can be split-merged.
    if (isHome(s)) { out.push(s); continue; }
    const twin = out.find(o =>
      !isHome(o) &&
      !merged.includes(o.id) &&
      o.place && s.place && o.place.name && s.place.name &&
      nameSimilarity(o.place.name, s.place.name) >= NAME_SIM_MIN &&
      (s.start_ts_ms - o.end_ts_ms) / 60000 <= SPLIT_VISIT_MAX_MIN &&
      Number.isFinite(o.lat) && Number.isFinite(s.lat) &&
      haversineMeters(o.lat, o.lon, s.lat, s.lon) <= SPLIT_VISIT_MAX_M);
    if (!twin) { out.push(s); continue; }
    // A stop somewhere ELSE between the halves means he left: two visits, not
    // one recorded twice (2026-10-08 — the overnight "the airbnb" to 08:13 and
    // the 09:41 return merged over a bakery and a print shop, and the
    // reconciler then cut the bakery to "9:20–9:23").
    const between = out.slice(out.indexOf(twin) + 1).filter(o => o.place && o.place.name
      && nameSimilarity(o.place.name, s.place.name) < NAME_SIM_MIN && !o.is_movement && !o.user_non_stop);
    if (between.length) { out.push(s); continue; }
    const away = pings && process.env.JORI_SPLIT_AWAY !== "0"
      && usablePings(pings, twin.end_ts_ms, s.start_ts_ms)
        .some(q => haversineMeters(twin.lat, twin.lon, q.lat, q.lon) > SPLIT_VISIT_AWAY_M);
    if (away) { out.push(s); continue; }
    twin.end_ts_ms = Math.max(twin.end_ts_ms, s.end_ts_ms);
    twin.end = hmFromMs(twin.end_ts_ms);
    twin.duration_min = Math.round((twin.end_ts_ms - twin.start_ts_ms) / 60000);
    twin.photos = [...(twin.photos || []), ...(s.photos || [])];
    twin.companions = [...new Set([...(twin.companions || []), ...(s.companions || [])])];
    // keep the shorter, cleaner label ("Cafe Example" over "Lunch at Cafe
    // Example (Turkish, 98 Rue Example)")
    if ((s.place.name || "").length < (twin.place.name || "").length) twin.place = s.place;
    twin.split_merged = true;
    merged.push(s.id);
  }
  return out;
}

// (2) A label that names an activity and no place is movement. The model
// returns venue: null for "Evening walk with the dog"; it was still listed as a
// stop. Also applies the model's venue split to the stop title.
function applyStatementLabels(stops, statements) {
  const labels = (statements && statements.labels) || [];
  if (!labels.length) return [];
  const applied = [];
  for (const s of stops) {
    const cur = s.place && s.place.name;
    if (!cur) continue;
    for (const l of labels) {
      if (!l.stored || nameSimilarity(l.stored, cur) < 0.9) continue;
      if (l.venue) {
        s.place = { ...s.place, name: l.venue };
        applied.push({ from: cur, to: l.venue });
      } else {
        s.is_movement = true;
        s.movement_reason = "you named an activity, not a place";
        applied.push({ from: cur, to: "(movement)" });
      }
      break;
    }
  }
  return applied;
}

// (3) A resolver guess is never presented as a venue. "~Shop Example? ·
// unconfirmed (also: two other venues)" was a machine guess for
// a window he was asked about and never answered.
const GUESS_SOURCES = new Set(["osm_overpass", "google_places", "reverse_geocode",
                               "coordinate", "unknown", "neighborhood", "address"]);

function unnameGuesses(stops) {
  const stripped = [];
  for (const s of stops) {
    if (s.is_movement || s.user_non_stop) continue;
    const src = (s.place && s.place.source) || "";
    // Never strip home. The accommodation is a known place, and an afternoon
    // block that reached here labelled "address" is still his own flat --
    // blanking it left the day with two nameless stops and no home at all.
    if (src === "accommodation" || s.is_home || s.known_recurring) continue;
    if (!GUESS_SOURCES.has(src) || !s.place.name) continue;
    // Two independent witnesses are not a guess. 2026-10-05 18:54–21:05: the
    // nearest place 8 m from the rest was a restaurant and the calendar over the
    // same two hours read "Friends @ a restaurant" (location_match, a physical
    // event) — and the stop still shipped as "6:54pm · unlabeled". When the
    // event's location names the same place the geocoder found, the name is
    // corroborated, not guessed.
    const ev = s.calendar_event;
    if (ev && ev.physical && ev.location_match && ev.location
        && nameSimilarity(s.place.name, ev.location) >= 0.8) {
      s.place = { ...s.place, source: "calendar_corroborated", confidence: 0.9 };
      continue;
    }
    stripped.push(s.place.name);
    s.guessed_name = s.place.name;
    s.place = { ...s.place, name: null, source: "unknown", confidence: 0 };
    s.unnamed = true;
  }
  return stripped;
}

// ---------------------------------------------------------------------------
// location-enrich questions that lost hum's ranker all day
// ---------------------------------------------------------------------------
//
// location-enrich (jobs/location-enrich.md) runs its OWN anchor-walk pass over
// the same raw GPS and queues a genuine "what was this stop?" question into
// data/location-pending-enrich.json the moment it has a hypothesis.
// Since 2026-08-04 that question has to win a slot in hum's ranker like any
// other candidate, capped at 3 asks/day (location-ask-queue.mjs) -- so on a
// day with more than a few candidate stops, most lose every round and just
// sit `asked: true` with no resolution. Because this file's own stops[] is an
// INDEPENDENT clustering pass over the same GPS, a stop location-enrich saw
// and queued can easily not appear in stops[] at all here (folded into a
// browse/movement segment, absorbed into a longer dwell, etc) -- and when
// that happens the visit has zero trace anywhere the user reads: never asked,
// never listed in unknown_stops[], never mentioned in the narrative.
//
// (2026-08-11 incident: a real ~35-minute coffee stop near the apartment was
// correctly captured and queued by location-enrich, lost the ranker every
// round that day, and never appeared in the Tuesday summary at all -- the
// narrative jumped straight from "woke 06:48" to "9:22am airbnb".)
//
// Fix: fold any pending-enrich entry that's been queued, is still unresolved
// (removed from this file by `findme resolve` the moment the user answers -- see
// findme's cmd_resolve), and falls on this day into unknown_stops[] -- reusing
// the SAME "Corrections & follow-ups" surface the renderer already has for
// stops with no confident name, rather than inventing a second mechanism.
const PENDING_ENRICH_PATH = path.join(JORI, "data/location-pending-enrich.json");

function loadUnaskedPendingEnrich(dateStr, stops, multiTz = false) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(PENDING_ENRICH_PATH, "utf8")); }
  catch { return []; }
  const pending = Array.isArray(raw && raw.pending) ? raw.pending : [];
  if (!pending.length) return [];

  const startMs = Date.parse(etBoundaryUtcIso(dateStr));
  const endMs = Date.parse(etBoundaryUtcIso(addDays(dateStr, 1)));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];

  const out = [];
  for (const p of pending) {
    // No `asked` test. When this was written the enrich job SENT its own ask and
    // marked the row `asked: true` on the way out, so "queued, asked, still
    // here" was the only shape a lost question could have. Since 2026-08-04 the
    // job only queues and hum's ranker decides — a question that never ships
    // stays `asked: false` forever, which is the strongest possible evidence it
    // never reached him, and this filter was skipping exactly those. Either
    // state means unresolved: `findme resolve` removes the row the moment he
    // answers. (2026-09-02: a pizzeria stop sat here `asked: false` from
    // 20:30 until its ask was composed at 08:15 the next morning — fourteen
    // minutes AFTER the summary that should have carried it.)
    if (!p || !p.visit_id) continue;
    // He already answered "none of those" (findme resolve … "unknown", since
    // 2026-10-06): the entry is kept only so the stop is never re-queued. It
    // is not an open question, so it does not go back into the summary's ask.
    if (p.declined_at) continue;
    const arrivedMs = Date.parse(p.arrived_at);
    if (!Number.isFinite(arrivedMs) || arrivedMs < startMs || arrivedMs >= endMs) continue;
    const parsedDeparted = Date.parse(p.departed_at);
    const departedMs = Number.isFinite(parsedDeparted) ? parsedDeparted : arrivedMs;

    // Already represented: a stops[] entry overlapping this window means the
    // visit DID make it through this file's own clustering, whether or not it
    // ended up in unknown_stops[] -- don't list it twice.
    const covered = (stops || []).some((s) => {
      if (!Number.isFinite(s.start_ts_ms) || !Number.isFinite(s.end_ts_ms)) return false;
      return s.start_ts_ms < departedMs && s.end_ts_ms > arrivedMs;
    });
    if (covered) continue;

    const top = Array.isArray(p.candidates) && p.candidates.length ? p.candidates[0] : null;
    const tz = timezoneForCoords(p.latitude, p.longitude) || tzAtMs(stops, arrivedMs);
    out.push({
      id: `pending-enrich-${p.visit_id}`,
      start: hmFromMs(arrivedMs, tz),
      end: hmFromMs(departedMs, tz),
      ...(multiTz ? { tz, tz_abbr: tzAbbr(tz, arrivedMs) } : {}),
      lat: typeof p.latitude === "number" ? p.latitude : null,
      lon: typeof p.longitude === "number" ? p.longitude : null,
      // With a shortlist below, a hint naming candidates[0] says the same thing
      // twice ("near Cafe A ... — Cafe A (27m), Cafe B (25m)") — and the
      // "lost the day's question queue" provenance belongs in `source`, not in
      // a sentence addressed to him. No hint: the renderer drops its "near ..."
      // clause and leads with the shortlist.
      hint: Array.isArray(p.candidates) && p.candidates.length
        ? null
        : (top ? `${top.name} (unconfirmed -- lost the day's question queue)` : null),
      candidates: (Array.isArray(p.candidates) ? p.candidates : [])
        .slice(0, 3)
        .map(c => ({ name: c.name, distance_m: c.distance_m })),
      source: "pending_enrich_unasked",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The far end of a drive out and back — an open question (2026-10-29)
// ---------------------------------------------------------------------------
//
// The user: "Driving to a place and returning without a stop makes that turning
// around point a destination worth asking about if we don't know the purpose of
// the drive already." bin/day-segments writes the far end of such a drive as a
// `segment-derived` visit row whose notes carry TURNAROUND_TOKEN, and the live
// card (segment-ask -> stop-identify) asks about it. This file's own stops[] is
// built from the trace, where a drive has no rest, so the row never becomes a
// stop here and the summary would not mention it: the 2026-10-28 airport run
// reached the day only because he asked why it was missing. Listing it in
// unknown_stops[] puts the same question in the summary's follow-ups.
//
// Open means still `segment-derived`: his answer makes it `user-confirmed`,
// "not a stop" makes it `non-stop`, and a check that learns the purpose (his
// calendar, his words) makes it `named`. A name that arrived another way (a
// location-confirm save-at writes no row) shows up as a named stop over the
// same window, which closes it too.
const TURNAROUND_TOKEN = "[turnaround]";
const TURNAROUND_NAMED_RADIUS_M = 3000;     // TURN_RADIUS_M in bin/day-segments

async function loadOpenTurnarounds(dateStr, stops, multiTz = false) {
  let rows;
  try {
    rows = await supabaseSelect(
      "location_history",
      `select=id,arrived_at,departed_at,latitude,longitude,notes` +
        `&segment_type=eq.visit&place_type=eq.segment-derived` +
        `&arrived_at=gte.${encodeURIComponent(etBoundaryUtcIso(dateStr))}` +
        `&arrived_at=lt.${encodeURIComponent(etBoundaryUtcIso(addDays(dateStr, 1)))}` +
        `&order=arrived_at.asc`,
    );
  } catch (e) {
    process.stderr.write(`[resolve-day] open turnarounds unavailable: ${e.message}\n`);
    return [];
  }
  const out = [];
  for (const r of rows || []) {
    if (!(r.notes || "").includes(TURNAROUND_TOKEN)) continue;
    const a = Date.parse(r.arrived_at), d = Date.parse(r.departed_at);
    if (!Number.isFinite(a) || !Number.isFinite(d) || !(d > a)) continue;
    const answered = (stops || []).some((s) => {
      if (!s.place || !s.place.name || !(s.place.confidence >= 0.6)) return false;
      if (!Number.isFinite(s.start_ts_ms) || !Number.isFinite(s.end_ts_ms)) return false;
      const overlap = Math.min(s.end_ts_ms, d) - Math.max(s.start_ts_ms, a);
      return overlap >= 0.5 * (d - a)
        && haversineMeters(s.lat, s.lon, r.latitude, r.longitude) <= TURNAROUND_NAMED_RADIUS_M;
    });
    if (answered) continue;
    const tz = timezoneForCoords(r.latitude, r.longitude) || tzAtMs(stops, a);
    out.push({
      id: `turnaround-${r.id}`,
      start: hmFromMs(a, tz),
      end: hmFromMs(d, tz),
      ...(multiTz ? { tz, tz_abbr: tzAbbr(tz, a) } : {}),
      lat: r.latitude, lon: r.longitude,
      hint: "the far end of a drive out and back, with no stop seen there",
      candidates: [],
      source: "drive_turnaround",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// A path when the map-matcher is down
// ---------------------------------------------------------------------------
//
// `day-path` snaps every fix to the street network via a PUBLIC Valhalla
// instance (valhalla1.openstreetmap.de) with an OSRM fallback. On 2026-09-01
// both were unreachable — `curl 28: timed out after 30005 ms`, `matched_km: 0`,
// `match_pct: 0`, zero legs — while the raw fixes for the same day were sitting
// in the database as usual.
//
// Everything downstream that asks "how far, and in which direction" reads those
// legs: the "Walked N miles" line, markMovementByPace's displacement guards, and
// the whole excursion pass, which without legs sees no geometry and quietly
// declines to emit a walk. So a third-party outage silently deleted a category
// of content from the day — exactly the failure mode this pipeline keeps being
// hardened against, arriving through a different door.
//
// The fixes still describe the day. Straight lines between consecutive fixes are
// a floor on the real distance — never the true street path, always short, never
// wrong in DIRECTION, which is what the guards actually test. So synthesize that
// when matching produced nothing, and label it, so nothing downstream mistakes
// an estimate for a measurement.
const GEOMETRY_MATCHED = "map_matched";
const GEOMETRY_STRAIGHT = "straight_line_fallback";

function pathHasLegs(dayPath) {
  return ((dayPath && dayPath.segments) || []).some(seg => (seg.legs || []).length);
}

// Consecutive usable fixes, joined by straight lines. Mirrors day-path's own leg
// shape so every consumer works unchanged.
function straightLineLegs(pings) {
  const pts = (pings || [])
    .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .filter(p => p.acc == null || p.acc <= 60)
    .sort((a, b) => a.ts - b.ts);
  const legs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (b.ts <= a.ts) continue;
    legs.push({ t0: a.ts, t1: b.ts, lat0: a.lat, lon0: a.lon, lat1: b.lat, lon1: b.lon,
                m: Math.round(haversineMeters(a.lat, a.lon, b.lat, b.lon)) });
  }
  return legs;
}

// Give the day a geometry when the matcher gave it none. Returns the path to
// use (possibly the same object, mutated) or null when there is nothing to
// build from either.
function ensurePathGeometry(dayPath, pings) {
  if (pathHasLegs(dayPath)) {
    if (dayPath.stats) dayPath.stats.geometry_source = GEOMETRY_MATCHED;
    return dayPath;
  }
  const legs = straightLineLegs(pings);
  if (legs.length < 2) return dayPath;
  const total = legs.reduce((t, l) => t + l.m, 0);
  const seg = {
    kind: "observed", costing: "pedestrian",
    start_ms: legs[0].t0, end_ms: legs[legs.length - 1].t1,
    matched_m: total, streets: [], legs,
  };
  const out = dayPath || { segments: [], stats: {}, conflicts: [], nonstops: [] };
  // Replace rather than append: an unmatched segment carries the same window
  // with no legs, and two segments over one window would double-count.
  out.segments = [seg];
  out.stats = out.stats || {};
  out.stats.geometry_source = GEOMETRY_STRAIGHT;
  out.stats.straight_line_m = total;
  process.stderr.write(
    `[resolve-day] map-matching produced no legs — using straight lines between ` +
    `${legs.length + 1} fixes (${total} m, a floor on the real distance)\n`);
  return out;
}

// ---------------------------------------------------------------------------
// Rests — where the trace actually stood still
// ---------------------------------------------------------------------------
//
// See lib/stop-rests.js for the 2026-08-31 case this exists for. Two
// passes, both reading progress along the route instead of one averaged point:
//
//   splitWideStopsOnRests  a cluster wider than any building is re-cut into the
//                          windows the trace actually rested in
//   verifyKnownAgainstRest a known-recurring name survives only if a rest sits
//                          inside that entry's own proximity radius
//
// Both run on the FINAL stop set, after every merge and reconcile pass, because
// both are answering "is this stop true?" and that can only be asked of the
// stop that would otherwise ship.

// Fetch the day's raw fixes once; two passes and flagUnloggedExcursions all
// want them and this table is already big.
async function fetchDayPings(dateStr, photos = []) {
  const startIso = etBoundaryUtcIso(dateStr);
  const endIso = etBoundaryUtcIso(addDays(dateStr, 1));
  try {
    const rows = await supabaseSelect(
      "location_history",
      `select=latitude,longitude,accuracy_m,arrived_at,segment_type,activity` +
        `&arrived_at=gte.${encodeURIComponent(startIso)}` +
        `&arrived_at=lte.${encodeURIComponent(endIso)}&order=arrived_at.asc&limit=20000`,
    );
    return [...rowsToPings(rows), ...photoPings(photos)].sort((a, b) => a.ts - b.ts);
  } catch (e) {
    process.stderr.write(`[resolve-day] raw pings unavailable (${(e && e.message) || e})\n`);
    return photoPings(photos);
  }
}

// `kind` and `activity` are what let a rest be corroborated by something other
// than the GPS positions themselves — see findRests.
function rowsToPings(rows) {
  return (rows || [])
    .map(r => ({ ts: Date.parse(r.arrived_at), lat: Number(r.latitude), lon: Number(r.longitude),
                 acc: r.accuracy_m == null ? null : Number(r.accuracy_m),
                 kind: r.segment_type || null, activity: r.activity || null }))
    .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.lat) && Number.isFinite(p.lon));
}

// The fixes of an arbitrary window, for the one pass that must look past the
// day's end (nameDayEndFromNight). Unreadable means none, never a failed day.
async function fetchPingsBetween(fromMs, toMs) {
  try {
    const rows = await supabaseSelect(
      "location_history",
      `select=latitude,longitude,accuracy_m,arrived_at,segment_type,activity` +
        `&arrived_at=gte.${encodeURIComponent(new Date(fromMs).toISOString())}` +
        `&arrived_at=lte.${encodeURIComponent(new Date(toMs).toISOString())}&order=arrived_at.asc&limit=2000`,
    );
    return rowsToPings(rows);
  } catch (e) {
    process.stderr.write(`[resolve-day] night pings unavailable (${(e && e.message) || e})\n`);
    return [];
  }
}

// A photo he took is a fix.
//
// The tracker goes quiet when the phone is still, which is most of a stop: on
// 2026-09-05 a 42-minute stop had ONE usable fix at 08:31 (still tagged
// `walking`) and then nothing until 09:12, so the "rest" the resolver found was
// the mean of where he left from and where he came back to — 65 m from where he
// actually was. A camera fix landed at 08:40:30, dead in the middle of that
// silence, and was used for nothing. Folding photos in as pings gives findRests,
// restSatAt, splitWideStopsOnRests and dropUnrestedStops the same evidence.
//
// `acc: null` is the honest value, not a flattering one — `photos` has no
// accuracy column, and usablePings already reads null as "unknown, not bad".
// A camera fix is taken while standing still, framing something, which is the
// condition those tests are trying to detect in the first place.
//
// Self-captured only. A received photo's GPS is the SENDER's location — the
// same rule photo-synthesised stops have followed since 2026-06-21.
function photoPings(photos) {
  return (photos || [])
    .filter(p => p.self_captured !== false && p.latitude != null && p.longitude != null)
    .map(p => ({ ts: Date.parse(p.taken_at), lat: Number(p.latitude), lon: Number(p.longitude),
                 acc: null, kind: "photo", activity: null, uuid: p.uuid }))
    .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.lat) && Number.isFinite(p.lon));
}

// Two rests closer together than this are one place seen twice, not two places.
//
// Lowered 150 -> 130 after 2026-09-29 (a law office / a restaurant,
// a beach avenue): the closing and the lunch that followed rested 145.7 m
// apart -- under the old bar by 4.3 m, so a real, differently-named venue got
// "kept_whole" as one place. 150 m had only ever been checked against Little
// Island's 87 m same-place rests and a synthetic ~395 m different-place pair;
// nothing calibrated the gap between them. 130 m keeps ample margin above
// a park pier while accepting this shape — and the names.size>=2 check right
// below still requires the two pieces to resolve to genuinely different venues
// before a split is kept, so a single large venue (same name on both rests)
// is unaffected regardless of this radius.
const SPLIT_SEPARATION_M = 130;

// Sources where the resolver holds truth about WHICH place this is. Mirrors
// daily-summary-confirm's RESOLVER_CONFIRMED.
// `saved_place` earns its seat here only by passing nameFromSavedPlaces' rest
// test below — an unrested saved place never acquires the source in the first
// place, so it cannot use this set to survive dropUnrestedStops.
// `photo_text` earns its seat the same way `saved_place` does: it is only ever
// set by nameStopsFromPhotoText, which requires a self-captured photo inside a
// VERIFIED REST at the stop and a name the model quoted out of that photo's own
// OCR. A sign he photographed while standing there outranks any proximity guess.
const RESOLVER_SETTLED = new Set(["user_confirmed", "user_confirmed_via_transcript",
  "named_location", "known_recurring", "confirmed_stop", "wifi_ssid", "accommodation",
  "saved_place", "photo_text"]);

// The people on a piece of a cut stop are the ones whose own visit row it
// overlaps (2026-10-21). The blend took every overlapping row's companions before
// it was cut (mergeCompanionsFromVisits runs first) and each piece copied them,
// so the 21:49 photo row at a restaurant (two friends) put one of them on the flat at 17:13 and
// again at 22:39. Same test as applyVisitCompanions: the row overlaps the window
// in time and sits within 300 m. A name no visit row gave the blend stays on every
// piece, as before.
function visitRowNames(startMs, endMs, lat, lon, rows) {
  const out = new Set();
  for (const v of rows || []) {
    if (!v || !Array.isArray(v.companions) || !v.companions.length) continue;
    const vStart = Date.parse(v.arrived_at);
    const vEnd = v.departed_at ? Date.parse(v.departed_at) : vStart;
    if (startMs >= vEnd || endMs <= vStart) continue;
    if (haversineMeters(lat ?? 0, lon ?? 0, v.latitude || 0, v.longitude || 0) > 300) continue;
    for (const c of v.companions) out.add(typeof c === "string" ? c : c && c.name);
  }
  return out;
}
function pieceCompanions(blend, piece, rows) {
  const list = blend.companions || [];
  if (!list.length || !Array.isArray(rows) || !rows.length || process.env.JORI_PIECE_COMPANIONS === "0") return [...list];
  const key = (c) => (typeof c === "string" ? c : c && c.name);
  const fromRows = visitRowNames(blend.start_ts_ms, blend.end_ts_ms,
    blend.centroid?.lat ?? blend.lat, blend.centroid?.lon ?? blend.lon, rows);
  const own = visitRowNames(piece.start_ts_ms, piece.end_ts_ms, piece.lat, piece.lon, rows);
  return list.filter((c) => !fromRows.has(key(c)) || own.has(key(c)));
}

// ...and the same test for a stop the later passes shrank in place (2026-10-24).
// The bakery stop took two companions from the flat's 12:01 row while it
// was still the 00:05-13:20 cluster; holdStartsAtWake and the spine cut it to
// 08:49-08:59 and it kept them, though he went "to get pastries for two family members"
// and a companion's phone was elsewhere. Only splitWideStopsOnRests re-checked its pieces.
// `companion_merge_window` is the window a stop had when mergeCompanionsFromVisits
// gave it its rows' people. Kept anyway: a name his words put on the stop, and a
// person with him at the stops on both sides of it with at most
// BRACKET_COMPANION_GAP_MS between (the partner at the 08:52 café on Oct 20,
// between two stretches at the flat, came to it only from the overnight row).
const BRACKET_COMPANION_GAP_MS = 15 * 60_000;
function pruneShrunkCompanions(stops, rows, fromWords = []) {
  const out = [];
  const key = (c) => (typeof c === "string" ? c : c && c.name);
  const said = new Map();
  for (const a of fromWords || []) {
    if (!a || !a.id) continue;
    const set = said.get(a.id) || new Set();
    for (const c of a.companions || []) set.add(key(c));
    said.set(a.id, set);
  }
  const list = stops || [];
  const drop = new Map();
  for (const s of list) {
    const w = s.companion_merge_window;
    delete s.companion_merge_window;
    if (!w || !(s.companions || []).length) continue;
    if (s.start_ts_ms <= w.start_ts_ms && s.end_ts_ms >= w.end_ts_ms) continue;
    const lat = s.lat ?? s.centroid?.lat, lon = s.lon ?? s.centroid?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(w.lat) || !Number.isFinite(w.lon)) continue;
    const kept = new Set(pieceCompanions({ companions: s.companions, ...w },
      { start_ts_ms: s.start_ts_ms, end_ts_ms: s.end_ts_ms, lat, lon }, rows).map(key));
    const words = said.get(s.id) || new Set();
    const names = new Set(s.companions.map(key).filter((n) => !kept.has(n) && !words.has(n)));
    if (names.size) drop.set(s, names);
  }
  const byTime = [...list].sort((a, b) => a.start_ts_ms - b.start_ts_ms);
  const has = (o, n) => Boolean(o) && (o.companions || []).some((c) => key(c) === n) && !(drop.get(o) || new Set()).has(n);
  for (const [s, names] of drop) {
    const i = byTime.indexOf(s);
    const prev = byTime[i - 1], next = byTime[i + 1];
    const bracketed = (n) => prev && next && has(prev, n) && has(next, n)
      && s.start_ts_ms - prev.end_ts_ms <= BRACKET_COMPANION_GAP_MS && next.start_ts_ms - s.end_ts_ms <= BRACKET_COMPANION_GAP_MS;
    const dropped = s.companions.filter((c) => names.has(key(c)) && !bracketed(key(c)));
    if (!dropped.length) continue;
    s.companions = s.companions.filter((c) => !dropped.includes(c));
    out.push({ id: s.id, dropped: dropped.map(key), window: `${s.start}\u2013${s.end}` });
  }
  return out;
}

// Re-cut over-wide stops. A settled identity is never re-cut: if he told us
// where he was, the window is his, however the fixes scattered.
//
// KNOWN GAP (2026-09-29, undispatched — flagged, not yet fixed): "user_confirmed"
// is meant to mean the user told us. It doesn't always. `location-confirm-resolve.mjs`'s
// `localResolve()` can auto-confirm a dwell purely from a calendar-location match,
// with nobody asked, and `location-confirm save` then PATCHes the underlying
// location_history visit row's place_type to the same "user-confirmed" this skip
// check treats as absolute. On 2026-09-29 the rental unit closing (calendar event
// 11:30-13:00) auto-confirmed a 72-minute visit row that actually held two real
// dwells -- the closing, then a ~20-minute lunch at a restaurant 167 m / 145.7 m away
// -- and this skip check threw the split away before geometry ever got a vote.
// (The threshold fix below this function, SPLIT_RADIUS_M/SPLIT_SEPARATION_M,
// would have caught it geometrically; it never got the chance.) A real fix needs
// the write path to distinguish an actual answer from the user from an algorithmic
// calendar match -- e.g. a distinct place_type/tier -- before this check, the
// classifyStops weight table (WEIGHT.user_confirmed), and day-path's spine tier
// map (SPINE_TIER_CONF["user-confirmed"]) can trust them differently. That's a
// coordinated, multi-file change and deliberately NOT attempted inline here.
//
// `confirmed_stop` is NOT in that skip (2026-10-11). It is a PROXIMITY match to
// some earlier confirmation, not an answer about this window, and a blend whose
// centroid lands near an anchor inherits the anchor's name whatever else is
// inside it: on 2026-10-10 the Airbnb's 07:49-08:09 coffee stop sat 170 m from
// the door, the blend's centroid fell 16 m from an anchor saved off an earlier
// blend, and the whole morning shipped as "The Rented Flat". Its pieces re-earn
// the name below (nameRest reads the same confirmations), so a rest AT the
// anchor keeps it and a rest elsewhere does not.
function splitWideStopsOnRests(stops, pings, ctx) {
  if (!pings.length) return { stops, splits: [] };
  const splits = [];
  const out = [];
  for (const s of stops) {
    const src = (s.place && s.place.source) || "";
    // A `named` row is the phone matching a saved place at arrival, not an answer
    // about this window. 2026-10-14: the rented flat geofence row covered 19:48-20:13,
    // widenToBackingVisits stretched it to midnight, and the walk to a bakery
    // (20:13-21:20, 190 m away) shipped inside "The Rented Flat". Only an answer is final.
    const geofenceOnly = process.env.JORI_GEOFENCE_RESPLIT !== "0"
      && !!(s.confirmed_row && s.confirmed_row.place_type === "named");
    if ((src === "user_confirmed" && !geofenceOnly) || s.user_non_stop) { out.push(s); continue; }
    const rests = splitStopOnRests(s, pings);
    if (!rests || !rests.length) { out.push(s); continue; }
    const pieces = rests.map((r, i) => {
      const piece = {
        ...s,
        id: s.id,   // renumbered below
        start: hmFromMs(r.start_ms), end: hmFromMs(r.end_ms),
        start_ts_ms: r.start_ms, end_ts_ms: r.end_ms,
        duration_min: r.minutes,
        lat: r.lat, lon: r.lon,
        cluster_radius_km: r.radius_m / 1000,
        sample_count: r.sample_count,
        rest_verified: { minutes: r.minutes, witnessed_min: r.witnessed_min,
                         precise_fixes: r.precise_count, corroborated_by: r.corroborated_by },
        // A stop's photos carry `ts` (attachPhotosToStop); only the raw rows say
        // `taken_at`. Reading `taken_at` alone parsed to NaN, so every piece came
        // out empty and the fallback below handed ALL photos to piece 1: on
        // 2026-10-10 the café's coffee photos stayed on the Airbnb.
        //
        // Half-open: a rest ends on the first fix ELSEWHERE, which is the next
        // rest's own first fix (findRests), so the instant is the next piece's.
        // Inclusive at both ends, a photo taken at that instant went to BOTH
        // pieces: 2026-10-21, the 20:40:09 photo at a restaurant was the fix that ended
        // the flat's rest and began a restaurant's, and the email showed it under the flat.
        photos: (s.photos || []).filter(ph => {
          const t = Date.parse(ph.taken_at || ph.ts);
          return Number.isFinite(t) && t >= r.start_ms
            && (t < r.end_ms || (t === r.end_ms && i === rests.length - 1));
        }),
        // The blend's name belonged to the blend. Each rest re-earns one below.
        place: { name: null, address: null, source: "unknown", confidence: 0, distance_m: null },
        companions: pieceCompanions(s, { start_ts_ms: r.start_ms, end_ts_ms: r.end_ms, lat: r.lat, lon: r.lon },
                                    ctx.companionRows),
        alternatives: [],
        split_from: { was: `${s.start}-${s.end}`, radius_m: Math.round((s.cluster_radius_km || 0) * 1000),
                      dropped_name: (s.place && s.place.name) || null, piece: i + 1, of: rests.length },
      };
      (ctx.nameRest || nameRest)(piece, ctx);
      return piece;
    });
    // Photos taken while walking between rests would otherwise vanish; give
    // them to the nearest piece in time rather than losing them.
    const kept = new Set(pieces.flatMap(p => (p.photos || []).map(ph => ph.uuid)));
    for (const ph of s.photos || []) {
      if (kept.has(ph.uuid)) continue;
      const t = Date.parse(ph.taken_at || ph.ts);
      if (!Number.isFinite(t)) continue;
      const near = pieces.reduce((best, p) => {
        const d = Math.min(Math.abs(t - p.start_ts_ms), Math.abs(t - p.end_ts_ms));
        return !best || d < best.d ? { p, d } : best;
      }, null);
      if (near) near.p.photos.push(ph);
    }
    // A split has to CHANGE THE ANSWER, or the wide radius was one place's own
    // footprint and cutting it in half only destroys a name. 2026-08-29: a
    // 173 m cluster at a park pier held two rests of 8 and 9 minutes — but
    // both resolve to the same place, because they ARE the same place; he was
    // walking around inside a park. Splitting it produced two identical
    // "<district>" halves and threw the pier away.
    //
    // So keep the cut only when the trace shows him at two DIFFERENT places:
    // the pieces must resolve to different names AND sit further apart than any
    // one venue's footprint. On 2026-08-31 that is "a district" and
    // "a chain store", 220 m apart — a walk to one place and then another.
    if (pieces.length === 1) {
      // One rest inside a much wider window: the window was a walk with one stop
      // in it. Keep the blend's NAME only if the rest re-earned it; otherwise
      // the tightened window carries whatever its own centroid resolves to.
      const p0 = pieces[0];
      splits.push({
        was: `${s.start}-${s.end}`, radius_m: Math.round((s.cluster_radius_km || 0) * 1000),
        retimed_to: `${p0.start}-${p0.end}`, dropped_name: (s.place && s.place.name) || null,
        into: [{ start: p0.start, end: p0.end, min: p0.duration_min,
                 name: p0.place.name, source: p0.place.source }],
      });
      out.push(p0);
      continue;
    }
    // A rest that earned no name is still a place: two verified rests this far
    // apart are two places whether or not either has a label, so each nameless
    // one counts as its own identity (a shared `null` would read as "the same
    // place" and keep the blend whole, hiding the coffee stop behind the door).
    const names = new Set(pieces.map((p, i) => (p.place && p.place.name) || `\0unnamed-${i}`));
    let apartM = 0;
    for (let a = 0; a < pieces.length; a++) {
      for (let b = a + 1; b < pieces.length; b++) {
        apartM = Math.max(apartM, haversineMeters(pieces[a].lat, pieces[a].lon,
                                                  pieces[b].lat, pieces[b].lon));
      }
    }
    // ...unless one rest is a place he named himself before: a past confirmation
    // within 30 m of the rest (nameRest) is not part of another venue's footprint,
    // however close. 2026-10-22, the old town: the phone named the 14:12 arrival "Café
    // the café" and iOS ran it to 17:35, but the long rest from 14:35 sat 3 m from
    // the flat he has confirmed a dozen times, 73 m from the café; at 128 m apart
    // the cut was refused and three hours at the flat shipped as the café.
    const blendName = (s.place && s.place.name) || null;
    const answeredRest = process.env.JORI_SPLIT_ON_ANSWERED_REST !== "0"
      && pieces.some(p => p.place && p.place.source === "confirmed_stop" && p.place.name
                          && !(blendName && nameSimilarity(p.place.name, blendName) >= 0.8));
    if (names.size < 2 || (apartM < SPLIT_SEPARATION_M && !answeredRest)) {
      splits.push({
        was: `${s.start}-${s.end}`, radius_m: Math.round((s.cluster_radius_km || 0) * 1000),
        kept_whole: true, name: (s.place && s.place.name) || null,
        rests: rests.length, apart_m: Math.round(apartM),
        reason: names.size < 2 ? "every rest resolves to the same place" : `rests only ${Math.round(apartM)} m apart`,
      });
      out.push(s);
      continue;
    }
    splits.push({
      was: `${s.start}-${s.end}`, radius_m: Math.round((s.cluster_radius_km || 0) * 1000),
      apart_m: Math.round(apartM),
      dropped_name: (s.place && s.place.name) || null,
      into: pieces.map(p => ({ start: p.start, end: p.end, min: p.duration_min,
                               name: p.place.name, source: p.place.source })),
    });
    out.push(...pieces);
  }
  out.sort((a, b) => a.start_ts_ms - b.start_ts_ms);
  out.forEach((s, i) => { s.id = s.id.replace(/-\d+$/, `-${i + 1}`); });
  return { stops: out, splits };
}

// Past confirmations (data/confirmed-stops.json), the same file and the
// same 30 m ring location-segment names a stop from. Read once per run; a
// missing or unreadable file means "no confirmations", never a failed day.
const CONFIRMED_STOP_MATCH_M = 30;

function loadConfirmedStopsEntries() {
  const file = process.env.JORI_CONFIRMED_STOPS_FILE
    || path.join(JORI, "data/confirmed-stops.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(raw) ? raw : (Array.isArray(raw && raw.entries) ? raw.entries : []);
  } catch (_) {
    return [];
  }
}

function matchConfirmedRest(entries, lat, lon, prefer = null) {
  let best = null, preferred = null;
  for (const e of entries || []) {
    const c = e && (e.centroid || e.coords);
    const elat = Array.isArray(c) ? c[0] : c && c.lat;
    const elon = Array.isArray(c) ? c[1] : c && c.lon;
    if (!e.name || elat == null || elon == null) continue;
    const d = haversineMeters(lat, lon, elat, elon);
    if (d > CONFIRMED_STOP_MATCH_M) continue;
    if (!best || d < best.distance_m) best = { entry: e, distance_m: d };
    if (prefer && e.name === prefer && (!preferred || d < preferred.distance_m)) preferred = { entry: e, distance_m: d };
  }
  // Two anchors a few metres apart (the flat and the café under it) are one spot:
  // a rest that was cut out of a stop named for one of them keeps that name
  // instead of whichever anchor the centroid happens to fall nearer.
  return preferred || best;
}

// Name one rest from ITS OWN centroid — a past confirmation first, then a
// known-recurring entry, then the confidence-gated point resolver. Tight
// geometry by construction: a rest's radius is metres, not the blend's hundreds.
function nameRest(piece, ctx) {
  // A confirmation the user already gave beats a hand-curated entry (same order
  // as location-segment's resolve_place), at the rest's own centroid.
  const conf = matchConfirmedRest(ctx.confirmedStopsEntries, piece.lat, piece.lon,
    piece.split_from && piece.split_from.dropped_name);
  if (conf) {
    piece.place = { name: conf.entry.name, address: conf.entry.address || null, source: "confirmed_stop",
                    confidence: 0.95, distance_m: Math.round(conf.distance_m) };
    return;
  }
  const m = matchStop(ctx.knownStopsEntries, {
    date: ctx.date, stopStartHM: piece.start, stopEndHM: piece.end,
    lat: piece.lat, lon: piece.lon,
  });
  if (m) {
    piece.place = { name: m.entry.name, address: m.entry.address || null, source: "known_recurring",
                    confidence: 0.95, distance_m: m.distance_m != null ? Math.round(m.distance_m) : null };
    return;
  }
  const gated = gatedPlaceFromPoint(piece.lat, piece.lon, new Date(piece.start_ts_ms).toISOString());
  if (gated) {
    piece.place = { name: gated.name, address: gated.address || null, source: gated.source,
                    confidence: gated.confidence, distance_m: null };
  }
}

// Passing through is not a stop, however the phone labelled it.
//
// The user, 2026-09-01: "we're still making up stops while passing through. it
// shouldn't be an unlabeled stop even if it's a favorited place." The 17:14
// window on 2026-08-31 came from a CLVisit row and survived every guard above,
// because a stop with no name has nothing for the name-checks to reject — so it
// shipped as "unlabeled" and asked him to name the turnaround of his own walk.
//
// The test is evidential, not editorial: if the window HAS fixes precise enough
// to settle the question and none of them form a rest, there was no stop. Three
// things are never dropped, each for its own reason:
//   * a settled identity — he told us, or the resolver knows
//   * a window we cannot SEE AT ALL (fewer than two usable fixes) — silence is
//     evidence of stillness, not of absence, and a phone that went quiet indoors
//     must never cost him a real stop. Fixes that exist but are too loose to
//     resolve the question are a different thing: we looked, and what we found
//     does not support a stop.
//   * a window with photos — a photo is proof he was there
//
// A fourth case, added 2026-09-15: a SUBSTANTIAL window still costs him
// something if it's deleted outright, because deletion means he can never
// correct it. The 2026-09-14 daily summary silently lost a 38-minute stop at
// a hospital (visiting someone, right before that
// night's comedy show) — six fixes wandering ~250m across the hospital campus,
// a 26-minute silent gap in the middle, and every one of them tagged
// `place_type='transit'` by iOS's own CLVisit, so no group ever reached a
// 75m rest. The data genuinely doesn't prove stillness — a large campus with
// indoor GPS drift looks exactly like passing through — so withholding a rest
// is still correct. But unlike a 5-minute sliver near a bridge, a
// multi-stop's-worth of unaccounted time is worth a question, not a silent
// hole in the day. Below UNRESTED_KEEP_MIN this stays the ordinary case the
// function exists for (2026-09-01: "we're still making up stops while
// passing through... it shouldn't be an unlabeled stop") — dropped with no
// trace. At or above it, the stop survives unnamed and falls into
// unknown_stops[] like any other low-confidence identity, so the corrections
// list asks instead of the day just being wrong.
const UNRESTED_KEEP_MIN = 20;

// A stretch he DESCRIBED as not-a-stop is still part of his day (2026-10-06).
// "Evening walk with the dog to the beach" was written to the 17:25 and 17:53
// rows as `non-stop` with his words — and the walk vanished from the summary,
// because a non-stop row only ever relabelled a GPS stop that overlapped it
// (classifyStops) and orphan-visit promotion skips non-stops. With no
// overlapping stop, his description had nowhere to land. Now: rows carrying
// the same description within DESCRIBED_JOIN_MS of each other become ONE
// movement slot in his words (user_non_stop → rendered as movement, never a
// venue), absorbing any unnamed, unsettled stop inside it. Skipped when a
// settled stop already covers most of the window — that stop carries it.
const DESCRIBED_JOIN_MS = 30 * 60_000;

// "If it's not a stop, it shouldn't appear as a stop in the spine" (the user,
// 2026-10-08, on a "9:28am · not a stop, not a stop" block). A settled
// non-stop with no description of his has nothing to say as a stop: the
// window leaves the spine and the travel leg between its neighbours covers it.
// Photos go to the nearest-in-time stop, as dropShortStops does. One he
// DESCRIBED ("Evening walk with the dog") keeps its movement slot — those words
// are the content (addDescribedNonStops).
// A run of them long enough to be the afternoon is not nothing, though
// (2026-10-12): an old-city walk was four GPS clusters, each answered "not a
// stop" (by him, or by stop-passage's Jev layer), spanning ~2 h. Dropping each
// one was right — none was a café — but with all four gone the walk itself had
// no slot: it read as a "travel" line from a restaurant, and its photos were handed
// to a bakery, which the narrator then described as the whole afternoon. So a
// run of non-stops (no surviving stop between them, gaps ≤ DESCRIBED_JOIN_MS)
// spanning ≥ NON_STOP_WALK_MIN — widened to the non-stop ROWS it touches, since
// a walk's first stretch often has no GPS cluster at all — becomes one
// movement block titled from geometry (day-excursions titleStretch), carrying
// its own photos plus any a neighbour was holding from inside its window.
const NON_STOP_WALK_MIN = 30;
// A non-stop row speaks for the stop it overlaps only when it covers this
// share of it (adaptSegmentStop).
const NON_STOP_COVER_SHARE = 0.5;

// The block is a WALK, so it is emitted only where he walked (2026-10-19). A
// one-minute sliver by a market at 18:05 chained to an automatic non-stop
// row at a mall (18:37-18:48), 4.5 km away, across the drive between them. The
// window had no matched legs, so titleStretch measured 0 m from the one point
// it had, and 43 minutes that were mostly a drive shipped as "Walk around
// <a neighbourhood>". The fixes decide, by day-path's walked_share rule: a pair at
// vehicle pace, or one the phone's motion sensor called "driving", is not
// walked. Under half walked, no block; the travel line between the stops
// covers the stretch. Fewer than NON_STOP_WALK_SHARE_MIN_M of fixes say nothing.
const NON_STOP_WALK_MIN_SHARE = 0.5;
const NON_STOP_WALK_SHARE_MIN_M = 500;
const WALK_PAIR_MAX_KMH = 7, VEHICLE_PAIR_KMH = 15, VEHICLE_PAIR_MIN_M = 300, FIX_ACC_MAX_M = 100;

function walkedShareOfFixes(pings, fromMs, toMs) {
  if (!Array.isArray(pings)) return null;
  // Fixes only: a visit row's point is a centroid (a photo-synthesized one sits
  // wherever the photo was tagged) and a photo is not the phone's own fix.
  const pts = pings.filter(p => p.ts >= fromMs && p.ts <= toMs && p.kind !== "visit" && p.kind !== "photo"
    && !(p.acc != null && p.acc > FIX_ACC_MAX_M));
  let walk = 0, total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const h = (b.ts - a.ts) / 3_600_000;
    if (h <= 0) continue;
    const d = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    const kmh = d / 1000 / h;
    total += d;
    const vehicle = kmh >= VEHICLE_PAIR_KMH || (kmh >= WALK_PAIR_MAX_KMH && d >= VEHICLE_PAIR_MIN_M)
      || a.activity === "driving" || b.activity === "driving";
    if (!vehicle) walk += d;
  }
  return total >= NON_STOP_WALK_SHARE_MIN_M ? walk / total : null;
}

async function dropUndescribedNonStops(stops, opts = {}) {
  const dropped = [], walks = [], gone = [];
  for (let i = stops.length - 1; i >= 0; i--) {
    const s = stops[i];
    if (!s.user_non_stop || s.excursion) continue;
    if (s.place && s.place.source === "user_confirmed") continue; // his words, or he named a stop inside it
    stops.splice(i, 1);
    gone.unshift(s);
  }
  // Runs of consecutive dropped windows with no surviving stop between them.
  const runs = [];
  for (const s of gone) {
    const r = runs[runs.length - 1];
    const between = r && stops.some(k => k.start_ts_ms >= r.end && k.end_ts_ms <= s.start_ts_ms);
    if (r && !between && s.start_ts_ms - r.end <= DESCRIBED_JOIN_MS) {
      r.members.push(s); r.end = Math.max(r.end, s.end_ts_ms);
    } else {
      runs.push({ members: [s], start: s.start_ts_ms, end: s.end_ts_ms });
    }
  }
  const nonStopRows = (opts.userConfirmed || [])
    .filter(r => r.place_type === "non-stop" && !r.place_name && r.arrived_at && r.departed_at
            && !(r.notes || "").includes("[ask-gate same-stay]"))
    .map(nonStopSpan)
    .filter(x => x.d > x.a)
    .sort((x, y) => x.a - y.a);
  const clock = process.env.JORI_DESCRIBED_WALK_START === "0" ? null
    : statementClock(opts.statements, opts.dateStr);
  const describedStarts = clock ? (opts.statements.non_stops || []).map(n => clock(n.from)).filter(x => x != null) : [];
  for (const r of runs) {
    // Widen over the non-stop rows chained to the run (each within
    // DESCRIBED_JOIN_MS of it), then clamp to the neighbouring stops.
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of nonStopRows) {
        if (row.d < r.start - DESCRIBED_JOIN_MS || row.a > r.end + DESCRIBED_JOIN_MS) continue;
        if (row.a < r.start) { r.start = row.a; grew = true; }
        if (row.d > r.end) { r.end = row.d; grew = true; }
      }
    }
    // ...and back to where he said the stretch began (2026-10-21: "After the falafel place we
    // simply walked back to the apartment", read by day-statements as a non-stop from
    // 14:22; the rows only began at 14:44, so the walk opened 25 minutes after he left
    // lunch). Only the start, only a stretch that begins within DESCRIBED_JOIN_MS of
    // the run, and the clamp below still stops it at the stop before.
    for (const w of describedStarts) {
      if (w < r.start && r.start - w <= DESCRIBED_JOIN_MS) r.start = w;
    }
    const prev = stops.filter(k => k.end_ts_ms <= r.members[0].start_ts_ms).pop();
    const next = stops.find(k => k.start_ts_ms >= r.members[r.members.length - 1].end_ts_ms);
    if (prev) r.start = Math.max(r.start, prev.end_ts_ms);
    if (next) r.end = Math.min(r.end, next.start_ts_ms);
    r.mins = (r.end - r.start) / 60_000;
  }
  // Runs the widening carried onto the same time are one walk (2026-10-21). The
  // walk home from הקוסם was two runs 45 min apart (14:44-15:00, 15:45-17:13); the
  // 14:44-15:17 row stretched the second back to 14:44 and the 15:45-16:02 row the
  // first on to 16:02, so the day shipped two overlapping walks, "not a stop"
  // 14:44-16:02 and "Walk in גן הכובשים" 14:44-17:13. The clamp above keeps a run
  // from crossing a surviving stop, so runs that now overlap or touch have nothing
  // between them.
  for (let i = 1; i < runs.length; i++) {
    const a = runs[i - 1], b = runs[i];
    if (b.start > a.end) continue;
    a.members.push(...b.members);
    a.start = Math.min(a.start, b.start);
    a.end = Math.max(a.end, b.end);
    a.mins = (a.end - a.start) / 60_000;
    runs.splice(i--, 1);
  }
  for (const r of runs) {
    const photos = [];
    const seenP = new Set();
    for (const s of r.members) for (const p of s.photos || []) if (!seenP.has(p.uuid)) { seenP.add(p.uuid); photos.push(p); }
    let walk = null;
    const walkedShare = walkedShareOfFixes(opts.pings, r.start, r.end);
    if (walkedShare != null && walkedShare < NON_STOP_WALK_MIN_SHARE) {
      r.not_walked = { walked_share: Math.round(walkedShare * 100) / 100 };
    }
    if (r.mins >= NON_STOP_WALK_MIN && opts.dayPath && !r.not_walked) {
      const t = await titleStretch(opts.dayPath, r.start, r.end, { resolvePoint: opts.resolvePoint, features: opts.features,
        points: r.members.filter(s => s.lat != null && s.lon != null)
          .map(s => ({ lat: s.lat, lon: s.lon, t: (s.start_ts_ms + s.end_ts_ms) / 2 })) });
      const first = r.members[0];
      walk = {
        id: `${first.id}-walk`, start: opts.hm ? opts.hm(r.start) : first.start,
        end: opts.hm ? opts.hm(r.end) : r.members[r.members.length - 1].end,
        start_ts_ms: r.start, end_ts_ms: r.end, duration_min: Math.round(r.mins),
        lat: t.lat ?? first.lat, lon: t.lon ?? first.lon,
        place: { name: t.title, address: null, source: "excursion", confidence: 0.7, distance_m: null },
        companions: [...new Set(r.members.flatMap(s => s.companions || []))], activity: null,
        photos, alternatives: [], pattern: "browse", user_non_stop: false,
        sample_count: null, cluster_radius_km: null, calendar_event: null,
        tz: first.tz, tz_abbr: first.tz_abbr,
        excursion: { from_base: null, routed_m: t.routed_m, geometry: t.geometry, away_m: t.away_m, kmh: t.kmh, mode: t.mode,
          turnaround: { lat: t.lat, lon: t.lon, neighborhood: t.neighborhood }, feature: t.feature,
          absorbed: r.members.map(s => ({ id: s.id, start: s.start, end: s.end, was: (s.place && s.place.name) || null })),
          non_stop_run: true },
      };
      // Photos a neighbour was holding that were taken inside the walk and
      // outside that neighbour's own window come back to the walk.
      for (const k of stops) {
        if (!(k.photos || []).length) continue;
        const keep = [];
        for (const p of k.photos) {
          const pt = Date.parse(p.ts || p.taken_at);
          const inWalk = Number.isFinite(pt) && pt >= r.start && pt <= r.end;
          const inOwn = Number.isFinite(pt) && pt >= k.start_ts_ms && pt <= k.end_ts_ms;
          if (inWalk && !inOwn && !seenP.has(p.uuid)) { seenP.add(p.uuid); walk.photos.push(p); }
          else keep.push(p);
        }
        k.photos = keep;
      }
      const at = stops.findIndex(k => k.start_ts_ms >= r.end);
      stops.splice(at < 0 ? stops.length : at, 0, walk);
      walks.push({ id: walk.id, title: t.title, start: walk.start, end: walk.end, minutes: walk.duration_min,
                   routed_m: t.routed_m, mode: t.mode, absorbed: r.members.length, photos: walk.photos.length });
    }
    for (const s of r.members) {
      let target = walk;
      if (!target) {
        const mid = (s.start_ts_ms + s.end_ts_ms) / 2;
        let best = Infinity;
        for (const k of stops) {
          const dist = Math.abs((k.start_ts_ms + k.end_ts_ms) / 2 - mid);
          if (dist < best) { best = dist; target = k; }
        }
        if (target && (s.photos || []).length) {
          const seen = new Set((target.photos || []).map(p => p.uuid));
          target.photos = [...(target.photos || []), ...s.photos.filter(p => !seen.has(p.uuid))];
        }
      }
      dropped.push({ id: s.id, start: s.start, end: s.end, guess: (s.place && s.place.name) || null,
                     photos_to: target && (s.photos || []).length ? target.id : null,
                     ...(walk ? { into_walk: walk.id } : {}),
                     ...(r.not_walked && r.mins >= NON_STOP_WALK_MIN ? { not_a_walk: r.not_walked } : {}) });
    }
  }
  return { dropped, walks };
}

function addDescribedNonStops(stops, userConfirmed) {
  const rows = (userConfirmed || [])
    .filter(r => r.place_type === "non-stop" && r.place_name && r.arrived_at && r.departed_at
            && r.latitude != null && r.longitude != null)
    .map(r => ({ ...r, a: Date.parse(r.arrived_at), d: Date.parse(r.departed_at) }))
    .sort((x, y) => x.a - y.a);
  const groups = [];
  for (const r of rows) {
    const g = groups[groups.length - 1];
    if (g && r.a - g.d <= DESCRIBED_JOIN_MS && nameSimilarity(g.name, r.place_name) >= 0.9) {
      g.d = Math.max(g.d, r.d); g.rows.push(r);
    } else groups.push({ name: r.place_name, a: r.a, d: r.d, rows: [r] });
  }
  const added = [];
  for (const g of groups) {
    const span = g.d - g.a;
    if (span <= 0) continue;
    const settled = (x) => RESOLVER_SETTLED.has((x.place && x.place.source) || "") || x.user_non_stop;
    const covered = stops.filter(settled).reduce((acc, x) =>
      acc + Math.max(0, Math.min(g.d, x.end_ts_ms) - Math.max(g.a, x.start_ts_ms)), 0);
    if (covered / span >= 0.5) continue;
    const absorbed = stops.filter(x => !settled(x) && !(x.place && x.place.name)
      && x.start_ts_ms >= g.a - 5 * 60_000 && x.end_ts_ms <= g.d + 5 * 60_000);
    const photos = absorbed.flatMap(x => x.photos || []);
    for (const x of absorbed) stops.splice(stops.indexOf(x), 1);
    const first = g.rows[0];
    const ns = {
      id: `s-${dateKeyOf(g.a)}-w${added.length + 1}`,
      start: hmFromMs(g.a), end: hmFromMs(g.d), start_ts_ms: g.a, end_ts_ms: g.d,
      duration_min: Math.round(span / 60000),
      lat: first.latitude, lon: first.longitude,
      place: { name: g.name, address: null, source: "user_confirmed", confidence: 1, distance_m: null },
      user_non_stop: true, companions: first.companions || [], photos, alternatives: [],
      pattern: "movement", calendar_event: null,
    };
    stops.push(ns);
    added.push({ id: ns.id, name: g.name, start: ns.start, end: ns.end, rows: g.rows.map(r => r.id),
                 absorbed: absorbed.map(x => x.id) });
  }
  if (added.length) stops.sort((x, y) => x.start_ts_ms - y.start_ts_ms);
  return added;
}

// Silence is stillness — at a stop's EDGES too (2026-10-06). The Lassers dinner
// at a restaurant: driving 345 m out at 18:44, nothing at all until 21:58 (driving
// 813 m away), yet the stop ran 18:54–21:00 — bounded by the first photo-
// synthesized row and the calendar event's end, the only evidence inside the
// silence. the user: "I think we were there longer." The phone goes quiet when
// it is still; the stop lasts until the trace next shows him somewhere else.
// So a stop's end runs on to the first usable fix after it (minus the time to
// cover the distance to that fix), and its start back to the last fix before
// it — only across a silent gap (no fix in between), never into a
// neighbouring stop, and never across more than SILENCE_EXTEND_MAX_MS.
const SILENCE_EXTEND_MIN_MS = 10 * 60_000;
const SILENCE_EXTEND_MAX_MS = 4 * 3600_000;
const SILENCE_EXIT_KMH = 20;   // a floor on how fast he left; driving is faster
const MOVING_ACTIVITIES = new Set(["walking", "running", "cycling", "automotive"]);

// The day's last stop, too (2026-10-21). Its last fix at the flat was 23:16:08
// and the next, at 00:54, was at the same spot, but this pass only saw the day's own
// fixes, so the stay ended at 23:16 and the 11:34pm call with a colleague sat after the
// day's last stop, "likely at" the flat. resolveDay hands in the fixes of the hours
// after midnight as well, and `dayEndMs` keeps every end inside the day.
// A camera fix is precise, so a photo is AT a place only where its own GPS sits at
// it (PHOTO_AT_STOP_M, the radius the photo passes below use), not anywhere in the
// SPINE_SAME_PLACE_M a drifting phone fix is allowed: a photo taken down the street
// on the walk away would otherwise hold the stop open and leave the walk no time.
// JORI_PHOTO_EDGE_RADIUS=0 gives photos the 150 m again.
function samePlaceRadius(q) {
  return q && q.kind === "photo" && process.env.JORI_PHOTO_EDGE_RADIUS !== "0"
    ? PHOTO_AT_STOP_M : SPINE_SAME_PLACE_M;
}

function extendThroughSilence(stops, pings, asleep = null, dayEndMs = null) {
  const out = [];
  const sorted = [...stops].sort((a, b) => a.start_ts_ms - b.start_ts_ms);
  const travelMs = (s, p) => haversineMeters(s.lat, s.lon, p.lat, p.lon) / (SILENCE_EXIT_KMH / 3.6) * 1000;
  sorted.forEach((s, i) => {
    if (s.lat == null || s.lon == null || s.is_movement || s.user_non_stop) return;
    const prev = sorted[i - 1], next = sorted[i + 1];
    const was = `${s.start}–${s.end}`;
    let changed = false;
    // A fix inside the 150 m radius still belongs to a DIFFERENT place when it sits
    // nearer the neighbouring stop (a different venue, SPLIT_SEPARATION_M+ away):
    // 2026-10-14, the 21:20 walk home was 101 m from the café and 66 m from the flat,
    // and counting it as "still at the café" stretched the café through the flat's hour.
    // Between two stops closer than that, a fix taken while moving that sits nearer
    // the neighbour is the short walk between them, not more time at this one.
    const nearer = (q, other) => process.env.JORI_SILENCE_NEIGHBOUR !== "0"
      && other && other.lat != null && other.lon != null
      && (haversineMeters(s.lat, s.lon, other.lat, other.lon) >= SPLIT_SEPARATION_M
          || (MOVING_ACTIVITIES.has(q.activity) && process.env.JORI_SILENCE_MOVING_NEIGHBOUR !== "0"))
      && haversineMeters(q.lat, q.lon, other.lat, other.lon) < haversineMeters(q.lat, q.lon, s.lat, s.lon);
    const near = (q, other) => haversineMeters(s.lat, s.lon, q.lat, q.lon) <= samePlaceRadius(q)
      && !nearer(q, other);
    // end → the first fix ELSEWHERE after it. Fixes at the place itself (a
    // photo at the table, a stray CLVisit) only say he was still there. The fix AT
    // the end counts: a stop cut on rests ends on the timestamp of the first fix
    // elsewhere (stop-rests.js findRests), and skipping it read the silence after
    // it as him still there (2026-10-16: walking 169 m from the restaurant at 21:44,
    // the dinner was stretched to the flat's next fix at 22:16).
    const hiBound = Math.min(next ? next.start_ts_ms : Infinity, s.end_ts_ms + SILENCE_EXTEND_MAX_MS,
      Number.isFinite(dayEndMs) ? dayEndMs : Infinity);
    let stillAt = s.end_ts_ms, exit = null;
    for (const q of usablePings(pings, s.end_ts_ms, s.end_ts_ms + 2 * SILENCE_EXTEND_MAX_MS)) {
      if (near(q, next)) { stillAt = q.ts; continue; }
      exit = q; break;
    }
    // A fix AT the place is direct evidence he was still there — 2026-10-05:
    // the flat's stop ended 16:09 while fixes there ran to 16:35 and a CLVisit
    // departure at 17:25; only the silence after that is inferred.
    let end = stillAt;
    if (exit && exit.ts - stillAt >= SILENCE_EXTEND_MIN_MS && exit.ts - stillAt <= SILENCE_EXTEND_MAX_MS) {
      end = exit.ts - travelMs(s, exit);
    }
    end = Math.min(end, hiBound);
    if (end > s.end_ts_ms + 60_000) { s.end_ts_ms = end; changed = true; }
    // start → the last fix elsewhere before it
    const loBound = Math.max(prev ? prev.end_ts_ms : -Infinity, s.start_ts_ms - SILENCE_EXTEND_MAX_MS);
    let firstAt = s.start_ts_ms, entry = null;
    for (const q of usablePings(pings, s.start_ts_ms - 2 * SILENCE_EXTEND_MAX_MS, s.start_ts_ms - 1).reverse()) {
      if (near(q, prev)) { firstAt = q.ts; continue; }
      entry = q; break;
    }
    let start = firstAt;
    if (entry && firstAt - entry.ts >= SILENCE_EXTEND_MIN_MS && firstAt - entry.ts <= SILENCE_EXTEND_MAX_MS) {
      start = entry.ts + travelMs(s, entry);
    }
    start = Math.max(start, loBound);
    // A fix from the night (the flat is within SPINE_SAME_PLACE_M of the café)
    // is not the venue's start: the Watch had him asleep. See widensThroughSleep.
    if (widensThroughSleep(s, start, asleep)) start = s.start_ts_ms;
    if (start < s.start_ts_ms - 60_000) { s.start_ts_ms = start; changed = true; }
    if (!changed) return;
    s.start = hmFromMs(s.start_ts_ms); s.end = hmFromMs(s.end_ts_ms);
    s.duration_min = Math.round((s.end_ts_ms - s.start_ts_ms) / 60000);
    s.extended_through_silence = true;
    out.push({ id: s.id, name: s.place && s.place.name, was, now: `${s.start}–${s.end}` });
  });
  return out;
}

// Two places are never the same minute (2026-10-20). A rest-cut stop ends on
// the first fix ELSEWHERE (stop-rests.js findRests), and that fix is the next
// place's first, so a stay and the next one 186 m away shared a minute: the
// rented flat 19:12-20:06 and the restaurant from 20:06, with no walk between. The flat's
// last fix was 19:15, and the 20:06 fix stood at the restaurant's table. Where the
// earlier stop's tail is only silence (no fix at its own place in it), it gives
// back the time it takes to walk to the next one; a fix at the place keeps it.
// Walking pace for a hop he could walk; beyond that, the same floor on a ride
// extendThroughSilence uses (an 8.6 km drive home is not 100 minutes on foot).
const TRAVEL_GAP_KMH = 5;
const TRAVEL_GAP_WALK_M = 1500;
const TRAVEL_GAP_MAX_MS = 30 * 60_000;
// Travel he was seen doing is not a silent tail (2026-10-28: the drive to the airport
// had a fix every five minutes, yet the flat was cut back to 05:30 to "make room"
// for it, ten minutes before the fix that proved he had left at 05:40). The gap is
// seen when at least one fix sits at neither place and no stretch of it, from the
// earlier stop's end to the later one's start, goes quiet for SILENCE_EXTEND_MIN_MS.
function travelSeen(a, b, pings) {
  const inGap = usablePings(pings, a.end_ts_ms, b.start_ts_ms);
  const apart = (s, q) => haversineMeters(s.lat, s.lon, q.lat, q.lon) > samePlaceRadius(q);
  if (!inGap.some(q => apart(a, q) && apart(b, q))) return false;
  let last = a.end_ts_ms;
  for (const q of inGap) {
    if (q.ts - last >= SILENCE_EXTEND_MIN_MS) return false;
    last = q.ts;
  }
  return b.start_ts_ms - last < SILENCE_EXTEND_MIN_MS;
}
function leaveRoomToTravel(stops, pings) {
  const out = [];
  const places = stops.filter(s => s.lat != null && s.lon != null
    && !s.is_movement && !s.user_non_stop && !s.excursion)
    .sort((a, b) => a.start_ts_ms - b.start_ts_ms);
  for (let i = 1; i < places.length; i++) {
    const a = places[i - 1], b = places[i];
    const d = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    if (d < SPLIT_SEPARATION_M) continue;            // one place, or near enough
    const kmh = d <= TRAVEL_GAP_WALK_M ? TRAVEL_GAP_KMH : SILENCE_EXIT_KMH;
    const need = Math.min(d / (kmh / 3.6) * 1000, TRAVEL_GAP_MAX_MS);
    const gap = b.start_ts_ms - a.end_ts_ms;
    if (gap >= need || gap < 0) continue;           // room already, or an overlap (reconcile's)
    if (travelSeen(a, b, pings)) continue;          // the fixes across the gap are the travel
    const atA = usablePings(pings, a.start_ts_ms, a.end_ts_ms)
      .filter(q => haversineMeters(a.lat, a.lon, q.lat, q.lon) <= samePlaceRadius(q)
        && haversineMeters(b.lat, b.lon, q.lat, q.lon) >= haversineMeters(a.lat, a.lon, q.lat, q.lon));
    const lastAtA = atA.length ? atA[atA.length - 1].ts : a.start_ts_ms;
    const end = Math.round(b.start_ts_ms - need);
    if (end <= lastAtA) continue;                   // he was seen there: leave it
    const was = `${a.start}–${a.end}`;
    a.end_ts_ms = end;
    a.end = hmFromMs(a.end_ts_ms);
    a.duration_min = Math.round((a.end_ts_ms - a.start_ts_ms) / 60000);
    out.push({ id: a.id, name: a.place && a.place.name, was, now: `${a.start}–${a.end}`,
               next: b.place && b.place.name, apart_m: Math.round(d) });
  }
  return out;
}

// A photo is shown under the place it was taken at, and that place's time
// covers it (2026-10-22: a photo at a bar belongs with the bar's section and
// sets the time of arrival, not the previous section's). The user photographed the table at a restaurant at
// 20:40:09, 3 m from the bar and 155 m from the flat. That photo was also the
// fix that ended the flat's rest (splitWideStopsOnRests, now half-open), so both
// pieces kept it; later passes trimmed the flat to 20:36 and nothing took the
// photo back, so the email showed it at the bottom of the flat's section.
//
// Two passes, both geometry and time:
//   pinStopsToPhotos (before extendThroughSilence): a photo whose own GPS puts it
//     at a stop, just outside that stop's window, moves the stop's arrival back
//     to it (or its departure on to it), and the neighbour gives way. He was
//     there when he took it, so a place is never reached after its first photo.
//   settleStopPhotos (last): each photo is on exactly one stop, the one whose
//     window holds the moment it was taken.
// JORI_PHOTO_PIN=0 / JORI_PHOTO_SETTLE=0 turn either off.
const PHOTO_AT_STOP_M = 75;               // the photo's GPS sits at the stop
const PHOTO_PIN_MAX_MS = 30 * 60_000;     // furthest a photo moves a stop's edge

const photoGps = (row) => (row && row.self_captured !== false && row.latitude != null && row.longitude != null
  && Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude))
  ? { lat: Number(row.latitude), lon: Number(row.longitude) } : null);
const stopToPhotoM = (x, g) => (g && x.lat != null && x.lon != null
  ? haversineMeters(x.lat, x.lon, g.lat, g.lon) : Infinity);
const msOutside = (x, t) => (t < x.start_ts_ms ? x.start_ts_ms - t : t > x.end_ts_ms ? t - x.end_ts_ms : 0);
// The email draws photos only under the stops it shows (daily-summary-render's
// isMainStop: a settled or answered name, an excursion, or 30+ minutes), so a
// photo is never moved onto a stop it hides, nor a neighbour trimmed out of it.
function shownInEmail(x) {
  return require(path.join(__dirname, "daily-summary-render.js"))._internal.isMainStop(x);
}
const reshaped = (x, startMs, endMs) => ({ ...x, start_ts_ms: startMs, end_ts_ms: endMs,
  duration_min: Math.round((endMs - startMs) / 60_000) });

// Guards, each a reason to leave the stop alone: the photo is no further than
// PHOTO_PIN_MAX_MS from the edge; its GPS is at this stop and clearly not at the
// neighbour (beyond PHOTO_AT_STOP_M and twice as far); no fix between the photo
// and the edge puts him anywhere else, and no other stop (a walk, a "not a
// stop" stretch) sits there; the neighbour keeps SHORT_STOP_MIN; the email
// shows the stop, and still shows the neighbour if it did before.
function pinStopsToPhotos(stops, photoRows, pings) {
  const out = [];
  if (process.env.JORI_PHOTO_PIN === "0") return out;
  const byUuid = new Map((photoRows || []).map(p => [p.uuid, p]));
  const places = stops.filter(x => x.lat != null && x.lon != null
    && !x.is_movement && !x.user_non_stop && !x.excursion)
    .sort((a, b) => a.start_ts_ms - b.start_ts_ms);
  const held = new Map();
  for (const s of stops) for (const ph of s.photos || []) if (ph && ph.uuid && !held.has(ph.uuid)) held.set(ph.uuid, ph);
  // Earliest first: the first photo at a place is the one that sets the arrival.
  const photos = [...held.values()]
    .map(ph => ({ ph, gps: photoGps(byUuid.get(ph.uuid)), t: Date.parse((byUuid.get(ph.uuid) || {}).taken_at) }))
    .filter(x => x.gps && Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  const hm = (x) => `${x.start}–${x.end}`;
  const restamp = (x) => {
    x.start = hmFromMs(x.start_ts_ms); x.end = hmFromMs(x.end_ts_ms);
    x.duration_min = Math.round((x.end_ts_ms - x.start_ts_ms) / 60_000);
  };
  for (const { ph, gps, t } of photos) {
    const near = places.filter(x => msOutside(x, t) <= PHOTO_PIN_MAX_MS);
    if (near.some(x => msOutside(x, t) === 0 && stopToPhotoM(x, gps) <= PHOTO_AT_STOP_M)) continue;
    const s = near.filter(x => stopToPhotoM(x, gps) <= PHOTO_AT_STOP_M)
      .sort((a, b) => msOutside(a, t) - msOutside(b, t))[0];
    if (!s) continue;
    const i = places.indexOf(s);
    const arriving = t < s.start_ts_ms;
    const n = arriving ? places[i - 1] : places[i + 1];
    const dS = stopToPhotoM(s, gps);
    if (n) {
      const dN = stopToPhotoM(n, gps);
      if (dN <= PHOTO_AT_STOP_M || dN < 2 * dS) continue;      // GPS cannot tell the two apart
    }
    const nearerS = (q) => haversineMeters(q.lat, q.lon, s.lat, s.lon) <= SPINE_SAME_PLACE_M
      && (!n || haversineMeters(q.lat, q.lon, s.lat, s.lon) <= haversineMeters(q.lat, q.lon, n.lat, n.lon));
    const between = arriving ? usablePings(pings, t + 1, s.start_ts_ms - 1) : usablePings(pings, s.end_ts_ms + 1, t - 1);
    if (!between.every(nearerS)) continue;
    const [lo, hi] = arriving ? [t, s.start_ts_ms] : [s.end_ts_ms, t];
    if (stops.some(x => x !== s && x !== n && x.start_ts_ms < hi && x.end_ts_ms > lo)) continue;
    let nStart = n ? n.start_ts_ms : null, nEnd = n ? n.end_ts_ms : null;
    if (n && arriving && nEnd > t) nEnd = t;
    if (n && !arriving && nStart < t) {
      // Leave him the time it takes to get there, unless he is seen there sooner.
      const d = haversineMeters(s.lat, s.lon, n.lat, n.lon);
      const need = Math.min(d / ((d <= TRAVEL_GAP_WALK_M ? TRAVEL_GAP_KMH : SILENCE_EXIT_KMH) / 3.6) * 1000, TRAVEL_GAP_MAX_MS);
      const seen = usablePings(pings, t + 1, n.end_ts_ms)
        .find(q => haversineMeters(q.lat, q.lon, n.lat, n.lon) <= SPINE_SAME_PLACE_M);
      nStart = Math.max(nStart, Math.round(Math.min(t + need, seen ? seen.ts : Infinity)));
    }
    if (n && nEnd - nStart < SHORT_STOP_MIN * 60_000) continue;
    if (n && shownInEmail(n) && !shownInEmail(reshaped(n, nStart, nEnd))) continue;
    if (!shownInEmail(arriving ? reshaped(s, t, s.end_ts_ms) : reshaped(s, s.start_ts_ms, t))) continue;
    const was = hm(s);
    if (arriving) s.start_ts_ms = t; else s.end_ts_ms = t;
    restamp(s);
    let neighbour = null;
    if (n && (nStart !== n.start_ts_ms || nEnd !== n.end_ts_ms)) {
      const nWas = hm(n);
      n.start_ts_ms = nStart; n.end_ts_ms = nEnd;
      restamp(n);
      neighbour = { id: n.id, name: (n.place && n.place.name) || null, was: nWas, now: hm(n) };
    }
    for (const x of stops) if (x !== s && (x.photos || []).some(p => p.uuid === ph.uuid)) x.photos = x.photos.filter(p => p.uuid !== ph.uuid);
    if (!(s.photos || []).some(p => p.uuid === ph.uuid)) s.photos = [...(s.photos || []), ph];
    out.push({ uuid: ph.uuid, id: s.id, name: (s.place && s.place.name) || null,
               edge: arriving ? "arrival" : "departure", was, now: hm(s),
               photo_m: Math.round(dS), neighbour });
  }
  return out;
}

// Runs last, after every pass that moves a stop's edges. A photo inside one
// stop's window goes there (nearest by its GPS when windows overlap, else the
// later-starting one: the boundary instant belongs to the place that begins
// there). It stays put when its GPS puts it nearer a shown stop already holding
// it, or when the window it falls in is a stop the email does not show (see
// shownInEmail). A photo in no window (taken between places) stays where the
// passes above put it, on one stop: a shown one first, then the nearest in time.
function settleStopPhotos(stops, photoRows) {
  const out = [];
  if (process.env.JORI_PHOTO_SETTLE === "0") return out;
  const byUuid = new Map((photoRows || []).map(p => [p.uuid, p]));
  const holders = new Map();
  for (const s of stops) for (const ph of s.photos || []) {
    if (!ph || !ph.uuid) continue;
    const h = holders.get(ph.uuid) || { ph, at: [] };
    if (!h.at.includes(s)) h.at.push(s);
    holders.set(ph.uuid, h);
  }
  const shown = new Map(stops.map(x => [x, shownInEmail(x)]));
  for (const [uuid, { ph, at }] of holders) {
    const row = byUuid.get(uuid);
    const t = Date.parse((row && row.taken_at) || ph.ts || ph.taken_at);
    const gps = photoGps(row);
    const dist = (x) => stopToPhotoM(x, gps);
    let owner = null;
    if (Number.isFinite(t)) {
      const inside = stops.filter(x => shown.get(x) && x.start_ts_ms <= t && t <= x.end_ts_ms)
        .sort((a, b) => (dist(a) - dist(b)) || (b.start_ts_ms - a.start_ts_ms));
      owner = inside[0] || null;
      if (owner && !at.includes(owner)) {
        const home = at.filter(x => shown.get(x)).sort((a, b) => dist(a) - dist(b))[0];
        if (home && gps && dist(home) < dist(owner) && dist(home) <= RECLAIM_RADIUS_M) owner = home;
      }
    }
    if (!owner) {
      owner = [...at].sort((a, b) => (Number(!shown.get(a)) - Number(!shown.get(b)))
        || (Number.isFinite(t) ? msOutside(a, t) - msOutside(b, t) : 0)
        || (dist(a) - dist(b)) || 0)[0];
    }
    if (at.length === 1 && at[0] === owner) continue;
    for (const x of at) if (x !== owner) x.photos = x.photos.filter(p => p.uuid !== uuid);
    if (!at.includes(owner)) owner.photos = [...(owner.photos || []), ph];
    out.push({ uuid, to: owner.id, name: (owner.place && owner.place.name) || null,
               from: at.filter(x => x !== owner).map(x => x.id), moved: !at.includes(owner) });
  }
  return out;
}

// The people he named are on the stop he named (2026-10-17). day-statements reads
// "had dinner here <maps link> with <two family members>" as the restaurant with
// two family members, but only Find My proximity (findme enrich) ever wrote a
// companion, so the 2026-10-16 header carried no one. The model reads the words
// (Rule #0b); this only binds its reading to a stop by name and by the time the
// model gave (its when_hint: a clock time, "now", or "earlier" than he wrote).
function applyStatementCompanions(stops, statements, dateStr) {
  const applied = [];
  if (!statements || process.env.JORI_WORD_COMPANIONS === "0") return applied;
  const tz = (statements._meta && statements._meta.tz) || DAY_BOUNDARY_TZ;
  const day0 = zonedMidnightMs(dateStr, tz);
  const at = (v) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "")); // lang-regex-ok: a model-emitted HH:MM stamp
    return m ? day0 + Number(m[1]) * 3600_000 + Number(m[2]) * 60_000 : null;
  };
  for (const p of statements.places || []) {
    const who = (p.companions || []).filter(x => typeof x === "string" && x.trim());
    if (!who.length || !p.venue) continue;
    const named = stops.filter(x => x.place && x.place.name && nameSimilarity(x.place.name, p.venue) >= 0.9)
      .sort((a, b) => a.start_ts_ms - b.start_ts_ms);
    const said = at(p.said_at), hint = at(p.when_hint);
    let s = null;
    if (hint != null) s = named.find(x => x.start_ts_ms - 600_000 <= hint && hint <= x.end_ts_ms + 600_000);
    else if (p.when_hint === "now" && said != null) s = named.find(x => x.start_ts_ms <= said && said <= x.end_ts_ms + 600_000);
    else if (said != null) s = named.filter(x => x.start_ts_ms <= said).pop() || null;
    else if (named.length === 1) s = named[0];
    if (!s) continue;
    const before = new Set(s.companions || []);
    s.companions = [...before, ...who.filter(w => !before.has(w))];
    applied.push({ id: s.id, venue: p.venue, companions: who, evidence: p.evidence || null });
  }
  return applied;
}

// What the user said they were there for (2026-10-21). day-statements read "the hotel
// for the conference", the user's reply to the 10:30 ask, as the hotel with activity
// "conference"; the row answered reads "Hotel Example", so the name test
// above never binds it, and "<conference title>" (8am-4pm, no location)
// stayed under "Events not matched" right below that stop. A statement binds here
// by the time the model gave (its when_hint, a clock time) to the stop covering
// it, when that stop carries the venue's name or is his own answer for the window
// (a user-confirmed row). Read by the calendar check only (calendarCorroborated in
// daily-summary-render.js). Runs on the final stop set.
function applyStatementWords(stops, statements, dateStr) {
  const applied = [];
  if (!statements || process.env.JORI_WORD_ACTIVITIES === "0") return applied;
  const tz = (statements._meta && statements._meta.tz) || DAY_BOUNDARY_TZ;
  const day0 = zonedMidnightMs(dateStr, tz);
  const at = (v) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "")); // lang-regex-ok: a model-emitted HH:MM stamp
    return m ? day0 + Number(m[1]) * 3600_000 + Number(m[2]) * 60_000 : null;
  };
  for (const p of statements.places || []) {
    if (!p.venue || typeof p.activity !== "string" || !p.activity.trim()) continue;
    const t = at(p.when_hint);
    if (t == null) continue;
    // A minute-resolution hint is inside the minute the stop began in.
    const s = stops.find((x) => !(x.excursion || x.is_movement || x.user_non_stop)
      && Math.floor(x.start_ts_ms / 60_000) * 60_000 <= t && t <= x.end_ts_ms
      && ((x.place && x.place.name && nameSimilarity(x.place.name, p.venue) >= 0.9)
        || (x.place && x.place.source === "user_confirmed"
          && x.confirmed_row && x.confirmed_row.place_type === "user-confirmed")));
    if (!s) continue;
    s.his_words = [...(s.his_words || []), { venue: p.venue, activity: p.activity, evidence: p.evidence || null }];
    applied.push({ id: s.id, venue: p.venue, activity: p.activity });
  }
  return applied;
}

// A day-statements "HH:MM" (the model's reading of when, in the day's zone) as epoch ms.
function statementClock(statements, dateStr) {
  if (!statements || !dateStr) return null;
  const tz = (statements._meta && statements._meta.tz) || DAY_BOUNDARY_TZ;
  const day0 = zonedMidnightMs(dateStr, tz);
  return (v) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "")); // lang-regex-ok: a model-emitted HH:MM stamp
    return m ? day0 + Number(m[1]) * 3600_000 + Number(m[2]) * 60_000 : null;
  };
}

// A stretch he described as movement has people on it too (2026-10-18: "We
// (the three of us) had our morning coffee at the café, then took the dog for a
// long walk along the beach" put the partner on the café and nobody on the walk). It
// has no venue to bind by, so it binds by the window the model gave (from/to)
// to the walk or drive block that window mostly covers, or that mostly covers it.
// Runs after every pass that builds such blocks (the non-stop walks, the gap
// loops): the walk above was built by those, after the places were bound.
function applyNonStopCompanions(stops, statements, dateStr) {
  const applied = [];
  if (!statements || process.env.JORI_WORD_COMPANIONS === "0") return applied;
  const at = statementClock(statements, dateStr);
  for (const n of statements.non_stops || []) {
    const who = (n.companions || []).filter(x => typeof x === "string" && x.trim());
    const from = at(n.from), to = at(n.to);
    if (!who.length || from == null || to == null || to <= from) continue;
    for (const s of stops) {
      if (!(s.excursion || s.is_movement || s.user_non_stop)) continue;
      const ov = Math.min(s.end_ts_ms, to) - Math.max(s.start_ts_ms, from);
      if (ov < 0.5 * Math.min(to - from, s.end_ts_ms - s.start_ts_ms)) continue;
      const before = new Set(s.companions || []);
      s.companions = [...before, ...who.filter(w => !before.has(w))];
      applied.push({ id: s.id, non_stop: true, companions: who, evidence: n.evidence || null });
    }
  }
  return applied;
}

// One stay in pieces, put back together (2026-10-17). mergeDuplicateStops runs
// mid-pipeline; addSpineDwells, the gap loops and the silence extension all run
// after it, and nothing merged what they left. 2026-10-16 shipped the rented flat
// as four headers: 05:39-05:49 from a visit row, 05:49-14:17 built by the spine
// borrowing that row's name, 14:17-15:38 from a confirmed row. Two stops with the
// same name that touch in time (he went nowhere between them) are one stop. The
// earlier keeps its id; the more authoritative place wins the name.
const TOUCH_MERGE_GAP_MS = 2 * 60_000;
const PLACE_SOURCE_RANK = { user_confirmed: 6, named_location: 5, accommodation: 5, known_recurring: 4,
                            confirmed_stop: 3, photo_text: 3, saved_place: 2, spine_dwell: 1 };
function mergeTouchingSameName(stops) {
  const merged = [];
  if (process.env.JORI_TOUCH_MERGE === "0") return { stops, merged };
  const moving = (x) => x.excursion || x.is_movement || x.user_non_stop;
  const out = [];
  for (const s of [...stops].sort((a, b) => a.start_ts_ms - b.start_ts_ms)) {
    const prev = out[out.length - 1];
    const a = prev && prev.place && prev.place.name, b = s.place && s.place.name;
    if (!prev || moving(prev) || moving(s) || !a || !b || nameSimilarity(a, b) < 0.9
        || s.start_ts_ms - prev.end_ts_ms > TOUCH_MERGE_GAP_MS
        || (prev.lat != null && s.lat != null && haversineMeters(prev.lat, prev.lon, s.lat, s.lon) > DUP_MERGE_M_FUZZY)) {
      out.push(s);
      continue;
    }
    const was = [`${prev.start}–${prev.end}`, `${s.start}–${s.end}`];
    if ((PLACE_SOURCE_RANK[s.place.source] || 0) > (PLACE_SOURCE_RANK[prev.place.source] || 0)) {
      prev.place = s.place;
      prev.confirmed_row = s.confirmed_row || prev.confirmed_row;
      if (s.lat != null) { prev.lat = s.lat; prev.lon = s.lon; }
    }
    prev.end_ts_ms = Math.max(prev.end_ts_ms, s.end_ts_ms);
    prev.end = hmFromMs(prev.end_ts_ms);
    prev.duration_min = Math.round((prev.end_ts_ms - prev.start_ts_ms) / 60_000);
    const seen = new Set((prev.photos || []).map(p => p.uuid));
    prev.photos = [...(prev.photos || []), ...(s.photos || []).filter(p => !seen.has(p.uuid))];
    prev.companions = [...new Set([...(prev.companions || []), ...(s.companions || [])])];
    prev.calendar_event = prev.calendar_event || s.calendar_event;
    const m = merged.find(x => x.id === prev.id);
    if (m) { m.was.push(was[1]); m.absorbed.push(s.id); m.now = `${prev.start}–${prev.end}`; }
    else merged.push({ id: prev.id, name: prev.place.name, was, absorbed: [s.id], now: `${prev.start}–${prev.end}` });
  }
  return { stops: out, merged };
}

// A venue stop cannot begin while he sleeps (2026-10-15). widensThroughSleep
// stops the passes that STRETCH a stop back through the night; this covers a
// stop that is already that long when it reaches them -- a raw cluster that
// starts at the day window's start. While the day was cut at home midnight
// (07:00 local) a night at the flat never reached the raw stops; cut at
// local midnight the whole night is one cluster, and the flat is 93 m from
// the café, so it is named for the café ("12:00am · the café"). The
// night is carried by the night paragraph, not by a venue: hold the start at his
// first fix after he woke (else the wake itself). The places he sleeps (lodging,
// named homes, recurring stops, anything he named) keep their overnight block.
//
// Without a Watch night the phone's wake stands in, but then only a stop that
// spent three hours or more of the morning before it is held: a phone-wake can
// be a bathroom trip, the Watch's cannot.
//
// A place he has confirmed spending a NIGHT at is one of the places he sleeps,
// whatever rung named it today (the daily-summary fix loop, 2026-10-15). This
// trip's stay is a manual travel row, not a lodging one, so applyAccommodation
// never marks the rented flat: it reaches here as a `confirmed_stop` (the 30 m
// match to his own "The Rented Flat") and was held like a café. Oct 15 then read
// "12:36am · 6h 38m between stops" from the end of dinner to 7:15am, and Oct 16's
// night at the flat shrank to 04:28-04:43. One of his confirmations whose own
// window ran four hours or more through 03:00 local (`placesSleptAt`), within
// SPINE_SAME_PLACE_M of the stop and under the same name, keeps its overnight
// block. No confirmation of the café ever covered a night, so the Oct 14
// café-named night is still held.
const HOLD_MIN_OVERLAP_MS = 60 * 60_000;
const HOLD_MIN_OVERLAP_PHONE_MS = 3 * 3600_000;
const SLEPT_AT_MIN_MS = 4 * 3600_000;
function placesSleptAt(entries, tzFor = timezoneForCoords) {
  const out = [];
  for (const e of entries || []) {
    const w = e && e.stop_window;
    const c = e && (e.centroid || e.coords);
    const lat = Array.isArray(c) ? c[0] : c && c.lat;
    const lon = Array.isArray(c) ? c[1] : c && c.lon;
    if (!e || !e.name || !w || lat == null || lon == null) continue;
    const a = Date.parse(w.start), b = Date.parse(w.end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b - a < SLEPT_AT_MIN_MS) continue;
    const tz = tzFor(lat, lon) || DAY_BOUNDARY_TZ;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(a));
    const threeAm = (d) => zonedMidnightMs(d, tz) + 3 * 3600_000;
    if ([threeAm(day), threeAm(addDays(day, 1))].some(t => t >= a && t <= b)) {
      out.push({ name: e.name, lat: Number(lat), lon: Number(lon) });
    }
  }
  return out;
}
function sleptAtStop(s, sleptAt) {
  const name = s.place && s.place.name;
  return Boolean(name && Number.isFinite(s.lat) && Number.isFinite(s.lon)
    && (sleptAt || []).some(p => p.name === name
      && haversineMeters(s.lat, s.lon, p.lat, p.lon) <= SPINE_SAME_PLACE_M));
}
// The day's last stop, when it runs on past midnight and nothing named it, takes
// its name from where the night's own fixes rest (the daily-summary fix loop,
// 2026-10-15). He came back from the comedy show at 23:52 and the arrival fix
// sat on a side street, 78 m from the rented flat, where the car stopped; from
// 00:13 every fix sat 5 m from the flat. The day ends at midnight, so the stop
// had eight minutes, no rest of its own and no name, and the summary ended on a
// stop the review could only call "null". The first rest in the next three hours
// names it, if that rest is within SPINE_SAME_PLACE_M of the stop (the same stay,
// not somewhere he went next) and on one of his confirmations (30 m). A bar near
// the flat that he stayed at past midnight rests at the bar, so it is never
// renamed for the flat.
const NIGHT_LOOKAHEAD_MS = 3 * 3600_000;
async function nameDayEndFromNight(stops, dayEndMs, entries, fetchPings = fetchPingsBetween) {
  const last = stops[stops.length - 1];
  if (!last || (last.place && last.place.name) || last.user_non_stop || last.is_movement || last.excursion) return null;
  if (!Number.isFinite(last.lat) || !Number.isFinite(last.lon) || !(last.end_ts_ms >= dayEndMs - 60_000)) return null;
  const pings = await fetchPings(dayEndMs, dayEndMs + NIGHT_LOOKAHEAD_MS);
  const rest = findRests(pings, dayEndMs, dayEndMs + NIGHT_LOOKAHEAD_MS)[0];
  if (!rest) return null;
  const apart = haversineMeters(rest.lat, rest.lon, last.lat, last.lon);
  if (apart > SPINE_SAME_PLACE_M) return null;
  const conf = matchConfirmedRest(entries, rest.lat, rest.lon);
  if (!conf) return null;
  last.place = { ...(last.place || {}), name: conf.entry.name, source: "confirmed_stop", confidence: 0.9,
                 distance_m: Math.round(conf.distance_m) };
  last.unnamed = false;
  last.named_from_night = { rest_from: hmFromMs(rest.start_ms), rest_m_from_stop: Math.round(apart) };
  return { id: last.id, name: conf.entry.name, rest_from: hmFromMs(rest.start_ms), rest_m_from_stop: Math.round(apart) };
}

function holdStartsAtWake(stops, pings, asleep, approx = false, sleptAt = null) {
  const out = [];
  if (!asleep || !Number.isFinite(asleep.to_ms) || !Number.isFinite(asleep.from_ms)) return out;
  const minOverlap = approx ? HOLD_MIN_OVERLAP_PHONE_MS : HOLD_MIN_OVERLAP_MS;
  for (const s of stops) {
    if (s.accommodation || s.is_movement || s.user_non_stop || s.excursion) continue;
    if (sleepExempt(s, asleep)) continue;
    if (sleptAtStop(s, sleptAt)) continue;
    if (!(s.end_ts_ms > asleep.to_ms)) continue;
    const overlap = Math.min(s.end_ts_ms, asleep.to_ms) - Math.max(s.start_ts_ms, asleep.from_ms);
    if (overlap < minOverlap) continue;
    let from = asleep.to_ms;
    if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) {
      const first = usablePings(pings, asleep.to_ms, s.end_ts_ms)
        .find(q => haversineMeters(s.lat, s.lon, q.lat, q.lon) <= SPINE_SAME_PLACE_M);
      if (first) from = first.ts;
    }
    const was = `${s.start}\u2013${s.end}`;
    s.start_ts_ms = from;
    s.start = hmFromMs(from);
    s.duration_min = Math.round((s.end_ts_ms - s.start_ts_ms) / 60000);
    s.start_held_at_wake = true;
    out.push({ id: s.id, name: (s.place && s.place.name) || null, source: (s.place && s.place.source) || null,
               was, now: `${s.start}\u2013${s.end}`, woke: hmFromMs(asleep.to_ms), basis: approx ? "phone" : "watch" });
  }
  return out;
}

function dropUnrestedStops(stops, pings) {
  const dropped = [];
  if (!pings.length) return { stops, dropped };
  const kept = [];
  for (const s of stops) {
    const src = (s.place && s.place.source) || "";
    // A resolver GUESS is not a name for this purpose — it is the nearest POI to
    // a window whose existence is what's in question, and keeping the stop
    // because the guesser filled it in is circular. Only a settled identity
    // protects a window.
    if (RESOLVER_SETTLED.has(src) || s.user_non_stop) { kept.push(s); continue; }
    if ((s.photos || []).length) { kept.push(s); continue; }
    const seen = usablePings(pings, s.start_ts_ms, s.end_ts_ms).length;
    if (seen < 2) { kept.push(s); continue; }      // cannot see it: leave it alone
    if (findRests(pings, s.start_ts_ms, s.end_ts_ms).length) { kept.push(s); continue; }
    const minutes = s.duration_min != null ? s.duration_min : (s.end_ts_ms - s.start_ts_ms) / 60_000;
    const record = { start: s.start, end: s.end, start_ts_ms: s.start_ts_ms, end_ts_ms: s.end_ts_ms,
                      minutes: s.duration_min,
                      fixes: seen, precise_fixes: preciseCount(pings, s.start_ts_ms, s.end_ts_ms),
                      reason: "no rest the fixes can support — passing through" };
    // Bracketed by the same place, it is an out-and-back from there, not a
    // stop — and "unlabeled" in the email is exactly the wrong thing to say
    // about it. 2026-10-05: 15:05–15:50 between two stays at the rented flat,
    // 3 precise fixes, no rest, shipped as "3:06pm · unlabeled" (the user: "If
    // we're not confident it's a separate location, why list it as such?").
    // The walk itself still reaches the day through excursions[].
    const i = stops.indexOf(s);
    const prev = stops.slice(0, i).reverse().find(o => o.lat != null && o.end_ts_ms <= s.start_ts_ms + 60_000);
    const next = stops.slice(i + 1).find(o => o.lat != null && o.start_ts_ms >= s.end_ts_ms - 60_000);
    const sameBase = prev && next
      && haversineMeters(prev.lat, prev.lon, next.lat, next.lon) <= SPINE_SAME_PLACE_M;
    if (sameBase) record.reason = "out and back from the same place — not a stop";
    // The stop's position has to be where a precise fix stood. When every
    // usable fix in its window sits away from that position, the position came
    // from imprecise rows alone (a cell-tower reading, accuracy in kilometres):
    // there is no place to ask about, only the walk around it.
    const placed = !(Number.isFinite(s.lat) && Number.isFinite(s.lon))
      || usablePings(pings, s.start_ts_ms, s.end_ts_ms)
        .some(q => haversineMeters(s.lat, s.lon, q.lat, q.lon) <= SPINE_SAME_PLACE_M);
    if (!placed && !sameBase) record.reason = "no precise fix sits at its position — a cell-tower reading, not a place";
    if (minutes >= UNRESTED_KEEP_MIN && !sameBase && placed) {
      record.kept_as_unknown = true;
      s.place = { name: null, address: null, source: "unknown", confidence: 0, distance_m: null };
      s.unnamed = true;
      s.unrested = true;
      kept.push(s);
    }
    dropped.push(record);
  }
  return { stops: kept, dropped };
}

// A known-recurring name has to be a place he STOOD, not a place his average
// position landed near. a chain store's centroid match on 2026-08-31 was 72 m
// — inside its 80 m proximity — for a window whose fixes ran 75-288 m away the
// whole time. Strip a name the trace cannot support; the stop stays, unnamed,
// and becomes a question he can answer in one tap.
function verifyKnownAgainstRest(stops, pings, ctx) {
  const stripped = [];
  if (!pings.length) return stripped;
  const byName = new Map((ctx.knownStopsEntries || []).map(e => [e.name, e]));
  for (const s of stops) {
    if ((s.place && s.place.source) !== "known_recurring") continue;
    const entry = byName.get(s.place.name);
    if (!entry || !entry.coords) continue;
    const prox = entry.proximity_m || 80;
    const rest = restAt(pings, s.start_ts_ms, s.end_ts_ms, entry.coords, prox);
    if (rest) {
      s.rest_verified = {
        minutes: rest.minutes, distance_m: rest.distance_m,
        // How much of the claim the fixes actually witness, versus how much is
        // inferred from the phone going quiet. 80 of 193 rests over the 28 days
        // to 2026-08-31 witness under half their own span — that is normal for a
        // still phone, not a defect, but the narrator should know which it has.
        witnessed_min: rest.witnessed_min, precise_fixes: rest.precise_count,
        corroborated_by: rest.corroborated_by,
      };
      continue;
    }
    stripped.push({ was: s.place.name, start: s.start, end: s.end,
                    proximity_m: prox, centroid_distance_m: s.place.distance_m,
                    reason: "no rest inside the place's own proximity radius" });
    s.place = { name: null, address: null, source: "unknown", confidence: 0, distance_m: null };
    s.unnamed = true;
    const gated = gatedPlaceFromPoint(s.lat, s.lon, new Date(s.start_ts_ms).toISOString());
    if (gated && gated.source !== "known_recurring") {
      s.place = { name: gated.name, address: gated.address || null, source: gated.source,
                  confidence: Math.min(gated.confidence, 0.55), distance_m: null };
    }
  }
  return stripped;
}

// ---------------------------------------------------------------------------
// His own saved places — matched at the REST, never at the centroid
// ---------------------------------------------------------------------------
//
// 2026-09-02: a 34-minute dinner at a pizzeria shipped as
// "7:34pm · unlabeled". Every rung held part of the answer and none could spend
// it. `day-segments` wrote the right name onto the visit row from its own saved
// rung (11/11 fixes contained, within 15 m) — but this file only lifts a name
// off a visit row when its place_type is `user-confirmed` or `named`, so a
// `segment-derived` name is invisible here. `stop-identify` has a `favorite`
// tier for exactly this case — *"a place he saved in Google Maps, within the
// same 30m ... 2328 of them exist and they are his own labels"* — but it only
// decides whether to ASK, it never names anything. And `location-segment`'s
// resolve_place ladder (named_location → confirmed_stop → known_recurring →
// wifi_ssid → OSM/Google) has no saved rung at all, so the day's own resolver
// could reach nothing better than the nearest POI. It guessed "RHYTHM ZERO |
// <NEIGHBOURHOOD>", unnameGuesses correctly stripped that as a guess, and the stop
// shipped nameless with 2328 of his own labels sitting unread on disk.
//
// The match runs against the REST, never the stop's centroid, and that is not a
// refinement — it is the difference between right and confidently wrong:
//
//   from the rest (14 fixes, 19:49-20:08)  Pizzeria A 9 m · Pizzeria B 65 m
//   from the visit centroid                Pizzeria B 23 m · Pizzeria A 63 m
//
// The centroid averages in the walk down the street and INVERTS the answer. That
// is why `findme enrich` offered Pizzeria B while day-segments offered Pizzeria
// TOO! from the same trace — they were standing in different places. A centroid
// is a summary statistic, not a place he was.
//
// Two guards stop this from manufacturing stops, which is the failure the user
// named on 2026-09-01 (*"it shouldn't be an unlabeled stop even if it's a
// favorited place"*):
//   * no rest, no name — a saved place he merely walked past never earns one,
//     and the window still falls to dropUnrestedStops exactly as before;
//   * a tie is not an answer — a second saved place inside the radius leaves the
//     stop unnamed for the ask, rather than picking the nearer by metres.
const SAVED_PLACES_PATH = path.join(JORI, "data/google-saved-places.json");
// Same radius stop-identify's `favorite` tier uses. His own label 30 m away is
// the place; a saved place further out than that is a coincidence of the block.
const SAVED_PLACE_MATCH_M = 30;
// Naming needs 30 m. A QUESTION can reach further: offering him three of his own
// saved places to tap costs nothing if none of them is right, and "I didn't
// capture a label. Tell me?" with no candidates — what 2026-09-02 shipped — is
// not a question he can answer in one tap.
const SAVED_PLACE_ASK_M = 200;

// Further saved-place lists in the same shape ({places: [{name, lat, lng,
// address, place_id}]}), e.g. one a places app keeps live (imported ∪ marks −
// clears, synced daily), while the Google export above is a snapshot that only
// moves when the user re-exports. A place marked after the last export is the
// user's label too, and the export alone left it invisible (2026-10-26: a lunch
// 22 m from such a mark shipped as a bare street address). Config:
// agent/local/config/place-naming.json `extra_saved_places` (file names in the
// installation's data/; shared with lib/place_naming.py); none by default.
const EXTRA_SAVED_PLACES_PATHS = (localConfig("place-naming", { extra_saved_places: [] }).extra_saved_places || [])
  .map((f) => (path.isAbsolute(f) ? f : f.includes("/") ? path.join(JORI, f) : path.join(JORI, "data", f)));

function readPlaceList(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(raw && raw.places) ? raw.places : [];
    return list
      .filter(p => p && p.name && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)))
      .map(p => ({ name: p.name, lat: Number(p.lat), lon: Number(p.lng),
                   address: p.address || null, place_id: p.place_id || null }));
  } catch {
    // Absent on a laptop checkout — the same reason day-segments guards its own
    // saved rung. No file means no rung, never a crash.
    return [];
  }
}

// The same venue in both lists must stay ONE place: two entries inside the radius
// would read as a tie, and a tie is never an answer.
function mergeSavedLists(primary, extra) {
  const ids = new Set(primary.map(p => p.place_id).filter(Boolean));
  const out = primary.slice();
  for (const p of extra) {
    if (p.place_id && ids.has(p.place_id)) continue;
    const twin = out.some(q => String(q.name).toLowerCase() === String(p.name).toLowerCase()
      && haversineMeters(q.lat, q.lon, p.lat, p.lon) <= SAVED_PLACE_MATCH_M);
    if (!twin) out.push(p);
  }
  return out;
}

let _savedPlacesCache = null;
function loadSavedPlaces() {
  if (_savedPlacesCache) return _savedPlacesCache;
  _savedPlacesCache = EXTRA_SAVED_PLACES_PATHS.reduce((acc, f) => mergeSavedLists(acc, readPlaceList(f)),
    readPlaceList(SAVED_PLACES_PATH));
  return _savedPlacesCache;
}

// Saved places within `radiusM` of a point, nearest first. `places` is for
// tests — the file is a 1 MB export that only exists on the mini, the same
// reason day-segments guards its own saved rung.
function savedPlacesNear(lat, lon, radiusM, places) {
  const out = [];
  for (const p of places || loadSavedPlaces()) {
    const d = haversineMeters(lat, lon, p.lat, p.lon);
    if (d <= radiusM) out.push({ ...p, distance_m: Math.round(d) });
  }
  return out.sort((a, b) => a.distance_m - b.distance_m);
}

// A rest's centroid is still a centroid. findRests is greedy against a RUNNING
// centroid inside a 75 m radius, so an unhurried walk down a block chains into
// one "rest" whose mean can land on a doorway nobody stopped at — the same
// shape as the a chain store blend (72 m centroid match, fixes 75-288 m away)
// one level down. So ask the fixes, not their average: most of them have to be
// at the place, or he was walking past it.
function restSatAt(pings, rest, place) {
  const pts = usablePings(pings, rest.start_ms, rest.end_ms);
  if (pts.length < 2) return false;
  const at = pts.filter(p => haversineMeters(p.lat, p.lon, place.lat, place.lon) <= SAVED_PLACE_MATCH_M);
  return at.length >= 2 && at.length * 2 >= pts.length;
}

function nameFromSavedPlaces(stops, pings, opts = {}) {
  const places = opts.savedPlaces || null;
  const named = [];
  const ambiguous = [];
  if (!pings.length) return { named, ambiguous };
  for (const s of stops) {
    const src = (s.place && s.place.source) || "";
    if (RESOLVER_SETTLED.has(src) || s.user_non_stop || s.is_movement) continue;
    // Only a nameless stop or one holding a resolver guess is up for this. A
    // calendar or photo_gps label is evidence of its own and outranks a
    // proximity match.
    if (s.place && s.place.name && !GUESS_SOURCES.has(src)) continue;
    const rests = findRests(pings, s.start_ts_ms, s.end_ts_ms);
    if (!rests.length) continue;
    // The longest rest is the one the stop is ABOUT; a two-minute pause at the
    // door on the way in should not get to name the evening.
    const rest = rests.reduce((a, b) => (b.minutes > a.minutes ? b : a));
    const near = savedPlacesNear(rest.lat, rest.lon, SAVED_PLACE_MATCH_M, places)
      .filter(p => restSatAt(pings, rest, p));
    if (near.length !== 1) {
      // Named or not, the rest is a real place he stood, and his own saved
      // places around it are the best tap-list the ask will ever get — better
      // than the POI guesses `alternatives` carries, because these are his
      // labels. Widen once for the question only; naming still needs 30 m.
      const forAsk = savedPlacesNear(rest.lat, rest.lon, SAVED_PLACE_ASK_M, places);
      if (forAsk.length) {
        s.saved_place_candidates = forAsk.map(p => ({ name: p.name, address: p.address,
                                                     distance_m: p.distance_m }));
      }
      if (near.length > 1) {
        ambiguous.push({ start: s.start, end: s.end,
                         candidates: near.map(p => ({ name: p.name, distance_m: p.distance_m })),
                         reason: "more than one saved place at the rest — ask, don't pick" });
      }
      continue;
    }
    const hit = near[0];
    named.push({ start: s.start, end: s.end, name: hit.name, distance_m: hit.distance_m,
                 was: (s.place && s.place.name) || null,
                 rest_min: rest.minutes, rest_fixes: rest.sample_count });
    s.place = { name: hit.name, address: hit.address, source: "saved_place",
                confidence: 0.9, distance_m: hit.distance_m };
    s.unnamed = false;
    s.rest_verified = { minutes: rest.minutes, distance_m: hit.distance_m,
                        witnessed_min: rest.witnessed_min, precise_fixes: rest.precise_count,
                        corroborated_by: rest.corroborated_by };
  }
  return { named, ambiguous };
}

// ---------------------------------------------------------------------------
// Possible unlogged excursions inside a long dwell
// ---------------------------------------------------------------------------
//
// iOS's own visit detection -- the source of the long "at home"/"at the
// apartment" dwells this file treats as a single stop -- only emits a
// departure when it's confident enough. A short trip out and back is well
// within the noise it tolerates, so the whole span stays one uninterrupted
// visit with no seam anywhere for this file's own clustering to find.
//
// (2026-08-11 incident: an ~86-minute stretch with zero GPS samples, bracketed
// by fixes showing ~30-40m of real movement right before it began, sat inside
// a single ~12-hour "at the apartment" dwell in that night's summary. Nothing
// downstream had a seam to work with, so the narrative folded it silently
// into "at the apartment" with no mention at all.)
//
// This does NOT touch stop clustering or resolution -- it only reads the raw
// GPS underneath an already-resolved long dwell and, if it finds a sampling
// silence that's both long and bracketed by real displacement (not just
// indoor GPS drift), attaches a fact the narrator can choose how to phrase
// (Rule #0b: this decides WHETHER a gap is notable, never what to say about
// it). A false positive costs one uncertain aside; a false negative is the
// status quo this fix is written against.
const UNLOGGED_EXCURSION_MIN_DWELL_MIN = 120; // only worth checking a genuinely long stay
const UNLOGGED_EXCURSION_MIN_GAP_MIN = 45;    // shorter gaps are ordinary indoor GPS silence
const UNLOGGED_EXCURSION_MIN_BRACKET_M = 25;  // must bracket real movement, not drift

async function flagUnloggedExcursions(stops, dateStr) {
  const candidates = (stops || []).filter(
    (s) => !s.is_movement && !s.user_non_stop && (s.duration_min || 0) >= UNLOGGED_EXCURSION_MIN_DWELL_MIN,
  );
  if (!candidates.length) return;

  const startIso = etBoundaryUtcIso(dateStr);
  const endIso = etBoundaryUtcIso(addDays(dateStr, 1));
  // One query for the whole day's raw pings rather than one per dwell -- a
  // long day can have several qualifying stops and this table is already big.
  const rows = await supabaseSelect(
    "location_history",
    `select=latitude,longitude,arrived_at&arrived_at=gte.${encodeURIComponent(startIso)}` +
      `&arrived_at=lte.${encodeURIComponent(endIso)}&order=arrived_at.asc&limit=20000`,
  );
  if (!Array.isArray(rows) || rows.length < 2) return;
  const pings = rows
    .map((r) => ({ ts: Date.parse(r.arrived_at), lat: Number(r.latitude), lon: Number(r.longitude) }))
    .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .sort((a, b) => a.ts - b.ts);
  if (pings.length < 2) return;

  for (const s of candidates) {
    const within = pings.filter((p) => p.ts >= s.start_ts_ms && p.ts <= s.end_ts_ms);
    if (within.length < 2) continue;
    let best = null;
    for (let i = 0; i < within.length - 1; i++) {
      const gapMin = (within[i + 1].ts - within[i].ts) / 60_000;
      if (gapMin < UNLOGGED_EXCURSION_MIN_GAP_MIN) continue;
      const meters = haversineMeters(within[i].lat, within[i].lon, within[i + 1].lat, within[i + 1].lon);
      if (meters < UNLOGGED_EXCURSION_MIN_BRACKET_M) continue; // drift, not a real trip out
      if (!best || gapMin > best.gapMin) best = { gapMin, startTs: within[i].ts, endTs: within[i + 1].ts, meters };
    }
    if (best) {
      s.possible_unlogged_excursion = {
        start: hmFromMs(best.startTs, s.tz || DISPLAY_TZ),
        end: hmFromMs(best.endTs, s.tz || DISPLAY_TZ),
        gap_min: Math.round(best.gapMin),
        meters: Math.round(best.meters),
      };
    }
  }
}

/**
 * Decide WHICH stops and which photos the photo-text pass may look at, then run
 * it. The split is the Rule #0b line: everything positional — is this stop still
 * nameless, did the trace actually rest here, was the photo taken inside that
 * rest — is settled here in code, and only the question "do these words name a
 * business?" reaches a model.
 */
async function namePhotoTextStops(stops, pings, photoRows) {
  const byUuid = new Map();
  for (const p of photoRows || []) {
    const tokens = Array.isArray(p.detected_text) ? p.detected_text : [];
    if (tokens.length) byUuid.set(p.uuid, { tokens, labels: Array.isArray(p.labels) ? p.labels : [] });
  }
  if (!byUuid.size) return { named: [], declined: [], calls: 0 };

  let eligible = 0;
  for (const s of stops) {
    s.photo_text_eligible = null;
    // Every stop, named or not (2026-10-08, the user: "The photo always should
    // take precedence"). The 11:37 café kept the tax office's name —
    // an answer that had spilled onto it — while the user's photo showed the café's
    // sign; a named stop was never shown its own photos. Only windows that
    // were not stops are skipped. A sign spelling the current name is a no-op.
    if (s.user_non_stop || s.is_movement) continue;
    const rests = findRests(pings, s.start_ts_ms, s.end_ts_ms);
    if (!rests.length) continue;
    const rest = rests.reduce((a, b) => (b.minutes > a.minutes ? b : a));
    const inRest = (s.photos || [])
      .filter(ph => ph.self_captured !== false && byUuid.has(ph.uuid))
      .filter(ph => {
        const t = Date.parse(ph.ts);
        return Number.isFinite(t) && t >= rest.start_ms && t <= rest.end_ms;
      })
      .map(ph => ph.uuid);
    if (!inRest.length) continue;
    s.photo_text_eligible = inRest;
    eligible += 1;
  }
  if (!eligible) return { named: [], declined: [], calls: 0 };

  try {
    return await nameStopsFromPhotoText(stops, uuid => byUuid.get(uuid) || null, {
      savedPlacesNear: (lat, lon, radiusM) => savedPlacesNear(lat, lon, radiusM),
      // Accurate on-device OCR of the photo the pass picked (lines, in order).
      readPhoto: (uuid) => {
        const r = require("node:child_process").spawnSync(path.join(__dirname, "..", "bin", "photo-ocr"), [uuid],
          { encoding: "utf8", timeout: 240000 });
        const out = JSON.parse(r.stdout || "{}");
        return (out.lines || []).filter(l => (l.confidence ?? 1) >= 0.3).map(l => l.text);
      },
    });
  } catch (e) {
    // Never let a naming pass take the day down: an unnamed stop is the status
    // quo, a thrown resolve is a missing summary.
    process.stderr.write(`[resolve-day] photo-text naming unavailable (${(e && e.message) || e})\n`);
    return { named: [], declined: [{ reason: `pass failed: ${(e && e.message) || e}` }], calls: 0 };
  }
}

// Carry saved_place / photo_text names onto their visit rows. Fail-open: a
// write that cannot happen leaves the day exactly as it was; the plan and the
// outcome are returned so the day JSON records both.
async function writeBackEarnedNames(stops, pings, { enabled = true } = {}) {
  const out = { done: [], failed: [], skipped: [], planned: 0 };
  const candidates = (stops || []).filter(s => s.place && ["saved_place", "photo_text"].includes(s.place.source));
  if (!enabled || !candidates.length) return out;
  const fromMs = Math.min(...candidates.map(s => s.start_ts_ms)) - 30 * 60_000;
  const toMs = Math.max(...candidates.map(s => s.end_ts_ms)) + 30 * 60_000;
  const rows = await supabaseSelect("location_history",
    `select=id,latitude,longitude,arrived_at,departed_at,place_name,place_type,notes` +
    `&segment_type=eq.visit` +
    `&arrived_at=gte.${encodeURIComponent(new Date(fromMs).toISOString())}` +
    `&arrived_at=lte.${encodeURIComponent(new Date(toMs).toISOString())}` +
    `&order=arrived_at.asc&limit=200`);
  if (!Array.isArray(rows)) return out;
  const plan = planNameWriteBack(candidates, rows, pings);
  out.skipped = plan.skipped;
  out.planned = plan.writes.length;
  if (!plan.writes.length) return out;
  const notesById = new Map(rows.map(r => [r.id, r.notes || null]));
  const applied = await applyNameWriteBack(plan, {
    patch: (id, body) => supabaseRequest(`/rest/v1/location_history?id=eq.${encodeURIComponent(id)}`,
      { method: "PATCH", body, prefer: "return=minimal" }),
    rowNotes: id => notesById.get(id) || null,
  });
  out.done = applied.done;
  out.failed = applied.failed;
  for (const w of applied.done) {
    process.stderr.write(`[resolve-day] wrote back "${w.name}" (${w.source}) onto visit ${w.row}` +
      ` — was ${w.was_type || "untyped"} "${w.was_name || ""}", ${w.rest_distance_m} m from the rest\n`);
  }
  for (const f of applied.failed) {
    process.stderr.write(`[resolve-day] write-back of "${f.name}" onto ${f.row} failed: ${f.error}\n`);
  }
  return out;
}

const SPINE_MODE_WORD = { walking: "walked", riding: "rode", driving: "drove" };
function supersedeRouteModesBySpine(routes, spine) {
  const legs = (spine || []).filter(n => n.type === "leg" && n.start_ms && n.end_ms);
  if (!legs.length) return routes;
  for (const r of routes) {
    for (const leg of r.legs || []) {
      const a = Date.parse(leg.start), b = Date.parse(leg.end);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
      let best = null, bestOv = 0;
      for (const sl of legs) {
        const ov = Math.min(b, sl.end_ms) - Math.max(a, sl.start_ms);
        if (ov > bestOv) { best = sl; bestOv = ov; }
      }
      if (!best || bestOv < (b - a) * 0.5) continue;
      const word = SPINE_MODE_WORD[best.mode];
      if (!word || word === leg.mode) continue;
      leg.mode_was = leg.mode;
      leg.mode = word;
      leg.mode_uncertain = !!best.mode_uncertain;
      leg.spine_leg = best.id;
    }
  }
  return routes;
}

async function resolveDay(dateStr, { skipCalendar = false, displayTz = null, writeBack = process.env.JORI_NAME_WRITEBACK !== "0" } = {}) {
  DISPLAY_TZ = displayTz || HOME_TZ;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`resolveDay: invalid date ${dateStr} (expected YYYY-MM-DD)`);
  }

  // Build the path FIRST: it decides the day window every later fetch uses.
  let dayPath = runDayPath(dateStr, displayTz);
  if (dayPath && dayPath.stats && dayPath.stats.tz) {
    DAY_BOUNDARY_TZ = dayPath.stats.tz;
    if (!displayTz) DISPLAY_TZ = dayPath.stats.tz;
  }

  // The raw fixes, fetched once: three passes want them, and they are also the
  // only geometry the day has when the map-matcher is down (see
  // ensurePathGeometry). Must run before anything measures distance or
  // direction — markMovementByPace's guards read legs too.
  // Fetched here rather than inside the two passes that attach them, because
  // the camera fixes are part of the ping stream now (photoPings) and the OCR
  // is read by the naming pass at the bottom of the ladder.
  const dayPhotoRows = await fetchDayPhotos(dateStr);
  const dayPings = await fetchDayPings(dateStr, dayPhotoRows);
  dayPath = ensurePathGeometry(dayPath, dayPings);

  const raw = await runLocationSegment(dateStr);

  // Photo-GPS gap-fill BEFORE calendar/classify, so calendar events bind to the
  // reconstructed afternoon stops and companions/classification see them too.
  await mergePhotoSynthesizedStops(raw.stops, dateStr);
  // A visit iOS recorded that breadcrumb clustering never saw (the phone goes
  // quiet when he sits still). Runs BEFORE the calendar pass so the event binds
  // to the promoted stop instead of falling to unmatched_calendar_events.
  await mergeOrphanVisitStops(raw.stops, dateStr);
  nameWeakStops(raw.stops);

  // Calendar fusion (post-segment). Annotates overlapping GPS stops with their
  // calendar_event in place, and returns events with no GPS overlap separately
  // — those go into the resolved day's `unmatched_calendar_events[]` so the
  // narrator can list them in a "scheduled, not at" section without pretending
  // they were physical visits.
  let stopsWithCal;
  let unmatchedCal = [];
  if (skipCalendar) {
    stopsWithCal = raw.stops;
  } else {
    const r = await enrichStopsWithCalendar(raw.stops, dateStr);
    stopsWithCal = r.stops;
    unmatchedCal = r.unmatched_calendar_events;
  }

  const known = loadKnownStops();
  if (known.missing) {
    process.stderr.write(`[resolve-day] known-recurring-stops.json missing — matcher disabled\n`);
  } else if (known.entries.length === 0) {
    process.stderr.write(`[resolve-day] known-recurring-stops.json has no active entries (filtered out ${known.filteredOut}) — matcher will always fall through\n`);
  } else {
    const missingCoords = entriesMissingCoords(known.entries);
    if (missingCoords.length > 0) {
      const names = missingCoords.map(e => e.name || "(unnamed)").join(", ");
      process.stderr.write(`[resolve-day] ${missingCoords.length}/${known.entries.length} known-recurring-stops entries lack coords and will not match: ${names}\n`);
    }
  }

  const userConfirmed = await fetchUserConfirmedStops(dateStr);
  // In the zone of where he woke and where he slept, not the day boundary's.
  // Adapted stops carry their position as `centroid` (lat/lon arrive later).
  const zoneOf = (st) => {
    const lat = st && (st.lat ?? (st.centroid && st.centroid.lat));
    const lon = st && (st.lon ?? (st.centroid && st.centroid.lon));
    return (lat != null && lon != null ? timezoneForCoords(lat, lon) : null) || DAY_BOUNDARY_TZ;
  };
  // The night that ENDED this morning, not the one starting tonight (2026-10-08,
  // The user: "when I went to sleep the previous night and when I woke up in the
  // morning"). Tonight's bedtime is unknown when the summary runs anyway; it
  // is tomorrow's summary's first line.
  const wake = await fetchWakeSignal(dateStr, zoneOf(stopsWithCal[0]));
  const sleep = await fetchSleepSignal(addDays(dateStr, -1), zoneOf(stopsWithCal[0]));

  // Merge Supabase companions (populated by findme + photos-daily) onto the
  // adapted stops by time-window overlap + ≤300m centroid distance — segment
  // doesn't fetch them yet.
  const companionRows = await mergeCompanionsFromVisits(stopsWithCal, dateStr);
  // The window each stop had when it took those rows' people (pruneShrunkCompanions).
  for (const s of stopsWithCal) {
    if (!(s.companions || []).length) continue;
    s.companion_merge_window = { start_ts_ms: s.start_ts_ms, end_ts_ms: s.end_ts_ms,
                                 lat: s.centroid?.lat ?? s.lat, lon: s.centroid?.lon ?? s.lon };
  }

  // An orphan-visit stop with a covering physical event takes the event as its
  // identity — see the note in mergeOrphanVisitStops.
  for (const s of stopsWithCal) {
    if (!s._calendar_may_name || !s.calendar_event || !s.calendar_event.physical) continue;
    const ev = s.calendar_event;
    const evStart = Date.parse(ev.start), evEnd = Date.parse(ev.end);
    if (!Number.isFinite(evStart) || !Number.isFinite(evEnd)) continue;
    const overlap = Math.min(evEnd, s.end_ts_ms) - Math.max(evStart, s.start_ts_ms);
    // The event must account for most of the STOP *and* the stop for a real
    // share of the EVENT. Requiring only the first renamed an 11-minute pause on
    // the drive home "<artist> — <festival>" simply because it fell inside
    // the concert's 2.5-hour window, 20 km from the venue, while the actual
    // 101-minute concert stop kept a wrong label. A stop covering 7% of an event
    // is passing through it, not attending it.
    if (overlap / (s.end_ts_ms - s.start_ts_ms) < 0.6) continue;
    if (overlap / (evEnd - evStart) < 0.4) continue;
    s.displaced_label = s.primary && s.primary.name && s.primary.name !== ev.summary ? s.primary.name : null;
    s.primary = { name: ev.summary, address: ev.location || null, source: "calendar_corroborated",
                  confidence: 0.9, distance_km: null };
    // classifyStops re-applies the `user-confirmed` location_history row at
    // weight 110, which would put the displaced label straight back. Suppress
    // that overlay here — the label we just displaced IS that row.
    s._calendar_named = true;
  }

  // RESOLVE_DAY_TRACE=1 prints the stop list after each pass — the fastest way
  // to answer "which pass undid that?" (2026-09-09: a calendar split was being
  // re-merged three passes later and no diagnostic said so).
  const trace = (label) => {
    if (!process.env.RESOLVE_DAY_TRACE) return;
    process.stderr.write(`[trace ${label}] ` + stops.map(x => `${x.start}-${x.end} ${(x.place && x.place.name) || "?"}/${(x.place && x.place.source) || "?"}`).join(" | ") + "\n");
  };
  let stops = classifyStops(stopsWithCal, {
    date: dateStr,
    knownStopsEntries: known.entries,
    userConfirmed,
  });
  // Name the accommodation BEFORE merging: a settled identity is never absorbed
  // into a walk, and "our Airbnb" is exactly that.
  stops = applyAccommodation(stops, await fetchLodgingSegment(dateStr));
  trace("accommodation");
  // A confirmed name reaches only as far as its row; a corroborated event
  // over the rest of the window is its own stop (the market / the movie).
  const calSplit = splitConfirmedStopOnEvent(stops);
  stops = calSplit.stops;
  const stops_split_on_calendar = calSplit.splits;
  trace("calendar-split");
  stops = mergeDuplicateStops(stops, dayPath);
  trace("merge-duplicates");
  stops = mergeWalkChains(stops);
  trace("walk-chains");
  // Give each stop its real window before anything judges it by length.
  const visits_held_at_wake = [];
  const asleepWindow = await fetchAsleepWindow(addDays(dateStr, -1), DAY_BOUNDARY_TZ);
  const visits_widened = widenToBackingVisits(stops, dayPath, asleepWindow, visits_held_at_wake);
  trace("widen");
  stops = dropShortStops(stops);
  trace("drop-short");
  // Pace is measured over the gaps BETWEEN consecutive stops -- the time he was
  // actually in transit -- not over "24h minus dwell", which counts unaccounted
  // time as movement and drags the figure below walking pace.
  const travelGapH = (list) => {
    const o = [...list].sort((x, y) => x.start_ts_ms - y.start_ts_ms);
    let h = 0;
    for (let i = 0; i < o.length - 1; i++) {
      h += Math.max(0, o[i + 1].start_ts_ms - o[i].end_ts_ms) / 3600_000;
    }
    return h;
  };
  const paceBeforeH = travelGapH(stops);
  const confirmed_added = dayPath ? overlayConfirmedVisits(stops, dayPath) : [];
  trace("overlay-confirmed");
  // dedupe again: the overlay can seat two confirmed rows for one venue
  // (location_history held the bouillon twice, split across a GPS drift).
  stops = mergeDuplicateStops(stops, dayPath);
  trace("merge-duplicates");
  // Where did the trace actually stand still? Both passes read progress along
  // the route rather than one averaged point — see lib/stop-rests.js.
  //
  // Position matters. They run AFTER widenToBackingVisits (so a stop has its
  // real window before the trace is asked what happened inside it) and BEFORE
  // markMovementByPace and reconcileStopTimeline: pace over a blended window is
  // an average of walking and standing, and reconcile's job is to trim stops
  // that overlap — on 2026-08-31 it took 29 minutes off the chain-store blend,
  // which deleted the very rest that proves where the store actually was.
  const restCtx = { date: dateStr, knownStopsEntries: known.entries,
                    confirmedStopsEntries: loadConfirmedStopsEntries(), companionRows };
  const splitPass = splitWideStopsOnRests(stops, dayPings, restCtx);
  stops = splitPass.stops;
  trace("split-rests");
  const stops_split_on_rests = splitPass.splits;
  // Splitting can seat a piece alongside the orphan visit that covered the same
  // rest; fold those before anything counts them as two places.
  if (stops_split_on_rests.some(x => !x.kept_whole)) stops = mergeDuplicateStops(stops, dayPath);
  const known_names_stripped = verifyKnownAgainstRest(stops, dayPings, restCtx);
  // After the strip, before the drop. A name stripped above may still be one of
  // his own saved places at the rest, and a window that earns a saved name is a
  // stop — while one that earns nothing stays nameless and falls to the drop
  // below on its own evidence.
  const savedPass = nameFromSavedPlaces(stops, dayPings);
  const stops_named_from_saved = savedPass.named;
  const saved_place_ambiguous = savedPass.ambiguous;
  // Last naming rung, and deliberately below the saved places: a place HE
  // labelled outranks our reading of a sign. This is for what proximity cannot
  // reach — on 2026-09-05 the nearest saved place was 129 m from the rest and
  // the nearest POI 116 m, while the answer was on the awning in the photo he
  // took there. Geometry is decided here; the language goes to a model.
  const photoTextPass = await namePhotoTextStops(stops, dayPings, dayPhotoRows);
  const stops_named_from_photo_text = photoTextPass.named;
  const photo_text_declined = photoTextPass.declined;
  // A name the two rungs above EARNED goes back onto the visit row it stands
  // on (`place_type='named'`), because the map (`day-path`) and the enrich
  // ask-loop (`findme`) read the ROW, not this JSON — on 2026-09-07 the day
  // knew "Jazz Club Example" while the row under it still said "131 Sample St" and
  // the map labelled the stop with the address of a twin row up the block.
  // See lib/stop-name-writeback.js for what may and may not be written.
  const names_written_back = await writeBackEarnedNames(stops, dayPings, { enabled: writeBack });
  // The map was rendered before the naming passes ran; if a row changed under
  // it, draw it again so the summary's picture agrees with its prose.
  if (names_written_back.done.length && dayPath && process.env.JORI_DAY_MAP !== "0") {
    const again = runDayPath(dateStr, displayTz);
    if (again && again.stats && again.stats.map_url) dayPath.stats.map_url = again.stats.map_url;
  }
  // Runs LAST of the three: stripping a name above can leave a stop unnamed, and
  // an unnamed window the trace cannot support is not a stop at all.
  const unrested = dropUnrestedStops(stops, dayPings);
  stops = unrested.stops;
  trace("drop-unrested");
  const stops_dropped_no_rest = unrested.dropped;
  if (stops_dropped_no_rest.length) {
    stops.forEach((s2, i) => { s2.id = s2.id.replace(/-\d+$/, `-${i + 1}`); });
  }

  const paceVerdict = dayPath ? markMovementByPace(stops, dayPath) : { demoted: [], kept: [] };
  const movement_demoted = paceVerdict.demoted;
  // What the pace test WOULD have deleted before the direction guards existed.
  // Kept in the payload so the next "why is my stop missing?" can be answered
  // from the day itself rather than from a re-derivation.
  const movement_kept = paceVerdict.kept;
  const statements = readDayStatements(dateStr);
  const all_stops_declared = statements && statements.all_stops_declared
    ? { declared: !!statements.all_stops_declared.value,
        evidence: statements.all_stops_declared.evidence || null, source: "day-statements" }
    : { declared: false, source: "unavailable" };
  if (all_stops_declared.declared) {
    for (const s2 of stops) {
      const src = (s2.place && s2.place.source) || "";
      const trusted = src === "user_confirmed" || src === "accommodation"
        || src === "named_location" || src === "known_recurring" || src === "confirmed_stop";
      if (!trusted && !s2.is_movement) {
        s2.is_movement = true;
        s2.movement_reason = "you said you had mentioned all the stops";
        movement_demoted.push({ name: s2.place.name, kmh: s2.pace_kmh, min: s2.duration_min,
                                reason: "all-stops-declared" });
      }
    }
  }
  const label_fixes = applyStatementLabels(stops, statements);
  stops = mergeSplitVisits(stops, dayPings);
  // The spine's verdicts on the visit rows come first (2026-09-07): a stop
  // may not claim more time at a place than the reconciled dwells give it,
  // and a stop the trace positively places elsewhere is dropped. Before the
  // reconciler, which otherwise trims REAL stops to make room for a ghost.
  const spineVerdicts = applySpineVerdicts(stops, dayPath);
  stops = spineVerdicts.stops;
  const guesses_unnamed = unnameGuesses(stops);
  const { adjustments: timeline_adjustments, conflicts: timeline_conflicts } =
    reconcileStopTimeline(stops, dayPath);
  // A walk out from the nightly base and back, with nothing named in it, is a
  // slot of its own (2026-09-01) — see lib/day-excursions.js.
  // Runs LAST, on the final stop set: the rule turns on whether anything named
  // survived inside the stretch, so it has to see what every merge, demotion and
  // label pass above decided. Anything named in there and no block is emitted —
  // the named stop is the slot and the walk is just how he got there.
  const excursionPass = await detectExcursions(stops, dayPath, { resolvePoint: resolvePointName });
  stops = excursionPass.stops;
  const excursions = excursionPass.excursions;
  // The spine is the frame (2026-09-07): a major dwell the trace found that no
  // stop above covers becomes a stop, so the narrative walks the same sequence
  // the map draws. Runs last, on the final set, for the same reason the
  // excursion pass does.
  const stops_from_spine = addSpineDwells(stops, dayPath, asleepWindow, visits_held_at_wake, stops_dropped_no_rest);
  const stops_named_on_spine = nameSpineDwells(stops, { ...restCtx, namedLocations: loadNamedLocations() });
  const stops_named_by_address = await nameStopsByAddress(stops);
  // After the spine has added what the trace supports: a place he named for a
  // window the trace never paused in (see addSavedAtStops).
  const stops_from_saved_at = addSavedAtStops(stops, restCtx.confirmedStopsEntries,
    Date.parse(etBoundaryUtcIso(dateStr)), Date.parse(etBoundaryUtcIso(addDays(dateStr, 1))), dayPings);
  // addSpineDwells runs after the companion merge up at stopsWithCal, so a
  // spine-built stop never saw the visit rows' companions: on 2026-10-08 the
  // apartment hour after the café carried the partner and "<a friend>" on its row and
  // rendered with neither (the friend had come back to the apartment with
  // them). Merge again, for the stops the spine added and the ones
  // overlayConfirmedVisits built (see stopsBuiltAfterCompanionMerge).
  const builtAfterMerge = stopsBuiltAfterCompanionMerge(stops);
  if (builtAfterMerge.length) await mergeCompanionsFromVisits(builtAfterMerge, dateStr);
  const companions_from_words = applyStatementCompanions(stops, statements, dateStr);
  // A dwell added (or widened) just above didn't exist yet when dropShortStops
  // gave away a short stop's photos to the nearest-in-time survivor — pull
  // back anything that actually belongs here now. See reclaimMisplacedPhotos.
  // ...and to a stop built from his answer (overlayConfirmedVisits builds those with
  // no photos): 2026-10-16, the photo the user took at the café and the one at
  // a bakery stayed on the flat's stop.
  const photos_reclaimed_by_spine = reclaimMisplacedPhotos(stops, reclaimTargetIds(stops, stops_from_spine), dayPhotoRows);
  const described_non_stops = addDescribedNonStops(stops, userConfirmed);
  const { dropped: non_stops_dropped, walks: non_stop_walks } = await dropUndescribedNonStops(stops, {
    userConfirmed, dayPath, resolvePoint: resolvePointName, hm: hmFromMs, pings: dayPings, statements, dateStr,
  });
  // A loop out of a place and back, inside a gap no stop closes, is an event
  // of its own — a walk, or a drive (day-excursions.js § loops in a gap).
  const loopPass = await detectGapLoops(stops, dayPath, { resolvePoint: resolvePointName, hmFromMs });
  stops = loopPass.stops;
  const gap_loops = loopPass.loops;
  companions_from_words.push(...applyNonStopCompanions(stops, statements, dateStr));
  // Last: the edges of every final stop run on through a silent phone, the day's
  // last one on the fixes after midnight too (JORI_SILENCE_PAST_MIDNIGHT=0: day only).
  const dayEndMs = Date.parse(etBoundaryUtcIso(addDays(dateStr, 1)));
  const afterMidnight = process.env.JORI_SILENCE_PAST_MIDNIGHT === "0" ? []
    : await fetchPingsBetween(dayEndMs + 1, dayEndMs + SILENCE_EXTEND_MAX_MS);
  // A photo taken at a place, just outside its window, pins that place's arrival
  // or departure to it; the neighbour gives way (see pinStopsToPhotos). Before the
  // silence pass, so a stop it moves still runs on through the quiet around it.
  const stops_pinned_to_photos = pinStopsToPhotos(stops, dayPhotoRows, dayPings);
  const stops_extended_through_silence = extendThroughSilence(stops, [...dayPings, ...afterMidnight], asleepWindow, dayEndMs);
  // ...but never into the minute the next place begins (see leaveRoomToTravel).
  const stops_trimmed_for_travel = leaveRoomToTravel(stops, dayPings);
  // And last of all, nothing begins before he woke (see holdStartsAtWake).
  const sleptAt = placesSleptAt(restCtx.confirmedStopsEntries);
  const starts_held_at_wake = asleepWindow
    ? holdStartsAtWake(stops, dayPings, asleepWindow, false, sleptAt)
    : holdStartsAtWake(stops, dayPings,
        wake && Number.isFinite(wake.ts_ms)
          ? { from_ms: Date.parse(etBoundaryUtcIso(dateStr)), to_ms: wake.ts_ms } : null, true, sleptAt);

  const touchPass = mergeTouchingSameName(stops);
  stops = touchPass.stops;
  const stops_merged_touching = touchPass.merged;
  // After every merge and naming pass, so a guess fills only what nothing else
  // could name and nothing later can carry it onto a neighbour (2026-10-22).
  const default_guesses_applied = applyDefaultGuesses(stops, await fetchDefaultGuesses(dateStr));
  // Every edge has moved for the last time: each photo now goes on exactly one
  // stop, the one whose window holds the moment it was taken (see settleStopPhotos).
  const photos_settled = settleStopPhotos(stops, dayPhotoRows);

  // An unnamed last stop that runs on into the night (see nameDayEndFromNight).
  const named_from_night = await nameDayEndFromNight(stops,
    Date.parse(etBoundaryUtcIso(addDays(dateStr, 1))), restCtx.confirmedStopsEntries);
  const stops_named_from_night = named_from_night ? [named_from_night] : [];

  // A stop cut down since it took its visit rows' people keeps only the ones whose
  // rows it still overlaps (pruneShrunkCompanions). Before the fix companions,
  // which are his words and land on the final windows.
  const companions_pruned = pruneShrunkCompanions(stops, companionRows, companions_from_words);
  // And the people his words put on the fixes of a window (see applyFixCompanions).
  const companions_from_fixes = applyFixCompanions(stops, await fetchFixCompanions(dateStr));
  const activities_from_words = applyStatementWords(stops, statements, dateStr);

  const paceAfterH = travelGapH(stops);
  if (dayPath && dayPath.stats) {
    const km = dayPath.stats.matched_km || 0;
    dayPath.stats.transit_h_before = Math.round(paceBeforeH * 10) / 10;
    dayPath.stats.transit_h_after = Math.round(paceAfterH * 10) / 10;
    dayPath.stats.pace_kmh_before = paceBeforeH > 0.05
      ? Math.round((km / paceBeforeH) * 10) / 10 : null;
    dayPath.stats.pace_kmh_after = paceAfterH > 0.05
      ? Math.round((km / paceAfterH) * 10) / 10 : null;
  }
  for (const s of stops) s.companions = canonicalCompanions(s.companions);
  // The stops are final: an event the raw calendar pass found no stop for goes
  // on the stop the trace built for it later (see attachCalendarToFinalStops).
  const lateCal = attachCalendarToFinalStops(stops, unmatchedCal);
  unmatchedCal = lateCal.unmatched;
  const calendar_attached_late = lateCal.attached;
  const travel_legs = buildTravelLegs(stops);

  const classified = selfMessageSignals(statements);

  // Each stop in the local time of where it was (2026-10-02) — before
  // unknown_stops copies start/end, so the follow-up ranges agree with it.
  const tzs = applyPerStopTz(stops, DISPLAY_TZ);
  const shifted = crossesZones(tzs, DISPLAY_TZ);
  for (const sig of [wake, sleep]) {
    if (!shifted || !sig || !Number.isFinite(sig.ts_ms)) continue;
    sig.tz = tzAtMs(stops, sig.ts_ms);
    sig.at = hmFromMs(sig.ts_ms, sig.tz);
    sig.tz_abbr = tzAbbr(sig.tz, sig.ts_ms);
  }
  // The same night as the Watch saw it, which the summary opens with in words
  // (2026-10-10). Read in the zone the wake line is read in, so they agree.
  const nightTz = (wake && wake.tz) || DISPLAY_TZ;
  const night = await fetchNightDetail(addDays(dateStr, -1), nightTz);
  if (night && shifted) night.tz_abbr = tzAbbr(nightTz, Date.parse(night.onset_at));

  // A window the user already answered as a non-stop is NOT an open question —
  // listing it here would ask him to label a stretch he's told us wasn't a stop.
  // Nor is a window too short to be a stop at all — see askableStops.
  const unknown_stops = askableStops(stops)
    .filter(s => !s.user_non_stop)
    .filter(s => s.place.name == null || s.place.confidence < 0.6)
    .map(s => ({ id: s.id, start: s.start, end: s.end, lat: s.lat, lon: s.lon, hint: s.place.address,
                 ...(s.tz_abbr ? { tz: s.tz, tz_abbr: s.tz_abbr } : {}),
                 // His own saved places around the rest, so the follow-up is a
                 // tap and not an essay question — see nameFromSavedPlaces.
                 candidates: (s.saved_place_candidates || []).slice(0, 3)
                   .map(c => ({ name: c.name, distance_m: c.distance_m })) }));
  // Stops location-enrich queued a question about but that lost hum's ranker
  // every round — see loadUnaskedPendingEnrich above.
  unknown_stops.push(...loadUnaskedPendingEnrich(dateStr, stops, shifted));
  unknown_stops.push(...await loadOpenTurnarounds(dateStr, stops, shifted));

  // Long dwells with a raw-GPS silence bracketed by real movement — see
  // flagUnloggedExcursions above. Runs after every merge/demotion pass so
  // duration_min and is_movement reflect the final stop set.
  await flagUnloggedExcursions(stops, dateStr);

  // Pass through segment's rich payload — narrator can use these directly.
  const seg = raw.raw_segment || {};
  return {
    date: dateStr,
    tz: DISPLAY_TZ,
    // Distinct zones the day's stops sat in, in order. >1 = a travel day: each
    // stop/unknown_stop carries its own tz + tz_abbr and the renderer labels
    // every time with it.
    tzs,
    generated_at: new Date().toISOString(),
    wake,
    sleep,
    night,
    stops,
    travel_legs,
    // The street-matched trace. `path.segments[].matched` is the routed
    // geometry; `path.conflicts` are visit records that contradict each other.
    map_url: (dayPath && dayPath.stats && dayPath.stats.map_url) || null,
    path: dayPath ? {
      window: dayPath.stats.window,
      tz: dayPath.stats.tz,
      segments: dayPath.segments,
      stats: dayPath.stats,
      conflicts: dayPath.conflicts,
      nonstops: dayPath.nonstops,
      // The day as one ordered sequence, dwell -> leg -> dwell (2026-09-07).
      // Each leg carries its own streets, metres, mode and unobserved
      // stretches, so a reader walks this rather than intersecting time
      // windows against segments. Visit rows the fixes never supported are
      // in `unsupported_records`, drawn and narrated nowhere.
      spine: dayPath.spine || [],
      unsupported_records: dayPath.unsupported_records || [],
      waypoint_visits: dayPath.waypoint_visits || [],
    } : null,
    timeline_adjustments,
    timeline_conflicts,
    confirmed_added,
    visits_widened,
    // Venue stops a backing visit would have stretched back through his sleep,
    // kept at their own first fix instead (see widenToBackingVisits).
    visits_held_at_wake,
    starts_held_at_wake,
    stops_named_from_night,
    stops_merged_touching,
    default_guesses_applied,
    companions_from_fixes,
    companions_from_words,
    companions_pruned,
    activities_from_words,
    movement_demoted,
    movement_kept,
    // Over-wide clusters the trace re-cut into the windows he actually rested
    // in, and known-recurring names the trace could not support. Both carry
    // what was dropped, so a name that vanishes is never silent.
    stops_split_on_rests,
    known_names_stripped,
    // What the spine's reconciliation did to the stop set: windows clipped to
    // the dwells the fixes support, and stops the trace places elsewhere.
    // 2026-09-05: two Sept-5 address visits whose departed_at was written 35 h
    // late had become a 12:16→05:58 "unknown" stop that crushed a restaurant to one
    // minute and swallowed the evening walk.
    stops_clipped_by_spine: spineVerdicts.clipped,
    stops_extended_through_silence,
    stops_trimmed_for_travel,
    described_non_stops,
    non_stops_dropped,
    non_stop_walks,
    gap_loops,
    stops_dropped_by_spine: spineVerdicts.dropped,
    // Dwells the spine found that clustering had folded into a gap — the
    // 2026-09-06 morning at home (10:07–13:18) that made the walk up 8th
    // Avenue read "4h 30m (2.4 km) to next".
    stops_from_spine,
    stops_from_saved_at,
    stops_named_on_spine,
    stops_named_by_address,
    // Photos dropShortStops sent to the nearest-in-time survivor before this
    // dwell existed as a candidate, pulled back once it did — see
    // reclaimMisplacedPhotos. Empty on a normal day.
    photos_reclaimed_by_spine,
    // A photo taken at a place that moved its arrival or departure, and photos
    // taken off a stop whose window no longer holds them (or off a second stop
    // holding the same photo) — see pinStopsToPhotos / settleStopPhotos.
    stops_pinned_to_photos,
    photos_settled,
    stops_named_from_saved,
    // What the sign in his own photo named, and what it declined to name. The
    // declines matter as much: "the photo's words do not name a venue" is the
    // difference between a rung that failed and a rung that had nothing to read.
    stops_named_from_photo_text,
    photo_text_declined,
    // Rows PATCHed to carry a saved_place / photo_text name (and rows that
    // were left alone, with why) — the write-back is auditable from the day.
    names_written_back,
    saved_place_ambiguous,
    stops_dropped_no_rest,
    // Every base→base stretch this day contained, whether or not it became a
    // walk block, each with the reason it did or didn't — so "why is my walk
    // missing?" is answerable from the day itself.
    excursions,
    label_fixes,
    guesses_unnamed,
    all_stops_declared,
    // location-segment's coarse classifier on the raw gaps. Where the spine
    // has a leg over the same window, its mode (measured on the leg's own
    // fixes) replaces the route's: on 2026-09-08 a two-fix gap read "cycled"
    // at 15 km/h while the spine said "riding, uncertain", and the narrator
    // wrote "biked home". `mode_was` keeps the classifier's word.
    routes: supersedeRouteModesBySpine(seg.routes || [], dayPath && dayPath.spine),
    stops_split_on_calendar,
    gaps: seg.gaps || [],
    summary: seg.summary || null,
    unmatched_calendar_events: unmatchedCal,
    calendar_attached_late,
    corrections: classified.corrections,
    declarative_self_messages: classified.declarative,
    unknown_stops,
    sources: {
      location_segment: {
        sample_count: raw.sample_count,
        stop_count: raw.stop_count,
        route_count: (seg.routes || []).length,
        gap_count: (seg.gaps || []).length,
      },
      known_recurring_stops: { active_entries: known.entries.length, filtered_out: known.filteredOut, missing: !!known.missing },
      user_confirmed_rows: userConfirmed.length,
      imsg_self_total: classified.total,
    },
  };
}

// Merge `location_history.companions` onto adapted stops by time/distance overlap.
// Segment doesn't query the visits table, but findme + photos-daily populate
// companions on `location_history` rows. This re-attaches that signal.
// One name per person, and never the user (lib/companions.js: the
// installation's companion-names config): the day is the user's own story — a
// face-tag list merged with findme's canonical names once read "with <the
// user> + <partner> + <partner, full name> + <dog>". canonicalCompanions is
// the kernel helper, required at the top of this file.

async function mergeCompanionsFromVisits(adaptedStops, dateStr) {
  const startIso = etBoundaryUtcIso(dateStr);
  const endIso = etBoundaryUtcIso(addDays(dateStr, 1));
  const rows = await supabaseSelect(
    "location_history",
    `select=arrived_at,departed_at,latitude,longitude,companions` +
      `&segment_type=eq.visit` +
      `&arrived_at=gte.${encodeURIComponent(startIso)}` +
      `&arrived_at=lt.${encodeURIComponent(endIso)}` +
      `&companions=not.is.null` +
      `&order=arrived_at.asc`,
  );
  applyVisitCompanions(adaptedStops, rows);
  return Array.isArray(rows) ? rows : [];
}

// The stops that did not exist when the merge above ran on the clustering
// stops: spine dwells (addSpineDwells), and the stops overlayConfirmedVisits
// builds from a confirmed row no clustering stop matched. Both start with no
// companions; on 2026-10-15 the pet shop's row carried the partner (the user's answer) and
// the stop built from it rendered alone. A saved-at stop is not one of them:
// it carries the people his words named for that window, and a long row
// nearby has no say over it.
function stopsBuiltAfterCompanionMerge(stops) {
  return (stops || []).filter(s => s.from_spine || (s.from_confirmed_visit && !s.from_saved_at));
}

// The pure half: attach each visit row's companions to every stop it overlaps
// in time and sits within 300 m of. A stop carries its position as `centroid`
// (segment stops) or bare `lat`/`lon` (spine dwells, addSpineDwells).
function applyVisitCompanions(adaptedStops, rows) {
  if (!rows || !rows.length) return;
  for (const v of rows) {
    if (!v.companions || !v.companions.length) continue;
    const vStart = Date.parse(v.arrived_at);
    const vEnd = v.departed_at ? Date.parse(v.departed_at) : vStart;
    for (const s of adaptedStops) {
      if (s.start_ts_ms >= vEnd || s.end_ts_ms <= vStart) continue;
      const d = haversineMeters(
        s.centroid?.lat ?? s.lat ?? 0, s.centroid?.lon ?? s.lon ?? 0,
        v.latitude || 0, v.longitude || 0,
      );
      if (d > 300) continue;
      // Merge (dedupe by name).
      const existing = new Set(s.companions.map(c => (typeof c === "string" ? c : c?.name)).filter(Boolean));
      for (const c of v.companions) {
        const key = typeof c === "string" ? c : c?.name;
        if (key && !existing.has(key)) {
          s.companions.push(c);
          existing.add(key);
        }
      }
    }
  }
}

// His words on the fixes themselves (2026-10-18). location-annotate puts the
// people he names for a window on every location row in it, the transit fixes
// included, but the merges above read visit rows only, and only rows that
// arrived inside the day. A stop no such row backs lost what he said: on
// 2026-10-17 he answered "we were together all the time yesterday", the partner was
// tagged on every fix of the day, and the 06:54 stretch at the flat, held up by
// the overnight row that arrived Friday 20:13, still read alone. A stop takes a
// person who is on at least FIX_COMPANION_SHARE of its own fixes (and at least
// FIX_COMPANION_MIN of them) within 300 m of it. A fix is a moment, so a name
// cannot spread past the window he tagged the way a long row's names can.
// JORI_FIX_COMPANIONS=0 turns it off.
const FIX_COMPANION_SHARE = 0.8;
const FIX_COMPANION_MIN = 2;
const FIX_COMPANION_M = 300;

async function fetchFixCompanions(dateStr) {
  if (process.env.JORI_FIX_COMPANIONS === "0") return [];
  const startIso = etBoundaryUtcIso(dateStr);
  const endIso = etBoundaryUtcIso(addDays(dateStr, 1));
  return rowsOr(await supabaseSelect(
    "location_history",
    `select=arrived_at,latitude,longitude,companions` +
      `&segment_type=eq.transit` +
      `&arrived_at=gte.${encodeURIComponent(startIso)}` +
      `&arrived_at=lt.${encodeURIComponent(endIso)}` +
      `&order=arrived_at.asc&limit=20000`,
  ));
}

// The pure half. Returns [{id, name, added[], fixes}] for each stop it added to.
function applyFixCompanions(stops, fixes) {
  const added = [];
  const names = companionNames();
  const canon = (c) => canonicalName(typeof c === "string" ? c : c?.name, names);
  const seen = new Map();
  const pts = [];
  for (const f of rowsOr(fixes)) {
    const ts = Date.parse(f.arrived_at), lat = Number(f.latitude), lon = Number(f.longitude);
    if (!Number.isFinite(ts) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const k = `${ts}|${lat.toFixed(6)}|${lon.toFixed(6)}`;   // the writer emits exact twins
    const who = [...new Set((Array.isArray(f.companions) ? f.companions : []).map(canon).filter(Boolean))];
    // One fix, so one set of people: a twin re-sent later carries no tags (2026-10-22, the
    // phone re-uploaded Oct 21's evening at 06:19Z; whichever twin sorted first decided, and
    // the partner's 7 of 7 fixes at the flat after a restaurant read 6 of 8, under the share).
    const twin = seen.get(k);
    if (twin) { for (const n of who) if (!twin.who.includes(n)) twin.who.push(n); continue; }
    const p = { ts, lat, lon, who };
    seen.set(k, p);
    pts.push(p);
  }
  if (!pts.some(p => p.who.length)) return added;
  for (const s of stops || []) {
    if (!Array.isArray(s.companions)) continue;
    const lat = s.centroid?.lat ?? s.lat, lon = s.centroid?.lon ?? s.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const own = pts.filter(p => p.ts >= s.start_ts_ms && p.ts < s.end_ts_ms
      && haversineMeters(lat, lon, p.lat, p.lon) <= FIX_COMPANION_M);
    if (own.length < FIX_COMPANION_MIN) continue;
    const count = new Map();
    for (const p of own) for (const n of p.who) count.set(n, (count.get(n) || 0) + 1);
    const have = new Set(s.companions.map(canon).filter(Boolean));
    const names = [...count]
      .filter(([n, k]) => !have.has(n) && k / own.length >= FIX_COMPANION_SHARE)
      .map(([n]) => n);
    if (!names.length) continue;
    s.companions.push(...names);
    added.push({ id: s.id, name: s.place?.name || null, added: names, fixes: own.length });
  }
  return added;
}

module.exports = {
  resolveDay,
  classifyStops,
  buildTravelLegs,
  // exported for tests / debuggers
  fetchUserConfirmedStops,
  _internal: { selfMessageSignals, readDayStatements, applyVisitCompanions, stopsBuiltAfterCompanionMerge, applyFixCompanions, FIX_COMPANION_SHARE, runLocationSegment, adaptSegmentStop, enrichStopsWithCalendar, attachCalendarToFinalStops, calendarLocationMatchesStop, fetchImsgSent, hmFromMs, etBoundaryUtcIso, pickWake, localHour, WAKE_WINDOW,
    splitWideStopsOnRests, pieceCompanions, pruneShrunkCompanions, verifyKnownAgainstRest, dropUnrestedStops, UNRESTED_KEEP_MIN, nameRest, SPLIT_SEPARATION_M,
    matchConfirmedRest, loadConfirmedStopsEntries, loadOpenTurnarounds,
    nameFromSavedPlaces, savedPlacesNear, loadSavedPlaces, mergeSavedLists, SAVED_PLACE_MATCH_M, SAVED_PLACE_ASK_M,
    photoPings, namePhotoTextStops, attachPhotosToStop, RESOLVER_SETTLED,
    writeBackEarnedNames, splitConfirmedStopOnEvent, supersedeRouteModesBySpine, venueFromEventLocation, overlayConfirmedVisits,
    loadUnaskedPendingEnrich, applyPerStopTz, tzAbbr, tzAtMs,
    ensurePathGeometry, straightLineLegs, pathHasLegs, GEOMETRY_MATCHED, GEOMETRY_STRAIGHT,
    mergeWalkChains, walkMergeable, applyAccommodation, accommodationName, mergeOrphanVisitStops, mergeDuplicateStops, sameplace, dropShortStops, SHORT_STOP_MIN, askableStops, FOLLOW_UP_TOUCH_MS, widenToBackingVisits, mergeSplitVisits, widensThroughSleep, holdStartsAtWake, placesSleptAt, nameDayEndFromNight, mergeTouchingSameName, applyDefaultGuesses, DEFAULT_GUESS_CONF, carveAroundElsewhere, applyStatementCompanions, applyStatementWords, applyNonStopCompanions, reclaimTargetIds,
    markMovementByPace, netDisplacementM, vehicleBracketed, legKmh, MOVING_KMH, RETURN_DISPLACEMENT_M, RETURN_RATIO,
    reconcileStopTimeline, crossingPaceMPerH, contradictedByTrace, tracePresenceMs, fastestKmh,
    RECONCILE_PACE_M_PER_H, addSpineDwells, addSavedAtStops, nameBareStopFromDwell, nameSpineDwells, nameStopsByAddress, SPINE_COVER_MIN, applySpineVerdicts, SPINE_SAME_PLACE_M,
    reclaimMisplacedPhotos, RECLAIM_WINDOW_BUFFER_MS, RECLAIM_RADIUS_M, unnameGuesses, extendThroughSilence, leaveRoomToTravel,
    pinStopsToPhotos, settleStopPhotos, PHOTO_AT_STOP_M, PHOTO_PIN_MAX_MS, addDescribedNonStops, dropUndescribedNonStops, NON_STOP_WALK_MIN, NON_STOP_COVER_SHARE, walkedShareOfFixes,
    loadPassageWindows, nonStopSpan, sleepExempt },
};
