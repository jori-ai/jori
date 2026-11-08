// push-announce.mjs — Jev decides which pushes Siri reads aloud.
//
// While a Focus such as Reduce Interruptions is on, Siri announces a push on
// AirPods only when it is time-sensitive: a regular push is held back silently
// even with the app on the Focus's allowed list (verified on device
// 2026-11-05, iOS 27: time-sensitive read, regular not). So every regular,
// non-system push is rated urgent / important / normal by Jev site
// `push-announce` (agent/config/jev-questions/push-announce.json); urgent and
// important go out time-sensitive. docs/jev.md has the site row.
//
// Fails open to a regular push: a judgment that errors or takes longer than
// JUDGE_TIMEOUT_MS never delays or drops the push itself.
// Off switch: touch data/.push-announce-off (no judgments; regular pushes).

import fs from "node:fs";
import { createRequire } from "node:module";
import { installTools } from "./root.cjs";
import { decide } from "./jev-shadow.mjs";
import { answerConfidence, jevSiteDef } from "./jev.mjs";
import { runToolless, parseModelJson } from "./jev-claude.mjs";

const require = createRequire(import.meta.url);

export const SITE = "push-announce";
export const LEVELS = ["urgent", "important", "normal"];
export const JUDGE_TIMEOUT_MS = 10000;
const TEXT_MAX = 600;

export function pushAnnounceOn(flag = installTools("data/.push-announce-off")) {
  try { return !fs.existsSync(flag); } catch { return true; }
}

/** Whether a level makes the push time-sensitive (read aloud). */
export function announces(level) {
  return level === "urgent" || level === "important";
}

export function judgeState({ title, body }) {
  return { push: { title: String(title || "").slice(0, 120), body: String(body || "").slice(0, TEXT_MAX) } };
}

export function legacyPrompt(state, def = jevSiteDef(SITE)) {
  const q = def?.questions?.level;
  if (!q?.instructions || !q.criteria) throw new Error("push-announce: no rubric on file");
  return [
    "You decide which of a personal assistant's phone notifications are read aloud.",
    q.instructions,
    "Levels:",
    ...LEVELS.map((l) => `- ${l}: ${q.criteria[l]}`),
    'Reply with JSON only: {"level":"urgent|important|normal","reason":"<= 12 words"}',
    "",
    JSON.stringify(state),
  ].join("\n");
}

async function legacyJudge(state) {
  const { sonnet } = require("./models.cjs").MODELS;
  const out = await runToolless({ model: sonnet, prompt: legacyPrompt(state), timeoutMs: JUDGE_TIMEOUT_MS });
  const j = parseModelJson(out);
  if (!LEVELS.includes(j?.level)) throw new Error(`push-announce legacy: unparseable answer (${String(out || "").slice(0, 80)})`);
  return { level: j.level, reason: String(j.reason || "").slice(0, 120) };
}

/**
 * Rate one push. Resolves { level, used, reason } — never rejects: an error or
 * a judgment slower than timeoutMs resolves level "normal" (a regular push).
 */
export async function judgePush({ title, body, messageId = null }, { timeoutMs = JUDGE_TIMEOUT_MS, judge = null } = {}) {
  const state = judgeState({ title, body });
  const run = judge || (() => decide({
    site: SITE,
    id: messageId,
    state,
    interpret: (answers) => {
      const level = answers.level?.choice;
      if (!LEVELS.includes(level)) throw new Error("jev: no level answer");
      return { value: { level, reason: "jev" }, confidence: answerConfidence(answers.level) };
    },
    legacy: () => legacyJudge(state),
    same: (a, b) => a?.level === b?.level,
    logInput: { title: state.push.title, body: state.push.body.slice(0, 200) },
  }).then((r) => ({ level: r.value.level, used: r.used, reason: r.value.reason })));
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ level: "normal", used: "timeout", reason: `no judgment in ${timeoutMs} ms` }), timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(run).catch((e) => ({ level: "normal", used: "error", reason: String(e?.message || e).slice(0, 160) })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
