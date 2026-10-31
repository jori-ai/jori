// question-route — which channel a question goes to.
//
// The user (2026-10-29): "let's create a new channel for questions. Use Jev to
// decide which questions are urgent. those should go to chat. Non-urgent
// questions should go to the questions channel. Location questions are always
// urgent - I should receive those as soon as they're conceived."
//
// So every question bound for the chat channel is routed here, at the one
// chokepoint every programmatic sender shares (bin/jori-send-curl), after all
// of its gates have decided the message goes out at all:
//
//   not a question      → chat, unchanged. Decided from structure only: the
//                         sender's intent, the hum context's finding
//                         (isQuestionCandidate) or an explicit --question.
//   location question   → chat, urgent. A rule, not a judgment: the question is
//                         about where the user is or just was, and it can only
//                         be answered from fresh memory. Decided from structure
//                         (a `location_ask:` dedup_key, a retrospective-confirm
//                         ask, a location lane or intent).
//   any other question  → Jev site `question-urgency` (a toolless Sonnet
//                         judgment on the same wording as shadow and fallback).
//                         urgent → chat; otherwise → the questions channel,
//                         written without a push (the user works through it
//                         when they choose).
//
// Fails toward chat: an error, a timeout or the off switch keeps the message
// where it was always going. A missed urgent question costs more than a
// non-urgent one arriving in chat.
//
// Every routed question is logged to data/question-route-log.jsonl.
// Off switch (everything stays in chat): `touch data/.questions-channel-off`.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { installTools } from "./root.cjs";
import { decide } from "./jev-shadow.mjs";
import { answerConfidence, boolOf, jevSiteDef } from "./jev.mjs";
import { runToolless, parseModelJson } from "./jev-claude.mjs";
import { isQuestionCandidate } from "./question-pacing.mjs";
import { userTz } from "./hum-events.mjs";

const require = createRequire(import.meta.url);
export const SITE = "question-urgency";
export const QUESTIONS_CHANNEL = "questions";
const LOG = () => process.env.QUESTION_ROUTE_LOG || installTools("data/question-route-log.jsonl");
const OFF = () => process.env.QUESTION_ROUTE_OFF || installTools("data/.questions-channel-off");
const TEXT_MAX = 1200;

// Intents whose every message is a question (`hum:<lane>:question` from
// hum-ask, `decision:ask`, `<lane>:ask`, `location:edge:ask`, ...).
function questionIntent(intent) {
  const last = String(intent || "").split(":").pop();
  return last === "question" || last === "ask";
}

function locationLane(s) {
  return String(s || "").toLowerCase().startsWith("location");
}

/** Is this message a question? Structure only (Rule #0b): intent, hum context, flag. */
export function isQuestion({ intent = "", context = null, explicit = false } = {}) {
  if (explicit) return true;
  if (questionIntent(intent)) return true;
  if (context?.kind === "question") return true;
  // hum-ping files the headline's key at the top of its context too.
  if (String(context?.dedup_key || "").startsWith("location_ask:")) return true;
  return isQuestionCandidate(context?.finding);
}

/** Is this question about where the user is or was? Structure only. */
export function isLocationQuestion({ intent = "", context = null, location = false } = {}) {
  if (location) return true;
  const f = context?.finding || {};
  const key = String(context?.dedup_key || f.dedup_key || "");
  if (key.startsWith("location_ask:")) return true;
  if (f.supporting_data?.ask_kind === "retrospective_confirmation") return true;
  if (locationLane(context?.lane) || locationLane(f.topic)) return true;
  // hum:<lane>:..., location:<what>:ask
  const parts = String(intent || "").split(":");
  return locationLane(parts[0]) || (parts[0] === "hum" && locationLane(parts[1]));
}

function ownerName() {
  try { return require("./instance.cjs").instance().owner_name || "the user"; } catch { return "the user"; }
}

/** The Sonnet rung, read from the site's own question file so both rungs share one wording. */
export function rubricPrompt(state, def = jevSiteDef(SITE)) {
  const q = def?.questions?.urgent;
  if (!q?.instructions || !q.criteria) throw new Error("question-route: no rubric on file");
  return [
    `You route questions for ${ownerName()}'s personal assistant.`,
    q.instructions,
    `- urgent=true: ${q.criteria.true}`,
    `- urgent=false: ${q.criteria.false}`,
    'Reply with JSON only: {"urgent":true|false,"reason":"<= 12 words"}',
    "",
    JSON.stringify(state),
  ].join("\n");
}

async function legacyJudge(state) {
  const { sonnet } = require("./models.cjs").MODELS;
  const out = await runToolless({ model: sonnet, prompt: rubricPrompt(state), timeoutMs: 60000 });
  const j = parseModelJson(out);
  if (typeof j?.urgent !== "boolean") throw new Error(`question-route legacy: unparseable answer (${String(out || "").slice(0, 80)})`);
  return { urgent: j.urgent, reason: String(j.reason || "").slice(0, 120) };
}

function localTime(now, tz) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" }).format(now);
  } catch { return now.toISOString(); }
}

function logRow(row) {
  try {
    fs.mkdirSync(path.dirname(LOG()), { recursive: true });
    fs.appendFileSync(LOG(), JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
  } catch { /* non-fatal */ }
}

/**
 * Route one outgoing message.
 * @returns {Promise<{channel:"chat"|"questions", urgent:boolean, question:boolean, reason:string, used?:string}>}
 */
export async function routeQuestion({ text, intent = "", context = null, explicit = false, location = false, now = new Date(), tz = null, judge = null } = {}) {
  if (!isQuestion({ intent, context, explicit }) && !location) {
    return { channel: "chat", urgent: false, question: false, reason: "not a question" };
  }
  const base = { intent: intent || null, lane: context?.lane || context?.finding?.topic || null, text: String(text || "").slice(0, 200) };
  if (isLocationQuestion({ intent, context, location })) {
    const r = { channel: "chat", urgent: true, question: true, reason: "location question" };
    logRow({ ...base, ...r });
    return r;
  }
  if (fs.existsSync(OFF())) {
    const r = { channel: "chat", urgent: false, question: true, reason: "questions channel off" };
    logRow({ ...base, ...r });
    return r;
  }
  const state = {
    question: String(text || "").slice(0, TEXT_MAX),
    kind: context?.kind || (questionIntent(intent) ? "question" : "ask"),
    lane: base.lane,
    local_time: localTime(now, tz || userTz()),
  };
  try {
    const r = judge ? { value: await judge(state), used: "test" } : await decide({
      site: SITE,
      id: context?.question_id || context?.ping_id || null,
      state,
      interpret: (answers) => {
        const urgent = boolOf(answers.urgent);
        if (urgent === null) throw new Error("jev: no urgent answer");
        return { value: { urgent, reason: "jev" }, confidence: answerConfidence(answers.urgent) };
      },
      legacy: () => legacyJudge(state),
      same: (a, b) => a?.urgent === b?.urgent,
      logInput: base,
    });
    const urgent = r.value?.urgent === true;
    const out = { channel: urgent ? "chat" : QUESTIONS_CHANNEL, urgent, question: true, reason: r.value?.reason || "", used: r.used };
    logRow({ ...base, ...out });
    return out;
  } catch (e) {
    const out = { channel: "chat", urgent: false, question: true, reason: `judge failed: ${String(e?.message || e).slice(0, 120)}` };
    logRow({ ...base, ...out });
    return out;
  }
}
