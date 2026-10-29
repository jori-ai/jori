// daily-summary-review.test.mjs — the independent Opus review and its verified repair.
//
// 2026-10-15. The Oct 14 summary opened "7:00am · Café Example" while its own
// night paragraph said the Watch had the user asleep until 7:29. The reviewer was
// Sonnet at medium effort reading the report text alone. the user: "before sending
// we should have another LLM review (opus level) to catch any issues or
// inconsistencies and repair them before sending."
//
// Pure pieces are tested directly; the CLI is driven end to end against a fake
// `claude` (CLAUDE_BIN), so no model runs.
//
// Run: node --test tests/daily-summary-review.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const R = require("../lib/daily-summary-review.js");
const { assemble, _internal: { stopHeaderHtml } } = require("../lib/daily-summary-render.js");
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin/daily-summary-review");

const ms = (iso) => Date.parse(iso);

// ---- stops that begin while the Watch has the user asleep -------------------------

const NIGHT = { tz: "Asia/Jerusalem", onset_at: "2026-10-13T22:26:05.484Z", wake_at: "2026-10-14T04:29:16.924Z" };
const stop = (id, startIso, endIso, source = "confirmed_stop", extra = {}) => ({
  id, title: id, start_ts_ms: ms(startIso), end_ts_ms: ms(endIso), tz: "Asia/Jerusalem", place: { name: id, source }, ...extra,
});

test("the 2026-10-14 defect: a cafe stop beginning at 7:00 with the Watch asleep until 7:29", () => {
  const day = { night: NIGHT, stops: [stop("Café Example", "2026-10-14T04:00:00Z", "2026-10-14T05:05:00Z")] };
  const f = R.stopsBeforeWake(day);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "high");
  assert.equal(f[0].from, "code");
  assert.match(f[0].detail, /Café Example.*begins at 7:00am.*asleep until 7:29am/);
});

test("the user's own homes, lodging and anything the user named are allowed to begin before the user woke", () => {
  for (const source of ["user_confirmed", "named_location", "known_recurring", "accommodation"]) {
    const day = { night: NIGHT, stops: [stop("Home", "2026-10-14T04:00:00Z", "2026-10-14T05:05:00Z", source)] };
    assert.deepEqual(R.stopsBeforeWake(day), [], source);
  }
});

test("slack at both ends: dropping off and the wake time rounding are not contradictions", () => {
  const justAfterOnset = stop("a", "2026-10-13T22:40:00Z", "2026-10-14T00:00:00Z");   // 14 min after onset
  const justBeforeWake = stop("b", "2026-10-14T04:22:00Z", "2026-10-14T05:00:00Z");   // 7 min before wake
  const afterWake = stop("c", "2026-10-14T04:38:00Z", "2026-10-14T05:00:00Z");
  assert.deepEqual(R.stopsBeforeWake({ night: NIGHT, stops: [justAfterOnset, justBeforeWake, afterWake] }), []);
});

test("an evening out before the user went to sleep is not a stop that began in the user's sleep", () => {
  const evening = stop("bar", "2026-10-13T18:00:00Z", "2026-10-13T22:00:00Z");
  assert.deepEqual(R.stopsBeforeWake({ night: NIGHT, stops: [evening] }), []);
});

test("no Watch night, or a wake with no end time, means no verdict on it", () => {
  assert.deepEqual(R.stopsBeforeWake({ stops: [stop("x", "2026-10-14T04:00:00Z", "2026-10-14T05:00:00Z")] }), []);
  assert.deepEqual(R.stopsBeforeWake({ night: { ...NIGHT, woke_range: { from: "07:36", to: "07:46" } },
    stops: [stop("x", "2026-10-14T04:00:00Z", "2026-10-14T05:00:00Z")] }), []);
});

test("overlapping stops are reported, a minute of rounding is not", () => {
  const a = stop("A", "2026-10-14T05:00:00Z", "2026-10-14T06:00:00Z");
  const b = stop("B", "2026-10-14T05:54:00Z", "2026-10-14T07:00:00Z");
  const c = stop("C", "2026-10-14T06:59:00Z", "2026-10-14T08:00:00Z");
  const f = R.overlappingStops({ stops: [c, b, a] });
  assert.equal(f.length, 1);
  assert.match(f[0].detail, /"A" and "B" overlap by 6 min/);
});

test("scoreFindings weighs high 3, medium 1, low 0", () => {
  assert.equal(R.scoreFindings([{ severity: "high" }, { severity: "medium" }, { severity: "low" }]), 4);
  assert.equal(R.scoreFindings([]), 0);
});

// ---- applying a model's edits ------------------------------------------------

const SKELETON = `<h1>Day</h1><h3>1:00pm · Ping's</h3><p>{{PROSE:s1}}</p>{{ASIDE:s1}}<h3>3:00pm · Home</h3><p>{{PROSE:s2}}</p>{{QUESTION:u1:ZGVmYXVsdA==}}{{OTHER_ANCHORS}}`;
const PROSE = { prose: { s1: "Lunch at Ping's. The phone had no GPS for a while.", s2: "Home." }, asides: {}, questions: {}, other_anchors: "" };

test("applyEdits: edits a named slot on a copy and leaves the original alone", () => {
  const slots = R.slotIds(SKELETON);
  const { prose, applied, rejected } = R.applyEdits(PROSE, [{ slot: "prose", id: "s1", text: "Lunch at Ping's.", why: "x" }], slots);
  assert.deepEqual(applied, [{ slot: "prose", id: "s1" }]);
  assert.deepEqual(rejected, []);
  assert.equal(prose.prose.s1, "Lunch at Ping's.");
  assert.match(PROSE.prose.s1, /no GPS/, "the input is not mutated");
});

test("applyEdits: empty text deletes the slot; question and aside slots work", () => {
  const slots = R.slotIds(SKELETON);
  const { prose } = R.applyEdits(PROSE, [
    { slot: "prose", id: "s2", text: "", why: "x" },
    { slot: "aside", id: "s1", text: "Closed a task here.", why: "x" },
    { slot: "question", id: "u1", text: "Was this Dominick?", why: "x" },
  ], slots);
  assert.equal("s2" in prose.prose, false);
  assert.equal(prose.asides.s1, "Closed a task here.");
  assert.equal(prose.questions.u1, "Was this Dominick?");
});

test("applyEdits: refuses a slot the skeleton lacks, markup in plain text, runaway length, non-strings", () => {
  const slots = R.slotIds(SKELETON);
  const { applied, rejected } = R.applyEdits(PROSE, [
    { slot: "prose", id: "s9", text: "invented stop", why: "x" },
    { slot: "prose", id: "s1", text: "<b>bold</b>", why: "x" },
    { slot: "prose", id: "s1", text: "x".repeat(701), why: "x" },
    { slot: "prose", id: "s1", text: 42, why: "x" },
    { slot: "header", id: "s1", text: "x", why: "x" },
  ], slots);
  assert.deepEqual(applied, []);
  assert.deepEqual(rejected.map((r) => r.reason), [
    "no such slot in the skeleton", "markup in a plain-text slot", "over 700 characters", "text is not a string", "unknown slot type",
  ]);
});

test("applyEdits: other_anchors takes plain list markup only", () => {
  const slots = R.slotIds(SKELETON);
  const ok = R.applyEdits(PROSE, [{ slot: "other_anchors", text: "<ul><li>Also: <em>$152</em></li></ul>", why: "x" }], slots);
  assert.equal(ok.applied.length, 1);
  const bad = R.applyEdits(PROSE, [{ slot: "other_anchors", text: "<script>x()</script>", why: "x" }], slots);
  assert.deepEqual(bad.applied, []);
  assert.equal(R.anchorsMarkupOk("<div><a href='x'>y</a></div>"), false);
});

test("slotIds reads the skeleton's own markers", () => {
  const s = R.slotIds(SKELETON);
  assert.deepEqual([...s.prose].sort(), ["s1", "s2"]);
  assert.deepEqual([...s.aside], ["s1"]);
  assert.deepEqual([...s.question], ["u1"]);
});

// ---- what the reviewer is shown ----------------------------------------------

test("factPack carries the night, the stops as built, the user's words and the amounts", () => {
  const text = R.factPack({
    date: "2026-10-14",
    manifest: {
      night: { fell_asleep: "1:26am IDT", woke: "7:29am IDT", asleep: "about 6 hours", wakeups: [{ at: "6:22am IDT", min: 6 }] },
      stops: [{ id: "s-1", start: "7:38am", end: "8:09am", tz_abbr: "IDT", title: "Café Example", provenance: { tier: "CONFIRMED" }, place_source: "confirmed_stop", companions: ["Rover"] }],
      tasks_completed: [{ completed_at: "07:45", title: "Buy WiFi hardware" }],
      standout_transactions: [{ merchant: "Example Air", amount_usd: "$630", stop_id: null }],
    },
    day: { path: { tz: "Asia/Jerusalem" } },
    statements: { places: [{ name: "Café Example", evidence: "coffee at antilia with sam" }] },
    corrections: [{ text: "the 7am also had a bagel run" }],
  });
  for (const needle of ["Asia/Jerusalem", "woke 7:29am IDT", "6:22am IDT (6 min)", "s-1: 7:38am-8:09am IDT \"Café Example\"",
    "companions on record: Rover", "NOT the user's words about this visit", "Buy WiFi hardware", "Example Air $630 (no stop)", "coffee at antilia with sam", "bagel run"]) {
    assert.ok(text.includes(needle), `missing: ${needle}\n${text}`);
  }
});

test("the review prompt tells the model what code already caught, and to check times", () => {
  const p = R.reviewPrompt({ facts: "F", reportText: "T", known: ["Café Example begins at 7:00am"] });
  assert.match(p, /ALREADY CAUGHT BY CODE CHECKS/);
  assert.match(p, /Café Example begins at 7:00am/);
  assert.match(p, /TIMES AND ORDER/);
  assert.doesNotMatch(R.reviewPrompt({ facts: "F", reportText: "T" }), /ALREADY CAUGHT/);
});

test("neither prompt lets prose be bent to agree with a wrong header", () => {
  assert.match(R.reviewPrompt({ facts: "F", reportText: "T" }), /Never ask for prose to be deleted or softened because it agrees with the user's words/);
  assert.match(R.reviewPrompt({ facts: "F", reportText: "T" }), /Do not also ask for prose to be changed to agree with it/);
  // lang-regex-ok: asserts the text of our own prompt, not anything the user wrote
  assert.match(R.repairPrompt({ facts: "F", prose: {}, issues: [] }), /Never delete or soften a sentence that agrees with the user's own messages/);
  assert.match(R.repairPrompt({ facts: "F", prose: {}, issues: [] }), /If a time in the prose is right and the header's is wrong, leave the prose alone/);
});

// ---- 2026-10-16: the review rubric and the evidence it is given ---------------
// Friday Oct 16 shipped the Old Port flat as four back-to-back stops, a dinner the user
// named ("had dinner here ... with Noa and Sam") only in Day's other anchors,
// a 3-hour "Café Example" auto-matched over it, and companions on one Nana visit
// but not the other. The reviewer had no copy of the user's messages (the statements
// file was never written) and told the writer to delete the one honest aside.

test("the rubric covers the user's words, who was there, the day's shape, times, names and prose, strongest evidence first", () => {
  const p = R.reviewPrompt({ facts: "F", reportText: "T" });
  for (const section of ["EVIDENCE, STRONGEST FIRST", "A. THE USER'S WORDS ARE ALL THERE AND RIGHT", "B. WHO WAS THERE",
    "C. THE SHAPE OF THE DAY", "D. TIMES AND ORDER", "E. NAMES AND CERTAINTY", "F. PROSE ACCURACY"]) {
    assert.ok(p.includes(section), `rubric lacks ${section}`);
  }
  assert.match(p, /appears only in "Day's other anchors", or not at all, is a defect/);
  // lang-regex-ok: asserts the text of our own prompt, not anything the user wrote
  assert.match(p, /A person the user said was there who is missing from that stop/);
  assert.match(p, /System, pipeline or debugging narration/);
  assert.match(p, /Code-built stops are final for the PROSE REPAIR only\. They are not proof\./);
});

test("factPack hands the reviewer the user's own messages verbatim, inside the day only, with the stop they were sent during", () => {
  const manifest = {
    stops: [{ id: "s-7", start: "20:39", end: "23:35", title: "Café Example", provenance: { tier: "CONFIRMED" }, place_source: "confirmed_stop", companions: [] }],
    harvest: {
      window: { start: "2026-10-15T21:00:00.000Z", end: "2026-10-16T21:00:00.000Z" },
      facts_by_stop: { "s-7": [
        { kind: "chat", role: "user", at: "2026-10-16T19:47:00Z", text: "had dinner here - https://maps.app.goo.gl/x with Noa and Sam" },
        { kind: "chat", role: "assistant", at: "2026-10-16T19:48:00Z", text: "noted" },
        { kind: "commit", at: "2026-10-16T19:49:00Z", subject: "a commit" },
      ] },
      orphan_facts: [{ kind: "chat", role: "user", at: "2026-10-15T20:00:00Z", text: "yesterday's message" }],
    },
  };
  const text = R.factPack({ date: "2026-10-16", manifest, day: { path: { tz: "Asia/Jerusalem" } }, statements: {}, corrections: [] });
  // lang-regex-ok: asserts the text of our own prompt, not anything the user wrote
  assert.match(text, /THE USER'S OWN MESSAGES THAT DAY/);
  assert.match(text, /10:47pm \[during s-7\]: "had dinner here - https:\/\/maps\.app\.goo\.gl\/x with Noa and Sam"/);
  assert.doesNotMatch(text, /noted|a commit|yesterday's message/, "only THE USER'S chat, only inside the day");
  assert.match(text, /companions on record: none/);
  assert.match(text, /PLACES EXTRACTED FROM THE USER'S WORDS: none \(the extraction did not run/);
});

test("the user's photos reach the reviewer: the stop they fall in, how far from it, the phone's venue reading, what is in frame", () => {
  // Friday Oct 16, 10:18: a photo at the real Café Example inside a block titled as the flat.
  const day = { stops: [{ id: "s-p2", title: "The Old Port Airbnb", start_ts_ms: Date.parse("2026-10-16T02:49:00Z"), end_ts_ms: Date.parse("2026-10-16T11:17:00Z"), lat: 12.34560, lon: -65.43210 }] };
  const photos = [
    { taken_at: "2026-10-16T07:18:37Z", latitude: 12.3454612, longitude: -65.4313712, device_venue: { name: "Café Example", pois: [{ name: "Café Example", category: "Restaurant", distance_m: 33 }] }, labels: ["plate", "drinking glass", "table"], persons: ["Sam"], self_captured: true },
    { taken_at: "2026-10-16T15:33:54Z", latitude: 12.29280, longitude: -65.45087, labels: ["textile"], self_captured: false },
  ];
  const lines = R.photoLines(photos, day, "Asia/Jerusalem");
  assert.match(lines[0], /10:18am: during s-p2 "The Old Port Airbnb", 81 m from that stop; phone's venue reading: "Café Example"; nearest places: Café Example \(Restaurant\) 33 m; in frame: plate, drinking glass, table; people: Sam/);
  assert.match(lines[1], /during no stop \(between stops\).*not taken on the user's phone/);
  const text = R.factPack({ date: "2026-10-16", manifest: { stops: [] }, day: { ...day, path: { tz: "Asia/Jerusalem" } }, statements: {}, corrections: [], photos });
  assert.match(text, /THE USER'S PHOTOS THAT DAY/);
  const blind = R.factPack({ date: "2026-10-16", manifest: { stops: [] }, day, statements: {}, corrections: [], photos: null });
  assert.match(blind, /not available to this review/, "a failed fetch is stated, never read as no photos");
  // lang-regex-ok: asserts the text of our own prompt, not anything the user wrote
  assert.match(R.reviewPrompt({ facts: "F", reportText: "T" }), /A stop whose photos place the user somewhere other than its title says/);
});

test("photo lines name a stop by its settled title, not the resolver's name before the settle", () => {
  // Oct 21: the walk was settled to the user's words, but the day JSON's place.name kept the
  // excursion's geometry title, and the photo lines used it.
  const day = { stops: [{ id: "s-w", start_ts_ms: Date.parse("2026-10-21T11:22:00Z"), end_ts_ms: Date.parse("2026-10-21T13:02:00Z"),
    place: { name: "Walk in גן הכובשים", source: "excursion" }, provenance: { title: "Walk back to the apartment from הקוסם" } }] };
  const lines = R.photoLines([{ taken_at: "2026-10-21T12:57:00Z" }], day, "Asia/Jerusalem");
  assert.match(lines[0], /during s-w "Walk back to the apartment from הקוסם"/);
  assert.doesNotMatch(lines[0], /גן הכובשים/);
  // A stop with no settled title still falls back to its place name.
  const bare = R.photoLines([{ taken_at: "2026-10-21T12:57:00Z" }], { stops: [{ ...day.stops[0], provenance: {} }] }, "Asia/Jerusalem");
  assert.match(bare[0], /during s-w "Walk in גן הכובשים"/);
});

test("splitStays: back-to-back same-place stops are one stay, lodging included; a real return is not", () => {
  const t = (h, m) => Date.UTC(2026, 9, 16, h, m);
  const stop = (id, title, a, b) => ({ id, title, tz: "Asia/Jerusalem", start_ts_ms: a, end_ts_ms: b, place: { name: title, source: "accommodation" } });
  const day = { stops: [
    stop("1", "The Old Port Airbnb", t(2, 39), t(2, 49)), stop("2", "The Old Port Airbnb", t(2, 49), t(11, 17)), stop("3", "The Old Port Airbnb", t(11, 17), t(12, 38)),
    stop("4", "Nana's apartment", t(13, 0), t(14, 48)), stop("5", "The Old Port Airbnb", t(17, 13), t(17, 37)),
  ] };
  const f = R.splitStays(day);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "high");
  assert.equal(f[0].fix_by, "fork");
  assert.match(f[0].detail, /one stay shown as 3 back-to-back stops/);
});

test("duplicateTasks: the same task at the same minute twice is one task", () => {
  const f = R.duplicateTasks([{ title: "Check new mail at Example mailbox 120", completed_at: "23:39" }, { title: "Check new mail at Example mailbox 120", completed_at: "23:39" }, { title: "Other", completed_at: "10:00" }]);
  assert.equal(f.length, 1);
  assert.match(f[0].detail, /listed 2 times/);
});

// ---- the CLI against a fake claude -------------------------------------------

const DATE = "2099-03-04";
const FILES = {
  report: `/tmp/daily-summary-${DATE}.html`, skeleton: `/tmp/ds-skeleton-${DATE}.html`, prose: `/tmp/ds-prose-${DATE}.json`,
  manifest: `/tmp/ds-manifest-${DATE}.json`, day: `/tmp/ds-day-${DATE}.json`, out: `/tmp/ds-review-${DATE}.json`,
  bak1: `/tmp/ds-prose-${DATE}.pre-repair-1.json`, bak2: `/tmp/ds-prose-${DATE}.pre-repair-2.json`,
};
const CLEAN = (f) => { for (const p of Object.values(FILES)) { try { fs.unlinkSync(p); } catch {} } return f; };

// A fake `claude -p` that answers by call number from a script in $FAKE_SCRIPT:
// an array of results (or the string "down"), consumed in order.
function fakeClaude(dir, script) {
  const scriptFile = path.join(dir, "script.json"), counter = path.join(dir, "n");
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
if (process.argv[2] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
let stdin = ""; process.stdin.on("data", (c) => stdin += c); process.stdin.on("end", () => {
  const n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) : 0;
  fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
  fs.appendFileSync(${JSON.stringify(path.join(dir, "prompts.log"))}, JSON.stringify({ n, args: process.argv.slice(2), stdin }) + "\\n");
  const script = JSON.parse(fs.readFileSync(${JSON.stringify(scriptFile)}, "utf8"));
  const step = script[Math.min(n, script.length - 1)];
  if (step === "down") { console.log("Not logged in · Please run /login"); process.exit(1); }
  console.log(JSON.stringify({ type: "result", is_error: false, structured_output: step, total_cost_usd: 0.25, session_id: "fake-session",
    usage: { input_tokens: 1000, output_tokens: 200 } }));
});
`, { mode: 0o755 });
  return { bin, prompts: () => fs.existsSync(path.join(dir, "prompts.log"))
    ? fs.readFileSync(path.join(dir, "prompts.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [] };
}

function setup() {
  CLEAN();
  const prose = JSON.parse(JSON.stringify({ prose: { s1: "Lunch at Ping's. The phone had no GPS for a while, so you may have stepped out." }, asides: {}, questions: {} }));
  fs.writeFileSync(FILES.skeleton, `<h1>Day of Wednesday, March 4, 2099</h1><h3>1:00pm–2:00pm · Ping's</h3><p>{{PROSE:s1}}</p>`);
  fs.writeFileSync(FILES.prose, JSON.stringify(prose));
  fs.writeFileSync(FILES.report, assemble(fs.readFileSync(FILES.skeleton, "utf8"), prose));
  fs.writeFileSync(FILES.manifest, JSON.stringify({ stops: [{ id: "s1", start: "1:00pm", end: "2:00pm", title: "Ping's", provenance: { tier: "CONFIRMED" } }] }));
  fs.writeFileSync(FILES.day, JSON.stringify({ stops: [] }));
}

function run(fake, args = []) {
  const dir = path.dirname(fake.bin);
  return spawnSync(process.execPath, [BIN, DATE, ...args], {
    encoding: "utf8", timeout: 60000,
    env: { ...process.env, CLAUDE_BIN: fake.bin, JORI_FORK_COST_LEDGER: path.join(dir, "ledger.ndjson"), DS_REVIEW_NO_ROUTE: "1", DS_REVIEW_PHOTOS_FILE: path.join(dir, "photos.json"),
           DS_REVIEW_PRIOR_CALLS_FILE: path.join(dir, "prior-calls.json") },
  });
}

const GPS_ISSUE = { kind: "quality", severity: "medium", detail: "a sentence about missing GPS", fix: "delete the clause", slot: { type: "prose", id: "s1" } };

test("CLI: Opus is the default reviewer, sees the facts, and a clean report publishes", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  try {
    const fake = fakeClaude(dir, [{ issues: [], verdict: "publish" }]);
    const r = run(fake);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.verdict, "publish");
    assert.equal(out.reviewer, "opus high");
    assert.equal(out.independent_review, "ok");
    const [call] = fake.prompts();
    assert.ok(call.args.includes("claude-opus-5-5") || call.args.some((a) => a.startsWith("claude-opus")), call.args.join(" "));
    assert.equal(call.args[call.args.indexOf("--effort") + 1], "high");
    assert.match(call.stdin, /FACTS \(the inputs the report was built from\)/);
    assert.match(call.stdin, /s1: 1:00pm-2:00pm "Ping's"/);
    // the call was written to the fork cost ledger
    const ledger = fs.readFileSync(path.join(dir, "ledger.ndjson"), "utf8");
    assert.match(ledger, /daily-summary-review:review/);
  } finally { CLEAN(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: --repair fixes the prose slot, re-assembles, re-reviews, and keeps a verified improvement", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  try {
    const fake = fakeClaude(dir, [
      { issues: [GPS_ISSUE], verdict: "revise" },                                                       // review
      { edits: [{ slot: "prose", id: "s1", text: "Lunch at Ping's.", why: "GPS sentence is banned" }], unfixable: [] }, // repair
      { issues: [], verdict: "publish" },                                                               // re-review
    ]);
    const r = run(fake, ["--repair"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = JSON.parse(r.stdout);
    assert.equal(out.repairs.length, 1);
    assert.equal(out.repairs[0].kept, true);
    assert.equal(out.repairs[0].score_before, 1);
    assert.equal(out.repairs[0].score_after, 0);
    assert.equal(JSON.parse(fs.readFileSync(FILES.prose, "utf8")).prose.s1, "Lunch at Ping's.");
    assert.ok(!fs.readFileSync(FILES.report, "utf8").includes("no GPS"), "the report that ships is the repaired one");
    assert.match(fs.readFileSync(FILES.bak1, "utf8"), /no GPS/, "the original prose is kept beside it");
    const calls = fake.prompts();
    assert.equal(calls.length, 3, "review, repair, re-review");
    assert.match(calls[1].stdin, /repairing a daily report/);
    assert.match(calls[1].stdin, /a sentence about missing GPS/);
  } finally { CLEAN(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: a repair that does not improve the findings is reverted", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  try {
    const originalProse = fs.readFileSync(FILES.prose, "utf8");
    const originalReport = fs.readFileSync(FILES.report, "utf8");
    const fake = fakeClaude(dir, [
      { issues: [GPS_ISSUE], verdict: "revise" },
      { edits: [{ slot: "prose", id: "s1", text: "Lunch at Ping's with Quinn.", why: "x" }], unfixable: [] },
      { issues: [{ kind: "invented", severity: "high", detail: "Quinn was never there", fix: "remove", slot: { type: "prose", id: "s1" } }], verdict: "revise" },
    ]);
    const r = run(fake, ["--repair"]);
    const out = JSON.parse(r.stdout);
    assert.equal(out.repairs[0].kept, false);
    assert.equal(out.repairs[0].why, "findings did not improve");
    assert.equal(fs.readFileSync(FILES.prose, "utf8"), originalProse, "prose put back");
    assert.equal(fs.readFileSync(FILES.report, "utf8"), originalReport, "report put back");
  } finally { CLEAN(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: an edit that names a slot the skeleton lacks is refused and nothing changes", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  try {
    const originalProse = fs.readFileSync(FILES.prose, "utf8");
    const fake = fakeClaude(dir, [
      { issues: [GPS_ISSUE], verdict: "revise" },
      { edits: [{ slot: "prose", id: "s7", text: "A stop that does not exist.", why: "x" }], unfixable: [] },
    ]);
    const out = JSON.parse(run(fake, ["--repair"]).stdout);
    assert.equal(out.repairs[0].kept, false);
    assert.equal(out.repairs[0].why, "no edit survived validation");
    assert.equal(out.repairs[0].rejected[0].reason, "no such slot in the skeleton");
    assert.equal(fs.readFileSync(FILES.prose, "utf8"), originalProse);
    assert.equal(fake.prompts().length, 2, "no re-review of an edit that never applied");
  } finally { CLEAN(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: a defect only code can fix is disclosed but does not block the send", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  try {
    fs.writeFileSync(FILES.day, JSON.stringify({ night: NIGHT, stops: [stop("Café Example", "2026-10-14T04:00:00Z", "2026-10-14T05:05:00Z")] }));
    const fake = fakeClaude(dir, [{ issues: [], verdict: "publish" }]);
    const r = run(fake);
    const out = JSON.parse(r.stdout);
    const f = out.findings.find((x) => x.from === "code");
    assert.ok(f && f.severity === "high" && f.fix_by === "none", JSON.stringify(out.findings));
    assert.equal(r.status, 0, "fix_by none never makes the fork loop");
    assert.equal(out.verdict, "publish_with_notes");
    assert.match(fake.prompts()[0].stdin, /ALREADY CAUGHT BY CODE CHECKS[\s\S]*Café Example/, "the model is told, not asked to rediscover it");
  } finally { CLEAN(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: a code-owned defect is recorded once in the ledger for the fixer, nothing is posted, and the day is not confirmed", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  try {
    fs.writeFileSync(FILES.day, JSON.stringify({ night: NIGHT, stops: [stop("Café Example", "2026-10-14T04:00:00Z", "2026-10-14T05:05:00Z")] }));
    const ledger = path.join(dir, "defects.jsonl");
    const runRecorded = () => spawnSync(process.execPath, [BIN, DATE], { encoding: "utf8", timeout: 60000,
      env: { ...process.env, CLAUDE_BIN: fakeClaude(dir, [{ issues: [], verdict: "publish" }]).bin, JORI_FORK_COST_LEDGER: path.join(dir, "l.ndjson"),
        DS_REVIEW_NO_ROUTE: "", DS_REVIEW_DEFECTS_LEDGER: ledger, DS_REVIEW_SEND_BIN: "/nonexistent", DS_REVIEW_PHOTOS_FILE: path.join(dir, "photos.json") } });
    const out = JSON.parse(runRecorded().stdout);
    assert.equal(out.confirmed, false, "a high code-owned defect means the day is not confirmed");
    const rows = fs.readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, DATE);
    runRecorded();
    assert.equal(fs.readFileSync(ledger, "utf8").trim().split("\n").length, 1, "same defect, same date: recorded once");
  } finally { CLEAN(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: a clean review confirms the day", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  try {
    const out = JSON.parse(run(fakeClaude(dir, [{ issues: [], verdict: "publish" }])).stdout);
    assert.equal(out.confirmed, true);
  } finally { CLEAN(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: a place the user named counts by its venue and its words, never by a raw message or link; pace is only judged on a walking day", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  const stmts = `/tmp/day-statements-${DATE}.json`, resolvedF = `/tmp/resolved-day-${DATE}.json`;
  try {
    fs.writeFileSync(FILES.report, "<h1>Day</h1><h3>1:20pm · The Old Man &amp; The Sea</h3><p>Lunch.</p><h3>8:39pm · Shawarma Falafel Example</h3><p>Dinner.</p><h3>9:50pm · The Old Port Airbnb</h3><p>Home.</p>");
    fs.writeFileSync(stmts, JSON.stringify({ places: [
      // "and" in the user's words, "&" in the venue's own name (2026-10-20)
      { name: "the old man and the sea", venue: "The Old Man and the Sea", evidence: "lunch at the old man and the sea" },
      { name: "had dinner here - https://maps.app.goo.gl/x", venue: "Shawarma Falafel Example", evidence: "had dinner here" },
      { name: "The Airbnb", venue: "the Airbnb", evidence: "The Airbnb" },
      { name: "Milk Bakery", venue: "Milk Bakery", evidence: "at Milk Bakery" },
    ] }));
    fs.writeFileSync(resolvedF, JSON.stringify({ path: { stats: { pace_kmh_after: 17.6, matched_km: 36.2, walked_km: 1.2 } } }));
    const out = JSON.parse(run(fakeClaude(dir, [{ issues: [], verdict: "publish" }]), ["--no-model"]).stdout);
    const missing = out.findings.filter((f) => f.kind === "missing").map((f) => f.detail);
    assert.equal(missing.length, 1, JSON.stringify(missing));
    assert.match(missing[0], /Milk Bakery/);
    assert.ok(!out.findings.some((f) => f.kind === "impossible" && /walking pace/.test(f.detail)), "a driving day is not a 17.6 km/h walk");
    fs.writeFileSync(resolvedF, JSON.stringify({ path: { stats: { pace_kmh_after: 9, matched_km: 10, walked_km: 9.5 } } }));
    const walk = JSON.parse(run(fakeClaude(dir, [{ issues: [], verdict: "publish" }]), ["--no-model"]).stdout);
    assert.ok(walk.findings.some((f) => /walking pace 9 km\/h/.test(f.detail)), "a walking day at 9 km/h is still flagged");
  } finally { CLEAN(); for (const f of [stmts, resolvedF]) { try { fs.unlinkSync(f); } catch {} } fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: 'and' and a possessive are not words of the place the user named (2026-10-24)", () => {
  // "Ben and Ora's" sat beside the header "Parents' home, Hill Town · with … Ora … Ben".
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  const stmts = `/tmp/day-statements-${DATE}.json`;
  try {
    fs.writeFileSync(FILES.report, "<h1>Day</h1><h3>5:14pm · <b>Parents' home, Hill Town</b> · with Sam + Ora + Eve + Ben</h3><p>Family evening.</p>");
    fs.writeFileSync(stmts, JSON.stringify({ places: [
      { name: "Ben and Ora", venue: "Ben and Ora's", evidence: "After Ben and Ora we drove to Nana." },
      { name: "Nurit and Gil", venue: "Nurit and Gil's", evidence: "then we went on to Nurit and Gil's" },
    ] }));
    const out = JSON.parse(run(fakeClaude(dir, [{ issues: [], verdict: "publish" }]), ["--no-model"]).stdout);
    // The word pass clears Ben and Ora's; Nurit and Gil's is left for the model,
    // and with no model it is unconfirmed, never a high "missing" on a word test alone.
    assert.deepEqual(out.candidates.map((c) => c.label), ["Nurit and Gil's"]);
    const missing = out.findings.filter((f) => f.kind === "missing").map((f) => [f.severity, f.headline]);
    assert.deepEqual(missing, [["medium", "I couldn't confirm that Nurit and Gil's, which you mentioned, is in the summary"]]);
  } finally { CLEAN(); try { fs.unlinkSync(stmts); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: commit lines are one short sentence per project; routine-omitted commits are not owed (2026-10-22)", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  try {
    const c = (sha, extra = {}) => ({ sha, ts: 1, local: "09:00", part: "morning", stop_id: null, pre: null, subject: `subject ${sha}`, ...extra });
    fs.writeFileSync(FILES.day, JSON.stringify({ stops: [], commits: [c("aaaaaaa1"), c("bbbbbbb2"), c("ccccccc3", { autonomous: true, omitted: "routine" })] }));
    fs.writeFileSync(FILES.report, '<h1>Day</h1><div class="commits"><ul class="worked"><li>x</li></ul></div>');
    const longLine = "You worked on the shopping assistant's sign-ins: it can copy a login from Apple Passwords into your vault, Vrbo signs in with your Expedia login, and United is tied to your MileagePlus login.";
    fs.writeFileSync(FILES.prose, JSON.stringify({ prose: {}, commits: [{ shas: ["aaaaaaa1", "bbbbbbb2"], text: longLine }] }));
    const out = JSON.parse(run(fakeClaude(dir, [{ issues: [], verdict: "publish" }]), ["--no-model"]).stdout);
    const wordy = out.findings.filter((f) => /commit line\(s\) over 140/.test(f.detail));
    assert.equal(wordy.length, 1, JSON.stringify(out.findings));
    assert.equal(wordy[0].fix_by, "fork");
    assert.ok(!out.findings.some((f) => /raw subject/.test(f.detail)), "the omitted routine commit is not owed a line");
    fs.writeFileSync(FILES.prose, JSON.stringify({ prose: {}, commits: [{ shas: ["aaaaaaa1", "bbbbbbb2"], text: "You got the shopping assistant signing in to your sites." }] }));
    const ok = JSON.parse(run(fakeClaude(dir, [{ issues: [], verdict: "publish" }]), ["--no-model"]).stdout);
    assert.ok(!ok.findings.some((f) => f.kind === "quality" && /commit/.test(f.detail)), JSON.stringify(ok.findings));
  } finally { CLEAN(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: a closed task whose title holds an escaped character is found in the report", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  try {
    const task = { title: 'Re: units 1A & 1B survey <draft> "final"', completed_at: "19:45" };
    fs.writeFileSync(FILES.day, JSON.stringify({ stops: [], tasks_completed: [task] }));
    fs.writeFileSync(FILES.report, "<h1>Day</h1><ul><li><b>7:45pm</b> Re: units 1A &amp; 1B survey &lt;draft&gt; &quot;final&quot;</li></ul>");
    const isMissing = (f) => f.kind === "missing" && f.detail.includes("closed the task");
    const found = JSON.parse(run(fakeClaude(dir, [{ issues: [], verdict: "publish" }]), ["--no-model"]).stdout);
    assert.ok(!found.findings.some(isMissing), JSON.stringify(found.findings));
    fs.writeFileSync(FILES.report, "<h1>Day</h1><ul><li>another task</li></ul>");
    const absent = JSON.parse(run(fakeClaude(dir, [{ issues: [], verdict: "publish" }]), ["--no-model"]).stdout);
    assert.equal(absent.findings.filter(isMissing).length, 1, JSON.stringify(absent.findings));
  } finally { CLEAN(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: when the model is unavailable the report is not blocked, and the hole is stated", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  try {
    const fake = fakeClaude(dir, ["down"]);
    const r = run(fake, ["--repair"]);
    const out = JSON.parse(r.stdout);
    assert.equal(out.independent_review, "unavailable");
    assert.ok(out.findings.some((f) => /review did not run/.test(f.detail) && f.severity === "medium"));
    assert.equal(fake.prompts().length, 1, "a fatal error (not logged in) is not retried");
    assert.equal(out.repairs.length, 0);
  } finally { CLEAN(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: --no-model keeps the structural checks and never starts a model", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  try {
    fs.writeFileSync(FILES.report, "<h1>Day</h1><h3>1:00pm–2:00pm · Ping's</h3><p>Lunch, 5 photos of dumplings.</p>");
    const fake = fakeClaude(dir, [{ issues: [], verdict: "publish" }]);
    const r = run(fake, ["--no-model", "--repair"]);
    assert.equal(r.status, 3);
    const out = JSON.parse(r.stdout);
    assert.equal(out.reviewer, "none (structural only)");
    assert.equal(fake.prompts().length, 0);
    assert.ok(out.findings.some((f) => f.kind === "quality" && f.fix_by === "prose"));
  } finally { CLEAN(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("factPack gives the walked miles the header prints even when the day has no transit charges", () => {
  // 2026-10-16: an empty mobility list hid the path totals, so the reviewer judged
  // "0.7 miles walked" unsupported.
  const day = { path: { tz: "Asia/Jerusalem", stats: { walked_km: 1.2, matched_km: 36.2, geometry_source: "map_matched" },
    spine: [{ type: "leg", mode: "walking", walked_m: 471 }, { type: "leg", mode: "driving", routed_m: 5581 },
            { type: "leg", mode: "walking", walked_m: 0, routed_m: 5033 }, { type: "leg", mode: "walking", walked_m: 725 }] } };
  const text = R.factPack({ date: "2026-10-16", manifest: { stops: [], mobility: [] }, day, statements: {}, corrections: [] });
  assert.match(text, /MOVEMENT TOTALS \(code\): walked 0\.7 miles/);
  assert.match(text, /all travel 36\.2 km/);
  assert.doesNotMatch(text, /TRANSIT, TOLL AND RIDE CHARGES/);
});

test("factPack's all-travel total counts the legs the map-matcher missed", () => {
  // 2026-10-15: two of four segments were not matched, so "all travel 1.4 km" sat
  // beside a 24.3 km evening drive and the review called the report contradictory.
  const day = { path: { tz: "Asia/Jerusalem", stats: { walked_km: 1, matched_km: 1.4, observed_km: 8, inferred_km: 40.6,
    geometry_source: "map_matched" },
    spine: [{ type: "leg", mode: "walking", walked_m: 805 }, { type: "leg", mode: "riding", routed_m: 0, straight_m: 24300 }] } };
  const text = R.factPack({ date: "2026-10-15", manifest: { stops: [] }, day, statements: {}, corrections: [] });
  assert.match(text, /all travel 48\.6 km, any mode \(1\.4 km of it map-matched\)/);
  assert.doesNotMatch(text, /all travel 1\.4 km/);
});

// 2026-10-17: Friday Oct 16 shipped twice without its Milk Bakery and August
// photos. `photos embed-uuids` dropped them with a stderr line and nothing else
// said so; the user asked "There are available photos that are missing from this. Why?"
test("a photo the email could not show is a medium finding naming the stop and its local time", () => {
  const manifest = { stops: [
    { id: "s-c1", title: "Milk Bakery", photos_not_shown: [
      { uuid: "2CC96CED-D0DE-45B1-B83B-4A67D580A526", taken_at: "2026-10-16T11:28:17.145Z", reason: "export produced no image file" }] },
    { id: "s-7", title: "Nana's apartment", photos_not_shown: [] },
    { id: "s-old", title: "Before the stamp existed" },
  ] };
  const day = { tz: "Asia/Jerusalem", stops: [{ id: "s-c1", tz: "Asia/Jerusalem" }] };
  const f = R.photosNotShown(manifest, day);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "medium");
  assert.equal(f[0].kind, "missing");
  assert.equal(f[0].stop_id, "s-c1");
  assert.match(f[0].headline, /Milk Bakery at 2:28pm/);
  assert.match(f[0].detail, /export produced no image file/);
  assert.deepEqual(R.photosNotShown({ stops: [] }, day), []);
  assert.deepEqual(R.photosNotShown(null, null), []);
});

test("CLI: a statement naming no place is checked by its time, never by its words", () => {
  // 2026-10-18: "We had lunch at a place I ate last week with the lassers" was called
  // missing beside the Oved Ba'ir lunch it described; "stopped for gas" had no stop.
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  const stmts = `/tmp/day-statements-${DATE}.json`;
  const at = (hm) => Date.parse(`${DATE}T${hm}:00Z`);
  const stopAt = (id, name, a, b) => ({ id, start_ts_ms: at(a), end_ts_ms: at(b),
    duration_min: Math.round((at(b) - at(a)) / 60000), place: { name, source: "user_confirmed" } });
  try {
    fs.writeFileSync(FILES.report, "<h1>Day</h1><h3>2:51pm · Oved Ba'ir</h3><p>Lunch.</p><h3>8:04pm · Osher Ad supermarket</h3><p>Snacks.</p>");
    const lunch = stopAt("s3", "Oved Ba'ir", "14:51", "16:20"), osher = stopAt("s6", "Osher Ad supermarket", "20:04", "20:30");
    fs.writeFileSync(FILES.day, JSON.stringify({ stops: [lunch, osher] }));
    fs.writeFileSync(stmts, JSON.stringify({ _meta: { tz: "UTC" }, places: [
      { name: "We had lunch at a place I ate last week with the lassers", venue: null, when_hint: "14:51",
        evidence: "We had lunch at a place I ate last week with the lassers" },
      { name: "stopped for gas", venue: null, when_hint: "19:55", evidence: "I stopped for gas after nana, close to Osher Ad." },
      { name: "evening walk with Rover", venue: null, when_hint: "earlier", evidence: "evening walk with Rover" },
    ] }));
    // Only the gas stop is left for the model; it finds no stop for it, so it is reported.
    const fake = fakeClaude(dir, [{ issues: [], verdict: "publish",
      candidates: [{ id: "c1", verdict: "absent", where: "nothing between Nana's and Osher Ad at 7:55pm" }] }]);
    const first = JSON.parse(run(fake).stdout);
    assert.deepEqual(first.candidates.map((c) => [c.label, c.outcome]), [["stopped for gas", "missing"]]);
    assert.deepEqual(first.findings.filter((f) => f.kind === "missing").map((f) => f.headline),
      ["stopped for gas, which you mentioned, is not in the summary"]);
    assert.match(fake.prompts()[0].stdin, /c1 · a stop the user described \(no place name\): "stopped for gas"[^\n]*about 19:55/);
    fs.writeFileSync(FILES.day, JSON.stringify({ stops: [lunch, stopAt("s5", "Gas station", "19:55", "20:03"), osher] }));
    const second = JSON.parse(run(fake, ["--no-model"]).stdout);
    assert.deepEqual(second.findings.filter((f) => f.kind === "missing"), []);
    assert.equal(second.candidates, undefined, "a stop at that time clears it in code");
  } finally { CLEAN(); try { fs.unlinkSync(stmts); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: the user's answer for a window, saved under other words, is not called missing; another name there still is (2026-10-21)", () => {
  // "hilton hotel for the AI conference" was the user's reply to the 10:30 ask; the row
  // the user answered reads "Hilton Seaside City". At 8:17pm "meet Erin and Iris at Café Shade"
  // while the stop then was the flat, named by a geofence, not by the user.
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  const stmts = `/tmp/day-statements-${DATE}.json`;
  const at = (hm) => Date.parse(`${DATE}T${hm}:00Z`);
  const stopAt = (id, name, a, b, rowType) => ({ id, start_ts_ms: at(a) + 56_000, end_ts_ms: at(b),
    duration_min: Math.round((at(b) - at(a)) / 60000), place: { name, source: "user_confirmed" },
    confirmed_row: { place_type: rowType }, provenance: { title: name } });
  try {
    fs.writeFileSync(FILES.report, "<h1>Day</h1><h3>10:30am · Hilton Seaside City</h3><p>Conference.</p><h3>5:13pm · The Old Port Airbnb</h3><p>Home.</p>");
    fs.writeFileSync(FILES.day, JSON.stringify({ stops: [
      stopAt("s2", "Hilton Seaside City", "10:30", "10:56", "user-confirmed"), stopAt("s7", "The Old Port Airbnb", "17:13", "20:36", "named")] }));
    fs.writeFileSync(stmts, JSON.stringify({ _meta: { tz: "UTC" }, places: [
      { name: "hilton hotel for the AI conference", venue: "Hilton hotel", when_hint: "10:30", evidence: "hilton hotel for the AI conference" },
      { name: "meet Erin and Iris at Café Shade", venue: "Café Shade", when_hint: "20:32", evidence: "We're going to meet Erin and Iris at Café Shade" },
    ] }));
    const fake = fakeClaude(dir, [{ issues: [], verdict: "publish",
      candidates: [{ id: "c1", verdict: "absent", where: "8:17pm-10:37pm is The Old Port Airbnb; no stop is Café Shade" }] }]);
    const out = JSON.parse(run(fake).stdout);
    assert.deepEqual(out.candidates.map((c) => c.label), ["Café Shade"], "the Hilton answer is cleared in code");
    const missing = out.findings.filter((f) => f.kind === "missing");
    assert.deepEqual(missing.map((f) => f.headline), ["Café Shade, which you mentioned, is not in the summary"]);
    assert.equal(missing[0].severity, "high");
    assert.match(missing[0].checked, /no stop is Café Shade/, "the finding keeps where the model looked");
    // The same words at a stop the user did not answer are not cleared in code: the model settles them.
    fs.writeFileSync(FILES.day, JSON.stringify({ stops: [stopAt("s2", "Hilton Seaside City", "10:30", "10:56", "named")] }));
    const again = JSON.parse(run(fake, ["--no-model"]).stdout);
    assert.ok(again.candidates.some((c) => c.label === "Hilton hotel"), JSON.stringify(again.candidates));
  } finally { CLEAN(); try { fs.unlinkSync(stmts); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: the call paragraph's figures are the call's, not invented amounts; prose amounts are still checked (2026-10-21)", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  try {
    const call = `<p class="call" style="x">11:34pm · Call with Quinn</p><p class="call-talk" style="margin:-8px 0 12px;">You went over $2 million in August bookings and a target of $1 million per day.</p>`;
    fs.writeFileSync(FILES.manifest, JSON.stringify({ stops: [{ id: "s1", title: "Ping's" }],
      standout_transactions: [{ merchant: "Ping's", amount_usd: "$86.55" }] }));
    fs.writeFileSync(FILES.report, `<h1>Day</h1><h3>1:00pm · Ping's</h3><p>Lunch, $86.55.</p>${call}`);
    const fake = fakeClaude(dir, [{ issues: [], verdict: "publish" }]);
    const clean = JSON.parse(run(fake, ["--no-model"]).stdout).findings.filter((f) => f.kind === "invented");
    assert.deepEqual(clean, []);
    fs.writeFileSync(FILES.report, `<h1>Day</h1><h3>1:00pm · Ping's</h3><p>Lunch, $86.55, and $40 on wine.</p>${call}`);
    const stray = JSON.parse(run(fake, ["--no-model"]).stdout).findings.filter((f) => f.kind === "invented");
    assert.equal(stray.length, 1);
    assert.match(stray[0].detail, /\$40/);
    assert.ok(!/\$2|\$1\b/.test(stray[0].detail), stray[0].detail);
  } finally { CLEAN(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: an amount in a closed task's title is the task's own text, not an invented figure (2026-10-28)", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  try {
    const task = { id: "t1", title: "Card charged $25 twice: check billing", completed_at: "10:00" };
    fs.writeFileSync(FILES.manifest, JSON.stringify({ stops: [{ id: "s1", title: "Cafe" }],
      standout_transactions: [], tasks_completed: [task] }));
    const tasks = `<h2>Tasks closed today</h2><ul><li><b>10:00am</b> ${task.title}</li></ul>`;
    fs.writeFileSync(FILES.report, `<h1>Day</h1><h3>9:00am · Cafe</h3><p>Coffee.</p>${tasks}`);
    const fake = fakeClaude(dir, [{ issues: [], verdict: "publish" }]);
    assert.deepEqual(JSON.parse(run(fake, ["--no-model"]).stdout).findings.filter((f) => f.kind === "invented"), []);
    fs.writeFileSync(FILES.report, `<h1>Day</h1><h3>9:00am · Cafe</h3><p>Coffee, $9.</p>${tasks}`);
    const stray = JSON.parse(run(fake, ["--no-model"]).stdout).findings.filter((f) => f.kind === "invented");
    assert.equal(stray.length, 1);
    assert.match(stray[0].detail, /\$9/);
    assert.ok(!/\$25/.test(stray[0].detail), stray[0].detail);
  } finally { CLEAN(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the night before's calls (2026-10-22) -------------------------------------
// Oct 21, Old Port: at 12:38am the user wrote "We spoke about the team, fundraise and product",
// about Tuesday's 11pm call. Shown only Wednesday's 11:34pm call, the reviewer said that
// call was misdated and belonged to the night before.

const OCT20_CALL = { who: "Quinn", start: "2026-10-20T20:00:00.000Z", end: "2026-10-20T20:30:00.000Z",
                     status: "held", source: "calendar", minutes: 30 };
const OCT21_START = "2026-10-20T21:00:00.000Z";   // midnight in Old Port

test("priorNightCalls keeps the previous evening's calls and nothing earlier or later", () => {
  const morning = { ...OCT20_CALL, start: "2026-10-20T06:00:00.000Z", end: "2026-10-20T06:30:00.000Z" };
  const today = { ...OCT20_CALL, start: "2026-10-21T20:34:00.000Z", end: "2026-10-21T21:03:00.000Z" };
  assert.deepEqual(R.priorNightCalls([morning, OCT20_CALL, today], OCT21_START), [OCT20_CALL]);
  assert.deepEqual(R.priorNightCalls(null, OCT21_START), []);
  assert.deepEqual(R.priorNightCalls([OCT20_CALL], undefined), []);
});

test("factPack names the night before's call in local time, apart from the day's own calls", () => {
  const base = { date: "2026-10-21", manifest: { stops: [] }, day: { path: { tz: "Asia/Jerusalem" } }, statements: {}, corrections: [] };
  const text = R.factPack({ ...base, priorCalls: [OCT20_CALL] });
  assert.match(text, /CALLS THE NIGHT BEFORE \(from the previous day's summary; not this day's calls/);
  assert.match(text, /Tue, Oct 20 11:00pm-11:30pm Call with Quinn \[status held, calendar times\]/);
  assert.doesNotMatch(R.factPack({ ...base, priorCalls: [] }), /CALLS THE NIGHT BEFORE/);
  assert.doesNotMatch(R.factPack(base), /CALLS THE NIGHT BEFORE/);
});

test("CLI: the reviewer is shown the night before's call when the previous day had one", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  try {
    fs.writeFileSync(path.join(dir, "prior-calls.json"), JSON.stringify([OCT20_CALL]));
    const fake = fakeClaude(dir, [{ issues: [], verdict: "publish" }]);
    const r = run(fake);
    assert.equal(r.status, 0, r.stderr);
    const [call] = fake.prompts();
    assert.match(call.stdin, /CALLS THE NIGHT BEFORE/);
    assert.match(call.stdin, /Call with Quinn \[status held, calendar times\]/);
  } finally { CLEAN(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- places the user named: code clears, the model judges (2026-10-27) ---------------
// In the week of Oct 20, 11 of 19 fixes for Jori misdescribing itself were a word
// test calling something missing that the report carried: "The Old Man & The Sea"
// for the user's "the old man and the sea" (Oct 20, and Bistro Example under its Hebrew name), the user's
// "Hilton hotel" answer saved as "Hilton Seaside City" (Oct 21), "Ben and Ora's" as
// the user's parents' home (Oct 24), "Elm 12" as "The Example home" (Oct 26). A place code
// cannot match is now a candidate the review call settles, and the model can clear
// it only by quoting the stop heading that carries it.

const CAND = (id, type, label, extra = {}) => ({ id, type, label, evidence: label, when: "19:15",
  missing: { kind: "missing", severity: "high", fix_by: "fork", headline: `${label}, which you mentioned, is not in the summary`,
    detail: `the user named "${label}" and it is not in the report`, fix: "add it as a stop" }, ...extra });
const HEADINGS = ["1:30pm · Pinat HaShlosha (פינת השלושה) · with Sam", "5:14pm · Parents' home, Hill Town · with Sam + Ora + Eve + Ben",
  "7:17pm · The Example home · with Alex + Sam + Erin + Iris", "8:06pm · ראיסה · with Sam + Dana + Lior"];
// Headings of stops that name no place, as the renderer prints them (the critic's cases, 2026-10-27).
const PLACEHOLDERS = ["7:17pm · unlabeled · with Alex + Sam", "9:28am · not a stop", "8:40am · Rothschild Blvd · walking · with Sam"];
const REPORT_TEXT = [HEADINGS[0], "Lunch, then coffee at Milk Bakery.", HEADINGS[1], "The evening at Ben and Ora's.", HEADINGS[2],
  "A long barbecue.", HEADINGS[3], ...PLACEHOLDERS, "9:00pm · Ozi · with Noa", "11:59pm · Old Port", "Day's other anchors", "Also: Café Shade Bar $40",
  "Tasks closed today", "7:45pm Call Café Shade about the booking"].join("\n");
// "11:59pm · Old Port" is a heading no stop of the day renders (a report out of step with its day file).
const settle = (cands, answers) => R.settleCandidates(cands, answers, { judged: true, reportText: REPORT_TEXT,
  headings: [...HEADINGS, ...PLACEHOLDERS, "9:00pm · Ozi · with Noa", "11:59pm · Old Port"],
  namedHeadings: [...HEADINGS, "9:00pm · Ozi · with Noa"], unnamedHeadings: PLACEHOLDERS });

test("quoteInStopTitle: only a quote inside a stop heading that covers its title points at a place", () => {
  // the replay's real answers: the heading under another name
  assert.ok(R.quoteInStopTitle("5:14pm · Parents' home, Hill Town · with Sam + Ora + Eve + Ben", HEADINGS), "Ben and Ora's");
  assert.ok(R.quoteInStopTitle("7:17pm · The Example home", HEADINGS), "Elm 12");
  assert.ok(R.quoteInStopTitle("8:06pm · ראיסה · with Sam + Dana + Lior", HEADINGS), "Bistro Example in Hebrew");
  assert.ok(R.quoteInStopTitle("Parents’ home, Hill Town", HEADINGS), "the title alone, curly apostrophe");
  // the critic's cases
  assert.ok(!R.quoteInStopTitle("then coffee at Milk Bakery", HEADINGS), "a sentence of prose");
  assert.ok(!R.quoteInStopTitle("7:17pm", HEADINGS), "a clock time inside a heading names no place");
  assert.ok(!R.quoteInStopTitle("7:17pm · ", HEADINGS), "the time and a separator");
  assert.ok(!R.quoteInStopTitle("with Sam + Ora + Eve + Ben", HEADINGS), "the companions alone");
  assert.ok(!R.quoteInStopTitle("7:45pm Call Café Shade about the booking", HEADINGS), "a task line");
  assert.ok(!R.quoteInStopTitle("Also: Café Shade Bar $40", HEADINGS), "Day's other anchors");
  assert.ok(!R.quoteInStopTitle("5:14pm · Parents' home … Example home", HEADINGS), "pieces from two different headings");
  assert.ok(!R.quoteInStopTitle("Lass", HEADINGS), "too short to point at anything");
  assert.ok(!R.quoteInStopTitle(undefined, HEADINGS));
  assert.ok(!R.quoteInStopTitle("7:17pm · The Example home", []));
});

test("settleCandidates: absent stays high, a named stop's heading clears, any other quote in the report is high, the rest is medium", () => {
  const cands = [
    CAND("c1", "place", "Ben and Ora's"), CAND("c2", "place", "Elm 12 (the Example home)"), CAND("c3", "place", "Bistro Example"),
    CAND("c4", "place", "Milk Bakery"), CAND("c5", "place", "Café Shade"), CAND("c6", "place", "Café Shade Bar"), CAND("c7", "place", "Mezcal"),
    CAND("c8", "place", "Ozi Bar"), CAND("c9", "place", "Falafel Corner"), CAND("c10", "place", "Falafel Example"), CAND("c11", "place_time", "stopped for gas"),
    CAND("c12", "place", "Elm 12"), CAND("c13", "place", "Port Said"), CAND("c14", "place", "Rothschild 22"), CAND("c15", "place", "Ozi"),
    CAND("c16", "place", "Old Port Port"),
  ];
  const answers = [
    { id: "c1", verdict: "present", quote: "5:14pm · Parents' home, Hill Town · with Sam + Ora + Eve + Ben", where: "the user's parents' home" },
    { id: "c2", verdict: "present", quote: "7:17pm · The Example home", where: "the user said Elm 12 is their home" },
    { id: "c3", verdict: "present", quote: "8:06pm · ראיסה", where: "Bistro Example in Hebrew" },
    { id: "c4", verdict: "present", quote: "then coffee at Milk Bakery", where: "the lunch prose names it" },        // prose only
    { id: "c5", verdict: "present", quote: "7:17pm", where: "the evening stop" },                                       // a clock time
    { id: "c6", verdict: "present", quote: "7:45pm Call Café Shade about the booking", where: "the task names it" },        // a task line
    { id: "c7", verdict: "absent", where: "no stop near 9pm is Mezcal" },
    { id: "c8", verdict: "present", quote: "9:00pm · Ozi Bar · with Sam", where: "the late stop" },                     // not in the report
    { id: "c9", verdict: "unsure", where: "the facts do not say" },
    { id: "zz", verdict: "absent", where: "an id code never asked about is ignored" },
    // the critic's placeholder headings: a stop that names no place clears nothing
    { id: "c12", verdict: "present", quote: "7:17pm · unlabeled · with Alex + Sam", where: "the evening stop, the user's answer" },
    { id: "c13", verdict: "present", quote: "9:28am · not a stop", where: "the morning stretch" },
    { id: "c14", verdict: "present", quote: "8:40am · Rothschild Blvd · walking", where: "the walk" },
    { id: "c15", verdict: "present", quote: "Ozi", where: "the late stop" },                                               // a bare short title
    { id: "c16", verdict: "present", quote: "11:59pm · Old Port", where: "the last stop" },                               // no stop renders it
  ];
  const { findings, record } = settle(cands, answers);
  assert.deepEqual(record.map((r) => [r.id, r.outcome, r.quote_shows || null]), [
    ["c1", "cleared", "named_title"], ["c2", "cleared", "named_title"], ["c3", "cleared", "named_title"], ["c4", "missing", "elsewhere"],
    ["c5", "missing", "no_title"], ["c6", "missing", "elsewhere"], ["c7", "missing", null], ["c8", "unconfirmed", "not_found"],
    ["c9", "unconfirmed", null], ["c10", "unconfirmed", null], ["c11", "unconfirmed", null],
    ["c12", "missing", "placeholder"], ["c13", "missing", "placeholder"], ["c14", "missing", "placeholder"], ["c15", "unconfirmed", "too_short"],
    ["c16", "missing", "unmatched"]]);
  const by = (label) => findings.find((f) => f.detail.includes(`"${label}"`));
  for (const label of ["Milk Bakery", "Café Shade", "Café Shade Bar", "Mezcal", "Elm 12", "Port Said", "Rothschild 22", "Old Port Port"]) {
    const f = by(label);
    assert.equal(f.severity, "high", label);
    assert.equal(f.headline, `${label}, which you mentioned, is not in the summary`, label);
    assert.equal(f.detail, `the user named "${label}" and it is not in the report`, `${label}: same detail as before, so the ledger dedupes`);
    assert.equal(f.settled_by, "model");
  }
  assert.match(by("Milk Bakery").checked, /evidence is in no stop heading: "then coffee at Milk Bakery"/);
  assert.match(by("Café Shade").checked, /part of a stop heading but not the stop's name: "7:17pm"/);
  assert.match(by("Elm 12").checked, /a heading that names no place \(an unlabeled stop, a walk, or a stretch that was not a stop\): "7:17pm · unlabeled/);
  assert.match(by("Mezcal").checked, /no stop near 9pm is Mezcal/);
  assert.match(by("Old Port Port").checked, /a heading that no stop in the day's data produces/);
  for (const [label, why] of [["Ozi Bar", /quoted text the report does not have/], ["Falafel Corner", /could not tell: the facts do not say/],
    ["Falafel Example", /gave no answer for it/], ["stopped for gas", /gave no answer/], ["Ozi", /quote is too short to point at one stop heading/]]) {
    const f = by(label);
    assert.equal(f.severity, "medium", label);
    assert.equal(f.unconfirmed, true, label);
    assert.equal(f.fix_by, "fork", label);
    assert.match(f.detail, why, label);
  }
  assert.doesNotMatch(by("Ozi").detail, /does not have/, "a short quote of a real title is not called text the report lacks");
  assert.equal(by("stopped for gas").headline, 'I couldn\'t confirm that "stopped for gas", which you mentioned, is in the summary');
  assert.equal(findings.length, 13);
});

// Which headings name a place is read from the stop data the report was rendered
// from, by rendering each stop's heading again, never from the heading's words.
test("classifyStopHeadings: a heading names a place only when its stop names a venue; unlabeled, not-a-stop, walking and walk blocks never", () => {
  const day = { tz: "Asia/Jerusalem", stops: [
    { id: "u", start: "19:17", duration_min: 200, companions: ["Alex", "Sam"], provenance: { certainty: "none", title: null } },
    { id: "n", start: "09:28", duration_min: 40, provenance: { non_stop: true, certainty: "none" } },
    { id: "w", start: "08:40", duration_min: 40, companions: ["Sam"], provenance: { title_kind: "movement", title: "Rothschild Blvd", movement_verb: "walking", certainty: "known" } },
    { id: "x", start: "18:42", duration_min: 30, excursion: true, provenance: { excursion: true, title: "Walk around Suk A-Dir", certainty: "known" } },
    { id: "v", start: "17:14", duration_min: 120, companions: ["Sam", "Ora", "Ben"], provenance: { certainty: "answered", title: "Parents' home, Hill Town" } },
    { id: "g", start: "22:15", duration_min: 60, provenance: { certainty: "guess", title_kind: "venue", title: "The Old Port Airbnb" } },
    { id: "q", start: "23:30", duration_min: 5, provenance: { certainty: "answered", title: "A short errand" } },      // answered: still a main stop
  ] };
  const text = (s) => R.headingTextOf(stopHeaderHtml(s, day));
  const lines = day.stops.map(text);
  assert.deepEqual(lines.slice(0, 3), ["7:17pm · unlabeled · with Alex + Sam", "9:28am · not a stop", "8:40am · Rothschild Blvd · walking · with Sam"],
    "the critic's three headings, as the renderer prints them");
  const k = R.classifyStopHeadings(day, [...lines, "1:00pm · Ping's"]);
  assert.deepEqual(k.named, ["5:14pm · Parents' home, Hill Town · with Sam + Ora + Ben", "10:15pm · The Old Port Airbnb · likely", "11:30pm · A short errand"]);
  assert.deepEqual(k.unnamed, [...lines.slice(0, 3), lines[3]], "the three placeholders and the walk block");
  assert.ok(!k.named.includes("1:00pm · Ping's") && !k.unnamed.includes("1:00pm · Ping's"), "a heading no stop renders is in neither");
  assert.deepEqual(R.classifyStopHeadings(null, lines), { named: [], unnamed: [] });
  assert.equal(R.isNamedVenueStop({ place: { name: "Ping's" } }), true, "no provenance: the resolver's name");
  assert.equal(R.isNamedVenueStop({}), false, "no provenance and no name: 'unknown near …'");
});

test("settleCandidates: when the model did not run, every candidate is unconfirmed and says why; none vanishes", () => {
  const { findings, record } = R.settleCandidates([CAND("c1", "place", "Milk Bakery")],
    [{ id: "c1", verdict: "present", quote: "7:17pm · The Example home", where: "x" }],
    { judged: false, reportText: REPORT_TEXT, headings: HEADINGS, namedHeadings: HEADINGS, unnamedHeadings: [], why: "the review did not run (Not logged in)" });
  assert.equal(record[0].outcome, "unconfirmed");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].detail, /the review did not run \(Not logged in\)/);
  assert.deepEqual(R.settleCandidates([], [], { judged: true }), { findings: [], record: [] });
});

test("quotedInReport: a quote must really be in the report, typography aside", () => {
  assert.ok(R.quotedInReport("then coffee at Milk Bakery", REPORT_TEXT));
  assert.ok(R.quotedInReport("“5:14pm · Parents’ home, Hill Town”", REPORT_TEXT), "curly quotes");
  assert.ok(R.quotedInReport("1:30pm · Pinat HaShlosha … Milk Bakery", REPORT_TEXT), "an ellipsis joins two real pieces");
  assert.ok(!R.quotedInReport("Parents' home … Café Shade Bar Seaside City", REPORT_TEXT), "every piece must be there");
  assert.ok(!R.quotedInReport("Rehov", REPORT_TEXT), "too short");
  assert.ok(!R.quotedInReport(undefined, REPORT_TEXT));
  assert.ok(!R.quotedInReport("anything at all", ""));
});

test("the review prompt puts the static rubric first and the day's facts, report and candidates after it", () => {
  const cands = [CAND("c1", "place", "Elm 12", { evidence: "Yes. Elm 12 is their home." }), CAND("c2", "place_time", "stopped for gas", { when: "19:55" })];
  const full = R.reviewPrompt({ facts: "THE-FACTS", reportText: "THE-REPORT", known: ["K1"], candidates: cands });
  assert.ok(full.startsWith(R.REVIEW_RUBRIC), "the static rubric is the prefix");
  const order = ["EVIDENCE, STRONGEST FIRST", "CANDIDATES (places the user named)", "FACTS (the inputs the report was built from):",
    "THE-FACTS", "THE-REPORT", "ALREADY CAUGHT BY CODE CHECKS", "CANDIDATES TO SETTLE"].map((n) => full.indexOf(n));
  assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), `order: ${order}`);
  assert.match(full, /- c1 · a place the user named: "Elm 12" · the user's words: "Yes\. Elm 12 is their home\." · about 19:15/);
  assert.match(full, /- c2 · a stop the user described \(no place name\): "stopped for gas" · about 19:55 · code found no stop covering that time/);
  assert.match(R.REVIEW_RUBRIC, /Only the header of a stop that names a place counts: an "unlabeled" stop/);
  // The rubric is the same on every call: nothing of the day is in it.
  for (const dayText of ["THE-FACTS", "THE-REPORT", "K1", "Elm 12"]) assert.ok(!R.REVIEW_RUBRIC.includes(dayText), dayText);
  assert.ok(!R.reviewDayPart({ facts: "F", reportText: "T" }).includes("EVIDENCE, STRONGEST FIRST"));
  assert.doesNotMatch(R.reviewDayPart({ facts: "F", reportText: "T" }), /CANDIDATES TO SETTLE|settle every candidate/);
  assert.deepEqual(R.REVIEW_SCHEMA.required, ["issues", "verdict", "candidates"]);
});

// The week's false findings, rebuilt from data/daily-summary-fix and the day
// files (stubbed model): each word-test miss is a candidate, the model's "present"
// quoting the heading clears it, a stop planted as removed is still reported, and a
// closed task stays a code check (its "&" title is found without the model).
test("CLI: the week's false 'missing' findings are settled by the review call; a removed stop is still reported", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  const stmts = `/tmp/day-statements-${DATE}.json`;
  try {
    const named = (id, start, title, companions) => ({ id, start, duration_min: 90, companions, provenance: { certainty: "answered", title } });
    const day = { tz: "Asia/Jerusalem", stops: [named("s1", "17:14", "Parents' home, Hill Town", ["Sam", "Ora", "Ben"]),
      named("s2", "19:17", "The Example home", ["Alex", "Sam", "Erin", "Iris"]), named("s3", "20:06", "ראיסה", ["Sam", "Dana", "Lior"])],
      tasks_completed: [{ title: "Re: Unit 1C & 1D probes & survey", completed_at: "19:45" }] };
    fs.writeFileSync(FILES.report, "<h1>Day</h1>" + day.stops.map((s) => `<div class="visit">${stopHeaderHtml(s, day)}<p>${s.id}.</p></div>`).join("")
      + "<ul><li><b>7:45pm</b> Re: Unit 1C &amp; 1D probes &amp; survey</li></ul>");
    fs.writeFileSync(FILES.day, JSON.stringify(day));
    fs.writeFileSync(stmts, JSON.stringify({ places: [
      // "place" is in no title, so the word pass cannot clear it (the day's real "Ben and Ora's" it can)
      { name: "Ben and Ora", venue: "Ben and Ora's place", evidence: "After Ben and Ora we drove to Nana.", when_hint: "17:14" },
      { name: "Elm 12 is their home", venue: "Elm 12 (the Example home)", evidence: "Yes. Elm 12 is their home.", when_hint: "19:15" },
      { name: "Bistro Example", venue: "Bistro Example", evidence: "dinner at Bistro Example with Dana and Lior", when_hint: "20:06" },
      { name: "Milk Bakery", venue: "Milk Bakery", evidence: "coffee at Milk Bakery", when_hint: "14:28" },   // planted: removed from the report
    ] }));
    const fake = fakeClaude(dir, [{ issues: [], verdict: "publish", candidates: [
      { id: "c1", verdict: "present", quote: "5:14pm · Parents' home, Hill Town · with Sam + Ora + Ben", where: "the user's parents' home" },
      { id: "c2", verdict: "present", quote: "7:17pm · The Example home", where: "the user said Elm 12 is the Lassers' home" },
      { id: "c3", verdict: "present", quote: "8:06pm · ראיסה · with Sam + Dana + Lior", where: "the Hebrew name of Bistro Example" },
      { id: "c4", verdict: "absent", where: "no stop near 2:28pm and no Milk Bakery anywhere in the report" },
    ] }]);
    const r = run(fake);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.candidates.map((c) => [c.label, c.outcome]),
      [["Ben and Ora's place", "cleared"], ["Elm 12 (the Example home)", "cleared"], ["Bistro Example", "cleared"], ["Milk Bakery", "missing"]]);
    const missing = out.findings.filter((f) => f.kind === "missing");
    assert.deepEqual(missing.map((f) => [f.severity, f.headline]), [["high", "Milk Bakery, which you mentioned, is not in the summary"]]);
    assert.equal(r.status, 3, "a stop really missing still blocks the send");
    assert.equal(out.confirmed, false);
    const calls = fake.prompts();
    assert.equal(calls.length, 1, "the candidates ride the one review call");
    // The rubric goes as an appended system prompt (cached); stdin starts with the day.
    const sys = calls[0].args[calls[0].args.indexOf("--append-system-prompt") + 1];
    assert.equal(sys, R.REVIEW_RUBRIC);
    assert.ok(calls[0].stdin.startsWith("FACTS (the inputs the report was built from)"), calls[0].stdin.slice(0, 80));
    assert.ok(!calls[0].stdin.includes("EVIDENCE, STRONGEST FIRST"));
    assert.match(calls[0].stdin, /CANDIDATES TO SETTLE[\s\S]*c1 · a place the user named: "Ben and Ora's place"[\s\S]*c4 · a place the user named: "Milk Bakery"/);
    assert.doesNotMatch(calls[0].stdin, /CANDIDATES TO SETTLE[\s\S]*Unit 1C/, "a closed task is never a candidate");
  } finally { CLEAN(); try { fs.unlinkSync(stmts); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});

// The critic's case (2026-10-27): the review calls Milk Bakery absent, a prose repair
// for another issue writes "then coffee at Milk Bakery", and the re-review says it is
// present, quoting that sentence. A sentence is not a stop: it stays a high finding.
test("CLI: a prose repair that names a missing place does not clear it; it stays high and blocks", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  const stmts = `/tmp/day-statements-${DATE}.json`;
  try {
    fs.writeFileSync(stmts, JSON.stringify({ places: [{ name: "Milk Bakery", venue: "Milk Bakery", evidence: "coffee at Milk Bakery", when_hint: "13:40" }] }));
    const fake = fakeClaude(dir, [
      { issues: [GPS_ISSUE], verdict: "revise", candidates: [{ id: "c1", verdict: "absent", where: "the only stop is Ping's" }] },
      { edits: [{ slot: "prose", id: "s1", text: "Lunch at Ping's, then coffee at Milk Bakery.", why: "GPS sentence is banned" }], unfixable: [] },
      { issues: [], verdict: "publish", candidates: [{ id: "c1", verdict: "present", quote: "then coffee at Milk Bakery", where: "the lunch prose" }] },
    ]);
    const r = run(fake, ["--repair"]);
    const out = JSON.parse(r.stdout);
    assert.equal(fake.prompts().length, 3, "review, repair, re-review");
    const f = out.findings.filter((x) => x.kind === "missing");
    assert.deepEqual(f.map((x) => [x.severity, x.headline]), [["high", "Milk Bakery, which you mentioned, is not in the summary"]]);
    assert.match(f[0].checked, /evidence is in no stop heading/);
    assert.equal(out.candidates[0].outcome, "missing");
    assert.equal(r.status, 3, "exit 3, as before the change");
    assert.equal(out.confirmed, false);
  } finally { CLEAN(); try { fs.unlinkSync(stmts); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: with the model down a candidate is unconfirmed (medium), kept out of the defects ledger, and the day is not confirmed", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  const stmts = `/tmp/day-statements-${DATE}.json`;
  try {
    fs.writeFileSync(stmts, JSON.stringify({ places: [{ name: "Milk Bakery", venue: "Milk Bakery", evidence: "coffee at Milk Bakery" }] }));
    const ledger = path.join(dir, "defects.jsonl");
    const r = spawnSync(process.execPath, [BIN, DATE], { encoding: "utf8", timeout: 60000,
      env: { ...process.env, CLAUDE_BIN: fakeClaude(dir, ["down"]).bin, JORI_FORK_COST_LEDGER: path.join(dir, "l.ndjson"),
        DS_REVIEW_NO_ROUTE: "", DS_REVIEW_DEFECTS_LEDGER: ledger, DS_REVIEW_PHOTOS_FILE: path.join(dir, "photos.json"),
        DS_REVIEW_PRIOR_CALLS_FILE: path.join(dir, "prior-calls.json") } });
    const out = JSON.parse(r.stdout);
    const f = out.findings.find((x) => x.kind === "missing");
    assert.equal(f.severity, "medium");
    assert.equal(f.unconfirmed, true);
    assert.match(f.detail, /the review did not run/);
    assert.equal(out.confirmed, false, "the gate holds the day for the fix loop");
    assert.equal(out.independent_review, "unavailable");
    assert.ok(!fs.existsSync(ledger) || !fs.readFileSync(ledger, "utf8").includes("Milk Bakery"), "not recorded as a code defect");
  } finally { CLEAN(); try { fs.unlinkSync(stmts); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});

// The critic's live case (2026-10-27): the Oct 26 evening rendered as the resolver
// shows it, an unnamed stop, and Opus answered "present" quoting "7:17pm ·
// unlabeled". An unlabeled stop is not the place the user named: it stays high.
test("CLI: a 'present' that quotes an unlabeled stop's heading does not clear the place the user named", () => {
  setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsr-"));
  const stmts = `/tmp/day-statements-${DATE}.json`;
  try {
    const day = { tz: "Asia/Jerusalem", stops: [{ id: "s4", start: "19:17", duration_min: 204, companions: ["Alex", "Sam"],
      provenance: { certainty: "none", title: null } }] };
    fs.writeFileSync(FILES.day, JSON.stringify(day));
    fs.writeFileSync(FILES.report, `<h1>Day</h1><div class="visit">${stopHeaderHtml(day.stops[0], day)}<p>A long evening.</p></div>`);
    fs.writeFileSync(stmts, JSON.stringify({ places: [{ name: "Elm 12 is their home", venue: "Elm 12 (the Example home)",
      evidence: "Yes. Elm 12 is their home.", when_hint: "19:15" }] }));
    const fake = fakeClaude(dir, [{ issues: [], verdict: "publish", candidates: [
      { id: "c1", verdict: "present", quote: "7:17pm · unlabeled · with Alex + Sam", where: "the user's answer was about this stop" }] }]);
    const r = run(fake);
    const out = JSON.parse(r.stdout);
    assert.match(fake.prompts()[0].stdin, /7:17pm · unlabeled · with Alex \+ Sam/, "the heading the model saw");
    assert.deepEqual(out.candidates.map((c) => [c.outcome, c.quote_shows]), [["missing", "placeholder"]]);
    const f = out.findings.filter((x) => x.kind === "missing");
    assert.deepEqual(f.map((x) => [x.severity, x.headline]), [["high", "Elm 12 (the Example home), which you mentioned, is not in the summary"]]);
    assert.equal(r.status, 3);
    assert.equal(out.confirmed, false);
  } finally { CLEAN(); try { fs.unlinkSync(stmts); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});
