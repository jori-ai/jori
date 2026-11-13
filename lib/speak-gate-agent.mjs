// speak-gate-agent — the speak gate's read-only research session, shared by
// the gate itself (bin/speak-gate.mjs) and its nightly audit
// (bin/speak-gate-audit.mjs). system/speak-gate.md § Research, § Nightly audit.
//
// A `claude -p` session on Max with READ-ONLY tools: the Jori read CLIs, gog
// reads, Read/Grep/Glob with secrets denied, and the web unless the message is
// about money or health. --permission-mode dontAsk refuses anything else
// without a prompt; no MCP servers, no settings files, no session kept.
//
// Also: the audit's lessons (data/speak-gate-lessons.json), which the gate
// reads into its prompt — the audit's feedback to the gate.
"use strict";

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { maxOnlyEnv, DEFAULT_CLAUDE_BIN } from "./jev-claude.mjs";
import { extractJsonObject } from "./extract-json.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { instance } = require(path.join(ROOT, "lib", "instance.cjs"));
const { installTools } = require(path.join(ROOT, "lib", "root.cjs"));

export const OWNER = instance().owner_name || "the user";
export const ASSISTANT = instance().assistant_name || "Jori"; // control-scan-ok: the setting's default
const GOG = process.env.SPEAK_GATE_GOG_BIN || "/opt/homebrew/bin/gog";
const CLAUDE_BIN = process.env.SPEAK_GATE_CLAUDE_BIN || DEFAULT_CLAUDE_BIN;

const B = (name) => path.join(ROOT, "bin", name);
export const TOOLS_DOC = `READ-ONLY TOOLS (use them; a verdict without research is not acceptable). Call each by its FULL PATH as written, never after \`cd\`; pipe only into head, tail, grep, jq, wc, sort, uniq, cut or tr. Anything else is refused.:
- ${B("db-read")} tables | ${B("db-read")} <table> "<postgrest query>"   every database table (messages, location history, health samples, finance, Plaid transactions, receipts, Amazon orders, trips, …). Start with \`tables\` when unsure where something lives.
- ${B("recall")} "<question>"   one search across chat, wiki, inbox and ${OWNER}'s replies.
- ${B("jori-messages-search")} "<text>" --k 8   semantic search of every message between ${OWNER} and ${ASSISTANT}.
- ${B("wiki")} search "<q>" --k 5 | ${B("wiki")} read <id>   long-term memory.
- ${B("rentals")} <overview|property|tenants|tenant|leases|accounts|transactions|pnl|orders|order|receipts> …   the rental portfolio's books (tenants, leases, ledger, Amazon orders, receipts). \`${B("rentals")} help\` lists options.
- ${B("location-day")} <YYYY-MM-DD>   where ${OWNER} went that day, legs and modes, with step counts (walked or rode).
- ${B("findme")} history <YYYY-MM-DD>   the raw location timeline.
- ${B("travel")} where <date> | ${B("travel")} list   the travel timeline (the authority on where ${OWNER} is).
- ${B("finance-facts")} questions | ${B("finance-facts")} list <txn|income|payment|move|exception>   what the finance review recorded.
- ${GOG} calendar list --json --results-only --from <iso> --to <iso> --all
- ${GOG} gmail search "<gmail query>" --max 10   email.
- ${GOG} tasks list <list>   task lists.
- Read / Grep / Glob over ${ROOT} (logs under agent/logs, data stores under data/). Secrets are off limits.
- WebSearch / WebFetch (when offered)   the outside world (an event's lineup, a price, a business, a date). NEVER put ${OWNER}'s personal data in a web query: no account numbers, amounts, balances, health values, addresses or names of people he knows. Search for the public thing (the band, the venue, the company), never for the person.`;

// Bank and health content is Jori-model-only and never goes into an outbound
// web request (agent/CLAUDE.md § Financial Operations rule 5, § Health): a
// message from a money or health role, or with a private intent, is
// researched without WebSearch/WebFetch.
const PRIVATE_PREFIXES = ["bank", "health", "net-worth", "property", "finance", "fin-", "hum:finance", "hum:stocks", "portfolio", "plaid", "broker"];
export function webAllowed(input, cfg = {}) {
  const noWeb = new Set(cfg.no_web_roles || ["cfo", "health-coach"]);
  if (noWeb.has(String(input.sender || ""))) return false;
  const i = String(input.intent || "").toLowerCase();
  return !PRIVATE_PREFIXES.some((p) => i.startsWith(p));
}

export function agentArgs(model, effort, web = true) {
  const bash = ["db-read", "recall", "jori-messages-search", "wiki", "rentals", "location-day", "travel", "finance-facts"]
    .map((b) => `Bash(${B(b)}:*)`)
    .concat([`Bash(${B("findme")} history:*)`, `Bash(${GOG} calendar list:*)`, `Bash(${GOG} gmail search:*)`, `Bash(${GOG} tasks list:*)`])
    // Read-only filters, so `… | head` or `… | jq` is not refused whole (the
    // first research replay lost most of its shell calls to an unlisted pipe).
    .concat(["head", "tail", "jq", "wc", "sort", "uniq", "cut", "grep", "tr"].map((f) => `Bash(${f}:*)`));
  return [
    "-p", "--model", model, "--effort", effort,
    "--tools", web ? "Bash,Read,Grep,Glob,WebSearch,WebFetch" : "Bash,Read,Grep,Glob",
    "--allowedTools", ["Read", "Grep", "Glob", ...(web ? ["WebSearch", "WebFetch"] : []), ...bash].join(","),
    "--disallowedTools", ["Read(**/.env*)", "Grep(**/.env*)", "Read(**/*oauth*)", "Read(**/*secret*)", "Read(**/*.key)", "Read(**/*.pem)", "Read(**/.ssh/**)"].join(","),
    "--permission-mode", "dontAsk",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "project",
    "--add-dir", ROOT,
    "--no-session-persistence",
    "--output-format", "text",
  ];
}

/** Run one research session. Resolves {text, err}; never rejects. */
export function runAgent(prompt, { model, effort, timeoutMs, web }) {
  return new Promise((resolve) => {
    const child = execFile(CLAUDE_BIN, agentArgs(model, effort, web),
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, cwd: os.tmpdir(), env: maxOnlyEnv() },
      (err, stdout) => resolve({ text: String(stdout || "").trim(), err }));
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

/** The last line of the answer that is a JSON object, else the first object found. */
export function lastJson(text) {
  const lines = String(text).trim().split("\n").reverse();
  for (const l of lines) { const t = l.trim(); if (t.startsWith("{") && t.endsWith("}")) { try { return JSON.parse(t); } catch {} } }
  try { return extractJsonObject(text); } catch { return null; }
}

// ─── The audit's lessons: feedback to the gate ─────────────────────────────

export const lessonsPath = () => process.env.SPEAK_GATE_LESSONS || installTools("data", "speak-gate-lessons.json");

/** The lessons the nightly audit left for the gate: [{text, since, cases}]. Never throws. */
export function readLessons() {
  if (process.env.SPEAK_GATE_NO_LESSONS === "1") return [];
  try {
    const j = JSON.parse(readFileSync(lessonsPath(), "utf8"));
    return Array.isArray(j.lessons) ? j.lessons.filter((l) => l && String(l.text || "").trim()) : [];
  } catch { return []; }
}
