"use strict";
// env-isolate.cjs — move a long-running process's .env secrets out of its
// visible starting environment.
//
// Why: agent/bin/process-manager.mjs loads .env into its own environment and
// starts its children (the supervisors, the message channels, the wiki
// servers) with all of it. A process's STARTING environment is readable by any
// process of the same user (`ps eww <pid>`), so every agent with Bash could
// read the whole .env from any of those children, for as long as they run.
// Values a process sets in process.env after it started are not visible that
// way.
//
// What it does: isolateProcessEnv(name), called first thing by the child,
// re-executes the same process in place (process.execve: same pid, same
// argv, same stdio, so process-manager notices nothing) with a starting
// environment that leaves out every variable whose value comes from .env
// unchanged, and `node --env-file=<.env>` to load those values back into
// process.env. Node's --env-file uses util.parseEnv, so a variable is left
// out only when parseEnv reads the same value from .env as the process holds;
// anything else (a value the environment overrides, a name .env does not
// have) stays in the starting environment. process.env after the re-exec is
// therefore exactly what it was before (verified 2026-11-16 on the mini: all
// 83 keys parse identically under process-manager's loader and --env-file).
//
// Roll-out is per process, by its process-manager name, in
// agent/local/config/agent-env.json: { "isolate": ["wiki-server-public"] | "all" }.
// It is read when the child starts, so turning a process on or off takes
// effect at that process's next restart; process-manager itself needs no
// restart. Off everywhere: JORI_AGENT_ENV_LOCKDOWN=0 or JORI_ENV_ISOLATE=0.
// Fails open: no execve, no .env, or any error leaves the process as it was.
// Design: docs/agent-secrets.md § 1.

const fs = require("node:fs");
const util = require("node:util");
const { installTools } = require("./root.cjs");

// Holds the pid that re-exec'd: execve keeps the pid, so the process sees its
// own pid after the re-exec, while a child that inherits the mark has another
// pid and isolates itself in turn.
const MARK = "JORI_ENV_ISOLATED";

/** agent-env.json `isolate`: a list of process names, or "all". */
function isolateListed(name) {
  try {
    const { localConfig } = require("./instance.cjs");
    const s = localConfig("agent-env", {}) || {};
    if (s.isolate === "all") return true;
    return Array.isArray(s.isolate) && s.isolate.map(String).includes(String(name));
  } catch { return false; }
}

/**
 * The starting environment to re-exec with: `env` without each name whose
 * value equals what parseEnv reads from `dotenvText`. Returns
 * { env, moved: [names] }. Pure; exported for the tests.
 */
function splitEnv(env, dotenvText) {
  let fromFile = {};
  try { fromFile = util.parseEnv(String(dotenvText || "")); } catch { fromFile = {}; }
  const out = {};
  const moved = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(fromFile, k) && fromFile[k] === v) moved.push(k);
    else out[k] = v;
  }
  return { env: out, moved };
}

/**
 * Re-exec this node process in place without its .env values in the
 * starting environment, when the installation lists `name`. Returns only
 * when it did not re-exec: { isolated, why }.
 */
function isolateProcessEnv(name, { envPath = installTools(".env"), log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  if (process.env[MARK] === String(process.pid)) {
    log(`[env-isolate] ${name}: running with .env values out of the starting environment (pid ${process.pid})`);
    return { isolated: true, why: "already" };
  }
  if (process.env.JORI_AGENT_ENV_LOCKDOWN === "0" || process.env.JORI_ENV_ISOLATE === "0") return { isolated: false, why: "switched off" };
  if (!isolateListed(name)) return { isolated: false, why: "not listed" };
  if (typeof process.execve !== "function") return { isolated: false, why: "this node has no process.execve" };
  let text;
  try { text = fs.readFileSync(envPath, "utf8"); } catch { return { isolated: false, why: "no .env" }; }
  const { env, moved } = splitEnv(process.env, text);
  if (!moved.length) return { isolated: false, why: "nothing from .env in the environment" };
  env[MARK] = String(process.pid);
  const args = [process.execPath, `--env-file=${envPath}`, ...process.execArgv, ...process.argv.slice(1)];
  log(`[env-isolate] ${name}: re-exec with ${moved.length} .env value(s) moved out of the starting environment`);
  try {
    process.execve(process.execPath, args, env);
  } catch (e) {
    log(`[env-isolate] ${name}: re-exec failed (${e.message}); running as before`);
    return { isolated: false, why: `execve: ${e.message}` };
  }
  return { isolated: false, why: "unreachable" };
}

module.exports = { isolateProcessEnv, splitEnv, isolateListed, MARK };
