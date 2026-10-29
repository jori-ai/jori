// places-log.test.mjs — every Places call this repo makes leaves a line, the
// line names the price tier its field mask buys, and the attribution math
// says how many calls on the key were NOT ours.
//
// The case it was built for: thousands of calls on the key in ten days, most
// of them photo fetches no tool in this repo makes. The bill named the SKU; only
// a call log set against Google's per-method count could say "not us".
//
// Run: node --test tests/places-log.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { tierForMask, summarize, attribution, readPlacesLog, GOOGLE_METHOD } = require("../lib/places-log.js");

test("the field mask decides the tier, highest field wins", () => {
  assert.equal(tierForMask("places.id,places.location,places.types"), "essentials");
  assert.equal(tierForMask("places.id,places.displayName,places.formattedAddress"), "pro");
  assert.equal(tierForMask("places.displayName,places.rating,places.userRatingCount"), "enterprise");
  assert.equal(tierForMask("places.displayName,places.rating,places.editorialSummary"), "enterprise_atmosphere");
  // a venue-verification mask: reviews + allowsDogs are Atmosphere
  assert.equal(tierForMask("places.id,places.rating,places.allowsDogs,places.reviews"), "enterprise_atmosphere");
  // places_nearby's trimmed mask (displayName, primaryType, …) is what the
  // export bills as "Nearby Search Pro" — Essentials is only id/location/types
  assert.equal(tierForMask("places.id,places.location,places.primaryType,places.types"), "pro");
});

test("summarize separates live calls from cache hits and handed-out photo URLs", () => {
  const entries = [
    { ts: "2026-09-10T10:00:00Z", tool: "findme", method: "searchNearby", cached: false, n: 1 },
    { ts: "2026-09-10T10:01:00Z", tool: "findme", method: "searchNearby", cached: true, n: 1 },
    { ts: "2026-09-10T11:00:00Z", tool: "example-photo-tool", method: "photoMedia", cached: false, n: 6 },
    { ts: "2026-09-10T11:05:00Z", tool: "places", method: "photoUrlIssued", cached: false, n: 3 },
    { ts: "2026-09-11T09:00:00Z", tool: "location-segment", method: "searchText", cached: false, n: 1 },
  ];
  const s = summarize(entries);
  assert.equal(s.live, 8);
  assert.equal(s.cachedHits, 1);
  assert.equal(s.photoUrlsIssued, 3);
  assert.deepEqual(s.byMethod, { searchNearby: 1, photoMedia: 6, searchText: 1 });
  assert.deepEqual(s.byTool["example-photo-tool"], { photoMedia: 6 });
  assert.deepEqual(s.byDay, { "2026-09-10": 7, "2026-09-11": 1 });
});

test("attribution is Google's count minus ours, never negative, with a share", () => {
  const a = attribution(
    { photoMedia: 4255, searchText: 776, searchNearby: 320, getPlace: 258 },
    { photoMedia: 40, searchText: 700, searchNearby: 330 },
  );
  const by = Object.fromEntries(a.rows.map(r => [r.method, r]));
  assert.equal(by.photoMedia.unattributed, 4215);
  assert.equal(by.searchNearby.unattributed, 0);      // we logged more than Google saw at the edge
  assert.equal(by.getPlace.unattributed, 258);        // a method no tool here calls
  assert.equal(a.google, 5609);
  assert.equal(a.unattributed, 4215 + 76 + 258);
  assert.ok(a.unattributed_share > 0.8);
});

test("Google's method names map to the log's short names", () => {
  assert.equal(GOOGLE_METHOD["google.maps.places.v1.Places.GetPhotoMedia"], "photoMedia");
  assert.equal(GOOGLE_METHOD["google.maps.places.v1.Places.SearchNearby"], "searchNearby");
});

test("readPlacesLog filters by time and survives a torn line", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "plog-")), "calls.jsonl");
  fs.writeFileSync(f, [
    JSON.stringify({ ts: "2026-09-09T00:00:00Z", tool: "a", method: "searchText" }),
    '{"ts":"2026-09-10T00:00:00Z","tool":"b","meth',
    JSON.stringify({ ts: "2026-09-10T12:00:00Z", tool: "c", method: "photoMedia", n: 2 }),
  ].join("\n") + "\n");
  const all = readPlacesLog(null, f);
  assert.equal(all.length, 2);
  const recent = readPlacesLog("2026-09-10T00:00:00Z", f);
  assert.deepEqual(recent.map(e => e.tool), ["c"]);
  assert.deepEqual(readPlacesLog(null, "/nonexistent/x.jsonl"), []);
});

test("summarize breaks calls down by lane: live to Google vs answered by a cache", () => {
  const s = summarize([
    { ts: "2026-10-13T10:00:00Z", tool: "places", method: "searchText", lane: "hum-nearby", cached: false },
    { ts: "2026-10-13T10:01:00Z", tool: "places", method: "searchText", lane: "hum-nearby", cached: true },
    { ts: "2026-10-13T10:02:00Z", tool: "places", method: "searchText", lane: "hum-nearby", cached: true },
    { ts: "2026-10-13T10:03:00Z", tool: "places", method: "searchText", lane: "hum-excursion", cached: false },
    { ts: "2026-10-13T10:04:00Z", tool: "places", method: "searchText", cached: false },
  ]);
  assert.deepEqual(s.byLane["hum-nearby"], { live: 1, cached: 2 });
  assert.deepEqual(s.byLane["hum-excursion"], { live: 1, cached: 0 });
  assert.deepEqual(s.byLane.untagged, { live: 1, cached: 0 });   // old lines and untagged callers
  assert.equal(s.live, 3);
});

test("logPlacesCall writes the lane from the entry or from PLACES_LANE", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "plane-")), "calls.jsonl");
  const mod = path.join(path.dirname(new URL(import.meta.url).pathname), "../lib/places-log.js");
  const run = (lane, entryLane) => execFileSync(process.execPath, ["-e",
    `require(${JSON.stringify(mod)}).logPlacesCall({ tool: "t", method: "searchText", mask: "places.id"${entryLane ? `, lane: ${JSON.stringify(entryLane)}` : ""} })`],
    { env: { ...process.env, PLACES_LOG_FILE: f, PLACES_LANE: lane || "" } });
  run("env-lane", "entry-lane");
  run("env-lane");
  run("");
  assert.deepEqual(readPlacesLog(null, f).map(e => e.lane), ["entry-lane", "env-lane", undefined]);
});

// ── 2026-10-20 audit trail: who called, what it asked, what it cost ─────────
// October's $31.72 had to be attributed by matching call bursts to hum ticks;
// these fields make the log answer it directly.

const PL = require("../lib/places-log.js");

test("price and SKU follow the method and the tier the mask buys", () => {
  assert.equal(PL.priceFor("searchText", "enterprise_atmosphere"), 0.04);
  assert.equal(PL.priceFor("searchText", "essentials"), 0);
  assert.equal(PL.priceFor("photoMedia", "photo"), 0.007);
  assert.equal(PL.skuFor("searchText", "enterprise_atmosphere"), "Places API Text Search Enterprise + Atmosphere");
  assert.equal(PL.skuFor("searchNearby", "pro"), "Places API Nearby Search Pro");
  assert.equal(PL.skuFor("photoMedia", "photo"), "Places API Place Details Photos");
  assert.equal(PL.skuFor("photoUrlIssued", "photo"), null);
});

test("caller chain records basenames only — never arguments or KEY=value", () => {
  const ps = [
    "    1     0 /sbin/launchd",
    "   10     1 /usr/sbin/cron",
    "   20    10 node /x/bin/cron-run --label trigger-hum -- /x/trigger-hum.sh",
    "   30    20 /bin/bash /x/trigger-hum.sh",
    "   40    30 env GOOGLE_PLACES_API_KEY=AIzaSECRET node /x/hum-harvest-all.mjs --model sk-ant-SECRET",
    "   50    40 /usr/bin/python3 /x/tools/bin/places at 1,2 coffee --key AIzaSECRET",
  ].join("\n");
  const chain = PL.chainFromPs(ps, 50, 8);
  assert.equal(chain, "python3 places < env node < bash trigger-hum.sh < node cron-run");
  assert.ok(!/SECRET|AIza|sk-ant|coffee/.test(chain));
});

test("callContext reads what cron-run, hum and Claude Code put in the env", () => {
  assert.deepEqual(PL.callContext({}), {});
  assert.deepEqual(
    PL.callContext({ JORI_JOB: "segment-ask", JORI_JOB_CHAIN: "trigger-segment-ask>segment-ask",
                     HUM_TICK_ID: "t-1", HUM_LANE: "nearby", CLAUDE_CODE_SESSION_ID: "s-1" }),
    { job: "segment-ask", chain: "trigger-segment-ask>segment-ask", tick: "t-1", hum_lane: "nearby", session: "s-1" });
  // a chain equal to the job adds nothing
  assert.deepEqual(PL.callContext({ JORI_JOB: "a", JORI_JOB_CHAIN: "a" }), { job: "a" });
});

test("a logged call carries context, what it asked, its SKU and list price; cached and blocked cost 0", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paud-")), "calls.jsonl");
  const mod = path.join(path.dirname(new URL(import.meta.url).pathname), "../lib/places-log.js");
  const run = (extra) => execFileSync(process.execPath, ["-e",
    `require(${JSON.stringify(mod)}).logPlacesCall({ tool: "places", method: "searchText", mask: "places.reviews", query: "coffee", lat: 12.34561, lon: -65.43211, radius: 400, ${extra} })`],
    { env: { ...process.env, PLACES_LOG_FILE: f, JORI_JOB: "hum-sense", HUM_LANE: "nearby", HUM_TICK_ID: "t-9", PLACES_LANE: "" } });
  run("");
  run("cached: true");
  run("blocked: true");
  const [live, cached, blocked] = readPlacesLog(null, f);
  assert.equal(live.sku, "Places API Text Search Enterprise + Atmosphere");
  assert.equal(live.est_usd, 0.04);
  assert.equal(live.query, "coffee");
  assert.equal(live.lat, 12.3456);
  assert.equal(live.radius, 400);
  assert.equal(live.job, "hum-sense");
  assert.equal(live.hum_lane, "nearby");
  assert.equal(live.tick, "t-9");
  assert.equal(cached.est_usd, 0);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.est_usd, 0);
});

test("auditRows groups by job/lane/day/query and prices old lines from the table", () => {
  const entries = [
    // pre-2026-10-20 line: no est_usd, no job — priced from the table, keyed tool:lane
    { ts: "2026-10-05T10:00:00Z", tool: "places", method: "searchText", tier: "enterprise_atmosphere", cached: false },
    { ts: "2026-10-05T10:00:01Z", tool: "places", method: "searchText", tier: "enterprise_atmosphere", cached: false, lane: "hum-nearby" },
    { ts: "2026-10-21T10:00:00Z", tool: "places", method: "searchText", tier: "enterprise_atmosphere", cached: false,
      est_usd: 0.04, job: "hum-sense", hum_lane: "nearby", query: "cafe" },
    { ts: "2026-10-21T10:00:05Z", tool: "places", method: "searchText", tier: "enterprise_atmosphere", cached: true,
      est_usd: 0, job: "hum-sense", hum_lane: "nearby", query: "cafe" },
    { ts: "2026-10-21T10:00:09Z", tool: "places", method: "searchText", tier: "enterprise_atmosphere", blocked: true,
      est_usd: 0, job: "hum-sense", hum_lane: "nearby", query: "bar" },
    { ts: "2026-10-21T10:01:00Z", tool: "places", method: "photoUrlIssued", tier: "photo", n: 5 },
  ];
  const byJob = Object.fromEntries(PL.auditRows(entries, "job").map((r) => [r.key, r]));
  assert.deepEqual(byJob["hum-sense/nearby"], { key: "hum-sense/nearby", live: 1, cached: 1, blocked: 1, est_usd: 0.04 });
  assert.equal(byJob["places:untagged"].est_usd, 0.04);
  assert.equal(byJob["places:hum-nearby"].live, 1);
  const byDay = PL.auditRows(entries, "day").map((r) => r.key).sort();
  assert.deepEqual(byDay, ["2026-10-05", "2026-10-21"]);
  const byQuery = PL.auditRows(entries, "query").map((r) => r.key);
  assert.ok(byQuery.includes("places: cafe") && byQuery.includes("places: bar") && byQuery.includes("places: (query not logged)"));
});
