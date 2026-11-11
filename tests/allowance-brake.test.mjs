// allowance-brake.test.mjs — the weekly-allowance brake holds a listed job only
// when the week is on pace past its threshold, fails open on every doubt, and
// releases a held weekly-slot job only after its window resets.
// Run: node --test tests/allowance-brake.test.mjs
//
// Fixture event logs and config in a temp dir; --state points the state file
// there too (which also turns off the real decision log), and `release` runs
// with --dry-run so launchctl is never called.

import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "allowance-brake");
const RESET = Date.parse("2026-11-05T03:00:00Z") / 1000;
const NOW = "2026-11-02T08:00:00Z";

function fixture({ points, config = { threshold: 0.95, jobs: { "improvement-plan": { release_label: "ai.test.plan" }, "dream-deep": {} } }, resetsAt = RESET }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allowance-brake-"));
  const logs = path.join(dir, "logs");
  fs.mkdirSync(path.join(logs, "supervisor-ops"), { recursive: true });
  fs.mkdirSync(path.join(logs, "supervisor-test-ops"), { recursive: true });
  const line = (ts, u) => JSON.stringify({ ts, kind: "rate_limit_event", rate_limit_info: { unifiedWindows: { seven_day: { utilization: u, resetsAt } } } });
  fs.writeFileSync(path.join(logs, "supervisor-ops", "events.ndjson"),
    points.map(([ts, u]) => line(ts, u)).join("\n") + "\n" + JSON.stringify({ ts: NOW, kind: "turn_end" }) + "\n");
  // A test supervisor at 99% must be ignored.
  fs.writeFileSync(path.join(logs, "supervisor-test-ops", "events.ndjson"), line("2026-11-02T07:59:00Z", 0.99) + "\n");
  const local = path.join(dir, "local");
  if (config) {
    fs.mkdirSync(path.join(local, "config"), { recursive: true });
    fs.writeFileSync(path.join(local, "config", "allowance-brake.json"), JSON.stringify(config));
  }
  return { dir, logs, local, state: path.join(dir, "state.json") };
}

function run(fx, args, now = NOW) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--events-dir", fx.logs, "--state", fx.state, "--now", now],
    { encoding: "utf8", env: { ...process.env, JORI_LOCAL_DIR: fx.local } });
  return { rc: r.status, out: r.stdout.trim(), json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
}

const HOT = [["2026-11-01T08:00:00Z", 0.45], ["2026-11-01T20:00:00Z", 0.55], ["2026-11-02T07:50:00Z", 0.66]];
const COOL = [["2026-11-01T08:00:00Z", 0.40], ["2026-11-02T07:50:00Z", 0.45]];

it("holds a listed job when the week is on pace past the threshold, and records a weekly-slot hold", () => {
  const fx = fixture({ points: HOT });
  const r = run(fx, ["check", "improvement-plan", "--json"]);
  assert.equal(r.rc, 3);
  assert.equal(r.json.decision, "hold");
  assert.ok(r.json.projected >= 0.95, `projected ${r.json.projected}`);
  const st = JSON.parse(fs.readFileSync(fx.state, "utf8"));
  assert.equal(st.held["improvement-plan"].release_label, "ai.test.plan");
  assert.equal(st.held["improvement-plan"].resets_at, "2026-11-05T03:00:00.000Z");
});

it("holds a job without a release label but keeps no record for it", () => {
  const fx = fixture({ points: HOT });
  assert.equal(run(fx, ["check", "dream-deep"]).rc, 3);
  assert.equal(fs.existsSync(fx.state), false);
});

it("runs when the pace stays under the threshold", () => {
  const fx = fixture({ points: COOL });
  const r = run(fx, ["check", "improvement-plan", "--json"]);
  assert.equal(r.rc, 0);
  assert.equal(r.json.decision, "run");
  assert.ok(r.json.projected < 0.95);
});

it("holds outright when the week is already past the threshold", () => {
  const fx = fixture({ points: [["2026-11-02T07:00:00Z", 0.96], ["2026-11-02T07:50:00Z", 0.96]] });
  assert.equal(run(fx, ["check", "dream-deep"]).rc, 3);
});

it("runs a job that is not listed, and runs everything when there is no config", () => {
  assert.equal(run(fixture({ points: HOT }), ["check", "nightly-review"]).rc, 0);
  assert.equal(run(fixture({ points: HOT, config: null }), ["check", "improvement-plan"]).rc, 0);
});

it("fails open on a stale reading, a window too young to rate, no samples, or a passed reset", () => {
  assert.equal(run(fixture({ points: [["2026-11-01T08:00:00Z", 0.5], ["2026-11-01T20:00:00Z", 0.8]] }), ["check", "dream-deep"]).rc, 0, "stale");
  assert.equal(run(fixture({ points: [["2026-11-02T05:00:00Z", 0.05], ["2026-11-02T07:50:00Z", 0.12]] }), ["check", "dream-deep"]).rc, 0, "young");
  assert.equal(run(fixture({ points: [] }), ["check", "dream-deep"]).rc, 0, "empty");
  assert.equal(run(fixture({ points: HOT, resetsAt: Date.parse("2026-11-02T07:55:00Z") / 1000 }), ["check", "dream-deep"]).rc, 0, "reset passed");
});

it("rates only the current window: samples before a reset do not count", () => {
  const old = Date.parse("2026-10-29T03:00:00Z") / 1000;
  const fx = fixture({ points: [["2026-11-01T10:00:00Z", 0.40], ["2026-11-02T07:50:00Z", 0.45]] });
  // A sample from the previous window (its own resetsAt) inside the 24h
  // lookback. Read as part of this window it would set the pace at ~37%/day
  // (0.10 -> 0.45) and hold; rated on this window alone the pace is ~5%/day.
  const f = path.join(fx.logs, "supervisor-ops", "events.ndjson");
  const prev = JSON.stringify({ ts: "2026-11-01T09:00:00Z", kind: "rate_limit_event", rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.10, resetsAt: old } } } });
  fs.writeFileSync(f, prev + "\n" + fs.readFileSync(f, "utf8"));
  assert.equal(run(fx, ["check", "improvement-plan"]).rc, 0);
});

it("releases a held weekly-slot job only after its window resets and the brake reads clear, and the next run reports the hold", () => {
  const fx = fixture({ points: HOT });
  assert.equal(run(fx, ["check", "improvement-plan"]).rc, 3);
  // Before the reset: nothing to release.
  assert.equal(run(fx, ["release", "--dry-run"]).out, "");
  // After the reset, with no fresh samples: the brake fails open, so it releases.
  const after = "2026-11-05T09:30:00Z";
  assert.match(run(fx, ["release", "--dry-run"], after).out, /would release improvement-plan: launchctl kickstart gui\/\d+\/ai\.test\.plan/);
  // Simulate the real release having kicked the agent.
  const st = JSON.parse(fs.readFileSync(fx.state, "utf8"));
  st.held["improvement-plan"].released_at = "2026-11-05T09:30:00.000Z";
  fs.writeFileSync(fx.state, JSON.stringify(st));
  assert.equal(run(fx, ["release", "--dry-run"], after).out, "", "a released hold is not kicked twice");
  // The relaunched trigger's check answers run, reports held_since, and clears the record.
  const r = run(fx, ["check", "improvement-plan", "--json"], after);
  assert.equal(r.rc, 0);
  assert.ok(r.json.held_since, "held_since reported");
  assert.equal(JSON.parse(fs.readFileSync(fx.state, "utf8")).held["improvement-plan"], undefined);
});

it("does not report or carry a hold the release never launched, or one from an earlier window", () => {
  const fx = fixture({ points: COOL });
  // An unreleased record whose window has passed: cleared on run, not reported.
  fs.writeFileSync(fx.state, JSON.stringify({ held: { "improvement-plan": { held_since: "2026-10-27T10:00:00.000Z", resets_at: "2026-10-29T03:00:00.000Z", release_label: "ai.test.plan" } } }));
  const r = run(fx, ["check", "improvement-plan", "--json"]);
  assert.equal(r.rc, 0);
  assert.equal(r.json.held_since, null);
  // A released record from an earlier window: a new hold starts a new held_since.
  const hot = fixture({ points: HOT });
  fs.writeFileSync(hot.state, JSON.stringify({ held: { "improvement-plan": { held_since: "2026-10-27T10:00:00.000Z", resets_at: "2026-10-29T03:00:00.000Z", released_at: "2026-10-29T09:30:00.000Z", release_label: "ai.test.plan" } } }));
  assert.equal(run(hot, ["check", "improvement-plan"]).rc, 3);
  const h = JSON.parse(fs.readFileSync(hot.state, "utf8")).held["improvement-plan"];
  assert.equal(h.held_since, "2026-11-02T08:00:00.000Z");
  assert.equal(h.released_at, undefined);
});

// ─── the governor: importance, cost estimate, the user's decision ───────────

const OPT_RUN = "Run it now on the usual model";
const OPT_CHEAPER = "Run it now on a cheaper model";
const OPT_DELAY = "Wait until the weekly allowance resets";
const GOV = {
  threshold: 0.95,
  jobs: {
    "chat-build": { importance: "important", release_label: "ai.test.build", cheaper: { model: "sonnet", effort: "high" }, label: "A chat build" },
    "chat-plain": { importance: "important" },
    "triage": { importance: "essential" },
    "big-optional": { importance: "optional", cost_estimate: 0.4 },
    "dream": { importance: "optional" },
  },
};

function answer(fx, id, text) {
  const st = JSON.parse(fs.readFileSync(fx.state, "utf8"));
  const q = st.questions.find((x) => x.id === id);
  q.status = "answered"; q.answer = text;
  fs.writeFileSync(fx.state, JSON.stringify(st));
}

it("asks the user once about an important job, and holds it while the question is open", () => {
  const fx = fixture({ points: HOT, config: GOV });
  const r = run(fx, ["check", "chat-build", "--key", "req-1", "--json"]);
  assert.equal(r.rc, 3);
  assert.match(r.json.reason, /asked you \(bud:chat-build-/); // lang-regex-ok: asserts the governor's own output, not the user's words
  let st = JSON.parse(fs.readFileSync(fx.state, "utf8"));
  assert.equal(st.questions.length, 1);
  const q = st.questions[0];
  assert.equal(q.status, "open");
  assert.equal(q.key, "req-1");
  assert.deepEqual(q.options, [OPT_RUN, OPT_CHEAPER, OPT_DELAY]);
  assert.ok(q.time_sensitive);
  assert.match(q.question, /^A chat build is ready to start/); // lang-regex-ok: asserts the governor's own output, not the user's words
  assert.equal(st.held["chat-build"].release_label, "ai.test.build");
  const again = run(fx, ["check", "chat-build", "--key", "req-1", "--json"]);
  assert.equal(again.rc, 3);
  assert.match(again.json.reason, /waiting for your answer/); // lang-regex-ok: asserts the governor's own output, not the user's words
  st = JSON.parse(fs.readFileSync(fx.state, "utf8"));
  assert.equal(st.questions.length, 1, "no second card while one is open");
});

it("offers no cheaper option when the job names no cheaper model", () => {
  const fx = fixture({ points: HOT, config: GOV });
  run(fx, ["check", "chat-plain"]);
  const st = JSON.parse(fs.readFileSync(fx.state, "utf8"));
  assert.deepEqual(st.questions[0].options, [OPT_RUN, OPT_DELAY]);
});

it("applies 'cheaper': relaunches the job, which then runs once on the cheaper model, and the next run asks again", () => {
  const fx = fixture({ points: HOT, config: GOV });
  run(fx, ["check", "chat-build", "--key", "req-1"]);
  const id = JSON.parse(fs.readFileSync(fx.state, "utf8")).questions[0].id;
  answer(fx, id, OPT_CHEAPER);
  const a = run(fx, ["apply", `bud:${id}`]);
  assert.equal(a.rc, 0);
  assert.match(a.out, /chat-build: cheaper; would kick ai\.test\.build/); // lang-regex-ok: asserts the governor's own output, not the user's words
  const r = run(fx, ["check", "chat-build", "--key", "req-1", "--json"]);
  assert.equal(r.rc, 4);
  assert.equal(r.json.decision, "cheaper");
  assert.equal(r.json.model, "sonnet");
  assert.equal(r.json.effort, "high");
  const next = run(fx, ["check", "chat-build", "--key", "req-2", "--json"]);
  assert.equal(next.rc, 3);
  assert.match(next.json.reason, /asked you/);
});

it("applies 'run now' and 'wait for the reset'", () => {
  const fx = fixture({ points: HOT, config: GOV });
  run(fx, ["check", "chat-build", "--key", "req-1"]);
  let id = JSON.parse(fs.readFileSync(fx.state, "utf8")).questions[0].id;
  answer(fx, id, OPT_RUN);
  run(fx, ["apply", `bud:${id}`]);
  assert.equal(run(fx, ["check", "chat-build", "--key", "req-1"]).rc, 0);

  run(fx, ["check", "chat-build", "--key", "req-2"]);
  id = JSON.parse(fs.readFileSync(fx.state, "utf8")).questions.find((q) => q.key === "req-2").id;
  answer(fx, id, OPT_DELAY);
  assert.match(run(fx, ["apply", `bud:${id}`]).out, /chat-build: delay; recorded/); // lang-regex-ok: asserts the governor's own output, not the user's words
  const r = run(fx, ["check", "chat-build", "--key", "req-2", "--json"]);
  assert.equal(r.rc, 3);
  assert.match(r.json.reason, /you chose to wait for the reset/);
});

it("an answer in other words keeps the question open and the job held", () => {
  const fx = fixture({ points: HOT, config: GOV });
  run(fx, ["check", "chat-build"]);
  const id = JSON.parse(fs.readFileSync(fx.state, "utf8")).questions[0].id;
  answer(fx, id, "hmm, maybe later?");
  assert.match(run(fx, ["apply", `bud:${id}`]).out, /not one of the options/);
  assert.equal(JSON.parse(fs.readFileSync(fx.state, "utf8")).questions[0].status, "open");
});

it("runs an essential job whatever the week, and closes an open question once the week is no longer over", () => {
  assert.equal(run(fixture({ points: HOT, config: GOV }), ["check", "triage"]).rc, 0);
  const fx = fixture({ points: HOT, config: GOV });
  run(fx, ["check", "chat-build"]);
  // Same state, a cool week: the job just runs and its question is closed.
  const cool = fixture({ points: COOL, config: GOV });
  fs.copyFileSync(fx.state, cool.state);
  assert.equal(run(cool, ["check", "chat-build"]).rc, 0);
  assert.match(JSON.parse(fs.readFileSync(cool.state, "utf8")).questions[0].status, /^closed:/);
});

it("adds the run's own cost: a cool week still holds an optional job whose run would push it past the threshold", () => {
  const fx = fixture({ points: COOL, config: GOV });
  const r = run(fx, ["check", "big-optional", "--json"]);
  assert.equal(r.rc, 3);
  assert.equal(r.json.estimate.share, 0.4);
  assert.match(r.json.reason, /this run adds ~40%/);
});

it("learns a job's cost from its ledger, priced by what the pace span cost", () => {
  const fx = fixture({ points: HOT, config: GOV });
  const dir = path.join(fx.logs, "ephemeral-forks");
  fs.mkdirSync(dir, { recursive: true });
  // The span (2026-11-01T08:00 -> 2026-11-02T07:50) moved the week 0.21 and cost $210: $1000 per allowance.
  const rows = [
    { ts: "2026-11-01T10:00:00Z", source: "dream", total_cost_usd: 10 },
    { ts: "2026-11-01T22:00:00Z", source: "dream", total_cost_usd: 10 },
    { ts: "2026-11-02T05:00:00Z", source: "hum", total_cost_usd: 190 },
  ];
  fs.writeFileSync(path.join(dir, "job-costs.ndjson"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const r = run(fx, ["status", "--json"]);
  assert.equal(Math.round(r.json.usd_per_allowance.usd), 1000);
  assert.equal(r.json.usd_per_allowance.basis, "measured");
  assert.equal(r.json.jobs.dream.estimate.share, 0.01);
  assert.equal(r.json.jobs.dream.estimate.runs, 2);
});

it("prices a job from its runs of the last month, not months-old ones", () => {
  const fx = fixture({ points: HOT, config: { ...GOV, usd_per_allowance: 1000 } });
  const dir = path.join(fx.logs, "ephemeral-forks");
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    ...[1, 2, 3, 4, 5, 6].map((d) => ({ ts: `2026-07-0${d}T10:00:00Z`, source: "dream", total_cost_usd: 1 })),
    { ts: "2026-10-27T10:00:00Z", source: "dream", total_cost_usd: 20 },
    { ts: "2026-11-02T01:00:00Z", source: "dream", total_cost_usd: 22 },
  ];
  fs.writeFileSync(path.join(dir, "job-costs.ndjson"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const r = run(fx, ["status", "--json"]);
  assert.equal(r.json.jobs.dream.estimate.runs, 2);
  assert.equal(r.json.jobs.dream.estimate.usd, 21);
});

it("relaunches a held job before the reset once the pace leaves room for it, but not one the user chose to hold until the reset", () => {
  const cfg = { threshold: 0.95, jobs: { "nightly": { importance: "optional", release_label: "ai.test.nightly" }, "chat-build": GOV.jobs["chat-build"] } };
  const hot = fixture({ points: HOT, config: cfg });
  assert.equal(run(hot, ["check", "nightly"]).rc, 3);
  assert.equal(run(hot, ["release", "--dry-run"]).out, "", "still over: nothing released");
  // The same held record, a week that has cooled down (reset still ahead).
  const cool = fixture({ points: COOL, config: cfg });
  fs.copyFileSync(hot.state, cool.state);
  assert.match(run(cool, ["release", "--dry-run"]).out, /would release nightly: launchctl kickstart gui\/\d+\/ai\.test\.nightly/); // lang-regex-ok: asserts the governor's own output

  // "Wait for the reset" holds even when the week cools.
  run(hot, ["check", "chat-build"]);
  const st = JSON.parse(fs.readFileSync(hot.state, "utf8"));
  const id = st.questions.find((q) => q.job === "chat-build").id;
  answer(hot, id, OPT_DELAY);
  run(hot, ["apply", `bud:${id}`]);
  fs.copyFileSync(hot.state, cool.state);
  const out = run(cool, ["release", "--dry-run"]).out;
  assert.ok(!out.includes("chat-build"), out);
});

// The last-day brake: inside final_day.hours before the reset the lower
// threshold applies, to check and release alike; earlier in the week it does not.
const FINAL = { threshold: 0.95, final_day: { hours: 24, threshold: 0.90 }, jobs: { "nightly": { importance: "optional", release_label: "ai.test.nightly" } } };
// 0.84 -> 0.89 over 22h (~5.5%/day): 16h before the reset -> projected ~0.93.
const LAST_DAY = [["2026-11-03T13:00:00Z", 0.84], ["2026-11-04T11:00:00Z", 0.89]];
const LAST_DAY_NOW = "2026-11-04T11:10:00Z";

it("holds at the final-day threshold in the last hours before the reset, where the usual one would let it run", () => {
  const usual = fixture({ points: LAST_DAY, config: { ...FINAL, final_day: undefined } });
  const u = run(usual, ["check", "nightly", "--json"], LAST_DAY_NOW);
  assert.equal(u.rc, 0, u.out);
  assert.ok(u.json.projected > 0.90 && u.json.projected < 0.95, `projected ${u.json.projected}`);

  const fx = fixture({ points: LAST_DAY, config: FINAL });
  const r = run(fx, ["check", "nightly", "--json"], LAST_DAY_NOW);
  assert.equal(r.rc, 3, r.out);
  assert.equal(r.json.threshold, 0.90);
  assert.ok(r.json.reason.includes("90% last-day brake"), r.json.reason);
  // The held job is not released while the last-day brake still says over.
  assert.equal(run(fx, ["release", "--dry-run"], "2026-11-04T12:00:00Z").out, "");
});

it("keeps the usual threshold earlier in the week, and status reports both", () => {
  const fx = fixture({ points: COOL, config: FINAL });
  const s = run(fx, ["status", "--json"]);
  assert.equal(s.json.threshold, 0.95, "three days before the reset: the usual brake");
  assert.equal(s.json.usual_threshold, 0.95);
  assert.deepEqual(s.json.final_day, { threshold: 0.90, hours: 24 });
  const late = run(fixture({ points: LAST_DAY, config: FINAL }), ["status", "--json"], LAST_DAY_NOW);
  assert.equal(late.json.threshold, 0.90, "16h before the reset: the last-day brake");
});

it("ignores a malformed final_day and keeps one threshold", () => {
  const fx = fixture({ points: LAST_DAY, config: { ...FINAL, final_day: { hours: 24, threshold: 1.5 } } });
  const r = run(fx, ["check", "nightly", "--json"], LAST_DAY_NOW);
  assert.equal(r.rc, 0, r.out);
  assert.equal(r.json.threshold, 0.95);
});

// The early window: a half-day span is not rated, and a run the governor released
// at the reset is a catch-up, not the week's pace.
it("does not rate a span shorter than a day: the nightly batch is not extrapolated over the week", () => {
  const fx = fixture({ points: [["2026-11-01T18:00:00Z", 0.02], ["2026-11-02T07:50:00Z", 0.15]] });
  const r = run(fx, ["check", "dream-deep", "--json"]);
  assert.equal(r.rc, 0, r.out);
  assert.ok(r.json.reason.includes("of this window to rate"), r.json.reason);
});

it("scales the pace down by a released job's catch-up share of the span's ledger spend, capped at half", () => {
  const points = [["2026-11-01T10:00:00Z", 0.50], ["2026-11-02T07:50:00Z", 0.62]]; // 12 points in ~22h (~99% projected); released 10 min before the span starts
  const plain = fixture({ points });
  assert.equal(run(plain, ["check", "dream-deep"]).rc, 3, "without a release: on pace past the brake");

  const fx = fixture({ points });
  fs.writeFileSync(fx.state, JSON.stringify({ released: [{ job: "improvement-plan", at: "2026-11-01T09:50:00.000Z", held_since: "2026-10-30T09:00:00.000Z" }] }));
  const dir = path.join(fx.logs, "ephemeral-forks");
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    { ts: "2026-11-01T13:00:00Z", source: "improvement-plan", total_cost_usd: 80 },  // the catch-up run: 80% of the span's ledger spend, capped at 50%
    { ts: "2026-11-01T15:00:00Z", source: "hum", total_cost_usd: 10 },
    { ts: "2026-11-02T05:00:00Z", source: "improvement-plan", total_cost_usd: 0 },  // outside its 12h: not catch-up (and costs nothing here)
    { ts: "2026-11-02T06:00:00Z", source: "gmail:x", total_cost_usd: 10 },
  ];
  fs.writeFileSync(path.join(dir, "job-costs.ndjson"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const r = run(fx, ["check", "dream-deep", "--json"]);
  assert.equal(r.rc, 0, r.out);
  assert.equal(r.json.catch_up_share, 0.5, "capped: the scaling also shrinks unledgered usage");
  assert.ok(r.json.projected < 0.95, `projected ${r.json.projected}`);

  // A release outside the span changes nothing.
  fs.writeFileSync(fx.state, JSON.stringify({ released: [{ job: "improvement-plan", at: "2026-10-29T03:30:00.000Z" }] }));
  assert.equal(run(fx, ["check", "dream-deep"]).rc, 3);
});

// ─── auto_cheaper: the user's standing choice (review item 7, 2026-11-10) ───
// "Run it now, cheaper model" was chosen on all four budget cards in a week;
// with auto_cheaper on, a job with a cheaper model runs on it without a card
// while the week still ends under 100%, and the card comes back past that.
const WARM = [["2026-11-01T08:00:00Z", 0.85], ["2026-11-02T07:50:00Z", 0.88]];
const GOV_AUTO = { ...GOV, auto_cheaper: true };

it("auto_cheaper: an important job with a cheaper model runs on it without asking when the week ends under 100%", () => {
  const fx = fixture({ points: WARM, config: GOV_AUTO });
  const r = run(fx, ["check", "chat-build", "--key", "req-1", "--json"]);
  assert.equal(r.rc, 4, r.out);
  assert.equal(r.json.decision, "cheaper");
  assert.equal(r.json.model, "sonnet");
  assert.equal(r.json.auto, true);
  const st = fs.existsSync(fx.state) ? JSON.parse(fs.readFileSync(fx.state, "utf8")) : {};
  assert.equal((st.questions || []).length, 0, "no card");
});

it("auto_cheaper: still asks when even the cheaper run would pass 100%", () => {
  const fx = fixture({ points: HOT, config: GOV_AUTO });
  const r = run(fx, ["check", "chat-build", "--json"]);
  assert.equal(r.rc, 3);
  assert.match(r.json.reason, /asked you/); // lang-regex-ok: asserts the governor's own output, not the user's words
});

it("auto_cheaper: a job with no cheaper model is still asked about", () => {
  const fx = fixture({ points: WARM, config: GOV_AUTO });
  const r = run(fx, ["check", "chat-plain", "--json"]);
  assert.equal(r.rc, 3);
  assert.match(r.json.reason, /asked you/); // lang-regex-ok: asserts the governor's own output, not the user's words
});

it("auto_cheaper: inside the last-day window the card is asked as before", () => {
  const LAST = [["2026-11-03T08:00:00Z", 0.87], ["2026-11-04T07:50:00Z", 0.9]];
  const fx = fixture({ points: LAST, config: { ...GOV_AUTO, final_day: { hours: 24, threshold: 0.9 } } });
  const r = run(fx, ["check", "chat-build", "--json"], "2026-11-04T08:00:00Z");
  assert.equal(r.rc, 3, r.out);
  assert.match(r.json.reason, /asked you/); // lang-regex-ok: asserts the governor's own output, not the user's words
});

it("without auto_cheaper the same week still asks", () => {
  const fx = fixture({ points: WARM, config: GOV });
  const r = run(fx, ["check", "chat-build", "--json"]);
  assert.equal(r.rc, 3, r.out);
});
