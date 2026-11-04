// daily-summary-nonstop.test.mjs — a window the user answered as "not a stop"
// must never ship a venue guess in its title (the user, 2026-07-27).
//
// The bug, from the 2026-07-26 summary: at 13:16 Jori asked "9m near Plage
// des Minimes around 12:49 … just a walk along the beach, or did you actually
// stop somewhere (Equinoxe, maybe)?" and the user answered "We were walking along
// the coastline in the minimes park." The answer WAS recorded — `findme resolve`
// stamped the visit row `place_type='non-stop'` — but it was lost twice over:
//   1. `findme` nulled `place_name`, discarding the user's actual words.
//   2. `resolve-day` only ever fetched `user-confirmed`/`named` rows, so the
//      non-stop answer was invisible and the window came back through the OSM
//      guesser.
// The title shipped as "~L'Équinoxe? · unconfirmed (also: Domino's, Le Transat)"
// directly above prose that said "Not really a stop, you and Sam were walking
// the coastline through Minimes park."
//
// Covers the three layers that had to change together: the findme classifier
// (Python), provenance tiering, and header rendering.
//
// Run: node --test tests/daily-summary-nonstop.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { computeProvenance, applyProvenance } = require(path.join(ROOT, "lib/daily-summary-confirm.js"));
const { buildManifest, _internal } = require(path.join(ROOT, "lib/daily-summary-render.js"));
const { stopHeaderHtml } = _internal;

// The real 12:49-13:02 stop from 2026-07-26, as resolve-day emitted it.
function minimesStop(extra = {}) {
  return {
    id: "s-20260726-3",
    start: "12:49", end: "13:02", duration_min: 13,
    place: { name: "L'Équinoxe", source: "osm_overpass", confidence: 0.5, distance_m: 40 },
    alternatives: [{ name: "Domino's", distance_km: 0.05 }, { name: "Le Transat", distance_km: 0.06 }],
    sample_count: 12,
    pattern: "browse",
    companions: ["Sam"],
    lat: 12.3456, lon: -65.4321,
    ...extra,
  };
}

test("an unanswered thin guess still hedges (the behavior we are NOT changing)", () => {
  const p = computeProvenance(minimesStop());
  assert.equal(p.tier, "WEAK_GUESS");
  assert.deepEqual(p.alternatives, ["Domino's", "Le Transat"]);
});

test("a non-stop answer titles the window with the PLACE from his words", () => {
  const stop = minimesStop({
    user_non_stop: true,
    // resolve-day promotes the non-stop row's place_name to user_confirmed.
    place: { name: "We were walking along the coastline in the minimes park", source: "user_confirmed", confidence: 1 },
  });
  const p = computeProvenance(stop);
  assert.equal(p.tier, "CONFIRMED");
  assert.equal(p.non_stop, true);
  assert.equal(p.hedge, false);
  // The title names the place; the user's sentence rides along for the prose.
  assert.equal(p.display_name, "Minimes Park");
  assert.equal(p.movement_note, "We were walking along the coastline in the minimes park");
  assert.equal(p.movement_verb, "walking");
  // The competing POIs are the whole problem — they must not survive an answer.
  assert.deepEqual(p.alternatives, []);

  stop.provenance = p;
  const html = stopHeaderHtml(stop).replace(/<[^>]+>/g, "");
  assert.match(html, /Minimes Park · walking/);
  assert.doesNotMatch(html, /unconfirmed|also:|L'Équinoxe|Domino|Transat|~/);
  assert.match(html, /with Sam/);          // companions still render
  // Headers became start-time-only ("one identity per place,
  // start-time headers"). Duration is no longer a header field — it renders on
  // the travel leg between stops — so assert the header's actual contract.
  assert.match(html, /12:49pm/);            // start-time header
});

test("a non-stop answer with no words drops the guess rather than keeping it", () => {
  const stop = minimesStop({ user_non_stop: true });
  const p = computeProvenance(stop);
  assert.equal(p.non_stop, true);
  assert.equal(p.display_name, null);
  assert.equal(p.confirmed_name, null);
  assert.deepEqual(p.alternatives, []);

  stop.provenance = p;
  const html = stopHeaderHtml(stop);
  assert.match(html, /not a stop/);
  assert.doesNotMatch(html, /L'Équinoxe|Domino|Transat|unconfirmed/);
});

test("a non-stop over an area label keeps the area, marked as a pass-through", () => {
  const stop = minimesStop({
    user_non_stop: true,
    place: { name: "Pont de l'Île de Ré", source: "neighborhood", confidence: 0.5 },
    alternatives: [],
  });
  const p = computeProvenance(stop);
  assert.equal(p.display_name, "Pont de l'Île de Ré");
  assert.equal(p.confirmed_name, null);   // an area is not a confirmed venue
  stop.provenance = p;
  const html = stopHeaderHtml(stop);
  assert.match(html, /Pont de l'Île de Ré/);
  assert.match(html, /· not a stop/);
});

test("the manifest carries non_stop and never leaks the dropped guess to the agent", () => {
  const stops = [minimesStop({ user_non_stop: true })];
  applyProvenance(stops, {});
  const m = buildManifest({ date: "2026-07-26", stops });
  assert.equal(m.stops[0].provenance.non_stop, true);
  assert.deepEqual(m.stops[0].provenance.alternatives, []);
  // place_name is what the agent reads when writing prose — it must not be the
  // POI the header just refused to assert.
  assert.equal(m.stops[0].place_name, "not a stop");
});

// --- the Python half: findme's answer classifier -----------------------------

// `findme` imports pyicloud at module scope and it isn't installed everywhere,
// so stub it before exec — the classifier itself is pure.
function classify(answer) {
  const driver = `
import sys, types, importlib.util, importlib.machinery, json
fake = types.ModuleType("pyicloud"); fake.PyiCloudService = object
sys.modules["pyicloud"] = fake
spec = importlib.util.spec_from_loader(
    "findme_mod", importlib.machinery.SourceFileLoader("findme_mod", sys.argv[1]))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(json.dumps(m._classify_non_stop(sys.argv[2])))
`;
  const r = spawnSync("python3", ["-c", driver, path.join(ROOT, "bin/findme"), answer], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("findme keeps the description on a non-stop answer, and only on one", () => {
  // Described non-stops: place_type='non-stop' AND the words are kept.
  assert.equal(classify("We were walking along the coastline in the minimes park."),
    "We were walking along the coastline in the minimes park");
  assert.equal(classify("just walking around"), "Just walking around");
  assert.equal(classify("no, we were just driving through"), "We were just driving through");
  // The leading classification is stripped — place_type already says it.
  assert.equal(classify("not really a stop, wandering the village"), "Wandering the village");

  // Bare negatives keep working exactly as before (empty string = no words).
  assert.equal(classify("no"), "");
  assert.equal(classify("blip"), "");
  assert.equal(classify("walk"), "");

  // null = not a non-stop; the caller falls through to identification. The
  // middle one is the trap: it mentions walking but names where the user ended up.
  assert.equal(classify("y space bbq"), null);
  assert.equal(classify("we walked to Le Récif and had lunch"), null);
  assert.equal(classify("1"), null);
});
