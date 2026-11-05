// call-vocabulary.test.mjs — the names handed to the call-notes models so they
// can fix Zoom's mishearings (lib/call-vocabulary.mjs), and the prompts that
// carry them (lib/meeting-notes-update.mjs editPrompt, lib/call-log.mjs
// logPrompt). Code only gathers the list; the model corrects. Synthetic names.
//
// Run: node --test tests/call-vocabulary.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.JORI_OWNER_NAME = "Ann";
process.env.JORI_OWNER_ID = "ann";
process.env.JORI_OWNER_EMAIL = "ann@example.org";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const V = await import(path.join(ROOT, "lib/call-vocabulary.mjs"));
const nu = await import(path.join(ROOT, "lib/meeting-notes-update.mjs"));
const CL = await import(path.join(ROOT, "lib/call-log.mjs"));

// A tiny wiki: Sam's page, two people linked to and from it, a day page in the
// window and one outside it, and a non-person page.
const person = (title) => ({ title, frontmatter_json: JSON.stringify({ entity: "person" }) });
const PAGES = {
  user_sam_lee: person("Sam Lee"),
  user_rob_day: person("Rob Day"),
  user_kim_ito: person("Kim Ito"),
  user_lou_ray: person("Lou Ray"),
  user_old_pal: person("Old Pal"),
  reference_acme: { title: "Acme - advisory role", frontmatter_json: "{}" },
  "day_2026-10-30": { title: "Friday", frontmatter_json: JSON.stringify({ type: "day" }) },
  "day_2026-08-01": { title: "Saturday", frontmatter_json: JSON.stringify({ type: "day" }) },
};
const FWD = {
  user_sam_lee: [{ dst_id: "user_rob_day", dst_title: "Rob Day", resolved: true }, { dst_id: "reference_acme", dst_title: "Acme - advisory role", resolved: true }, { dst_id: "user_gone", dst_title: "Gone", resolved: false }],
  "day_2026-10-30": [{ dst_id: "user_sam_lee", dst_title: "Sam Lee", resolved: true }, { dst_id: "user_lou_ray", dst_title: "Lou Ray", resolved: true }],
  "day_2026-08-01": [{ dst_id: "user_old_pal", dst_title: "Old Pal", resolved: true }],
};
const BACK = {
  user_sam_lee: [{ src_id: "user_kim_ito", src_title: "Kim Ito" }, { src_id: "day_2026-10-30", src_title: "Friday" }, { src_id: "day_2026-08-01", src_title: "Saturday" }],
};
const ws = {
  getPage: (id) => PAGES[id] || null,
  searchPages: (q) => Object.keys(PAGES).filter((id) => PAGES[id].title.toLowerCase().includes(String(q).toLowerCase())).map((id) => ({ id })),
  getForwardLinks: (id) => FWD[id] || [],
  getBacklinks: (id) => BACK[id] || [],
};
const NOW = Date.parse("2026-11-04T12:00:00Z");

test("the list keeps priority order, drops duplicates and junk, and is bounded", () => {
  assert.deepEqual(V.boundedVocabulary([["ServiceCo", " Sam Lee "], ["sam lee", "", null, "x".repeat(61), "Rob Day"]]), ["ServiceCo", "Sam Lee", "Rob Day"]);
  const many = Array.from({ length: 200 }, (_, i) => `Name${i}`);
  assert.equal(V.boundedVocabulary([many]).length, V.MAX_NAMES);
  const long = Array.from({ length: 50 }, (_, i) => `${"Long".repeat(10)}${i}`);
  const got = V.boundedVocabulary([long]);
  assert.ok(got.join("; ").length <= V.MAX_CHARS, "char cap holds");
  assert.ok(got.length < 50);
});

test("the wiki gives the counterpart, the people linked to and from them, and people on recent day pages", () => {
  const names = V.wikiNames({ names: ["sam lee", "samlee"], ws, now: NOW });
  assert.deepEqual(names, ["Sam Lee", "Rob Day", "Kim Ito", "Lou Ray"]);
  assert.ok(!names.includes("Old Pal"), "a day page outside the window is not a recent mention");
  assert.ok(!names.includes("Acme - advisory role"), "only person pages");
});

test("a page is found by its id, or by an exact title only (never a partial name)", () => {
  assert.deepEqual(V.wikiNames({ pageIds: ["user_sam_lee"], ws, now: NOW }).slice(0, 1), ["Sam Lee"]);
  assert.deepEqual(V.wikiNames({ names: ["Sam"], ws, now: NOW }), []);
});

test("no wiki, or a wiki that throws, gives just the configured names", () => {
  assert.deepEqual(V.callVocabulary({ config: ["ServiceCo"], names: ["Sam Lee"] }), ["ServiceCo"]);
  const broken = { getPage: () => { throw new Error("no db"); } };
  assert.deepEqual(V.callVocabulary({ config: ["ServiceCo"], pageIds: ["x"], ws: broken }), ["ServiceCo"]);
  assert.deepEqual(V.callVocabulary({ config: ["ServiceCo"], names: ["Sam Lee"], ws, now: NOW }), ["ServiceCo", "Sam Lee", "Rob Day", "Kim Ito", "Lou Ray"]);
});

test("the block asks the model to correct mishearings of these names, and is empty for no names", () => {
  assert.equal(V.vocabularyBlock([]), "");
  const b = V.vocabularyBlock(["ServiceCo", "Sam Lee"]);
  assert.ok(b.includes("ServiceCo; Sam Lee"));
  assert.ok(b.includes("mishears"));
  assert.ok(b.includes("Never add a name"));
});

const NOTES = "# Notes\n\n## Running Context (Full History)\n\n### People\n\n**Sam** — cofounder.\n\n## To Discuss (Upcoming)\n\n- [ ] Pilot\n\n## Discussed\n";

test("the meeting-notes prompt carries the names before Zoom's text; without names it is unchanged", () => {
  const args = { date: "2026-11-04", when: "4:00pm-4:30pm, 30 min", source: "summary", content: "They discussed Suicide's contract.", notesText: NOTES, name: "Sam" };
  const plain = nu.editPrompt(args);
  assert.ok(!plain.includes("NAMES THAT MAY APPEAR"));
  const p = nu.editPrompt({ ...args, vocabulary: ["ServiceCo"] });
  assert.ok(p.includes("NAMES THAT MAY APPEAR"));
  assert.ok(p.indexOf("ServiceCo") < p.indexOf("Suicide's contract"), "the names come before the call text");
});

test("the call-log prompt carries the names; config plus the wiki around the candidates", () => {
  const rec = { start: "2026-10-23T14:31:30Z", end: "2026-10-23T15:16:12Z", minutes: 45, topic: "Room", guests: [{ name: "Rob Day", email: null, minutes: 43 }] };
  const content = { kind: "summary", text: "Rob asked about Suicide." };
  assert.ok(!CL.logPrompt(rec, content, [], "UTC").includes("NAMES THAT MAY APPEAR"));
  const vocab = CL.vocabularyForCall([{ id: "user_sam_lee" }], ws, { vocabulary: ["ServiceCo"] });
  assert.equal(vocab[0], "ServiceCo");
  assert.ok(vocab.includes("Sam Lee"));
  const p = CL.logPrompt(rec, content, [], "UTC", vocab);
  assert.ok(p.includes("NAMES THAT MAY APPEAR"));
  assert.ok(p.includes("ServiceCo; Sam Lee"));
});
