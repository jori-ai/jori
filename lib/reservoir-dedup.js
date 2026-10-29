"use strict";
// Pass 2 of the reservoir build: dedup.
//
// A single-shot research prompt asks for five buckets at once, so the same
// venue routinely lands in must_see AND optional AND as a food_specialty's
// best_place under three slightly different names, and the same dish shows up
// three times ("the foods should not be repeated"). Nothing caught that before:
// carryAnnotations matched by name equality, which is a lookup, not a dedup.
//
// Dedup here is NON-DESTRUCTIVE. A loser keeps its row and gets
// state:"duplicate" + dup_of:<winner id>. That matters for two reasons:
// carryAnnotations still finds it on the next rebuild (so a done/skip mark
// isn't lost when a merge is later revised), and a wrong merge is recoverable
// by hand instead of being a silent deletion. Renderers filter duplicates out.
//
// Three tiers, cheapest first:
//   1. venue identity  — exact mapsUri match (a stable Google place identity,
//      already stamped on every verified entry by the reservoir build).
//   2. dish identity   — normalized dish name within food_specialties.
//   3. fuzzy residue   — pairs that are *similar but uncertain* are returned as
//      candidates for the caller to resolve (one bounded model call over just
//      the pairs). The lib stays pure so it tests without a model.

const { haversineM } = require("./reservoir-done.js");

// Cross-bucket precedence when the same VENUE appears twice. A place that is
// both a must-see and an "optional" is a must-see.
const BUCKET_RANK = {
  must_see: 0,
  unique_experiences: 1,
  time_sensitive: 2,
  food_specialties: 3,
  optional: 4,
};
const SECTION_ORDER = ["must_see", "optional", "food_specialties", "unique_experiences", "time_sensitive"];

// Same-venue proximity for entries that verified to slightly different Places
// records (a museum vs its ticket office). Tight on purpose: two genuinely
// different restaurants on one street are ~40m apart, so anything looser starts
// merging real distinct entries.
const SAME_VENUE_M = 75;

// Name similarity bands. Above HIGH we merge without asking; between LOW and
// HIGH it's a fuzzy candidate; below LOW they're unrelated.
const NAME_SIM_HIGH = 0.9;
const NAME_SIM_LOW = 0.62;

function stripAccents(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Lowercase, de-accent, drop leading articles and punctuation. "Le Marché
// Couvert" and "marche couvert" have to collapse to one key.
function normName(s) {
  return stripAccents(s)
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/&/g, " et ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(le|la|les|l|du|de|des|d|the|a|au|aux)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The research prompt returns `dish` as a DESCRIPTION, not a name — e.g.
// "Pâté de Townsville (pâté en croûte of game — partridge/pheasant, duck, veal
// and pork...)". Comparing whole strings finds nothing, which is why repeated
// foods survived. The dish is the head phrase; everything after the first
// parenthesis, dash, slash or comma is gloss.
// NB: the split set deliberately excludes the plain hyphen. It's word-internal
// in French — splitting on it turns "Marennes-Oléron oysters" into "Marennes"
// and "Galette-saucisse" into "Galette", destroying the very tokens that
// identify the dish. Em/en dashes are gloss separators; hyphens are not.
function dishHead(s) {
  return String(s || "").split(/[(—–\/,;:]/)[0].trim() || String(s || "").trim();
}

// Dishes need a rougher hand than venues: plural/singular drift and the
// "specialite de X" phrasing are the same dish, not two.
function normDish(s) {
  return normName(dishHead(s))
    .replace(/\b(specialite|specialty|traditional|local|classique|maison)\b/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.replace(/s$/, ""))
    .join(" ")
    .trim();
}

// Dice coefficient over bigrams — cheap, no dependency, and forgiving of the
// word-order drift research output actually produces.
function similarity(a, b) {
  const x = normName(a).replace(/\s/g, "");
  const y = normName(b).replace(/\s/g, "");
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const grams = new Map();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) || 0;
    if (n > 0) { grams.set(g, n - 1); hits++; }
  }
  return (2 * hits) / (x.length - 1 + y.length - 1);
}

// The display name of an entry, whatever bucket it's in. food_specialties have
// no `name` — they carry dish + best_place — which is exactly the asymmetry
// that made name-keyed matching unreliable everywhere else in this pipeline.
function displayName(e) {
  return e.name || e.dish || e.best_place || "";
}
// The VENUE an entry sends you to. For a food specialty that's the restaurant,
// not the dish.
function venueName(e) {
  return e.best_place || e.name || "";
}

// Venue names routinely carry a location suffix — "Crêperie Example,
// Townsville intra-muros". Two unrelated shops on one street then score as
// similar purely on the shared suffix, so compare the head only. Erring toward
// "different" is the safe direction here: nothing gets merged wrongly.
function venueHead(e) {
  const n = venueName(e);
  const head = n.split(/[,—–]/)[0].trim();
  return head || n;
}

function isFood(bucket) {
  return bucket === "food_specialties";
}

// Flatten to a working list, tagging each entry with its bucket + array index
// so decisions can be written back in place.
function flatten(reservoir) {
  const out = [];
  const buckets = reservoir.buckets || {};
  for (const bucket of SECTION_ORDER) {
    const arr = buckets[bucket] || [];
    for (let i = 0; i < arr.length; i++) out.push({ bucket, i, e: arr[i] });
  }
  return out;
}

// Two entries point at the same physical venue?
//  - identical mapsUri            -> certain
//  - within 75m and names similar -> certain
//  - within 75m, names in the middle band -> uncertain (fuzzy candidate)
function venueRelation(a, b) {
  if (a.e.mapsUri && b.e.mapsUri && a.e.mapsUri === b.e.mapsUri) return "same";
  const aHas = a.e.lat != null && a.e.lon != null;
  const bHas = b.e.lat != null && b.e.lon != null;
  if (!aHas || !bHas) return "none";
  const m = haversineM(a.e.lat, a.e.lon, b.e.lat, b.e.lon);
  if (m > SAME_VENUE_M) return "none";
  const sim = similarity(venueHead(a.e), venueHead(b.e));
  if (sim >= NAME_SIM_HIGH) return "same";
  if (sim >= NAME_SIM_LOW) return "maybe";
  // Close together but clearly different names: two neighbouring businesses.
  return "none";
}

function rankOf(x) {
  return BUCKET_RANK[x.bucket] ?? 99;
}

// Winner between two same-venue entries: better bucket first, then the one with
// a resolved rating, then the richer description, then stable by id.
function preferred(a, b) {
  const ra = rankOf(a), rb = rankOf(b);
  if (ra !== rb) return ra < rb ? a : b;
  const rateA = Number(a.e.rating) || 0, rateB = Number(b.e.rating) || 0;
  if (rateA !== rateB) return rateA > rateB ? a : b;
  const whyA = (a.e.why || "").length, whyB = (b.e.why || "").length;
  if (whyA !== whyB) return whyA > whyB ? a : b;
  return String(a.e.id || "") <= String(b.e.id || "") ? a : b;
}

function markDuplicate(loser, winner, reason) {
  loser.e.state = "duplicate";
  loser.e.dup_of = winner.e.id || displayName(winner.e);
  loser.e.dup_reason = reason;
}

// Same venue, but one is a dish and the other is a sight: keep BOTH (eating at
// a place and visiting it are different intents) and link them, so the map
// draws one pin instead of two stacked on identical coordinates.
function linkVenue(a, b) {
  const key = a.e.mapsUri || b.e.mapsUri || `${a.e.lat},${a.e.lon}`;
  a.e.same_venue_as = key;
  b.e.same_venue_as = key;
}

// --- tier 2: dish dedup ------------------------------------------------------
// The failure this fixes: the same food appearing several times. Group
// food_specialties by normalized dish, keep the best-rated instance.
function dedupDishes(items, stats) {
  const byDish = new Map();
  for (const it of items) {
    if (!isFood(it.bucket) || it.e.state === "duplicate") continue;
    // A "table" entry is a restaurant, not a dish — it has no `dish` to key on,
    // and two different family restaurants are not duplicates of each other
    // just because neither is about a specific food. They still dedupe as
    // VENUES below (same mapsUri / <75m + similar name), which is the correct
    // identity for them.
    if (it.e.kind === "table" || !it.e.dish) continue;
    const key = normDish(it.e.dish);
    if (!key) continue;
    if (!byDish.has(key)) byDish.set(key, []);
    byDish.get(key).push(it);
  }
  for (const [, group] of byDish) {
    if (group.length < 2) continue;
    let winner = group[0];
    for (const it of group.slice(1)) winner = preferred(winner, it);
    for (const it of group) {
      if (it === winner) continue;
      markDuplicate(it, winner, "same dish");
      stats.dishes++;
    }
  }
}

// --- tier 1: venue dedup -----------------------------------------------------
function dedupVenues(items, stats, fuzzy) {
  const live = items.filter((it) => it.e.state !== "duplicate");
  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      const A = live[a], B = live[b];
      if (A.e.state === "duplicate" || B.e.state === "duplicate") continue;
      const rel = venueRelation(A, B);
      if (rel === "none") continue;
      const foodA = isFood(A.bucket), foodB = isFood(B.bucket);
      if (rel === "maybe") {
        fuzzy.push({
          kind: "venue",
          a: { id: A.e.id, bucket: A.bucket, name: venueName(A.e), why: A.e.why || "" },
          b: { id: B.e.id, bucket: B.bucket, name: venueName(B.e), why: B.e.why || "" },
        });
        continue;
      }
      // rel === "same"
      if (foodA !== foodB) { linkVenue(A, B); stats.linked++; continue; }
      if (foodA && foodB) {
        // Two dishes at one restaurant is legitimate (dish dedup already ran).
        linkVenue(A, B); stats.linked++; continue;
      }
      const winner = preferred(A, B);
      const loser = winner === A ? B : A;
      markDuplicate(loser, winner, "same venue");
      stats.venues++;
    }
  }
}

// --- tier 3: fuzzy dish candidates ------------------------------------------
// Two dishes in the same family — "galette de sarrasin" vs "galette complète" —
// are the repeat a reader actually notices, but bigram similarity SCORES THEM LOW
// (0.43): the shared head noun gets diluted by the differing modifier. So dish
// candidacy keys on a shared significant token instead, which is what "same
// family" really means.
//
// The harder case ("galette de sarrasin" vs "crêpe salée" — same food, no
// shared word) has no cheap signal at all. Rather than pretend otherwise, the
// full surviving dish roster goes back with the report so the caller's single
// model call can consider the whole set at once; it's 6-12 dishes per area.
const STOP_TOKENS = new Set(["de", "du", "des", "la", "le", "les", "au", "aux", "et", "a", "avec"]);
function significantTokens(s) {
  return new Set(normDish(s).split(" ").filter((w) => w.length >= 4 && !STOP_TOKENS.has(w)));
}

// A token shared by MOST of the roster carries no signal — in a town named for a dish every
// dish says the town's name, in Paris every one says "cuisine". Keying on those
// turned a bounded candidate list into 50 noisy pairs. Drop any token common
// enough to be background vocabulary for the area.
const COMMON_TOKEN_RATIO = 0.34;
// Document frequency is an estimate; below this many dishes it means nothing
// and the filter would discard the only signal there is (on a 2-dish roster
// every shared token is "common" by definition).
const MIN_ROSTER_FOR_IDF = 6;
function discriminatingTokens(tokenSets) {
  if (tokenSets.length < MIN_ROSTER_FOR_IDF) return tokenSets;
  const df = new Map();
  for (const set of tokenSets) for (const t of set) df.set(t, (df.get(t) || 0) + 1);
  const limit = Math.max(2, Math.ceil(tokenSets.length * COMMON_TOKEN_RATIO));
  return tokenSets.map((set) => new Set([...set].filter((t) => df.get(t) < limit)));
}

function fuzzyDishPairs(items, fuzzy) {
  const foods = items.filter((it) => isFood(it.bucket) && it.e.state !== "duplicate");
  const toks = discriminatingTokens(foods.map((it) => significantTokens(it.e.dish)));
  for (let a = 0; a < foods.length; a++) {
    for (let b = a + 1; b < foods.length; b++) {
      let shared = false;
      for (const t of toks[a]) if (toks[b].has(t)) { shared = true; break; }
      if (!shared) continue;
      fuzzy.push({
        kind: "dish",
        a: { id: foods[a].e.id, dish: foods[a].e.dish, place: foods[a].e.best_place || "" },
        b: { id: foods[b].e.id, dish: foods[b].e.dish, place: foods[b].e.best_place || "" },
      });
    }
  }
}

// Every surviving dish, for the caller's whole-set "any of these the same
// food?" question — the only way to catch same-food-different-words.
function dishRoster(items) {
  return items
    .filter((it) => isFood(it.bucket) && it.e.state !== "duplicate")
    // Tables carry no dish, so there is nothing for the fuzzy dish resolver to
    // compare — feeding it nulls just invites it to merge unrelated restaurants.
    .filter((it) => it.e.kind !== "table" && it.e.dish)
    .map((it) => ({ id: it.e.id, dish: it.e.dish, place: it.e.best_place || "" }));
}

// Apply a resolver's verdicts on the fuzzy candidates. `verdicts` is
// [{a, b, same: bool}] — ids, so it round-trips through a model cleanly.
function applyVerdicts(reservoir, verdicts) {
  if (!verdicts || !verdicts.length) return { merged: 0 };
  const items = flatten(reservoir);
  const byId = new Map(items.map((it) => [it.e.id, it]));
  let merged = 0;
  for (const v of verdicts) {
    if (!v || !v.same) continue;
    const A = byId.get(v.a), B = byId.get(v.b);
    if (!A || !B) continue;
    if (A.e.state === "duplicate" || B.e.state === "duplicate") continue;
    const winner = preferred(A, B);
    const loser = winner === A ? B : A;
    markDuplicate(loser, winner, v.reason || "resolved duplicate");
    merged++;
  }
  return { merged };
}

// Main entry point. Mutates `reservoir` in place and returns a report:
//   { stats: {venues, dishes, linked}, fuzzy: [candidate...] }
// The caller decides whether to resolve `fuzzy` with a model and then calls
// applyVerdicts. Re-running is safe: entries already marked duplicate are
// skipped, so a rebuild doesn't cascade merges.
function dedupeReservoir(reservoir) {
  const stats = { venues: 0, dishes: 0, linked: 0 };
  const fuzzy = [];
  const items = flatten(reservoir);
  // Clear any prior automatic marks so a rebuild re-derives from scratch;
  // never clear a HUMAN done/skip.
  for (const it of items) {
    if (it.e.state === "duplicate") {
      delete it.e.dup_of;
      delete it.e.dup_reason;
      it.e.state = "open";
    }
  }
  dedupDishes(items, stats);
  dedupVenues(items, stats, fuzzy);
  fuzzyDishPairs(items, fuzzy);
  return { stats, fuzzy, dish_roster: dishRoster(items) };
}

module.exports = {
  dedupeReservoir,
  applyVerdicts,
  // exported for tests + reuse by the cluster pass
  normName,
  normDish,
  dishHead,
  venueHead,
  similarity,
  displayName,
  venueName,
  flatten,
  SECTION_ORDER,
  BUCKET_RANK,
};
