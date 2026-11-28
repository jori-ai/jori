// daily-summary-review-photo-people.test.mjs — the review sees a face tag under
// the name the day knows the person by.
//
// Photos tags a relative by a full name ("Jane Example"); the day calls her Nana
// (the companion-names alias table, lib/companions.js). The review read "people: Jane Example" beside
// "with Nana + Alex + Sam + Rover + Noa", flagged her as missing from the dinner,
// and its repair wrote "with Jane Example there too" into the prose.
//
// Run: node --test tests/daily-summary-review-photo-people.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
// A synthetic alias table, where lib/companions.js reads it.
const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "ds-photo-people-"));
fs.mkdirSync(path.join(LOCAL, "config"));
fs.writeFileSync(path.join(LOCAL, "config", "companion-names.json"),
  JSON.stringify({ self: ["Owner Example"], aliases: { "Jane Example": "Nana", "Sam Example": "Sam" } }));
process.env.JORI_LOCAL_DIR = LOCAL;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { photoLines } = require(path.join(ROOT, "lib/daily-summary-review.js"));

const day = { stops: [{ id: "s-20261022-5", title: "Nana", lat: 12.34560, lon: -65.43210,
  start_ts_ms: Date.parse("2026-10-22T15:47:00Z"), end_ts_ms: Date.parse("2026-10-22T18:45:00Z") }] };
const line = (persons) => photoLines([{ taken_at: "2026-10-22T16:06:32Z", latitude: 12.3456,
  longitude: -65.4321, persons }], day, "Asia/Jerusalem")[0];

test("a tag the alias table renames reads under the day's name, with the tag kept", () => {
  assert.match(line(["Jane Example"]), /people: Nana \(tagged "Jane Example"\)/);
});

test("a tag that already carries the day's name, or an unknown one, reads as tagged", () => {
  const l = line(["Sam Example", "Alex Example", "Someone New"]);
  assert.match(l, /people: Sam Example, Alex Example, Someone New/);
});

// A pet's face tag is not a person: shown a bare animal name under "people", the review asked for
// the dog to be added to the header's list of who was there. Pets come from the same local table.
test("a tag that is one of the household's pets reads as a pet, not a person", () => {
  const pets = fs.mkdtempSync(path.join(os.tmpdir(), "ds-photo-pets-"));
  fs.mkdirSync(path.join(pets, "config"));
  fs.writeFileSync(path.join(pets, "config", "companion-names.json"),
    JSON.stringify({ self: ["Owner Example"], aliases: { "Rover Example": "Rover" }, pets: ["Rover"] }));
  const r = spawnSync(process.execPath, ["-e", `
    const { photoLines } = require(${JSON.stringify(path.join(ROOT, "lib/daily-summary-review.js"))});
    const day = ${JSON.stringify(day)};
    console.log(photoLines([{ taken_at: "2026-10-22T16:06:32Z", latitude: 12.3456, longitude: -65.4321,
      persons: ["Rover", "Rover Example", "Sam Example"] }], day, "Asia/Jerusalem")[0]);`],
    { encoding: "utf8", env: { ...process.env, JORI_LOCAL_DIR: pets } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /people: Rover \(a pet, not a person\), Rover Example \(a pet, not a person\), Sam Example/);
  fs.rmSync(pets, { recursive: true, force: true });
});

test("with no pets listed, a tag reads as tagged (nothing changes)", () => {
  assert.match(line(["Rover"]), /people: Rover(?! \()/);
});
