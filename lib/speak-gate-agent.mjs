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
// reads into its prompt — the audit's feedback to the gate; and the rewrite
// check (checkRewrite below), the tool-less pass that reads every rewrite
// before it replaces the sender's text.
"use strict";

import { execFile } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { maxOnlyEnv, DEFAULT_CLAUDE_BIN, runToollessDetailed } from "./jev-claude.mjs";
import { extractJsonObject } from "./extract-json.mjs";
import { localLlmChat, localLlmBackend } from "./local-llm.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { instance } = require(path.join(ROOT, "lib", "instance.cjs"));
const { installTools } = require(path.join(ROOT, "lib", "root.cjs"));
const { MODELS } = require(path.join(ROOT, "lib", "models.cjs"));

export const OWNER = instance().owner_name || "the user";
export const ASSISTANT = instance().assistant_name || "Jori"; // control-scan-ok: the setting's default
// gog through its shim (bin/shims/gog reads the keyring password from .env
// itself): the research session starts without .env secrets (modelEnv).
const GOG_SHIM = installTools("bin/shims/gog");
export const GOG = process.env.SPEAK_GATE_GOG_BIN || (fs.existsSync(GOG_SHIM) ? GOG_SHIM : process.env.GOG_BIN || "/opt/homebrew/bin/gog");
const CLAUDE_BIN = process.env.SPEAK_GATE_CLAUDE_BIN || DEFAULT_CLAUDE_BIN;
// The rewrite check's model binary (a test stand-in; the judge's otherwise).
const CHECK_BIN = process.env.SPEAK_GATE_CHECK_BIN || CLAUDE_BIN;

const B = (name) => path.join(ROOT, "bin", name);
export const TOOLS_DOC = `READ-ONLY TOOLS (use them; a verdict without research is not acceptable). Call each by its FULL PATH as written, never after \`cd\`; pipe only into head, tail, grep, jq, wc, sort, uniq, cut or tr. Anything else is refused.:
- ${B("db-read")} tables | ${B("db-read")} <table> "<postgrest query>"   every database table (messages, location history, health samples, finance, Plaid transactions, receipts, Amazon orders, trips, …). Start with \`tables\` when unsure where something lives.
- ${B("recall")} "<question>"   one search across chat, wiki, inbox and ${OWNER}'s replies.
- ${B("jori-messages-search")} "<text>" --k 8   semantic search of every message between ${OWNER} and ${ASSISTANT}.
- ${B("wiki")} search "<q>" --k 5 | ${B("wiki")} read <id>   long-term memory.
- ${B("work-record")} find "<q>" | ${B("work-record")} show <id> | ${B("work-record")} list --since <YYYY-MM-DD>   one-off work ${ASSISTANT} did for ${OWNER} (a comparison, an evaluation, research, a review): the bottom line, the deliverable's full text as delivered, and dated updates. A message that leans on earlier work ("the review", "the comparison", a recommendation) is checked against the record, and against its updates and its as-of date.
- ${B("rentals")} <overview|property|tenants|tenant|leases|accounts|transactions|pnl|orders|order|receipts> …   the rental portfolio's books (tenants, leases, ledger, Amazon orders, receipts). \`${B("rentals")} help\` lists options.
- ${B("location-day")} <YYYY-MM-DD>   where ${OWNER} went that day, legs and modes, with step counts (walked or rode).
- ${B("findme")} history <YYYY-MM-DD>   the raw location timeline.
- ${B("travel")} where <date> | ${B("travel")} list   the travel timeline (the authority on where ${OWNER} is).
- ${B("finance-facts")} questions | ${B("finance-facts")} list <txn|income|payment|move|exception>   what the finance review recorded.
- ${GOG} calendar list --json --results-only --from <iso> --to <iso> --all
- ${GOG} gmail search "<gmail query>" --max 10   email.
- ${GOG} gmail get <messageId> | ${GOG} gmail messages search "<gmail query>" --max 5 --include-body   an email's full text. A search row shows only a subject and a snippet: open the email before saying what it says, or that it does not say something.
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
    .concat(["find", "show", "list"].map((c) => `Bash(${B("work-record")} ${c}:*)`))
    .concat([`Bash(${B("findme")} history:*)`, `Bash(${GOG} calendar list:*)`, `Bash(${GOG} gmail search:*)`, `Bash(${GOG} tasks list:*)`])
    // Reading an email's body (the audit found claims about mail the judge
    // could not open). `messages modify` and `thread get --download` stay out.
    .concat([`Bash(${GOG} gmail get:*)`, `Bash(${GOG} gmail messages search:*)`])
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

// ─── The rewrite check ─────────────────────────────────────────────────────
//
// The nightly audit found rewrites that ADDED claims nothing showed: a reply
// "not on record" that the sent-mail log held, a device "still offline" hours
// after it came back, a time the judge made up. So every rewrite is read once
// more, tool-less, before it replaces the sender's text: does it state
// anything that neither the original, the gate's records nor the gate's own
// findings show, or that the records contradict? The Rule #0b ladder: Haiku
// (localLlmChat) first, Sonnet only when that answer fails the schema or the
// call fails, and never past `deadline`. What a failed or unfinished check
// means is the caller's (bin/speak-gate.mjs: the original is sent).

const CHECK_RUNG_MS = { haiku: 40000, sonnet: 60000 };
const CHECK_MIN_MS = 10000; // a rung with less time left than this is not started

export function rewriteCheckPrompt({ original, rewrite, findings, records }) {
  const f = findings || {};
  return `You check one rewrite before it reaches ${OWNER}. A fact-checking gate replaced a message (ORIGINAL) with its own text (REWRITE). A rewrite may correct, cut, shorten, reorder or rephrase. It must not state anything that nothing below shows.

List:
- "added": each factual claim in the REWRITE that none of ORIGINAL, THE GATE'S FINDINGS and RECORDS states or plainly implies. A factual claim is a time, date, amount, count, name, place, status, who did or said what, or that something exists or does not exist ("no reply on record" and "not on the calendar" are claims). Not a claim: rewording, a question, or a recommendation or offer built only from facts that are shown.
- "contradicted": each claim in the REWRITE that RECORDS contradict, even when THE GATE'S FINDINGS state it, with what the record shows.
THE GATE'S FINDINGS show a claim only when they say where it was found (a record, a search, a source); a bare assertion there shows nothing.
Quote each claim briefly, as the rewrite words it. Leave a list empty when there is nothing.

ORIGINAL:
"""${original}"""

REWRITE:
"""${rewrite}"""

THE GATE'S FINDINGS (what it says it checked and found):
reason: ${f.reason || "(none)"}
checks: ${JSON.stringify(f.checks || {})}
sources: ${JSON.stringify(f.sources || [])}

RECORDS (what the gate was given before it judged, read by code):
${String(records || "(none)").slice(0, 60000)}

Answer with ONE line of JSON and nothing else: {"added":["..."],"contradicted":["..."]}`;
}

/** A check answer that fits the schema ({added, contradicted}: lists of strings), or null. */
export function parseCheck(text) {
  const p = lastJson(text);
  if (!p || typeof p !== "object" || !Array.isArray(p.added) || !Array.isArray(p.contradicted)) return null;
  const list = (a) => (a.every((x) => typeof x === "string") ? a.map((x) => x.trim()).filter(Boolean).slice(0, 8).map((x) => x.slice(0, 240)) : null);
  const added = list(p.added), contradicted = list(p.contradicted);
  return added && contradicted ? { added, contradicted } : null;
}

async function askTier(tier, prompt, timeoutMs) {
  // localLlmChat floors a Haiku call at 30 s; the rung's own limit wins here.
  const run = (o) => runToollessDetailed({ ...o, bin: CHECK_BIN, timeoutMs: Math.min(o.timeoutMs, timeoutMs) });
  if (tier === "haiku") return localLlmChat({ user: prompt, timeoutMs, run });
  const { out, error } = await run({ model: MODELS.sonnet, prompt, effort: "low", timeoutMs });
  if (error || !out) throw new Error(`sonnet ${error?.kind || "empty_output"}`);
  return out;
}

/**
 * Check one rewrite. Never throws.
 * @param {{original:string, rewrite:string, findings?:{reason?, checks?, sources?}, records?:string,
 *   deadline?:number (epoch ms), ask?:(tier, prompt, timeoutMs) => Promise<string>}} o
 * @returns {Promise<{ran:true, added:string[], contradicted:string[], tier:string, attempts:object[], ms:number}
 *   | {ran:false, error:string, attempts:object[], ms:number}>}
 */
export async function checkRewrite({ original, rewrite, findings, records, deadline = Date.now() + 100000, ask = askTier }) {
  const t0 = Date.now();
  const prompt = rewriteCheckPrompt({ original, rewrite, findings, records });
  // The first rung is Haiku or nothing: behind the local-model kill switch
  // localLlmChat is a 1B model, and a check that waves claims through is worse
  // than none.
  const tiers = localLlmBackend() === "haiku" ? ["haiku", "sonnet"] : ["sonnet"];
  const attempts = [];
  for (const tier of tiers) {
    const left = deadline - Date.now();
    if (left < CHECK_MIN_MS) { attempts.push({ tier, error: "no time left" }); break; }
    let text;
    try { text = await ask(tier, prompt, Math.min(CHECK_RUNG_MS[tier], left)); }
    catch (e) { attempts.push({ tier, error: String(e.message || e).slice(0, 120) }); continue; }
    const v = parseCheck(text);
    if (!v) { attempts.push({ tier, error: `off schema: ${String(text).slice(-80)}` }); continue; }
    attempts.push({ tier, ok: true });
    return { ran: true, ...v, tier, attempts, ms: Date.now() - t0 };
  }
  return { ran: false, error: attempts.map((a) => `${a.tier}: ${a.error}`).join("; ").slice(0, 200), attempts, ms: Date.now() - t0 };
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
