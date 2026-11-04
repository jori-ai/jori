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
  ticketAction, dropPauses, openStore, recordTicket, mentionsTitle, quoted,
  performanceDate, validateScan, scanSchema, clipText, pruneSeen, TICKET_KINDS,
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

// ── Tickets: purchases, lottery tickets, surveys ──────────────────────────

test("ticket kinds: bought, paid lottery tickets or attended retire now, a win alone changes nothing", () => {
  assert.equal(ticketAction({ kind: "attended" }), "retire");
  assert.equal(ticketAction({ kind: "purchase", date: "2026-12-01" }), "retire", "a purchase the user made retires at once, even for a later date");
  assert.equal(ticketAction({ kind: "lottery_purchase", date: "2026-11-05" }), "retire", "paid lottery tickets retire at once too, not after the show");
  assert.equal(ticketAction({ kind: "lottery_purchase" }), "retire", "date unknown");
  assert.equal(ticketAction({ kind: "won", date: "2026-11-01" }), "none");
  assert.equal(ticketAction({ kind: "none" }), "none");
  assert.deepEqual(TICKET_KINDS, ["purchase", "lottery_purchase", "attended", "won", "none"]);
});

test("retirement drops every pause for the show", () => {
  const p = { entries: [{ show: "Hey, Larry!", paused_until: "2026-11-10", removed: true }, { show: "Night of the Tester", paused_until: "2026-11-04", removed: true }] };
  assert.deepEqual(dropPauses(p, "hey larry").pauses.entries.map((e) => e.show), ["Night of the Tester"]);
  assert.equal(dropPauses(p, "Some Show").changed, false);
});

/** A throwaway store: the three files under a temp dir. */
async function tmpStore(list, pauses = null, ledger = null) {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-tickets-"));
  const cfg = { shows_file: path.join(dir, "shows.json"), files: { pauses: path.join(dir, "pauses.json"), tickets: path.join(dir, "tickets.json") } };
  fs.writeFileSync(cfg.shows_file, JSON.stringify(list));
  if (pauses) fs.writeFileSync(cfg.files.pauses, JSON.stringify(pauses));
  if (ledger) fs.writeFileSync(cfg.files.tickets, JSON.stringify(ledger));
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
  return { cfg, read: () => ({ list: read(cfg.shows_file), pauses: read(cfg.files.pauses), ledger: read(cfg.files.tickets) }), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("recordTicket: a purchase retires the show and drops its pause; the same email again is a duplicate", async () => {
  const t = await tmpStore({ shows: [{ title: "The Tester Returns" }, { title: "Hey, Larry!" }], retired: [] }, { entries: [{ show: "The Tester Returns", paused_until: "2026-04-27", removed: true }] });
  try {
    let st = openStore(t.cfg);
    const r = recordTicket(st, { show: "tester returns", kind: "purchase", date: "2026-04-21", message_id: "m1", source: "mail scan" }, "2026-04-20");
    st.save();
    assert.equal(r.result, "retired");
    let f = t.read();
    assert.deepEqual(f.list.shows.map((s) => s.title), ["Hey, Larry!"]);
    assert.deepEqual(f.list.retired[0], { title: "The Tester Returns", reason: "bought tickets for 2026-04-21 (mail scan)", date: "2026-04-20" });
    assert.deepEqual(f.pauses.entries, []);
    assert.equal(f.ledger.records.length, 1);
    st = openStore(t.cfg);
    assert.equal(recordTicket(st, { show: "The Tester Returns", kind: "purchase", message_id: "m1" }, "2026-04-20").result, "duplicate");
    assert.equal(recordTicket(st, { show: "The Tester Returns", kind: "attended", message_id: "m2" }, "2026-04-22").result, "already-retired");
  } finally { t.done(); }
});

test("recordTicket: paid lottery tickets retire the show at once, with the old pause dropped", async () => {
  const t = await tmpStore({ shows: [{ title: "Hey, Larry!" }, { title: "Night of the Tester" }], retired: [] }, { entries: [{ show: "Hey, Larry!", paused_until: "2026-11-10", removed: true }] });
  try {
    const st = openStore(t.cfg);
    assert.equal(recordTicket(st, { show: "Hey, Larry!", kind: "lottery_purchase", date: "2026-11-05", message_id: "w1" }, "2026-11-03").result, "retired");
    st.save();
    const f = t.read();
    assert.deepEqual(f.list.shows.map((s) => s.title), ["Night of the Tester"]);
    assert.match(f.list.retired[0].reason, /won \+ bought tickets for 2026-11-05/);
    assert.deepEqual(f.pauses.entries, []);
    assert.equal(f.ledger.records[0].result, "retired");
  } finally { t.done(); }
});

test("recordTicket: a lottery win nobody paid for changes nothing", async () => {
  const t = await tmpStore({ shows: [{ title: "Some Show: The Sequel" }], retired: [] });
  try {
    const st = openStore(t.cfg);
    const r = recordTicket(st, { show: "Some Show: The Sequel", kind: "won", date: "2026-06-16", message_id: "x" }, "2026-06-16");
    st.save();
    assert.equal(r.result, "noted");
    const f = t.read();
    assert.deepEqual(f.list.shows.map((s) => s.title), ["Some Show: The Sequel"]);
    assert.equal(f.pauses, null, "no pause written");
  } finally { t.done(); }
});

test("grounding: titles and quotes must come from the email itself", () => {
  assert.ok(mentionsTitle("What did you think of The Tester Returns?", "The Tester Returns"));
  assert.ok(mentionsTitle("Here are your Night of the Tester: A New Musical tickets", "Night of the Tester"));
  assert.ok(mentionsTitle("HEY, LARRY! (NY) May 1, 2026, 2:00 pm: Lottery Results - YOU WON!", "Hey, Larry!"));
  assert.ok(mentionsTitle("Your & Tester tickets", "& Tester"));
  assert.ok(!mentionsTitle("Larry layers your agent has to handle", "Larry Lives"));
  assert.ok(!mentionsTitle("Testerville festival", "Tester"));
  assert.ok(quoted("Thank you for your purchase,  please keep this email", "thank you for your PURCHASE, please"));
  assert.ok(!quoted("Thank you for your purchase", "thanks for buying"));
  assert.ok(!quoted("anything", ""));
  assert.ok(quoted("you\u2019ve been chosen as a winner \u2014 pay now", "You've been chosen as a winner - pay"), "curly quotes and dashes match their plain forms");
  assert.equal(performanceDate("2026-11-05", "2026-11-03"), "2026-11-05");
  assert.equal(performanceDate("Nov 5", "2026-11-03"), null);
  assert.equal(performanceDate("2029-11-05", "2026-11-03"), null, "more than a year off");
  assert.equal(clipText("you&rsquo;ve  been\n chosen &amp; more"), "you’ve been chosen & more");
});

test("validateScan keeps grounded answers and refuses the rest", () => {
  const titles = ["The Tester Returns", "Hey, Larry!", "Night of the Tester"];
  const batch = [
    { id: "a", subject: "What did you think of The Tester Returns?", text: "" },
    { id: "b", subject: "Ticket Purchase Confirmation", text: "Hi, The Tester Returns Monday, April 20, 2026 at 7:00 PM Thank you for your purchase" },
    { id: "c", subject: "See a Show While the Price Is Low", text: "Night of the Tester and more this fall" },
    { id: "d", subject: "HEY, LARRY! (NY) May 1, 2026: Lottery Results - YOU WON!", text: "complete your purchase" },
    { id: "e", subject: "Your results", text: "nothing to see" },
  ];
  const answer = { items: [
    { id: "a", kind: "attended", show: "The Tester Returns", performance_date: "", evidence: "What did you think of The Tester Returns?" },
    { id: "b", kind: "lottery_purchase", show: "The Tester Returns", performance_date: "2026-04-20", evidence: "Thank you for your purchase" },
    { id: "c", kind: "purchase", show: "Night of the Tester", performance_date: "", evidence: "you bought Night of the Tester tickets" },
    { id: "d", kind: "won", show: "Night of the Tester", performance_date: "2026-05-01", evidence: "YOU WON!" },
    { id: "e", kind: "none", show: "none", performance_date: "", evidence: "" },
    { id: "zz", kind: "purchase", show: "Hey, Larry!", performance_date: "", evidence: "x" },
    { id: "a", kind: "purchase", show: "Hey, Larry!", performance_date: "", evidence: "x" },
  ] };
  const { ok, bad } = validateScan(answer, batch, titles, "2026-05-03");
  assert.deepEqual(ok.map((o) => [o.id, o.kind, o.show, o.date]), [
    ["a", "attended", "The Tester Returns", null],
    ["b", "lottery_purchase", "The Tester Returns", "2026-04-20"],
    ["e", "none", null, null],
  ]);
  assert.deepEqual(bad, ["c", "d"], "c quotes words the email does not contain; d names a show the email does not");
  const sch = scanSchema(titles);
  assert.deepEqual(sch.properties.items.items.properties.show.enum, [...titles, "none"]);
});

test("pruneSeen forgets old message ids only", () => {
  const L = { seen: { old: { at: "2026-05-01" }, recent: { at: "2026-10-30" } } };
  pruneSeen(L, "2026-11-03");
  assert.deepEqual(Object.keys(L.seen), ["recent"]);
});
