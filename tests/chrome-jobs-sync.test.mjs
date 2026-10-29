// chrome-jobs-sync.test.mjs — keeps agent/config/chrome-jobs.json honest.
//
// webhook-auth.sh pins every job in that list to the ops supervisor, because
// ops is the only supervisor that loads the chrome-devtools MCP. The list was
// hand-maintained inline in webhook-auth.sh and drifted both ways: runner-only
// jobs (cdp-runner from Bash, which works from any supervisor or from a plain
// cron script) were pinned to the heavy tier for nothing — two jobs routed
// "haiku" ran heavy every day — while nothing
// would have noticed a NEW MCP job missing from it.
//
// Rule checked here, both directions:
//   1. a live playbook that drives the chrome-devtools MCP must be listed
//      (a playbook the installation runs: a task's job or a job-routing entry,
//      kernel or local — a playbook file nothing registers is not dispatched);
//   2. a listed job must have a playbook that still drives the MCP.
// "Live" = not marked SUPERSEDED/RETIRED on its first line.
//
// Run: node --test tests/chrome-jobs-sync.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const JOBS_DIR = path.join(REPO, "agent", "ops-agent", "jobs");
const CONFIG = path.join(REPO, "agent", "config", "chrome-jobs.json");

// Uses of the ops agent's own Chrome MCP (the :9222 automation profile). A
// suffixed `chrome-devtools-<name>` MCP (another person's browser) is a
// different server and is not what pins a job to ops here. cdp-runner /
// run-action from Bash are deliberately absent.
const MCP_USE = /mcp__chrome-devtools(?!-)|`chrome-devtools` MCP|\bcdp\.(navigate|evaluate)\b/;

function livePlaybooks() {
  const out = new Map();
  for (const f of fs.readdirSync(JOBS_DIR)) {
    if (!f.endsWith(".md")) continue;
    const text = fs.readFileSync(path.join(JOBS_DIR, f), "utf8");
    const first = text.split("\n", 1)[0];
    if (/^\**\s*(SUPERSEDED|RETIRED)/i.test(first)) continue;
    out.set(f.replace(/\.md$/, ""), text);
  }
  return out;
}

// Kernel list + this installation's agent/local/chrome-jobs.json, merged as webhook-auth.sh reads them.
const { loadRegistry } = createRequire(import.meta.url)(path.join(REPO, "lib", "registry.cjs"));
const listed = new Set(loadRegistry("chrome-jobs").jobs);
const playbooks = livePlaybooks();
const registered = new Set();
for (const t of loadRegistry("tasks").tasks) { registered.add(t.name); if (t.job) registered.add(t.job); }
for (const j of Object.keys(loadRegistry("job-routing").jobs || {})) registered.add(j);

test("every playbook that drives the chrome-devtools MCP is pinned to ops", () => {
  const missing = [...playbooks].filter(([j, t]) => registered.has(j) && MCP_USE.test(t)).map(([j]) => j).filter((j) => !listed.has(j));
  assert.deepEqual(missing, [], `add to agent/config/chrome-jobs.json: ${missing.join(", ")}`);
});

test("every pinned job still drives the chrome-devtools MCP", () => {
  const stale = [...listed].filter((j) => !playbooks.has(j) || !MCP_USE.test(playbooks.get(j)));
  assert.deepEqual(stale, [], `remove from agent/config/chrome-jobs.json (no MCP use, or no live playbook): ${stale.join(", ")}`);
});

test("webhook-auth.sh reads the list instead of hardcoding it", () => {
  const sh = fs.readFileSync(path.join(REPO, "agent", "scripts", "lib", "webhook-auth.sh"), "utf8");
  assert.match(sh, /chrome-jobs\.json/);
  assert.doesNotMatch(sh, /new Set\(\[\s*"/, "inline chrome set is back in webhook-auth.sh");
});
