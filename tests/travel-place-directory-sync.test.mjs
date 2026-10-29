// travel-place-directory-sync.test.mjs — the hand-curated place corrections
// (city spellings collapsed, a city filed under the wrong country moved) come
// from the installation's private data file on top of a few built-in ones.
//
// Run: node --test tests/travel-place-directory-sync.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), "../bin/travel-place-directory-sync");

function canon(places, aliases) {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "tpds-"));
  if (aliases) {
    fs.mkdirSync(path.join(local, "travel-wiki"));
    fs.writeFileSync(path.join(local, "travel-wiki", "place-aliases.json"), JSON.stringify(aliases));
  }
  const code = `const m = require(${JSON.stringify(BIN)}); console.log(JSON.stringify(${JSON.stringify(places)}.map(m.canonicalizePlace)));`;
  return JSON.parse(execFileSync(process.execPath, ["-e", code], { env: { ...process.env, JORI_LOCAL_DIR: local }, encoding: "utf8" }));
}

const ALIASES = {
  city_aliases: { "Kenya|nairobi district": "Nairobi" },
  country_overrides: { "Peru|la paz": "Bolivia" },
};

test("city spellings collapse and a misfiled city moves country", () => {
  const out = canon([
    { country: "Kenya", city: "Nairobi-District" },
    { country: "Vietnam", city: "Hồ Chí Minh" },
    { country: "Canada", city: "San Francisco" },
    { country: "Canada", city: "Vancouver" },
    { country: "Peru", city: "La Paz" },
    { country: "" },
  ], ALIASES);
  assert.deepEqual(out, [
    { country: "Kenya", city: "Nairobi" },
    { country: "Vietnam", city: "Ho Chi Minh City" },
    { country: "United States", city: "San Francisco" },
    { country: "Canada", city: "Vancouver" },
    { country: "Bolivia", city: "La Paz" },
    null,
  ]);
});

test("no data file: only the built-in corrections apply", () => {
  assert.deepEqual(canon([
    { country: "Kenya", city: "Nairobi-District" },
    { country: "Canada", city: "San Francisco" },
  ], null), [
    { country: "Kenya", city: "Nairobi-District" },
    { country: "United States", city: "San Francisco" },
  ]);
});
