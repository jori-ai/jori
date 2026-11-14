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
// role: research_plan says what was found / what to answer instead) | digest
// (hold for the daily summary) | drop.
//
// Two depths (the user's call, 2026-11-10): a PROACTIVE message gets all four;
// a REPLY to something the user just wrote gets 1 and 3 and is never dropped
// (it can only be sent or corrected).
//
// RESEARCH, NOT A GLANCE (the user, grading the first replay: "go beyond a
// cursory verification — check all available sources, including all our
// databases and applications, and the web"). The judge is a Claude session
// with READ-ONLY tools, as many steps as it needs within a time budget:
//   - bin/db-read (every Supabase table, GET only by construction), bin/recall
//     (chat + wiki + inbox + replies), bin/jori-messages-search, bin/wiki,
//     bin/rentals (the rental books, read-only by design), bin/location-day
//     (where, with steps), bin/findme history, bin/travel, bin/finance-facts,
//     gog calendar/gmail/tasks reads;
//   - Read/Grep/Glob over the installation (logs, data stores) with secrets
//     denied; WebSearch and WebFetch.
// Locked down: --permission-mode dontAsk (anything not allowed is refused, no
// prompt), only those Bash prefixes allowed, no MCP servers, no settings files,
// no session kept. It cannot write, send or change anything.
//
// Evidence handed to it up front (so research starts from what is known): the
// outbound precheck in evidence mode (transcript, calendar, the user's dated
// words, wiki hits, acknowledged topics, today's pings, travel facts and any
// place/date pairing the travel check flagged), the sending role's own
// conversation with each question's state, the questions still open, and the
// user's standing rules (agent/local/config/speak-gate.json standing_rules).
//
// Claude only, never Jev: money and health messages pass through here too.
//
// Stdin:  {message, intent?, sender? (role id), kind?: "proactive"|"reply"|"report",
//          reply_to_text?, channel?, supporting_data?, fixed_choices? (a card's
//          option labels), as_of? (replay)}
// Stdout: {verdict, message?, research_plan?, reason, checks, sources, ms}
// Fail-open: an error emits {verdict:"send", reason:"gate_error:…"}.
// Env: SPEAK_GATE_LOG (default data/speak-gate-log.jsonl), SPEAK_GATE_NO_LOG=1,
//      SPEAK_GATE_TIMEOUT_S (proactive 300, reply 120).
"use strict";

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { resolvedAnswers } from "../lib/speak-gate-live.mjs";
import { OWNER, ASSISTANT, TOOLS_DOC, webAllowed as webAllowedFor, runAgent, lastJson, readLessons } from "../lib/speak-gate-agent.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { MODELS } = require(path.join(ROOT, "lib", "models.cjs"));
const { localConfig } = require(path.join(ROOT, "lib", "instance.cjs"));
try { require(path.join(ROOT, "lib", "load-env.js")).loadEnv(); } catch { /* env may be set */ }
const rest = require(path.join(ROOT, "lib", "supabase-rest.js"));
let org = null;
try { org = require(path.join(ROOT, "lib", "org.cjs")); } catch { /* no team: names fall back to ids */ }

const LOG = process.env.SPEAK_GATE_LOG || path.join(ROOT, "data", "speak-gate-log.jsonl");
const VERDICTS = ["send", "rewrite", "resolve", "digest", "drop"];
// SPEAK_GATE_CONFIG: a config file to read instead (a staged replay).
const CFG = process.env.SPEAK_GATE_CONFIG
  ? JSON.parse(readFileSync(process.env.SPEAK_GATE_CONFIG, "utf8"))
  : localConfig("speak-gate", { standing_rules: [] });

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
      supporting_data: input.supporting_data, created_at: input.as_of || null, solicited: input.kind !== "proactive" }),
    encoding: "utf8", timeout: 90000, env,
  });
  try { return JSON.parse(String(r.stdout || "").trim().split("\n").pop()); } catch { return null; }
}

const ts = (iso) => String(iso || "").slice(0, 16).replace("T", " ") + "Z";
const oneLine = (s, n) => String(s).slice(0, n).split("\n").join(" ");

async function roleThread(sender, asOf) {
  if (!sender) return "";
  const before = asOf ? `&created_at=lt.${encodeURIComponent(asOf)}` : "";
  const since = new Date((asOf ? Date.parse(asOf) : Date.now()) - 14 * 864e5).toISOString();
  try {
    const rows = await rest.request(`/rest/v1/jori_messages?select=role,content,created_at,metadata&conversation_id=eq.role:${encodeURIComponent(sender)}&created_at=gt.${encodeURIComponent(since)}${before}&order=created_at.desc&limit=25`);
    return (rows || []).reverse().map((m) => {
      // A question's state is today's; in a replay it would leak the later answer.
      const st = !asOf && m.metadata && m.metadata.question_state ? ` [question ${m.metadata.question_state}]` : "";
      return `- [${ts(m.created_at)}] ${m.role === "user" ? OWNER : "role"}${st}: ${oneLine(m.content, 300)}`;
    }).join("\n");
  } catch { return ""; }
}

// Answers this gate already found instead of letting a question through (held
// resolve, last 14 days): a message asking one of them again is a re-ask, and
// the answer is right here.
async function foundAnswers(asOf) {
  try {
    const rows = await resolvedAnswers({ before: asOf || undefined, limit: 15 });
    return rows.map((r) => `- [${ts(r.judged_at)}] (${r.sender || "?"}) asked: ${oneLine(r.original || "", 200)}\n  found: ${oneLine(r.suggestion, 300)}`).join("\n");
  } catch { return ""; }
}

async function openQuestions(asOf) {
  if (asOf) return ""; // states are today's: unknowable as of a replay instant
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  try {
    const rows = await rest.request(`/rest/v1/jori_messages?select=content,created_at,sender,metadata&role=eq.assistant&metadata->>question_state=eq.open&created_at=gt.${encodeURIComponent(since)}&order=created_at.desc&limit=20`);
    return (rows || []).map((m) => `- [${ts(m.created_at)}] (${m.sender || "?"}) ${oneLine(m.content, 200)}`).join("\n");
  } catch { return ""; }
}

// The research session and its tools live in lib/speak-gate-agent.mjs (shared
// with the nightly audit). Money and health messages are researched without
// the web.
const webAllowed = (input) => webAllowedFor(input, CFG);

// ─── The judge ──────────────────────────────────────────────────────────────

function roleName(id) {
  if (!id || !org) return id || "ops";
  try { const r = org.org().roles.find((x) => x.id === id); return r ? `${r.name} (${r.title})` : id; } catch { return id; }
}

function prompt(input, ev, extra) {
  // A report email the user set up (kind "report") is checked like a reply:
  // truth and phrasing, never held.
  const reply = input.kind === "reply" || input.kind === "report";
  const E = (title, body) => (body && String(body).trim() ? `\n## ${title}\n${String(body).trim()}\n` : "");
  const rules = (CFG.standing_rules || []).map((r) => `- ${r}`).join("\n");
  // The nightly audit's feedback (bin/speak-gate-audit.mjs): an Opus review of
  // this gate's past decisions, distilled into lessons.
  const lessons = readLessons().map((l) => `- ${l.text}`).join("\n");
  const checks = input.kind === "report"
    ? `This is a REPORT EMAIL ${OWNER} set up (a scheduled brief, summary or report), shown as text. Two questions:
1. TRUE — verify its factual claims against the sources (tools below), the ones that matter most first. A claim the sources contradict, or a hedge where the answer is findable, must be fixed.
3. PHRASING — plain, clear, no internal jargon.
A report is NEVER dropped or held: the verdict is "send" or "rewrite". For "rewrite", "message" is the corrected text of only the parts you would change, each as "<what it said> → <what it should say>", one per line.`
    : reply
    ? `This is a REPLY to something ${OWNER} just wrote. Two questions:
1. TRUE — verify every factual claim against the sources (tools below). A claim the sources contradict, or a hedge ("I can't tell whether…", "tell me if…") where the answer is findable, must be fixed — find the answer and put it in.
3. PHRASING — answers what ${OWNER} asked, directly, short, plain.
A reply is NEVER dropped, held or sent back: the verdict is "send" or "rewrite".`
    : `This is a PROACTIVE message — ${OWNER} did not ask for it. Think before you speak. Four questions:
1. TRUE & CURRENT — verify every claim against the sources, not just the evidence below. A claim that something MATCHES (a listing fits a watch, an artist is the one followed, a charge is a known payee, a place is where ${OWNER} is) needs the match itself checked: a different act with a similar name is a false claim. Still relevant (not settled, past or already handled)?
2. SELF-RESOLVE — if it asks ${OWNER} something, look for the answer yourself first, in EVERY source (databases, location and steps, transactions, receipts, email, the books, messages, the web), not only the wiki. If you find it → "resolve" (never "drop"), and research_plan states the answer you found and where, so it is recorded instead of asked. If asking is right but the question is the wrong one → "rewrite" with the better question.
3. PHRASING — one point. A question is ONE decision with short choices and a recommendation first. Short, plain, topic first; no internal jargon; no hedging.
4. VALUE — would ${OWNER} be glad to get this now? New, actionable or genuinely interesting, timely. Routine status with nothing to do → "digest". Nothing new or ${ASSISTANT}'s own plumbing → "drop". ${OWNER}'s standing rules below override your sense of value.
Default to "send" only when all four pass. Prefer "rewrite" to "drop" when the core is valuable but the wording or question is off.`;
  return `You are the think-before-you-speak gate for ${OWNER}'s assistant (${ASSISTANT}). Every message to ${OWNER} passes you first. Sender: ${roleName(input.sender)}. Intent: ${input.intent || "unknown"}. Channel: ${input.channel || "chat"}. Now: ${input.as_of || new Date().toISOString()}.${input.as_of ? ` REPLAY: judge as of that instant, the moment it was about to be sent. Anything dated after it (a message, a wiki line, a row, an email) did not exist yet: ignore it. ${OWNER}'s later answer to THIS message never counts as "already answered".` : ""}

${checks}

RESEARCH FIRST. Use the tools to verify the claims and look for answers before you decide; check several sources, not one. Budget: a few minutes. You cannot change anything, and must not try.

${TOOLS_DOC}
${rules ? `\n## ${OWNER.toUpperCase()}'S STANDING RULES (their own words; they override your judgment)\n${rules}\n` : ""}${lessons ? `\n## LESSONS FROM THE NIGHTLY AUDIT (a senior reviewer re-checked your past decisions; apply these. ${OWNER}'s standing rules win over them)\n${lessons}\n` : ""}
THE MESSAGE:
"""${input.message}"""
${E("TAPPABLE CHOICES SENT WITH IT (fixed: a rewrite must still be a question these answer)", Array.isArray(input.fixed_choices) ? input.fixed_choices.join(" | ") : "")}${reply ? E(`WHAT ${OWNER.toUpperCase()} WROTE (being answered)`, input.reply_to_text) : ""}${E("THIS ROLE'S CONVERSATION, LAST 14 DAYS (question states are authoritative)", extra.thread)}${E("QUESTIONS STILL OPEN (any role)", extra.open)}${E("ANSWERS THIS GATE ALREADY FOUND (a question it held because it found the answer; asking one again is a re-ask: resolve it with the same answer)", extra.found)}${E(`WHAT ${OWNER.toUpperCase()} SAID (dated, from the reply log)`, ev.owner_said)}${E("TRAVEL TIMELINE FACTS", ev.authoritative_facts)}${E("TRAVEL CHECK FLAGGED (code paired a place and a date; decide yourself whether the message actually claims where the user is)", ev.travel_check_flagged)}${E("LONG-TERM MEMORY (wiki hits)", ev.long_term_memory)}${E("TOPICS ACKNOWLEDGED IN THE LAST 48H", ev.acknowledged_topics_48h)}${E("PINGS ALREADY SENT TODAY", ev.hum_pings_today)}${E("SENDER'S SUPPORTING DATA", ev.supporting_data)}${E("CHAT, LAST 8H", ev.transcript_last_8h)}${E("CALENDAR, REST OF TODAY", ev.calendar_today)}
When done, end your answer with ONE LINE of compact JSON (nothing after it):
{"verdict":"${reply ? "send|rewrite" : "send|rewrite|resolve|digest|drop"}","message":"<the rewritten text, only for rewrite>","research_plan":"<only for resolve: the answer you found and its source, or what is left to do>","checks":{"true":"ok|<problem>","${reply ? "phrasing" : "self_resolve"}":"ok|<problem>"${reply ? "" : ',"phrasing":"ok|<problem>","value":"ok|<problem>"'}},"sources":["<each source you checked, short>"],"reason":"<≤200 chars>"}`;
}

async function judge(input, ev, extra) {
  const reply = input.kind === "reply" || input.kind === "report";
  const timeoutMs = 1000 * Number(process.env.SPEAK_GATE_TIMEOUT_S || (reply ? 120 : 300));
  const { text, err } = await runAgent(prompt(input, ev, extra), { model: MODELS.sonnet, effort: reply ? "low" : "medium", timeoutMs, web: webAllowed(input) });
  if (!text) throw new Error(`judge_unavailable:${err?.killed ? "timeout" : (err?.code || "empty")}`);
  if (text.startsWith("Not logged in")) throw new Error("judge_unavailable:not_logged_in");
  const p = lastJson(text);
  if (!p || !p.verdict) throw new Error(`judge_no_json:${oneLine(text.slice(-120), 120)}`);
  if (!VERDICTS.includes(p.verdict)) p.verdict = "send";
  if (reply && !["send", "rewrite"].includes(p.verdict)) p.verdict = "send";
  if (p.verdict === "rewrite" && !String(p.message || "").trim()) p.verdict = "send";
  return p;
}

// ─── Main ───────────────────────────────────────────────────────────────────

let input;
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { out({ verdict: "send", reason: "gate_invalid_input" }, {}); }
if (!input || !String(input.message || "").trim()) out({ verdict: "send", reason: "gate_empty_input" }, {});
input.kind = ["reply", "report"].includes(input.kind) ? input.kind : "proactive";
const ctx = { intent: input.intent || null, sender: input.sender || null, kind: input.kind, as_of: input.as_of || null, message: String(input.message).slice(0, 400), ...(input.replay_id ? { replay_id: input.replay_id } : {}) };
const t0 = Date.now();
try {
  const pre = precheckEvidence(input);
  if (pre && pre.decision && pre.decision !== "evidence") {
    // A deterministic stage decided (settled subject, stale premise). A reply
    // is never dropped: its suppress becomes a send.
    const v = pre.decision === "suppress" ? (input.kind !== "proactive" ? "send" : "drop") : pre.decision === "modify" ? "rewrite" : "send";
    out({ verdict: v, ...(v === "rewrite" ? { message: pre.message } : {}), reason: `deterministic: ${pre.reason || ""}`.slice(0, 200), ms: Date.now() - t0 }, ctx);
  }
  const ev = (pre && pre.evidence) || {};
  if (pre && pre.message) input.message = pre.message;
  const [thread, open, found] = await Promise.all([roleThread(input.sender, input.as_of), openQuestions(input.as_of), foundAnswers(input.as_of)]);
  const r = await judge(input, ev, { thread, open, found });
  out({ ...r, ms: Date.now() - t0 }, ctx);
} catch (e) {
  out({ verdict: "send", reason: `gate_error:${String(e.message || e).slice(0, 160)}`, ms: Date.now() - t0 }, ctx);
}
