// lib/build-park.mjs — a chat build asks one question and resumes its own
// session with the answer (docs/chat-build-park.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./synthetic-instance.mjs";
import { ask, park, answer, sweep, card, resumeTask, MAX_ROUNDS, PARK_TTL_DAYS, KIND } from "../lib/build-park.mjs";

function queue(request = { id: "b1", spec: "Add a weekly summary of open leases", source: "chat", size: "large" }) {
  const q = fs.mkdtempSync(path.join(os.tmpdir(), "bq-"));
  for (const d of ["running", "pending", "parked", "asks", "failed", "done"]) fs.mkdirSync(path.join(q, d));
  fs.writeFileSync(path.join(q, "running", `${request.id}.json`), JSON.stringify(request));
  return q;
}
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const Q = { question: "Which day should it go out?", options: ["Monday morning", "Friday afternoon"], recommended: 0 };

test("ask → park → tap answer → the request is back in pending with the session to resume", () => {
  const q = queue();
  const now = Date.parse("2026-11-16T12:00:00Z");
  assert.equal(ask({ id: "b1", ...Q, context: "The digest itself is built." }, { q, now }).round, 1);
  let sent = null;
  const r = park({ id: "b1", sessionId: "sess-1" }, { q, now, send: (c) => { sent = c; return { ok: true, msgId: "m1" }; } });
  assert.equal(r.parked, true);
  assert.equal(sent.choices.kind, "decision"); // the app draws multiple choice only for this kind
  assert.equal(sent.choices.handler, KIND);
  assert.equal(sent.choices.ref, "b1");
  assert.deepEqual(sent.choices.options.map((o) => o.label), Q.options);
  assert.ok(sent.text.includes("needs one answer"));
  assert.ok(!fs.existsSync(path.join(q, "running", "b1.json")));
  assert.equal(read(path.join(q, "parked", "b1.json")).session_id, "sess-1");

  const a = answer({ id: "b1", option: "Friday afternoon" }, { q, now: now + 3600e3 });
  assert.deepEqual([a.ok, a.resumed], [true, true]);
  const back = read(path.join(q, "pending", "b1.json"));
  assert.equal(back.resume.session_id, "sess-1");
  assert.equal(back.resume.answer, "Friday afternoon");
  assert.equal(back.resume.answer_kind, "option");
  assert.equal(back.spec, "Add a weekly summary of open leases");
  assert.ok(!fs.existsSync(path.join(q, "parked", "b1.json")));
  // A second tap on the same card.
  assert.equal(answer({ id: "b1", option: "Monday morning" }, { q }).already_answered, true);
  const task = resumeTask("b1", back.resume, "/r/b1.md");
  assert.ok(task.includes("Their answer: Friday afternoon") && task.includes("git status --porcelain"));
});

test("a typed answer is passed on as the user's words; a label that is not on the card is refused", () => {
  const q = queue();
  ask({ id: "b1", ...Q }, { q });
  park({ id: "b1", sessionId: "s" }, { q, send: () => ({ ok: true }) });
  assert.throws(() => answer({ id: "b1", option: "Sunday" }, { q }), /not one of the card's options/);
  answer({ id: "b1", text: "neither, do Wednesdays" }, { q });
  const back = read(path.join(q, "pending", "b1.json"));
  assert.equal(back.resume.answer, "neither, do Wednesdays");
  assert.equal(back.resume.answer_kind, "text");
});

test("an old parked build restarts fresh with the question and answer in the spec", () => {
  const q = queue();
  const now = Date.parse("2026-11-01T12:00:00Z");
  ask({ id: "b1", ...Q }, { q, now });
  park({ id: "b1", sessionId: "s" }, { q, now, send: () => ({ ok: true }) });
  const a = answer({ id: "b1", option: "Monday morning" }, { q, now: now + (PARK_TTL_DAYS + 1) * 86400e3 });
  assert.equal(a.fresh, true);
  const back = read(path.join(q, "pending", "b1.json"));
  assert.equal(back.resume, undefined);
  assert.ok(back.spec.includes('stopped to ask the user: "Which day should it go out?"\nTheir answer: Monday morning'));
});

test("a held card still parks; a failed send or a missing session does not", () => {
  let q = queue();
  ask({ id: "b1", ...Q }, { q });
  assert.equal(park({ id: "b1", sessionId: "s" }, { q, send: () => ({ ok: false, held: true }) }).held, true);
  q = queue();
  ask({ id: "b1", ...Q }, { q });
  assert.equal(park({ id: "b1", sessionId: "" }, { q, send: () => ({ ok: true }) }).parked, false);
  assert.equal(park({ id: "b1", sessionId: "s" }, { q, send: () => ({ ok: false, status: 3 }) }).parked, false);
  assert.ok(fs.existsSync(path.join(q, "running", "b1.json")), "not parked: the request stays for the report path");
});

test("rounds are capped, bad asks fail inside the run, and only the running build can ask", () => {
  const q = queue({ id: "b1", spec: "x", source: "chat", resume: { round: MAX_ROUNDS } });
  assert.throws(() => ask({ id: "b1", ...Q }, { q }), /already asked/);
  const q2 = queue();
  assert.throws(() => ask({ id: "b1", question: "?", options: ["only one"] }, { q: q2 }), /2 to 4/);
  assert.throws(() => ask({ id: "other", ...Q }, { q: q2 }), /no running build/);
});

test("sweep drops builds nobody answered for a month", () => {
  const q = queue();
  const now = Date.parse("2026-10-01T12:00:00Z");
  ask({ id: "b1", ...Q }, { q, now });
  park({ id: "b1", sessionId: "s" }, { q, now, send: () => ({ ok: true }) });
  assert.deepEqual(sweep({ q, now: now + 10 * 86400e3 }), []);
  assert.deepEqual(sweep({ q, now: now + 31 * 86400e3 }), ["b1"]);
  assert.equal(read(path.join(q, "failed", "b1.json")).parked_unanswered, Q.question);
});

test("the card carries an expiry and the recommended option", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  const { choices } = card({ id: "b1", ...Q, context: "" }, { spec: "x" }, { now });
  assert.equal(choices.expires_at, new Date(now + PARK_TTL_DAYS * 86400e3).toISOString());
  assert.equal(choices.options[0].label, "Monday morning");
  assert.ok(choices.recommended_id);
});

test("the card goes out under an intent the speak gate never holds", async () => {
  const { QUESTION_INTENT } = await import("../lib/build-park.mjs");
  const { NEVER_HELD_INTENTS } = await import("../lib/speak-gate-live.mjs");
  assert.ok(NEVER_HELD_INTENTS.has(QUESTION_INTENT));
  assert.ok(NEVER_HELD_INTENTS.has("chat-build-result"), "the build's report answers a request the user made");
});
