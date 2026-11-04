// question-dismiss — the user dismissed a question in the app; close it in code.
//
// The user (2026-10-31): "The user should be able to dismiss any question."
//
// The app's Dismiss (bubble menu, or the x in the open-questions tray) inserts
// a silent user reply to the question carrying metadata.question_dismiss. That
// reply alone closes the question in the app on every device (it is derived
// from replies, like a tapped answer). Here, reached from lib/choice-reply.mjs
// before any agent sees the message, the question is closed at its source so
// nothing re-asks it:
//
//   ledger question (metadata.question_id, lib/open-questions.mjs)
//       → retired "dismissed by the user"; question_state stamped on every copy.
//         A hum improvement idea behind it (memory_hook hum_improvement:<id>)
//         is marked declined in the ideas ledger, so hum_asks stops re-asking.
//   decision card (metadata.choices kind "decision", lib/decision-queue.mjs)
//       → the source entry's status becomes "dismissed" (no longer open, so
//         the decisions lane never offers it again).
//   anything else  → the row is stamped dismissed; nothing else to close.
//
// Structure only (Rule #0b): a metadata flag the app set, ids we wrote.
// Returns {handled:true, reply:null} — silent, like a checklist tick.

import { getQuestion, recordRetired, stampRows } from "./open-questions.mjs";

export const DISMISS_KEY = "question_dismiss";

export function isDismissal(row) {
  return row?.role === "user" && !!row?.reply_to && row?.metadata?.[DISMISS_KEY] != null;
}

function parseChoices(raw) {
  if (!raw) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
}

/** Close a decision-queue entry as dismissed. */
export async function dismissDecision(ref, now = new Date()) {
  const dq = await import("./decision-queue.mjs");
  const source = { cost: "cost", imp: "improvement", ppl: "people" }[String(ref || "").split(":")[0]];
  if (!source) return false;
  const file = dq.PATHS[source]();
  let doc;
  try { doc = JSON.parse((await import("node:fs")).readFileSync(file, "utf8")); } catch { return false; }
  const q = (doc?.questions || []).find((x) => dq.refFor(source, x) === ref);
  if (!q || q.status !== "open") return false;
  q.status = "dismissed";
  q.dismissed_at = now.toISOString();
  q.answered_via = "chat-dismiss";
  dq.writeJsonAtomic(file, doc);
  return true;
}

/** Mark a hum improvement idea declined so hum_asks never re-asks it. */
export async function declineIdea(ideaId) {
  if (!ideaId) return false;
  const ideas = await import("./hum-ideas.mjs");
  const cur = ideas.loadLatest().find((i) => i.id === ideaId);
  if (!cur || cur.status === "declined") return false;
  ideas.appendRow({ id: ideaId, status: "declined", declined_via: "chat-dismiss", updated_at: new Date().toISOString() });
  return true;
}

/**
 * @param parent the question row {id, metadata}
 * @returns {Promise<{handled:true, reply:null, kind:"dismiss", closed:string[]}>}
 */
export async function dismissQuestion(parent, deps = {}) {
  const meta = parent?.metadata || {};
  const closed = [];
  const msgIds = new Set([parent?.id].filter(Boolean));

  const qid = meta.question_id;
  if (qid) {
    const q = (deps.getQuestion || getQuestion)(qid);
    for (const id of q?.msg_ids || []) msgIds.add(id);
    if ((deps.recordRetired || recordRetired)(qid, "dismissed by the user")) closed.push(`question:${qid}`);
    const hook = String(q?.memory_hook || "");
    if (hook.startsWith("hum_improvement:")) {
      try { if (await (deps.declineIdea || declineIdea)(hook.slice("hum_improvement:".length))) closed.push(`idea:${hook}`); }
      catch (e) { console.error(`[question-dismiss] idea decline failed: ${e.message}`); }
    }
  }

  const prompt = parseChoices(meta.choices);
  if (prompt?.kind === "decision" && prompt.ref) {
    try { if (await (deps.dismissDecision || dismissDecision)(prompt.ref)) closed.push(`decision:${prompt.ref}`); }
    catch (e) { console.error(`[question-dismiss] decision dismiss failed: ${e.message}`); }
  }

  await (deps.stampRows || stampRows)([...msgIds], "dismissed");
  return { handled: true, reply: null, kind: "dismiss", closed };
}
