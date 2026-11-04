"use strict";
// Pass 3 of the reservoir build: geographic clustering + list numbering.
//
// The reservoir is a flat pile of vetted places. What a day actually needs is
// "what can I do together on foot, and what do I have to drive to" — so every
// entry gets a cluster, and the site can regroup by it.
//
// The model, in the terms the user plans in (driving or walking):
//   pod   — things within WALK_KM of each other. You park once and walk between
//           them. Greedy centroid clustering, the same shape as clusterSights()
//           in france-itinerary-layout, generalized so both callers share one
//           implementation instead of growing a second.
//   mode  — how you REACH the pod from the base: "walk" if its centroid is
//           within WALK_FROM_CENTER_KM of the area center, else "drive" (and
//           then km_from_center is the number worth showing).
//
// Two deliberate differences from the itinerary version: food entries ARE
// clustered here (using their best_place coordinates) — "what's near what" is
// the entire point of this view — and entries with no coordinates are not
// dropped, they land in cluster:null and render as an "Unplaced" group with no
// map pin. That last case is real: the reservoir build pushes unverified
// unique_experiences without coords on purpose.

const { haversineM } = require("./reservoir-done.js");
const { SECTION_ORDER, displayName } = require("./reservoir-dedup.js");

// A comfortable stroll between two stops, not a route distance. 1.2km keeps an
// old-town core together without swallowing the next neighbourhood.
const WALK_KM = 1.2;
// How far from the base you'll walk rather than drive. 2.5km, not 1.5: at 1.5
// the Paris reservoir labelled clusters 1.8km from the centre as "drive", which
// is plainly wrong for a city you cross on foot. 2.5 keeps genuinely-driven
// destinations honest — a town 4.3km from a suburban base, or one 22km
// away, still read as drive.
const WALK_FROM_CENTER_KM = 2.5;

function km(aLat, aLon, bLat, bLon) {
  return haversineM(aLat, aLon, bLat, bLon) / 1000;
}

function hasCoords(e) {
  return e && e.lat != null && e.lon != null && Number.isFinite(e.lat) && Number.isFinite(e.lon);
}

// Pull a town / neighbourhood out of a Google formatted address. These look
// like "12 Rue X, 10000 Townsville, France" — the postcode-prefixed component is
// the town, which is the label a human recognizes.
function townOf(e) {
  let parts = String(e.address || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    const m = p.match(/^\d{4,6}\s+(.+)$/);
    if (m) return m[1];
  }
  // The rule above is France-shaped: postcode and town share one component
  // ("10000 Townsville"). Plenty of other countries give the postcode its OWN
  // component AFTER the town — "Palmer St 1, Townsville, 3303139, Freedonia" — so the before-the-country fallback returned the bare postcode and
  // clusters rendered as "3303139" / "9083300" / "88000". Drop pure-postcode
  // components first; then the fallback lands on the town again.
  parts = parts.filter((p) => !/^\d{4,7}$/.test(p));
  // Two components with a street first means Google gave no country at all
  // ("12 Main St, Townsville") — there the TOWN is last, not second-to-last.
  if (parts.length === 2 && /^\d|\b(st|street|rd|road|ave|blvd|rue|via|way|dr|drive)\b\.?$/i.test(parts[0])) {
    return parts[1];
  }
  // No postcode component — fall back to the second-to-last (before country).
  if (parts.length >= 2) return parts[parts.length - 2];
  return parts[0] || "";
}

// Greedy centroid clustering. Same algorithm as the itinerary layout's, lifted
// here so there's one copy: walk the items, join the nearest cluster within the
// radius, otherwise open a new one, and drift the centroid as members join.
function podsOf(items, radiusKm) {
  const pods = [];
  for (const it of items) {
    let best = null, bestD = Infinity;
    for (const p of pods) {
      const d = km(it.e.lat, it.e.lon, p.lat, p.lon);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best && bestD <= radiusKm) {
      best.items.push(it);
      best.lat = best.items.reduce((s, x) => s + x.e.lat, 0) / best.items.length;
      best.lon = best.items.reduce((s, x) => s + x.e.lon, 0) / best.items.length;
    } else {
      pods.push({ lat: it.e.lat, lon: it.e.lon, items: [it] });
    }
  }
  return pods;
}

// Label a pod: the town shared by its members reads best ("Old town", "Townsville");
// with no address to go on, name it after its most important member.
function labelPod(pod) {
  const towns = new Map();
  for (const it of pod.items) {
    const t = townOf(it.e);
    if (t) towns.set(t, (towns.get(t) || 0) + 1);
  }
  if (towns.size) {
    return [...towns.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  const lead = pod.items.find((it) => it.bucket === "must_see") || pod.items[0];
  return displayName(lead.e) || "Nearby";
}

// Entry names carry their own gloss — "Le Canon & L'Herbe oyster villages, Cap
// Ferret". A cluster heading has to fit on one line next to a mode chip, so cut
// to the head phrase and cap it.
const LABEL_MAX = 28;
function shortLabel(s) {
  let out = String(s || "").split(/[(—–,]/)[0].trim();
  if (out.length > LABEL_MAX) {
    const cut = out.slice(0, LABEL_MAX);
    const sp = cut.lastIndexOf(" ");
    out = (sp > 12 ? cut.slice(0, sp) : cut).trim() + "…";
  }
  return out;
}

function slugLabel(s, n) {
  const base = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return base ? `${base}` : `cluster-${n}`;
}

// Regenerate `dont_miss` — the ordered id list day planning reads to rank hero
// stops (the day-plan skill; the reservoir status CLI surfaces it too). Nothing has written it since the
// one-off script that produced it was removed, so every rebuild silently
// dropped it and the itinerary lost its priority signal. Derive it here from
// the same ranking the list already uses: must-sees by rating, then the
// strongest unique experiences.
const DONT_MISS_MAX = 8;
function regenerateDontMiss(reservoir) {
  const b = reservoir.buckets || {};
  const live = (arr) => (arr || []).filter((e) => e && e.state !== "duplicate" && e.id);
  const byRating = (x, y) => (Number(y.rating) || 0) - (Number(x.rating) || 0);
  const must = live(b.must_see).slice().sort(byRating);
  const uniq = live(b.unique_experiences).slice().sort(byRating);
  const ids = [...must.map((e) => e.id), ...uniq.map((e) => e.id)].slice(0, DONT_MISS_MAX);
  reservoir.dont_miss = ids;
  return ids;
}

// Assign `seq` 1..N over the canonical section order, skipping duplicates.
// Stored on the entry so the site list, the map pins, and the wiki renderer all
// read ONE number — pins can't renumber when the page flips to cluster view,
// and the three renderers can't drift into three different numberings.
function assignSeq(reservoir) {
  let n = 0;
  const buckets = reservoir.buckets || {};
  for (const bucket of SECTION_ORDER) {
    for (const e of buckets[bucket] || []) {
      if (!e) continue;
      if (e.state === "duplicate") { delete e.seq; continue; }
      e.seq = ++n;
    }
  }
  return n;
}

// Main entry point. Mutates `reservoir` in place; returns a report.
function clusterReservoir(reservoir) {
  const buckets = reservoir.buckets || {};
  const items = [];
  for (const bucket of SECTION_ORDER) {
    for (const e of buckets[bucket] || []) {
      if (!e || e.state === "duplicate") continue;
      if (hasCoords(e)) items.push({ bucket, e });
      else { e.cluster = null; }
    }
  }

  const pods = podsOf(items, WALK_KM);

  // Rank pods so the biggest / most important reads first, then label + stamp.
  for (const pod of pods) {
    pod.label = labelPod(pod);
    pod.mustCount = pod.items.filter((it) => it.bucket === "must_see").length;
  }
  pods.sort((a, b) => (b.mustCount - a.mustCount) || (b.items.length - a.items.length));

  const centerLat = reservoir.lat, centerLon = reservoir.lon;
  const haveCenter = Number.isFinite(centerLat) && Number.isFinite(centerLon);
  // In a big city every pod's address says the same town, so labelling by town
  // alone produced three clusters all called "Paris" — useless as a heading.
  // Where a town repeats, name the pod after its leading member instead.
  const townCounts = new Map();
  for (const pod of pods) townCounts.set(pod.label, (townCounts.get(pod.label) || 0) + 1);
  for (const pod of pods) {
    if (townCounts.get(pod.label) > 1) {
      const lead = pod.items.find((it) => it.bucket === "must_see") || pod.items[0];
      const near = shortLabel(displayName(lead.e));
      if (!near) continue;
      // The lead entry often already names its town ("Townsville", "Townsville
      // ramparts walk"), and "Townsville · Townsville" reads as a bug. When the
      // disambiguator already carries the town, it IS the label.
      const town = pod.label;
      pod.label = near.toLowerCase().startsWith(town.toLowerCase()) ? near : `${town} · ${near}`;
    }
  }

  const clusters = [];
  pods.forEach((pod, idx) => {
    const dist = haveCenter ? km(centerLat, centerLon, pod.lat, pod.lon) : 0;
    const mode = !haveCenter || dist <= WALK_FROM_CENTER_KM ? "walk" : "drive";
    const id = slugLabel(pod.label, idx + 1);
    const meta = {
      id,
      label: pod.label,
      mode,
      size: pod.items.length,
      km_from_center: Math.round(dist * 10) / 10,
      lat: Math.round(pod.lat * 1e6) / 1e6,
      lon: Math.round(pod.lon * 1e6) / 1e6,
    };
    clusters.push(meta);
    for (const it of pod.items) {
      it.e.cluster = { id, label: pod.label, mode, km_from_center: meta.km_from_center };
    }
  });

  reservoir.clusters = clusters;
  const count = assignSeq(reservoir);
  const dontMiss = regenerateDontMiss(reservoir);

  return {
    clusters,
    numbered: count,
    unplaced: (reservoir.buckets ? Object.values(reservoir.buckets).flat() : [])
      .filter((e) => e && e.state !== "duplicate" && !hasCoords(e)).length,
    dont_miss: dontMiss.length,
  };
}

module.exports = {
  clusterReservoir,
  assignSeq,
  regenerateDontMiss,
  podsOf,
  townOf,
  labelPod,
  WALK_KM,
  WALK_FROM_CENTER_KM,
};
