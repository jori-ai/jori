"use strict";
// max-judge — one tool-less, structured-output judgment on the Max subscription.
//
// For scripts that need a model to read a document and fill a JSON schema
// (a receipt or quote scanner, a mail-scan adapter). Same flags and reasons as
// lib/jev-claude.mjs, which is the ESM equivalent for text verdicts:
//   --tools ""                          no tools at all (built-ins included)
//   --strict-mcp-config --mcp-config {} no MCP servers
//   --setting-sources project + cwd=tmp no jori settings, hooks or permissions
//   --no-session-persistence            throwaway judgments
//   env without ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN → Max session only
//     (agent/CLAUDE.md § Auth Model: no API-key-billed calls)
//   prompt on STDIN
//
// AUTH: `claude -p` reads the Max credential from the login keychain, which
// only unlocks inside the GUI (Aqua) session. From cron or SSH it prints
// "Not logged in" — so callers run as launchd user agents, not crontab.
//
// Errors that will fail every later call the same way (not logged in, a usage
// limit) are thrown with `fatal = true` so a batch stops at the first one
// instead of logging it N times and exiting 0.

const { execFile } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), ".local/bin/claude");

// Machine-generated CLI/API error text, not language.
// lang-regex-ok: claude CLI auth/limit error strings
const FATAL_RE = /not logged in|failed to authenticate|please run \/login|invalid api key|oauth|usage limit|limit reached|credit balance/i;

function maxOnlyEnv(base = process.env) {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/**
 * `webSearch: true` is the ONE tool a judgment may be given (for a watch job's
 * capped lookup of something its own sources do not cover): built-in
 * WebSearch and nothing else — no Bash, no files, no MCP.
 *
 * `onResult(rawResult)` is called with the CLI's whole JSON result (usage, cost,
 * session id) before the structured object is returned, so a caller can write a
 * cost row; an exception inside it never fails the judgment.
 *
 * `appendSystem` is text added to Claude Code's own system prompt
 * (`--append-system-prompt`). The CLI caches the system prompt between calls and
 * not the stdin prompt (measured 2026-10-27: a repeated appended block was read
 * from cache on the second call, the same text at the top of stdin was written
 * afresh), so a caller that sends the same long instructions on every call puts
 * them here and only the per-call data on stdin. `system` replaces the system
 * prompt instead.
 *
 * @returns {Promise<object>} the schema-conforming object
 */
function judge({ model, system, appendSystem, prompt, schema, effort = "low", timeoutMs = 180000, webSearch = false, onResult = null }) {
  const args = [
    "-p", "--model", model, "--effort", effort,
    "--tools", webSearch ? "WebSearch" : "",
    ...(webSearch ? ["--allowedTools", "WebSearch"] : []),
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "project",
    "--no-session-persistence",
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
  ];
  if (system) args.push("--system-prompt", system);
  if (appendSystem) args.push("--append-system-prompt", appendSystem);

  return new Promise((resolve, reject) => {
    const child = execFile(
      CLAUDE_BIN,
      args,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, cwd: os.tmpdir(), env: maxOnlyEnv() },
      (err, stdout, stderr) => {
        let out = null;
        try {
          out = JSON.parse(stdout);
        } catch {}
        const problem = String((out && out.is_error && out.result) || (!out && (stderr || stdout)) || (err && err.message) || "");
        if (out && typeof onResult === "function") { try { onResult(out); } catch { /* a ledger write never fails a judgment */ } }
        if (out && !out.is_error && out.structured_output && typeof out.structured_output === "object") {
          return resolve(out.structured_output);
        }
        const e = new Error(`claude -p: ${(problem || "no structured output").trim().slice(0, 200)}`);
        e.fatal = FATAL_RE.test(problem) || FATAL_RE.test(String(stdout || ""));
        reject(e);
      }
    );
    child.on("error", (e) => reject(Object.assign(new Error(`claude -p: ${e.message}`), { fatal: true })));
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

module.exports = { judge, maxOnlyEnv, CLAUDE_BIN };
