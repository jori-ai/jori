// cost-review-prefetch-rates.test.mjs — bin/cost-review-prefetch.mjs (it reads
// the supervisors' transcripts by their Claude Code project dirs, named after
// the install root) prices off-ledger sessions and the review's own runs at
// the rate in force when the tokens were spent. The other cost tools are
// covered in cost-rates-dated.test.mjs. Transcripts are synthetic; no ledger,
// session or model is read.
//
// It also lays out two series the review used to rebuild by hand (tests at the
// end): fork_ledger, the ephemeral-fork rows per source over 24h windows, and
// floor_cohorts, each tier's session-start floor compared cohort to cohort with
// the ops-haiku:ops-light corroboration ratio applied. Ledgers and event logs
// there are synthetic too, under a throwaway HOME.
//
// Run: node --test tests/cost-review-prefetch-rates.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const near = (got, want, what) => assert.ok(Math.abs(got - want) < 0.005, `${what}: ${got} vs ${want}`);

// A throwaway $HOME whose Dev/jori points at this checkout's code but has its
// own logs and transcripts, so nothing here reads a real ledger or session.
function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cost-rates-"));
  const g = path.join(home, "Dev/jori");
  fs.mkdirSync(path.join(g, "agent/logs"), { recursive: true });
  fs.mkdirSync(path.join(g, "agent/ops-agent"), { recursive: true });
  fs.mkdirSync(path.join(g, "data"), { recursive: true });
  for (const rel of ["bin", "lib", "agent/config", "agent/scripts"]) {
    fs.symlinkSync(path.join(ROOT, rel), path.join(g, rel));
  }
  return { home, g };
}

// One transcript line per API request, in the shape Claude Code writes.
const line = (id, model, ts, usage) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model, role: "assistant", usage } });
const userLine = (text) => JSON.stringify({ type: "user", timestamp: "2026-10-06T11:59:00.000Z", message: { role: "user", content: text } });
const U = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });

// Expected list USD for the transcript below, at the rates in force.
const SONNET_BEFORE = (1000 * 2 + 10_000 * 10 + 100_000 * 2.5 + 10_000_000 * 0.20) / 1e6;
const SONNET_AFTER = (1000 * 2 + 10_000 * 10 + 100_000 * 2.5 + 10_000_000 * 0.10) / 1e6;
const HAIKU_SHORT = (1000 * 0.10 + 1_000_000 * 0.50 + 60_000 * 0.01 + 20_000 * 0.125) / 1e6;
const HAIKU_LONG = (1000 * 0.50 + 100_000 * 2.50 + 5_000_000 * 0.05 + 200_000 * 0.625) / 1e6;

test("cost-review-prefetch: off-ledger sessions and the review's own cost use the dated rates", () => {
  const { home, g } = fakeHome();
  try {
    // Claude Code's project dir for <install root>/agent/ops-agent.
    const proj = path.join(home, ".claude/projects", path.join(g, "agent/ops-agent").replace(/[^a-zA-Z0-9]/g, "-")); // lang-regex-ok: encodes a path into Claude Code's project-dir name
    fs.mkdirSync(proj, { recursive: true });
    // An off-ledger Sonnet session (no ledger row has its id) spanning the cut.
    fs.writeFileSync(path.join(proj, "offledger-1.jsonl"), [
      userLine("SOME SONNET FORK"),
      line("s1", "claude-sonnet-5-5", "2026-10-06T12:00:00.000Z", U(1000, 10_000, 10_000_000, 100_000)),
      line("s2", "claude-sonnet-5-5", "2026-10-08T12:00:00.000Z", U(1000, 10_000, 10_000_000, 100_000)),
    ].join("\n") + "\n");
    // A cost-review run that used Haiku 5.5 on both sides of the threshold.
    fs.writeFileSync(path.join(proj, "review-1.jsonl"), [
      userLine("COST EFFICIENCY REVIEW (daily)."),
      line("h1", "claude-haiku-5-5", "2026-10-08T12:00:00.000Z", U(1000, 1_000_000, 60_000, 20_000)),
      line("h2", "claude-haiku-5-5", "2026-10-08T12:00:00.000Z", U(1000, 100_000, 5_000_000, 200_000)),
    ].join("\n") + "\n");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cost-rates-pf-"));
    const report = path.join(tmp, "r.json");
    fs.writeFileSync(report, JSON.stringify({ since: new Date(Date.now() - 86400e3).toISOString(), by_tier: [], jobs: [] }));
    const dest = path.join(tmp, "out.json");
    execFileSync("node", [path.join(ROOT, "bin/cost-review-prefetch.mjs"), report, report, dest],
      { env: { ...process.env, HOME: home, JORI_HOME: g }, encoding: "utf8" });
    const out = JSON.parse(fs.readFileSync(dest, "utf8"));
    const w = out.offledger_sessions.workloads.find((x) => x.label.includes("SOME SONNET FORK"));
    assert.ok(w, JSON.stringify(out.offledger_sessions));
    near(w.usd_7d, SONNET_BEFORE + SONNET_AFTER, "off-ledger Sonnet 5.5 session");
    const run = out.self_cost_series.runs.find((r) => r.date === "2026-10-08");
    assert.ok(run, JSON.stringify(out.self_cost_series));
    near(run.usd, HAIKU_SHORT + HAIKU_LONG, "review run on Haiku 5.5");
    fs.rmSync(tmp, { recursive: true, force: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── fork_ledger and floor_cohorts ──────────────────────────────────────────

const DAY = 86400e3;

function forksHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cost-forks-"));
  const g = path.join(home, "Dev/jori");
  for (const d of ["agent/logs/ephemeral-forks", "agent/logs/supervisor-ops", "agent/logs/supervisor-ops-light", "agent/logs/supervisor-ops-haiku", "agent/ops-agent", "data"]) {
    fs.mkdirSync(path.join(g, d), { recursive: true });
  }
  for (const rel of ["bin", "lib", "agent/config", "agent/scripts"]) {
    fs.symlinkSync(path.join(ROOT, rel), path.join(g, rel));
  }
  return { home, g };
}

function runPrefetch(home, g, since) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cost-forks-pf-"));
  try {
    const report = path.join(tmp, "r.json");
    fs.writeFileSync(report, JSON.stringify({ since: new Date(since).toISOString(), by_tier: [], jobs: [] }));
    const dest = path.join(tmp, "out.json");
    execFileSync("node", [path.join(ROOT, "bin/cost-review-prefetch.mjs"), report, report, dest],
      { env: { ...process.env, HOME: home, JORI_HOME: g }, encoding: "utf8" });
    return JSON.parse(fs.readFileSync(dest, "utf8"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const iso = (t) => new Date(t).toISOString();

test("fork_ledger: per-source 24h windows, 3-window mean, prior range, small sources folded", () => {
  const { home, g } = forksHome();
  try {
    const since = Date.now() - DAY;           // the report window is [since, since + 1 day)
    const mid = (k) => since - k * DAY + DAY / 2; // middle of window k back (0 = current)
    const row = (t, source, usd, turns, extra = {}) => JSON.stringify({ ts: iso(t), source, total_cost_usd: usd, num_turns: turns, ...extra });
    fs.writeFileSync(path.join(g, "agent/logs/ephemeral-forks/job-costs.ndjson"), [
      row(mid(3), "big-job", 10, 50),
      row(mid(2), "big-job", 20, 60),
      row(mid(1), "big-job", 30, 70),
      row(mid(0), "big-job", 12, 40, { turns_source: "transcript" }),
      row(mid(0), "big-job", 40, 80),
      row(mid(10), "big-job", 5, 30),      // inside 14 days, outside the 7 windows
      row(mid(20), "big-job", 99, 99),     // outside 14 days: ignored
      row(mid(0), "tiny-job", 0.5, 1),     // under $3 over 14 days: folded into other
      "not json",
    ].join("\n") + "\n");
    const out = runPrefetch(home, g, since);
    assert.deepEqual(out.errors, []);
    const fl = out.fork_ledger;
    const b = fl.sources["big-job"];
    assert.ok(b, JSON.stringify(fl));
    assert.equal(b.runs_14d, 6);
    assert.equal(b.usd_14d, 117);
    assert.deepEqual(b.windows_usd, [0, 0, 0, 10, 20, 30, 52]);
    assert.deepEqual(b.windows_runs, [0, 0, 0, 1, 1, 1, 2]);
    assert.equal(b.mean_last3_windows_usd, Math.round((20 + 30 + 52) / 3 * 100) / 100);
    assert.deepEqual(b.prior_window_usd_range, [10, 30]);
    assert.equal(b.current.runs, 2);
    assert.equal(b.current.usd, 52);
    assert.equal(b.current.usd_per_run, 26);
    assert.equal(b.current.turns_per_run, 60);
    assert.equal(b.current.transcript_turn_rows, 1);
    assert.deepEqual(b.prior_run_usd, { n: 4, min: 5, median: 20, max: 30 });
    assert.equal(b.current_run_above_prior_max, true);
    assert.equal(fl.sources["tiny-job"], undefined);
    assert.deepEqual(fl.other, { runs_14d: 1, usd_14d: 0.5 });
    assert.deepEqual(fl.total_windows_usd, [0, 0, 0, 10, 20, 30, 52.5]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("fork_ledger: a missing ledger is UNKNOWN, not zero", () => {
  const { home, g } = forksHome();
  try {
    const out = runPrefetch(home, g, Date.now() - DAY);
    assert.match(out.fork_ledger.note, /UNKNOWN/);
    assert.deepEqual(out.fork_ledger.sources, {});
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("floor_cohorts: same cohort across days, light cohort preferred, corroboration ratio applied", () => {
  const { home, g } = forksHome();
  try {
    const since = Date.now() - DAY;
    const at = (k, minute) => since - k * DAY + 3600e3 + minute * 60e3; // k windows back
    let n = 0;
    // One session start: a floor_measured event joined to the dispatch 30 s earlier.
    const start = (k, minute, source, floor) => {
      n += 1;
      const t = at(k, minute);
      return [
        JSON.stringify({ ts: iso(t - 30e3), kind: "dispatcher.dispatching", item: { source } }),
        JSON.stringify({ ts: iso(t), kind: "context.floor_measured", sessionId: `s${n}`, floorTokens: floor }),
      ];
    };
    const write = (tier, lines) => fs.writeFileSync(path.join(g, `agent/logs/supervisor-${tier}/events.ndjson`), lines.flat().join("\n") + "\n");
    // ops-light: gmail (light, well sampled) grows +1,000 a day over 3 days; hum
    // (heavy: carries its own playbook) is sampled more but must not be chosen.
    write("ops-light", [
      start(3, 0, "gmail:aaa", 110000), start(3, 10, "gmail:bbb", 110000),
      start(1, 0, "gmail:ccc", 112000),
      start(0, 0, "gmail:ddd", 113000), start(0, 10, "gmail:eee", 113000), start(0, 20, "gmail:fff", 113000),
      ...[3, 2, 1, 0].flatMap((k) => [start(k, 30, "hum", 140000), start(k, 40, "hum", 140000), start(k, 50, "hum", 140000)]),
    ]);
    // ops-haiku moves in proportion (0.725x): corroborated on 3 days, not on 1.
    write("ops-haiku", [
      start(3, 0, "comedy", 100000),
      start(1, 0, "comedy", 102000),
      start(0, 0, "comedy", 102175),
    ]);
    // ops: no session start in the report window -> no matched cohort.
    write("ops", [start(2, 0, "webhook", 120000)]);
    const out = runPrefetch(home, g, since);
    assert.deepEqual(out.errors, []);
    const fc = out.floor_cohorts;
    const light = fc.tiers["ops-light"];
    assert.equal(light.matched.cohort, "gmail:*");
    assert.equal(light.matched.current.n, 3);
    assert.equal(light.matched.delta_1d, 1000);
    assert.equal(light.matched.delta_3d, 3000);
    assert.equal(light.matched.three_back.windows_back, 3);
    assert.deepEqual(light.series["gmail:*"].map((x) => x && x.median), [null, null, null, 110000, null, 112000, 113000]);
    assert.deepEqual(light.alternatives.map((a) => a.cohort), ["gmail:*", "hum"]);
    const haiku = fc.tiers["ops-haiku"];
    assert.equal(haiku.matched.delta_1d, 175);
    assert.equal(haiku.matched.delta_3d, 2175);
    assert.equal(fc.corroboration_3d.ratio, 0.725);
    assert.equal(fc.corroboration_3d.corroborated, true);
    assert.equal(fc.corroboration_1d.ratio, 0.175);
    assert.equal(fc.corroboration_1d.corroborated, false);
    assert.equal(fc.tiers.ops.matched, null);
    assert.deepEqual(fc.over_1d_line, []);
    assert.deepEqual(fc.over_3d_line, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
