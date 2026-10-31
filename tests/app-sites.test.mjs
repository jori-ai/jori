// app-sites.test.mjs — the web apps' own config parsing (each app's
// lib/config.ts), and the watch site's copy of the recommendation model.
//
// The sites are built from their own directory, so nothing personal is compiled
// in: every value arrives as an env var (bin/app-env prints them). These pin
// how the env is read, and that a site with none is OFF rather than broken.
// Node strips the TypeScript types natively; no build step.
//
// Run: node --test tests/app-sites.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// apps/<name> once the sites have moved, web/<name> before.
const appDir = (name) => [path.join(ROOT, "apps", name), path.join(ROOT, "web", name)].find((d) => fs.existsSync(path.join(d, "package.json")));
const SITES = ["cruises", "itin", "watch"];

for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "ALLOWED_EMAILS", "NEXT_PUBLIC_SITE_TZ",
  "NEXT_PUBLIC_FAVORITE_PORTS", "NEXT_PUBLIC_WATCH_VIEWERS", "NEXT_PUBLIC_DEFAULT_MAX_CABIN_PER_NIGHT"]) delete process.env[k];

const configs = Object.fromEntries(await Promise.all(SITES.map(async (s) => [s, await import(path.join(appDir(s), "lib/config.ts"))])));

test("with no env every site is off: not configured, nobody allowed, UTC", () => {
  for (const s of SITES) {
    const c = configs[s];
    assert.equal(c.CONFIGURED, false, s);
    assert.equal(c.SUPABASE_URL, "", s);
    assert.deepEqual(c.ALLOWED_EMAILS, [], s);
    assert.equal(c.isAllowed("owner@example.com"), false, s);
    assert.equal(c.SITE_TZ, "UTC", s);
  }
  assert.deepEqual(configs.cruises.FAVORITE_PORTS, []);
  assert.deepEqual(configs.watch.VIEWERS, []);
});

test("allowed emails: trimmed, lower-cased, case-insensitive match", () => {
  for (const s of SITES) {
    const c = configs[s];
    const list = c.parseEmails(" Owner@Example.com, ,partner@example.com ");
    assert.deepEqual(list, ["owner@example.com", "partner@example.com"], s);
    assert.equal(c.isAllowed("OWNER@example.com", list), true, s);
    assert.equal(c.isAllowed("stranger@example.com", list), false, s);
    assert.equal(c.isAllowed(null, list), false, s);
  }
});

test("no personal fallback is compiled into any site's config", () => {
  for (const s of SITES) {
    const src = fs.readFileSync(path.join(appDir(s), "lib/config.ts"), "utf8");
    assert.doesNotMatch(src, /supabase\.co"/, s);
    assert.doesNotMatch(src, /eyJ[A-Za-z0-9_-]{10,}/, s);
    assert.doesNotMatch(src, /@[a-z0-9-]+\.[a-z]{2,}"/i, s);
  }
});

test("watch viewers: id:Name pairs, ids lower-cased, duplicates dropped, bare id is its own name", () => {
  const { parseViewers } = configs.watch;
  assert.deepEqual(parseViewers("alex:Alex, Sam:Sam Lee ,alex:Again,kim"), [
    { p: "alex", name: "Alex" }, { p: "sam", name: "Sam Lee" }, { p: "kim", name: "kim" },
  ]);
  assert.deepEqual(parseViewers(""), []);
});

test("cruises: favorite ports keep their order; the default cap reads a number, 'any', or falls back", async () => {
  assert.deepEqual(configs.cruises.parseList("Galveston, Seattle,,Barcelona"), ["Galveston", "Seattle", "Barcelona"]);
  const { parseDefaultCap, DEFAULT_MAX_CABIN_PER_NIGHT } = await import(path.join(appDir("cruises"), "lib/sailing-taxonomy.ts"));
  assert.equal(DEFAULT_MAX_CABIN_PER_NIGHT, 440);
  assert.equal(parseDefaultCap(undefined), 440);
  assert.equal(parseDefaultCap("300"), 300);
  assert.equal(parseDefaultCap("any"), null);
  assert.equal(parseDefaultCap("garbage"), 440);
  assert.equal(parseDefaultCap("-5"), 440);
});

test("the watch site's model is a byte-for-byte copy of lib/watch-recsys.mjs", () => {
  // The site is built from its own directory (a CLI deploy uploads nothing else), so it
  // carries a copy; `npm run sync-model` (also its prebuild) refreshes it from the kernel.
  const kernel = fs.readFileSync(path.join(ROOT, "lib/watch-recsys.mjs"), "utf8");
  const copy = fs.readFileSync(path.join(appDir("watch"), "lib/recsys.mjs"), "utf8");
  assert.equal(copy, kernel, "run `npm run sync-model` in the watch app");
});
