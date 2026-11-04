// rental-listing-filter.test.mjs — vacation-rental LISTINGS are not venues, and
// must never win a stop's nearest-POI joust.
//
// Hosts publish Airbnb/Vrbo listings into Google Places, so a marina block in a
// tourist town is carpeted with pins whose "name" is a marketing headline. They
// sit meters off the path and can never be corroborated, so they beat the real
// venues on proximity and then get printed as fact — a daily summary once
// titled two walking stretches with them:
//
//   ~T2 Sea View. Portmer the small ones. Near the port. Family. Balcony.?
//   ~Résidence avec Piscine face au port 200m plage? · unconfirmed (also: …)
//
// `location-segment.is_rental_listing` drops them before scoring, so the ladder
// falls through to Nominatim — a beach's name or a street address, which is
// a strictly better label than a listing headline.
//
// The two directions are NOT symmetric. Dropping a real venue costs a hedge that
// was already hedged; keeping a listing prints marketing copy as a place the
// user went. So the false-positive list below is the one that matters — it is
// padded with the exact shapes the heuristics could plausibly over-match (a
// "Studio" museum, a "Maison"/"Villa" restaurant, a real hotel). The town and
// venues are fictional; the shapes are what the heuristics see.
//
// Run: node --test tests/rental-listing-filter.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SEGMENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "location-segment");

// location-segment is a single self-contained script (stdlib only), so it loads
// straight from source — no stubbing, no side effects at import.
function classify(candidates) {
  const driver = `
import sys, importlib.util, importlib.machinery, json
spec = importlib.util.spec_from_loader("seg", importlib.machinery.SourceFileLoader("seg", sys.argv[1]))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(json.dumps([m.is_rental_listing(c) for c in json.loads(sys.argv[2])]))
`;
  const r = spawnSync("python3", ["-c", driver, SEGMENT, JSON.stringify(candidates)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const CITY_ONLY = "99100 Portmer, France";   // a listing pin publishes a city
const STREET = "14 Rue de l'Exemple, 99100 Portmer, France";

test("every listing shape that once polluted a resolved day is caught", () => {
  // The shapes of one real day's primary names and alternatives.
  const listings = [
    { name: "Résidence avec Piscine face au port 200m plage", address: CITY_ONLY },
    { name: "Résidence avec Piscine face au port 200m plage - Standard Studio", address: CITY_ONLY },
    { name: "Charmant appartement 2 pièces près de la plage à Portmer - FR-1-825-17 - Apartment", address: CITY_ONLY },
    { name: "T2 Sea View. Portmer the small ones. Near the port. Family. Balcony.", address: CITY_ONLY },
    { name: "Vrbo Property", address: CITY_ONLY },
    { name: "Appart sea view panoramic terrace at 20m beach Les Galets", address: CITY_ONLY },
  ];
  assert.deepEqual(classify(listings), listings.map(() => true),
    listings.filter((_, i) => !classify(listings)[i]).map(l => l.name).join(" | "));
});

test("other listing shapes are caught too", () => {
  const listings = [
    { name: "Cosy studio sleeps 4 · Old Town", address: CITY_ONLY },
    { name: "Beach house with pool, 3 bedrooms", address: CITY_ONLY },
    { name: "Gîte de charme avec terrasse", address: CITY_ONLY },
    { name: "Sunny loft 2BR steps from the beach", address: CITY_ONLY },
    { name: "Airbnb Rental Unit", address: CITY_ONLY },
    { name: "Bright apartment", address: CITY_ONLY, primary_type: "lodging", reviews: 0 },
  ];
  assert.deepEqual(classify(listings), listings.map(() => true));
});

test("real venues are NOT dropped — this is the direction that must not break", () => {
  const venues = [
    { name: "Equinoxe", address: STREET, primary_type: "restaurant", reviews: 210 },
    { name: "Plage des Galets", address: STREET, primary_type: "park", reviews: 900 },
    { name: "Le Petit Exemple", address: "59 Rue de l'Exemple, 99100 Portmer, France", primary_type: "restaurant", reviews: 88 },
    { name: "La Tour du Phare", address: "10 Rue de l'Exemple, 99200 Villemer, France", primary_type: "restaurant", reviews: 300 },
    { name: "Le Récif", address: "Avenue de la Capitainerie, 99100 Portmer, France", primary_type: "bar", reviews: 120 },
    { name: "Domino's", address: "5 Rue de l'Exemple, 99100 Portmer, France", primary_type: "pizza_restaurant", reviews: 400 },
    // A real hotel is a real stop — ordinary name, street address, reviews.
    { name: "Grand Hotel du Port", address: "30 Quai de l'Exemple, 99100 Portmer, France", primary_type: "hotel", reviews: 620 },
    // Names that deliberately brush the heuristics.
    { name: "Studio Museum of Prints", address: "144 Example Street, Springfield", primary_type: "museum", reviews: 1500 },
    { name: "Maison Lumiere", address: "298 Example Street, Springfield", primary_type: "cocktail_bar", reviews: 3000 },
    { name: "Villa Olivetta", address: "107 Example Street, Springfield", primary_type: "italian_restaurant", reviews: 400 },
    { name: "The Quiet Note", address: "147 Example Street, Springfield", primary_type: "live_music_venue", reviews: 2000 },
    { name: "Golden Lantern Tea Parlor", address: "13 Example Street, Springfield", primary_type: "chinese_restaurant", reviews: 5000 },
    { name: "Residence Inn", address: "1033 Example Street, Springfield", primary_type: "hotel", reviews: 900 },
  ];
  const got = classify(venues);
  const dropped = venues.filter((_, i) => got[i]).map(v => v.name);
  assert.deepEqual(dropped, [], `real venues must survive, dropped: ${dropped.join(", ")}`);
});
