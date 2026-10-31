"use strict";
// day-excursions — a walk from the nightly base is a slot of its own.
//
// The requirement: movement isn't a slot unless it's an intentional walk from
// the nightly base. Walks are recorded: leaving home and returning without a
// named stop is a 'Walk along the river' or 'Walk to <neighbourhood>'. A named
// stop makes the walk irrelevant: an hour's walk to a theater makes the theater
// the slot, not the walk.
//
// Until now movement had exactly one place to appear: the italic "N min between
// stops" line. Rung 5 of the location spine says moves are REPORTED and never
// WRITTEN, so an out-and-back had no representation at all — it falls inside the
// gap between two stops, and the gap is not a thing the prose can talk about.
// A 2026-08-31 walk with the dog was drawn on the map and absent from every
// sentence of that day's summary, which is what prompted this file.
//
// The rule, exactly:
//
//   base → … → base, nothing NAMED in between   ⇒  one walk block, titled
//                                                  by where the walk went
//   anything named in between                   ⇒  no walk block; the named
//                                                  stop is the slot and the
//                                                  walk is just how the user got there
//
// "Named" is `isSettledIdentity` — the same test mergeWalkChains already uses to
// refuse to absorb a real stop into a stroll. An address ("340 Main St"), a POI
// guess, or an unlabeled sliver is NOT named, so those get swallowed by the walk
// rather than blocking it: that is the whole point of the rule. A GPS artefact
// must never be able to demote a walk back into invisibility.
//
// Naming is geometry, not language (Rule #0b — code owns geometry, a model owns
// language). Every candidate name here comes from a DATA SOURCE we queried: a
// waterway or park the path actually ran along (OSM), or the neighborhood the
// turnaround point resolves to. Nothing is pattern-matched out of anything
// the user said. If no source yields a name the block is titled plainly "Walk" —
// we still know it happened, we just cannot say where it went.

const fs = require("fs");
const path = require("path");

const BASE_MATCH_M = 150;        // same radius applyAccommodation uses for "the base"
// A walk has to have been a walk. Below either bar this is stepping out for a
// delivery, or GPS drift around the front door, and it does not deserve a block.
const MIN_EXCURSION_MIN = 10;
const MIN_AWAY_M = 250;
// And it has to have been WALKED. 2026-08-23 offered a 133-minute absence from
// home carrying 1,040 m of street-matched path — 0.47 km/h — with no cluster
// inside it at all, because CLVisit never split out where the user actually
// was. Calling that "Walk around <the park>" asserts a walk not taken.
// The inner-dwell guard cannot see it (there is no inner stop to judge), so the
// stretch is judged on its own pace, against the same line resolve-day uses to
// separate moving from still.
const MIN_WALK_KMH = 1.8;         // MOVING_KMH in resolve-day
// ...and not driven. A base-to-base stretch at driving pace is a trip somewhere
// (2026-10-16: 56 minutes, 35 km, to the airport for a pick-up and back), and with
// no ceiling it came out "Walk to ..." whenever the map-matcher answered. The drive
// stays a travel line; where it went is a stop of its own or nothing.
// JORI_EXCURSION_DRIVES=1 restores the old behaviour.
const MAX_WALK_KMH = 12;          // LOOP_DRIVE_KMH below

// How close the path has to run to a feature, and for how much of itself, before
// the feature gets to name the walk. 200 m is generous on purpose: a wide
// river's mapped centerline sits well offshore of the greenway you walk on.
const FEATURE_NEAR_M = 200;
const FEATURE_COVERAGE = 0.5;

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OVERPASS_TIMEOUT_MS = 40_000; // whole call, across mirrors (maps.mail.ru answers in ~16 s)

function haversineMeters(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lat2 == null || lon1 == null || lon2 == null) return Infinity;
  const R = 6371000, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// -------- the day's base --------
//
// Where the user woke: the day's first stop, when it has a settled identity and ran
// long enough to have been the night. Nothing else can be the base, so a day
// that opens somewhere unnamed yields none and this file does nothing at all —
// fail-safe by construction, because "a walk from the base" is meaningless
// without one.
//
// applyAccommodation's rule (starts AND ends at the same place) is deliberately
// NOT reused here. That test is about naming a trip's lodging, and as a base
// test it fails on ordinary days: 2026-08-29 ended on a 1-minute Miznon stop
// after the phone went quiet, which under first-and-last matching erased the
// base and with it every walk of that day. The return trip is already required
// by the pairing below — a stretch only counts when it comes back — so
// demanding it of the day as a whole bought nothing and cost real walks.
// The FIRST QUALIFYING stop, not literally stops[0]: a day can open with a
// stray sliver (2026-08-19 began with a 0-minute bar at 00:00, left over
// from the night before), and reading that as the base erased the whole day's
// walks. Scan forward to the first settled stop long enough to have been the
// night and stop there — anything later is somewhere visited, not where the user woke.
const BASE_MIN_MIN = 60;
// The night can be missing from `stops` when this pass runs: resolve-day adds
// the spine's own dwells (addSpineDwells) AFTER the excursion pass, and on a day
// whose overnight stay had no visit row of its own the first stop in the list is
// wherever the user went first. 2026-10-20: the rented flat's night (00:09-08:52)
// was only a spine dwell, so the base came out as the 92-minute lunch at a
// seafood restaurant, 1 km away, nothing matched it, and the 18:45-19:12 walk out of the
// flat and back was never a block: the evening read as the flat twice, 42
// minutes apart. The spine's opening dwell stands in for the night only when it
// is settled (the user's word, or corroborated), long enough, and over before the first
// qualifying stop begins; a stop that is the night itself still wins.
const SPINE_BASE_TIERS = new Set(["user-confirmed", "corroborated"]);
function spineNight(dayPath) {
  const spine = (dayPath && dayPath.spine) || [];
  const d = spine.find(n => n && n.type === "dwell");
  if (!d || !d.place || !d.place.name || d.place.lat == null || d.place.lon == null) return null;
  if (!SPINE_BASE_TIERS.has(d.place.tier)) return null;
  if (!d.start_ms || !d.end_ms || d.end_ms - d.start_ms < BASE_MIN_MIN * 60_000) return null;
  return { lat: d.place.lat, lon: d.place.lon, start_ts_ms: d.start_ms, end_ts_ms: d.end_ms,
           place: { name: d.place.name } };
}
// The spine's major dwells AT the base that no stop covers (see detectExcursions).
const ANCHOR_COVER_MIN = 0.5;   // SPINE_COVER_MIN in resolve-day
function baseAnchors(dayPath, stops, base) {
  const spine = (dayPath && dayPath.spine) || [];
  const out = [];
  for (const n of spine) {
    if (!n || n.type !== "dwell" || !n.major || !n.start_ms || !n.end_ms || n.end_ms <= n.start_ms) continue;
    if (!n.place || n.place.lat == null || n.place.lon == null) continue;
    if (haversineMeters(n.place.lat, n.place.lon, base.lat, base.lon) > BASE_MATCH_M) continue;
    let covered = 0;
    for (const s of stops) {
      const ov = Math.min(n.end_ms, s.end_ts_ms) - Math.max(n.start_ms, s.start_ts_ms);
      if (ov > 0) covered += ov;
    }
    if (covered / (n.end_ms - n.start_ms) >= ANCHOR_COVER_MIN) continue;
    out.push({ _anchor: true, id: n.id, lat: n.place.lat, lon: n.place.lon,
               start_ts_ms: n.start_ms, end_ts_ms: n.end_ms,
               start: n.start || null, end: n.end || null, place: { name: n.place.name || null } });
  }
  return out;
}
function dayBase(stops, dayPath = null) {
  if (!stops || stops.length < 2) return null;
  let first = stops.find(s => s.lat != null && isNamedStop(s)
    && (s.duration_min || 0) >= BASE_MIN_MIN);
  const night = spineNight(dayPath);
  if (night && (!first || (first.start_ts_ms != null && night.end_ts_ms <= first.start_ts_ms))) first = night;
  if (!first) return null;
  const last = stops[stops.length - 1];
  // When the day does end where it began, average the two centroids — the same
  // place recorded twice pins it better than either reading alone.
  const closes = last.lat != null
    && haversineMeters(first.lat, first.lon, last.lat, last.lon) <= BASE_MATCH_M;
  return {
    lat: closes ? (first.lat + last.lat) / 2 : first.lat,
    lon: closes ? (first.lon + last.lon) / 2 : first.lon,
    name: (first.place && first.place.name) || null,
  };
}

function isBaseStop(s, base) {
  return base != null && s.lat != null
    && haversineMeters(s.lat, s.lon, base.lat, base.lon) <= BASE_MATCH_M;
}

// A stop whose identity is settled owns its slot. Mirrors resolve-day's
// isSettledIdentity — kept as its own copy so this module stays standalone, and
// asserted equal by the test suite.
const SETTLED_SOURCES = new Set([
  "user_confirmed", "named_location", "known_recurring",
  "wifi_ssid", "accommodation", "confirmed_stop",
]);
function isNamedStop(s) {
  return SETTLED_SOURCES.has((s.place && s.place.source) || "");
}

// An unnamed stop inside the stretch usually IS the walk — a browse cluster, a
// CLVisit blip, a sliver of drift — and absorbing it is the point of the rule.
// But not always: on 2026-08-29 the user was out 10:05-12:14 with a 63-minute cluster
// in the middle at 0.82 km/h. That is not walking, it is sitting somewhere we
// failed to name, and titling the stretch "Walk to …" would assert a walk not
// taken AND silence the location-enrich ask that would have got the place
// named. Pace is the discriminator resolve-day already calibrated: real dwells
// run 0.00-1.31 km/h, walking clusters 2.4-4.4. So a long stop the user was
// STILL for blocks the walk; a long stop moved through does not.
const DWELL_BLOCK_MIN = 20;
const DWELL_BLOCK_KMH = 1.8;      // MOVING_KMH in resolve-day
function isUnnamedDwell(s) {
  if ((s.duration_min || 0) < DWELL_BLOCK_MIN) return false;
  if (s.user_non_stop || s.is_movement) return false;   // already settled as movement
  // Unmeasured is not evidence of walking. Without a pace we decline to call a
  // 20-minute stop a stroll.
  return s.pace_kmh == null || s.pace_kmh < DWELL_BLOCK_KMH;
}

// -------- path geometry inside a window --------

function legsIn(dayPath, fromMs, toMs) {
  const out = [];
  for (const seg of (dayPath && dayPath.segments) || []) {
    for (const leg of seg.legs || []) {
      // A leg with no span is an instant, and belongs to the window it falls
      // in, including one that opens on it: the step out of the door as a loop
      // starts (2026-10-17, the evening walk's first 292 m, dropped from both
      // the walk and the window before it).
      const zero = leg.t1 <= leg.t0;
      if (zero ? (leg.t0 < fromMs || leg.t0 >= toMs) : (leg.t1 <= fromMs || leg.t0 >= toMs)) continue;
      if (leg.lat0 == null || leg.lat1 == null) continue;
      out.push(leg);
    }
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

// Routed metres, summed per LEG rather than apportioned across a segment by
// elapsed time. Time-apportionment is what credited the 2026-08-31 walk with
// 53 m of the day's 2,590 and charged the rest to sitting at home — the day
// collapsed into one street-matched segment, so "share of the day's minutes"
// bore no relation to "share of the day's metres".
function routedMetersIn(dayPath, fromMs, toMs) {
  let m = 0;
  for (const leg of legsIn(dayPath, fromMs, toMs)) {
    const span = leg.t1 - leg.t0;
    if (span <= 0) { m += leg.m || 0; continue; }
    const ov = Math.min(toMs, leg.t1) - Math.max(fromMs, leg.t0);
    if (ov > 0) m += (leg.m || 0) * (ov / span);
  }
  return m;
}

// Every distinct point the path touched in the window, in order.
function pointsIn(dayPath, fromMs, toMs) {
  const legs = legsIn(dayPath, fromMs, toMs);
  const pts = [];
  for (const l of legs) {
    pts.push({ lat: l.lat0, lon: l.lon0, t: l.t0 });
    pts.push({ lat: l.lat1, lon: l.lon1, t: l.t1 });
  }
  return pts;
}

// The turnaround: the point of the walk that got furthest from the base. On an
// out-and-back that is where the user was actually going, which is what the
// title should name — "Walk to <neighbourhood>" is a statement about the far end, not
// about the average position.
function turnaroundOf(points, base) {
  let best = null, bestM = -1;
  for (const p of points) {
    const m = haversineMeters(p.lat, p.lon, base.lat, base.lon);
    if (m > bestM) { bestM = m; best = p; }
  }
  return best ? { ...best, away_m: Math.round(bestM) } : null;
}

// -------- naming from OSM features the path actually ran along --------

function bboxOf(points, padM) {
  const lats = points.map(p => p.lat), lons = points.map(p => p.lon);
  const dLat = padM / 111_320;
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLon = padM / (111_320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  return {
    south: Math.min(...lats) - dLat, west: Math.min(...lons) - dLon,
    north: Math.max(...lats) + dLat, east: Math.max(...lons) + dLon,
  };
}

// Mirrors, backoff and the health file are shared with lib/overpass_client.py
// (see its header): last-good mirror first, failed mirrors back off, every
// mirror tried when all are backing off. 2026-10-20: overpass-api.de refusing.
const OVERPASS_CONFIG = path.join(__dirname, "overpass-endpoints.json");
// Overpass asks a client to name a contact: the installation's own address
// (agent_email, else owner_email), when it has one.
const USER_AGENT = (() => {
  let contact = "";
  try { const i = require("./instance.cjs").instance(); contact = i.agent_email || i.owner_email || ""; } catch { /* no instance */ }
  return `jori-location/1.0 (personal assistant${contact ? `; contact ${contact}` : ""})`;
})();
const OVERPASS_HEALTH = path.join(__dirname, "..", "data", ".cache", "overpass-health.json");

function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return dflt; }
}

function overpassConfig() {
  const c = readJson(OVERPASS_CONFIG, {});
  return {
    urls: Array.isArray(c.endpoints) && c.endpoints.length ? c.endpoints : [OVERPASS_URL],
    perMirrorMs: (c.per_mirror_s || 20) * 1000,
    skipMin: c.skip_failed_min || 2,
    refusedMin: c.skip_refused_min || 30,
    maxMin: c.skip_failed_max_min || 120,
  };
}

function overpassEndpoints(cfg) {
  const h = readJson(OVERPASS_HEALTH, {});
  const rec = (u) => (h[u] && typeof h[u] === "object" ? h[u] : {});
  const now = Date.now() / 1000;
  const live = cfg.urls.filter((u) => !((rec(u).skip_until || 0) > now));
  const pool = live.length ? live : cfg.urls;
  return pool.slice().sort((a, b) => (rec(b).last_ok || 0) - (rec(a).last_ok || 0)
    || cfg.urls.indexOf(a) - cfg.urls.indexOf(b));
}

function markOverpass(cfg, url, ok, kind, err, ms) {
  const h = readJson(OVERPASS_HEALTH, {});
  const now = Date.now() / 1000;
  const iso = new Date().toISOString().slice(0, 19) + "Z";
  let r = h[url] && typeof h[url] === "object" ? h[url] : {};
  if (ok) {
    r = { last_ok: now, ms };
    h._last_success = iso;
    delete h._all_failed_since;
  } else {
    const fails = (r.fails || 0) + 1;
    const skip = Math.min((kind === "refused" ? cfg.refusedMin : cfg.skipMin) * 2 ** (fails - 1), cfg.maxMin);
    Object.assign(r, { fails, skip_until: now + skip * 60, last_fail: iso, last_error: `${kind}: ${err}`.slice(0, 200) });
  }
  h[url] = r;
  try {
    fs.mkdirSync(path.dirname(OVERPASS_HEALTH), { recursive: true });
    const tmp = `${OVERPASS_HEALTH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(h, null, 1));
    fs.renameSync(tmp, OVERPASS_HEALTH);
  } catch {}
}

async function overpass(query) {
  const cfg = overpassConfig();
  const deadline = Date.now() + OVERPASS_TIMEOUT_MS;
  for (const url of overpassEndpoints(cfg)) {
    const left = deadline - Date.now();
    if (left < 2000) break;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(cfg.perMirrorMs, left));
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: ctl.signal,
      });
      if (!res.ok) { markOverpass(cfg, url, false, "busy", `HTTP ${res.status}`); continue; }
      const json = await res.json();
      markOverpass(cfg, url, true, null, null, Date.now() - t0);
      return json;
    } catch (e) {
      const code = e && e.cause && e.cause.code;
      const kind = ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"].includes(code) ? "refused" : "busy";
      markOverpass(cfg, url, false, kind, code || (e && e.name) || "error");
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// Named water and named green space around the walk, with geometry, so coverage
// can be measured rather than assumed. Anything that fails — Overpass down,
// timeout, no network on the mini — returns [] and the walk falls through to
// neighborhood naming. A missing river name must never cost us the block.
async function nearbyFeatures(points) {
  if (!points.length) return [];
  const b = bboxOf(points, 400);
  const bbox = `${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)}`;
  const q = `[out:json][timeout:20];
(
  way["waterway"~"^(river|canal)$"]["name"](${bbox});
  way["natural"="coastline"]["name"](${bbox});
  way["leisure"~"^(park|nature_reserve|garden)$"]["name"](${bbox});
  way["natural"="beach"]["name"](${bbox});
);
out geom;`;
  const json = await overpass(q);
  if (!json || !Array.isArray(json.elements)) return [];
  const out = [];
  for (const el of json.elements) {
    const name = el.tags && el.tags.name;
    if (!name || !Array.isArray(el.geometry) || !el.geometry.length) continue;
    const isWater = !!(el.tags.waterway || el.tags.natural === "coastline");
    out.push({
      name,
      kind: isWater ? "water" : (el.tags.natural === "beach" ? "beach" : "green"),
      geometry: el.geometry,
      bounds: el.bounds || null,
    });
  }
  return out;
}

function nearGeometry(p, geometry) {
  for (const g of geometry) {
    if (haversineMeters(p.lat, p.lon, g.lat, g.lon) <= FEATURE_NEAR_M) return true;
  }
  return false;
}

function insideBounds(p, bounds) {
  return bounds != null
    && p.lat >= bounds.minlat && p.lat <= bounds.maxlat
    && p.lon >= bounds.minlon && p.lon <= bounds.maxlon;
}

// Which feature, if any, the walk was OF. A linear feature (a river, a
// coastline) has to be alongside the path for most of it; an area feature (a
// park) has to contain most of it. Both are the same question — "was this walk
// about that thing?" — asked in the geometry each shape supports.
function dominantFeature(points, features) {
  let best = null;
  for (const f of features) {
    const hits = points.filter(p =>
      f.kind === "green" ? (insideBounds(p, f.bounds) || nearGeometry(p, f.geometry))
                         : nearGeometry(p, f.geometry)).length;
    const cov = points.length ? hits / points.length : 0;
    if (cov < FEATURE_COVERAGE) continue;
    // Water wins ties: "along the river" says more than the park it runs
    // through, and the riverside parks are named after the river anyway.
    const rank = (f.kind === "water" ? 2 : f.kind === "beach" ? 1 : 0);
    if (!best || rank > best.rank || (rank === best.rank && cov > best.cov)) {
      best = { name: f.name, kind: f.kind, cov, rank };
    }
  }
  return best;
}

// The title. Preposition follows the SHAPE of what named it, not the words in
// it: you walk *along* a river, *in* a park, *to* another neighborhood, and
// *around* your own.
function titleFor({ feature, turnNeighborhood, baseNeighborhood, mode = "walking" }) {
  const noun = mode === "driving" ? "Drive" : "Walk";
  if (feature) {
    if (feature.kind === "water") return `${noun} along ${feature.name}`;
    return `${noun} ${mode === "driving" ? "through" : "in"} ${feature.name}`;
  }
  if (turnNeighborhood && baseNeighborhood
      && turnNeighborhood.toLowerCase() !== baseNeighborhood.toLowerCase()) {
    return `${noun} to ${turnNeighborhood}`;
  }
  const where = turnNeighborhood || baseNeighborhood;
  return where ? `${noun} around ${where}` : noun;
}

// -------- detection --------

/**
 * Fold base→base stretches with nothing named in them into single walk blocks.
 *
 * @param stops     the final resolved stop list (mutated only by replacement)
 * @param dayPath   day-path output; without it there is no geometry and no walk
 * @param opts.resolvePoint  (lat, lon, atIso) -> { neighborhood, name, ... }
 * @param opts.features      override for the OSM lookup (tests; offline runs)
 * @returns { stops, excursions } — excursions[] is the audit trail, so a
 *          "why is my walk missing?" is answerable from the day JSON itself
 *          rather than from a re-derivation (same contract as movement_kept).
 */
async function detectExcursions(stops, dayPath, opts = {}) {
  const excursions = [];
  if (!Array.isArray(stops) || stops.length < 2 || !dayPath) return { stops, excursions };
  // In time order: "everything strictly between two base stops" is positional.
  // A remainder carved out of a stop (applySpineVerdicts' "-r1" piece) is
  // seated next to its parent, not at its own time; on 2026-10-20 the flat's
  // 19:12 remainder sat before the 18:55 stop, so the walk between the two flat
  // stays found nothing inside it and the 18:55 stop and its photo stayed out.
  stops = [...stops].sort((a, b) => (a.start_ts_ms ?? 0) - (b.start_ts_ms ?? 0));
  const base = dayBase(stops, dayPath);
  if (!base) return { stops, excursions };
  // The trace's own returns to the base close a walk too. resolve-day adds the
  // spine's dwells as stops only after this pass, so a stay at the base that no
  // visit row covered is not in `stops` yet: 2026-10-20 (re-run), back at the flat
  // 19:12-20:04 after the walk existed only as a spine dwell, and the walk out at
  // 18:42 had nothing to come back to. Such a dwell takes part in the pairing as
  // an anchor and is never emitted; addSpineDwells makes it a stop afterwards.
  const anchors = baseAnchors(dayPath, stops, base);
  const seq = anchors.length
    ? [...stops, ...anchors].sort((a, b) => (a.start_ts_ms ?? 0) - (b.start_ts_ms ?? 0))
    : stops;

  const resolvePoint = opts.resolvePoint || (() => null);
  const lookupFeatures = opts.features || nearbyFeatures;
  const baseNeighborhood = (() => {
    const r = resolvePoint(base.lat, base.lon, null);
    return (r && r.neighborhood) || null;
  })();

  const out = [];
  const keep = (s) => { if (!s._anchor) out.push(s); };
  let i = 0;
  while (i < seq.length) {
    const a = seq[i];
    if (!isBaseStop(a, base)) { keep(a); i += 1; continue; }

    // Find the next base stop; everything strictly between is the excursion.
    let j = i + 1;
    while (j < seq.length && !isBaseStop(seq[j], base)) j += 1;
    if (j >= seq.length) { keep(a); i += 1; continue; }

    const inner = seq.slice(i + 1, j);
    const b = seq[j];
    const fromMs = a.end_ts_ms, toMs = b.start_ts_ms;
    const mins = (toMs - fromMs) / 60_000;
    const named = inner.filter(isNamedStop);
    const dwells = inner.filter(s => !isNamedStop(s) && isUnnamedDwell(s));
    const points = pointsIn(dayPath, fromMs, toMs);
    const turn = points.length ? turnaroundOf(points, base) : null;
    const routedM = Math.round(routedMetersIn(dayPath, fromMs, toMs));

    const kmh = mins > 0 ? (routedM / 1000) / (mins / 60) : 0;
    const reject =
      named.length ? `named stop inside (${named.map(s => s.place.name).join(", ")})`
      : dwells.length ? `unnamed dwell inside (${dwells.map(s => `${s.duration_min} min at ${s.pace_kmh == null ? "unmeasured" : s.pace_kmh + " km/h"}`).join(", ")})`
      : mins < MIN_EXCURSION_MIN ? `only ${Math.round(mins)} min`
      : !turn ? "no path geometry"
      : turn.away_m < MIN_AWAY_M ? `never got further than ${turn.away_m} m from base`
      : kmh < MIN_WALK_KMH ? `${kmh.toFixed(1)} km/h over ${Math.round(mins)} min — stopped somewhere, we just don't know where`
      : kmh >= MAX_WALK_KMH && process.env.JORI_EXCURSION_DRIVES !== "1" ? `driven at ${kmh.toFixed(1)} km/h — a trip somewhere, not a walk`
      : null;

    if (reject) {
      // Recorded either way: a walk that did NOT become a block is exactly the
      // thing someone will ask about later.
      excursions.push({
        from: a.end, to: b.start, minutes: Math.round(mins),
        routed_m: routedM, away_m: turn ? turn.away_m : null,
        kmh: Math.round(kmh * 100) / 100,
        emitted: false, reason: reject,
      });
      keep(a);
      i += 1;
      continue;
    }

    const turnR = resolvePoint(turn.lat, turn.lon, new Date(turn.t).toISOString());
    const features = await lookupFeatures(points);
    const feature = dominantFeature(points, features);
    const title = titleFor({
      feature,
      turnNeighborhood: (turnR && turnR.neighborhood) || null,
      baseNeighborhood,
    });

    const walk = {
      // renumbered below, from a real stop's id (an anchor's is the spine's "d9")
      id: [a, b, ...stops].find(s => !s._anchor).id,
      start: a.end, end: b.start,
      start_ts_ms: fromMs, end_ts_ms: toMs,
      duration_min: Math.round(mins),
      lat: turn.lat, lon: turn.lon,
      place: { name: title, address: null, source: "excursion", confidence: 0.7, distance_m: null },
      // Companions come only from what was actually recorded against the
      // absorbed stops. We do NOT inherit the base stop's companions: someone
      // being home all day is not evidence they came on the walk.
      companions: [...new Set(inner.flatMap(s => s.companions || []))],
      activity: null,
      photos: inner.flatMap(s => s.photos || []),
      alternatives: [],
      pattern: "browse",
      user_non_stop: false,
      sample_count: inner.reduce((t, s) => t + (s.sample_count || 0), 0) || null,
      cluster_radius_km: null,
      calendar_event: inner.map(s => s.calendar_event).find(Boolean) || null,
      excursion: {
        from_base: base.name || null,
        routed_m: routedM,
        away_m: turn.away_m,
        kmh: Math.round(kmh * 100) / 100,
        turnaround: { lat: turn.lat, lon: turn.lon,
                      neighborhood: (turnR && turnR.neighborhood) || null },
        feature: feature ? { name: feature.name, kind: feature.kind,
                             coverage: Math.round(feature.cov * 100) / 100 } : null,
        // What the walk swallowed. These were unnamed by definition, but the
        // list is how a later correction knows which rows to attach a name to.
        absorbed: inner.map(s => ({ id: s.id, start: s.start, end: s.end,
                                    was: (s.place && s.place.name) || null })),
      },
    };
    excursions.push({
      from: walk.start, to: walk.end, minutes: walk.duration_min,
      routed_m: routedM, away_m: turn.away_m, kmh: Math.round(kmh * 100) / 100,
      emitted: true, title, absorbed: inner.length,
    });

    keep(a);
    out.push(walk);
    i = j;   // b is the next iteration's `a`
  }

  // Ids are positional; renumber so the day stays contiguous (mergeWalkChains
  // does the same after it folds a chain).
  out.forEach((s, idx) => { s.id = String(s.id).replace(/-\d+$/, `-${idx + 1}`); });
  return { stops: out, excursions };
}

// -------- loops out of ANY place, inside a gap (2026-10-06) --------
//
// 2026-10-06: every trek outside the home should be listed even if the user
// don't linger long in one place — a walk/drive is an event to be captured...
// unless a walk or drive are to get to a destination event... It's only
// interesting if the drive/walk are the event itself (e.g. not to get to a
// point and back)."
//
// The base→base pass above only sees a walk when a STOP closes it. On
// 2026-10-05 the dog walk left the flat at 17:25, came back at 18:05, sat home
// 21 minutes, then drove to dinner — the return was never a stop (too short,
// too quiet), so the gap ran flat → a restaurant, a trip to a destination, and the
// walk inside it was invisible. So, inside every gap between consecutive
// stops: if the path leaves the gap's starting place (≥ MIN_AWAY_M) and comes
// back within BASE_MATCH_M of it, that loop is the event — a walk, or a drive
// at driving pace. A path that goes from A to B never loops, so the trip to
// dinner stays a gap. If the user then stayed at the starting place ≥ LOOP_STAY_MIN
// before leaving again, that stay is a stop of its own.
const LOOP_DRIVE_KMH = 12;
const LOOP_STAY_MIN = 10;
const LOOP_LEAVE_MPS = 5000 / 3600;   // 5 km/h
// Lower than MIN_WALK_KMH: a loop's distance is often straight lines between
// sparse fixes, which undercounts a real walk; the "sat somewhere" case this
// guards against runs ~0.5 km/h (2026-08-23).
const LOOP_MIN_KMH = 1.2;

// Every out-and-back from `anchor` inside [fromMs, toMs], in order. A loop
// starts at the last point near the anchor before the path got MIN_AWAY_M
// away, and ends at the first point back near it.
function findLoops(points, anchor, fromMs, toMs) {
  const near = (p) => haversineMeters(p.lat, p.lon, anchor.lat, anchor.lon) <= BASE_MATCH_M;
  // A quiet phone at home gives no departure time: the last fix there can be
  // long before leaving (2026-10-04: 17:54 at home, 18:15 already 216 m out).
  // So the start is estimated back from the first fix outside, at walking
  // pace — never earlier than that last fix at home.
  const leaveFrom = (lastNear, out) => Math.max(lastNear,
    out.t - haversineMeters(out.lat, out.lon, anchor.lat, anchor.lon) / LOOP_LEAVE_MPS * 1000);
  const loops = [];
  let leftAt = fromMs, out = null, far = false;
  for (const p of points) {
    if (p.t < fromMs || p.t > toMs) continue;
    if (!far) {
      if (near(p)) { leftAt = Math.max(leftAt, p.t); out = null; continue; }
      if (!out) out = p;
      if (haversineMeters(p.lat, p.lon, anchor.lat, anchor.lon) >= MIN_AWAY_M) far = true;
    } else if (near(p)) {
      loops.push({ start: Math.round(leaveFrom(leftAt, out)), end: p.t });
      far = false; leftAt = p.t; out = null;
    }
  }
  return loops;
}

// How long the user stayed at the anchor after `fromMs` before the path left it.
function stayUntil(points, anchor, fromMs, toMs) {
  let end = fromMs;
  for (const p of points) {
    if (p.t <= fromMs || p.t > toMs) continue;
    if (haversineMeters(p.lat, p.lon, anchor.lat, anchor.lon) > BASE_MATCH_M) break;
    end = p.t;
  }
  return end;
}

// A stop shorter than this inside a loop's window is part of the walk, not a
// destination — 2026-10-04's 1-minute promenade stop sat in the middle of a
// 55-minute walk with the dog and hid it. A real destination is a stop the user
// stayed at; the theater rule still holds for anything longer.
const LOOP_ABSORB_MAX_MIN = 10;

async function detectGapLoops(stops, dayPath, opts = {}) {
  const loops = [];
  if (!Array.isArray(stops) || stops.length < 1 || !dayPath) return { stops, loops };
  const resolvePoint = opts.resolvePoint || (() => null);
  const lookupFeatures = opts.features || nearbyFeatures;
  const hmOf = opts.hmFromMs || ((ms) => new Date(ms).toISOString().slice(11, 16));
  const isMove = (s) => s.excursion || s.user_non_stop || s.is_movement;
  const queue = [...stops];
  const out = [];
  while (queue.length) {
    const a = queue.shift();
    out.push(a);
    if (a.lat == null || isMove(a)) continue;
    // The window runs from the stop's start to the next stop the user actually
    // stayed at — short slivers in between are candidates for absorption.
    let k = 0;
    while (k < queue.length && !isMove(queue[k])
           && (queue[k].duration_min ?? (queue[k].end_ts_ms - queue[k].start_ts_ms) / 60_000) < LOOP_ABSORB_MAX_MIN) k += 1;
    const next = queue[k];
    if (next && isMove(next)) continue;     // a described walk already owns this stretch
    const fromMs = a.start_ts_ms;
    const toMs = next ? next.start_ts_ms : a.end_ts_ms;
    const allPts = pointsIn(dayPath, fromMs, toMs);
    let chosen = null;
    for (const loop of findLoops(allPts, a, fromMs, toMs)) {
      const mins = (loop.end - loop.start) / 60_000;
      const pts = allPts.filter(p => p.t >= loop.start && p.t <= loop.end);
      const turn = turnaroundOf(pts, a);
      const routedM = Math.round(routedMetersIn(dayPath, loop.start, loop.end));
      const kmh = mins > 0 ? (routedM / 1000) / (mins / 60) : 0;
      // A loop must leave the stop after the user had actually been there, so the
      // walk IN to a stop is never mistaken for a walk out of it.
      const reject = loop.start - a.start_ts_ms < 5 * 60_000 ? "arrival, not a departure"
        : mins < MIN_EXCURSION_MIN ? `only ${Math.round(mins)} min`
        : !turn || turn.away_m < MIN_AWAY_M ? "never got far"
        : kmh < LOOP_MIN_KMH ? `${kmh.toFixed(1)} km/h — stopped somewhere, not a walk`
        : null;
      if (reject) {
        loops.push({ from_stop: a.id, start: hmOf(loop.start), end: hmOf(loop.end),
                     minutes: Math.round(mins), routed_m: routedM, emitted: false, reason: reject });
        continue;
      }
      chosen = { ...loop, mins, pts, turn, routedM, kmh };
      break;
    }
    if (!chosen) continue;
    const { turn, routedM, kmh, pts } = chosen;
    const mode = kmh >= LOOP_DRIVE_KMH ? "driving" : "walking";
    // Slivers the loop swallowed travel with it; the first named one is where
    // the walk went.
    const absorbed = queue.slice(0, k).filter(x => x.start_ts_ms < chosen.end && x.end_ts_ms > chosen.start);
    for (const x of absorbed) queue.splice(queue.indexOf(x), 1);
    const via = absorbed.find(x => x.place && x.place.name);
    const turnR = resolvePoint(turn.lat, turn.lon, new Date(turn.t).toISOString());
    const anchorR = resolvePoint(a.lat, a.lon, null);
    const feature = dominantFeature(pts, await lookupFeatures(pts));
    const noun = mode === "driving" ? "Drive" : "Walk";
    const title = (!feature && via) ? `${noun} to ${via.place.name}`
      : titleFor({ feature, mode, turnNeighborhood: (turnR && turnR.neighborhood) || null,
                   baseNeighborhood: (anchorR && anchorR.neighborhood) || null });
    const origEnd = a.end_ts_ms;
    // The stop gives up the time the trace places the user away.
    if (a.end_ts_ms > chosen.start) {
      a.end_ts_ms = chosen.start; a.end = hmOf(chosen.start);
      a.duration_min = Math.round((a.end_ts_ms - a.start_ts_ms) / 60_000);
    }
    // ...and the photos taken in that time. Short stops dropped earlier handed
    // theirs to this one by nearest time (2026-10-17: the two seafront shots at
    // 20:04 sat under the 4pm flat block, and the walk they were taken on had none).
    const tsOf = (p) => Date.parse(p.ts || p.taken_at || "");
    const takenIn = (from, to) => (a.photos || []).filter(p => tsOf(p) >= from && tsOf(p) <= to);
    const onWalk = takenIn(chosen.start, chosen.end);
    a.photos = (a.photos || []).filter(p => !onWalk.includes(p));
    const loopStop = {
      id: `${a.id}-loop`, start: hmOf(chosen.start), end: hmOf(chosen.end),
      start_ts_ms: chosen.start, end_ts_ms: chosen.end, duration_min: Math.round(chosen.mins),
      lat: turn.lat, lon: turn.lon,
      place: { name: title, address: null, source: "excursion", confidence: 0.7, distance_m: null },
      companions: [...new Set(absorbed.flatMap(x => x.companions || []))], activity: null,
      photos: [...onWalk, ...absorbed.flatMap(x => x.photos || [])], alternatives: [], pattern: "browse",
      user_non_stop: false, sample_count: null, cluster_radius_km: null, calendar_event: null,
      excursion: { from_base: (a.place && a.place.name) || null, routed_m: routedM, away_m: turn.away_m,
        kmh: Math.round(kmh * 100) / 100, mode,
        turnaround: { lat: turn.lat, lon: turn.lon, neighborhood: (turnR && turnR.neighborhood) || null },
        feature: feature ? { name: feature.name, kind: feature.kind, coverage: Math.round(feature.cov * 100) / 100 } : null,
        absorbed: absorbed.map(x => ({ id: x.id, start: x.start, end: x.end, was: (x.place && x.place.name) || null })),
        loop_in_gap: true },
    };
    out.push(loopStop);
    // Back at the anchor afterwards: the rest of the stop's own window, or —
    // when the loop ran past it — however long the trace keeps the user there.
    const backEnd = Math.max(origEnd, stayUntil(allPts, a, chosen.end, toMs));
    if ((backEnd - chosen.end) / 60_000 >= LOOP_STAY_MIN) {
      const onReturn = takenIn(chosen.end + 1, backEnd);
      a.photos = a.photos.filter(p => !onReturn.includes(p));
      // Re-queued, so a second walk from the same place later is found too.
      queue.unshift({ ...a, id: `${a.id}-back`, start: hmOf(chosen.end), end: hmOf(backEnd),
        start_ts_ms: chosen.end, end_ts_ms: backEnd,
        duration_min: Math.round((backEnd - chosen.end) / 60_000), photos: onReturn, returned_after_loop: true });
    }
    loops.push({ from_stop: a.id, title, mode, start: loopStop.start, end: loopStop.end,
      minutes: loopStop.duration_min, routed_m: routedM, away_m: turn.away_m, emitted: true,
      absorbed: absorbed.length });
  }
  return { stops: out, loops };
}

// -------- a stretch on the move, between two stops (2026-10-13) --------
//
// The base→base rule above sees only walks that START and END at the nightly
// base. On 2026-10-12 an old-city walk ran from the car to a bakery: two hours
// on foot through the old city, every GPS cluster inside it answered "not a
// stop" (by the user, and by stop-passage's Jev layer). Those answers
// correctly removed the café GUESSES — and with nothing left in the window, the
// walk itself became an italic "travel" line and its photos went to the bakery.
// "Not a stop" is a statement about a place, not about the time: a long
// stretch of it IS the event. This titles such a stretch from geometry, the
// same way an excursion is titled; resolve-day decides when to emit it.
async function titleStretch(dayPath, fromMs, toMs, opts = {}) {
  const resolvePoint = opts.resolvePoint || (() => null);
  const lookupFeatures = opts.features || nearbyFeatures;
  // The matcher leaves holes; on 2026-10-12 the whole old-city walk had no
  // legs. Then the caller's own points (the clusters it absorbed) stand in,
  // and distance is straight lines between them — a floor, labelled as such.
  let points = pointsIn(dayPath, fromMs, toMs);
  let routedM = Math.round(routedMetersIn(dayPath, fromMs, toMs));
  let geometry = "matched";
  if (!points.length && (opts.points || []).length) {
    points = opts.points.slice().sort((a, b) => a.t - b.t);
    routedM = Math.round(points.slice(1).reduce((m, p, i) =>
      m + haversineMeters(points[i].lat, points[i].lon, p.lat, p.lon), 0));
    geometry = "straight_line_fallback";
  }
  const mins = (toMs - fromMs) / 60_000;
  const kmh = mins > 0 ? (routedM / 1000) / (mins / 60) : 0;
  const mode = kmh >= LOOP_DRIVE_KMH ? "driving" : "walking";
  const anchor = points[0] || null;
  const turn = anchor ? turnaroundOf(points, anchor) : null;
  // The middle of the stretch, by time, is where the user spent it; the turnaround
  // of an A→B walk is just its far end.
  const mid = points.length ? points[Math.floor(points.length / 2)] : null;
  const midR = mid ? resolvePoint(mid.lat, mid.lon, new Date(mid.t).toISOString()) : null;
  const features = points.length ? await lookupFeatures(points) : [];
  const feature = dominantFeature(points, features);
  const title = titleFor({ feature, turnNeighborhood: null,
                           baseNeighborhood: (midR && midR.neighborhood) || null, mode });
  return { title, mode, routed_m: routedM, geometry, kmh: Math.round(kmh * 100) / 100,
           lat: mid ? mid.lat : null, lon: mid ? mid.lon : null,
           away_m: turn ? turn.away_m : null,
           neighborhood: (midR && midR.neighborhood) || null,
           feature: feature ? { name: feature.name, kind: feature.kind,
                                coverage: Math.round(feature.cov * 100) / 100 } : null };
}

module.exports = {
  detectExcursions,
  detectGapLoops,
  titleStretch,
  routedMetersIn,
  legsIn,
  _internal: {
    dayBase, isBaseStop, isNamedStop, isUnnamedDwell, turnaroundOf, pointsIn, dominantFeature,
    titleFor, findLoops, nearbyFeatures, haversineMeters, bboxOf,
    SETTLED_SOURCES, BASE_MATCH_M, BASE_MIN_MIN, MIN_EXCURSION_MIN, MIN_AWAY_M,
    DWELL_BLOCK_MIN, DWELL_BLOCK_KMH, MIN_WALK_KMH,
    FEATURE_NEAR_M, FEATURE_COVERAGE,
  },
};
