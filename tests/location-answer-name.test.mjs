// location-answer-name.test.mjs — the place-name reader behind location-confirm
// save-visit. Models stubbed; the replies are synthetic. Run: node --test <this file>
import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, readPlaceAnswer, validate } from "../lib/location-answer-name.mjs";

const FRIENDS = "Sam and Kim's house, 1 Example Lane. We left our car there and went on a day trip to the hills in Sam's car.";
const COUSINS = "This was Robin (Bobbie) and Lee Sample’s house. 2 Sample rd. my cousins were also there - jo and her husband and three kids, and Chris.";
const PLACE = '{"answer":"place","place_name":"Sam and Kim\'s house","evidence":"Sam and Kim\'s house, 1 Example Lane."}';
const ladder = (sonnet, opus, seen = []) => ({ seen, tiers: [["sonnet", sonnet], ["opus", opus]].map(([name, out]) =>
  ({ name, run: async () => { seen.push(name); if (out instanceof Error) throw out; return out; } })) });

test("provenance: an invented or unquoted name fails, his own words pass", () => {
  // gemma3:1b probe: a name from the QUESTION; a word the user never said.
  assert.ok(validate({ answer: "place", place_name: "Sample Road", evidence: "Sample Road" }, "Why do you keep asking me about this?"));
  assert.ok(validate({ answer: "place", place_name: "map", evidence: "Was this the place with the dog?" }, "Was this the place with the dog?"));
  assert.ok(validate({ answer: "place|other" }, FRIENDS));
  assert.ok(validate({ answer: "place", place_name: "x".repeat(61), evidence: FRIENDS }, FRIENDS));
  assert.equal(validate({ answer: "place", place_name: "Robin (Bobbie) and Lee Sample's house, 2 Sample rd",
    evidence: "Robin (Bobbie) and Lee Sample’s house" }, COUSINS), null);   // straight vs curly apostrophe
});

test("the prompt carries the stop's window and Jori's guess, to tell two places apart", () => {
  const p = buildPrompt("We had lunch at Deli One and then walked over to Cafe Two for coffee", { stop: "Sat 10 Oct, 15:20–15:55", guess: "Cafe Two", who: "Alex" });
  assert.ok(p.includes("(Sat 10 Oct, 15:20–15:55, local time)") && p.includes('guess for it had been "Cafe Two"'));
  assert.ok(p.includes("Jori asked Alex"));
  assert.ok(!buildPrompt("x").includes("guess for it"));
});

test("Sonnet's name is taken; unsure / other give no name and win", async () => {
  const l = ladder(PLACE, "");
  assert.deepEqual([(await readPlaceAnswer(FRIENDS, l)).place_name, l.seen], ["Sam and Kim's house", ["sonnet"]]);
  for (const answer of ["unsure", "other"]) {
    const m = ladder(`{"answer":"${answer}","place_name":"Aroma","evidence":"Aroma"}`, PLACE);
    assert.deepEqual([(await readPlaceAnswer("Probably Aroma, not sure", m)).place_name, m.seen], [null, ["sonnet"]]);
  }
});

test("a malformed Sonnet reply climbs to Opus; any failure or timeout gives null", async () => {
  const l = ladder("I think it's a house", PLACE);
  assert.deepEqual([(await readPlaceAnswer(FRIENDS, l)).tier, l.seen], ["opus", ["sonnet", "opus"]]);
  assert.equal(await readPlaceAnswer(FRIENDS, ladder("", "{}")), null);
  assert.equal(await readPlaceAnswer(FRIENDS, ladder(new Error("spawn failed"), new Error("x"))), null);
  assert.equal(await readPlaceAnswer(FRIENDS, { ...ladder(PLACE, PLACE), deadlineMs: 1000 }), null);   // no rung under 2 s
});
