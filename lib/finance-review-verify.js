"use strict";
// finance-review-verify — proves the model's summary says nothing the packet
// does not.
//
// The weekly review's tables are rendered by code from the packet. The only
// model-written text is a short summary at the top, and this is its gate. The
// 2026-10-04 email showed what an ungated summary does: it called a predicted
// manual payment "autopay set to pull", explained a quiet rent week as "normal
// for long-term rentals mid-month" (wrong type, wrong date), and attached a
// T+1 settlement caveat to cash that settles instantly. None of those were
// numbers. They were WORDS the packet never said.
//
// So the check is containment, not plausibility:
//   * every sentence cites one or more packet facts by id, and the ids exist;
//   * every number in it (amounts, percents, counts, day numbers) appears in
//     one of the facts it cites;
//   * every content word in it appears in one of the facts it cites (after
//     light stemming), or is on a short list of connective words that carry no
//     claim ("also", "this week", "worth a look").
// A sentence that fails is a failed summary. The composer then sends the email
// without one: tables only, which are correct by construction.
//
// This validates MODEL OUTPUT against a source text. It does not interpret
// anything the user writes.

const { instance } = require("./instance.cjs");

const MAX_SENTENCES = 5;
const MAX_WORDS = 45;

// Words that join facts without asserting anything. Deliberately small: every
// word added here is a word the model may use without a source.
const GLUE = new Set(`
a an the and or but also plus then so as at by for from in into of on onto to with without
is are was were be been being has have had it its this that these those there here
week this-week weekly worth look note noted attention needs need needing first next main biggest largest top
item items flag flags flagged open question questions answer answers nothing urgent otherwise quiet else
still only both each per vs versus while which what who where when not no yes
your you his him her their
`.trim().split(/\s+/));
// The reader's own name addresses them; it asserts nothing.
for (const w of String(instance().owner_name || "").toLowerCase().split(/[^a-z']+/)) if (w.length >= 3 && w !== "the" && w !== "user") GLUE.add(w);

const stem = (w) => w
  .replace(/['’]s$/, "")
  .replace(/(ies)$/, "y")
  .replace(/(ing|ed|es|s|ly)$/, "")
  .slice(0, 8);

const words = (text) => String(text).toLowerCase()
  .replace(/[$−–—-]?\$?\d[\d,]*(\.\d+)?%?/g, " ") // numbers handled separately
  .split(/[^a-z']+/).filter((w) => w.length >= 3);

const numbers = (text) => (String(text).match(/\d[\d,]*(\.\d+)?/g) || [])
  .map((n) => n.replace(/,/g, "").replace(/\.0+$/, ""));

/**
 * @param {{facts: {id:string,text:string}[]}} packet
 * @param {{sentences: {text:string, facts:string[]}[]}} summary
 */
function verifySummary(packet, summary) {
  const problems = [];
  const factById = new Map((packet.facts || []).map((f) => [f.id, f]));
  const sentences = summary && Array.isArray(summary.sentences) ? summary.sentences : null;
  if (!sentences) return { ok: false, problems: [{ sentence: null, issue: "summary must be {sentences:[{text, facts:[ids]}]}" }] };
  if (sentences.length > MAX_SENTENCES) problems.push({ sentence: null, issue: `more than ${MAX_SENTENCES} sentences` });

  sentences.forEach((s, i) => {
    const where = `#${i + 1}`;
    const text = String(s.text || "").trim();
    if (!text) { problems.push({ sentence: where, issue: "empty" }); return; }
    if (text.split(/\s+/).length > MAX_WORDS) problems.push({ sentence: where, issue: `over ${MAX_WORDS} words` });
    const ids = Array.isArray(s.facts) ? s.facts : [];
    if (!ids.length) { problems.push({ sentence: where, issue: "cites no fact" }); return; }
    const missing = ids.filter((id) => !factById.has(id));
    if (missing.length) { problems.push({ sentence: where, issue: `unknown fact id(s): ${missing.join(", ")}` }); return; }

    const source = ids.map((id) => factById.get(id).text).join(" \n ");
    const srcNums = new Set(numbers(source));
    for (const n of numbers(text)) {
      if (!srcNums.has(n)) problems.push({ sentence: where, issue: `number "${n}" is not in the cited facts` });
    }
    const srcStems = new Set(words(source).map(stem));
    const srcWords = new Set(words(source));
    for (const w of words(text)) {
      if (GLUE.has(w) || srcWords.has(w) || srcStems.has(stem(w))) continue;
      problems.push({ sentence: where, issue: `word "${w}" is not in the cited facts` });
    }
  });

  return { ok: problems.length === 0, problems };
}

module.exports = { verifySummary, MAX_SENTENCES, MAX_WORDS };
