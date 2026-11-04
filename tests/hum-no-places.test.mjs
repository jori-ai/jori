// Hum searches Google Places for picks only after the user says yes to a meal
// offer. No harvester, sensor or tick script may reach Places; the one path
// that searches for picks is bin/meal-pick, at standard tier, under its own
// lane. (An installation's own hum-side Places callers, if any, are pinned in
// its own tests.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["agent/scripts/hum-harvesters", "agent/scripts/hum-sensors"];
// Optional files (an installation's own) are checked when present.
const FILES = ["agent/scripts/hum-tick.mjs", "agent/scripts/hum-harvest-all.mjs", "lib/local-lore.mjs", "lib/place-lore.mjs"]
  .filter((f) => fs.existsSync(path.join(ROOT, f)));
// Code, not comments: strip // and /* */ before looking.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
const FORBIDDEN = [/bin\/places\b/, /\(BIN, "places"\)/, /places\.googleapis\.com/, /places[-_]client/, /\bplacesAt\(/];

test("no hum harvester, sensor or tick script calls Google Places", () => {
  const files = [
    ...DIRS.flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith(".mjs")).map((f) => path.join(d, f))),
    ...FILES,
  ];
  const hits = [];
  for (const f of files) {
    const src = code(fs.readFileSync(path.join(ROOT, f), "utf8"));
    for (const re of FORBIDDEN) if (re.test(src)) hits.push(`${f}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

test("meal-pick is the post-yes path: standard tier, its own lane", () => {
  const src = fs.readFileSync(path.join(ROOT, "bin/meal-pick"), "utf8");
  assert.match(src, /"--tier", "standard"/);
  assert.match(src, /"--lane", "hum-meal-offer"/);
  const policy = JSON.parse(fs.readFileSync(path.join(ROOT, "lib/places-tier-policy.json"), "utf8"));
  assert.ok(policy.daily_live_caps.enterprise["hum-meal-offer"] > 0);
});

test("meal_offer, the ask before any search, makes no Places call itself", () => {
  const src = code(fs.readFileSync(path.join(ROOT, "agent/scripts/hum-harvesters/meal_offer.mjs"), "utf8"));
  for (const re of FORBIDDEN) assert.doesNotMatch(src, re);
  assert.match(src, /meal-pick --ping-id/);
});
