// photo-companions.test.mjs — Jev may drop a face that is only PICTURED, never
// add one; the user is never a companion; names are canonical. Synthetic names
// in a temp local config.
// Run: node --test tests/photo-companions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "photo-companions-"));
fs.mkdirSync(path.join(LOCAL, "config"));
fs.writeFileSync(path.join(LOCAL, "instance.json"), JSON.stringify({ owner_name: "Alex", owner_id: "alex" }));
fs.writeFileSync(path.join(LOCAL, "config", "companion-names.json"), JSON.stringify({
  self: ["Alex Example"], aliases: { "Sam Example": "Sam", "Rover": "Rover", "Kim Example": "Kim" },
}));
process.env.JORI_LOCAL_DIR = LOCAL;
const { presentCompanions, buildState, taggedPeople } = await import("../lib/photo-companions.mjs");

const cafe = [
  { taken_at: "2026-10-07T05:34:17Z", persons: ["Sam Example", "Rover"], labels: ["dog", "people", "restaurant"], self_captured: true },
  { taken_at: "2026-10-07T05:34:18Z", persons: ["Alex Example", "Sam Example"], labels: ["people", "cup"], self_captured: true },
  { taken_at: "2026-10-07T05:36:00Z", persons: ["Kim Example"], labels: ["computer monitor", "screen"], self_captured: true },
];
// Stand-in for the harness: run interpret on scripted answers, act on them.
const jevSays = (yes) => async (o) => {
  const answers = {};
  Object.keys(o.questions).forEach((k, i) => { answers[k] = { type: "noul", noul: yes[i] }; });
  const it = o.interpret(answers);
  return { value: it.value, used: "jev", jev: { confidence: it.confidence } };
};

test("the user is never a companion and face-tag names are canonical", () => {
  assert.deepEqual([...taggedPeople(cafe).keys()], ["Sam", "Rover", "Kim"]);
  const st = buildState({ photos: cafe, tz: "Asia/Jerusalem" });
  assert.deepEqual(st.photos[1].people_tagged, ["Sam"]);
  assert.equal(st.photos[0].at, "08:34");
  assert.equal(st.photos[0].taken_by_alex, true, "the took-it key is named with the owner id");
});

test("a face only on a screen is dropped; the people at the table stay", async () => {
  const r = await presentCompanions({ photos: cafe, decideImpl: jevSays([0.98, 0.97, 0.03]) });
  assert.deepEqual(r.present, ["Sam", "Rover"]);
  assert.deepEqual(r.dropped.map((d) => d.name), ["Kim"]);
});

test("on legacy (Jev unsure or down) every tag stands", async () => {
  const r = await presentCompanions({ photos: cafe, decideImpl: async (o) => ({ value: await o.legacy(), used: "legacy" }) });
  assert.deepEqual(r.present, ["Sam", "Rover", "Kim"]);
});

test("no tagged people: nothing asked", async () => {
  const r = await presentCompanions({ photos: [{ persons: ["Alex"] }], decideImpl: () => { throw new Error("asked"); } });
  assert.deepEqual(r, { present: [], dropped: [], used: "none" });
});
