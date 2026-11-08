// local-history-prompt.mjs — the one prompt that turns nearby Wikipedia /
// OpenStreetMap subjects into a local-history ping (or nothing).
//
// Shared by the hum `nearby` lane (agent/scripts/hum-harvesters/nearby.mjs)
// and the live lane (bin/local-history-live), so a fact reads the same
// whichever path found it. Code builds the list; the model only decides
// whether one item is worth saying and words it.

import { renderLocalLoreBlock } from "./local-lore.mjs";
import { PROXIMITY_M } from "./local-history-ledger.mjs";

export const RELEVANCE_FLOOR = 0.55;

/**
 * @param {object} o
 * @param {string} o.owner        how to name the user ("The user" or their name)
 * @param {string} o.place        where they are, as a label ("" when unknown)
 * @param {number} o.hour         local hour
 * @param {boolean} o.moving
 * @param {object[]} o.items      localLore() items, nearest first
 * @param {string[]} [o.recentChat]
 * @param {string|null} [o.wokeBy] what started this (an event summary), or null
 * @param {number} [o.radiusM]    the radius the list was cut to
 * @param {boolean} [o.live]      the user is next to these right now (live lane)
 */
export function buildLocalHistoryPrompt({ owner = "The user", place = "", hour, moving, items, recentChat = [], wokeBy = null, radiusM = PROXIMITY_M, live = false, floor = RELEVANCE_FLOOR }) {
  const chatLines = (recentChat || []).slice(-10).map((t) => `  - ${t}`).join("\n");
  const where = live
    ? `${owner} is ${moving ? "walking" : "standing"} right next to these places at this moment (${hour}:00 local)${place ? `, around ${place}` : ""}.`
    : `${owner} is out around ${place || "a spot"} and it is ${hour}:00 local, ${moving ? "walking" : "stopped"}.`;
  return `${where} You may tell them ONE thing about the ground they are standing on, or say nothing.

These are the pings that land: what stood here before, what a street or building is named after, when something was cut or built and why — specific and human. "named after a sign showing a Moor's head that hung on the old rue du Maure" is worth saying; "a street in the 3rd arrondissement" is the definition, not the fact.

${renderLocalLoreBlock(items, radiusM)}

RULES:
1. The fact MUST come from the list above, not from memory. If nothing above is interesting, say nothing.
2. Pick ONE subject. Copy its title into "source" EXACTLY as written above — code uses it to place the subject on a map, check the user is still near it, and make sure it is never told again.
3. No venue recommendations, no "you should visit", no opening hours, nothing to book. This is an explanation, not a suggestion.
4. Read past the opening definition of an article; the story is usually under history / name-origin.
5. If the user's own recent words show they are busy with something (a meeting, a call, a meal), keep it short or say nothing.${live ? `
6. They are within sight of it now, so point at it: "The church beside you…", "here". Never "on your left/right" — you do not know which way they face.` : ""}

RELEVANCE 0.0-1.0, honestly — ${floor.toFixed(2)} is the floor:
  0.9  genuinely surprising and right in front of them
  0.75 a good story about something within sight
  0.6  mildly interesting
  <${floor.toFixed(2)} filler — say nothing

WHAT THE USER HAS SAID IN CHAT RECENTLY:
${chatLines || "  (nothing recent)"}

${wokeBy ? `What woke you: ${wokeBy}.` : live ? "What woke you: a fresh GPS fix from their phone." : "Nothing woke you; the user has been in this area a while."}

Reply with ONE JSON object and nothing else:
{"say": true|false, "relevance": 0.0-1.0, "source": "<exact title from the list>", "signal": "<what the user reads, under 220 chars, specific, no preamble>", "why_now": "<one line>", "why_not": "<if say is false, one line>"}`;
}
