// secrets-guard — Claude Code PreToolUse check for Jori's own sessions: an
// agent reading the installation's secrets directly.
//
// The agents' environment no longer carries the secrets (lib/agent-env.cjs);
// this closes the other direct route, the agent reading them itself:
//   - the secrets files: any .env (not .env.example / .env.tpl / .env.sample),
//     the repo's top-level secrets/ and credentials/ directories, the Supabase
//     OAuth store (data/.supabase-oauth.json), 1Password's local config;
//   - the 1Password CLI (`op …`) and macOS keychain password reads
//     (`security find-generic-password`, `find-internet-password`,
//     `dump-keychain`);
//   - dumping the environment (`env`, `printenv`, `export -p`, `set`) — inert
//     once the agent is locked down, logged so the roll-out shows who did it.
// The tools that legitimately use a secret (bin/site-pass, card-pass,
// email-send, …) read it inside their own process, which this hook never sees:
// it judges only the agent's own tool call.
//
// Modes (agent/local/config/agent-env.json `guard`, re-read per call):
//   "log"   (default) allow, and log the access to agent/logs/secrets-guard.log
//   "block" refuse with exit 2 and a reason the model reads
//   "off"
// The log names the kind and the matched path or program, never the command
// line (it can carry a value). Not airtight: the agent still runs as the same
// macOS user, so a determined detour (a script that reads the file) is not
// seen. Design: docs/agent-secrets.md.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { splitCommands } from "./rollback-guard.mjs";

const require = createRequire(import.meta.url);
const { installRoot } = require("./root.cjs");

const WRAPPERS = new Set(["command", "exec", "nice", "nohup", "time", "sudo", "builtin", "caffeinate", "xargs"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/; // lang-regex-ok: shell VAR=value assignment syntax
const ENV_DUMPERS = new Set(["env", "printenv"]);
const KEYCHAIN_READS = new Set(["find-generic-password", "find-internet-password", "dump-keychain", "export"]);
const SAFE_ENV_SUFFIXES = [".example", ".sample", ".tpl", ".template"];

const expandHome = (p) => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

/** Whether a path (absolute or relative to cwd) is one of the secrets files. */
export function protectedPath(p, { cwd = process.cwd(), root = installRoot(), home = os.homedir() } = {}) {
  if (!p || typeof p !== "string") return null;
  const raw = expandHome(p.trim());
  const base = path.basename(raw);
  if (base === ".env" || (base.startsWith(".env.") && !SAFE_ENV_SUFFIXES.some((s) => base.endsWith(s)))) return "dotenv";
  // An unexpanded variable ("$JORI_HOME/secrets/x") is judged on its tail.
  const resolved = raw.includes("$") ? raw : path.resolve(cwd, raw);
  const under = (dir) => resolved === dir || resolved.startsWith(dir + path.sep);
  const tail = (seg) => resolved.includes(`/${seg}/`) && raw.includes("$");
  if (under(path.join(root, "secrets")) || tail("secrets")) return "secrets-dir";
  if (under(path.join(root, "credentials")) || tail("credentials")) return "credentials-dir";
  if (base === ".supabase-oauth.json") return "supabase-oauth-store";
  if (under(path.join(home, ".config", "op"))) return "1password-config";
  if (resolved.includes("com.1password")) return "1password-store";
  return null;
}

/**
 * Classify one PreToolUse input. Returns [] or a list of
 * { kind, target } (target: the matched path or program, never a value).
 */
export function findAccesses(input, { root = installRoot(), home = os.homedir(), depth = 0 } = {}) {
  const tool = input?.tool_name;
  const ti = input?.tool_input || {};
  const cwd = input?.cwd || process.cwd();
  const opts = { cwd, root, home };
  if (tool === "Read" || tool === "Grep" || tool === "Glob" || tool === "Edit" || tool === "Write") {
    const out = [];
    for (const k of ["file_path", "path", "pattern"]) {
      const kind = protectedPath(ti[k], opts);
      if (kind) out.push({ kind, target: String(ti[k]) });
    }
    return out;
  }
  if (tool !== "Bash") return [];
  return bashAccesses(String(ti.command || ""), { ...opts, depth });
}

function bashAccesses(src, { cwd, root, home, depth = 0 }) {
  const out = [];
  let dir = cwd;
  for (let words of splitCommands(src)) {
    words = words.slice();
    while (words.length && ASSIGN.test(words[0])) words.shift();
    let dumper = null;
    while (words.length) {
      const w = path.basename(words[0]);
      if (WRAPPERS.has(w)) { words.shift(); while (words[0]?.startsWith("-")) words.shift(); continue; }
      if (ENV_DUMPERS.has(w)) {
        dumper = w; words.shift();
        while (words.length && (words[0].startsWith("-") || ASSIGN.test(words[0]))) words.shift();
        if (w === "printenv") { words = []; }
        continue;
      }
      break;
    }
    if (!words.length) { if (dumper) out.push({ kind: "env-dump", target: dumper }); continue; }
    const head = path.basename(words[0]);
    if (head === "cd") { const t = words[1]; dir = !t || t === "-" ? dir : path.resolve(dir, expandHome(t)); continue; }
    if ((head === "export" && words[1] === "-p") || (head === "set" && words.length === 1)) {
      out.push({ kind: "env-dump", target: head }); continue;
    }
    if (depth < 3 && SHELLS.has(head)) {
      const i = words.findIndex((x, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(x)); // lang-regex-ok: shell option flags like -c / -lc
      if (i > 0 && words[i + 1] != null) out.push(...bashAccesses(words[i + 1], { cwd: dir, root, home, depth: depth + 1 }));
      else for (const w of words.slice(1)) { const kind = protectedPath(w, { cwd: dir, root, home }); if (kind) out.push({ kind, target: w }); }
      continue;
    }
    if (depth < 3 && head === "eval") { out.push(...bashAccesses(words.slice(1).join(" "), { cwd: dir, root, home, depth: depth + 1 })); continue; }
    if (head === "op") { out.push({ kind: "1password-cli", target: `op ${words[1] || ""}`.trim() }); continue; }
    if (head === "security" && KEYCHAIN_READS.has(words[1])) { out.push({ kind: "keychain-read", target: `security ${words[1]}` }); continue; }
    for (const w of words) {
      // `--file=/x/.env`, `<.env` are split oddly; check the value after = too.
      for (const cand of [w, w.includes("=") ? w.slice(w.indexOf("=") + 1) : null]) {
        if (!cand) continue;
        const kind = protectedPath(cand.replace(/^[<>]+/, ""), { cwd: dir, root, home }); // lang-regex-ok: shell redirection characters on a path word
        if (kind) { out.push({ kind, target: cand }); break; }
      }
    }
  }
  return out;
}

function guardMode() {
  try {
    const { localConfig } = require("./instance.cjs");
    const m = String(localConfig("agent-env", { guard: "log" }).guard || "log");
    return ["log", "block", "off"].includes(m) ? m : "log";
  } catch { return "log"; }
}

function logLine(s) {
  try {
    const f = path.join(installRoot(), "agent/logs/secrets-guard.log");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${new Date().toISOString()} ${s}\n`);
  } catch {}
}

// Returns { code, stderr? }. Never throws: a guard error allows the call.
export function runHook(inputText, { mode = guardMode(), log = logLine } = {}) {
  if (mode === "off") return { code: 0 };
  let input;
  try { input = JSON.parse(inputText || "{}"); } catch { return { code: 0 }; }
  let hits;
  try { hits = findAccesses(input); } catch { return { code: 0 }; }
  if (!hits.length) return { code: 0 };
  const what = hits.map((h) => `${h.kind}:${h.target}`).join(", ").slice(0, 300);
  const where = input.cwd ? path.basename(input.cwd) : "?";
  if (mode === "block") {
    log(`BLOCKED ${input.tool_name} in ${where} :: ${what}`);
    return {
      code: 2,
      stderr: `secrets-guard: blocked — this reads the installation's secrets directly (${what}). Agents never read .env, the secrets directories, the 1Password CLI or the keychain themselves: run the tool that needs the secret (it reads .env on its own), or tell the user what you need. See docs/agent-secrets.md.`,
    };
  }
  log(`LOGGED ${input.tool_name} in ${where} :: ${what}`);
  return { code: 0 };
}
