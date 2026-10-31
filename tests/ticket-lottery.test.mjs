// ticket-lottery.test.mjs — fixtures for the parsers the ticket lottery and
// day-of rush scripts depend on (lib/ticket-lottery.mjs). A platform format
// drift must fail here, not silently enter nothing at the next entry window.
//
// Run: node --test tests/ticket-lottery.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normTitle, sameTitle, matchShow, parseLongDate, parseSlashDate, parseStamp, pauseAllMode,
  activePauses, verifyLink, quantityRequested, receivedMatches, entryKey, doneKeys, lotteryConfig,
} from "../lib/ticket-lottery.mjs";
import { parsePayload } from "../lib/gmail-parsed.mjs";

// A synthetic curated list with the shapes a real one has (an alias-free
// active list, a retired list, a title that only matches by prefix).
const curated = {
  shows: [{ title: "Night of the Tester" }, { title: "Hey, Larry!" }, { title: "SIX" }, { title: "Some Show: The Sequel" }],
  retired: [{ title: "Wicked", reason: "seen", date: "2026-01-01" }],
};

test("titles: platform listing shapes match the curated list", () => {
  assert.equal(normTitle("STRANGER THINGS (NY)"), "stranger things");
  assert.equal(normTitle("& Juliet"), "and juliet");
  assert.ok(sameTitle("Stranger Things", "Stranger Things: The First Shadow"));
  assert.ok(sameTitle("SIX the Musical", "SIX"));
  assert.ok(sameTitle("HEY, LARRY!", "Hey, Larry!"));
  assert.ok(sameTitle("The Great Gatsby", "GREAT GATSBY"));
  assert.ok(!sameTitle("Chicago", "Chicagoland"));
  assert.ok(!sameTitle("Proof", "Proofreading Live"));
  assert.equal(matchShow("NIGHT OF THE TESTER", curated.shows)?.title, "Night of the Tester");
  assert.equal(matchShow("ALADDIN (NY)", curated.shows), null);
  assert.equal(matchShow("WICKED", curated.shows), null, "retired shows are not targets");
  assert.equal(matchShow("WICKED", curated.retired)?.title, "Wicked");
});

test("curated list: no title is both active and retired", () => {
  for (const s of curated.shows) assert.equal(matchShow(s.title, curated.retired), null, s.title);
});

test("dates: long and slash stamps", () => {
  assert.deepEqual(parseLongDate("Wednesday, May 27, 2026 at 7:00PM"), { date: "2026-05-27", time: "19:00" });
  assert.deepEqual(parseLongDate("Saturday, May 09, 2026 at 2:00PM"), { date: "2026-05-09", time: "14:00" });
  assert.deepEqual(parseLongDate("Tuesday, September 15, 2026 at 12:00AM"), { date: "2026-09-15", time: "00:00" });
  assert.equal(parseLongDate(""), null);
  assert.deepEqual(parseSlashDate("ENTER NOW FOR ALADDIN (NY) ON 05/27/26, 7:00 PM"), { date: "2026-05-27", time: "19:00" });
  assert.deepEqual(parseSlashDate("ENTER NOW FOR SIX ON 10/4/26, 2:00 PM"), { date: "2026-10-04", time: "14:00" });
  assert.deepEqual(parseStamp("10/4/26, 2:00 PM", "slash"), { date: "2026-10-04", time: "14:00" });
  assert.deepEqual(parseStamp("Sunday, October 4, 2026 at 2:00PM", "long"), { date: "2026-10-04", time: "14:00" });
});

test("pause-all: only a weekly-cap reason is exemptible", () => {
  const ex = ["Hey, Larry!"];
  assert.equal(pauseAllMode(null, "2026-10-04", ex), "none");
  assert.equal(pauseAllMode({ paused_until: "2026-10-01" }, "2026-10-04", ex), "expired");
  assert.equal(pauseAllMode({ paused_until: "2026-10-10", reason: "weekly cap — bought X" }, "2026-10-04", ex), "exempt-only");
  assert.equal(pauseAllMode({ paused_until: "2026-10-10", reason: "weekly cap — bought X" }, "2026-10-04", []), "all");
  assert.equal(pauseAllMode({ paused_until: "2026-10-10", reason: "travel" }, "2026-10-04", ex), "all");
  assert.equal(pauseAllMode({ paused_until: "2026-10-04", reason: "travel" }, "2026-10-04", ex), "all", "paused_until is inclusive");
});

test("per-show pauses: expired entries drop, removed ones block", () => {
  const r = activePauses({ entries: [
    { show: "Chicago", removed: true, paused_until: "2026-10-09" },
    { show: "Proof", removed: true, paused_until: "2026-10-01" },
  ] }, "2026-10-04");
  assert.deepEqual(r.active, ["Chicago"]);
  assert.equal(r.kept.length, 1);
  assert.ok(r.changed);
});

test("confirm email: verify link survives, wrong perfId is ignored", () => {
  const body = "Click to Confirm Your Email Address\nhttps://lottery.example.com/enter-lottery/?entry=55123&lottery=1088924&verification_code=abc123&action=verify\nThanks";
  assert.equal(verifyLink(body, 1088924), "https://lottery.example.com/enter-lottery/?entry=55123&lottery=1088924&verification_code=abc123&action=verify");
  assert.equal(verifyLink(body, 999), null);
  // HTML-only message: the link lives in an href
  const html = Buffer.from('<p><a href="https://lottery.example.com/enter-lottery/?entry=1&amp;lottery=42&amp;verification_code=z&amp;action=verify">Click to Confirm</a></p>').toString("base64url");
  const parsed = parsePayload({ mimeType: "text/html", body: { data: html }, headers: [{ name: "Subject", value: "Action Required" }] });
  assert.ok(verifyLink(parsed.hrefs.join("\n"), 42));
});

test("entry-received email (verified address path)", () => {
  const subj = "THE LOST BOYS 06/10/26, 2:00 PM: Lottery Entry Received";
  assert.ok(receivedMatches(subj, { show: "The Lost Boys", date: "2026-06-10" }));
  assert.ok(!receivedMatches(subj, { show: "The Lost Boys", date: "2026-06-11" }));
  assert.ok(!receivedMatches(subj, { show: "SIX", date: "2026-06-10" }));
  assert.equal(quantityRequested("WE'VE GOT YOUR ENTRY\nQuantity Requested: 2\nTotal: $90"), 2);
});

test("day-of rush: curated, non-lottery, not already pinged today", async () => {
  const { newDrops, message } = await import("../bin/ticket-rush-run");
  const drops = newDrops([
    { title: "SIX", url: "https://tt/six", priceFrom: 45, isLottery: false },
    { title: "Wicked", url: "https://tt/w", isLottery: false },
    { title: "Chicago", url: "https://tt/c", isLottery: false },
    { title: "Proof", url: "https://tt/p", isLottery: true },
  ], [...curated.shows, { title: "Chicago" }], [{ show: "Chicago", date: "2026-10-04" }], "2026-10-04");
  assert.deepEqual(drops.map((d) => d.show), ["SIX"]);
  assert.equal(message(drops, "RushApp"), "🎟️ Rush tickets just showed up for today:\n\n• SIX — today, from $45\nhttps://tt/six\n\nTap a link to grab them on RushApp.");
});

test("duplicate guard is per (show, date, platform, entrant); missing entrant = the owner", () => {
  const state = { entries: [
    { show: "Hey, Larry!", date: "2026-10-05", platform: "alpha", status: "submitted" },
    { show: "Chicago", date: "2026-10-05", platform: "alpha", status: "conflict" },
  ] };
  const keys = doneKeys(state, "owner1");
  assert.ok(keys.has(entryKey({ show: "HEY, LARRY!", date: "2026-10-05", platform: "alpha", entrant: "owner1" }, "owner1")));
  assert.ok(!keys.has(entryKey({ show: "Hey, Larry!", date: "2026-10-05", platform: "alpha", entrant: "friend" }, "owner1")));
  assert.ok(!keys.has(entryKey({ show: "Chicago", date: "2026-10-05", platform: "alpha" }, "owner1")), "a conflict row does not block a later entry");
});

test("config: a fresh install has no platforms and no rush source (off)", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const prev = process.env.JORI_LOCAL_DIR;
  process.env.JORI_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tl-cfg-"));
  try {
    const c = lotteryConfig();
    assert.deepEqual(c.platforms, {});
    assert.equal(c.rush, null);
    assert.ok(path.isAbsolute(c.files.state) && path.isAbsolute(c.shows_file));
  } finally { if (prev === undefined) delete process.env.JORI_LOCAL_DIR; else process.env.JORI_LOCAL_DIR = prev; }
});
