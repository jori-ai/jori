// agent-env-launchers.test.mjs — every launcher that starts `claude -p` with
// bypassPermissions (so the model has Bash, and can print its environment)
// builds that environment through the agent-env lockdown (lib/agent-env.cjs,
// agent/scripts/lib/agent-env.sh). A tool-less or WebSearch-only `claude -p`
// is out of scope: without Bash the model cannot read the environment.
// docs/agent-secrets.md § 1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Not a live spawn path: the legacy tmux launcher (process-manager.mjs runs the
// agents), and the supervisor's test doubles.
const EXEMPT = new Set([
  "agent/bin/claude-session-launcher.sh",
  "agent/test/mock-claude.mjs",
  "agent/test/supervisor-quota-hold.test.mjs",
]);

const SPAWNS_CLAUDE_P = /"\$\{?CLAUDE[A-Z_]*\}?" +-p\b|\$CLAUDE[A-Z_]* +-p\b|"-p"|claude -p\b/; // lang-regex-ok: shell/JS source text, not language
const WIRED = /agent-env|agentEnv|AGENT_ENV_CMD|agentEnvId/; // lang-regex-ok: source identifiers

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "bin", "agent", "lib"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter((f) => f && !f.endsWith(".md") && !f.endsWith(".json"));
}

test("every bypassPermissions claude -p launcher goes through the agent-env lockdown", () => {
  const unwired = [];
  for (const f of trackedFiles()) {
    if (EXEMPT.has(f)) continue;
    let src;
    try { src = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
    if (!src.includes("bypassPermissions") || !SPAWNS_CLAUDE_P.test(src)) continue;
    if (!WIRED.test(src)) unwired.push(f);
  }
  assert.deepEqual(unwired, [], `these start claude -p with Bash but pass their whole environment: ${unwired.join(", ")}`);
});
