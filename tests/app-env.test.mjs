// app-env.test.mjs — lib/app-env.cjs / bin/app-env: the env the web apps under
// apps/ are built with, derived from a synthetic installation.
//
// Run: node --test tests/app-env.test.mjs
import { LOCAL_DIR, writeLocalConfig } from "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { APPS, appEnv, formatEnv } = require("../lib/app-env.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rm = (name) => fs.rmSync(path.join(LOCAL_DIR, "config", `${name}.json`), { force: true });
const setInstance = (over) =>
  fs.writeFileSync(path.join(LOCAL_DIR, "instance.json"), JSON.stringify({
    owner_name: "the user", owner_id: "user", owner_email: "owner@example.com", tz: "UTC", ...over,
  }));

test("no Supabase config: URL and key are empty, so every site is off", () => {
  setInstance({});
  rm("supabase"); rm("apps"); rm("watchlist");
  for (const app of APPS) {
    const env = appEnv(app);
    assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, "");
    assert.equal(env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "");
    // Nobody but the owner, and the owner only because instance.json names an address.
    assert.equal(env.ALLOWED_EMAILS, "owner@example.com");
    assert.equal(env.NEXT_PUBLIC_SITE_TZ, "UTC");
  }
});

test("Supabase project and anon key come from the instance and supabase.json", () => {
  setInstance({ supabase_project: "abcdefghijklmnop" });
  writeLocalConfig("supabase", { anon_key: "public-anon-key" });
  const env = appEnv("itin");
  assert.equal(env.NEXT_PUBLIC_SUPABASE_URL, "https://abcdefghijklmnop.supabase.co");
  assert.equal(env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "public-anon-key");
});

test("allowed emails: per-site list, else the shared list, else the owner; lower-cased", () => {
  setInstance({});
  writeLocalConfig("apps", {
    allowed_emails: ["Owner@Example.com", "partner@example.com"],
    sites: { itin: { allowed_emails: "solo@example.com" } },
  });
  assert.equal(appEnv("cruises").ALLOWED_EMAILS, "owner@example.com,partner@example.com");
  assert.equal(appEnv("itin").ALLOWED_EMAILS, "solo@example.com");
});

test("cruises: favorite ports in order, and the default cap (number, 'any', or unset)", () => {
  writeLocalConfig("apps", { sites: { cruises: { favorite_ports: ["Galveston", "Seattle"], default_max_cabin_per_night: 300 } } });
  let env = appEnv("cruises");
  assert.equal(env.NEXT_PUBLIC_FAVORITE_PORTS, "Galveston,Seattle");
  assert.equal(env.NEXT_PUBLIC_DEFAULT_MAX_CABIN_PER_NIGHT, "300");
  writeLocalConfig("apps", { sites: { cruises: { default_max_cabin_per_night: null } } });
  env = appEnv("cruises");
  assert.equal(env.NEXT_PUBLIC_FAVORITE_PORTS, "");
  assert.equal(env.NEXT_PUBLIC_DEFAULT_MAX_CABIN_PER_NIGHT, "any");
  rm("apps");
  assert.equal(appEnv("cruises").NEXT_PUBLIC_DEFAULT_MAX_CABIN_PER_NIGHT, "");
  assert.equal("NEXT_PUBLIC_FAVORITE_PORTS" in appEnv("itin"), false);
});

test("watch viewers: the owner's stored id, plus a partner only when the watchlist names one", () => {
  setInstance({ owner_name: "Alex", owner_id: "alex" });
  rm("watchlist"); rm("apps");
  assert.equal(appEnv("watch").NEXT_PUBLIC_WATCH_VIEWERS, "alex:Alex");
  writeLocalConfig("watchlist", { partner_id: "sam", partner_name: "Sam" });
  assert.equal(appEnv("watch").NEXT_PUBLIC_WATCH_VIEWERS, "alex:Alex,sam:Sam");
  writeLocalConfig("apps", { sites: { watch: { viewers: ["a:A", "b:B"] } } });
  assert.equal(appEnv("watch").NEXT_PUBLIC_WATCH_VIEWERS, "a:A,b:B");
  rm("apps"); rm("watchlist");
  setInstance({});
  // The generic owner keeps its stored id as the display name, never "the user".
  assert.equal(appEnv("watch").NEXT_PUBLIC_WATCH_VIEWERS, "user:user");
});

test("unknown app throws; formatEnv drops empty values unless asked", () => {
  assert.throws(() => appEnv("nope"), /unknown app/);
  assert.equal(formatEnv({ A: "1", B: "" }), "A=1\n");
  assert.equal(formatEnv({ A: "1", B: "" }, { all: true }), "A=1\nB=\n");
});

test("bin/app-env prints dotenv lines and rejects a bad app", () => {
  setInstance({ supabase_project: "abcdefghijklmnop" });
  writeLocalConfig("supabase", { anon_key: "public-anon-key" });
  const out = execFileSync(path.join(ROOT, "bin/app-env"), ["itin"], { encoding: "utf8" });
  assert.match(out, /^NEXT_PUBLIC_SUPABASE_URL=https:\/\/abcdefghijklmnop\.supabase\.co$/m);
  assert.match(out, /^ALLOWED_EMAILS=owner@example\.com$/m);
  assert.equal(execFileSync(path.join(ROOT, "bin/app-env"), ["--list"], { encoding: "utf8" }), APPS.join("\n") + "\n");
  assert.throws(() => execFileSync(path.join(ROOT, "bin/app-env"), ["nope"], { stdio: "pipe" }), (e) => e.status === 2);
});
