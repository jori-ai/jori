// venue-lanes.test.mjs — venue watch lanes built from config, their delivery,
// and the gates every lane shares (soft-block calendar overlap, regional
// presence pre-gate, structured availability, the morning brief's metro filter).
//
// All venues, artists and metros are synthetic. The test points JORI_LOCAL_DIR
// at its own config, so it runs the same on a fresh install and a configured one.
//
// Run: node --test tests/venue-lanes.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "venue-lanes-test-"));
fs.mkdirSync(path.join(LOCAL, "config"));
fs.writeFileSync(path.join(LOCAL, "config", "venue-events.json"), JSON.stringify({ home_metro: "metro_a", metros: ["metro_a", "metro_b"], near_zone: "near" }));
process.env.JORI_LOCAL_DIR = LOCAL;
process.env.JORI_TZ = "UTC";

const L = await import("../lib/venue-events/lanes.mjs");
const W = await import("../lib/venue-events/watch.mjs");
const S = await import("../lib/venue-events/store.mjs");

test("a fresh install has no lanes: nothing to run", () => {
  assert.deepEqual(Object.keys(L.LANES), []);
  assert.deepEqual(S.EVENT_METROS, ["metro_a", "metro_b"]);
});

const CFG = {
  voice: "Be brief.",
  lanes: {
    "tour-watch": {
      groups: ["discovery"], categories: ["music"], siblings: ["late-watch"], max_picks: 4, metro_from_event: true,
      watchlist: { comedy_group: "big-rooms", national_max_tier: 1, national_countries: ["US"], near_states: ["ST"], near_country: "US" },
      system: "Pick shows. {{voice}}",
      sections: [{ key: "watchlist", heading: "Watchlist" }, { key: "discovery", heading: "New" }],
      deliver: { mode: "email", subject: "Alerts — {date} — {place}", place_labels: { default: "Home", by_gate_metro: { metro_b: "Home & Away" } },
        pointer: { when: "here_or_trip", headliner_check: true, lead_sections: ["watchlist"], text: "Alerts: {who}{at_venue}{city_away}{when}{more} — in your inbox.", push: "Alerts: {n} new" } },
    },
    "late-watch": {
      groups: ["late"], sections: [{ key: "show", heading: "Late shows" }], ride_along_with: "tour-watch",
      deliver: { mode: "chat_when_home", subject: "Late — {n} new show{s}", chat: { header: "Late: {n} new show{s}", intent: "late" }, away: { style: "digest" } },
    },
    "region-watch": {
      groups: ["region"], metro: "metro_b", regional: { any_zone_section: "special" },
      sections: [{ key: "special", heading: "Special" }, { key: "music", heading: "Music" }],
      deliver: { mode: "email", subject: "Region — {date}", pointer: { when: "here_or_trip", lead_sections: ["special"], text: "Region: {who}{at_venue}{city}{more}.", push: "Region: {n} new" } },
    },
  },
};

function stubSend({ here = [], headliners = [] } = {}) {
  const sent = { email: [], label: [], pointer: [], chat: [] };
  return { sent, send: {
    email: (m) => sent.email.push(m), label: async (s) => sent.label.push(s), pointer: (m) => sent.pointer.push(m),
    chat: (t, intent) => sent.chat.push({ t, intent }), inCity: (m) => here.includes(m), isHeadliner: (...n) => n.some((x) => headliners.includes(x)),
  } };
}

const pick = (o) => ({ key: o.title, title: "Artist One Live", venue: "Hall A", date: "2026-11-12", performers: ["Artist One"], pick: { section: "watchlist", why: "Because." }, ...o });

test("buildLane: config becomes the lane runLane reads", () => {
  const lanes = L.buildLanes(CFG);
  const t = lanes["tour-watch"];
  assert.equal(t.seenFile, "data/tour-watch-seen.json");
  assert.equal(t.maxPicks, 4);
  assert.equal(t.system(), "Pick shows. Be brief.");
  assert.deepEqual(t.schema.properties.picks.items.properties.section.enum, ["watchlist", "discovery"]);
  assert.equal(t.metroFor({ city: "Far City" }), "far city");
  assert.equal(t.metroFor({ gate_metro: "metro_b" }), "metro_b");
  assert.equal(t.metroFor({}), "metro_a");
  assert.equal(typeof t.extraCandidates, "function");
  assert.equal(lanes["late-watch"].rideAlongWith, "tour-watch");
  assert.equal(lanes["late-watch"].metroFor({ city: "Far City" }), "metro_a");
  assert.equal(lanes["region-watch"].metroFor({}), "metro_b");
  assert.equal(lanes["region-watch"].acceptPick({ zone: "drive", pick: { section: "music" } }), false);
  assert.equal(lanes["region-watch"].acceptPick({ zone: "drive", pick: { section: "special" } }), true);
  assert.equal(lanes["region-watch"].acceptPick({ zone: "near", pick: { section: "music" } }), true);
});

test("watchlist branches: comedy only from its group, a watchlist hit wins over the same store row", () => {
  const pool = [
    { key: "a", category: "music" },
    { key: "b", category: "comedy", groups: ["big-rooms"] },
    { key: "c", category: "comedy", groups: ["small-rooms"] },
    { key: "a", category: "music", branch: "watchlist" },
  ];
  assert.deepEqual(L.assignBranches(pool, { comedyGroup: "big-rooms" }).map((e) => `${e.key}:${e.branch}`), ["b:comedy", "a:watchlist"]);
  assert.equal(L.inWatchRadius({ country: "US", state: "XX" }, 1, CFG.lanes["tour-watch"].watchlist), true);
  assert.equal(L.inWatchRadius({ country: "US", state: "XX" }, 3, CFG.lanes["tour-watch"].watchlist), false);
  assert.equal(L.inWatchRadius({ country: "US", state: "ST" }, 3, CFG.lanes["tour-watch"].watchlist), true);
});

test("watchlist parse: tiers, aliases, deceased skipped, other sections ignored", () => {
  const md = "## Watchlist\n### Tier 1 — Urgent\n- **Artist One** (10)\n### Tier 4 — Heritage\n- **Artist Two / Band Three** (7)\n- **Artist Four** — deceased, skip\n### Deceased\n- **Artist Five**\n## Comedy\n- **Comic Six**";
  assert.deepEqual(L.parseWatchlist(md).map((x) => `${x.tier}:${x.name}`), ["1:Artist One", "4:Artist Two", "4:Band Three"]);
});

test("pointer: leads with the watchlist show where the user is, with venue and date", () => {
  const lane = L.buildLanes(CFG)["tour-watch"];
  const text = CFG.lanes["tour-watch"].deliver.pointer.text;
  const ptr = (picks, here = "metro_a") => L.lanePointer(picks, { text, here, metroFor: lane.metroFor, leadSections: ["watchlist"] });
  const away = pick({ title: "x1", venue: "Civic Theatre", city: "Far City", date: "2026-11-02" });
  assert.equal(ptr([away, pick({ title: "x2" }), pick({ title: "x3" })]), "Alerts: Artist One at Hall A, Nov 12 + 2 more — in your inbox.");
  assert.equal(ptr([away]), "Alerts: Artist One at Civic Theatre, Far City, Nov 2 — in your inbox.");
  const disc = pick({ title: "New Band", performers: ["New Band"], venue: "Club", pick: { section: "discovery" } });
  assert.equal(ptr([disc, pick({ title: "y", artist: "Artist Two", performers: [], venue: "Arena", date: "2026-12-01" })]), "Alerts: Artist Two at Arena, Dec 1 + 1 more — in your inbox.");
  const there = pick({ title: "z", performers: ["Artist Three"], venue: "Hall B", city: "Region Town", gate_metro: "metro_b", date: "2026-10-18" });
  assert.equal(ptr([pick({ title: "w" }), there], "metro_b"), "Alerts: Artist Three at Hall B, Oct 18 + 1 more — in your inbox.");
  assert.equal(ptr([pick({ title: "v", date: null, venue: null })]), "Alerts: Artist One — in your inbox.");
});

test("email delivery: sections, subject place label, label, and a pointer only when here or worth the trip", async () => {
  const { sent, send } = stubSend({ here: [] });
  const lane = L.buildLanes(CFG, { send })["tour-watch"];
  const picks = [pick({ title: "p1", gate_metro: "metro_b", city: "Region Town" }), pick({ title: "p2", pick: { section: "discovery", why: "New." } })];
  await lane.deliver(picks, { today: "2026-10-29" });
  assert.equal(sent.email.length, 1);
  assert.equal(sent.email[0].subject, "Alerts — Thu, Oct 29 — Home & Away");
  assert.match(sent.email[0].html, /<h2[^>]*>Watchlist<\/h2>/);
  assert.match(sent.email[0].html, /<h2[^>]*>New<\/h2>/);
  assert.deepEqual(sent.label, [sent.email[0].subject]);
  assert.equal(sent.pointer.length, 0, "away from every pick's metro and no headliner: email only");

  const h = stubSend({ headliners: ["Artist One"] });
  await L.buildLanes(CFG, { send: h.send })["tour-watch"].deliver(picks, { today: "2026-10-29" });
  assert.equal(h.sent.pointer.length, 1, "a tier-1 headliner earns the pointer while away");
  assert.equal(h.sent.pointer[0].push, "Alerts: 2 new");
  assert.equal(h.sent.pointer[0].intent, "tour-watch");

  const r = stubSend({ here: ["metro_b"] });
  await L.buildLanes(CFG, { send: r.send })["region-watch"].deliver([
    pick({ title: "m", performers: ["Band M"], venue: "Club M", city: "Region Town", pick: { section: "music", why: "." } }),
    pick({ title: "s", performers: ["Band S"], venue: "Amphitheatre", city: "Hill Town", pick: { section: "special", why: "." } }),
  ], { today: "2026-10-29" });
  assert.equal(r.sent.pointer[0].pointer, "Region: Band S at Amphitheatre, Hill Town + 1 more.");
});

test("chat_when_home: a chat ping while home, the digest by email while away", async () => {
  const picks = [pick({ title: "Late Set", venue: "Cellar Bar", pick: { section: "show", why: "Good." }, tag: "worth the trip", url: "https://x/1" })];
  const home = stubSend({ here: ["metro_a"] });
  await L.buildLanes(CFG, { send: home.send })["late-watch"].deliver(picks, { today: "2026-10-29" });
  assert.equal(home.sent.email.length, 0);
  assert.equal(home.sent.chat[0].intent, "late");
  assert.equal(home.sent.chat[0].t, "Late: 1 new show\n\n• Late Set — Cellar Bar, Thu, Nov 12 (worth the trip)\n  Good.\nhttps://x/1");
  const away = stubSend();
  await L.buildLanes(CFG, { send: away.send })["late-watch"].deliver(picks, { today: "2026-10-29" });
  assert.equal(away.sent.chat.length, 0);
  assert.equal(away.sent.email[0].subject, "Late — 1 new show");
  assert.match(away.sent.email[0].html, /Late shows/);
  assert.equal(away.sent.label.length, 1);
});

test("regional pre-gate: away dates drop unless a headliner is on the bill; sold out drops; theater runs collapse", async () => {
  const presence = async (dates) => new Map(dates.map((d) => [d, d <= "2026-10-28"]));
  const headliner = (...names) => names.includes("Artist One");
  const perf = (date) => ({ key: `run|${date}`, title: "A Play", venue: "Stage", date, category: "theater", performers: [] });
  const pool = [
    { key: "a", title: "here", date: "2026-10-20", category: "music", performers: [] },
    { key: "b", title: "away", date: "2026-11-05", category: "music", performers: [] },
    { key: "c", title: "away, headliner", date: "2026-11-06", category: "music", performers: ["Artist One"] },
    { key: "d", title: "sold out", date: "2026-10-21", category: "music", status: "sold_out", performers: [] },
    perf("2026-10-12"), perf("2026-10-09"), perf("2026-10-10"),
  ];
  const kept = await L.regionalPrepare(pool, { metro: "metro_b", presence, headliner });
  assert.deepEqual(kept.map((e) => e.key).sort(), ["a", "c", "run:a-play|stage"]);
  assert.equal(kept.find((e) => e.category === "theater").run_dates, 3);
  assert.equal(kept.find((e) => e.category === "theater").date, "2026-10-09");
});

test("presenceByDate: one timeline read, failing open", async () => {
  const P = {
    fetchSegments: async () => [{ arrive_at: "2026-10-01T06:00:00Z", depart_at: "2026-10-28T21:00:00Z", metro: "metro_b" }],
    loadFlights: () => [], normalizeMetro: (m) => m, parseWhen: (d) => Date.parse(`${d}T19:00:00Z`),
    resolvePresenceAt: (ms, segs) => { const s = segs.find((x) => Date.parse(x.arrive_at) <= ms && ms < Date.parse(x.depart_at)); return s ? { metro: s.metro } : { metro: "metro_a" }; },
  };
  const m = await W.presenceByDate(["2026-10-15", "2026-11-15"], "metro_b", { presence: P });
  assert.equal(m.get("2026-10-15"), true);
  assert.equal(m.get("2026-11-15"), false);
  const broken = { ...P, fetchSegments: async () => { throw new Error("down"); } };
  assert.equal((await W.presenceByDate(["2026-11-15"], "metro_b", { presence: broken })).get("2026-11-15"), true);
});

test("soft block: the configured movable event, by series id or a whole-word name", () => {
  const ev = (summary, over = {}) => ({ summary, ...over });
  const sb = { name: "jordan" };
  assert.equal(W.isSoftBlockEvent(ev("Jordan <> Alex"), sb), true);
  assert.equal(W.isSoftBlockEvent(ev("Jordanian food night"), sb), false, "a whole word, not a substring");
  assert.equal(W.isSoftBlockEvent(ev("Weekly sync", { attendees: [{ email: "jordan@example.com" }] }), sb), true);
  assert.equal(W.isSoftBlockEvent(ev("Weekly sync", { id: "ser1_R2", recurringEventId: "ser1" }), { name: "jordan", knownId: "ser1" }), true);
  assert.equal(W.isSoftBlockEvent(ev("Jordan <> Alex"), {}), false, "no soft block configured");
  assert.equal(W.softBlockConfig(), null, "a fresh install has none");
});

test("availability: a structured status decides with no page read", async () => {
  const res = await W.availability([
    { key: "s", status: "sold_out", structured_status: true },
    { key: "o", status: "onsale", structured_status: true },
    { key: "c", status: "cancelled" },
  ]);
  assert.equal(res.get("s"), "sold_out");
  assert.equal(res.get("o"), "available");
  assert.equal(res.get("c"), "cancelled");
});

test("candidate rows: home-metro rows carry no city, others do; regional rows carry drive time", () => {
  const [home] = W.candidateRows([{ title: "x", venue: "v", city: "metro_a", date: "2026-10-20" }]);
  assert.equal("city" in home, false);
  const [far] = W.candidateRows([{ title: "x", venue: "v", city: "Hill Town", date: "2026-10-20", drive_min: 80, zone: "drive" }]);
  assert.equal(far.city, "Hill Town");
  assert.equal(far.drive_min, 80);
});

test("morning brief events: only the metro the user is in, and only near-zone regional rows", () => {
  const store = { events: {
    h: { key: "h", date: "2026-10-15", city: "metro_a", title: "home set" },
    n: { key: "n", date: "2026-10-15", city: "Region Town", gate_metro: "metro_b", zone: "near", title: "near" },
    d: { key: "d", date: "2026-10-15", city: "Hill Town", gate_metro: "metro_b", zone: "drive", title: "drive" },
    t: { key: "t", date: "2026-10-16", city: "metro_a", title: "tomorrow" },
  } };
  assert.deepEqual(S.eventsInMetroOn(store, "metro_a", "2026-10-15").map((e) => e.key), ["h"]);
  assert.deepEqual(S.eventsInMetroOn(store, "metro_b", "2026-10-15").map((e) => e.key), ["n"]);
  assert.deepEqual(S.eventsInMetroOn(store, "metro_c", "2026-10-15"), []);
});

test("templates: unknown placeholders are left as written", () => {
  assert.equal(L.fill("{n} new{s} {nope}", { n: 2, s: "s" }), "2 news {nope}");
});
