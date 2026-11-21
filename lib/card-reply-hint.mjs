// card-reply-hint — which waiting card a TYPED reply answers, and how to file it.
//
// An exact tap on a card is filed in code (lib/choice-reply.mjs); a typed answer is
// the agent's reading. This builds the line that tells the agent which card the
// reply is to and the command that files it (a decision card, a chat build's
// question, an installation's own card kind). It was phone-channel's alone, so a
// typed reply to a decision card written in a ROLE's conversation reached a role
// session that never saw it; role-session now builds it from the same function.
// Structured fields only (our own card metadata): what the user meant is the agent's reading.

import { installTools } from "./root.cjs";
import { assistantName } from "./instance.cjs";

const ASSISTANT = assistantName(); // the assistant's configured name (lib/instance.cjs)

/**
 * `parent` is the jori_messages row the reply is threaded to; `hints` the installation's
 * own card kinds (agent/phone-channel/_ext/reply-hints.mjs `cardHints`). "" when the
 * parent is not a card with a filing command.
 */
export function cardReplyHint(parent, hints = {}) {
  const REPLY_HINTS = hints;
  try {
    const raw = parent?.metadata?.choices;
    const p = typeof raw === "string" ? JSON.parse(raw) : raw;
    // An installation's own card kind (REPLY_HINTS, from _ext/reply-hints.mjs):
    // the user's typed answer is the agent's reading; the hint only names the
    // ref and how to file it. The kernel's decision card is never overridden.
    const extHint = p?.kind !== "decision" && p?.ref ? REPLY_HINTS[p.kind] : null;
    if (typeof extHint === "function") return extHint(p) || "";
    // A chat build parked on a question (lib/build-park.mjs): the typed answer
    // resumes that build's own session. Drawn as a decision card, routed by
    // `handler` (cards sent before 2026-11-16 carry kind "build-park").
    if ((p?.handler || p?.kind) === "build-park" && p.ref) {
      const bopts = (p.options || []).map((o, i) => `${i + 1}. ${o.label}`).join("; ");
      return `[Build question ${p.ref}] That message was a build they asked for, stopped to ask them this (options: ${bopts}). Once you know their answer, file it with \`${installTools("bin/build-park")} answer --id ${p.ref} --option "<that option's label, exactly>"\` or \`--text "<their answer, in their words>"\`; the build then resumes where it stopped. Confirm in one short line. If they are asking about it rather than answering, answer and leave it open.\n\n`;
    }
    if (p?.kind !== "decision" || p.handler || !p.ref) return "";
    const opts = (p.options || []).map((o, i) => `${i + 1}. ${o.label}`).join("; ");
    return `[Decision card ${p.ref}] That message was a decision ${ASSISTANT} asked them (options: ${opts}). Once you know their answer — an option (by number or meaning) or their own words — file it with \`~/Dev/jori/bin/decision-answer --ref ${p.ref} --option "<that option's label, exactly>"\` or \`--text "<their answer>"\`, then confirm in one short line. If they are asking about it rather than answering, answer and leave it open.\n\n`;
  } catch {
    return "";
  }
}
