// kernel-call-site-guards.test.mjs — the shared guards, pinned on the call
// sites that joined the kernel after the guards' own tests listed theirs:
// atomic writes, the pinned claude binary, Jev's tool-less batch, the Max-only
// auth guard, the rollback guard in fork settings, and the central model file.
// The guards themselves are tested in atomic-write, claude-binaries,
// jev-claude-toolless, max-auth-guard, rollback-guard and models-central.
//
// No model is called: daily-summary-review runs against a stub binary.
// Run: node --test tests/kernel-call-site-guards.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { REPO_ROOT as ROOT } from "../lib/root.cjs";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel) => read(rel).split("\n")
  .filter((l) => !l.trimStart().startsWith("#") && !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
  .join("\n");

test("these writers use the shared atomic helper, not a bare writeFileSync", () => {
  const sites = {
    "bin/meeting-notes-from-zoom": "writeFileAtomic(NOTES, next)",
    "lib/supervisor-code-reload.mjs": "writeFileAtomic(STATE_FILE",
    "lib/live-day.js": "writeFileAtomic(dest",
    "bin/hum-metrics-collect": "write_json_atomic(QUAL_QUEUE",
  };
  for (const [f, needle] of Object.entries(sites)) assert.ok(read(f).includes(needle), `${f} lost its atomic write (${needle})`);
});

test("daily-summary-review forks CLAUDE_BIN and logs it; a decoy `claude` first on PATH never runs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bin-"));
  const ran = path.join(tmp, "ran.log");
  const stub = (who, version) => `#!/bin/sh\necho "${who} $1" >> "${ran}"\n`
    + `if [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi\necho '{"issues":[],"verdict":"publish"}'\n`;
  const fake = path.join(tmp, "pinned-claude"), date = "2099-01-05", report = `/tmp/daily-summary-${date}.html`;
  fs.mkdirSync(path.join(tmp, "decoy"));
  fs.writeFileSync(path.join(tmp, "decoy/claude"), stub("decoy", "2.1.81"), { mode: 0o755 });
  fs.writeFileSync(fake, stub("pinned", "9.9.9"), { mode: 0o755 });
  fs.writeFileSync(report, "<h1>Day</h1><h3>1:00pm–2:00pm · Corner Cafe</h3><p>Lunch at the Corner Cafe.</p>");
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, "bin/daily-summary-review"), date], {
      encoding: "utf8", timeout: 30000,
      env: { ...process.env, PATH: `${path.join(tmp, "decoy")}:${process.env.PATH}`, CLAUDE_BIN: fake },
    });
    const calls = fs.existsSync(ran) ? fs.readFileSync(ran, "utf8").trim().split("\n") : [];
    assert.ok(!calls.some((l) => l.startsWith("decoy")), `the PATH's claude ran: ${calls.join(" | ")}`);
    assert.ok(calls.includes("pinned -p"), `the pinned binary never ran: ${calls.join(" | ")}`);
    assert.ok(r.stderr.includes(`claude: ${fake} (9.9.9 (Claude Code))`), r.stderr);
  } finally {
    for (const f of [report, `/tmp/ds-review-${date}.json`]) { try { fs.unlinkSync(f); } catch {} }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the Jev P1 gate does not spawn claude with the old leaky flags", () => {
  const s = read("lib/jev-p1-gate.mjs");
  assert.ok(!/"--allowedTools",\s*""/.test(s), "lib/jev-p1-gate.mjs still spawns claude with --allowedTools \"\"");
});

test("the ephemeral fable runner sources the Max-only guard before its claude -p", () => {
  const src = read("agent/scripts/lib/run-ephemeral-fable.sh");
  const g = src.indexOf("max_auth_check");
  const run = src.search(/"\$CLAUDE" -p/);
  assert.ok(g > 0 && run > g, "max_auth_check must run before \"$CLAUDE\" -p");
});

test("the fable runner and the daily summary merge the rollback guard into their fork settings", () => {
  for (const f of ["agent/scripts/lib/run-ephemeral-fable.sh", "bin/daily-summary-run"]) {
    assert.ok(read(f).includes("jori_fork_settings"), `${f} does not merge the guard`);
  }
});

test("these Opus call sites read the central model file, no literal id", () => {
  for (const rel of ["bin/family-qa", "bin/day-statements", "bin/daily-summary-review"]) {
    const c = code(rel);
    assert.ok(!c.includes("claude-opus-"), `${rel} hard-codes an Opus id`);
    assert.ok(c.includes("models.env") || c.includes("models.cjs"), `${rel} does not read the central model file`);
  }
});

test("cost-review-prefetch can price the pinned Opus id", () => {
  const { MODELS } = createRequire(import.meta.url)("../lib/models.cjs");
  assert.ok(read("bin/cost-review-prefetch.mjs").includes(`'${MODELS.opus}'`), `no rate for ${MODELS.opus}`);
});
