// cruise-deep-link.test.mjs — pins the URL contract between the weekly cruise
// email and the cruise site.
//
// The email carries alerts and the site carries the corpus, so the link between
// them is load-bearing: a card saying "Reflection dropped 19%" is a dead end if
// clicking it lands on the front page, where the default $440/night cap and the
// travel-plan filter can hide that exact sailing. Two halves have to agree —
// bin/cruise-link builds the URL, the cruise app's lib/deep-link.ts reads it —
// and they are in different languages in different directories, so nothing but
// a test notices when one drifts.
//
// Run: node --test tests/cruise-deep-link.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// bin/cruise-link reads its base from the cruise-watch config `site_url`; pin a
// fixture so the contract is tested the same on any install.
const FIX = mkdtempSync(path.join(tmpdir(), "cruise-link-"));
mkdirSync(path.join(FIX, "config"), { recursive: true });
writeFileSync(path.join(FIX, "config", "cruise-watch.json"), JSON.stringify({ site_url: "https://cruises.example.test" }));
const ENV = { ...process.env, JORI_LOCAL_DIR: FIX };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The cruise app: apps/cruises once the sites have moved, web/cruises before.
const APP = ["apps/cruises", "web/cruises"].map((d) => path.join(ROOT, d)).find((d) => existsSync(path.join(d, "package.json")));
const { parseDeepLink } = await import(path.join(APP, "lib/deep-link.ts"));

/** Run the builder, then read the URL back the way the site would. */
function roundTrip(args) {
  const url = execFileSync(path.join(ROOT, "bin/cruise-link"), args, { encoding: "utf8", env: ENV }).trim();
  const sp = Object.fromEntries(new URL(url).searchParams.entries());
  return { url, link: parseDeepLink(sp) };
}

test("a sailing id survives the colon in it", () => {
  // celebrity:RF4BH330_2026-12-07 — hand-writing this into an href is exactly
  // what the builder exists to prevent.
  const id = "celebrity:RF4BH330_2026-12-07";
  const { url, link } = roundTrip(["sailing", id]);
  assert.ok(url.includes("%3A"), "the colon must be percent-encoded in the URL");
  assert.equal(link.focusSailing, id, "and must decode back to the original id");
});

test("the three bucket links parse as their buckets", () => {
  assert.equal(roundTrip(["drops"]).link.drops, true);
  assert.equal(roundTrip(["drops"]).link.sort, "drop");
  assert.equal(roundTrip(["lows"]).link.atl, true);
  assert.equal(roundTrip(["plan"]).link.plan, true);
});

test("browse carries every filter the email might scope by", () => {
  const { link } = roundTrip([
    "browse", "--line", "celebrity", "--port", "Barcelona",
    "--month", "12", "--year", "2026", "--max-night", "any",
  ]);
  assert.deepEqual(link.lines, ["celebrity"]);
  assert.deepEqual(link.ports, ["Barcelona"]);
  assert.deepEqual(link.months, [11], "the URL speaks 1-12, the UI indexes 0-11");
  assert.deepEqual(link.years, [2026]);
  assert.equal(link.maxCabinPerNight, "any");
});

test("`any` on the cap is distinct from no cap parameter at all", () => {
  // null means "leave the default $440 alone"; "any" means "lift it".
  assert.equal(parseDeepLink({}).maxCabinPerNight, null);
  assert.equal(parseDeepLink({ maxnight: "any" }).maxCabinPerNight, "any");
  assert.equal(parseDeepLink({ maxnight: "600" }).maxCabinPerNight, 600);
});

test("plan is tri-state so a link can turn it OFF", () => {
  assert.equal(parseDeepLink({}).plan, null, "absent leaves the default");
  assert.equal(parseDeepLink({ plan: "1" }).plan, true);
  assert.equal(parseDeepLink({ plan: "0" }).plan, false, "an email may want the full corpus");
});

test("a bare URL asks for nothing", () => {
  const link = parseDeepLink({});
  assert.equal(link.any, false, "so the site keeps its own defaults");
  assert.equal(link.focusSailing, null);
});

test("unknown parameters are ignored rather than breaking an old email", () => {
  const link = parseDeepLink({ sailing: "x", somethingRetired: "1" });
  assert.equal(link.focusSailing, "x");
  assert.equal(link.any, true);
});

test("lists accept both comma-separated and repeated values", () => {
  assert.deepEqual(parseDeepLink({ line: "royal,celebrity" }).lines, ["royal", "celebrity"]);
  assert.deepEqual(parseDeepLink({ line: ["royal", "celebrity"] }).lines, ["royal", "celebrity"]);
});

test("nonsense months and years are dropped, not passed through", () => {
  assert.deepEqual(parseDeepLink({ month: "0,13,abc,7" }).months, [6]);
  assert.deepEqual(parseDeepLink({ year: "1200,2026,nope" }).years, [2026]);
});
