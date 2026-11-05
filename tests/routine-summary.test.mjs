// The user's usual day as context for the models that name a stop
// (lib/routine-summary.js), and where it reaches them: stop-evidence's state and
// prompts, and the daily review's facts and rubric.
// The case: 2026-10-28, a 7:44pm stop at an evening market titled after a coffee
// shop 16 m away and narrated as "a second coffee", while the user's notes said
// coffee is a morning thing.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../lib/routine-summary.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "routine-summary-"));
const SCHEDULE = "| 8–9 AM | Morning coffee | With Pat |\n| ~1:00 PM | Lunch, main meal |\n| ~5-7 PM | Walk |";
const cfg = { pages: ["user_daily_schedule"], corrections_days: 30, max_age_days: 7, max_chars: 200 };
const NOW = Date.parse("2026-11-04T12:00:00Z");

function corrections(dir) {
  fs.writeFileSync(path.join(dir, "2026-10-28.jsonl"),
    JSON.stringify({ text: "We hardly ever have a second coffee and almost never in the evening." }) + "\n{torn\n");
  fs.writeFileSync(path.join(dir, "2026-08-01.jsonl"), JSON.stringify({ text: "too old to read" }) + "\n");
}

test("builds from the configured pages and recent corrections, then serves the cache", async () => {
  const dir = tmp(), file = path.join(dir, "cache.json"), corr = path.join(dir, "corr");
  fs.mkdirSync(corr); corrections(corr);
  const prompts = [];
  const run = async (p) => { prompts.push(p); return { summary: "Coffee is a morning thing (8-9am). Lunch ~1pm. Walk 5-7pm.", model: "m" }; };
  const readPage = (id) => (id === "user_daily_schedule" ? SCHEDULE : null);
  const a = await R.ensureRoutineSummary({ cfg, file, run, readPage, correctionsDir: corr, now: NOW });
  assert.equal(a.status, "rebuilt");
  assert.match(a.text, /morning/);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes("Morning coffee"), "the page reaches the model");
  assert.ok(prompts[0].includes("almost never in the evening"), "the user's correction reaches the model");
  assert.ok(!prompts[0].includes("too old to read"), "corrections outside the window are not read");
  const b = await R.ensureRoutineSummary({ cfg, file, run, readPage, correctionsDir: corr, now: NOW + 3600000 });
  assert.equal(b.status, "fresh");
  assert.equal(prompts.length, 1, "an unchanged source is not rebuilt");
  assert.equal(R.routineSummarySync({ file }), a.text);
});

test("rebuilds when a source changes or the cache is older than max_age_days", async () => {
  const dir = tmp(), file = path.join(dir, "cache.json");
  let n = 0;
  const run = async () => ({ summary: `version ${++n}` });
  let page = SCHEDULE;
  const opts = () => ({ cfg: { ...cfg, corrections_days: 0 }, file, run, readPage: () => page, correctionsDir: dir });
  await R.ensureRoutineSummary({ ...opts(), now: NOW });
  page = SCHEDULE + "\n| 10 PM | Back to work |";
  assert.equal((await R.ensureRoutineSummary({ ...opts(), now: NOW })).text, "version 2");
  assert.equal((await R.ensureRoutineSummary({ ...opts(), now: NOW + 8 * 86400000 })).text, "version 3");
});

test("a failed rebuild keeps the previous text; no sources means no summary", async () => {
  const dir = tmp(), file = path.join(dir, "cache.json");
  const base = { cfg: { ...cfg, corrections_days: 0 }, file, correctionsDir: dir, now: NOW };
  await R.ensureRoutineSummary({ ...base, readPage: () => SCHEDULE, run: async () => ({ summary: "old text" }) });
  const r = await R.ensureRoutineSummary({ ...base, readPage: () => SCHEDULE + " changed", run: async () => { throw new Error("timeout"); } });
  assert.equal(r.status, "stale");
  assert.equal(r.text, "old text");
  const none = await R.ensureRoutineSummary({ ...base, cfg: { ...cfg, pages: [], corrections_days: 0 }, run: async () => { throw new Error("must not be called"); } });
  assert.equal(none.status, "none");
  assert.equal(none.text, null);
});

test("the summary is bounded in size", () => {
  const long = "Coffee is a morning thing. ".repeat(40);
  const c = R.clip(long, 200);
  assert.ok(c.length <= 200);
  assert.ok(c.endsWith("."), "cut at a sentence end");
});

test("stop-evidence: the usual day rides in the state and the prompts say it only weighs", async () => {
  const se = await import("../lib/stop-evidence.mjs");
  const base = { start: NOW, end: NOW + 17 * 60000, tz: "UTC", rest: null, transcript: [], photos: [], candidates: [] };
  assert.equal(se.buildState(base).users_usual_day, undefined, "absent when there is no summary");
  const st = se.buildState({ ...base, routine: "Coffee is a morning thing." });
  assert.equal(st.users_usual_day, "Coffee is a morning thing.");
  const src = fs.readFileSync(new URL("../lib/stop-evidence.mjs", import.meta.url), "utf8");
  assert.ok(src.includes("never names a place by itself"), "the Sonnet prompt bounds the prior");
  const jev = JSON.parse(fs.readFileSync(new URL("../agent/config/jev-questions/stop-evidence.json", import.meta.url), "utf8"));
  assert.ok(jev.venue_template.instructions.includes("users_usual_day"), "the Jev template knows the field");
});

test("stop-evidence: evidenceVerdict hands the usual day to the decision", async () => {
  const se = await import("../lib/stop-evidence.mjs");
  let seen = null;
  const sb = async (q) => (q.startsWith("jori_messages")
    ? [{ role: "user", content: "browsing the market", created_at: new Date(NOW + 60000).toISOString() }] : []);
  const r = await se.evidenceVerdict({
    sb, start: NOW, end: NOW + 17 * 60000, tz: "UTC", rest: { lat: 32, lon: 34 }, near: () => [], id: "t",
    routine: "Coffee is a morning thing.", lookImpl: false,
    decideImpl: async ({ state, legacy }) => { seen = state; return { value: null }; },
  });
  assert.equal(r.settled, false);
  assert.equal(seen.users_usual_day, "Coffee is a morning thing.");
  assert.equal(r.summary.usual_day, true);
});

test("daily review: the usual day is in the facts and check E knows how to use it", () => {
  const DR = require("../lib/daily-summary-review.js");
  const facts = DR.factPack({ date: "2026-10-28", manifest: { stops: [] }, day: { tz: "UTC" }, statements: null, corrections: [],
    routine: "Coffee is a morning thing (8-9am)." });
  assert.ok(facts.includes("THE USER'S USUAL DAY"));
  assert.ok(facts.includes("Coffee is a morning thing (8-9am)."));
  const without = DR.factPack({ date: "2026-10-28", manifest: { stops: [] }, day: { tz: "UTC" }, statements: null, corrections: [] });
  assert.ok(!without.includes("THE USER'S USUAL DAY"));
  assert.ok(DR.REVIEW_RUBRIC.includes("THE USER'S USUAL DAY"));
  assert.ok(DR.REVIEW_RUBRIC.includes("a fit alone is not a finding"));
});
