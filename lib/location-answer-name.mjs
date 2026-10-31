// location-answer-name.mjs — a confident place NAME read out of a sentence the
// user gave for "where was this stop?" (location-confirm save-visit). A reply
// like "<friends>' house, <street address>. We left our car there and went on a
// day trip in their car." stayed row-only, because a sentence must not become
// the 30 m label of every later stop. What names the place, and whether the
// user is sure, is a language judgment (Rule #0b).
//
// THE LADDER STARTS AT SONNET (Opus if its reply is malformed), not the local
// model — a Rule #0b exception the owner decided. On 11 replies gemma3:1b refused three real places and invented two ("Hahadarim Road" from
// the question; "map"), and those wrong answers PASS the schema check, so a
// local-first ladder would never climb: it would act on them. At ~1 such answer
// a week, ~3-6 s each, a local rung buys nothing. Spelling a place name with
// Sonnet is what stop-evidence.mjs and photo-place-name.js already do.
//
// The stop's local window and Jori's own lead guess go in the prompt only so
// the model can tell WHICH of several places the user named was this stop; when that
// is not clear ("lunch at Miznon, then coffee at Cafe Xoho") the answer is unsure.
//
// Code checks provenance only: the JSON; answer exactly place | unsure | other;
// for "place" a 2-60 char label, an "evidence" quote found in the user's words, and
// every label word found there. unsure (hedged, a question), other (no place,
// another stop), any failure or timeout: no name, the answer stays row-only.
//
// CLI: echo '{"text":"...","stop":"Mon 12 Oct, 09:02–09:18","guess":"..."}' | node <this>
//   → one line: {"answer","place_name","evidence","tier"} or {"place_name":null}

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { instance } from "./instance.cjs";

export const MAX_LABEL_CHARS = 60;   // = PROMOTE_MAX_NAME_CHARS in location-confirm
const ANSWERS = new Set(["place", "unsure", "other"]);

export function buildPrompt(text, { stop, guess, who = instance().owner_name } = {}) {
  const when = stop ? ` (${stop}, local time)` : "";
  const lead = guess ? ` Jori's own guess for it had been "${guess}": only a guess, often wrong, never a reason to doubt a place the person clearly states.` : "";
  return `Jori asked ${who} (below: "the person") where they were during one stop of their day${when}.${lead} The person's answer:
"""
${text}
"""
Classify the answer:
- "place": the person states, without hedging, where they were during THIS stop: a venue, a business, a street address, or someone's home.
- "unsure": the person is not sure ("maybe", "probably", "I think", "not sure", "I don't know"), offers alternatives without settling on one, asks a question instead of answering ("Was this the pharmacy?"), or names more than one place without it being clear which one was THIS stop.
- "other": it names no place for this stop: not a stop, just walking or driving, or something else entirely. A place the person went AFTER or BEFORE this stop ("after this we went to X", "then we headed to X", "before that we were at X") is a different stop, not this one: if that is the only place named, the answer is "other".
If the person names this stop's place AND mentions where they went before or after, the answer is "place", with this stop's place. When more than one place is named, it is clear which one was this stop only if the person says so, or if Jori's guess names one of them; the time of day alone, or a guess that matches none of them, does not make it clear, and the answer is "unsure".
If "place": "place_name" is a short label for that place in the person's words (at most ${MAX_LABEL_CHARS} characters; no other details: not who was there, not what they did, not the street address when the place has a name), and "evidence" is the person's exact words that name it, copied verbatim. Otherwise leave both empty.

Output ONLY one line of compact JSON with exactly these keys: "answer" ("place", "unsure" or "other"), "place_name", "evidence". No prose, no code fence.`;
}

// Typography folded before comparing (a straight apostrophe from the model, a
// curly one from the user). A character map, not a pattern.
const FOLD = new Map([
  ["\u2018", "'"], ["\u2019", "'"], ["\u201B", "'"], ["\u02BC", "'"],
  ["\u201C", '"'], ["\u201D", '"'], ["\u201E", '"'],
  ["\u2013", "-"], ["\u2014", "-"], ["\u2212", "-"],
]);
export function fold(s) {
  let out = "", space = false;
  for (const ch of String(s ?? "")) {
    if (ch.trim() === "") { space = out.length > 0; continue; }
    if (space) { out += " "; space = false; }
    out += FOLD.get(ch) ?? ch;
  }
  return out.toLowerCase();
}

const EDGE = new Set([...",.;:!?()[]{}\"'"]);   // edges of one word of the MODEL's label
function trimEdges(w) {
  const c = [...w];
  while (c.length && EDGE.has(c[0])) c.shift();
  while (c.length && EDGE.has(c[c.length - 1])) c.pop();
  return c.join("");
}

/** null when `parsed` is a valid reading of `text`, else why it is not. */
export function validate(parsed, text) {
  if (!parsed || typeof parsed !== "object") return "not a JSON object";
  if (!ANSWERS.has(parsed.answer)) return `answer is ${JSON.stringify(parsed.answer)}`;
  if (parsed.answer !== "place") return null;
  const name = [...String(parsed.place_name ?? "").trim()];
  if (name.length < 2 || name.length > MAX_LABEL_CHARS) return `place_name is ${name.length} chars`;
  const hay = fold(text), ev = fold(String(parsed.evidence ?? "").trim());
  if (!ev || !hay.includes(ev)) return "evidence is not in the user's words";
  for (const w of fold(name.join("")).split(" ")) {
    const t = trimEdges(w);
    if (t && !hay.includes(t)) return `"${t}" is not in the user's words`;
  }
  return null;
}

let MODELS = null;
const claudeTier = (name) => ({ name, timeoutMs: 20000,
  // Tool-less and Max-only (lib/jev-claude.mjs): it cannot act on what it reads.
  run: async (prompt, timeoutMs) => {
    MODELS ||= createRequire(import.meta.url)("./models.cjs").MODELS;
    const { runToolless } = await import("./jev-claude.mjs");
    return runToolless({ model: MODELS[name], prompt, timeoutMs });
  },
});
export const TIERS = [claudeTier("sonnet"), claudeTier("opus")];

// The whole read is bounded (deadlineMs) so save-visit, which findme gives 60 s,
// always has time left to write — or to write nothing.
export async function readPlaceAnswer(text, { stop, guess, tiers = TIERS, deadlineMs = 25000, log = () => {} } = {}) {
  const said = String(text ?? "").trim();
  if (!said) return null;
  const { parseModelJson } = await import("./jev-claude.mjs");
  const t0 = Date.now();
  for (const tier of tiers) {
    const left = deadlineMs - (Date.now() - t0);
    if (left < 2000) { log(`deadline reached before ${tier.name}`); break; }
    let raw = "";
    try { raw = String((await tier.run(buildPrompt(said, { stop, guess }), Math.min(tier.timeoutMs ?? left, left))) ?? ""); }
    catch (e) { log(`${tier.name}: ${e.message}`); }
    const parsed = parseModelJson(raw);
    const why = validate(parsed, said);
    if (why) { log(`${tier.name} rejected: ${why}`); continue; }
    if (parsed.answer !== "place") return { answer: parsed.answer, place_name: null, tier: tier.name };
    return { answer: "place", place_name: String(parsed.place_name).trim(), evidence: String(parsed.evidence).trim(), tier: tier.name };
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let out = null, input = "";
  try {
    for await (const c of process.stdin) input += c;
    const { text, stop, guess } = JSON.parse(input || "{}");
    out = await readPlaceAnswer(text, { stop, guess, log: (m) => process.stderr.write(`[location-answer-name] ${m}\n`) });
  } catch (e) { process.stderr.write(`[location-answer-name] ${e.message}\n`); }
  process.stdout.write(JSON.stringify(out || { place_name: null }) + "\n");
}
