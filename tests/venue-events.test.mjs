// venue-events.test.mjs — the shared venue ingest + watch-lane bookkeeping.
//
// These pin the parts that are easy to get quietly wrong: vendor date parsing
// (a year-less "Oct 4" must land on the coming one), the affiliate-link unwrap,
// the store keeping an errored source's events instead of letting them vanish
// and come back "new", and dedup against legacy seen files so the cutover from
// the agent-run lanes does not re-announce everything.
//
// Run: node --test tests/venue-events.test.mjs
//
// Venue names, artists and metros below are synthetic. The test points
// JORI_LOCAL_DIR at its own config (home metro "metro_a", zone UTC), so it runs
// the same on a fresh install and on a configured one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "venue-events-test-"));
fs.mkdirSync(path.join(LOCAL, "config"));
fs.writeFileSync(path.join(LOCAL, "config", "venue-events.json"), JSON.stringify({ home_metro: "metro_a", metros: ["metro_a"] }));
process.env.JORI_LOCAL_DIR = LOCAL;
process.env.JORI_TZ = "UTC";

const { parseVendorDate, parseVendorTime, eventKey, makeEvent, slug } = await import("../lib/venue-events/normalize.mjs");
const { mapTmEvent, unwrapTmUrl, tmCategory, mapTribe, loadFetchers, FETCHERS, sourceCodeRef } = await import("../lib/venue-events/fetchers.mjs");
const { mergeSource, prune, eventsForGroups, sourceHealthVerdict, venueHealthNote } = await import("../lib/venue-events/store.mjs");
const { fingerprints, seenSet, isKnown, loadSeen, candidateRows } = await import("../lib/venue-events/watch.mjs");
const { parseWatchlist, namesArtist, venuePerkNote } = await import("../lib/venue-events/lanes.mjs");

test("vendor dates: ISO, ICS, numeric, month-name with and without year", () => {
  assert.equal(parseVendorDate("2026-10-04T20:00:00-04:00", "2026-10-04"), "2026-10-04");
  assert.equal(parseVendorDate("20261004T200000", "2026-10-04"), "2026-10-04");
  assert.equal(parseVendorDate("10/4/26", "2026-10-04"), "2026-10-04");
  assert.equal(parseVendorDate("Sat, Oct 10", "2026-10-04"), "2026-10-10");
  assert.equal(parseVendorDate("October 10, 2027", "2026-10-04"), "2027-10-10");
  assert.equal(parseVendorDate("10 Oct", "2026-10-04"), "2026-10-10");
  // A WP post title "Some Film – Sep 19 ’26 – 06:45PM": a 2-digit year must pin it, not roll it to 2027
  assert.equal(parseVendorDate("Some Film – Sep 19 ’26 – 06:45PM", "2026-10-04"), "2026-09-19");
  assert.equal(parseVendorDate("nonsense", "2026-10-04"), null);
});

test("year-less dates roll to next year only past a 7-day slack", () => {
  // Jan 5 seen in late December belongs to the coming January.
  assert.equal(parseVendorDate("Jan 5", "2026-12-28"), "2027-01-05");
  // A show listed for 3 days ago stays this year (not jumped a year ahead).
  assert.equal(parseVendorDate("Oct 1", "2026-10-04"), "2026-10-01");
});

test("vendor times", () => {
  assert.equal(parseVendorTime("8:00 PM"), "20:00");
  assert.equal(parseVendorTime("7pm"), "19:00");
  assert.equal(parseVendorTime("12:30 am"), "00:30");
  assert.equal(parseVendorTime("19:30"), "19:30");
  assert.equal(parseVendorTime("20261004T193000"), "19:30");
});

test("event key collides for the same show from two sources", () => {
  const a = eventKey({ venue: "Jazz Room", date: "2026-10-10", title: "Ada Vale" });
  const b = eventKey({ venue: "jazz room", date: "2026-10-10", title: "ADA VALE" });
  assert.equal(a, b);
  assert.equal(slug("Café Ünder?"), "cafe-under");
});

test("Ticketmaster: affiliate unwrap, status, category", () => {
  const wrapped = "https://ticketmaster.evyy.net/c/Example/1/2?u=https%3A%2F%2Fwww.ticketmaster.com%2Fx%2Fevent%2FABC";
  assert.equal(unwrapTmUrl(wrapped), "https://www.ticketmaster.com/x/event/ABC");
  assert.equal(unwrapTmUrl("https://www.ticketmaster.com/y"), "https://www.ticketmaster.com/y");
  const ev = mapTmEvent({
    name: "Ada Vale", url: wrapped,
    dates: { start: { localDate: "2026-11-02", localTime: "20:00:00" }, status: { code: "rescheduled" } },
    classifications: [{ segment: { name: "Music" }, genre: { name: "Jazz" } }],
    _embedded: { attractions: [{ name: "Ada Vale" }] },
  }, { key: "tm-jazz-room", venue: "Jazz Room", category: "music" }, "2026-10-04");
  assert.equal(ev.date, "2026-11-02");
  assert.equal(ev.time, "20:00");
  assert.equal(ev.status, "postponed");
  assert.equal(ev.category, "music");
  assert.deepEqual(ev.performers, ["Ada Vale"]);
  assert.equal(tmCategory({ classifications: [{ segment: { name: "Arts & Theatre" }, genre: { name: "Comedy" } }] }), "comedy");
});

test("tribe (WordPress Events Calendar) mapping", () => {
  const li = mapTribe({ title: "Rock &amp; Roll Night", start_date: "2026-10-16 17:45:00", url: "https://li/e", categories: [{ name: "Music" }], excerpt: "<p>Join us</p>" },
    { key: "park-stage", venue: "Park Stage", category: "performance" }, "2026-10-04");
  assert.equal(li.title, "Rock & Roll Night");
  assert.equal(li.description, "Join us");
  assert.equal(li.time, "17:45");
  assert.equal(li.city, "metro_a", "a row with no city belongs to the configured home metro");
});

test("store: an errored source keeps its events; zero rows bumps zero_streak; prune past + stale", () => {
  const store = { sources: {}, events: {} };
  const src = { key: "s", kind: "tm", groups: ["rnb"] };
  const ev = makeEvent(src, { title: "A", date: "2026-10-10", venue: "V" }, "2026-10-04");
  mergeSource(store, src, { events: [ev] }, "2026-10-04T10:00:00Z");
  assert.equal(Object.keys(store.events).length, 1);
  mergeSource(store, src, { events: [], error: "HTTP 500" }, "2026-10-05T10:00:00Z");
  assert.equal(Object.keys(store.events).length, 1, "a failed fetch must not drop known shows");
  assert.equal(store.sources.s.error_streak, 1);
  mergeSource(store, src, { events: [] }, "2026-10-06T10:00:00Z");
  assert.equal(store.sources.s.zero_streak, 1);
  assert.equal(store.sources.s.error_streak, 0);
  // first_seen survives a re-listing
  mergeSource(store, src, { events: [ev] }, "2026-10-07T10:00:00Z");
  assert.equal(store.events[ev.key].first_seen, "2026-10-04T10:00:00Z");
  prune(store, "2026-10-20");
  assert.equal(Object.keys(store.events).length, 0, "past shows are pruned");
});

test("eventsForGroups: group + horizon + drops cancelled", () => {
  const store = { events: {
    a: { key: "a", groups: ["rnb"], date: "2026-10-10", status: "onsale" },
    b: { key: "b", groups: ["rnb"], date: "2026-10-10", status: "cancelled" },
    c: { key: "c", groups: ["village"], date: "2026-10-10" },
    d: { key: "d", groups: ["rnb"], date: "2027-06-01" },
  } };
  const got = eventsForGroups(store, ["rnb"], { today: "2026-10-04", horizonDays: 90 }).map((e) => e.key);
  assert.deepEqual(got, ["a"]);
});

test("legacy seen files dedup new-format events (no re-announce at cutover)", () => {
  // an older seen-file shape
  const legacy = loadSeen("/nonexistent"); // empty is fine
  assert.deepEqual(legacy.seen, []);
  const set = seenSet([{ artist: "Ada Vale", venue: "Jazz Room", date: "2026-11-02", branch: "discovery" }]);
  const ev = { key: "ada-vale-live|jazz-room|2026-11-02", title: "Ada Vale Live", performers: ["Ada Vale"], date: "2026-11-02" };
  assert.ok(isKnown(ev, set), "performer|date fingerprint matches the legacy artist|date entry");
  assert.ok(fingerprints(ev).includes(ev.key));
});

test("watchlist parse: tiers, aliases, deceased skipped, other sections ignored", () => {
  const md = `## Concert watchlist
### Tier 1 — Urgent
- **Artist One** (10 plays)
- **Artist Two** (8)
### Tier 4 — Israeli heritage
- **Artist Three / Band Four** (7+5)
- **Artist Five** — deceased, skip
### Tier 5 — Classic
- **Band Six + Singer Seven** (3)
### Deceased (do NOT search)
- **Artist Eight**
## Comedy
- **Comic Nine**`;
  const w = parseWatchlist(md);
  assert.deepEqual(w.map((x) => `${x.tier}:${x.name}`), ["1:Artist One", "1:Artist Two", "4:Artist Three", "4:Band Four", "5:Band Six + Singer Seven"]);
});

test("namesArtist matches whole names only", () => {
  assert.ok(namesArtist({ title: "An Evening with Artist One" }, "Artist One"));
  assert.ok(!namesArtist({ title: "Artist Oneray Tribute" }, "Artist One"));
  assert.ok(namesArtist({ title: "Tour", performers: ["Artist Two"] }, "Artist Two"));
});

test("candidate rows carry short ids and only compact fields", () => {
  const rows = candidateRows([{ title: "X", venue: "V", date: "2026-10-10", city: "metro_a", performers: [], branch: "discovery" }]);
  assert.deepEqual(rows[0], { id: "c1", title: "X", venue: "V", date: "2026-10-10", branch: "discovery" });
});

// Regression guard for the 2026-10-06 system-channel alert "venue-ingest:
// <key> has returned 0 events 3 runs running — the watch lanes that read it
// are blind to that venue". Three of those landed in 50 seconds and two were
// false: tm-hall-parent is an empty Ticketmaster parent record (0 events
// unfiltered) whose shows are filed under tm-hall-room, and
// tm-far-horizon's only listings sit past the ingest horizon. A source
// that never produced a row must not be reported as a venue gone dark.
test("health: last_nonzero separates a source that went quiet from one that never produced", () => {
  const store = { sources: {}, events: {} };
  const src = { key: "s", kind: "tm", groups: ["discovery"] };
  const ev = makeEvent(src, { title: "T", date: "2026-12-01", venue: "V" }, "2026-10-01");

  // never produced: three empty runs
  for (const d of ["2026-10-01", "2026-10-02", "2026-10-03"]) {
    mergeSource(store, src, { events: [] }, `${d}T10:00:00Z`);
  }
  assert.equal(store.sources.s.zero_streak, 3);
  assert.equal(store.sources.s.last_nonzero, null);
  assert.equal(store.sources.s.last_ok, "2026-10-03T10:00:00Z", "last_ok is set even on an empty fetch, which is why last_nonzero exists");
  assert.equal(sourceHealthVerdict(store.sources.s), "never-produced");

  // then it produces, then goes quiet three runs: that IS a blind spot
  mergeSource(store, src, { events: [ev] }, "2026-10-04T10:00:00Z");
  assert.equal(store.sources.s.zero_streak, 0);
  assert.equal(store.sources.s.last_nonzero, "2026-10-04T10:00:00Z");
  for (const d of ["2026-10-05", "2026-10-06", "2026-10-07"]) {
    mergeSource(store, src, { events: [] }, `${d}T10:00:00Z`);
  }
  assert.equal(sourceHealthVerdict(store.sources.s), "went-quiet");
  assert.equal(store.sources.s.last_nonzero, "2026-10-04T10:00:00Z", "a quiet run must not clear the last-good marker");

  // an errored source is its own verdict and keeps its last_nonzero
  mergeSource(store, src, { events: [], error: "HTTP 500" }, "2026-10-08T10:00:00Z");
  mergeSource(store, src, { events: [], error: "HTTP 500" }, "2026-10-09T10:00:00Z");
  mergeSource(store, src, { events: [], error: "HTTP 500" }, "2026-10-10T10:00:00Z");
  assert.equal(sourceHealthVerdict(store.sources.s), "failing");
  assert.equal(store.sources.s.last_nonzero, "2026-10-04T10:00:00Z");
});

test("health: a pre-upgrade row whose last fetch had events is not called never-produced", () => {
  // Rows written before last_nonzero existed carry last_count + last_ok only.
  const store = { sources: { s: { kind: "tm", last_ok: "2026-10-05T10:00:00Z", last_count: 12, zero_streak: 0, error_streak: 0 } }, events: {} };
  const src = { key: "s", kind: "tm", groups: ["rnb"] };
  for (const d of ["2026-10-06", "2026-10-07", "2026-10-08"]) {
    mergeSource(store, src, { events: [] }, `${d}T10:00:00Z`);
  }
  assert.equal(store.sources.s.zero_streak, 3);
  assert.equal(store.sources.s.last_nonzero, "2026-10-05T10:00:00Z", "seeded from the pre-upgrade last_ok");
  assert.equal(sourceHealthVerdict(store.sources.s), "went-quiet", "it produced 12 rows last week — this is a regression, not unverified config");
});

test("health note: one row for the whole run, and no blind-spot claim for a never-produced source", () => {
  const never = { zero_streak: 3, error_streak: 0, last_nonzero: null };
  const quiet = { zero_streak: 3, error_streak: 0, last_nonzero: "2026-09-20T10:00:00Z" };
  const failing = { zero_streak: 0, error_streak: 3, last_error: "HTTP 503" };

  const note = venueHealthNote([
    { key: "tm-far-horizon", health: never, groups: ["discovery", "rnb"] },
    { key: "jazz-club", health: quiet, groups: ["discovery", "rnb"] },
    { key: "late-room", health: failing, groups: ["rnb"] },
  ]);

  // ONE row, three bullets — not three rows 50 seconds apart.
  assert.equal(note.split("•").length - 1, 3);
  assert.match(note, /3 venue sources need a look/);

  const zankel = note.split("\n").find((l) => l.includes("tm-far-horizon"));
  assert.match(zankel, /never returned a row/);
  assert.ok(!/blind/.test(zankel), "a source that never produced a row is unverified config, not a venue gone dark");

  const bird = note.split("\n").find((l) => l.includes("jazz-club"));
  assert.match(bird, /genuine blind spot/);
  assert.match(bird, /2026-09-20/, "says when it last had events, so the reader can see what regressed");

  assert.match(note.split("\n").find((l) => l.includes("late-room")), /HTTP 503/);

  // single source reads as singular
  assert.match(venueHealthNote([{ key: "jazz-club", health: quiet, groups: [] }]), /one venue source needs a look/);
});

// Regression guard for the 2026-10-20 system-channel alert "venue-ingest: one
// venue source needs a look … tm-seasonal-stadium — came back empty 3 runs
// running, having had events as recently as 2026-10-17. This one is a genuine
// blind spot." (2026-10-20).
// It was false: Seasonal Stadium's season had ended, the Ticketmaster API
// answered 200, and the next listing was in 2027, past the horizon. Little
// Island was one run behind it. A calendar that ran out must not page.
test("health: a calendar that ran out (every listed show past) is ran-out, not a blind spot", () => {
  const store = { sources: {}, events: {} };
  const src = { key: "tm-seasonal-stadium", kind: "tm", groups: ["discovery"] };
  const last = makeEvent(src, { title: "Last Show", date: "2026-10-17", venue: "Seasonal Stadium" }, "2026-10-17");
  mergeSource(store, src, { events: [last], ref: "2026-10-17" }, "2026-10-17T09:35:00Z");
  assert.equal(store.sources[src.key].listed_through, "2026-10-17");
  for (const d of ["2026-10-18", "2026-10-19", "2026-10-20"]) {
    mergeSource(store, src, { events: [], ref: d }, `${d}T09:35:00Z`);
  }
  const h = store.sources[src.key];
  assert.equal(h.zero_streak, 3);
  assert.equal(h.zero_since, "2026-10-18", "stamped on the run the streak began, not moved by later empty runs");
  assert.equal(sourceHealthVerdict(h), "ran-out");
  const note = venueHealthNote([{ key: src.key, health: h, groups: src.groups }]);
  assert.ok(!/blind/.test(note), "the defensive wording must not call a finished season a blind spot");
  assert.match(note, /2026-10-17/);
});

test("health: shows that vanish while still in the future are still a genuine blind spot", () => {
  const store = { sources: {}, events: {} };
  const src = { key: "jazz-club", kind: "cdp", groups: ["rnb"] };
  const future = makeEvent(src, { title: "Future Set", date: "2026-11-17", venue: "Jazz Club" }, "2026-10-17");
  mergeSource(store, src, { events: [future], ref: "2026-10-17" }, "2026-10-17T09:35:00Z");
  for (const d of ["2026-10-18", "2026-10-19", "2026-10-20"]) {
    mergeSource(store, src, { events: [], ref: d }, `${d}T09:35:00Z`);
  }
  const h = store.sources[src.key];
  assert.equal(sourceHealthVerdict(h), "went-quiet");
  assert.match(venueHealthNote([{ key: src.key, health: h, groups: src.groups }]), /genuine blind spot/);
});

test("health: a pre-upgrade row is backfilled from the store before prune (the Park Stage crossing)", () => {
  // The live park-stage row on 2026-10-20: zero_streak 2, last_nonzero on
  // 2026-10-18 (01:35 local), no listed_through / zero_since, one stored show dated 2026-10-18.
  const src = { key: "park-stage", kind: "tribe", groups: ["village"] };
  const ev = makeEvent(src, { title: "Closing Night", date: "2026-10-18", venue: "Park Stage" }, "2026-10-18");
  const store = {
    sources: { [src.key]: { kind: "tribe", last_ok: "2026-10-20T05:35:01.236Z", last_nonzero: "2026-10-18T05:35:01.319Z",
      last_count: 0, last_error: null, zero_streak: 2, error_streak: 0 } },
    events: { [ev.key]: { ...ev, groups: src.groups, first_seen: "2026-10-01T05:35:00Z", last_seen: "2026-10-18T05:35:01.319Z" } },
  };
  mergeSource(store, src, { events: [], ref: "2026-10-21" }, "2026-10-21T09:35:00Z");
  const h = store.sources[src.key];
  assert.equal(h.zero_streak, 3);
  assert.equal(h.listed_through, "2026-10-18", "derived from the store's own events for this source");
  assert.equal(h.zero_since, "2026-10-19", "the local day after last_nonzero");
  assert.equal(sourceHealthVerdict(h), "ran-out");
  // Without the backfill the prune that follows would leave no evidence.
  prune(store, "2026-10-21");
  assert.equal(Object.keys(store.events).length, 0);
  assert.equal(store.sources[src.key].listed_through, "2026-10-18");
});

test("health: zero_since resets when events return; listed_through survives error runs", () => {
  const store = { sources: {}, events: {} };
  const src = { key: "s", kind: "tm", groups: ["rnb"] };
  const a = makeEvent(src, { title: "A", date: "2026-10-25", venue: "V" }, "2026-10-10");
  const undated = makeEvent(src, { title: "Residency", venue: "V" }, "2026-10-10");
  mergeSource(store, src, { events: [a], ref: "2026-10-10" }, "2026-10-10T09:35:00Z");
  assert.equal(store.sources.s.listed_through, "2026-10-25");
  mergeSource(store, src, { events: [], ref: "2026-10-11" }, "2026-10-11T09:35:00Z");
  assert.equal(store.sources.s.zero_since, "2026-10-11");
  mergeSource(store, src, { events: [], error: "HTTP 500", ref: "2026-10-12" }, "2026-10-12T09:35:00Z");
  assert.equal(store.sources.s.listed_through, "2026-10-25", "carried across an error run");
  assert.equal(store.sources.s.zero_since, "2026-10-11", "carried across an error run");
  mergeSource(store, src, { events: [a, undated], ref: "2026-10-13" }, "2026-10-13T09:35:00Z");
  assert.equal(store.sources.s.zero_since, null, "events came back, so the empty streak is over");
  assert.equal(store.sources.s.listed_through, null, "a non-empty run with any undated row clears it, never carries the old value");
  // no ref given: falls back to the UTC date of nowIso
  mergeSource(store, src, { events: [] }, "2026-10-14T09:35:00Z");
  assert.equal(store.sources.s.zero_since, "2026-10-14");
});

// Critic finding on the 2026-10-20 draft: an undated row (an article, a
// residency, an ongoing exhibit) never "happens", so a source that lists them
// can never be judged ran-out. city-guide held 27 undated rows and one dated
// 2026-10-23; had it broken to zero after that date, a ran-out verdict would
// have only been logged, removing the backstop skill-repair relies on.
test("health: a mostly-undated source (city-guide shape) that goes dark is still a genuine blind spot", () => {
  const src = { key: "city-guide", kind: "cdp", groups: ["discovery"] };
  const dated = makeEvent(src, { title: "Pop-up", date: "2026-10-23", venue: "Somewhere" }, "2026-10-20");
  const undated = [1, 2, 3].map((i) => makeEvent(src, { title: `Article ${i}`, venue: "City Guide" }, "2026-10-20"));
  const store = { sources: {}, events: {} };
  mergeSource(store, src, { events: [dated, ...undated], ref: "2026-10-20" }, "2026-10-20T09:35:00Z");
  assert.equal(store.sources[src.key].listed_through, null);
  for (const d of ["2026-10-24", "2026-10-25", "2026-10-26"]) {
    mergeSource(store, src, { events: [], ref: d }, `${d}T09:35:00Z`);
  }
  const h = store.sources[src.key];
  assert.equal(h.zero_streak, 3);
  assert.equal(sourceHealthVerdict(h), "went-quiet");
  assert.match(venueHealthNote([{ key: src.key, health: h, groups: src.groups }]), /genuine blind spot/);

  // The backfill obeys the same rule: a pre-upgrade row whose stored events include an undated one stays null.
  const legacy = { sources: { [src.key]: { kind: "cdp", last_nonzero: "2026-10-23T09:35:00Z", last_count: 0, zero_streak: 2, error_streak: 0 } }, events: {} };
  for (const ev of [dated, ...undated]) legacy.events[ev.key] = { ...ev, groups: src.groups };
  mergeSource(legacy, src, { events: [], ref: "2026-10-26" }, "2026-10-26T09:35:00Z");
  assert.equal(legacy.sources[src.key].listed_through, null);
  assert.equal(sourceHealthVerdict(legacy.sources[src.key]), "went-quiet");
});

test("perks: a configured venue's standing note, exact venue name, case-insensitive", () => {
  const perks = [{ venue: "Jazz Room", note: "Members get early seating here." }];
  assert.equal(venuePerkNote({ venue: "Jazz Room" }, perks), "Members get early seating here.");
  assert.equal(venuePerkNote({ venue: "jazz room" }, perks), "Members get early seating here.", "venue casing is not part of the match");
  assert.equal(venuePerkNote({ venue: "Other Club" }, perks), "");
  assert.equal(venuePerkNote({ venue: "Jazz Room Gift Shop" }, perks), "", "a longer venue name is a different venue");
  assert.equal(venuePerkNote({}, perks), "");
  assert.equal(venuePerkNote({ venue: "Jazz Room" }), "", "no perks configured: no note");
});

test("fetchers: built-in kinds, hook modules add theirs, a broken hook module is skipped", async () => {
  for (const k of ["tm", "tribe", "wpPosts", "cdp", "squarespaceEvents", "dice", "jsonLdPage"]) assert.equal(typeof FETCHERS[k], "function", k);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "venue-ext-"));
  fs.writeFileSync(path.join(dir, "a.mjs"), "export const kinds = { demoKind: async () => [] }; export const codeFiles = { demoKind: 'lib/demo.mjs' };");
  fs.writeFileSync(path.join(dir, "b.mjs"), "throw new Error('boom');");
  const logs = [];
  const all = await loadFetchers({ dir, log: (m) => logs.push(m) });
  assert.equal(typeof all.demoKind, "function");
  assert.equal(typeof all.tm, "function");
  assert.equal(sourceCodeRef({ kind: "demoKind" }).action_file, "lib/demo.mjs");
  assert.equal(sourceCodeRef({ kind: "dice", url: "https://x" }).action_file, "lib/venue-events/sources-generic.mjs");
  assert.ok(logs.some((l) => l.includes("b.mjs")), "the broken module is reported");
  assert.equal(Object.keys(await loadFetchers({ dir: path.join(dir, "missing") })).length, Object.keys(FETCHERS).length);
});
