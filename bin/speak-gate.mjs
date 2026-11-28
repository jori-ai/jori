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
// conversation with each question's state, the questions still open, the
// newest records (recentRecords: the email the user sent in the last 24 h,
// show and film verdicts of the last 48 h, the calendar with each event's
// details), the recorded money expectations for a finance-lane message
// (lib/speak-gate-finance.mjs: every active fin_expected_income and
// fin_scheduled_payments row with its note and cadence), and the user's
// standing rules (agent/local/config/speak-gate.json standing_rules).
//
// MONEY CLAIMS: money is late, missing or short only against a recorded
// expectation. The judge reports a `premise`; a proactive message whose premise
// is contradicted becomes `resolve`, an unbacked one `drop`, never a rewrite
// into a question (applyPremiseRule; system/speak-gate.md § Money claims).
//
// A REWRITE IS CHECKED before it replaces the sender's text (vetRewrite): a
// tool-less Haiku pass, Sonnet if that answer is off schema, asks whether it
// states anything that neither the original, the evidence nor the judge's own
// findings show, or that the evidence contradicts. If so, the rewrite is
// withdrawn. When the judge had found nothing wrong with the original itself
// (the rewrite was for wording), or the check cannot finish, the original is
// sent as written: the gate's fail-open path. So it is when the check found
// the records contradicting the judge's own text (the judge's note is then not
// to be trusted). Otherwise a model reads the judge's truth note
// (trimOriginal): if it says the original states something false, sending it
// unchanged delivers a message the gate knows is wrong, so the model deletes
// only that part, code proves it is a pure deletion, the check reads the
// result once more, and the trimmed text is sent. Only when the model says the
// wrong part is the WHOLE message is a proactive message held ("digest");
// every other failure sends the original as written, and a reply is never
// held. A report email is never trimmed: its fix is only shown in the app.
//
// Claude only, never Jev: money and health messages pass through here too.
//
// Stdin:  {message, intent?, sender? (role id), kind?: "proactive"|"reply"|"report",
//          reply_to_text?, replied_to? ({role, text, at}: the message a threaded
//          reply points at), channel?, supporting_data?, fixed_choices? (a card's
//          option labels), as_of? (replay)}
// Stdout: {verdict, message?, research_plan?, reason, checks, sources, ms, evidence_ms?,
//          rewrite_added_claim?, rewrite_claims?, original_trimmed?}; a checked rewrite carries
//          checks.rewrite_check {added_claim, added, contradicted, tier | error, ms, withdrawn?,
//          trimmed?, removed?, trim_tier?, trim_ms?, trim_skipped?, trim_failed?}
// Fail-open: an error emits {verdict:"send", reason:"gate_error:…"}.
// Env: SPEAK_GATE_LOG (default data/speak-gate-log.jsonl), SPEAK_GATE_NO_LOG=1,
//      SPEAK_GATE_TIMEOUT_S (proactive 300, reply 120), SPEAK_GATE_SENT_LOG (default
//      data/email-sent.jsonl), SPEAK_GATE_GOG_BIN / SPEAK_GATE_CHECK_BIN (test stand-ins).
"use strict";

import { execFile, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { resolvedAnswers } from "../lib/speak-gate-live.mjs";
import { OWNER, ASSISTANT, TOOLS_DOC, IDENTITY_RULE, GOG, webAllowed as webAllowedFor, runAgent, lastJson, readLessons, checkRewrite, trimOriginal, isPureDeletion } from "../lib/speak-gate-agent.mjs";
import { eventPeopleLine } from "../lib/meeting-event.mjs";
import { financeScope, financeRecords, FINANCE_EVIDENCE_TITLE, PREMISE_RULE, applyPremiseRule } from "../lib/speak-gate-finance.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { MODELS } = require(path.join(ROOT, "lib", "models.cjs"));
const { localConfig } = require(path.join(ROOT, "lib", "instance.cjs"));
const { installTools } = require(path.join(ROOT, "lib", "root.cjs"));
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

// Earlier one-off work the message may lean on (system/wiki-architecture.md
// § Work records): the closest work records, each with its bottom line and its
// dated updates, so a recommendation that was corrected or superseded later is
// in front of the judge without it having to think of searching.
function workRecords(message) {
  try {
    const ws = require(path.join(ROOT, "lib", "wiki-store.js"));
    const hits = ws.searchPages(String(message).slice(0, 600), { type: "work", limit: 4 });
    return hits.map((h) => {
      const p = ws.getPage(h.id);
      if (!p) return "";
      const ups = (p.body_md.split(/\n## Updates\n/)[1] || "").trim();
      return `- ${h.id}: ${p.title} — ${p.description || ""}${ups && !ups.startsWith("_None yet") ? `\n  Updates: ${oneLine(ups, 900)}` : ""}`;
    }).filter(Boolean).join("\n");
  } catch { return ""; }
}

// The newest records, picked by time alone (code does not read the message to
// choose them). The nightly audit's wrong rewrites leaned on searches that
// missed something written minutes or hours before: a reply the user had just
// sent, a rating just recorded, what a calendar event itself says. Each source
// is bounded and fails to nothing; they run beside the other evidence reads.
const sentLog = () => process.env.SPEAK_GATE_SENT_LOG || installTools("data", "email-sent.jsonl");

function tailLines(file, bytes = 262144) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    return start > 0 ? lines.slice(1) : lines; // the first line may be cut
  } finally { closeSync(fd); }
}

function sentMail(nowMs) {
  try {
    const rows = [];
    for (const l of tailLines(sentLog())) {
      if (!l.trim()) continue;
      let e; try { e = JSON.parse(l); } catch { continue; }
      const t = Date.parse(e.ts || "");
      if (!e.from_me || !(t > nowMs - 24 * 3600e3 && t <= nowMs)) continue;
      rows.push(`- [${ts(e.ts)}] to ${e.to || "?"}${e.cc ? ` cc ${e.cc}` : ""} · "${oneLine(e.subject || "", 120)}": ${oneLine(e.text || "", 300)}`);
    }
    return rows.slice(-12).reverse().join("\n");
  } catch { return ""; }
}

async function watchVerdicts(nowMs, asOf) {
  try {
    const before = asOf ? `&created_at=lt.${encodeURIComponent(asOf)}` : "";
    const rows = await rest.request(`/rest/v1/watch_feedback?select=verdict,note,season_n,source,created_at,watch_titles(name)&created_at=gt.${encodeURIComponent(new Date(nowMs - 48 * 3600e3).toISOString())}${before}&order=created_at.desc&limit=8`, { timeoutMs: 5000 });
    return (rows || []).map((r) => `- [${ts(r.created_at)}] ${(r.watch_titles && r.watch_titles.name) || "?"}${r.season_n ? ` season ${r.season_n}` : ""}: ${r.verdict}${r.note ? ` (${oneLine(r.note, 160)})` : ""} · via ${r.source || "?"}`).join("\n");
  } catch { return ""; }
}

function calendarDetails(nowMs) {
  const when = (x) => (x && (x.dateTime || x.date)) || "?";
  return new Promise((resolve) => {
    try {
      execFile(GOG, ["calendar", "list", "--json", "--results-only", "--all",
        "--from", new Date(nowMs - 3 * 3600e3).toISOString(), "--to", new Date(nowMs + 48 * 3600e3).toISOString()],
      { encoding: "utf8", timeout: 6000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        try {
          const evs = err ? [] : JSON.parse(stdout);
          resolve((Array.isArray(evs) ? evs : []).filter((e) => e && e.status !== "cancelled")
            .sort((a, b) => String(when(a.start)).localeCompare(String(when(b.start)))).slice(0, 15)
            .map((e) => {
              const ep = ((e.conferenceData && e.conferenceData.entryPoints) || []).find((p) => p.entryPointType === "video");
              const bits = [e.location ? `@ ${oneLine(e.location, 80)}` : "", e.transparency === "transparent" ? "free" : "",
                e.eventType && e.eventType !== "default" ? e.eventType : "", e.updated ? `updated ${ts(e.updated)}` : "",
                (ep && ep.uri) || e.hangoutLink ? `video ${(ep && ep.uri) || e.hangoutLink}` : "",
                e.description ? `details: ${oneLine(e.description, 240)}` : "",
                // Who the event is with, from its own organizer and guests: the
                // only thing that identifies a person the title names by first name.
                eventPeopleLine(e) || "no organizer or guest other than the owner listed"].filter(Boolean).join(" · ");
              return `- [${when(e.start)} → ${when(e.end)}] "${oneLine(e.summary || "", 100)}"${bits ? ` ${bits}` : ""}`;
            }).join("\n"));
        } catch { resolve(""); }
      });
    } catch { resolve(""); }
  });
}

async function recentRecords(asOf) {
  const p = asOf ? Date.parse(asOf) : NaN;
  const nowMs = Number.isFinite(p) ? p : Date.now();
  const [watch, cal] = await Promise.all([watchVerdicts(nowMs, asOf), calendarDetails(nowMs)]);
  const S = (title, body) => (body ? `${title}\n${body}` : "");
  return [S(`Email ${OWNER} sent, last 24 h (newest first; the text they wrote, without the quoted thread):`, sentMail(nowMs)),
    S("Shows and films rated, last 48 h:", watch),
    S("Calendar, 3 h ago to 2 days ahead, with each event's own details:", cal)].filter(Boolean).join("\n\n");
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

const E = (title, body) => (body && String(body).trim() ? `\n## ${title}\n${String(body).trim()}\n` : "");

// Everything the judge is shown besides the message and its instructions. The
// rewrite check reads the same text, so a claim the judge could take from it
// is never counted as added.
function repliedTo(input) {
  const r = input.replied_to;
  if (!r || !String(r.text || "").trim()) return "";
  const whose = r.role === "user" ? `${OWNER}'s own earlier message` : `an earlier message of ${ASSISTANT}'s`;
  return `${whose}${r.at ? ` (${r.at})` : ""}:\n"""${String(r.text).slice(0, 1200)}"""`;
}

function evidenceText(input, ev, extra) {
  const reply = input.kind === "reply" || input.kind === "report";
  return `${E("TAPPABLE CHOICES SENT WITH IT (fixed: a rewrite must still be a question these answer)", Array.isArray(input.fixed_choices) ? input.fixed_choices.join(" | ") : "")}${reply ? E(`WHAT ${OWNER.toUpperCase()} WROTE (being answered)`, input.reply_to_text) : ""}${reply ? E(`THE MESSAGE ${OWNER.toUpperCase()} REPLIED TO (they tapped Reply on it: what they wrote answers THIS, not the newest message in the chat)`, repliedTo(input)) : ""}${E("THIS ROLE'S CONVERSATION, LAST 14 DAYS (question states are authoritative)", extra.thread)}${E("QUESTIONS STILL OPEN (any role)", extra.open)}${E("NEWEST RECORDS (read by code just before you; they may be newer than a search reaches, and a claim they contradict is false)", extra.recent)}${E(FINANCE_EVIDENCE_TITLE, extra.finance)}${E(`EARLIER WORK DONE FOR ${OWNER.toUpperCase()} (work records: the newest record and its updates win; a superseded recommendation is not the current one; work-record show <id> has the full text)`, extra.work)}${E("ANSWERS THIS GATE ALREADY FOUND (a question it held because it found the answer; asking one again is a re-ask: resolve it with the same answer)", extra.found)}${E(`WHAT ${OWNER.toUpperCase()} SAID (dated, from the reply log)`, ev.owner_said)}${E("TRAVEL TIMELINE FACTS", ev.authoritative_facts)}${E("TRAVEL CHECK FLAGGED (code paired a place and a date; decide yourself whether the message actually claims where the user is)", ev.travel_check_flagged)}${E("LONG-TERM MEMORY (wiki hits)", ev.long_term_memory)}${E("TOPICS ACKNOWLEDGED IN THE LAST 48H", ev.acknowledged_topics_48h)}${E("PINGS ALREADY SENT TODAY", ev.hum_pings_today)}${E("SENDER'S SUPPORTING DATA", ev.supporting_data)}${E("CHAT, LAST 8H", ev.transcript_last_8h)}${E("CALENDAR, REST OF TODAY", ev.calendar_today)}`;
}

function prompt(input, ev, extra) {
  // A report email the user set up (kind "report") is checked like a reply:
  // truth and phrasing, never held.
  const reply = input.kind === "reply" || input.kind === "report";
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
1. TRUE — verify every factual claim against the sources (tools below). A claim the sources contradict, or a hedge ("I can't tell whether…", "tell me if…") where the answer is findable, must be fixed — find the answer and put it in.${input.replied_to ? `
THREADED REPLY: ${OWNER} tapped Reply on a specific earlier message (shown below under THE MESSAGE ${OWNER.toUpperCase()} REPLIED TO). Their words answer THAT message. Never read them against a newer question, a pending question, or the order of the chat, and never rewrite the reply so that it is about a different question than the one they replied to.` : ""}
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

${IDENTITY_RULE}

${PREMISE_RULE}

A REWRITE NEVER CLAIMS MORE than the original and the sources you checked show. Repair by removing, softening, shortening or reordering what is there. A message that says a change was approved, applied or committed must not become "live", "running" or "working" unless a source you checked shows it running. Add a fact the original did not state (a time, a name, a status, that something did or did not happen) only when you found it in a source you checked, and put it in checks with where you found it. When a correction would need a fact you did not find, say less instead: cut the wrong part rather than replace it with a guess. Not finding something does not show it is not there: never write that something is missing, unanswered or not on record unless a source you read says so. A separate check reads your rewrite against the original, the evidence below and your checks; when the rewrite says anything none of them shows, the rewrite is withdrawn, and if you found the original wrong, only the wrong part is cut from it when that can be done cleanly (a proactive message whose whole point is wrong is held); otherwise the original is sent as written.

RESEARCH FIRST. Use the tools to verify the claims and look for answers before you decide; check several sources, not one. Budget: a few minutes. You cannot change anything, and must not try.

${TOOLS_DOC}
${rules ? `\n## ${OWNER.toUpperCase()}'S STANDING RULES (their own words; they override your judgment)\n${rules}\n` : ""}${lessons ? `\n## LESSONS FROM THE NIGHTLY AUDIT (a senior reviewer re-checked your past decisions; apply these. ${OWNER}'s standing rules win over them)\n${lessons}\n` : ""}
THE MESSAGE:
"""${input.message}"""
${evidenceText(input, ev, extra)}
When done, end your answer with ONE LINE of compact JSON (nothing after it):
{"verdict":"${reply ? "send|rewrite" : "send|rewrite|resolve|digest|drop"}","message":"<the rewritten text, only for rewrite>","research_plan":"<only for resolve: the answer you found and its source, or what is left to do>","checks":{"true":"ok|<problem>","${reply ? "phrasing" : "self_resolve"}":"ok|<problem>"${reply ? "" : ',"phrasing":"ok|<problem>","value":"ok|<problem>"'}},"premise":"n/a|backed|unbacked|contradicted","premise_note":"<only when unbacked or contradicted: what the record shows or lacks>","sources":["<each source you checked, short>"],"reason":"<≤200 chars>"}`;
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

// ─── The rewrite check ──────────────────────────────────────────────────────
//
// A rewrite replaces the sender's words, so it is read once more before it
// goes out (checkRewrite in lib/speak-gate-agent.mjs). When it states anything
// that neither the original, the evidence nor the judge's own findings show,
// or that the evidence contradicts, the rewrite is withdrawn. A correction the
// judge found and named in its checks passes, so a false claim it caught is
// still fixed. The live sender kills the gate at its budget + 90 s
// (lib/speak-gate-live.mjs runGate), so every model step here stops 10 s
// before that.
//
// What goes out instead of a withdrawn rewrite depends on what the judge found:
//   - the check could not run, the judge found nothing wrong with the original
//     (checks.true "ok": the rewrite was about wording or value), the check
//     found the records contradicting the judge's own text (its note is not to
//     be trusted then), or the message is a report email (its fix is only shown
//     in the app): the ORIGINAL as written, the fail-open path;
//   - any other truth note: trimOriginal has a model read it, and when it says
//     the original states something false, cut out only that part. A cut that
//     isPureDeletion rejects climbs to the next rung, and the check reads an
//     accepted cut once more (deleting a "not" flips a sentence). A clean cut
//     goes out as the message.
//   - holding is the one narrow case: the model says the wrong part is the
//     whole message, on a proactive message → "digest". (The live sender still
//     delivers intents it never holds.) Every other failure — no clean cut on
//     any rung, a trimmed text the check flags or cannot read, a note that does
//     not say the original is wrong, a reply — sends the original as written,
//     with why in rewrite_check.trim_skipped / trim_failed.

/** The judge's truth note on the original, or null when it is a plain ok. */
function originalFinding(r) {
  const t = r && r.checks && typeof r.checks === "object" && !Array.isArray(r.checks) ? r.checks.true : null;
  if (typeof t !== "string") return null;
  const s = t.trim();
  // The judge's output schema is "true": "ok|<problem>"; it often explains an
  // ok ("ok: the calendar shows it"), so a field that opens with that token is
  // ok and nothing is trimmed. A schema check on the judge's own field. Any
  // other note is free text that may still confirm the original, so whether it
  // says the original is wrong is the trim model's reading, not this test's.
  if (!s || s.slice(0, 2).toLowerCase() === "ok") return null;
  return s.slice(0, 400);
}

async function vetRewrite(input, r, records, t0) {
  const reply = input.kind === "reply" || input.kind === "report";
  const budgetS = Number(process.env.SPEAK_GATE_TIMEOUT_S || (reply ? 120 : 300));
  const deadline = t0 + (budgetS + 80) * 1000;
  const findings = { reason: r.reason, checks: r.checks, sources: r.sources };
  const c = await checkRewrite({ original: input.message, rewrite: r.message, records, findings, deadline });
  const base = r.checks && typeof r.checks === "object" && !Array.isArray(r.checks) ? r.checks : { judge: r.checks ?? null };
  const claims = c.ran ? [...c.added, ...c.contradicted.map((x) => `contradicted: ${x}`)] : [];
  const check = c.ran
    ? { added_claim: claims.length > 0, added: c.added, contradicted: c.contradicted, tier: c.tier, ms: c.ms }
    : { added_claim: null, error: c.error, ms: c.ms };
  if (c.ran && !claims.length) return { ...r, checks: { ...base, rewrite_check: check }, rewrite_added_claim: false, rewrite_claims: [] };
  const why = !c.ran ? `the rewrite check could not run: ${c.error}`
    : [c.added.length ? `nothing shows ${c.added.join("; ")}` : "", c.contradicted.length ? `the records contradict ${c.contradicted.join("; ")}` : ""].filter(Boolean).join("; and ");
  const withdrawn = { ...check, withdrawn: String(r.message).slice(0, 2000) };
  const common = { sources: r.sources, rewrite_added_claim: check.added_claim, rewrite_claims: claims };
  const asWritten = (extra = {}) => ({
    verdict: "send",
    reason: `Rewrite withdrawn, sent as written (${why}). Gate: ${r.reason || ""}`.slice(0, 300),
    checks: { ...base, rewrite_check: { ...withdrawn, ...extra } },
    ...common,
  });

  const finding = originalFinding(r);
  if (!c.ran || !finding || input.kind === "report") return asWritten();
  const notTrimmed = (extra) => ({ ...asWritten(extra), original_trimmed: false });
  if (c.contradicted.length) return notTrimmed({ trim_skipped: "the records contradicted the judge's own text" });

  const choices = Array.isArray(input.fixed_choices) && input.fixed_choices.length ? input.fixed_choices : null;
  const t = await trimOriginal({ original: input.message, finding, reason: r.reason, choices, deadline,
    accept: (cut) => isPureDeletion(input.message, cut) });
  if (!t.ran) return notTrimmed({ trim_failed: `no clean trim: ${t.error}`.slice(0, 300), trim_ms: t.ms });
  const trimInfo = { trim_tier: t.tier, trim_ms: t.ms };
  if (!t.original_wrong) return notTrimmed({ trim_skipped: "the judge's note does not say the original is wrong", ...trimInfo });
  if (t.trimmed === null) {
    if (input.kind !== "proactive") return notTrimmed({ trim_failed: "the wrong part is the whole message", ...trimInfo });
    return {
      verdict: "digest",
      reason: `Rewrite withdrawn; what the gate found wrong is the whole message (${finding})`.slice(0, 300),
      checks: { ...base, rewrite_check: { ...withdrawn, trim_failed: "the wrong part is the whole message", ...trimInfo } },
      ...common,
      original_trimmed: false,
    };
  }
  const c2 = await checkRewrite({ original: input.message, rewrite: t.trimmed, records, findings, deadline });
  if (!c2.ran) return notTrimmed({ trim_failed: `the trimmed text could not be checked: ${c2.error}`.slice(0, 300), ...trimInfo });
  if (c2.added.length || c2.contradicted.length) {
    return notTrimmed({ trim_failed: `the trimmed text still says what nothing shows: ${[...c2.added, ...c2.contradicted].join("; ")}`.slice(0, 300), ...trimInfo });
  }
  return {
    verdict: "rewrite",
    message: t.trimmed,
    reason: `Rewrite withdrawn; sent without the part the gate found wrong (${finding}).`.slice(0, 300),
    checks: { ...base, rewrite_check: { ...withdrawn, trimmed: true, removed: t.removed, ...trimInfo } },
    ...common,
    original_trimmed: true,
  };
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
  const te = Date.now();
  const [thread, open, found, recent, finance] = await Promise.all([roleThread(input.sender, input.as_of), openQuestions(input.as_of), foundAnswers(input.as_of), recentRecords(input.as_of),
    financeScope(input) ? financeRecords({ asOf: input.as_of }) : ""]);
  const extra = { thread, open, found, recent, finance, work: workRecords(input.message) };
  const evidence_ms = Date.now() - te;
  let r = applyPremiseRule(input, await judge(input, ev, extra));
  if (r.verdict === "rewrite") r = await vetRewrite(input, r, evidenceText(input, ev, extra), t0);
  out({ ...r, ms: Date.now() - t0, evidence_ms }, ctx);
} catch (e) {
  out({ verdict: "send", reason: `gate_error:${String(e.message || e).slice(0, 160)}`, ms: Date.now() - t0 }, ctx);
}
