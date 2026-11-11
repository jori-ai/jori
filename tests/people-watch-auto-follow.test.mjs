// people-watch-auto-follow.test.mjs — with `auto_follow_work` on, people the
// user works with are followed (research on, nudges off) without a question;
// a decline, a snooze or someone not worked with is left alone, and a pending
// follow_news card for an auto-followed person is withdrawn.
// Run: node --test tests/people-watch-auto-follow.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "people-watch-auto-"));
process.env.JORI_DATA_DIR = dir;
process.env.PEOPLE_WATCH_DB = path.join(dir, "pw.db");
process.env.PEOPLE_WATCH_ASKS = path.join(dir, "people-watch-asks.json");
process.env.JORI_LOCAL_DIR = path.join(dir, "local");
fs.mkdirSync(path.join(dir, "local", "config"), { recursive: true });
const cfgFile = path.join(dir, "local", "config", "people-watch.json");
fs.writeFileSync(cfgFile, JSON.stringify({ auto_follow_work: true }));

const pw = createRequire(import.meta.url)(path.resolve("lib/people-watch.js"));

after(() => {
  pw.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 10, 3);
const person = (wiki_id, extra = {}) => ({
  wiki_id, name: wiki_id, description: null, scope: ["people"], works_with: false,
  slipping: false, silence_days: 10, contact_days: 5, recent_contact_days: 3,
  state: pw.getPerson(wiki_id) || { status: "unasked", nudges: 0, research: 0 }, ...extra,
});

test("work people are followed without a question; decided and non-work people are not", () => {
  pw.decide("user_declined", { status: "declined", note: "no" , now: NOW - 1000 });
  const scanned = [
    person("user_work", { works_with: true }),
    person("user_declined", { works_with: true }),
    person("user_friend"),
  ];
  const plan = pw.propose({ now: NOW, scanned });
  const work = pw.getPerson("user_work");
  assert.equal(work.status, "tracking");
  assert.equal(work.research, 1);
  assert.equal(work.nudges, 0);
  assert.equal(pw.getPerson("user_declined").status, "declined", "a decline stands");
  assert.ok(plan.some((x) => x.kind === "auto_follow" && x.wiki_id === "user_work"));
  assert.ok(!plan.some((x) => x.kind === "follow_news"), "no follow_news card for an auto-followed person");
});

test("a follow_news card already open for a work person is withdrawn when they are auto-followed", () => {
  fs.writeFileSync(cfgFile, JSON.stringify({ auto_follow_work: false }));
  pw.propose({ now: NOW, scanned: [person("user_w2", { works_with: true })] });
  assert.ok(pw.openAsks().some((a) => a.wiki_id === "user_w2" && a.kind === "follow_news"), "asked while off");
  fs.writeFileSync(cfgFile, JSON.stringify({ auto_follow_work: true }));
  pw.propose({ now: NOW + 1000, scanned: [person("user_w2", { works_with: true })] });
  assert.equal(pw.getPerson("user_w2").research, 1);
  assert.ok(!pw.openAsks().some((a) => a.wiki_id === "user_w2"), "the card is withdrawn");
});

test("dry run reports who would be followed and changes nothing", () => {
  const plan = pw.propose({ now: NOW, scanned: [person("user_dry", { works_with: true })], dryRun: true });
  assert.ok(plan.some((x) => x.kind === "auto_follow" && x.wiki_id === "user_dry"));
  assert.equal(pw.getPerson("user_dry"), null);
});
