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
// reads into its prompt — the audit's feedback to the gate; the rewrite
// check (checkRewrite below), the tool-less pass that reads every rewrite
// before it replaces the sender's text; and the trim (trimOriginal below),
// which cuts the wrong part out of the original when a rewrite is withdrawn.
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

// ─── Who a message names ───────────────────────────────────────────────────
//
// A calendar ping named a person by full name and said how the user knows
// them, for an event titled with a first name only. The first name matched a
// wiki person page, and the gate verified the facts against the event's TITLE
// and that same page, so it passed. The event's own invite came from another
// firm and its guest was a different person. An identity claim is true only
// when the event or message itself shows it. Shared by the judge's TRUE check
// and the rewrite check; the same rule is in the hum composer (jobs/hum.md) and
// in resolve-first (lib/hum-resolve-first.mjs).
export const IDENTITY_RULE = `WHO THE MESSAGE NAMES. When it names a person with more than a first name, or says who they are or how ${OWNER} knows them (a surname, a company, a role, "you introduced them to…", "your…"), that claim is TRUE only if it comes from the thing itself: the calendar event's own organizer or guest e-mail addresses (listed with each event, "invite from…, guests…"), its notes, the e-mail or message it is about, or a contact or wiki page found by that EMAIL ADDRESS. A match on a first name alone is NOT evidence: a title like "Sam / ${OWNER} - project" matching a wiki page for some other Sam proves nothing, and a wiki page that produced the guess cannot also confirm it. Compare the event's organizer and guests with the person the message names; if the address belongs to someone else, or to nobody on file, or the event lists no one, the claim is false or unverifiable: say so in checks.true, and fix it by rewriting with just the first name and no identity claim (or with who the event itself shows), or resolve it from the guest address and the recent chat. Evidence that points the other way (an agenda or chat that ties the same first name to a different matter) counts against the match.`;

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
- "added": each factual claim in the REWRITE that none of ORIGINAL, THE GATE'S FINDINGS and RECORDS states or plainly implies. A factual claim is a time, date, amount, count, name, place, status, who did or said what, who a person is (a full name, a company, a relationship) or that something exists or does not exist ("no reply on record" and "not on the calendar" are claims). A person's identity is shown only by an e-mail address, an organizer or guest, or the thing's own text, never by a first name that happens to match. Not a claim: rewording, a question, or a recommendation or offer built only from facts that are shown.
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

// ─── The trim: the original without the part the judge found wrong ─────────
//
// When a rewrite is withdrawn (it said something nothing shows) and the judge
// had found the ORIGINAL wrong, sending the original as written delivers a
// message the gate already knows is wrong. The judge's truth note is free
// text: it may say the original is false, or only what it confirmed or could
// not check. So a model first reads the note (original_wrong), and only when
// it says something the original states is false does it cut out that part,
// deleting words and never adding any. A cut the caller's `accept` rejects
// (bin/speak-gate.mjs passes isPureDeletion against the original) counts like
// an off-schema answer and climbs to the next rung. The caller then runs
// checkRewrite on the result, because deleting a "not" can flip a sentence.
// Same ladder and deadline rules as the check. What each outcome means is the
// caller's (bin/speak-gate.mjs).

export function trimPrompt({ original, finding, reason, choices }) {
  const tappable = Array.isArray(choices) && choices.length
    ? `\n- The message is sent with tappable choices (${choices.join(" | ")}). Keep the question they answer; if that question is the wrong part, answer with "trimmed": null.`
    : "";
  return `A fact-checking gate checked a message to ${OWNER} and wrote the note below about whether its claims are true. Its own correction was rejected, so the question is what to send instead.

First decide: does THE GATE'S FINDING say that something the ORIGINAL states is false, or contradicted by a record or source? A note that only says the claims were confirmed or match a source, could not be checked, were taken from the original, or that the wording could be better does NOT say the original is wrong: then answer {"original_wrong":false,"trimmed":null,"removed":[]}.

If it does say part of the original is false, remove only that part, so the rest can still be sent.

Rules for the removal:
- DELETE ONLY. Every word you keep must appear in the ORIGINAL, in the same order. Never add, change, reword or reorder a word. You may drop whole sentences, a clause or a few words, and nothing else.
- Remove exactly what THE GATE'S FINDING says is wrong, and the words that only make sense with it. Keep everything else.
- Never remove a word like "not", "no" or "never" on its own when that flips what a sentence says.
- If what is wrong is the whole point of the message (removing it leaves nothing worth sending), answer with "trimmed": null and "original_wrong": true.${tappable}

THE GATE'S FINDING (what it says is wrong with the original):
${finding}${reason ? `\nreason: ${reason}` : ""}

ORIGINAL:
"""${original}"""

Answer with ONE line of JSON and nothing else: {"original_wrong":true,"trimmed":"<the original with the wrong part removed>","removed":["<each part you removed, as written>"]}, or {"original_wrong":true,"trimmed":null,"removed":[]}, or {"original_wrong":false,"trimmed":null,"removed":[]}`;
}

/** A trim answer that fits the schema ({original_wrong: boolean, trimmed: string|null, removed: string[]}), or null. */
export function parseTrim(text) {
  const p = lastJson(text);
  if (!p || typeof p !== "object" || Array.isArray(p) || typeof p.original_wrong !== "boolean") return null;
  if (!p.original_wrong) return { original_wrong: false, trimmed: null, removed: [] };
  if (!("trimmed" in p) || (p.trimmed !== null && typeof p.trimmed !== "string")) return null;
  const removed = p.removed === undefined ? [] : p.removed;
  if (!Array.isArray(removed) || !removed.every((x) => typeof x === "string")) return null;
  const trimmed = p.trimmed === null || !p.trimmed.trim() ? null : p.trimmed.trim();
  return { original_wrong: true, trimmed, removed: removed.map((x) => x.trim()).filter(Boolean).slice(0, 8).map((x) => x.slice(0, 240)) };
}

// Punctuation a cut may drop from a word's edges (a sentence now ends earlier,
// a bracket closes earlier). A cut may drop it, never change or add it.
// A hyphen is not an edge: "-5%" and "5%" say different things.
const EDGE = new Set([..."\"'“”‘’`.,;:!?…()[]{}«»—–*_"]);
// lang-regex-ok: a Unicode character class (letter or digit) on one character, structure not meaning
const WORD_CHAR = /[\p{L}\p{N}]/u;
const hasWordChar = (w) => [...w].some((ch) => WORD_CHAR.test(ch));

function tokens(s) {
  // Whitespace-separated tokens, compared by code to prove one string is a
  // deletion of another. Character tests only: nothing here reads meaning.
  const out = [];
  let cur = "";
  for (const ch of String(s || "")) {
    if (ch.trim() === "") { if (cur) out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function core(w) {
  let a = 0, b = w.length;
  while (a < b && EDGE.has(w[a])) a++;
  while (b > a && EDGE.has(w[b - 1])) b--;
  return w.slice(a, b);
}

// A kept token stands for an original one when it is a contiguous piece of it
// that still holds its core: edge punctuation dropped, nothing changed or
// added ("3pm." → "3pm", never "3pm?"). Case may differ. A token with no
// letter or digit must be one of the original's exactly.
function keeps(kept, orig) {
  if (!hasWordChar(kept) || !hasWordChar(orig)) return kept === orig;
  const k = kept.toLowerCase(), o = orig.toLowerCase(), c = core(o);
  return !!c && o.includes(k) && k.includes(c);
}

/** True when `trimmed` is `original` with at least one token deleted and none added, changed or moved. */
export function isPureDeletion(original, trimmed) {
  const o = tokens(original), t = tokens(trimmed);
  if (!t.some(hasWordChar) || t.length >= o.length) return false;
  let i = 0;
  for (const w of t) {
    while (i < o.length && !keeps(w, o[i])) i++;
    if (i === o.length) return false;
    i++;
  }
  return true;
}

/**
 * Cut the part the judge found wrong out of the original. Never throws.
 * @param {{original:string, finding:string, reason?:string, choices?:string[], deadline?:number (epoch ms),
 *   ask?:(tier, prompt, timeoutMs) => Promise<string>, accept?:(trimmed:string) => boolean}} o
 *   `accept` vets a cut (isPureDeletion against the original): one it rejects climbs to the next rung.
 * @returns {Promise<{ran:true, original_wrong:boolean, trimmed:string|null, removed:string[], tier:string, attempts:object[], ms:number}
 *   | {ran:false, error:string, attempts:object[], ms:number}>}
 */
export async function trimOriginal({ original, finding, reason, choices, deadline = Date.now() + 100000, ask = askTier, accept = null }) {
  const t0 = Date.now();
  const prompt = trimPrompt({ original, finding, reason, choices });
  const tiers = localLlmBackend() === "haiku" ? ["haiku", "sonnet"] : ["sonnet"];
  const attempts = [];
  for (const tier of tiers) {
    const left = deadline - Date.now();
    if (left < CHECK_MIN_MS) { attempts.push({ tier, error: "no time left" }); break; }
    let text;
    try { text = await ask(tier, prompt, Math.min(CHECK_RUNG_MS[tier], left)); }
    catch (e) { attempts.push({ tier, error: String(e.message || e).slice(0, 120) }); continue; }
    const v = parseTrim(text);
    if (!v) { attempts.push({ tier, error: `off schema: ${String(text).slice(-80)}` }); continue; }
    if (v.original_wrong && v.trimmed !== null && accept && !accept(v.trimmed)) {
      attempts.push({ tier, error: "not a pure deletion of the original" });
      continue;
    }
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
