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

test("web_search lane: one capped search adds dated future events; past, undated and failures add nothing", async () => {
  const calls = [];
  const run = async (o) => { calls.push(o); return { events: [
    { title: "Hall Sing Night", date: "2026-11-20", time: "19:30", venue: "Hall A", city: "Home City", url: "https://x/a" },
    { title: "Old Night", date: "2026-10-01", time: "", venue: "Hall A", city: "Home City", url: "https://x/b" },
    { title: "Someday", date: "", time: "", venue: "Hall B", city: "Home City", url: "https://x/c" },
  ] }; };
  const lane = L.buildLane("sing-lane", { groups: ["sing"], web_search: { ask: "Find sing nights at Hall A.", category: "singing", max_searches: 3 }, sections: ["show"] }, {}, { judge: run });
  const rows = await lane.extraCandidates({ today: "2026-10-30", log: () => {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].webSearch, true);
  assert.match(calls[0].system, /at most 3 web searches/);
  assert.match(calls[0].prompt, /^Today is 2026-10-30\. Find sing nights at Hall A\./);
  assert.deepEqual(rows.map((r) => [r.title, r.date, r.time, r.venue, r.source, r.category]), [["Hall Sing Night", "2026-11-20", "19:30", "Hall A", "web-sing-lane", "singing"]]);

  const failing = L.buildLane("sing-lane", { web_search: { ask: "x" } }, {}, { judge: async () => { throw new Error("timeout"); } });
  assert.deepEqual(await failing.extraCandidates({ today: "2026-10-30" }), []);
  const fatal = L.buildLane("sing-lane", { web_search: { ask: "x" } }, {}, { judge: async () => { throw Object.assign(new Error("not on Max"), { fatal: true }); } });
  await assert.rejects(() => fatal.extraCandidates({ today: "2026-10-30" }), /not on Max/);
  assert.equal(L.buildLane("plain", { groups: ["g"] }).extraCandidates, undefined, "no web_search, no watchlist: store rows only");
});

test("also_to: every email of the lane also goes to each extra recipient; one failing does not stop the rest", async () => {
  const { sent, send } = stubSend();
  const failing = { ...send, email: (m) => { if (m.to === "bad@example.com") throw new Error("send failed"); send.email(m); } };
  const c = { groups: ["g"], sections: ["show"], deliver: { mode: "email", subject: "Shows — {n}", also_to: ["bad@example.com", "friend@example.com"] } };
  await L.buildLane("duo-lane", c, {}, { send: failing }).deliver([pick({ title: "Duo", pick: { section: "show", why: "." } })], { today: "2026-10-30" });
  assert.deepEqual(sent.email.map((m) => m.to ?? "owner"), ["owner", "friend@example.com"]);
  assert.equal(sent.email[1].subject, "Shows — 1");
  assert.equal(sent.label.length, 1, "labelled once");
});

test("a browsing-skill row's start in its own field (date_field) gives the date and the clock", async () => {
  const F = await import("../lib/venue-events/fetchers.mjs");
  const src = { key: "cinema", venue: "Cinema A", category: "film", date_field: "showTimeLocal" };
  const rows = F.cdpRows(src, [{ title: "Musical Sing-Along", showTimeLocal: "2026-11-14T19:30:00", url: "https://x/s" }, { title: "No time" }], { ref: "2026-10-30" });
  assert.deepEqual([rows[0].date, rows[0].time, rows[0].venue, rows[0].url], ["2026-11-14", "19:30", "Cinema A", "https://x/s"]);
  assert.equal(rows[1].date, null);
  const plain = F.cdpRows({ key: "list", venue: "V" }, [{ title: "T", isoDate: "2026-11-01", time: "8pm" }], { ref: "2026-10-30", pageUrl: "https://x/list" });
  assert.deepEqual([plain[0].date, plain[0].time, plain[0].url], ["2026-11-01", "20:00", "https://x/list"]);
});

test("lanes_file and sources_file may be lists of private files, read in order; a missing one is skipped", async () => {
  const C = await import("../lib/venue-events/config.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "venue-files-"));
  const a = path.join(dir, "a.json"), b = path.join(dir, "b.json");
  fs.writeFileSync(a, JSON.stringify({ voice: "First.", soft_block: { name: "sam" }, lanes: { one: { groups: ["g1"] }, two: { groups: ["g2"] } },
    sources: [{ key: "s1", kind: "tm", groups: ["g1"] }], metro_tz: { metro_b: "Etc/GMT-2" }, horizon_days: 90 }));
  fs.writeFileSync(b, JSON.stringify({ voice: "Second.", lanes: { two: { groups: ["g2b"] }, three: { groups: ["g3"] } },
    sources: [{ key: "s2", kind: "cdp", groups: ["g3"] }], metro_tz: { metro_c: "Etc/GMT+5" } }));
  const missing = path.join(dir, "nope.json");
  const cfgDir = path.join(LOCAL, "config");
  fs.writeFileSync(path.join(cfgDir, "venue-watch.json"), JSON.stringify({ lanes_file: [a, missing, b] }));
  fs.writeFileSync(path.join(cfgDir, "venue-events.json"), JSON.stringify({ home_metro: "metro_a", sources_file: [a, missing, b] }));
  try {
    const wc = L.watchConfig();
    assert.deepEqual(Object.keys(wc.lanes), ["one", "two", "three"]);
    assert.deepEqual(wc.lanes.two.groups, ["g2b"], "a later file replaces a lane by name");
    assert.equal(wc.voice, "First.", "other keys: the first file that has one");
    assert.equal(W.softBlockConfig().name, "sam");
    const vc = C.venueConfig({ fresh: true });
    assert.deepEqual(vc.sources.map((s) => s.key), ["s1", "s2"]);
    assert.deepEqual(vc.metro_tz, { metro_b: "Etc/GMT-2", metro_c: "Etc/GMT+5" });
    fs.writeFileSync(b, "{ broken");
    assert.throws(() => L.watchConfig(), /lanes_file/);
  } finally {
    fs.rmSync(path.join(cfgDir, "venue-watch.json"));
    fs.writeFileSync(path.join(cfgDir, "venue-events.json"), JSON.stringify({ home_metro: "metro_a", metros: ["metro_a", "metro_b"], near_zone: "near" }));
    C.resetVenueConfig();
  }
});

// ─── artist watches ────────────────────────────────────────────────────────

const RULES = [
  { id: "w-singer-2", updated_at: "2026-10-03T00:00:00Z", title: "Singer One in any city", condition: "a Singer One show", request: "and Singer One anywhere" },
  { id: "w-singer", updated_at: "2026-10-01T00:00:00Z", title: "Tell the user when Singer One plays where they are", condition: "a show by Singer One (not Singer Two)", request: "watch for Singer One" },
  { id: "w-letter", updated_at: "2026-10-02T00:00:00Z", title: "When the bank letter arrives", condition: "a bank letter", request: "tell me when it arrives" },
];
const READ = { watches: [
  { id: "w-singer-2", artist: "Singer One", aliases: [], note: "Singer One, the vocalist (not Singer Two)", query: "Singer One concerts", category: "music" },
  { id: "w-singer", artist: "Singer One", aliases: ["סינגר וואן"], note: "Singer One, the vocalist (not Singer Two)", query: "Singer One concerts", category: "music" },
  { id: "w-letter", artist: "", aliases: [], note: "", query: "", category: "other" },
] };

test("watchedArtists: one read per new or edited watch, inactive ones dropped, a failed read waits for the next run", async () => {
  const calls = [];
  const run = async (o) => { calls.push(o); return READ; };
  const cache = { "w-gone": { updated_at: "x", artist: "Old Act", aliases: ["Old Act"] } };
  const a = await L.watchedArtists({ rules: RULES, cache, run });
  assert.deepEqual(a.map((x) => [x.watch_id, x.artist, x.aliases.join("|"), x.query]), [["w-singer-2", "Singer One", "Singer One", "Singer One concerts"], ["w-singer", "Singer One", "Singer One|סינגר וואן", "Singer One concerts"]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, W.HAIKU);
  assert.equal(cache["w-gone"], undefined);
  assert.equal(cache["w-letter"].artist, "", "a watch that is not about a performer is remembered as such");
  await L.watchedArtists({ rules: RULES, cache, run });
  assert.equal(calls.length, 1, "nothing new: no model call");
  const edited = [RULES[0], { ...RULES[1], updated_at: "2026-10-05T00:00:00Z" }, RULES[2]];
  await L.watchedArtists({ rules: edited, cache, run: async () => { throw new Error("timeout"); } });
  assert.equal(cache["w-singer"].updated_at, "2026-10-01T00:00:00Z", "the failed read leaves it to be read again");
  await assert.rejects(() => L.watchedArtists({ rules: edited, cache, run: async () => { throw Object.assign(new Error("not on Max"), { fatal: true }); } }), /not on Max/);
});

const TOUR = {
  events_results: [
    { title: "Far City, ST", date: { start_date: "Nov 12", when: "Thu 7:00 PM" }, time: "7:00 PM", venue: "Hall A" },
    { title: "Next City, ST", date: { start_date: "Mar 4", when: "Thu 6:30 PM 2027" }, time: "6:30 PM", venue: "Hall B" },
    { title: "Gone City, ST", date: { start_date: "Oct 27", when: "Tue 8:00 PM" }, venue: "Hall C" },
    { title: "Ignored title", address: ["Hall D", "Home City, ST"], date: { start_date: "Dec 1", when: "Dec 1, 8:30 PM" }, venue: { name: "Hall D" } },
  ],
  organic_results: [{ link: "https://fan-wiki.example.org/singer-one" }, { link: "https://www.ticketmaster.com/singer-one-tickets/artist/1" }],
};

test("googleTourRows: Google's tour block becomes dated rows with the page's ticketing link; no ticket link, no rows", () => {
  const rows = L.googleTourRows(TOUR, { artist: "Singer One", today: "2026-10-30" });
  assert.deepEqual(rows.map((r) => [r.title, r.city, r.state, r.date, r.time, r.url, r.performers[0], r.source]), [
    ["Singer One — Hall A", "Far City", "ST", "2026-11-12", "19:00", "https://www.ticketmaster.com/singer-one-tickets/artist/1", "Singer One", "serpapi-tour"],
    ["Singer One — Hall B", "Next City", "ST", "2027-03-04", "18:30", "https://www.ticketmaster.com/singer-one-tickets/artist/1", "Singer One", "serpapi-tour"],
    ["Singer One — Hall D", "Home City", "ST", "2026-12-01", "20:30", "https://www.ticketmaster.com/singer-one-tickets/artist/1", "Singer One", "serpapi-tour"],
  ]);
  assert.deepEqual(L.googleTourRows({ ...TOUR, organic_results: [{ link: "https://fan-wiki.example.org/x" }] }, { artist: "Singer One", today: "2026-10-30" }), []);
  assert.equal(L.ticketLink({ organic_results: [{ link: "https://shop.example-tix.com/a" }] }, ["example-tix.com"]), "https://shop.example-tix.com/a");
  assert.equal(L.ticketLink({ organic_results: [{ link: "/goto?url=x" }] }, ["example-tix.com"]), null, "a relative link is not a ticket link");
  const own = L.googleTourRows({ events_results: [
    { title: "Far City, ST", date: { start_date: "Nov 12", when: "Thu 7:00 PM" }, venue: "Hall A", link: "https://www.example-tix.com/e/1" },
    { title: "Far City, ST", date: { start_date: "Nov 13", when: "Fri 7:00 PM" }, venue: "Hall A", link: "https://www.search.example/goto?x" },
  ], organic_results: [] }, { artist: "Singer One", today: "2026-10-30", hosts: ["example-tix.com"] });
  assert.deepEqual(own.map((r) => [r.date, r.url]), [["2026-11-12", "https://www.example-tix.com/e/1"]], "an event's own ticketing link, else none");
  assert.equal(L.ticketLink({ organic_results: [{ link: "https://notexample-tix.com/a" }] }, ["example-tix.com"]), null);
});

test("artist watches: store, Ticketmaster and the capped Google search feed watchlist rows; away dates wait unseen; dry runs never search", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "artist-watch-"));
  const stateFile = path.join(dir, "state.json");
  process.env.TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY || "test-key";
  const searches = [];
  let clock = Date.parse("2026-10-30T07:00:00Z");
  const deps = {
    run: async () => READ, rules: async () => RULES,
    search: (engine, q, p) => { searches.push([engine, q, p]); return { result: TOUR }; },
    searchesLeft: () => 200,
    tm: async (name) => (name === "Singer One" ? [{ key: "tm1", source: "tm-artist", title: "Singer One", venue: "Arena", city: "Home City", date: "2026-11-20", time: "20:00", performers: ["Singer One"], url: "https://tm.example/e/1", category: "music" }] : []),
    inCity: (metro) => metro !== "far city",
    headliner: () => false, now: () => clock,
  };
  const store = { events: {
    s1: { key: "s1", title: "סינגר וואן בהופעה", venue: "Hall E", date: "2026-11-25", performers: [], category: "music", gate_metro: "metro_b" },
    s2: { key: "s2", title: "Someone Else", venue: "Hall F", date: "2026-11-26", performers: [], category: "music" },
    s3: { key: "s3", title: "Singer One", venue: "Hall G", date: "2026-10-01", performers: [], category: "music" },
  } };
  const lane = L.buildLane("tour-watch", { ...CFG.lanes["tour-watch"], artist_watches: { state_file: stateFile, max_searches: 3, reserve: 50, refresh_hours: 72 } }, CFG, { artistWatch: deps });

  const all = await lane.extraCandidates({ store, today: "2026-10-30" });
  assert.deepEqual(searches, [["google", "Singer One concerts", { hl: "en", gl: "us" }]], "two watches for one performer: one search");
  const rows = all.filter((r) => !r.held);
  const google = L.googleTourRows(TOUR, { artist: "Singer One", today: "2026-10-30" });
  assert.deepEqual(rows.map((r) => r.key).sort(), ["s1", "tm1", ...google.filter((r) => r.city !== "Far City").map((r) => r.key)].sort());
  assert.deepEqual(all.filter((r) => r.held).map((r) => r.city), ["Far City"], "the Far City date is held: the user is not there then");
  for (const r of all) {
    assert.equal(r.branch, "watchlist");
    assert.equal(r.artist, "Singer One");
    assert.equal(r.watch, "Singer One, the vocalist (not Singer Two)");
    assert.equal(r.watch_id, "w-singer-2");
  }
  const rowsForModel = W.candidateRows(rows);
  assert.ok(rowsForModel.every((r) => r.watch === "Singer One, the vocalist (not Singer Two)" && r.branch === "watchlist"));

  clock += 24 * 3600e3;
  await lane.extraCandidates({ store, today: "2026-10-31" });
  assert.equal(searches.length, 1, "inside refresh_hours: the cached rows, no new search");

  clock += 72 * 3600e3;
  const before = fs.readFileSync(stateFile, "utf8");
  const dry = await lane.extraCandidates({ store, today: "2026-11-03", dryRun: true });
  assert.equal(searches.length, 1, "a dry run never spends a search");
  assert.equal(fs.readFileSync(stateFile, "utf8"), before, "and writes nothing");
  assert.ok(dry.some((r) => r.source === "serpapi-tour"), "it still sees the cached rows");

  const low = L.buildLane("tour-watch", { ...CFG.lanes["tour-watch"], artist_watches: { state_file: stateFile, reserve: 50 } }, CFG, { artistWatch: { ...deps, searchesLeft: () => 50 } });
  await low.extraCandidates({ store, today: "2026-11-03" });
  assert.equal(searches.length, 1, "at the reserve: no search");
  const blind = L.buildLane("tour-watch", { ...CFG.lanes["tour-watch"], artist_watches: { state_file: stateFile } }, CFG, { artistWatch: { ...deps, searchesLeft: () => null } });
  await blind.extraCandidates({ store, today: "2026-11-03" });
  assert.equal(searches.length, 1, "an unreadable allowance fails closed");
  await lane.extraCandidates({ store, today: "2026-11-03" });
  assert.equal(searches.length, 2, "past refresh_hours with allowance: searched again");

  const failing = L.buildLane("tour-watch", { ...CFG.lanes["tour-watch"], artist_watches: { state_file: stateFile } }, CFG, { artistWatch: { ...deps, search: () => ({ error: "timeout" }) } });
  clock += 72 * 3600e3;
  const kept = await failing.extraCandidates({ store, today: "2026-11-03" });
  assert.ok(kept.some((r) => r.source === "serpapi-tour"), "a failed search keeps the last rows");

  const noRules = L.buildLane("tour-watch", { artist_watches: { state_file: stateFile } }, CFG, { artistWatch: { ...deps, rules: async () => { throw new Error("db locked"); } } });
  assert.deepEqual(await noRules.extraCandidates({ store, today: "2026-11-03" }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("mergeExtras: a held extra row keeps the same show out of the pool, unseen; other extras join it", () => {
  const pool = [
    { key: "p1", title: "Singer One", venue: "Hall A", date: "2026-11-20", performers: ["Singer One"] },
    { key: "p2", title: "Other Act", venue: "Hall B", date: "2026-11-21", performers: [] },
  ];
  const extra = [
    { key: "x1", title: "Singer One — Hall A", venue: "Hall A", date: "2026-11-20", performers: ["Singer One"], held: true },
    { key: "x2", title: "Singer One — Hall C", venue: "Hall C", date: "2026-12-02", performers: ["Singer One"] },
  ];
  assert.deepEqual(W.mergeExtras(pool, extra).map((e) => e.key), ["p2", "x2"]);
  assert.deepEqual(W.mergeExtras(pool, []).map((e) => e.key), ["p1", "p2"]);
});
