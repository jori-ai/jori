// comedy-club-watch.test.mjs — Direction B parsers and matching for
// bin/comedy-club-watch-run. Every name, room and date here is synthetic.
// Run: node --test tests/comedy-club-watch.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { rosterHits, parseCellarSets, cardDate, onsalePhrase, itemKey, pingText, to24 } from "../lib/comedy.mjs";
import { eventsFromHtml } from "../lib/event-ld.mjs";
import { toItems } from "../bin/comedy-club-watch-run";

const roster = [
  { name: "Lou Ek", aka: ["Lou E.K."], taste: "neutral" },
  { name: "Mod Vance", aka: ["Mod"], taste: "core" },
  { name: "Jon Mallory", taste: "yes" },
];

// Shape of a club lineup API's show.html (the Comedy Cellar markup, trimmed).
const CELLAR = `<div><div class="set-header"><span class="lineup-toggle" data-lineup-id="1">+</span><div class="info"><span class="bold">9:30 pm<span class="hide-mobile"> show</span></span><span class="divider">-</span><span class="title">Main Room</span></div></div><div class="lineup" data-set-content="1"><div class="set-content"><div><p><span class="name">Lou E.K.</span> FX&#039;s SHOW</p></div><div><p><span class="name">Jo Last</span></p></div></div><div class="make-reservation"><a href="/reservations-town/?showid=1791158200">Make A Reservation</a></div></div></div>`;

test("club lineup API → named sets with a per-show link", () => {
  const [s] = parseCellarSets(CELLAR, "2026-10-05");
  assert.equal(s.time, "21:30");
  assert.deepEqual(s.names, ["Lou E.K.", "Jo Last"]);
  assert.equal(s.url, "https://www.comedycellar.com/reservations-town/?showid=1791158200");
  assert.deepEqual(rosterHits(s.text, roster).map((c) => c.name), ["Lou Ek"]);
});

test("roster match is on word boundaries", () => {
  assert.equal(rosterHits("Modified Comedy Night", roster).length, 0);
  assert.deepEqual(rosterHits("Mod: Live in Town", roster).map((c) => c.name), ["Mod Vance"]);
  assert.deepEqual(rosterHits("An Evening with JON MALLORY (work in progress)", roster).map((c) => c.name), ["Jon Mallory"]);
});

test("JSON-LD events from a venue page", () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"ComedyEvent","name":"Jon Mallory: New Hour","startDate":"2027-01-14T19:00:00-05:00","url":"/events/mallory","performer":[{"@type":"Person","name":"Jon Mallory"}],"offers":{"availability":"https://schema.org/InStock"},"location":{"name":"Example Comedy Club"}}]}</script>`;
  const [e] = eventsFromHtml(html, "https://comedy.example.com/");
  assert.equal(e.url, "https://comedy.example.com/events/mallory");
  assert.equal(e.availability, "InStock");
  assert.equal(onsalePhrase(e.availability), "on sale NOW");
  assert.equal(onsalePhrase("https://schema.org/SoldOut"), "SOLD OUT — resale only");
});

test("card dates and times", () => {
  assert.equal(cardDate("Sat Oct 12 · 7:30 PM", "2026-10-04"), "2026-10-12");
  assert.equal(cardDate("January 14 — 7pm", "2026-10-04"), "2027-01-14", "a passed month rolls into next year");
  assert.equal(cardDate("10/20", "2026-10-04"), "2026-10-20");
  assert.equal(cardDate("no date here", "2026-10-04"), null);
  assert.equal(to24("doors 7:30 PM"), "19:30");
});

test("items: one per roster name per show, deduped against seen", () => {
  const seen = new Set();
  const venue = { name: "Cellar Room", cap: 180 };
  const rows = [{ text: "Main Room · Lou E.K. · Jo Last", url: "https://cc/1", date: "2026-10-05", time: "21:30" }];
  const a = toItems(rows, venue, roster, seen);
  assert.equal(a.length, 1);
  assert.equal(a[0].comedian, "Lou Ek");
  assert.equal(toItems(rows, venue, roster, seen).length, 0, "second pass is deduped");
  assert.equal(itemKey(a[0]), "lou ek|2026-10-05|cellar room");
  const line = pingText({ ...a[0], onsale: "on sale NOW", tags: [] });
  assert.ok(line.startsWith("🎤 Lou Ek — Cellar Room, Mon, Oct 5 21:30. on sale NOW."));
});

test("urlDate reads a machine-generated date stamp from a listing URL path", async () => {
  const { urlDate } = await import("../lib/comedy.mjs");
  assert.equal(urlDate("https://club.example.com//shows/show/13935/2026-10-04-200000-the-room"), "2026-10-04");
  assert.equal(urlDate("https://example.com/e/123456"), null);
});

// ── One item per comedian ──────────────────────────────────────────────────
// Two shows by one comedian must not go out as two pings and two pushes
// seconds apart.
// These run the real script against a temp JORI_ROOT whose bin holds
// fakes that only record their arguments: nothing is fetched or sent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RUN = fileURLToPath(new URL("../bin/comedy-club-watch-run", import.meta.url));
const ymd = (n) => { const d = new Date(Date.now() + n * 86400_000); return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(d); };

const FAKE = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const bin = path.basename(process.argv[1]), args = process.argv.slice(2);
const rec = { bin, args };
const bf = args.indexOf("--body-file"); if (bf >= 0) rec.body = fs.readFileSync(args[bf + 1], "utf8");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(rec) + "\\n");
const busy = (process.env.FAKE_BUSY_DATES || "").split(",").filter(Boolean);
const away = (process.env.FAKE_AWAY_DATES || "").split(",").filter(Boolean);
const clash = (process.env.FAKE_CLASH_DATES || "").split(",").filter(Boolean);
if (bin === "travel") process.exit(away.includes(args[2]) ? 1 : 0); // in town every night unless listed
if (bin === "headliner") process.exit(1);       // nobody is a headliner
if (bin === "calendar-conflict-check") {
  const day = args.includes("--duration-hours");
  if (!day && clash.includes(args[0])) {        // the show-time conflict check
    process.stdout.write(JSON.stringify({ conflict: true, events: [{ summary: "Dinner with friends", start: args[0] + "T19:00:00-04:00" }] }));
    process.exit(1);
  }
  const evs = day && busy.includes(args[0]) ? [{ summary: "Dinner with friends", start: args[0] + "T19:00:00-04:00" }] : [];
  process.stdout.write(JSON.stringify({ events: evs }));
  process.exit(0);
}
if (bin === "gog") {                              // the calendar read behind "seen this year"
  process.stdout.write(JSON.stringify({ events: JSON.parse(process.env.FAKE_CAL_EVENTS || "[]") }));
  process.exit(0);
}
process.exit(0);
`;

function harness({ roster, busy = [], away = [], clash = [], seen = [], cal = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccw-test-"));
  const bin = path.join(root, "bin"), data = path.join(root, "data"), local = path.join(root, "local");
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(path.join(local, "config"), { recursive: true });
  // This test's own installation config: one companion; data paths default under JORI_ROOT.
  fs.writeFileSync(path.join(local, "config", "comedy-club-watch.json"), JSON.stringify({ companions: COMP }));
  for (const b of ["travel", "headliner", "calendar-conflict-check", "jori-send-curl", "jori-notify", "email-send", "gog"]) {
    fs.writeFileSync(path.join(bin, b), FAKE, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(data, "comedy-headliners.json"), JSON.stringify({ comedians: roster }));
  if (seen.length) fs.writeFileSync(path.join(data, "comedy-sightings.json"), JSON.stringify({ sightings: seen }));
  const logFile = path.join(root, "calls.jsonl");
  const env = { ...process.env, JORI_ROOT: root, JORI_LOCAL_DIR: local, JORI_TZ: "UTC", JORI_OWNER_EMAIL: "user@example.com", FAKE_LOG: logFile, FAKE_BUSY_DATES: busy.join(","), FAKE_AWAY_DATES: away.join(","), FAKE_CLASH_DATES: clash.join(","),
    COMEDY_SEEN_GOG: path.join(bin, "gog"), FAKE_CAL_EVENTS: JSON.stringify(cal) };
  const run = (...args) => spawnSync(process.execPath, [RUN, ...args], { env, encoding: "utf8", timeout: 60_000 });
  const calls = (b) => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((c) => c.bin === b);
  const state = () => JSON.parse(fs.readFileSync(path.join(data, "comedy-club-watch-seen.json"), "utf8"));
  const ingest = (cands) => { const f = path.join(root, "cands.json"); fs.writeFileSync(f, JSON.stringify(cands)); return run("--ingest", f); };
  return { root, run, calls, state, ingest, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const COMP = [{ name: "Sam", email: "sam@example.com" }];
const PAT = { name: "Pat Rowe", taste: "neutral" }, DEM = { name: "Dee Martel", taste: "yes" }, NOR = { name: "Jim North", taste: "neutral" };
const show = (comedian, venue, d, url, cap = 300) => ({ comedian, title: `${comedian} live`, venue, cap, date: ymd(d), time: "20:00", url });

test("two shows by one comedian in one pass → one ping + one push listing both dates", () => {
  const h = harness({ roster: [PAT] });
  try {
    const r = h.ingest([show("Pat Rowe", "Hard Rock Room", 21, "https://t/pat-2"), show("Pat Rowe", "Hard Rock Room", 20, "https://t/pat-1")]);
    assert.equal(r.status, 0, r.stderr);
    const pings = h.calls("jori-send-curl"), pushes = h.calls("jori-notify");
    assert.equal(pings.length, 1, "one ping for one comedian");
    assert.equal(pushes.length, 1, "one push for one comedian");
    const msg = pings[0].args.at(-1);
    assert.ok(msg.startsWith("🎤 Pat Rowe — 2 shows at Hard Rock Room:"), msg);
    assert.ok(msg.indexOf("https://t/pat-1") < msg.indexOf("https://t/pat-2"), "shows listed by date");
    assert.equal(pushes[0].args[0], "Pat Rowe — 2 shows at Hard Rock Room");
    assert.equal(h.calls("email-send").length, 0);
    assert.deepEqual(h.state().seen.map((s) => s.surfaced), [true, true], "every show is recorded as surfaced");
  } finally { h.cleanup(); }
});

test("three shows by ONE comedian is one ping, not a '3 big comedians' email", () => {
  const h = harness({ roster: [NOR] });
  try {
    h.ingest([show("Jim North", "Cellar Room", 3, "https://cc/a"), show("Jim North", "Cellar Room", 4, "https://cc/b"), show("Jim North", "Stand Room", 10, "https://st/c")]);
    assert.equal(h.calls("email-send").length, 0);
    const pings = h.calls("jori-send-curl");
    assert.equal(pings.length, 1);
    const msg = pings[0].args.at(-1);
    assert.ok(msg.startsWith("🎤 Jim North — 3 shows:"), msg);
    assert.ok(msg.includes("Cellar Room, ") && msg.includes("Stand Room, "), "rooms named per line when they differ");
  } finally { h.cleanup(); }
});

test("the email threshold and counts are comedians, with one entry per comedian", () => {
  const h = harness({ roster: [PAT, DEM, NOR] });
  try {
    h.ingest([show("Dee Martel", "Bell Room", 45, "https://bh/1"), show("Dee Martel", "Bell Room", 46, "https://bh/2"),
      show("Pat Rowe", "Hard Rock Room", 20, "https://t/pat-1"), show("Jim North", "Cellar Room", 3, "https://cc/a")]);
    const mails = h.calls("email-send");
    assert.equal(mails.length, 1);
    assert.equal(mails[0].args[mails[0].args.indexOf("--subject") + 1], "🎤 3 big comedians in small rooms");
    assert.equal(mails[0].body.split("Dee Martel").length - 1, 1, "one entry for Dee Martel");
    assert.ok(mails[0].body.includes("https://bh/1") && mails[0].body.includes("https://bh/2"), "both of that comedian's dates are in it");
    const pointer = h.calls("jori-send-curl");
    assert.equal(pointer.length, 1);
    assert.ok(pointer[0].args.at(-1).startsWith("🎤 3 big comedians"), pointer[0].args.at(-1));
  } finally { h.cleanup(); }
});

test("a comedian's shows stay together when one of them needs the model's calendar check", () => {
  const h = harness({ roster: [PAT], busy: [ymd(20)] });
  try {
    const r = h.ingest([show("Pat Rowe", "Hard Rock Room", 20, "https://t/pat-1"), show("Pat Rowe", "Hard Rock Room", 21, "https://t/pat-2")]);
    assert.equal(h.calls("jori-send-curl").length, 0, "nothing goes out ahead of the check");
    const keys = JSON.parse(r.stdout.trim().split("\n").at(-1)).needs_check;
    assert.equal(keys.length, 2, "both shows wait for the check");
    const d = h.run("--deliver", keys[0], "--deliver", keys[1]);
    assert.equal(d.status, 0, d.stderr);
    assert.equal(h.calls("jori-send-curl").length, 1, "one --deliver call with both keys → one ping");
    const st = h.state();
    assert.equal(st.pending.length, 0);
    assert.deepEqual(st.seen.map((s) => s.surfaced), [true, true]);
  } finally { h.cleanup(); }
});

test("a single show keeps the old one-line ping and push", async () => {
  const { groupByComedian, groupText, groupNotify } = await import("../lib/comedy.mjs");
  const it = { comedian: "Lou Ek", taste: "neutral", venue: "Cellar Room", date: "2026-10-05", time: "21:30", onsale: "on sale NOW", tags: [], url: "https://cc/1" };
  const [g] = groupByComedian([it]);
  assert.equal(groupText(g), pingText(it));
  assert.equal(groupNotify(g), "Lou Ek at Cellar Room — 2026-10-05");
});

// ── D7: a clashing show is KEPT, with a note naming the clash ──────────────
// The chosen behaviour over dropping: "you already have X that night". It must
// survive the away-today rule (item 6) below.

test("D7: a show that clashes with a calendar event is kept, and the message names the clash", () => {
  const d = ymd(20);
  const h = harness({ roster: [PAT], busy: [d], clash: [d] });
  try {
    const r = h.ingest([show("Pat Rowe", "Hard Rock Room", 20, "https://t/pat-1")]);
    assert.equal(r.status, 0, r.stderr);
    const keys = JSON.parse(r.stdout.trim().split("\n").at(-1)).needs_check;
    assert.equal(keys.length, 1, "kept for the calendar check, not dropped");
    const del = h.run("--deliver", keys[0]);
    assert.equal(del.status, 0, del.stderr);
    const [ping] = h.calls("jori-send-curl");
    assert.ok(ping, "the clashing show was delivered");
    assert.ok(ping.args.at(-1).includes("⚠︎ you already have Dinner with friends that night"), ping.args.at(-1));
    assert.deepEqual(h.state().seen.map((s) => s.surfaced), [true]);
  } finally { h.cleanup(); }
});

test("D7 + item 6: away today, a clashing show on a date the user is back still goes out (by email) with its clash note", () => {
  const d = ymd(20);
  const h = harness({ roster: [PAT], busy: [d], clash: [d], away: [ymd(0)] });
  try {
    const r = h.ingest([show("Pat Rowe", "Hard Rock Room", 20, "https://t/pat-1")]);
    const keys = JSON.parse(r.stdout.trim().split("\n").at(-1)).needs_check;
    h.run("--deliver", keys[0]);
    const mails = h.calls("email-send");
    assert.equal(mails.length, 1, "away today → email");
    assert.ok(mails[0].body.includes("you already have Dinner with friends that night"), mails[0].body);
    assert.equal(h.calls("jori-send-curl").length, 0, "no chat ping while away");
    assert.equal(h.calls("jori-notify").length, 0, "no push while away");
  } finally { h.cleanup(); }
});

// ── Item 6: keep running while away, only dates the user is there ─────────

test("item 6: away today, a show on a date the user is back is sent by email only; a show on a date the user is away is not sent", () => {
  const h = harness({ roster: [PAT, DEM], away: [ymd(0), ymd(5)] });
  try {
    const r = h.ingest([show("Pat Rowe", "Hard Rock Room", 20, "https://t/pat-1"), show("Dee Martel", "Bell Room", 5, "https://bh/1")]);
    assert.equal(r.status, 0, r.stderr);
    const mails = h.calls("email-send");
    assert.equal(mails.length, 1);
    assert.ok(mails[0].body.includes("https://t/pat-1"), "the date the user is back");
    assert.ok(!mails[0].body.includes("https://bh/1"), "not the date the user is away");
    assert.equal(h.calls("jori-send-curl").length, 0);
    assert.equal(h.calls("jori-notify").length, 0);
    const seen = Object.fromEntries(h.state().seen.map((s) => [s.comedian, s]));
    assert.equal(seen["Pat Rowe"].surfaced, true);
    assert.equal(seen["Dee Martel"].surfaced, false);
    assert.equal(seen["Dee Martel"].skip_reason, "away_not_headliner");
  } finally { h.cleanup(); }
});

// ── Seen this calendar year ────────────────────────────────────────────────
// Never offer the same comedian twice in one year unless it is a new show; when
// unsure, offer it with a reminder of the last time. The calendar and the
// sightings file say what the user has seen or booked; the same night is dropped
// in code, another date goes to the Hits check (is it a new show?) carrying the
// reminder.

import { calendarSightings, repeatCheck, reminder, forComedian } from "../lib/comedy-seen.mjs";

const SROSTER = [{ name: "Nia Wolfe" }, { name: "Jim North" }, { name: "Chris Dee" }];
const calEvent = (o) => ({ id: "e1", summary: "x", status: "confirmed", start: { dateTime: "2026-11-05T01:00:00+02:00", timeZone: "America/Chicago" }, ...o });

test("seen: a ticket event with the performer in its title is a sighting, dated in the event's own zone", () => {
  const [s, ...rest] = calendarSightings([calEvent({
    summary: "Nia Wolfe at Cellar Room (Underground)", location: "The Underground, 12 Main St, Springfield",
    attendees: [{ email: "sam@example.com", responseStatus: "needsAction" }],
  })], SROSTER, { companions: COMP });
  assert.equal(rest.length, 0);
  assert.deepEqual([s.comedian, s.date, s.venue, s.with, s.source], ["Nia Wolfe", "2026-11-04", "The Underground", "Sam", "calendar"]);
});

test("seen: declined, cancelled, tentative, free, all-day and non-roster events are not sightings; a street address names no venue", () => {
  const w = "Nia Wolfe";
  const none = calendarSightings([
    calEvent({ summary: w, attendees: [{ self: true, responseStatus: "declined" }] }),
    calEvent({ summary: w, status: "cancelled" }),
    calEvent({ summary: w, status: "tentative" }),
    calEvent({ summary: w, transparency: "transparent" }),
    calEvent({ summary: w, start: { date: "2026-11-04" } }),
    calEvent({ summary: "Dinner with Dana" }),
  ], SROSTER, { companions: COMP });
  assert.deepEqual(none, []);
  const [a] = calendarSightings([calEvent({ summary: "Chris Dee at Example Comedy Club", location: "12 Main St, Springfield" })], SROSTER, { companions: COMP });
  assert.equal(a.venue, null);
  assert.equal(a.with, null, "the companion is not on that event");
});

test("seen: the same night is already booked; another date in the year is a repeat with the last time as the reminder", () => {
  const norton = [{ comedian: "Jim North", date: "2026-05-27", venue: "Cellar Room", with: "Sam" }];
  const item = (date) => ({ comedian: "Jim North", date });
  assert.equal(repeatCheck(item("2026-05-27"), norton, "2026-10-22").already_booked.date, "2026-05-27");
  const r = repeatCheck(item("2026-11-04"), norton, "2026-10-22");
  assert.equal(r.repeat.date, "2026-05-27");
  assert.equal(r.tag, "↺ you and Sam saw Jim North at Cellar Room on Wed, May 27");
  assert.deepEqual(repeatCheck(item("2027-01-14"), norton, "2026-10-22"), {}, "a different year is not a repeat");
});

test("seen: the reminder names the most recent past sighting, or the booked one when nothing is behind the user", () => {
  const two = [{ comedian: "Jim North", date: "2026-03-02", venue: "Stand Room" }, { comedian: "Jim North", date: "2026-05-27", venue: "Cellar Room", with: "Sam" }, { comedian: "Jim North", date: "2026-12-09", venue: "Big Hall" }];
  assert.equal(repeatCheck({ comedian: "Jim North", date: "2026-11-04" }, two, "2026-10-22").repeat.date, "2026-05-27");
  const booked = [{ comedian: "Nia Wolfe", date: "2026-11-04", venue: "The Underground", with: "Sam" }];
  assert.equal(repeatCheck({ comedian: "Nia Wolfe", date: "2026-12-02" }, booked, "2026-10-22").tag,
    "↺ you and Sam already have tickets to Nia Wolfe at The Underground on Wed, Nov 4");
  assert.equal(reminder({ date: "2026-09-09" }, "Chris Dee", "2026-10-22"), "↺ you saw Chris Dee on Wed, Sep 9");
});

test("seen: sightings are matched to a roster entry by name or aka, not by spelling luck", () => {
  const entry = { name: "Lou Ek", aka: ["Lou E.K."] };
  const all = [{ comedian: "Lou E.K.", date: "2026-02-01" }, { comedian: "Jim North", date: "2026-02-02" }];
  assert.deepEqual(forComedian(entry, all).map((s) => s.date), ["2026-02-01"]);
});

const yearOf = (d) => d.slice(0, 4);
const earlierSameYear = (d) => `${yearOf(d)}-01-0${d === `${yearOf(d)}-01-01` ? 2 : 1}`;

test("seen: a comedian the user saw earlier this year waits for the Hits check, with the reminder attached; nothing goes out ahead of it", () => {
  const d = ymd(20), earlier = earlierSameYear(d);
  const h = harness({ roster: [NOR], seen: [{ comedian: "Jim North", date: earlier, venue: "Cellar Room", with: "Sam", source: "manual" }] });
  try {
    const r = h.ingest([show("Jim North", "Cellar Room", 20, "https://cc/nov")]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(h.calls("jori-send-curl").length + h.calls("email-send").length, 0, "no ping before the check");
    const keys = JSON.parse(r.stdout.trim().split("\n").at(-1)).needs_check;
    assert.equal(keys.length, 1);
    const [p] = JSON.parse(h.run("--pending").stdout);
    assert.equal(p.repeat.date, earlier);
    assert.ok(p.tags.some((t) => t.startsWith("↺ you and Sam ")), JSON.stringify(p.tags));
    assert.ok(p.listing.includes("Jim North live"), "the listing text rides along for the new-show read");
    // The Hits check calls it a new show → it goes out, carrying the reminder.
    assert.equal(h.run("--deliver", keys[0]).status, 0);
    const [ping] = h.calls("jori-send-curl");
    assert.ok(ping.args.at(-1).includes("↺ you and Sam "), ping.args.at(-1));
    assert.deepEqual(h.state().seen.map((s) => s.surfaced), [true]);
  } finally { h.cleanup(); }
});

test("seen: the Hits check can skip a repeat as the same material, and the state says why", () => {
  const d = ymd(20);
  const h = harness({ roster: [NOR], seen: [{ comedian: "Jim North", date: earlierSameYear(d), venue: "Cellar Room", source: "manual" }] });
  try {
    const keys = JSON.parse(h.ingest([show("Jim North", "Cellar Room", 20, "https://cc/nov")]).stdout.trim().split("\n").at(-1)).needs_check;
    assert.equal(h.run("--skip", keys[0], "--reason", "seen_this_year").status, 0);
    const [s] = h.state().seen;
    assert.equal(s.surfaced, false);
    assert.equal(s.skip_reason, "seen_this_year");
    assert.equal(h.calls("jori-send-curl").length, 0);
  } finally { h.cleanup(); }
});

test("seen: a show on the night the user is already going is dropped in code, not sent and not asked about", () => {
  const d = ymd(20);
  const h = harness({ roster: [NOR], seen: [{ comedian: "Jim North", date: d, venue: "Stand Room", source: "manual" }] });
  try {
    const r = h.ingest([show("Jim North", "Cellar Room", 20, "https://cc/same-night")]);
    assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").at(-1)).needs_check, []);
    assert.equal(h.calls("jori-send-curl").length + h.calls("email-send").length, 0);
    const st = h.state();
    assert.equal(st.pending.length, 0);
    assert.deepEqual(st.seen.map((s) => [s.surfaced, s.skip_reason]), [[false, "already_booked"]]);
  } finally { h.cleanup(); }
});

test("seen: a hold (\"let's wait a year\") drops every listing up to its date, new show or not, and lapses after it", () => {
  const north = [{ comedian: "Jim North", date: "2026-05-27", venue: "Example Club", with: "Sam", hold_until: "2027-05-27" }];
  assert.equal(repeatCheck({ comedian: "Jim North", date: "2026-11-11" }, north, "2026-10-29").held.date, "2026-05-27");
  assert.equal(repeatCheck({ comedian: "Jim North", date: "2027-05-27" }, north, "2026-10-29").held.date, "2026-05-27");
  assert.deepEqual(repeatCheck({ comedian: "Jim North", date: "2027-06-03" }, north, "2026-10-29"), {}, "after the hold it is offered again");
});

test("seen: a held comedian is dropped in code, not sent and not asked about", () => {
  const d = ymd(20);
  const h = harness({ roster: [NOR], seen: [{ comedian: "Jim North", date: earlierSameYear(d), venue: "Example Club", source: "manual", hold_until: ymd(300) }] });
  try {
    const r = h.ingest([show("Jim North", "Example Club", 20, "https://club.example/held")]);
    assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").at(-1)).needs_check, []);
    assert.equal(h.calls("jori-send-curl").length + h.calls("email-send").length, 0);
    assert.deepEqual(h.state().seen.map((s) => [s.surfaced, s.skip_reason]), [[false, "held"]]);
  } finally { h.cleanup(); }
});

test("seen: a sighting last year does not hold a comedian back this year", () => {
  const d = ymd(20);
  const h = harness({ roster: [NOR], seen: [{ comedian: "Jim North", date: `${Number(yearOf(d)) - 1}-06-01`, venue: "Cellar Room", source: "manual" }] });
  try {
    h.ingest([show("Jim North", "Cellar Room", 20, "https://cc/nov")]);
    const [ping] = h.calls("jori-send-curl");
    assert.ok(ping, "sent straight away");
    assert.ok(!ping.args.at(-1).includes("↺"), ping.args.at(-1));
  } finally { h.cleanup(); }
});

test("seen: a booking that is only on the calendar (performer in the title) counts, and a declined one does not", () => {
  const d = ymd(20), earlier = earlierSameYear(d);
  const start = { dateTime: `${earlier}T19:00:00Z`, timeZone: "UTC" };
  const booked = harness({ roster: [NOR], cal: [{ id: "c1", summary: "Jim North at Stand Room", status: "confirmed", start }] });
  const declined = harness({ roster: [NOR], cal: [{ id: "c2", summary: "Jim North at Stand Room", status: "confirmed", start, attendees: [{ self: true, responseStatus: "declined" }] }] });
  try {
    assert.equal(JSON.parse(booked.ingest([show("Jim North", "Cellar Room", 20, "https://cc/a")]).stdout.trim().split("\n").at(-1)).needs_check.length, 1);
    declined.ingest([show("Jim North", "Cellar Room", 20, "https://cc/a")]);
    assert.equal(declined.calls("jori-send-curl").length, 1, "a declined event is not a sighting");
  } finally { booked.cleanup(); declined.cleanup(); }
});

// ── Off without config ─────────────────────────────────────────────────────

test("no rooms configured: a scheduled run does nothing — no fetch, no dispatch, no state", () => {
  const h = harness({ roster: [NOR] });
  try {
    const r = h.run("--scheduled");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("no rooms configured"), r.stdout);
    assert.ok(!fs.existsSync(path.join(h.root, "data", "comedy-club-watch-seen.json")), "no state written");
  } finally { h.cleanup(); }
});

test("comedian: the roster CLI reads the configured roster file, and an empty install has none", () => {
  const COMEDIAN = fileURLToPath(new URL("../bin/comedian", import.meta.url));
  const h = harness({ roster: [NOR] });
  try {
    const env = { ...process.env, JORI_ROOT: h.root, JORI_LOCAL_DIR: path.join(h.root, "local") };
    const hit = spawnSync(process.execPath, [COMEDIAN, "check", "An Evening with Jim North"], { env, encoding: "utf8" });
    assert.equal(hit.status, 0, hit.stderr);
    assert.equal(JSON.parse(hit.stdout).name, "Jim North");
    fs.rmSync(path.join(h.root, "data", "comedy-headliners.json"));
    assert.equal(spawnSync(process.execPath, [COMEDIAN, "check", "Jim North"], { env, encoding: "utf8" }).status, 1);
  } finally { h.cleanup(); }
});

test("a venue-events kind's rows become listing rows the roster can match", async () => {
  const { rowsFromEvents } = await import("../bin/comedy-club-watch-run");
  const [r, s] = rowsFromEvents([
    { title: "Late Show · Lou E.K.", performers: ["Lou E.K.", "Jo Last"], date: "2026-10-05", time: "21:30", url: "https://x/1", venue: "Cellar Room", status: null },
    { title: "Mod: Live", performers: [], date: "2026-10-06", url: "https://x/2", venue: "Some Bar", status: "soldout" },
  ]);
  assert.equal(r.text, "Late Show · Lou E.K. · Jo Last", "a name the title already carries is not repeated");
  assert.deepEqual(rosterHits(r.text, roster).map((c) => c.name), ["Lou Ek"]);
  assert.equal(s.availability, "SoldOut");
  assert.equal(onsalePhrase(s.availability), "SOLD OUT — resale only");
  assert.equal(s.venue, "Some Bar", "an aggregator row keeps its own room");
});
