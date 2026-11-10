#!/usr/bin/env node
// speak-gate — think before you speak. The ONE gate every message to the user
// passes before it reaches them (system/speak-gate.md).
//
// The outbound precheck (bin/outbound-precheck.mjs) asked one narrow question —
// does this contradict or repeat the recent conversation? — on a quick,
// tool-less, low-effort read. It never asked whether the message is TRUE, whether
// Jori could have answered it without asking, whether it is asked well, or
// whether it is worth the user's attention. This gate asks all four:
//
//   1. TRUE & CURRENT — does every claim hold against the sources, right now?
//   2. SELF-RESOLVE   — could Jori settle this without the user (find the
//                       answer, close the question), or ask a better question?
//   3. PHRASING       — one clear point; a question is one decision with
//                       choices and a recommendation; short, in the user's style.
//   4. VALUE          — new to the user, actionable or genuinely interesting;
//                       otherwise it waits for a digest or is dropped.
//
// Verdicts: send | rewrite (message = the better text) | resolve (back to the
// role: research_plan says what to look up / answer instead) | digest (hold for
// the daily summary) | drop.
//
// Two depths (the user's call, 2026-11-10): a PROACTIVE message gets all four,
// Sonnet at medium effort with up to one round of read-only lookups. A REPLY to
// something the user just wrote gets the light check — 1 and 3 only, never
// dropped (it can only be sent or corrected).
//
// RESEARCH WITHOUT TOOLS. The judge runs tool-less (lib/jev-claude.mjs: no
// tools, no MCP, no settings). It may answer {"lookups":[…]} once instead of a
// verdict; this file runs those from a fixed READ-ONLY menu (wiki, calendar,
// travel, the message log, recorded finance facts) and asks again with the
// results. Nothing the model writes is ever executed as a command.
//
// Evidence: outbound-precheck in evidence mode (transcript, calendar, the
// user's dated words, wiki, acknowledged topics, today's pings, travel facts),
// plus what the precheck never had — the role's own conversation and the state
// of every question it asked (answered / open), which is what the Felix
// reply of 2026-11-10 got wrong.
//
// Claude only, never Jev: money and health messages pass through here too.
//
// Stdin:  {message, intent?, sender? (role id), kind?: "proactive"|"reply",
//          reply_to_text?, channel?, supporting_data?, as_of? (replay)}
// Stdout: {verdict, message?, research_plan?, reason, checks, lookups_used}
// Fail-open: an error emits {verdict:"send", reason:"gate_error:…"}.
// Env: SPEAK_GATE_LOG (default data/speak-gate-log.jsonl), SPEAK_GATE_NO_LOG=1.
"use strict";

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { runToollessDetailed, parseModelJson } from "../lib/jev-claude.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { MODELS } = require(path.join(ROOT, "lib", "models.cjs"));
const { instance } = require(path.join(ROOT, "lib", "instance.cjs"));
try { require(path.join(ROOT, "lib", "load-env.js")).loadEnv(); } catch { /* env may be set */ }
const rest = require(path.join(ROOT, "lib", "supabase-rest.js"));
let org = null;
try { org = require(path.join(ROOT, "lib", "org.cjs")); } catch { /* no team: names fall back to ids */ }

const OWNER = instance().owner_name || "the user";
const ASSISTANT = instance().assistant_name || "Jori"; // control-scan-ok: the setting's default
const LOG = process.env.SPEAK_GATE_LOG || path.join(ROOT, "data", "speak-gate-log.jsonl");
const GOG = process.env.SPEAK_GATE_GOG_BIN || "/opt/homebrew/bin/gog";
const VERDICTS = ["send", "rewrite", "resolve", "digest", "drop"];
const MAX_LOOKUPS = 3;
let AS_OF = null; // a replay's instant: lookups see nothing after it

function log(row) {
  if (process.env.SPEAK_GATE_NO_LOG === "1") return;
  try { mkdirSync(path.dirname(LOG), { recursive: true }); appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n"); } catch {}
}

function out(result, ctx) {
  process.stdout.write(JSON.stringify(result) + "\n");
  log({ ...ctx, ...result });
  process.exit(0);
}

// ─── Evidence ───────────────────────────────────────────────────────────────

function precheckEvidence(input) {
  const env = { ...process.env, OUTBOUND_PRECHECK_EVIDENCE: "1", OUTBOUND_PRECHECK_NO_ALERT: "1",
    OUTBOUND_PRECHECK_LOG: process.env.SPEAK_GATE_PRECHECK_LOG || path.join(ROOT, "data", "speak-gate-precheck-log.jsonl") };
  if (input.as_of) env.OUTBOUND_PRECHECK_AS_OF = input.as_of;
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin", "outbound-precheck.mjs")], {
    input: JSON.stringify({ message: input.message, intent: input.intent, agent: input.sender || "ops",
      supporting_data: input.supporting_data, created_at: input.as_of || null, solicited: input.kind === "reply" }),
    encoding: "utf8", timeout: 90000, env,
  });
  try { return JSON.parse(String(r.stdout || "").trim().split("\n").pop()); } catch { return null; }
}

const ts = (iso) => String(iso || "").slice(0, 16).replace("T", " ") + "Z";

async function roleThread(sender, asOf) {
  if (!sender) return "";
  const before = asOf ? `&created_at=lt.${encodeURIComponent(asOf)}` : "";
  const since = new Date((asOf ? Date.parse(asOf) : Date.now()) - 14 * 864e5).toISOString();
  try {
    const rows = await rest.request(`/rest/v1/jori_messages?select=role,content,created_at,metadata&conversation_id=eq.role:${encodeURIComponent(sender)}&created_at=gt.${encodeURIComponent(since)}${before}&order=created_at.desc&limit=25`);
    return (rows || []).reverse().map((m) => {
      // A question's state is today's; in a replay it would leak the later answer.
      const st = !asOf && m.metadata && m.metadata.question_state ? ` [question ${m.metadata.question_state}]` : "";
      return `- [${ts(m.created_at)}] ${m.role === "user" ? OWNER : "role"}${st}: ${String(m.content).slice(0, 300).replace(/\n/g, " ")}`; // lang-regex-ok: flattens newlines for a one-line log row
    }).join("\n");
  } catch { return ""; }
}

async function openQuestions(asOf) {
  if (asOf) return ""; // states are today's: unknowable as of a replay instant
  const since = new Date((asOf ? Date.parse(asOf) : Date.now()) - 14 * 864e5).toISOString();
  try {
    const rows = await rest.request(`/rest/v1/jori_messages?select=content,created_at,sender,metadata&role=eq.assistant&metadata->>question_state=eq.open&created_at=gt.${encodeURIComponent(since)}&order=created_at.desc&limit=20`);
    return (rows || []).map((m) => `- [${ts(m.created_at)}] (${m.sender || "?"}) ${String(m.content).slice(0, 200).replace(/\n/g, " ")}`).join("\n"); // lang-regex-ok: flattens newlines for a one-line log row
  } catch { return ""; }
}

// ─── The read-only lookup menu ──────────────────────────────────────────────

function run(bin, args, timeout = 15000) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout });
  return String(r.stdout || r.stderr || "").trim().slice(0, 2500) || "(nothing)";
}

const LOOKUPS = {
  wiki_search: { args: "query", doc: "search long-term memory (people, places, plans, decisions)", run: (a) => run(path.join(ROOT, "bin", "wiki"), ["search", String(a.query || ""), "--k", "4"]) },
  wiki_read: { args: "id", doc: "read one wiki page by id", run: (a) => run(path.join(ROOT, "bin", "wiki"), ["read", String(a.id || "").replace(/[^a-z0-9_-]/gi, "")]) },
  calendar: { args: "from, to (ISO dates)", doc: "calendar events in a range", run: (a) => run(GOG, ["calendar", "list", "--json", "--results-only", "--from", String(a.from || ""), "--to", String(a.to || ""), "--all"]) },
  travel_where: { args: "when (date or ISO time)", doc: "where the user is/will be", run: (a) => run(path.join(ROOT, "bin", "travel"), ["where", String(a.when || "")]) },
  messages_search: { args: "text, days (≤60)", doc: `search ${OWNER}'s conversations with ${ASSISTANT} (both sides)`, run: async (a) => {
    const days = Math.min(60, Math.max(1, Number(a.days) || 14));
    const until = AS_OF ? Date.parse(AS_OF) : Date.now();
    const since = new Date(until - days * 864e5).toISOString();
    const q = String(a.text || "").replace(/[%*,()]/g, " ").trim().slice(0, 80);
    if (!q) return "(no text)";
    try {
      const rows = await rest.request(`/rest/v1/jori_messages?select=role,content,created_at,metadata&content=ilike.*${encodeURIComponent(q)}*&created_at=gt.${encodeURIComponent(since)}${AS_OF ? `&created_at=lt.${encodeURIComponent(AS_OF)}` : ""}&order=created_at.desc&limit=8`);
      return (rows || []).map((m) => `- [${ts(m.created_at)}] ${m.role}${!AS_OF && m.metadata?.question_state ? ` [question ${m.metadata.question_state}]` : ""}: ${String(m.content).slice(0, 300).replace(/\n/g, " ")}`).join("\n") || "(no matches)"; // lang-regex-ok: flattens newlines for a one-line log row
    } catch (e) { return `(failed: ${e.message})`; }
  } },
  finance_facts: { args: "what: questions|txn|income|payment|move|exception", doc: "what the finance review has recorded or still asks", run: (a) => {
    const what = String(a.what || "questions");
    return what === "questions" ? run(path.join(ROOT, "bin", "finance-facts"), ["questions"]) : run(path.join(ROOT, "bin", "finance-facts"), ["list", what.replace(/[^a-z]/g, "")]);
  } },
};

async function runLookups(list) {
  const done = [];
  for (const l of (Array.isArray(list) ? list : []).slice(0, MAX_LOOKUPS)) {
    const tool = LOOKUPS[l && l.tool];
    if (!tool) { done.push({ ...l, result: "(unknown lookup)" }); continue; }
    let result;
    try { result = await tool.run(l.args || {}); } catch (e) { result = `(failed: ${e.message})`; }
    done.push({ tool: l.tool, args: l.args, result });
  }
  return done;
}

// ─── The judge ──────────────────────────────────────────────────────────────

function prompt(input, ev, extra, lookups) {
  const reply = input.kind === "reply";
  const who = input.sender && org ? (() => { try { const r = org.org().roles.find((x) => x.id === input.sender); return r ? `${r.name} (${r.title})` : input.sender; } catch { return input.sender; } })() : (input.sender || "ops");
  const E = (title, body) => (body && String(body).trim() ? `\n## ${title}\n${String(body).trim()}\n` : "");
  const menu = Object.entries(LOOKUPS).map(([k, v]) => `  - ${k} {${v.args}}: ${v.doc}`).join("\n");
  const checks = reply
    ? `This is a REPLY to something ${OWNER} just wrote. Light check, two questions only:
1. TRUE — is every claim in it supported by the evidence? A claim the evidence contradicts (e.g. "I can't tell whether you answered" when the thread shows the questions answered) must be fixed.
3. PHRASING — does it answer what ${OWNER} asked, directly, short, in plain words, without hedges like "tell me if…" or "I can't tell…" when the answer is findable?
A reply is NEVER dropped, held or sent back: the verdict is "send" or "rewrite".`
    : `This is a PROACTIVE message — ${OWNER} did not ask for it. Think before you speak. Four questions:
1. TRUE & CURRENT — is every claim true right now, against the evidence? Is it still relevant (not settled, not past, not already handled)?
2. SELF-RESOLVE — if it asks ${OWNER} something: could ${ASSISTANT} find the answer itself (the wiki, the message log, calendar, travel, recorded finance facts), or close the item without asking? If so → "resolve" with a research_plan naming where the answer is. If asking is right but the question is the wrong one (asks for something knowable, asks two things, asks what instead of the real decision) → "rewrite" with the better question.
3. PHRASING — one point. A question is ONE decision, with short choices and a recommendation first. Short, plain, topic first; no internal jargon (job names, ids, "the review's queue"); no hedging.
4. VALUE — would ${OWNER} be glad to get this now? New to them, actionable or genuinely interesting, and timely. Routine status with nothing to do → "digest" (waits for the daily summary). Nothing new, nothing to do, or noise about ${ASSISTANT}'s own plumbing → "drop".
Default to "send" only when all four pass. Prefer "rewrite" over "drop" when the core is valuable but the wording or question is off.`;
  return `You are the think-before-you-speak gate for ${OWNER}'s assistant (${ASSISTANT}). Every message to ${OWNER} passes you first. Sender: ${who}. Intent: ${input.intent || "unknown"}. Channel: ${input.channel || "chat"}.${input.as_of ? ` REPLAY: judge as of ${input.as_of}, the moment it was about to be sent. Anything dated after that instant (a wiki line, a reply, a decision) did not exist yet: ignore it. In particular ${OWNER}'s later answer to THIS message never counts as "already answered".` : ""}

${checks}

THE MESSAGE:
"""${input.message}"""
${reply ? E(`WHAT ${OWNER.toUpperCase()} WROTE (being answered)`, input.reply_to_text) : ""}${E("THIS ROLE'S CONVERSATION, LAST 14 DAYS (question states are authoritative)", extra.thread)}${E("QUESTIONS STILL OPEN (any role)", extra.open)}${E(`WHAT ${OWNER.toUpperCase()} SAID (dated, from the reply log)`, ev.owner_said)}${E("AUTHORITATIVE TRAVEL FACTS", ev.authoritative_facts)}${E("LONG-TERM MEMORY (wiki hits)", ev.long_term_memory)}${E("TOPICS ACKNOWLEDGED IN THE LAST 48H", ev.acknowledged_topics_48h)}${E("PINGS ALREADY SENT TODAY", ev.hum_pings_today)}${E("SENDER'S SUPPORTING DATA", ev.supporting_data)}${E("CHAT, LAST 8H", ev.transcript_last_8h)}${E("CALENDAR, REST OF TODAY", ev.calendar_today)}${lookups ? E("YOUR LOOKUPS", lookups.map((l) => `### ${l.tool} ${JSON.stringify(l.args || {})}\n${l.result}`).join("\n\n")) : ""}
${lookups ? "You have used your lookups: decide now." : `If a check needs a fact the evidence lacks, you may FIRST ask for up to ${MAX_LOOKUPS} read-only lookups instead of deciding — reply {"lookups":[{"tool":"…","args":{…}}]}. Menu:\n${menu}\nOnly when the answer could change the verdict; otherwise decide now.`}

Reply with ONE LINE of compact JSON, no prose, no fence:
{"verdict":"${reply ? "send|rewrite" : "send|rewrite|resolve|digest|drop"}","message":"<the rewritten text, only for rewrite>","research_plan":"<only for resolve: what to look up or answer instead of asking>","checks":{"true":"ok|<problem>","${reply ? "phrasing" : "self_resolve"}":"ok|<problem>"${reply ? "" : ',"phrasing":"ok|<problem>","value":"ok|<problem>"'}},"reason":"<≤160 chars>"}`;
}

async function judge(input, ev, extra) {
  const model = MODELS.sonnet;
  const effort = input.kind === "reply" ? "low" : "medium";
  let lookups = null;
  for (let round = 0; round < 2; round++) {
    const { out: text, error } = await runToollessDetailed({ model, effort, prompt: prompt(input, ev, extra, lookups), timeoutMs: 150000 });
    if (!text) throw new Error(`judge_unavailable:${error?.kind || "?"}`);
    const p = parseModelJson(text);
    if (!p) throw new Error(`judge_no_json:${text.slice(0, 80)}`);
    if (Array.isArray(p.lookups) && !lookups && round === 0) { lookups = await runLookups(p.lookups); continue; }
    if (!VERDICTS.includes(p.verdict)) p.verdict = "send";
    if (input.kind === "reply" && !["send", "rewrite"].includes(p.verdict)) p.verdict = "send";
    if (p.verdict === "rewrite" && !String(p.message || "").trim()) p.verdict = "send";
    return { ...p, lookups_used: (lookups || []).map((l) => ({ tool: l.tool, args: l.args })) };
  }
  throw new Error("judge_no_decision");
}

// ─── Main ───────────────────────────────────────────────────────────────────

let input;
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { out({ verdict: "send", reason: "gate_invalid_input" }, {}); }
if (!input || !String(input.message || "").trim()) out({ verdict: "send", reason: "gate_empty_input" }, {});
input.kind = input.kind === "reply" ? "reply" : "proactive";
AS_OF = input.as_of || null;
const ctx = { intent: input.intent || null, sender: input.sender || null, kind: input.kind, as_of: input.as_of || null, message: String(input.message).slice(0, 400), ...(input.replay_id ? { replay_id: input.replay_id } : {}) };
const t0 = Date.now();
try {
  const pre = precheckEvidence(input);
  if (pre && pre.decision && pre.decision !== "evidence") {
    // A deterministic stage decided (authority contradiction, settled subject,
    // stale premise). A reply is never dropped: its suppress becomes a send.
    const v = pre.decision === "suppress" ? (input.kind === "reply" ? "send" : "drop") : pre.decision === "modify" ? "rewrite" : "send";
    out({ verdict: v, ...(v === "rewrite" ? { message: pre.message } : {}), reason: `deterministic: ${pre.reason || ""}`.slice(0, 200), ms: Date.now() - t0 }, ctx);
  }
  const ev = (pre && pre.evidence) || {};
  if (pre && pre.message) input.message = pre.message;
  const [thread, open] = await Promise.all([roleThread(input.sender, input.as_of), openQuestions(input.as_of)]);
  const r = await judge(input, ev, { thread, open });
  out({ ...r, ms: Date.now() - t0 }, ctx);
} catch (e) {
  out({ verdict: "send", reason: `gate_error:${String(e.message || e).slice(0, 160)}`, ms: Date.now() - t0 }, ctx);
}
