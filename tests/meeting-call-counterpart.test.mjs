// meeting-call-counterpart.test.mjs — a recurring meeting's calls name the
// counterpart by their wiki person page (full name + link), not the meeting's
// short configured name.
// Run: node --test tests/meeting-call-counterpart.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { counterpart, settleCalls } from "../lib/meeting-call.mjs";

const m = { id: "weekly", name: "Sam", zoom: { participant: { emails: ["old@example.org", "sam@example.com"], names: [] } } };
const pages = { user_sam_rivera: { title: "Sam Rivera", status: "active" }, user_gone: { title: "Gone", status: "archived" } };

test("the person page linked to a participant email gives the full name and a link", () => {
  const cp = counterpart(m, { wikiIdForEmail: (e) => (e === "sam@example.com" ? "user_sam_rivera" : null), getPage: (id) => pages[id] || null });
  assert.deepEqual(cp, { name: "Sam Rivera", md: "[[user_sam_rivera|Sam Rivera]]" });
});

test("no linked page, an archived page, or a failing lookup falls back to the configured name", () => {
  assert.deepEqual(counterpart(m, { wikiIdForEmail: () => null, getPage: () => null }), { name: "Sam", md: null });
  assert.deepEqual(counterpart(m, { wikiIdForEmail: () => "user_gone", getPage: (id) => pages[id] }), { name: "Sam", md: null });
  assert.deepEqual(counterpart(m, { wikiIdForEmail: () => { throw new Error("no db"); } }), { name: "Sam", md: null });
});

test("settled calls carry who and who_md", () => {
  const kept = [{ start: "2026-11-02T21:00:00Z", end: "2026-11-02T21:30:00Z", minutes: 30, summary: "Sam <> me", event_id: "e1" }];
  const { calls } = settleCalls(kept, null, { who: "Sam Rivera", whoMd: "[[user_sam_rivera|Sam Rivera]]" });
  assert.equal(calls[0].who, "Sam Rivera");
  assert.equal(calls[0].who_md, "[[user_sam_rivera|Sam Rivera]]");
  assert.equal(settleCalls(kept, null, { who: "Sam" }).calls[0].who_md, undefined);
});
