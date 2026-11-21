// model-call-env.test.mjs — every place code starts a `claude -p` model call
// builds the child's environment through the agent-env filter
// (lib/agent-env.cjs modelEnv / agentEnv, or a helper built on them:
// lib/jev-claude.mjs and lib/max-judge.js maxOnlyEnv). A model call inherits
// whatever its caller loaded from .env, and a child's starting environment is
// readable by any same-user process (`ps eww`), so one unfiltered call shows
// every secret to an agent with Bash while it runs. docs/agent-secrets.md § 1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Files that name the claude binary but start no model call of their own, or
// are test doubles and the legacy tmux launcher.
const EXEMPT = new Set([
  "agent/bin/claude-session-launcher.sh",
  "agent/test/mock-claude.mjs",
  "agent/test/supervisor-quota-hold.test.mjs",
  "lib/claude-binaries.js", // `claude --version` only
  "lib/cyber-inventory.mjs", // `claude --version` only
]);

// Starts the claude binary in-process (node or python), not through a shell
// launcher (those are agent-env-launchers.test.mjs).
const SPAWN = /\b(spawn|spawnSync|execFile|execFileSync|subprocess\.run|subprocess\.Popen)\(/; // lang-regex-ok: source text
const CLAUDE = /CLAUDE_BIN|DEFAULT_CLAUDE_BIN|\.local\/bin\/claude|claudeBin|resolveClaudeBin|bin\[0\]/; // lang-regex-ok: source text
const PRINT_P = /"-p"|'-p'|\$\{CLAUDE[A-Z_]*\} -p\b/; // lang-regex-ok: source text
const WIRED = /modelEnv|maxOnlyEnv|agentEnv|_model_env|_agent_env|agent-env/; // lang-regex-ok: source identifiers

test("every in-process claude -p model call filters its environment", () => {
  const files = execFileSync("git", ["ls-files", "bin", "agent", "lib", "plugins"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter((f) => f && /\.(m?js|cjs|py)$|^(bin|plugins\/[^/]+\/bin)\/[^/.]+$/.test(f) && !f.includes("/test/") && !EXEMPT.has(f)); // lang-regex-ok: file paths
  const open = [];
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
    if (!src.startsWith("#!") && !/\.(m?js|cjs|py)$/.test(f)) continue; // lang-regex-ok: file paths
    if (/^#!.*\b(ba|z)?sh\b/.test(src)) continue; // lang-regex-ok: shebang; shell launchers are agent-env-launchers.test.mjs
    if (SPAWN.test(src) && CLAUDE.test(src) && PRINT_P.test(src) && !WIRED.test(src)) open.push(f);
  }
  assert.deepEqual(open, [], `start the model call with lib/agent-env.cjs modelEnv(): ${open.join(", ")}`);
});
