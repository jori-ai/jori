// daily-summary-commits.test.mjs — the day's commits ship in their own section,
// in plain language, grouped by time of day (the user, 2026-10-21: "commits
// should be included in plain language in the daily summary ... based on the
// time of day").
//
// Run: node --test tests/daily-summary-commits.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { dayCommits, commitLines, partOf, routineTags } = require(path.join(ROOT, "lib/daily-summary-commits.js"));
const { buildSkeleton, buildMarkdown, assemble } = require(path.join(ROOT, "lib/daily-summary-render.js"));

const NY = "America/New_York";
// Real subjects from 2026-10-20/21. 13:05Z = 9:05am EDT, 17:40Z = 1:40pm, 23:10Z = 7:10pm, 05:30Z(+1) = 1:30am.
const RAW = [
  { sha: "7d99881d", at: "2026-10-20T13:05:00Z", subject: "awardwallet-sync: weekly miles & points snapshot into loyalty_accounts, next to the bank tables" },
  { sha: "843b424b", at: "2026-10-20T13:40:00Z", subject: "awardwallet-sync: warn on disconnect, including the silent kind (no AwardWallet read in 21 days)" },
  { sha: "14da6aba", at: "2026-10-20T17:40:00Z", subject: "site-pass: skip masked saved usernames; pin United to the FY892488 MileagePlus login" },
  { sha: "7d7c625a", at: "2026-10-20T23:10:00Z", subject: "self-improve: apply owner-approved fix (Face-ID) — Jev call-held" },
  { sha: "411587d2", at: "2026-10-21T03:30:00Z", subject: "awardwallet: refresh via the extension in the mini's Chrome before syncing" },
];

test("parts of the day by local hour", () => {
  assert.equal(partOf("01:30"), "night");
  assert.equal(partOf("05:00"), "morning");
  assert.equal(partOf("11:59"), "morning");
  assert.equal(partOf("12:00"), "afternoon");
  assert.equal(partOf("17:00"), "evening");
  assert.equal(partOf("23:59"), "evening");
});

test("commits get the local clock and part of the day, chronologically", () => {
  const c = dayCommits([...RAW].reverse(), [], NY);
  assert.deepEqual(c.map((x) => [x.sha, x.local, x.part]), [
    ["7d99881d", "09:05", "morning"], ["843b424b", "09:40", "morning"], ["14da6aba", "13:40", "afternoon"],
    ["7d7c625a", "19:10", "evening"], ["411587d2", "23:30", "evening"],
  ]);
});

test("a written line covers several commits and sits at the earliest; an uncovered commit falls back to its subject", () => {
  const c = dayCommits(RAW, [], NY);
  const written = [
    { shas: ["843b424b", "7d99881d"], text: "Your airline miles and hotel points now get a weekly snapshot, with a warning if AwardWallet goes quiet." },
    { shas: ["14da6aba"], text: "Logging in to United now picks the right MileagePlus account." },
    { shas: ["deadbeef"], text: "Invented work that no commit backs." },
  ];
  const { parts, uncovered } = commitLines(c, written);
  assert.deepEqual(parts.map((p) => p.label), ["Morning", "Afternoon", "Evening"]);
  assert.equal(parts[0].lines.length, 1);
  assert.equal(parts[0].lines[0].time, "09:05");
  assert.deepEqual(parts[0].lines[0].shas, ["7d99881d", "843b424b"]);
  assert.deepEqual(uncovered, ["7d7c625a", "411587d2"]);
  assert.equal(parts[2].lines[0].plain, false);
  assert.ok(!JSON.stringify(parts).includes("Invented work"));
});

test("long and short shas match", () => {
  const c = dayCommits(RAW, [], NY);
  const { uncovered } = commitLines(c, [{ shas: ["411587d2aa11"], text: "x" }]);
  assert.ok(!uncovered.includes("411587d2"));
});

// Two stops: home 8:30am-12:30pm, a café 2:00pm-6:00pm (EDT). 1:40pm lands on the
// walk between them; 7:10pm and 11:30pm land after the user left the café.
const STOPS = [
  { id: "s1", start: "08:30", end: "12:30", start_ts_ms: Date.parse("2026-10-20T12:30:00Z"), end_ts_ms: Date.parse("2026-10-20T16:30:00Z"),
    duration_min: 240, place: { name: "Home A" }, title: "Home A", title_certainty: "answered", provenance: { tier: "CONFIRMED" } },
  { id: "s2", start: "14:00", end: "18:00", start_ts_ms: Date.parse("2026-10-20T18:00:00Z"), end_ts_ms: Date.parse("2026-10-20T22:00:00Z"),
    duration_min: 240, place: { name: "Café Grumpy" }, title: "Café Grumpy", title_certainty: "answered", provenance: { tier: "CONFIRMED" } },
];

test("each commit belongs to the stop he was at, or the one he walked away from", () => {
  const c = dayCommits(RAW, STOPS, NY);
  assert.deepEqual(c.map((x) => [x.sha, x.stop_id]), [
    ["7d99881d", "s1"], ["843b424b", "s1"], ["14da6aba", "s1"], ["7d7c625a", "s2"], ["411587d2", "s2"],
  ]);
  // Before the first stop it belongs to no stop: a diary never lists an event
  // under a header that starts later (the user, 2026-10-22).
  const early = dayCommits([{ sha: "aaaaaaa1", at: "2026-10-20T06:00:00Z", subject: "x" }], STOPS, NY);
  assert.equal(early[0].stop_id, null);
  assert.equal(early[0].pre, "before_stop");
});

test("the email lists the work under each stop, in plain language, with no separate section", () => {
  const day = { date: "2026-10-20", tz: NY, tzs: [NY], stops: STOPS, travel_legs: [], commits: dayCommits(RAW, STOPS, NY) };
  const prose = { commits: [{ shas: ["7d99881d", "843b424b"], text: "You set up a weekly snapshot of your miles and points." }] };
  const html = assemble(buildSkeleton(day, {}), prose);
  assert.ok(!html.includes("{{"));
  assert.ok(!html.includes("What you worked on"));
  const [, home, cafe] = html.split("<h3");
  assert.ok(home.includes("<b>9:05am</b> You set up a weekly snapshot of your miles and points."), "the 9:05am work sits under the first stop");
  assert.ok(home.includes("<b>1:40pm</b>"), "the commit that landed on the walk sits under the stop he left");
  assert.ok(cafe.includes("<b>7:10pm</b>"), "the 7:10pm commit sits under the café");
  const md = buildMarkdown(day, prose);
  assert.ok(!md.includes("## What you worked on"));
  const [, mdHome] = md.split("### ");
  assert.ok(mdHome.includes("- **09:05** You set up a weekly snapshot"));
});

test("a day with no stops still lists the work, by time of day; a failed git read says so", () => {
  const day = { date: "2026-10-20", tz: NY, tzs: [NY], stops: [], travel_legs: [], commits: dayCommits(RAW, [], NY) };
  const html = assemble(buildSkeleton(day, {}), {});
  assert.ok(html.includes("What you worked on"));
  assert.ok(html.includes("Afternoon"));
  const none = { ...day, commits: [] };
  assert.ok(!assemble(buildSkeleton(none, {}), {}).includes("What you worked on"));
  assert.ok(assemble(buildSkeleton({ ...none, commits_error: "git exit 128" }, {}), {}).includes("Couldn't read the day's commits"));
});

// ---- 2026-10-22: before the first stop, and Jori's own routine work ----

// The Oct 21 shape: slept 22:58Z-05:53Z (1:58am-8:53am Jerusalem), first stop 09:04 local.
const JLM = "Asia/Jerusalem";
const NIGHT = { onset_at: "2026-10-20T22:58:14Z", wake_at: "2026-10-21T05:53:02Z" };
const FIRST = { id: "j1", start: "09:04", end: "10:16", start_ts_ms: Date.parse("2026-10-21T06:04:45Z"), end_ts_ms: Date.parse("2026-10-21T07:16:00Z"),
  duration_min: 72, place: { name: "Café Example" }, title: "Café Example", title_certainty: "answered", provenance: { tier: "CONFIRMED" } };
const SECOND = { id: "j2", start: "10:30", end: "11:00", start_ts_ms: Date.parse("2026-10-21T07:30:00Z"), end_ts_ms: Date.parse("2026-10-21T08:00:00Z"),
  duration_min: 30, place: { name: "Hilton Seaside City" }, title: "Hilton Seaside City", title_certainty: "answered", provenance: { tier: "CONFIRMED" } };
const OVERNIGHT = [
  { sha: "896ad693", at: "2026-10-20T22:17:09Z", subject: "purchase: read texted codes from attributedBody, 1Password-only logins" },
  { sha: "f2181d45", at: "2026-10-21T01:23:23Z", subject: "[auto-impl] The daily summary's walk line no longer says 'the phone lost you for N min'" },
  { sha: "4472a5d5", at: "2026-10-21T08:34:12Z", subject: "logins-import-apple: copy a login from Apple Passwords into the 1Password Logins vault" },
];

test("commits before the first stop are grouped by the Watch's night, never put under that stop", () => {
  const c = dayCommits(OVERNIGHT, [FIRST, SECOND], JLM, [FIRST, SECOND], { night: NIGHT });
  assert.deepEqual(c.map((x) => [x.sha, x.local, x.stop_id, x.pre]), [
    ["896ad693", "01:17", null, "before_sleep"],
    ["f2181d45", "04:23", null, "asleep"],
    ["4472a5d5", "11:34", "j2", null],
  ]);
  // No Watch night -> no claim that the user was asleep.
  const noNight = dayCommits(OVERNIGHT, [FIRST, SECOND], JLM, [FIRST, SECOND]);
  assert.deepEqual(noNight.slice(0, 2).map((x) => x.pre), ["before_stop", "before_stop"]);
  // A day with no stop has nowhere to place them ahead of: they stay in the by-part list.
  assert.deepEqual(dayCommits(OVERNIGHT, [], JLM).map((x) => x.pre), [null, null, null]);
});

test("the email and the wiki page put pre-stop work in its own section ahead of the first stop", () => {
  const commits = dayCommits(OVERNIGHT, [FIRST, SECOND], JLM, [FIRST, SECOND], { night: NIGHT });
  const day = { date: "2026-10-21", tz: JLM, tzs: [JLM], stops: [FIRST, SECOND], travel_legs: [], commits };
  const prose = { commits: [
    { shas: ["896ad693"], text: "You taught the shopping assistant to read texted codes." },
    { shas: ["f2181d45"], text: "Jori tidied the summary's walk lines." },
  ] };
  const html = assemble(buildSkeleton(day, {}), prose);
  assert.ok(!html.includes("{{"));
  const iBefore = html.indexOf("Before you went to sleep"), iAsleep = html.indexOf("While you slept"), iStop = html.indexOf("<h3");
  assert.ok(iBefore > -1 && iAsleep > iBefore && iStop > iAsleep, "sections run in time order, ahead of the first header");
  assert.ok(!html.slice(iStop).includes("1:17am"), "the 1:17am item is not under a stop");
  assert.ok(html.slice(html.indexOf("<h3", iStop + 1)).includes("<b>11:34am</b>"), "the 11:34am item sits under the stop he was at");
  const md = buildMarkdown(day, prose);
  assert.ok(md.indexOf("## While you slept") > -1 && md.indexOf("## While you slept") < md.indexOf("### "));
  assert.ok(md.includes("- **04:23** Jori tidied"));
  // Nothing before the first stop -> no section.
  const quiet = { ...day, commits: dayCommits([OVERNIGHT[2]], [FIRST, SECOND], JLM, [FIRST, SECOND], { night: NIGHT }) };
  const qh = assemble(buildSkeleton(quiet, {}), {});
  assert.ok(!qh.includes("While you slept") && !qh.includes("Before your first stop"));
});

test("a tag that turned up on most of the last week is routine, so its commits are omitted and not owed", () => {
  const week = (n) => Array.from({ length: n }, (_, i) => ({ date: `2026-10-${14 + i}`, tags: ["[auto-impl]"] }));
  assert.deepEqual([...routineTags(week(7))], ["[auto-impl]"]);
  assert.deepEqual([...routineTags(week(3))], []);
  assert.deepEqual([...routineTags(null)], [], "a failed read hides nothing");
  const routine = routineTags(week(7));
  const c = dayCommits(OVERNIGHT, [FIRST, SECOND], JLM, [FIRST, SECOND], { night: NIGHT, routineTags: routine });
  assert.equal(c[1].autonomous, true);
  assert.equal(c[1].omitted, "routine");
  assert.equal(c[0].omitted, undefined, "his own work is never omitted");
  const { uncovered, lines } = commitLines(c, []);
  assert.deepEqual(uncovered, ["896ad693", "4472a5d5"]);
  assert.equal(lines.length, 2);
  // Rare autonomous work (not routine) is kept, flagged so the narrator keeps it to a few words.
  const kept = dayCommits(OVERNIGHT, [FIRST, SECOND], JLM, [FIRST, SECOND], { night: NIGHT, routineTags: routineTags(week(1)) });
  assert.equal(kept[1].omitted, undefined);
  assert.equal(kept[1].autonomous, true);
  // The overnight section vanishes when everything in it was routine.
  const day = { date: "2026-10-21", tz: JLM, tzs: [JLM], stops: [FIRST, SECOND], travel_legs: [], commits: c };
  const html = assemble(buildSkeleton(day, {}), {});
  assert.ok(!html.includes("While you slept"));
  assert.ok(html.includes("Before you went to sleep"));
});

// ---- 2026-10-23: git's bare "Merge branch '…'" subjects are left out ----

test("a bare merge commit is left out and not owed; a described merge and the merged work stay", () => {
  const { bareMerge } = require(path.join(ROOT, "lib/daily-summary-commits.js"));
  // Real subjects from 2026-10-22.
  assert.equal(bareMerge("Merge branch 'worktree-agent-ae3c6ffc5db739168'"), true);
  assert.equal(bareMerge("Merge branch 'main' of github.com:user/jori"), true);
  assert.equal(bareMerge("Merge remote-tracking branch 'origin/main' into main"), true);
  assert.equal(bareMerge("Merge the phone sign-in page for the shop Chrome (browser.example.com)"), false);
  assert.equal(bareMerge("Merge branch 'x': and also fix the Quinn agenda"), false);
  const day = [
    { sha: "65728605", at: "2026-10-21T12:04:41Z", subject: "English- and Hebrew-language events wherever you are, not just home: new language-events-watch lane" },
    { sha: "69e9cf12", at: "2026-10-21T12:05:32Z", subject: "Merge branch 'worktree-agent-ae3c6ffc5db739168'" },
    { sha: "e7e08b28", at: "2026-10-21T07:20:39Z", subject: "Merge the phone sign-in page for the shop Chrome (browser.example.com)" },
  ];
  const c = dayCommits(day, [FIRST, SECOND], JLM, [FIRST, SECOND], { night: NIGHT });
  const bySha = Object.fromEntries(c.map((x) => [x.sha, x]));
  assert.equal(bySha["69e9cf12"].omitted, "merge");
  assert.equal(bySha["65728605"].omitted, undefined, "the merged work itself is listed");
  assert.equal(bySha["e7e08b28"].omitted, undefined, "a merge with its own description is kept");
  const { uncovered } = commitLines(c, []);
  assert.deepEqual(uncovered.sort(), ["65728605", "e7e08b28"], "nothing falls back to the raw 'Merge branch' subject");
  // A merge outranks the routine tag, so `why` says what it is.
  const both = dayCommits([{ sha: "aaaaaaa1", at: "2026-10-21T12:05:32Z", subject: "Merge branch 'worktree-agent-a1'" }],
    [FIRST, SECOND], JLM, [FIRST, SECOND], { routineTags: new Set(["[auto-impl]"]) });
  assert.equal(both[0].omitted, "merge");
});
