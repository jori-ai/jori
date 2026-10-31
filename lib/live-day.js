"use strict";
// live-day.js — continuously-evolving belief structure for the user's day.
//
// Calendar provides priors (calendar_seed intervals at expected times);
// GPS dwell evidence either reinforces those intervals or contradicts +
// rewrites; user-confirmed answers are absolute. Chat signals + Google
// Tasks completions attach as evidence on the matching interval.
//
// The structure lives at data/live-day.json, refreshed by a 10-min
// cron. At day rollover (date != today in the home zone) the prior file gets archived
// to data/live-day-archive/<YYYY-MM-DD>.json and a fresh structure
// is initialized.
//
// Schema v1:
//   {
//     schema_version, date, tz, as_of,
//     wake, sleep,
//     current_interval_id,
//     intervals: [
//       { id, start, end, start_ts_ms, end_ts_ms, open, type,
//         place: { name, source, confidence, lat, lon, address },
//         calendar: { event_id, summary, expected_start, expected_end, location } | null,
//         gps_status: "no_evidence_yet" | "dwelling" | "supports" | "contradicts" | "missed" | "confirmed",
//         companions, photos, duration_min, pattern,
//         activity_hint,
//         evidence_log: [{ ts, source, claim, outcome }] }
//     ],
//     open_questions, unmatched_calendar_events, visit_splits, summary
//   }
//
// Future readers (hum, chat-agent, location-confirm) consume this single
// source of truth instead of re-deriving from raw signals every tick.

const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write.js");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { resolveDay, _internal: { etBoundaryUtcIso } } = require(path.join(__dirname, "resolve-day.js"));
const { gatherChatSignals, gatherTaskSignals, attachSignals } = require(path.join(__dirname, "live-day-signals.js"));
const { fetchJson } = require(path.join(__dirname, "supabase-rest.js"));
const { instance } = require("./instance.cjs");
const { installTools } = require("./root.cjs");

// Calendar fetch — `gog calendar list` is the only auth path that has
// calendar.readonly scope locally. The gmail-push-token used by
// location-calendar-fuse.js lacks that scope (documented 2026-04-17 / the
// daily-summary playbook switched to MCP for the same reason). gog is
// authenticated via OAuth in ~/.config/gog/ but needs GOG_ACCOUNT set: the
// owner's address (instance owner_email, or JORI_CAL_ACCOUNT).
// gog: $GOG_BIN, else a package-manager install (cron's PATH has neither), else PATH.
const GOG = process.env.GOG_BIN || ["/opt/homebrew/bin/gog", "/usr/local/bin/gog"].find((p) => fs.existsSync(p)) || "gog";
const GOG_ACCOUNT = process.env.JORI_CAL_ACCOUNT || instance().owner_email;

function fetchCalendarViaGog(dateStr, tz) {
  const tomorrow = addDays(dateStr, 1);
  // The window has to be expressed in the SAME zone the day is anchored to.
  // This used to be a literal home-zone offset, which silently asked for a
  // home-zone window on a day resolve-day had anchored six hours east — a six-hour skew that binds
  // edge-of-day events to the wrong date.
  const off = offsetIso(tzOffsetMinutes(dateStr, tz));
  const args = [
    "calendar", "list",
    "--json", "--results-only",
    "--from", `${dateStr}T00:00:00${off}`,
    "--to", `${tomorrow}T00:00:00${off}`,
  ];
  if (!GOG_ACCOUNT) return []; // no owner_email: no calendar priors
  const env = { ...process.env, GOG_ACCOUNT };
  const res = spawnSync(GOG, args, { encoding: "utf8", env, timeout: 20_000 });
  if (res.status !== 0) {
    process.stderr.write(`[live-day] gog calendar failed (rc=${res.status}): ${(res.stderr || "").slice(0, 200)}\n`);
    return [];
  }
  let events;
  try { events = JSON.parse(res.stdout || "[]"); } catch { return []; }
  if (!Array.isArray(events)) return [];
  // Drop transparent (free / someone-else's-only / recurring-marker) events —
  // they don't represent the user physically at a place.
  return events.filter(ev => (ev.transparency || "opaque") !== "transparent");
}

// The home zone (instance().tz): the day's zone when resolve-day names none.
const TZ = instance().tz;
const DATA_DIR = installTools("data");
const LIVE_DAY_FILE = path.join(DATA_DIR, "live-day.json");
const ARCHIVE_DIR = path.join(DATA_DIR, "live-day-archive");
const PENDING_FILE = path.join(DATA_DIR, "location-confirm-pending.json");

const SCHEMA_VERSION = 1;
const URL_PREFIXES = ["http://", "https://", "zoom.", "meet.google"];
const CURRENT_INTERVAL_GRACE_MIN = 60;

function todayInHomeZone() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

// ---------------------------------------------------------------------------
// Day-boundary arithmetic.
//
// resolve-day.js owns the same arithmetic, but it reads a MUTABLE module global
// (DAY_BOUNDARY_TZ) that only resolveDay() sets — so the answer its exported
// etBoundaryUtcIso() gives depends on whether resolveDay happened to run first.
// live-day.js is a second caller, so it takes the zone as an explicit argument
// here rather than inheriting whatever the last resolveDay() left behind.
// ---------------------------------------------------------------------------

function tzOffsetMinutes(dateStr, tz) {
  // Offset of `tz` at noon UTC on dateStr, in minutes east of UTC.
  const noon = new Date(`${dateStr}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, timeZoneName: "shortOffset",
  }).formatToParts(noon);
  const off = parts.find(p => p.type === "timeZoneName")?.value || "GMT-5";
  // lang-regex-ok: parses an Intl-generated offset string ("GMT+02:00"), which
  // is machine-generated structure, not anything the user said.
  const m = /GMT([+-]\d{1,2})(?::?(\d{2}))?/.exec(off);
  if (!m) return -300;
  const sign = m[1][0] === "+" ? 1 : -1;
  return sign * (Math.abs(parseInt(m[1], 10)) * 60 + (m[2] ? parseInt(m[2], 10) : 0));
}

function offsetIso(offsetMin) {
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

// [start, end) in epoch ms for local midnight-to-midnight on dateStr in tz.
function dayWindowMs(dateStr, tz) {
  const start = Date.parse(`${dateStr}T00:00:00Z`) - tzOffsetMinutes(dateStr, tz) * 60_000;
  return { start, end: start + 24 * 3600_000 };
}

function nowIso() { return new Date().toISOString(); }

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isPhysicalLocation(loc) {
  return loc && !URL_PREFIXES.some(p => loc.startsWith(p));
}

// ---------------------------------------------------------------------------
// Build intervals
// ---------------------------------------------------------------------------

function gpsStopsToIntervals(stops) {
  return stops.map(s => {
    const start_ts_ms = s.start_ts_ms ?? Date.parse(s.start);
    const end_ts_ms = s.end_ts_ms ?? Date.parse(s.end);
    return {
      id: `iv-gps-${start_ts_ms}`,
      start: new Date(start_ts_ms).toISOString(),
      end: new Date(end_ts_ms).toISOString(),
      start_ts_ms,
      end_ts_ms,
      open: false,
      type: "stop",
      place: {
        name: s.place?.name ?? null,
        source: s.place?.source ?? "unknown",
        confidence: s.place?.confidence ?? 0,
        lat: s.lat ?? null,
        lon: s.lon ?? null,
        address: s.place?.address ?? null,
      },
      calendar: null,
      gps_status: "supports",
      companions: s.companions || [],
      photos: s.photos || [],
      duration_min: s.duration_min,
      pattern: s.pattern || "dwell",
      activity_hint: null,
      evidence_log: [{
        ts: nowIso(),
        source: "gps_dwell",
        claim: `${s.duration_min}min cluster at (${(s.lat ?? 0).toFixed(4)}, ${(s.lon ?? 0).toFixed(4)}) → ${s.place?.name ?? "unresolved"} (${s.place?.source ?? "?"}, conf ${s.place?.confidence ?? "?"})`,
        outcome: "interval_created",
      }],
    };
  });
}

// ---------------------------------------------------------------------------
// A geofence is a gap-filler BETWEEN named visits, never a blanket over them
// ---------------------------------------------------------------------------
//
// `named_location` is not a measurement, it is a 150 m circle drawn around a
// place we already knew (NAMED_LOCATION_MATCH_KM in bin/location-segment).
// Whatever the day's clustering lands inside that circle takes the circle's
// name — and once that was the entire day: one interval, 00:00 to 22:11,
// 1332 minutes of the house's name. iOS had recorded the evening walk AS IT
// HAPPENED and written it to location_history hours before the midnight
// archive ran: three visit rows at 18:30, 18:38 and 18:48, 190-720 m from the
// house, each one a place the house's own geofence says it is not. The day
// before had the same shape. This is the "the daily summary missed the
// evening dog walk" class again,
// and the location-spine skill already names the mechanism: *a container
// bigger than the place is the recurring failure.*
//
// So the geofence yields. A recorded visit that resolved to somewhere else,
// sitting inside a geofence interval's window, cuts that interval into
// [home] [the stop] [home] rather than being swallowed by it.
//
// It only ever CUTS: a day with nothing but home fixes has no qualifying visit
// and comes back as the single interval it always was.

// Outside the circle that named the interval, so it cannot be that place.
// Same 150 m as NAMED_LOCATION_MATCH_KM — the two must agree, because this is
// the exact question that constant already answers in the other direction.
const GEOFENCE_YIELD_M = 150;

// Sources whose name comes from a radius around a place we knew in advance
// rather than from the stop's own evidence. These, and only these, are the
// blankets. `accommodation` is deliberately NOT here: it is a trip's lodging,
// where a nearby row at 3am is far more likely to be GPS drift than an errand,
// and the incident this fixes is entirely about home.
const GEOFENCE_SOURCES = new Set(["named_location", "known_recurring"]);

// `place_type` values that assert "he was HERE", mapped to the interval source
// they earn. Set-membership over strings WE generate — never a shape match on
// anything the user wrote (Rule #0b). Excluded on purpose: `segment-derived` (our
// own guess written back, so splitting on it would be circular),
// `photo-synthesized` (a photo's coordinate, not a recorded stop), `non-stop`
// (him telling us it was not one), and null.
//
// `visit_address` / `visit_poi` are deliberately NOT in HIGH_CONF_SOURCES: a
// reverse-geocoded street number is a location, not a venue. Scoring these as
// unresolved is the honest reading, and it puts the walk stops back in front of
// location-confirm as questions worth asking instead of hiding them inside a
// stop that already "knew" its name.
const VISIT_PLACE_TYPES = new Map([
  ["user-confirmed", { source: "user_confirmed", confidence: 1.0 }],
  ["named", { source: "named_location", confidence: 0.95 }],
  ["poi", { source: "visit_poi", confidence: 0.6 }],
  ["address", { source: "visit_address", confidence: 0.5 }],
]);

// A CLVisit anchor is a single raw coordinate whose own error resolve-day
// measured at ~106 m. Past 150 m the row cannot say which side of a 150 m
// geofence it fell on, so it may not move one. His own answers are exempt —
// those are absolute by rule, whatever the phone thought of the fix.
const VISIT_ACCURACY_MAX_M = 150;

// A row covering essentially all of the interval is not a stop INSIDE it, it is
// a rival claim about the same window — that is a rename, which belongs to
// resolve-day, not to a split.
const VISIT_COVERS_HOST_MAX = 0.9;

// The asymmetry here is the point. A visit row is EVIDENCE somebody recorded,
// so it keeps whatever length iOS gave it, 13 seconds included. A remainder is
// ARITHMETIC WE PRODUCED, and eleven seconds of the house's name between two
// street stops 700 m from the house is not a moment the user was home — it is the
// gap between two rows. Evidence gets no floor; our own subtraction does.
//
// CONSEQUENCE, stated because it is easy to assume otherwise: the pieces
// therefore do NOT tile the host exactly. A sub-floor remainder is dropped, so
// each split loses under REMAINDER_MIN_MS at every boundary — at most
// 60s x (visits + 1) for one host, and 16s on 2026-08-24 (a 5s and an 11s gap
// between the walk stops). `covered_min` rounds to whole minutes, which HIDES
// that loss rather than avoiding it. The alternative — stretching a visit piece
// back over the gap — would tile perfectly by asserting he arrived somewhere
// five seconds before iOS says he did, and a false timestamp is a worse thing
// to publish than a five-second hole. Each split records its own `dropped_sec`
// so the bound is observable instead of a claim.
const REMAINDER_MIN_MS = 60_000;

// location_history rows → the minimal shape the split needs, with the table's
// structural defects handled: ~25% of rows are exact duplicates written by a
// second producer under a DIFFERENT id (so identity is the window plus the
// point, never the id), rows can contain one another, and rows can overlap.
function normalizeVisits(rows) {
  const out = [];
  const seen = new Set();
  for (const r of rows || []) {
    const kind = VISIT_PLACE_TYPES.get(r.place_type);
    if (!kind) continue;
    if (!r.place_name) continue;
    if (r.latitude == null || r.longitude == null) continue;
    const start_ms = Date.parse(r.arrived_at);
    const end_ms = Date.parse(r.departed_at);
    // An open row (departed_at null) has no window to cut with — ordinary, and
    // silent. An arrived_at we cannot parse is NOT ordinary: it means the wire
    // format moved under us, and every row would fail the same way, so the
    // split would quietly stop happening and the blob would come back with
    // nothing in the record to say why. Say so.
    if (r.arrived_at != null && !Number.isFinite(start_ms)) {
      process.stderr.write(`[live-day] unparseable visit arrived_at ${JSON.stringify(r.arrived_at)}`
        + " — location_history timestamp format changed; the geofence split is now inert\n");
      continue;
    }
    if (!Number.isFinite(start_ms) || !Number.isFinite(end_ms) || end_ms <= start_ms) continue;
    if (kind.source !== "user_confirmed"
      && r.accuracy_m != null && r.accuracy_m > VISIT_ACCURACY_MAX_M) continue;
    const key = `${start_ms}|${end_ms}|${r.latitude.toFixed(5)}|${r.longitude.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      start_ms, end_ms,
      lat: r.latitude, lon: r.longitude,
      name: r.place_name, place_type: r.place_type,
      source: kind.source, confidence: kind.confidence,
    });
  }
  // ORDER MATTERS, and getting it wrong is how this fix silently un-fixes
  // itself. Containers are dropped FIRST, before any overlap resolution.
  //
  // The overlap pass below keeps the earliest-and-longest row and discards
  // anything nested inside it. Run that first and a container EATS the very
  // rows it contains: location_history once held a home row running two days
  // (18:40 on day 1 -> 22:21 on day 3), fetched for day 3. It missed that
  // evening's walk by NINE MINUTES. Had it ended at 23:59 instead,
  // all three walk rows would have been swallowed here — before the container
  // guard in splitOnNamedVisits ever got to see them — and the day would have
  // gone back to being one 1332-minute blob with nothing to show why.
  //
  // So: a row that fully contains another qualifying row is describing a window
  // bigger than a place, which is the failure the location-spine skill names as
  // recurring. The more specific row wins; the container is not evidence about
  // any single stop. This also handles nesting depth > 1 in one pass (A ⊃ B ⊃ C
  // drops both A and B), because each of A and B contains something.
  const spans = (a, b) => a.start_ms <= b.start_ms && a.end_ms >= b.end_ms
    && (a.end_ms - a.start_ms) > (b.end_ms - b.start_ms);
  const specific = out.filter(a => !out.some(b => b !== a && spans(a, b)));

  // Earliest first, longest first on a tie. What remains can still PARTIALLY
  // overlap (neither containing the other); those would produce overlapping
  // intervals and a covered_min longer than the day exists, so first wins.
  specific.sort((a, b) => (a.start_ms - b.start_ms) || (b.end_ms - a.end_ms));
  const kept = [];
  for (const v of specific) {
    if (kept.some(k => k.start_ms < v.end_ms && v.start_ms < k.end_ms)) continue;
    kept.push(v);
  }
  return kept;
}

function geofencePiece(host, from, to, note) {
  const first = from === host.start_ts_ms;
  return {
    ...host,
    // The leading piece keeps the host's id so prior-belief and evidence
    // matching by id still lands on the bulk of the day across refreshes.
    id: first ? host.id : `iv-gps-${from}`,
    start: new Date(from).toISOString(),
    end: new Date(to).toISOString(),
    start_ts_ms: from,
    end_ts_ms: to,
    duration_min: Math.round((to - from) / 60_000),
    place: { ...host.place },
    // Photos and companions describe the whole original cluster and carry no
    // per-piece timing here; keeping them on the leading piece reports them
    // once rather than duplicating them across every slice.
    photos: first ? (host.photos || []) : [],
    companions: first ? (host.companions || []) : [],
    evidence_log: [
      ...(first ? (host.evidence_log || []) : []),
      { ts: nowIso(), source: "geofence_yield", claim: note, outcome: "interval_split" },
    ],
  };
}

function visitPiece(host, v) {
  return {
    id: `iv-visit-${v.start_ms}`,
    start: new Date(v.start_ms).toISOString(),
    end: new Date(v.end_ms).toISOString(),
    start_ts_ms: v.start_ms,
    end_ts_ms: v.end_ms,
    open: false,
    type: "stop",
    place: {
      name: v.name,
      source: v.source,
      confidence: v.confidence,
      lat: v.lat,
      lon: v.lon,
      address: null,
    },
    calendar: null,
    gps_status: v.source === "user_confirmed" ? "confirmed" : "supports",
    companions: [],
    photos: [],
    duration_min: Math.round((v.end_ms - v.start_ms) / 60_000),
    pattern: "dwell",
    activity_hint: null,
    evidence_log: [{
      ts: nowIso(),
      source: "visit_row",
      claim: `iOS recorded a visit at (${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}) → ${v.name}`
        + ` (${v.place_type}), ${Math.round(_metres(host.place.lat, host.place.lon, v.lat, v.lon))}m`
        + ` from "${host.place.name}" — outside its ${GEOFENCE_YIELD_M}m radius, so not that place`,
      outcome: "interval_created",
    }],
  };
}

// Returns { intervals, splits }. `intervals` is a NEW array; `splits` is the
// provenance record, so the next "why did my day fragment?" is answerable from
// the day itself rather than from a re-derivation.
function splitOnNamedVisits(intervals, visits) {
  const list = intervals || [];
  if (!list.length || !visits || !visits.length) return { intervals: list, splits: [] };

  const byHost = new Map();
  for (const v of visits) {
    const overlapping = list.filter(i => i.start_ts_ms < v.end_ms && v.start_ms < i.end_ts_ms);
    // A row spanning more than one interval is a container, not a stop —
    // location_history has held a 2.7-day home row that would
    // otherwise re-label days at a time. Same guard resolve-day's
    // widenToBackingVisits uses, for the same reason.
    if (overlapping.length !== 1) continue;
    const host = overlapping[0];
    if (!GEOFENCE_SOURCES.has(host.place?.source)) continue;
    if (host.place?.lat == null || host.place?.lon == null) continue;
    if (_metres(host.place.lat, host.place.lon, v.lat, v.lon) <= GEOFENCE_YIELD_M) continue;

    // CONTAINED, not merely overlapping. Clipping a row to the host's window
    // sounds harmless and is not: the 2.7-day home row ENDED inside the day
    // being built, so clipping turned it into an 1101-minute "stop" that passed
    // every other guard and would have renamed 18 hours of the day. A row that
    // starts before this interval or ends after it is describing a window
    // bigger than the interval — that is the container shape, whichever end it
    // sticks out of.
    if (v.start_ms < host.start_ts_ms || v.end_ms > host.end_ts_ms) continue;
    const hostMs = host.end_ts_ms - host.start_ts_ms;
    if (hostMs > 0 && (v.end_ms - v.start_ms) / hostMs >= VISIT_COVERS_HOST_MAX) continue;

    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(v);
  }
  if (!byHost.size) return { intervals: list, splits: [] };

  const out = [];
  const splits = [];
  for (const host of list) {
    const vs = byHost.get(host);
    if (!vs || !vs.length) { out.push(host); continue; }
    vs.sort((a, b) => a.start_ms - b.start_ms);
    const label = host.place?.name || "unnamed";
    const pieces = [];
    let cursor = host.start_ts_ms;
    // Time the floor discards. Not an accident to be hidden by rounding — see
    // REMAINDER_MIN_MS. Carried into the split record so the bound is a
    // measurement rather than a promise.
    let droppedMs = 0;
    for (const v of vs) {
      if (v.start_ms - cursor >= REMAINDER_MIN_MS) {
        pieces.push(geofencePiece(host, cursor, v.start_ms,
          `"${label}" yielded ${new Date(v.start_ms).toISOString()}-${new Date(v.end_ms).toISOString()}`
          + ` to a recorded visit at ${v.name}; this is the stretch before it`));
      } else {
        droppedMs += Math.max(0, v.start_ms - cursor);
      }
      pieces.push(visitPiece(host, v));
      cursor = Math.max(cursor, v.end_ms);
    }
    if (host.end_ts_ms - cursor >= REMAINDER_MIN_MS) {
      pieces.push(geofencePiece(host, cursor, host.end_ts_ms,
        `"${label}" resumed after ${vs.length} recorded visit(s) elsewhere`));
    } else {
      droppedMs += Math.max(0, host.end_ts_ms - cursor);
    }
    // Guard against cutting a stop out of existence: if every piece fell under
    // the remainder floor we keep the original rather than publish nothing.
    if (!pieces.length) { out.push(host); continue; }
    splits.push({
      host_id: host.id,
      was: `${host.start}-${host.end}`,
      was_min: Math.round((host.end_ts_ms - host.start_ts_ms) / 60_000),
      name: label,
      yielded_to: vs.map(v => ({
        name: v.name,
        place_type: v.place_type,
        start: new Date(v.start_ms).toISOString(),
        duration_min: Math.round((v.end_ms - v.start_ms) / 60_000),
        away_m: Math.round(_metres(host.place.lat, host.place.lon, v.lat, v.lon)),
      })),
      now_pieces: pieces.length,
      // Sub-floor remainders this split discarded. Bounded above by
      // REMAINDER_MIN_MS x (visits + 1); 16s on the 2026-08-24 case.
      dropped_sec: Math.round(droppedMs / 1000),
    });
    out.push(...pieces);
  }
  out.sort((a, b) => a.start_ts_ms - b.start_ts_ms);
  return { intervals: out, splits };
}

// The day's visit rows, clipped to the window the day is actually anchored to.
// Errors collapse to [] (fetchJson already does): a split we could not compute
// leaves the day exactly as it was, which is the pre-existing behaviour.
async function fetchDayVisits(dateStr, tz) {
  const win = dayWindowMs(dateStr, tz);
  const startIso = new Date(win.start).toISOString();
  const endIso = new Date(win.end).toISOString();
  const q = "/rest/v1/location_history?select=id,arrived_at,departed_at,latitude,longitude,place_name,place_type,accuracy_m"
    + "&segment_type=eq.visit"
    + `&arrived_at=lt.${encodeURIComponent(endIso)}`
    + `&departed_at=gt.${encodeURIComponent(startIso)}`
    + "&order=arrived_at.asc";
  const rows = await fetchJson(q, { timeoutMs: 8000 });
  return Array.isArray(rows) ? rows : [];
}

function reconcileCalendar(intervals, calEvents, nowMs) {
  const unmatched = [];
  for (const ev of calEvents) {
    const start = ev.start?.dateTime || ev.start?.date;
    const end = ev.end?.dateTime || ev.end?.date;
    if (!start || !end) continue;
    const sMs = Date.parse(start);
    const eMs = Date.parse(end);
    if (!sMs || !eMs) continue;
    if ((eMs - sMs) / 60_000 < 5) continue;

    const physical = isPhysicalLocation(ev.location);
    if (!physical) {
      unmatched.push({
        event_id: ev.id || null,
        summary: ev.summary || "",
        location: ev.location || null,
        start, end,
        duration_min: Math.round((eMs - sMs) / 60_000),
        physical: false,
      });
      continue;
    }

    // Try to match an existing GPS interval by time overlap.
    const overlapping = intervals.find(i =>
      i.place?.source !== "calendar_seed" && i.start_ts_ms < eMs && i.end_ts_ms > sMs);
    if (overlapping) {
      overlapping.calendar = {
        event_id: ev.id || null,
        summary: ev.summary || "",
        expected_start: start,
        expected_end: end,
        location: ev.location || null,
      };
      overlapping.gps_status = "supports";
      overlapping.evidence_log.push({
        ts: nowIso(),
        source: "calendar_match",
        claim: `Calendar event "${ev.summary}" at ${ev.location} overlaps this GPS interval — calendar+GPS agree`,
        outcome: "annotated",
      });
      continue;
    }

    // No GPS overlap — calendar_seed interval. Past events with no GPS = missed,
    // future or in-progress = awaiting evidence.
    const happened = eMs <= nowMs;
    intervals.push({
      id: `iv-cal-${ev.id || sMs}`,
      start, end,
      start_ts_ms: sMs,
      end_ts_ms: eMs,
      open: !happened,
      type: "stop",
      place: {
        name: ev.summary || ev.location,
        source: "calendar_seed",
        confidence: 0.6,
        lat: null,
        lon: null,
        address: ev.location || null,
      },
      calendar: {
        event_id: ev.id || null,
        summary: ev.summary || "",
        expected_start: start,
        expected_end: end,
        location: ev.location || null,
      },
      gps_status: happened ? "missed" : "no_evidence_yet",
      companions: [],
      photos: [],
      duration_min: Math.round((eMs - sMs) / 60_000),
      pattern: "dwell",
      activity_hint: null,
      evidence_log: [{
        ts: nowIso(),
        source: "calendar_seed",
        claim: `Calendar event "${ev.summary}" at ${ev.location} — no GPS overlap (${happened ? "past, gps_missed" : "future/in-progress, awaiting GPS"})`,
        outcome: happened ? "marked_missed" : "awaiting_gps_evidence",
      }],
    });
  }
  return unmatched;
}

function mergeEvidence(prior, current) {
  // Dedup on (source, claim) — every refresh re-runs gpsStopsToIntervals and
  // emits a fresh "interval_created" claim with `nowIso()` as ts. Including
  // ts in the dedup key would let identical creation claims accumulate
  // forever. Source+claim is the right semantic identity. We keep the
  // earliest occurrence (prior wins) so the canonical creation timestamp
  // sticks.
  const seen = new Set();
  const all = [...(prior || []), ...(current || [])];
  return all.filter(e => {
    const key = `${e.source}|${e.claim}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// A confirmed name belongs to the WINDOW the user confirmed, not to whatever
// interval happens to touch that window after the next re-clustering. Carrying
// it to the first overlapping interval is how a 23-minute confirmed cafe visit
// became the name of a 569-minute overnight stop on 2026-08-10: resolve-day had
// already resolved that cluster as "The airbnb" (user_confirmed, conf 1), and
// the stale prior overwrote it, so the archived record says he slept 9.5 hours
// at a cafe. Three guards, all asking the same question — is this the same stop?
const CARRY_MIN_OVERLAP_FRACTION = 0.5;  // the confirmation must mostly land inside
const CARRY_MAX_GROWTH_FACTOR = 3;       // a stop may grow; it may not become another stop
const CARRY_GROWTH_GRACE_MIN = 15;       // absolute slack, so short stops can still settle

function overlapMs(a, b) {
  return Math.min(a.end_ts_ms, b.end_ts_ms) - Math.max(a.start_ts_ms, b.start_ts_ms);
}

// Which new interval (if any) may adopt this prior confirmation, and why not.
function carryTarget(prior, candidates, claimed) {
  const priorMs = Math.max(prior.end_ts_ms - prior.start_ts_ms, 0);
  let best = null;
  let bestOv = 0;
  let anyOverlap = false;
  for (const n of candidates) {
    const ov = overlapMs(prior, n);
    if (ov > 0) anyOverlap = true;
    if (claimed.has(n.id)) continue;          // one confirmation per interval
    if (ov > bestOv) { best = n; bestOv = ov; }
  }
  // Nothing overlaps: the window he confirmed is genuinely unrepresented.
  if (!anyOverlap) return { target: null, reason: "no_overlap" };
  // Something overlaps but a stronger confirmation already took it — those
  // minutes are represented, so this must not become a second interval.
  if (!best || bestOv <= 0) return { target: null, reason: "already_claimed" };
  if (priorMs > 0 && bestOv < priorMs * CARRY_MIN_OVERLAP_FRACTION) {
    return { target: null, reason: "overlap_too_small" };
  }
  const candMs = Math.max(best.end_ts_ms - best.start_ts_ms, 0);
  const allowedMs = priorMs * CARRY_MAX_GROWTH_FACTOR + CARRY_GROWTH_GRACE_MIN * 60_000;
  if (priorMs > 0 && candMs > allowedMs) {
    return { target: null, reason: "candidate_far_longer" };
  }
  return { target: best, reason: "adopted" };
}

function preservePriorBeliefs(newIntervals, priorIntervals) {
  if (!priorIntervals || !priorIntervals.length) return;

  // Lock-and-keep: every prior interval whose place.source is user_confirmed
  // is gospel FOR ITS OWN WINDOW. Longest confirmation first, so the strongest
  // claim picks its interval before a shorter one can take it.
  const claimed = new Set();
  const confirmedPriors = priorIntervals
    .filter(p => p.place?.source === "user_confirmed")
    .sort((a, b) => (b.end_ts_ms - b.start_ts_ms) - (a.end_ts_ms - a.start_ts_ms));

  for (const prior of confirmedPriors) {
    const { target, reason } = carryTarget(prior, newIntervals, claimed);

    if (target) {
      claimed.add(target.id);
      // GPS is the authority on WHERE the interval was; the confirmation is the
      // authority on what it is CALLED. Copying the prior wholesale also moved
      // the coordinates, so a renamed interval stopped describing its own dwell.
      target.place = {
        ...prior.place,
        lat: target.place?.lat ?? prior.place?.lat ?? null,
        lon: target.place?.lon ?? prior.place?.lon ?? null,
      };
      target.gps_status = "confirmed";
      // Dedup AFTER appending, not before — appending post-merge re-added an
      // identical carry line on every 10-minute refresh.
      target.evidence_log = mergeEvidence(
        mergeEvidence(prior.evidence_log, target.evidence_log),
        [{
          ts: nowIso(),
          source: "user_confirmed_carry",
          claim: `Prior user_confirmed "${prior.place.name}" carried forward; current GPS resolution overridden`,
          outcome: "locked",
        }],
      );
      continue;
    }

    if (reason !== "no_overlap") {
      // His confirmation overlaps a stop we cannot safely rename — either it
      // sits inside a much longer one (the 2026-08-10 bug) or the new
      // clustering only clips it. Either way those minutes are ALREADY
      // represented, so re-adding the prior as its own interval would produce
      // a duplicate stop, a duplicate iv-gps-<start> id, and a covered_min
      // that exceeds the length of a day. Keep what he told us as evidence on
      // the stop that overlaps it most, and leave the name alone.
      let host = null;
      let hostOv = 0;
      for (const n of newIntervals) {
        const ov = overlapMs(prior, n);
        if (ov > hostOv) { host = n; hostOv = ov; }
      }
      if (host) {
        host.evidence_log = mergeEvidence(host.evidence_log, [{
          ts: nowIso(),
          source: "user_confirmed_contained",
          claim: `Prior user_confirmed "${prior.place.name}" (${Math.round((prior.end_ts_ms - prior.start_ts_ms) / 60_000)}min) overlaps this stop but does not match it (${reason}) — kept as evidence, name not overridden`,
          outcome: "noted",
        }]);
      }
      continue;
    }

    // no_overlap: the window he confirmed is not represented at all, so carry
    // it forward as its own interval.
    newIntervals.push({ ...prior });
  }

  // For non-locked intervals, preserve evidence_log when a prior matches by
  // id or by overlapping time + similar place.
  const priorById = new Map(priorIntervals.map(p => [p.id, p]));
  for (const ni of newIntervals) {
    if (ni.place?.source === "user_confirmed") continue; // already merged above
    const exact = priorById.get(ni.id);
    if (exact) {
      ni.evidence_log = mergeEvidence(exact.evidence_log, ni.evidence_log);
      continue;
    }
    const overlap = priorIntervals.find(p =>
      p.place?.source !== "user_confirmed" &&
      p.start_ts_ms < ni.end_ts_ms && p.end_ts_ms > ni.start_ts_ms);
    if (overlap) {
      ni.evidence_log = mergeEvidence(overlap.evidence_log, ni.evidence_log);
    }
  }

  newIntervals.sort((a, b) => a.start_ts_ms - b.start_ts_ms);
}

function pickCurrent(intervals) {
  const nowMs = Date.now();
  const graceMs = CURRENT_INTERVAL_GRACE_MIN * 60_000;
  const candidates = intervals.filter(i =>
    i.open || (i.end_ts_ms >= nowMs - graceMs && i.start_ts_ms <= nowMs));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.start_ts_ms - a.start_ts_ms);
  return candidates[0].id;
}

function collectOpenQuestions() {
  const pending = readJson(PENDING_FILE, []);
  if (!Array.isArray(pending)) return [];
  return pending.map(a => ({
    interval_id: null, // best-effort; resolver may attach later
    ask_id: a.ask_id,
    asked_at: a.first_sample_ts || null,
    candidates: [a.primary, ...(a.alternatives || [])]
      .filter(Boolean)
      .map(c => c.name)
      .filter(Boolean),
  }));
}

function computeSummary(intervals) {
  const by = (key, val) => intervals.filter(i => i[key] === val).length;
  const bySource = (val) => intervals.filter(i => i.place?.source === val).length;
  return {
    interval_count: intervals.length,
    stop_count: intervals.filter(i => i.type === "stop").length,
    calendar_seeded: bySource("calendar_seed"),
    user_confirmed: bySource("user_confirmed"),
    gps_supports: by("gps_status", "supports"),
    gps_contradicts: by("gps_status", "contradicts"),
    gps_missed: by("gps_status", "missed"),
    gps_dwelling: by("gps_status", "dwelling"),
    gps_confirmed: by("gps_status", "confirmed"),
  };
}

// A day with no intervals is not a quiet day — it is a day we failed to
// resolve. On 2026-08-07 resolve-day produced no stops, live-day.json was
// overwritten with interval_count 0, and the rollover filed that as the
// permanent record. location_history still holds 178 rows and 30 visits for
// that date, and the archive is 776 bytes against 19-26KB either side. The
// day was never missing; only the belief about it was, and nothing in the
// system ever goes back for a day.
function isDegenerate(day) {
  return !day || !Array.isArray(day.intervals) || day.intervals.length === 0;
}

// Calendar seeds are re-derived from Google every tick, so a day holding only
// those has observed nothing a re-run could lose.
function hasObservedIntervals(day) {
  return (day?.intervals || []).some(i => i.place?.source !== "calendar_seed");
}

// May `next` replace the ARCHIVE already on disk for the same date? Only if it
// is not emptier. Both empty is harmless; anything richer always wins.
function shouldReplaceDay(next, existing) {
  if (!existing) return true;
  if (existing.date !== next?.date) return true;
  if (!isDegenerate(next)) return true;
  return isDegenerate(existing);
}

function archive(prior) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const dest = path.join(ARCHIVE_DIR, `${prior.date}.json`);
  const existing = fs.existsSync(dest) ? readJson(dest, null) : null;
  if (!shouldReplaceDay(prior, existing)) {
    process.stderr.write(`[live-day] keeping existing archive for ${prior.date} (${existing.intervals.length} intervals) rather than overwriting it with 0\n`);
    return;
  }
  // Flag rather than hide: a blank day stays visible as incomplete so it can be
  // rebuilt from location_history later, instead of reading as a quiet day.
  const record = isDegenerate(prior)
    ? { ...prior, degraded: true, degraded_reason: "archived with no intervals" }
    : prior;
  writeFileAtomic(dest, JSON.stringify(record, null, 2));
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

async function refreshLiveDay() {
  const date = todayInHomeZone();
  const prior = readJson(LIVE_DAY_FILE, null);

  // Day rollover: archive the prior day and start fresh.
  if (prior && prior.date && prior.date !== date) {
    archive(prior);
  }

  // 1) GPS view of today (partial day; location-segment runs through current samples).
  let resolved;
  let resolveFailed = false;
  try {
    resolved = await resolveDay(date, { skipCalendar: true });
  } catch (e) {
    resolveFailed = true;
    process.stderr.write(`[live-day] resolve-day failed: ${e.message}\n`);
    resolved = { stops: [], wake: null, sleep: null, unmatched_calendar_events: [], routes: [], gaps: [] };
  }

  // 1b) Which zone did resolve-day actually anchor this day to? On a travel day
  // it adopts the day-path's zone (the day runs midnight to midnight in the
  // zone the user woke up in). live-day used to assume the home zone
  // regardless, so it published intervals anchored abroad under the home zone
  // and measured them against a home-zone window. Fall back to the home zone
  // when resolve-day could not say — that is the home case.
  const boundaryTz = resolved.path?.tz || resolved.tz || TZ;

  // 2) Calendar events for today (via gog — see top of file for why).
  let calEvents = [];
  try {
    calEvents = fetchCalendarViaGog(date, boundaryTz);
  } catch (e) {
    process.stderr.write(`[live-day] calendar fetch failed: ${e.message}\n`);
  }

  // 3) Build intervals from GPS; let recorded visits cut any geofence that is
  // blanketing them (see § A geofence is a gap-filler); then reconcile with
  // calendar — after the cut, so an event binds to the piece it belongs to
  // rather than to the whole day.
  let intervals = gpsStopsToIntervals(resolved.stops || []);
  let visit_splits = [];
  try {
    const cut = splitOnNamedVisits(intervals, normalizeVisits(await fetchDayVisits(date, boundaryTz)));
    intervals = cut.intervals;
    visit_splits = cut.splits;
  } catch (e) {
    process.stderr.write(`[live-day] visit split skipped: ${e.message}\n`);
  }
  const unmatchedCal = reconcileCalendar(intervals, calEvents, Date.now());
  intervals.sort((a, b) => a.start_ts_ms - b.start_ts_ms);

  // 4) Attach chat + task signals as evidence on covering intervals.
  try {
    const chatSig = await gatherChatSignals(date, etBoundaryUtcIso);
    attachSignals(intervals, chatSig);
  } catch (e) {
    process.stderr.write(`[live-day] chat signals failed: ${e.message}\n`);
  }
  try {
    const taskSig = gatherTaskSignals(date);
    attachSignals(intervals, taskSig);
  } catch (e) {
    process.stderr.write(`[live-day] task signals failed: ${e.message}\n`);
  }

  // 5) Preserve user_confirmed and evidence_log from prior live-day (today).
  const priorIntervalsForToday = (prior && prior.date === date) ? (prior.intervals || []) : [];
  preservePriorBeliefs(intervals, priorIntervalsForToday);

  // 6) Pick current interval + summarize.
  const current_interval_id = pickCurrent(intervals);
  const summary = computeSummary(intervals);

  const live = {
    schema_version: SCHEMA_VERSION,
    date,
    tz: boundaryTz,
    as_of: nowIso(),
    wake: resolved.wake || (prior?.date === date ? prior?.wake : null) || null,
    sleep: resolved.sleep || null,
    current_interval_id,
    intervals,
    open_questions: collectOpenQuestions(),
    unmatched_calendar_events: unmatchedCal,
    visit_splits,
    summary,
  };

  // A tick that learned nothing must not replace a tick that learned something.
  // Testing the SHAPE of `live` is not enough: preservePriorBeliefs carries
  // every user_confirmed prior forward, so a totally failed resolve still
  // produces a non-empty structure — one stripped of everything GPS knew
  // (on 2026-08-10 that would have dropped the 689-minute accommodation stop
  // while leaving the confirmations, and an emptiness test would have allowed
  // it). The honest signal is whether resolve-day returned anything at all.
  const priorForToday = (prior && prior.date === date) ? prior : null;
  const resolvedNothing = resolveFailed || !(resolved.stops || []).length;
  if (resolvedNothing && hasObservedIntervals(priorForToday)) {
    process.stderr.write(
      `[live-day] resolve-day ${resolveFailed ? "threw" : "returned no stops"} for ${date} — keeping ` +
      `the ${priorForToday.intervals.length} intervals already believed rather than overwriting them\n`);
    return priorForToday;
  }

  writeJson(LIVE_DAY_FILE, live);
  return live;
}

// ---------------------------------------------------------------------------
// Accuracy verification (the 99%-for-7-days verified_correctness target was
// retired 2026-10-06 — it never produced a number; name_accuracy is the measure)
// ---------------------------------------------------------------------------

// Sources trusted enough that an interval carrying one is neither an accuracy
// miss nor a location-confirm ask candidate (see resolution_gaps below).
// "accommodation" is emitted by resolve-day.js at confidence 0.95 for the
// place the user is actually staying, and is already treated as trusted by
// resolve-day.js (:786 high-confidence, :1473/:1703 confirmed) and by
// daily-summary-confirm.js. Omitting it here made live-day the lone dissenter:
// on any trip the lodging scored as unresolved AND was queued as a question,
// so Jori would ask the user where they had been while at their own
// rental. Added 2026-08-04.
const HIGH_CONF_SOURCES = new Set([
  "user_confirmed",
  "named_location",
  "known_recurring",
  "confirmed_stop",
  "wifi_ssid",
  "osm_overpass",
  "google_places",
  "accommodation",
]);

function loadDayFile(dateStr) {
  // Today's live-day is in LIVE_DAY_FILE; everything older is in archive/.
  const archivePath = path.join(ARCHIVE_DIR, `${dateStr}.json`);
  if (fs.existsSync(archivePath)) return readJson(archivePath, null);
  const today = readJson(LIVE_DAY_FILE, null);
  if (today && today.date === dateStr) return today;
  return null;
}


// ---------------------------------------------------------------------------
// Was the name RIGHT? — not merely produced
// ---------------------------------------------------------------------------
//
// `resolution_rate` counts minutes whose place carries a high-confidence
// SOURCE. It never compares the name to anything, so a confidently wrong name
// scores exactly like a right one. On 2026-08-10 the day scored **1.0 with zero
// resolution gaps** — and the single question asked about it was answered
// wrong: "Le Café des Anges" (20m from the flat) instead of Harvest Cafe, 280m
// away, because a 569-minute overnight cluster swallowed 18 of the 22 minutes.
// A metric that rewards confident wrongness will hide every other fix on the
// list, which is why this exists.
//
// Ground truth is his own corrections, and it is available NOW rather than at
// T+7 like the (retired 2026-10-06) `verified_correctness` placeholder.
//
// THE COMPARISON IS GEOMETRIC, NEVER TEXTUAL. Two reasons, and the second is
// the important one: "Harvest." and "Harvest Cafe" are the same place while
// "Le Café des Anges" and "Harvest Cafe" are 280m apart, so distance answers
// correctly where string equality answers backwards; and matching on how names
// read would be pattern-matching the user's language (Rule #0b).
const CORROBORATE_M = 60;

function _metres(aLat, aLon, bLat, bLon) {
  const R = 111320;
  return Math.hypot((bLat - aLat) * R,
                    (bLon - aLon) * R * Math.cos((aLat * Math.PI) / 180));
}

function verifyNames(intervals, confirmations) {
  // Only rows that assert a PLACE. `non-stop` says the window was not a stop —
  // a different claim, and not evidence about a name.
  const truth = (confirmations || []).filter(
    c => c.place_type === "user-confirmed" && c.latitude != null && c.departed_at,
  );
  let corroborated_min = 0, contradicted_min = 0, unexamined_min = 0;
  const contradictions = [];

  for (const i of intervals) {
    const mins = i.duration_min || 0;
    const src = i.place?.source;
    // Nothing claimed, or he claimed it himself — neither is a prediction we
    // can be graded on.
    // ONLY GRADE AN ASSERTED NAME. No source, no name, or his own answer means
    // no prediction was made — and a missing name is a COVERAGE miss, already
    // counted by resolution_rate. Scoring it as "wrong" would make accuracy a
    // second, worse copy of coverage instead of the orthogonal thing it is for:
    // coverage asks whether we said anything, accuracy asks whether what we
    // said was true.
    if (!src || src === "user_confirmed" || !i.place?.name || i.place?.lat == null) {
      unexamined_min += mins;
      continue;
    }
    const iStart = Date.parse(i.start), iEnd = Date.parse(i.end);
    const overlapping = truth.filter(c => {
      const cs = Date.parse(c.arrived_at), ce = Date.parse(c.departed_at);
      return cs < iEnd && iStart < ce;
    });
    if (!overlapping.length) {
      // Silence is NOT correctness. Most stops are never corrected; counting
      // them as right is precisely the error being fixed here.
      unexamined_min += mins;
      continue;
    }
    const nearest = Math.min(
      ...overlapping.map(c => _metres(i.place.lat, i.place.lon, c.latitude, c.longitude)),
    );
    if (nearest <= CORROBORATE_M) {
      corroborated_min += mins;
    } else {
      contradicted_min += mins;
      contradictions.push({
        id: i.id,
        start: i.start,
        duration_min: mins,
        said: i.place?.name || null,
        source: src,
        confidence: i.place?.confidence ?? null,
        he_said: overlapping[0].place_name || null,
        off_by_m: Math.round(nearest),
      });
    }
  }

  const judged = corroborated_min + contradicted_min;
  return {
    corroborated_min,
    contradicted_min,
    unexamined_min,
    // Null, not 1.0, when nothing was checkable. A day nobody corrected has no
    // accuracy — it has no evidence.
    name_accuracy: judged > 0 ? Math.round((corroborated_min / judged) * 1000) / 1000 : null,
    contradictions: contradictions.sort((a, b) => b.duration_min - a.duration_min).slice(0, 10),
  };
}

// gps_status values meaning an interval that carries a calendar event bears
// it out: GPS agreed ("supports"), he is there now ("dwelling"), or he named
// the stop himself ("confirmed", set over "supports" when his confirmation is
// carried onto the interval). "contradicts" is not support.
const CALENDAR_SUPPORTED_STATUSES = new Set(["supports", "dwelling", "confirmed"]);

function computeAccuracy(live, confirmations = []) {
  const intervals = live.intervals || [];
  // Measure against the day this record actually belongs to. The evening
  // interval is still open while the day is live and keeps growing past local
  // midnight, so an unclamped sum reports more minutes than a day contains —
  // 2026-08-10 came out at covered_min 1487 of a possible 1440, because the
  // last stop ran 155 minutes past the Paris boundary. Numerator and
  // denominator both use the clamped figure, so the rates stay <= 1.
  const tz = live.tz || TZ;
  const win = dayWindowMs(live.date, tz);
  const minutesInDay = (i) => {
    const a = Math.max(i.start_ts_ms, win.start);
    const b = Math.min(i.end_ts_ms, win.end);
    return Number.isFinite(a) && Number.isFinite(b) && b > a ? (b - a) / 60_000 : 0;
  };
  const totalMin = Math.round(intervals.reduce((s, i) => s + minutesInDay(i), 0));

  // Resolution rate — fraction of minutes with a high-confidence place name.
  // user_confirmed counts even at confidence < 0.7 (it's absolute by rule).
  const resolvedMin = intervals
    .filter(i => {
      const src = i.place?.source;
      if (!src) return false;
      if (src === "user_confirmed") return true;
      if (!HIGH_CONF_SOURCES.has(src)) return false;
      return (i.place?.confidence ?? 0) >= 0.7;
    })
    .reduce((s, i) => s + minutesInDay(i), 0);
  const resolution_rate = totalMin > 0 ? resolvedMin / totalMin : 0;

  // Calendar prediction: of physical calendar events the user had, how many
  // did GPS confirm? supports = calendar+GPS agree; missed = calendar said
  // but no GPS at that location; unmatched_physical = scheduled with a
  // physical address but no GPS overlap (lives in unmatched_calendar_events).
  //
  // An interval that carries a calendar event supports it whether GPS agreed
  // ("supports") or he then named the stop himself ("confirmed", which
  // replaces "supports" when his confirmation is carried onto the interval).
  // Counting only "supports" dropped every match on a stop he had confirmed:
  // on 2026-10-24 "Michael's wedding" sat on one and the day scored nothing.
  // The calendar seeds stay as they were: "missed" is counted below,
  // "no_evidence_yet" has not happened yet.
  const calIntervals = intervals.filter(i => i.calendar);
  const supports = calIntervals.filter(i => CALENDAR_SUPPORTED_STATUSES.has(i.gps_status)).length;
  const missed = calIntervals.filter(i => i.gps_status === "missed").length;
  const unmatchedPhysical = (live.unmatched_calendar_events || [])
    .filter(e => e.physical).length;
  const calendarTotal = supports + missed + unmatchedPhysical;
  const calendar_accuracy = calendarTotal > 0
    ? supports / calendarTotal
    : null;

  // User-confirmed share — minutes where the user personally validated the name.
  const userConfMin = intervals
    .filter(i => i.place?.source === "user_confirmed")
    .reduce((s, i) => s + minutesInDay(i), 0);
  const user_confirmed_share = totalMin > 0 ? userConfMin / totalMin : 0;

  // Coverage gaps — ≥30min stretches between consecutive intervals (excluding
  // overnight: any gap whose midpoint falls between 00:00 and 06:00 local time
  // is assumed to be sleep and is dropped from the report).
  const sortedIntervals = [...intervals].sort((a, b) => a.start_ts_ms - b.start_ts_ms);
  const gaps = [];
  for (let i = 0; i < sortedIntervals.length - 1; i++) {
    const a = sortedIntervals[i];
    const b = sortedIntervals[i + 1];
    const gapMs = b.start_ts_ms - a.end_ts_ms;
    if (gapMs < 30 * 60_000) continue;
    const midMs = a.end_ts_ms + gapMs / 2;
    // "Overnight" means overnight where the user actually is. Evaluated in the
    // home zone this dropped the wrong gaps on a trip: 02:00 six hours east is
    // 20:00 at home, so a genuine night's sleep was reported as a daytime gap.
    const midHourLocal = parseInt(new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "numeric", hour12: false,
    }).format(new Date(midMs)), 10);
    if (midHourLocal < 6 || midHourLocal >= 24) continue; // overnight
    gaps.push({
      start: a.end,
      end: b.start,
      gap_min: Math.round(gapMs / 60_000),
    });
  }

  // Resolution gaps — intervals that flunked the high-confidence test;
  // these are the candidates for tomorrow's location-confirm asks.
  const resolution_gaps = intervals
    .filter(i => {
      const src = i.place?.source;
      if (src === "user_confirmed") return false;
      if (HIGH_CONF_SOURCES.has(src) && (i.place?.confidence ?? 0) >= 0.7) return false;
      return true;
    })
    .map(i => ({
      id: i.id,
      start: i.start,
      end: i.end,
      duration_min: i.duration_min,
      place_name: i.place?.name || null,
      source: i.place?.source || null,
      confidence: i.place?.confidence ?? null,
      lat: i.place?.lat ?? null,
      lon: i.place?.lon ?? null,
    }));

  const verified = verifyNames(intervals, confirmations);

  return {
    date: live.date,
    schema_version: 2,
    interval_count: intervals.length,
    covered_min: totalMin,
    // COVERAGE, not correctness: the fraction of minutes that got a
    // confident-looking name. Read it beside name_accuracy, never instead of it.
    resolution_rate: Math.round(resolution_rate * 1000) / 1000,
    ...verified,
    calendar_supports: supports,
    calendar_missed: missed,
    calendar_unmatched_physical: unmatchedPhysical,
    calendar_total_physical: calendarTotal,
    calendar_accuracy: calendar_accuracy != null ? Math.round(calendar_accuracy * 1000) / 1000 : null,
    user_confirmed_share: Math.round(user_confirmed_share * 1000) / 1000,
    coverage_gaps: gaps,
    resolution_gaps,
    // `verified_correctness` / `drift_count_at_t_plus_7` used to sit here as
    // nulls for the nightly playbook to back-fill at T+7. They were never
    // filled once in 64 days and the metric was retired on 2026-10-06
    // (jobs/nightly-review.md § Retired) — so they are no longer emitted at
    // all, rather than shipped as a permanent null that reads like a pending
    // measurement. name_accuracy above is the correctness number.
  };
}

module.exports = {
  refreshLiveDay,
  loadDayFile,
  computeAccuracy,
  LIVE_DAY_FILE,
  ARCHIVE_DIR,
  // exported for tests / debugging
  _internal: {
    gpsStopsToIntervals,
    normalizeVisits,
    splitOnNamedVisits,
    fetchDayVisits,
    GEOFENCE_YIELD_M,
    REMAINDER_MIN_MS,
    reconcileCalendar,
    preservePriorBeliefs,
    pickCurrent,
    computeSummary,
    verifyNames,
    tzOffsetMinutes,
    offsetIso,
    dayWindowMs,
    isDegenerate,
    shouldReplaceDay,
    hasObservedIntervals,
  },
};
