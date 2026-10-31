// daily-summary-effort-ab.test.mjs — bin/daily-summary-ab's side-by-side
// report from fixture run dirs, and one dry run end to end through
// bin/daily-summary-run with a fake `claude` (CLAUDE_BIN) and a fake HOME.
// The dry run passes --effort through, asks for JSON output, carries the DRY
// RUN instruction, and collects artifacts and metrics without publishing.
// All places are invented; no model is called.
//
// Run: node --test tests/daily-summary-effort-ab.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT as ROOT } from "../lib/root.cjs";

const AB = path.join(ROOT, "bin/daily-summary-ab");

function writeRun(dir, effort, { cost, prose, header }) {
  const d = path.join(dir, effort);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "metrics.json"), JSON.stringify({ effort, total_cost_usd: cost, num_turns: 9, duration_ms: 120000 }));
  fs.writeFileSync(path.join(d, "ds-prose-2099-01-01.json"), JSON.stringify({ prose: { s1: prose }, questions: { u1: "q?" } }));
  fs.writeFileSync(path.join(d, "ds-confirmed-2099-01-01.json"), JSON.stringify({ s1: "Harbor Noodle" }));
  fs.writeFileSync(path.join(d, "ds-review-2099-01-01.json"), JSON.stringify({ verdict: "publish", findings: [{ severity: "low" }] }));
  fs.writeFileSync(path.join(d, "daily-summary-2099-01-01.html"), `<h3>1:00pm · ${header}</h3>`);
}

test("report lays efforts side by side and marks differing headers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsab-"));
  writeRun(dir, "medium", { cost: 0.8, prose: "Lunch at Harbor Noodle.", header: "Harbor Noodle" });
  writeRun(dir, "xhigh", { cost: 2.4, prose: "You had lunch at Harbor Noodle, which disappointed.", header: "Harbor Noodle | Old Quarter" });
  const r = spawnSync(process.execPath, [AB, "report", dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(dir, "report.md"), "utf8");
  assert.match(md, /\| cost_usd \| 0\.8 \| 2\.4 \|/);
  assert.match(md, /\| 1 ≠ \|/);
  assert.match(md, /Harbor Noodle \\\| Old Quarter/);
  assert.match(md, /\*\*xhigh:\*\* You had lunch at Harbor Noodle, which disappointed\./);
  const json = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
  assert.equal(json.find((x) => x.effort === "medium").confirmed_stops, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dry run: effort passthrough, DRY RUN prompt, artifacts collected, nothing published", () => {
  const date = "2099-01-04";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsrun-"));
  fs.mkdirSync(path.join(home, "Dev"), { recursive: true });
  fs.symlinkSync(ROOT, path.join(home, "Dev/jori"));
  const seen = path.join(home, "seen");
  const fake = path.join(home, "fake-claude");
  fs.writeFileSync(fake, `#!/bin/bash
echo "$@" > "${seen}.args"
cat > "${seen}.prompt"
echo '<h3>9:00am · Home</h3>' > /tmp/daily-summary-${date}.html
echo '{"prose":{"s1":"x"}}' > /tmp/ds-prose-${date}.json
echo '{"is_error":false,"total_cost_usd":1.23,"num_turns":7,"duration_ms":60000,"result":"done"}'
`);
  fs.chmodSync(fake, 0o755);
  const out = path.join(home, "out");
  try {
    const r = spawnSync("/bin/bash", [path.join(ROOT, "bin/daily-summary-run"), date, "--dry-run", "--effort", "medium", "--out", out],
      // The fake claude needs no keychain: let the run's SSH guard pass when the suite runs over SSH.
      { encoding: "utf8", env: { ...process.env, HOME: home, CLAUDE_BIN: fake, DAILY_SUMMARY_ALLOW_SSH: "1" }, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const args = fs.readFileSync(`${seen}.args`, "utf8");
    assert.match(args, /--effort medium/);
    assert.match(args, /--output-format json/);
    const prompt = fs.readFileSync(`${seen}.prompt`, "utf8");
    assert.match(prompt, /DRY RUN/);
    assert.match(prompt, new RegExp(`DAILY SUMMARY ${date} DRY-RUN`));
    const m = JSON.parse(fs.readFileSync(path.join(out, "metrics.json"), "utf8"));
    assert.equal(m.total_cost_usd, 1.23);
    assert.equal(m.effort, "medium");
    assert.ok(fs.existsSync(path.join(out, `daily-summary-${date}.html`)));
  } finally {
    for (const f of [`daily-summary-${date}.html`, `ds-prose-${date}.json`]) { try { fs.unlinkSync(`/tmp/${f}`); } catch {} }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("dry run without a date is refused", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsrun-"));
  const r = spawnSync("/bin/bash", [path.join(ROOT, "bin/daily-summary-run"), "--dry-run"],
    { encoding: "utf8", env: { ...process.env, HOME: home, CLAUDE_BIN: "/usr/bin/false" } });
  assert.equal(r.status, 1);
  fs.rmSync(home, { recursive: true, force: true });
});
