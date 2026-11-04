// cost-review-prefetch-rates.test.mjs — bin/cost-review-prefetch.mjs (it reads
// the supervisors' transcripts by their Claude Code project dirs, named after
// the install root) prices off-ledger sessions and the review's own runs at
// the rate in force when the tokens were spent. The other cost tools are
// covered in cost-rates-dated.test.mjs. Transcripts are synthetic; no ledger,
// session or model is read.
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
