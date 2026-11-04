// travel-place-normalize.test.mjs — the place-parsing guards in
// bin/travel-place-directory-sync.
//
// Every rejection case here is a page that is ACTUALLY in the live corpus,
// found by the monthly wiki-dedup-sweep on 2026-07-29. That sweep is the first
// thing able to find gaps in these hand-curated guards, because it is the only
// pass that compares the whole corpus against itself — `memory-consolidation`
// is diff-mode and never sees two bad pages created weeks apart.
//
// The preserved cases matter just as much: a guard that also drops "Trinidad
// and Tobago", "Long Beach" or "San Miguel de Allende" would quietly delete
// real travel history, which is far worse than the garbage it removes.
//
// The sync binary runs on import (it reads process.argv and does DB work), so
// the pure helpers are extracted from source rather than required. That is
// deliberate: it keeps the test honest about the real file without refactoring
// a 1285-line live tool just to make it importable.

import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "bin/travel-place-directory-sync"), "utf8");

function extract(pattern) {
  const m = SRC.match(pattern);
  if (!m) throw new Error(`could not extract ${pattern} — did the sync tool get refactored?`);
  return m[0];
}

const ctx = {};
{
  // Only the sets the extracted functions close over.
  const US_STATE_CODES = new Set(SRC.match(/const US_STATE_CODES = new Set\(\[([\s\S]*?)\]\)/)[1]
    .split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean));
  const CA_PROV_CODES = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]);
  const body = [
    extract(/function isPlausiblePlace\(text\)[\s\S]*?\n\}/),
    extract(/function isSubdivisionCode\(city\)[\s\S]*?\n\}/),
    extract(/function isPlausibleCityName\(city\)[\s\S]*?\n\}/),
    "ctx.isPlausiblePlace = isPlausiblePlace; ctx.isSubdivisionCode = isSubdivisionCode; ctx.isPlausibleCityName = isPlausibleCityName;",
  ].join("\n");
  new Function("US_STATE_CODES", "CA_PROV_CODES", "ctx", body)(US_STATE_CODES, CA_PROV_CODES, ctx);
}
const { isPlausiblePlace, isSubdivisionCode, isPlausibleCityName } = ctx;

describe("place parsing rejects what actually polluted the corpus", () => {
  it("rejects an alphanumeric postal code (travel_city_argentina_x5009dyj)", () => {
    assert.equal(isPlausiblePlace("X5009DYJ"), false,
      "the original guard only rejected tokens STARTING with a digit, so this sailed through");
    assert.equal(isPlausiblePlace("K1A0B1"), false);
  });

  it("rejects a trip title in the location field (travel_city_thailand_first_family_vacation_to)", () => {
    assert.equal(isPlausiblePlace("first family vacation to"), false);
    assert.equal(isPlausiblePlace("honeymoon"), false);
    assert.equal(isPlausiblePlace("anniversary getaway"), false);
  });

  it("rejects a bare subdivision code as a city (travel_city_canada_bc, travel_city_mexico_b_c)", () => {
    assert.equal(isSubdivisionCode("BC"), true);
    assert.equal(isSubdivisionCode("B.C."), true);
    assert.equal(isSubdivisionCode("ON"), true);
    assert.equal(isSubdivisionCode("CA"), true);
  });
});

describe("place parsing preserves real places", () => {
  // A guard that drops these would delete genuine travel history — the failure
  // mode that matters more than the garbage it is removing.
  const REAL = [
    "Cartagena", "Cartagena de Indias", "Ho Chi Minh City", "Rio de Janeiro",
    "Kansas City", "Atlantic City", "Mexico City", "Oaxaca City", "Long Beach",
    "San Miguel de Allende", "San Carlos de Bariloche", "Buenos Aires", "Vancouver",
    "Trinidad and Tobago", "Türkiye", "Vatican City", "Grand Cayman", "Valle Sagrado",
  ];

  for (const name of REAL) {
    it(`keeps ${JSON.stringify(name)}`, () => {
      assert.equal(isPlausiblePlace(name), true);
      assert.equal(isSubdivisionCode(name), false);
    });
  }

  it("keeps a multi-word name whose tokens individually look mundane", () => {
    // "and" / "de" / "of" must never be prose-stopped — they are load-bearing
    // in real place names.
    assert.equal(isPlausiblePlace("Trinidad and Tobago"), true);
    assert.equal(isPlausiblePlace("Isle of Man"), true);
  });

  it("still rejects the classes the original guard was written for", () => {
    // Regression cover for the 2026-05 hardening (see wiki-architecture.md 6d):
    // dates, month abbrevs and structural prose must stay rejected.
    assert.equal(isPlausiblePlace("Feb 10 - 22"), false);
    assert.equal(isPlausiblePlace("Title"), false);
    assert.equal(isPlausiblePlace("Display name"), false);
    assert.equal(isPlausiblePlace("2011 Jan 3"), false);
  });
});

describe("the alias maps carry the duplicates the sweep found", () => {
  it("collapses the two spellings that exist as separate live pages", () => {
    assert.match(SRC, /"Colombia\|cartagena de indias", "Cartagena"/);
    assert.match(SRC, /"Vietnam\|ho chi minh", "Ho Chi Minh City"/);
  });

  it("files San Francisco under the United States, not Canada", () => {
    assert.match(SRC, /"Canada\|san francisco", "United States"/);
  });
});

describe("every city path goes through one gate", () => {
  // travel_city_canada_bc outlived the first version of this fix: parsePlace was
  // guarded, but placeFromCityLink reseeds the directory from wikilinks already
  // present in trip bodies, so the bad page kept recreating itself from its own
  // dangling link. A guard a bad page can route around is not a guard.
  it("isPlausibleCityName rejects both garbage and subdivision codes", () => {
    assert.equal(isPlausibleCityName("BC"), false);
    assert.equal(isPlausibleCityName("X5009DYJ"), false);
    assert.equal(isPlausibleCityName("first family vacation to"), false);
    assert.equal(isPlausibleCityName("Vancouver"), true);
  });

  it("no city-producing call site still uses the bare country-side check", () => {
    // The country side legitimately keeps isPlausiblePlace (a country is never a
    // two-letter subdivision). These are the five city-side sites; if a new one
    // appears using the bare check, this test should be updated deliberately.
    const cityGated = (SRC.match(/isPlausibleCityName\(/g) || []).length;
    assert.ok(cityGated >= 5, `expected every city path gated, found ${cityGated}`);
  });
});

describe("unattended runs are bounded", () => {
  // Once this runs weekly on a timer, its prune step is a standing risk: if an
  // upstream source degrades, the tool cannot tell "these pages are garbage"
  // from "I can no longer see the data that justified them", and would quietly
  // delete real travel history. Steady state is 0 deletions; the one legitimate
  // cleanup was 8.
  it("has a deletion cap, defaulting low, overridable for an attended cleanup", () => {
    assert.match(SRC, /const MAX_DELETIONS_DEFAULT = 10;/);
    assert.match(SRC, /--max-deletions/);
  });

  it("skips ALL deletions when the cap trips, rather than deleting up to the cap", () => {
    // Deleting the first 10 of 40 would be the worst outcome: partial damage
    // plus a green-looking run.
    const guard = SRC.slice(SRC.indexOf("if (toDelete.length > maxDeletions)"));
    assert.match(guard.slice(0, 600), /return 0;/);
    assert.ok(!/toDelete\.slice\(0, maxDeletions\)/.test(SRC), "must not delete a truncated subset");
  });

  it("exits non-zero when the cap trips, so a launchd run records a failure", () => {
    assert.match(SRC, /if \(deletionCapTripped\) process\.exitCode = 4;/);
  });
});

describe("the directory build is idempotent", () => {
  // Before this, the sync rewrote 16 pages on EVERY run, forever. ensureCity
  // keyed on the raw city string, so "Medellín" and "Medellin" became two
  // records — 230 records for 214 pages — that both rendered to the same
  // pageId. Whichever rendered last won, and the winner changed between runs.
  // Each rewrite is a new revision AND a re-embed of an unchanged page, which
  // matters now that the sync runs weekly on a timer.
  const ctx2 = {};
  {
    const body = [
      extract(/function preferCityDisplay\(a, b\)[\s\S]*?\n\}/),
      "ctx2.preferCityDisplay = preferCityDisplay;",
    ].join("\n");
    new Function("ctx2", body)(ctx2);
  }
  const { preferCityDisplay } = ctx2;

  const PAIRS = [
    ["Medellín", "Medellin"],
    ["Bogotá", "Bogota"],
    ["Jardín", "Jardin"],
    ["Tunuyán", "Tunuyan"],
    ["Puerto Iguazú", "Puerto Iguazu"],
  ];

  for (const [accented, plain] of PAIRS) {
    it(`keeps the accented spelling for ${accented}`, () => {
      // These are the real names; stripping accents to match a slug would
      // degrade the travel record. The slug already strips them for the id.
      assert.equal(preferCityDisplay(accented, plain), accented);
      assert.equal(preferCityDisplay(plain, accented), accented);
    });
  }

  it("prefers lowercase connector words", () => {
    assert.equal(preferCityDisplay("Rio De Janeiro", "Rio de Janeiro"), "Rio de Janeiro");
    assert.equal(preferCityDisplay("Rio de Janeiro", "Rio De Janeiro"), "Rio de Janeiro");
  });

  it("is a total order, so the winner never depends on argument order", () => {
    // This is the property that actually stops the flip-flop — a preference
    // that depended on which source arrived first would just churn differently.
    const names = ["Medellín", "Medellin", "Rio de Janeiro", "Rio De Janeiro", "Bogotá", "Bogota", "Lima"];
    for (const a of names) {
      for (const b of names) {
        assert.equal(preferCityDisplay(a, b), preferCityDisplay(b, a), `${a} vs ${b} is order-dependent`);
      }
    }
  });

  it("ensureCity keys on the normalized name, not the raw string", () => {
    assert.match(SRC, /const key = `\$\{country\}\|\$\{normalizeCityKey\(city\)\}`;/);
  });
});
