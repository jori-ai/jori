"use strict";
// agent-env.cjs — the environment a `claude` agent process is started with.
//
// Why: process-manager loads every line of .env into its environment, and the
// supervisors and fork runners used to hand that whole environment to
// `claude -p`. Every agent's Bash tool (and every MCP server it starts) could
// then print every key, token and password the installation owns with one
// `env`, while the same agent reads untrusted mail, web pages and group chats
// all day. The tools that need a secret read it from .env themselves
// (lib/load-env.js and friends), so the agent does not need any of them.
//
// What it does: given the parent environment, return the subset that is safe
// to hand an agent. A name is DROPPED when
//   - it is shaped like a secret (TOKEN, SECRET, PASSWORD, *_API_KEY, COOKIE, …),
//   - or it is a .env key that is not plainly configuration (a URL, host,
//     path, model, id, … or any JORI_* setting): an unknown .env key is
//     assumed to be a secret,
//   - or the installation lists it in `strip`.
// The few secrets the agent process itself needs are KEPT by name:
// CLAUDE_CODE_OAUTH_TOKEN (the Max login under cron, lib cron-run) and
// GOG_KEYRING_PASSWORD (gog is an external binary that only reads its
// keyring password from its environment, and agents call it directly; a
// documented remainder until gog gets a shim), plus the installation's `keep`.
//
// Roll-out is per agent: agent/local/config/agent-env.json
//   { "lockdown": ["ops-haiku", "ops-light"] | "all" | [],
//     "keep":  ["NAME", …],   // extra names an agent must still see
//     "strip": ["NAME", …] }  // extra names to drop
// is re-read at every spawn, so a change takes effect at the next session
// start or fork with no supervisor restart. The agent names are the
// agents.json ids (chat, ops, ops-light, ops-haiku) plus "forks" (the
// ephemeral runners). An agent that is not locked down gets the parent
// environment unchanged. Design and roll-out: docs/agent-secrets.md.

const fs = require("node:fs");
const path = require("node:path");

const { installTools } = require("./root.cjs");

// Secrets the agent process itself needs (see header).
const KEEP_SECRETS = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "GOG_KEYRING_PASSWORD"]);

// A name shaped like a credential. `_ID` names (JORI_APNS_KEY_ID,
// *_CLIENT_ID) are identifiers, not secrets, and are let through.
const SECRET_SHAPE = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|COOKIE|CREDENTIAL|PRIVATE|(^|_)API_?KEY(_|$)|(^|_)KEY$|_PW$|_PASS$|_PIN$|_SESSION$|_AUTH$|XOX[A-Z])/;

// A .env key that is plainly configuration, not a credential.
const CONFIG_SHAPE = /^JORI_|(_URL|_HOST|_PORT|_DIR|_PATH|_BIN|_MODEL|_TZ|_DOMAIN|_PROJECT|_EMAIL|_NAME|_ID|_NUMBER|_AUD|_ENABLED|_DISABLED|_MODE)$/;

function isSecretShaped(name) {
  if (/_ID$/.test(name)) return false;
  return SECRET_SHAPE.test(name);
}

/** The key names in a dotenv file (KEY=VALUE lines); empty when unreadable. */
function envFileKeys(envPath = installTools(".env")) {
  let text;
  try { text = fs.readFileSync(envPath, "utf8"); } catch { return new Set(); }
  const keys = new Set();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/); // lang-regex-ok: dotenv syntax, not language
    if (m) keys.add(m[1]);
  }
  return keys;
}

/** agent/local/config/agent-env.json, re-read on every call. */
function settings() {
  const { localConfig } = require("./instance.cjs");
  const s = localConfig("agent-env", { lockdown: [], keep: [], strip: [] });
  return {
    lockdown: s.lockdown === "all" ? "all" : (Array.isArray(s.lockdown) ? s.lockdown.map(String) : []),
    keep: new Set(Array.isArray(s.keep) ? s.keep.map(String) : []),
    strip: new Set(Array.isArray(s.strip) ? s.strip.map(String) : []),
  };
}

/** Whether `agent` (an agents.json id, or "forks") runs locked down. */
function lockedDown(agent, s = settings()) {
  if (process.env.JORI_AGENT_ENV_LOCKDOWN === "0") return false; // emergency off switch (supervisor env)
  if (s.lockdown === "all") return true;
  return s.lockdown.includes(String(agent));
}

/**
 * Decide one name. Returns "keep" or a reason string for dropping it.
 * Exported for the tests and for `agent-env --explain`.
 */
function decide(name, { dotenvKeys = new Set(), keep = new Set(), strip = new Set() } = {}) {
  if (KEEP_SECRETS.has(name) || keep.has(name)) return "keep";
  if (strip.has(name)) return "strip-listed";
  if (isSecretShaped(name)) return "secret-shaped";
  if (dotenvKeys.has(name) && !CONFIG_SHAPE.test(name)) return "unknown-dotenv-key";
  return "keep";
}

/**
 * The environment to start a `claude` agent with.
 *   agent       agents.json id or "forks"
 *   parentEnv   the environment it would otherwise inherit (default process.env)
 *   force       true: filter even when the agent is not locked down (tests)
 * Returns { env, locked, dropped: [{name, reason}] }. Never returns values of
 * dropped names; callers may log `dropped` (names only).
 */
function agentEnv(agent, { parentEnv = process.env, envPath, force = false } = {}) {
  const s = settings();
  const locked = force || lockedDown(agent, s);
  if (!locked) return { env: { ...parentEnv }, locked: false, dropped: [] };
  const dotenvKeys = envFileKeys(envPath);
  const env = {};
  const dropped = [];
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    const why = decide(name, { dotenvKeys, keep: s.keep, strip: s.strip });
    if (why === "keep") env[name] = value;
    else dropped.push({ name, reason: why });
  }
  return { env, locked: true, dropped };
}

module.exports = { agentEnv, decide, lockedDown, isSecretShaped, envFileKeys, settings, KEEP_SECRETS };

// CLI (used by the bash fork runners, agent/scripts/lib/agent-env.sh):
//   agent-env.cjs --agent forks --print0   NUL-separated NAME=VALUE of the
//                                          filtered env (nothing when not locked)
//   agent-env.cjs --agent forks --explain  names kept/dropped and why (no values)
if (require.main === module) {
  const args = process.argv.slice(2);
  const agent = args[args.indexOf("--agent") + 1] || "forks";
  if (args.includes("--explain")) {
    const { locked, env, dropped } = agentEnv(agent, { force: args.includes("--force") });
    console.log(`${agent}: ${locked ? "locked down" : "not locked down (inherits everything)"}`);
    if (locked) {
      console.log(`kept ${Object.keys(env).length}: ${Object.keys(env).sort().join(" ")}`);
      for (const d of dropped.sort((a, b) => a.name.localeCompare(b.name))) console.log(`dropped ${d.name} (${d.reason})`);
    }
  } else if (args.includes("--print0")) {
    const { locked, env } = agentEnv(agent);
    if (!locked) process.exit(3); // caller keeps the inherited env
    for (const [k, v] of Object.entries(env)) process.stdout.write(`${k}=${v}\0`);
  } else {
    console.error("usage: agent-env.cjs --agent <id> (--print0 | --explain [--force])");
    process.exit(64);
  }
}
