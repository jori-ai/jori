// answer-router — an answer to an open question registers in whatever conversation it is typed.
//
// THE GAP THIS CLOSES. Jori asks the user questions from many jobs, and each job
// belongs to a team role, so a question lands in the OWNING ROLE's conversation
// (jori-send-curl → the role's `role:<id>`; hum pings go to the member whose area
// they are about). Filing the answer was the coordinator chat agent's job alone
// (chat-agent procedures: daily-summary-fix, hum-answer, …). A role session has
// none of those steps, so an answer typed in the role's conversation was read,
// replied to, and registered nowhere: the day stayed "awaiting", the summary stayed
// held. The same is true of an answer typed in a group, or in another role's thread.
//
// So the filing is code, on every inbound user message, in every conversation:
//   1. each FLOW (a job that asks questions and waits for the answer) lists the
//      questions it is still waiting on (`list`);
//   2. a MODEL reads the message against them (Rule #0b: never a pattern) on the
//      Haiku → Sonnet → Opus ladder, a rung climbed only when the one below fails
//      to give a valid reading, and says which questions the message answers;
//   3. the flow files the user's words (`file`), verbatim, once. The flow itself
//      decides what the words settle (the daily-summary fixer reads them against
//      its own questions), so a partial or oblique answer is still passed on.
//
// Idempotent per message id: data/answer-router/<message id>.json is claimed with
// O_EXCL before anything runs, so the phone-channel hook, a role session's prepare
// step and the coordinator all calling this for one message file it once. A second
// caller gets the first one's outcome (or `in_progress`).
//
// Fails OPEN and never blocks the message: a model that cannot be reached, an
// unreadable flow, a CLI that errors → the message is handled by its agent as it
// always was, and the outcome says why nothing was filed.
//
// Which flows exist: FLOWS below (daily-summary fix questions, hum's open
// questions) plus an installation's own, registered in lib/_ext/open-ask-flows.mjs
// as `export const flows = [{ id, list(), file() }]`. system/conversations.md §
// Answers to open questions has the audit of every other waiting flow.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadHook } from "./ext-hooks.mjs";
import { installTools } from "./root.cjs";

const require = createRequire(import.meta.url);
const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const dataDir = () => process.env.JORI_DATA_DIR || installTools("data");
export const LEDGER_DIR = () => process.env.ANSWER_ROUTER_DIR || path.join(dataDir(), "answer-router");
/** A claim with no outcome older than this is a run that died; it may be retaken. */
export const CLAIM_STALE_MS = 10 * 60e3;
/** Ledger files older than this are swept when the router next runs. */
const LEDGER_KEEP_MS = 14 * 864e5;
/** Messages this short are never read against the questions (a lone emoji is a tapback, not a sentence). */
const MIN_TEXT_CHARS = 2;
/** Most questions put to the model at once (the oldest, most recently asked first). */
const MAX_ASKS = 12;

// ── Flows ────────────────────────────────────────────────────────────────────
// A flow: { id, list(): Promise<Ask[]>, file({ asks, text, messageId, conversationId }): Promise<{ok, note?}> }
// An Ask: { flow, ref, question, asked_at, about?, group? } — `group` batches the asks
// of one flow that go to one filing call (the daily summary's day).

async function runBin(bin, args, env) {
  return execFileP(process.execPath, [installTools(`bin/${bin}`), ...args], { timeout: 60000, env: { ...process.env, ...(env || {}) }, maxBuffer: 4 * 1024 * 1024 });
}

/** The daily summary's fix loop: questions it asked about a day, not yet answered. */
export const dailySummaryFixFlow = {
  id: "daily-summary-fix",
  async list() {
    const { stdout } = await runBin("daily-summary-fix", ["open-asks"]);
    const rows = JSON.parse(stdout);
    return rows.map((r) => ({
      flow: "daily-summary-fix", ref: `${r.date}#${r.n}`, group: r.date,
      question: r.text, asked_at: r.asked_at, about: `the daily summary of ${r.date}`,
    }));
  },
  async file({ asks, text, messageId }) {
    const days = [...new Set(asks.map((a) => a.group))];
    const notes = [];
    for (const day of days) {
      const { stdout } = await runBin("daily-summary-fix", ["request", day, "--answer", text, ...(messageId ? ["--message-id", messageId] : [])]);
      notes.push(String(stdout).trim());
    }
    return { ok: true, note: notes.join("; "), days };
  },
};

/**
 * Hum's open questions (data/open-questions.jsonl): the plain ones, whose answer is
 * captured for memory by `hum-answer`. Not the ones whose answer does something else
 * and needs reading by an agent: a question that offers to change how hum behaves
 * (`hum_improvement:` hook → hum-idea-decide), the location lanes (the answer must reach
 * the visit, not only the ledger) and the self-re-asking lanes (finance review).
 */
export const humQuestionFlow = {
  id: "hum-question",
  async list() {
    const OQ = await import("./open-questions.mjs");
    return OQ.openQuestions()
      .filter((q) => !OQ.TIME_BOUND_LANES.has(q.lane) && !OQ.SELF_REASKING_LANES.has(q.lane) && !String(q.memory_hook || "").startsWith("hum_improvement:"))
      .slice(-MAX_ASKS)
      .map((q) => ({ flow: "hum-question", ref: q.id, group: q.id, question: q.question || q.original_question, asked_at: q.last_asked_at || q.first_asked_at, about: q.subject || null }));
  },
  async file({ asks, text }) {
    const done = [];
    for (const a of asks) {
      await runBin("hum-answer", [a.ref, text]);
      done.push(a.ref);
    }
    return { ok: true, note: `hum-answer ${done.join(", ")}`, ids: done };
  },
};

export async function loadFlows() {
  const flows = [dailySummaryFixFlow, humQuestionFlow];
  try {
    const ext = await loadHook(HERE, "open-ask-flows");
    if (Array.isArray(ext?.flows)) flows.push(...ext.flows);
  } catch (e) { process.stderr.write(`[answer-router] open-ask-flows hook failed: ${e.message}\n`); }
  return flows;
}

/** Every question any flow is waiting on, oldest first. A flow that cannot be read is skipped (and named in `errors`). */
export async function listOpenAsks({ flows } = {}) {
  const fl = flows || await loadFlows();
  const asks = [];
  const errors = [];
  for (const f of fl) {
    try { asks.push(...(await f.list())); }
    catch (e) { errors.push({ flow: f.id, error: String(e.message || e).slice(0, 160) }); }
  }
  asks.sort((a, b) => String(a.asked_at).localeCompare(String(b.asked_at)));
  return { asks: asks.slice(-MAX_ASKS), errors };
}

// ── The reading (a model, never a pattern) ───────────────────────────────────

export function answerPrompt({ asks, text, history }) {
  const qs = asks.map((a, i) => `[${i + 1}] (asked ${String(a.asked_at).slice(0, 16).replace("T", " ")}Z${a.about ? `, about ${a.about}` : ""}) ${a.question}`).join("\n");
  const ctx = (history || []).length ? `The conversation just before it (oldest first):\n${history.map((h) => `${h.who}: ${String(h.text).slice(0, 400)}`).join("\n")}\n\n` : "";
  return [
    "You are deciding whether a message the user just wrote answers one of the questions their assistant asked them and is still waiting on.",
    "",
    "Questions still waiting for an answer:",
    qs,
    "",
    ctx + `The user's message:\n"""\n${String(text).slice(0, 2000)}\n"""`,
    "",
    "Which of the numbered questions does the message answer, wholly or in part? An answer may be a few words, may correct the question's premise (\"I wasn't away that long, it was just a short walk\"), may answer several questions at once, and may arrive in a thread about something else. A new request, a question to the assistant, small talk, or an answer to some other question you were not shown answers none of them. When in doubt whether it is meant as an answer to a listed question, say none.",
    "",
    'Reply with JSON only, nothing else: {"answers":[<question numbers>]}. Use {"answers":[]} when it answers none.',
  ].join("\n");
}

/** Validate a model reading; the 1-based question numbers it names, or null when invalid. */
export function parseReading(raw, n) {
  let obj = null;
  try {
    const s = String(raw || "");
    const a = s.indexOf("{"), b = s.lastIndexOf("}"); // structure of the model's JSON, not language
    obj = JSON.parse(s.slice(a, b + 1));
  } catch { return null; }
  if (!obj || !Array.isArray(obj.answers)) return null;
  const nums = obj.answers;
  if (!nums.every((x) => Number.isInteger(x) && x >= 1 && x <= n)) return null;
  return [...new Set(nums)];
}

/**
 * The default ladder: Haiku (lib/local-llm.mjs), then Sonnet, then Opus, a rung climbed only
 * when the one below throws or gives no valid reading. `ask(prompt, tier)` is replaceable
 * (tests). Returns { numbers, tier, attempts }; numbers is null when no rung gave a reading.
 */
export async function readAnswers({ asks, text, history, ask, tiers = ["haiku", "sonnet", "opus"] }) {
  const prompt = answerPrompt({ asks, text, history });
  const attempts = [];
  const askTier = ask || (async (p, tier) => {
    if (tier === "haiku") {
      const { localLlmChat } = await import("./local-llm.mjs");
      return localLlmChat({ messages: [{ role: "user", content: p }], maxTokens: 200, timeoutMs: 45000 });
    }
    const { runToollessDetailed } = await import("./jev-claude.mjs");
    const { MODELS } = require("./models.cjs");
    const { out, error } = await runToollessDetailed({ model: MODELS[tier], prompt: p, effort: "low", timeoutMs: 90000 });
    if (error || !out) throw new Error(`${tier} ${error?.kind || "empty_output"}: ${error?.message || "no output"}`);
    return out;
  });
  for (const tier of tiers) {
    let raw;
    try { raw = await askTier(prompt, tier); }
    catch (e) { attempts.push({ tier, error: String(e.message || e).slice(0, 140) }); continue; }
    const numbers = parseReading(raw, asks.length);
    if (!numbers) { attempts.push({ tier, error: "not a valid reading" }); continue; }
    attempts.push({ tier, ok: true });
    return { numbers, tier, attempts };
  }
  return { numbers: null, tier: null, attempts };
}

// ── The idempotency ledger ───────────────────────────────────────────────────

const safeId = (id) => String(id || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80); // lang-regex-ok: a file name from a message id
const claimFile = (id) => path.join(LEDGER_DIR(), `${safeId(id)}.json`);

function readClaim(id) { try { return JSON.parse(fs.readFileSync(claimFile(id), "utf8")); } catch { return null; } }

/** Take the message: true when this caller is the one to handle it. */
function claim(id) {
  fs.mkdirSync(LEDGER_DIR(), { recursive: true });
  const file = claimFile(id);
  const body = JSON.stringify({ message_id: id, claimed_at: new Date().toISOString(), status: "in_progress" }) + "\n";
  try { fs.writeFileSync(file, body, { flag: "wx" }); return true; }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    const prev = readClaim(id);
    // A claim that never got an outcome is a run that died: retake it once it is stale.
    if (prev && prev.status === "in_progress" && Date.now() - Date.parse(prev.claimed_at) > CLAIM_STALE_MS) { fs.writeFileSync(file, body); return true; }
    return false;
  }
}

function finish(id, outcome) {
  const file = claimFile(id);
  fs.writeFileSync(`${file}.tmp-${process.pid}`, JSON.stringify({ message_id: id, ...outcome, finished_at: new Date().toISOString() }, null, 1) + "\n");
  fs.renameSync(`${file}.tmp-${process.pid}`, file);
}

function sweepLedger() {
  try {
    for (const f of fs.readdirSync(LEDGER_DIR())) {
      const p = path.join(LEDGER_DIR(), f);
      if (Date.now() - fs.statSync(p).mtimeMs > LEDGER_KEEP_MS) fs.unlinkSync(p);
    }
  } catch { /* nothing to sweep */ }
}

/** What an earlier call decided for this message, or null (a role session reads it to word its reply). */
export function routedOutcome(messageId) {
  const c = readClaim(messageId);
  return c && c.status !== "in_progress" ? c : null;
}

/** Wait for another caller's routing of this message to finish (a role session starting while the hook still reads it). */
export async function waitForOutcome(messageId, { timeoutMs = 90000, pollMs = 1000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const c = readClaim(messageId);
    if (!c) return null;                       // nothing claimed (or the claim was dropped for a retry)
    if (c.status !== "in_progress") return c;
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Route one inbound user message: read it against every open question, file what it answers.
 *
 * Returns { status, filed, ... } where status is:
 *   "filed"             one or more flows were handed the user's words
 *   "none"              the message answers no open question
 *   "no_open_questions" nothing was waiting
 *   "skipped"           too short / no id / not routable
 *   "already_routed"    an earlier call took this message (`previous` is its outcome, null while it still runs)
 *   "unreadable"        no model rung gave a reading: nothing filed, the agent handles it as before
 *   "error"             a flow's filing failed (the message is NOT marked answered anywhere)
 */
export async function routeAnswer({ messageId, text, conversationId = null, history = [], flows, ask, tiers } = {}) {
  const body = String(text ?? "").trim();
  if (!messageId || body.length < MIN_TEXT_CHARS) return { status: "skipped" };
  if (process.env.ANSWER_ROUTER_OFF === "1" || fs.existsSync(path.join(dataDir(), ".answer-router-off"))) return { status: "skipped", reason: "switched off" };
  const fl = flows || await loadFlows();
  const { asks, errors } = await listOpenAsks({ flows: fl });
  if (!asks.length) return { status: "no_open_questions", errors };
  if (!claim(messageId)) return { status: "already_routed", previous: routedOutcome(messageId) };
  sweepLedger();
  let outcome;
  try {
    const { numbers, tier, attempts } = await readAnswers({ asks, text: body, history, ask, tiers });
    if (numbers === null) outcome = { status: "unreadable", attempts, errors };
    else if (!numbers.length) outcome = { status: "none", tier, asked: asks.length };
    else {
      const matched = numbers.map((n) => asks[n - 1]);
      const filed = [];
      let failed = null;
      for (const f of fl) {
        const mine = matched.filter((a) => a.flow === f.id);
        if (!mine.length) continue;
        try {
          const r = await f.file({ asks: mine, text: body, messageId, conversationId });
          filed.push({ flow: f.id, asks: mine.map((a) => a.ref), ...(r?.note ? { note: r.note } : {}) });
        } catch (e) { failed = { flow: f.id, error: String(e.message || e).slice(0, 200) }; }
      }
      outcome = failed ? { status: "error", filed, failed, tier } : { status: "filed", filed, tier };
    }
  } catch (e) {
    outcome = { status: "error", failed: { error: String(e.message || e).slice(0, 200) } };
  }
  finish(messageId, { ...outcome, conversation_id: conversationId });
  // An error leaves no claim behind: the next caller (the role session, the coordinator) tries again.
  if (outcome.status === "error" || outcome.status === "unreadable") { try { fs.unlinkSync(claimFile(messageId)); } catch { /* gone */ } }
  return outcome;
}

/**
 * A block for an agent's task or prompt: what the code filed for this message (so it
 * acknowledges instead of filing again), and what is still waiting on the user that the
 * code does not file itself. Empty string when there is nothing to say.
 */
export function routingBlock(result, ceo = "the user") {
  const outcome = result && result.status === "already_routed" ? result.previous : result;
  if (!outcome || !outcome.status) return "";
  if (outcome.status === "filed") {
    const what = (outcome.filed || []).map((f) => `${f.flow} (${(f.asks || []).join(", ")})`).join("; ");
    return `[Answer already filed] Code read ${ceo}'s message as an answer to open question(s) and filed it: ${what}. Do NOT file it again (no \`daily-summary-fix request\`, no \`hum-answer\`) and do not ask ${ceo} that question again. Acknowledge in one short line, in ${ceo}'s terms (for a daily-summary answer: "Got it, I'll fold that into the summary"). If the message also asks something else, answer that too.\n\n`;
  }
  return "";
}

/** The conversation tail a routing call reads the message against. */
export function historyFrom(rows, { ceo = "User", excludeId = null, limit = 6 } = {}) {
  return (rows || []).filter((r) => r.id !== excludeId).slice(-limit).map((r) => ({ who: r.role === "user" ? ceo : "Assistant", text: r.content }));
}
