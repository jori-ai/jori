// push-announce.test.mjs — which pushes go out time-sensitive (read aloud).
// Replies always, urgent always, the system channel never; everything else is
// Jev site push-announce's call, failing open to a regular push.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { announceDecision } from "../lib/apns-push.mjs";
import { judgePush, announces, pushAnnounceOn, legacyPrompt, SITE } from "../lib/push-announce.mjs";
import { jevSiteDef } from "../lib/jev.mjs";

const never = () => { throw new Error("judge must not be called"); };

test("a reply to the user's request is read aloud without a judgment", async () => {
  assert.equal(await announceDecision({ body: "Here's the answer", announce: "always" }, { judge: never }), true);
});

test("urgent is read aloud; the system channel is not, and neither is judged", async () => {
  assert.equal(await announceDecision({ body: "Leave now", urgent: true }, { judge: never }), true);
  assert.equal(await announceDecision({ body: "Watchdog restarted X", channel: "system" }, { judge: never }), false);
});

test("everything else follows Jev's level", async () => {
  for (const [level, expected] of [["urgent", true], ["important", true], ["normal", false]]) {
    const judge = async () => ({ level, used: "jev" });
    assert.equal(await announceDecision({ body: "x" }, { judge }), expected, level);
  }
});

test("a test run without an injected judge never calls Jev", async () => {
  assert.equal(await announceDecision({ body: "Morning digest" }), false);
});

test("a failing or slow judgment falls back to a regular push", async () => {
  const err = await judgePush({ title: "t", body: "b" }, { judge: async () => { throw new Error("boom"); } });
  assert.deepEqual([err.level, err.used], ["normal", "error"]);
  const slow = await judgePush({ title: "t", body: "b" }, { timeoutMs: 20, judge: () => new Promise((r) => setTimeout(() => r({ level: "urgent" }), 500)) });
  assert.deepEqual([slow.level, slow.used], ["normal", "timeout"]);
});

test("off switch and levels", () => {
  const flag = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pa-")), ".push-announce-off");
  assert.equal(pushAnnounceOn(flag), true);
  fs.writeFileSync(flag, "");
  assert.equal(pushAnnounceOn(flag), false);
  assert.deepEqual(["urgent", "important", "normal"].map(announces), [true, true, false]);
});

test("the site has a rubric for every level, and the legacy prompt reads it", () => {
  const def = jevSiteDef(SITE);
  for (const l of ["urgent", "important", "normal"]) assert.ok(def.questions.level.criteria[l], l);
  const p = legacyPrompt({ push: { title: "t", body: "b" } }, def);
  assert.ok(p.includes(def.questions.level.criteria.important));
});

test("a question is never read aloud, even urgent, and is not judged", async () => {
  assert.equal(await announceDecision({ body: "Where did you have lunch?", announce: "never" }, { judge: never }), false);
  assert.equal(await announceDecision({ body: "Which stop was that?", urgent: true, announce: "never" }, { judge: never }), false);
});
