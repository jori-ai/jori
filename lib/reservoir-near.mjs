// reservoir-near — what the trip reservoir already knows about where the user is
// standing right now.
//
// WHY THIS EXISTS. The requirement: a nearby ping should carry something of
// value — information about the area, interesting or relevant places around
// the user. The obvious reading is "add web search to the nearby lane", and it
// is the wrong one: the search has already happened.
//
// The reservoir build researches every area of a trip in advance and stores
// the result in `trip_reservoirs` — for a typical city stay that is a dozen or more
// geo-tagged clusters and five buckets (must_see, optional, time_sensitive,
// food_specialties, unique_experiences), every entry carrying lat/lon, a
// specific `why`, `verified: true`, and for the perishable ones `days`, `hours`
// and a `source_url`. It is vetted against the user's taste by the itinerary pipeline,
// and it records `state: "done"` for places already visited.
//
// The `nearby` lane had never read a byte of it. It was asked to produce
// "something specific and verifiable" about the neighbourhood from a Sonnet
// call with no tools and no sources — which is the setup that produces either
// silence or a confident guess. Meanwhile the verified answer was sitting in
// Postgres, geo-tagged.
//
// So: reservoir first (free, instant, verified, taste-matched, and aware of
// what the user has already seen), and a web search only as the fallback for an area
// no trip covers — see `neighborhood-brief`.
//
// Distances are geometry, so code owns them (Rule #0b). Nothing here reads or
// interprets anything the user wrote.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), "reservoir-store.js");

// Buckets worth surfacing while the user is standing somewhere, in the order they
// deserve attention. `time_sensitive` leads deliberately: an entry that carries
// its own end date and source URL is both the most useful thing to say and the
// easiest to say truthfully (Rule #2 — it is dated at the source).
const BUCKET_ORDER = ["time_sensitive", "unique_experiences", "must_see", "food_specialties", "optional"];

/** Metres between two points. */
export function haversineM(la1, lo1, la2, lo2) {
  const R = 6371000;
  const dLa = (la2 - la1) * Math.PI / 180;
  const dLo = (lo2 - lo1) * Math.PI / 180;
  const a = Math.sin(dLa / 2) ** 2
    + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return Math.round(R * 2 * Math.asin(Math.sqrt(a)));
}

/** The reservoir for the metro the user is in, or null. Cheap: the store caches. */
function loadReservoir(metro) {
  if (!metro) return null;
  try {
    const raw = execFileSync("node", ["-e", `
      const s = require(${JSON.stringify(STORE)});
      s.pullReservoir(${JSON.stringify(metro)}).then(r => console.log(JSON.stringify(r || null))).catch(() => console.log("null"));
    `], { encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(raw || "null");
  } catch { return null; }
}

/**
 * Reservoir entries within `radiusM` of a point, nearest first.
 *
 * Excludes anything already done — re-suggesting a market walked through on
 * Friday is the same failure as re-asking a question already answered, and
 * the reservoir is the one store that reliably knows.
 *
 * @returns {{entries: Array, area: string|null, reason: string}}
 */
export function reservoirNear(metro, lat, lon, { radiusM = 700, limit = 8 } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { entries: [], area: null, reason: "no coordinates" };
  }
  const res = loadReservoir(metro);
  const buckets = res?.structured?.buckets || res?.buckets;
  if (!buckets) return { entries: [], area: metro || null, reason: `no reservoir for ${metro || "this area"}` };

  const out = [];
  // One place, one line. An entry legitimately appears in more than one bucket
  // — Marché des Enfants Rouges is both `must_see` and `time_sensitive` — and
  // BUCKET_ORDER runs most-useful-first, so the first sighting is the one to
  // keep and the duplicate would only pad the prompt.
  const seen = new Set();
  for (const bucket of BUCKET_ORDER) {
    for (const e of (buckets[bucket] || [])) {
      const key = String(e?.name || e?.id || "").toLowerCase().trim();
      if (key && seen.has(key)) continue;
      const elat = Number(e?.lat), elon = Number(e?.lon);
      if (!Number.isFinite(elat) || !Number.isFinite(elon)) continue;
      // Already visited. Not a discovery.
      if (String(e?.state || "").toLowerCase() === "done") continue;
      const d = haversineM(lat, lon, elat, elon);
      if (d > radiusM) continue;
      if (key) seen.add(key);
      out.push({
        bucket,
        name: e.name || null,
        why: e.why || null,
        distance_m: d,
        address: e.address || null,
        rating: e.rating ?? null,
        // Perishability, straight from the source — what makes this sayable.
        date: e.date ?? null,
        days: Array.isArray(e.days) ? e.days : null,
        hours: e.hours || null,
        source_url: e.source_url || null,
        maps_url: e.mapsUri || null,
        dog_ok: e.dog_ok ?? null,
        food_hook: e.food_hook || null,
        verified: e.verified === true,
      });
    }
  }
  out.sort((a, b) => a.distance_m - b.distance_m);
  return {
    entries: out.slice(0, limit),
    area: res?.label || metro || null,
    reason: out.length ? `${out.length} reservoir entr${out.length === 1 ? "y" : "ies"} within ${radiusM}m` : `nothing in the reservoir within ${radiusM}m`,
  };
}

/** Render for a prompt. Kept here so the shape and its explanation travel together. */
export function renderReservoirBlock({ entries, area }) {
  if (!entries?.length) return "";
  const lines = entries.map((e) => {
    const bits = [`${e.distance_m}m`];
    if (e.rating) bits.push(`${e.rating}★`);
    if (e.days) bits.push(e.days.join("/"));
    if (e.hours) bits.push(e.hours);
    if (e.date) bits.push(`until ${e.date}`);
    const head = `  - ${e.name} [${e.bucket}] — ${bits.join(", ")}`;
    const why = e.why ? `\n      ${e.why}` : "";
    const src = e.source_url ? `\n      source: ${e.source_url}` : "";
    return head + why + src;
  });
  return `ALREADY RESEARCHED FOR THIS TRIP — ${area || "this area"} (verified; the user has NOT been to these):
${lines.join("\n")}`;
}
