// coherence-check.test.mjs — the "does every stated reason follow?" check.
//
//   lib/coherence-check.mjs  validation, the action table, the ladder, fail-open,
//                            privacy, the log, the split queue
//   bin/coherence-check      CLI contract (always exits 0, fail-open output)
//   bin/jori-send-curl       runs it before the speak gate for chat-bound
//                            proactive messages, only in scope, sends the kept text
//   bin/hum-ping             runs it before routing, tells jori-send-curl it did,
//                            records it on the feedback row, retires a split part
//
// A stand-in judge, a stand-in CLI and fake senders only; throwaway data dirs,
// so no model is called and nothing reaches Supabase, the phone or real data.
//
// Run: node --test tests/coherence-check.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { underTestRunner } = require("../lib/load-env.js");
const { KERNEL_SUBDIR } = require("../lib/root.cjs");

function freshData() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "coherence-"));
  process.env.JORI_DATA_DIR = d;
  return d;
}
const cc = await import("../lib/coherence-check.mjs");

const FUSED = "The airport pickup is about 50 minutes out. The garden hose is due today too, so a quick look at the porch before you leave would save a trip back.";
const KEPT = "The airport pickup is about 50 minutes out.";
const DETACHED = "The garden hose is due to arrive today.";
const failing = [{ words: "so a quick look … would save a trip back", follows: false, why: "it waits at home either way" }];
const verdict = (o) => ({ subjects: [], links: [], decision: "keep", kept_text: null, detached_text: null, reason: "r", ...o });
const judgeOf = (...answers) => {
  const calls = [];
  const fn = async (arg) => {
    calls.push(arg);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
  fn.calls = calls;
  return fn;
};
const TWO_TIERS = [{ name: "a", model: "m-a" }, { name: "b", model: "m-b" }];

// ── validation ─────────────────────────────────────────────────────────────

test("validate: a keep needs no failing link; a change needs one, a shorter kept text, and for split a detached text", () => {
  assert.equal(cc.validate(verdict({}), FUSED), null);
  assert.match(cc.validate(verdict({ links: failing }), FUSED), /keep, but a link is marked as failing/);
  assert.match(cc.validate(verdict({ decision: "trim", kept_text: KEPT }), FUSED), /no link marked as failing/);
  assert.match(cc.validate(verdict({ decision: "trim", links: failing, kept_text: "" }), FUSED), /no kept text/);
  assert.match(cc.validate(verdict({ decision: "trim", links: failing, kept_text: FUSED }), FUSED), /is the original/);
  assert.match(cc.validate(verdict({ decision: "trim", links: failing, kept_text: FUSED + " More." }), FUSED), /not shorter/);
  assert.match(cc.validate(verdict({ decision: "split", links: failing, kept_text: KEPT }), FUSED), /no detached text/);
  assert.match(cc.validate(verdict({ decision: "maybe" }), FUSED), /bad decision/);
  assert.equal(cc.validate(verdict({ decision: "split", links: failing, kept_text: KEPT, detached_text: DETACHED }), FUSED), null);
});

test("the prompt carries the message and its tappable answers; the system text never names a kind of item", () => {
  const p = cc.buildPrompt({ message: FUSED, choices: { options: [{ label: "Yes" }, { label: "No" }] } });
  assert.ok(p.includes(FUSED));
  assert.ok(p.includes('["Yes","No"]'));
  assert.ok(!cc.buildPrompt({ message: "x" }).includes("TAPPABLE"));
  for (const word of ["parcel", "package", "grill", "mailbox", "airport"]) {
    assert.ok(!cc.SYSTEM.toLowerCase().includes(word), `the judgment is general, not about ${word}s`);
  }
});

// ── the action table ───────────────────────────────────────────────────────

test("keep: the message goes out exactly as written, and the decision is logged", async () => {
  freshData();
  const r = await cc.coherenceCheck({ message: FUSED, intent: "hum:situation:pickup", source: "t" }, { judgeFn: judgeOf(verdict({})), tiers: TWO_TIERS });
  assert.equal(r.decision, "keep");
  assert.equal(r.text, FUSED);
  const [row] = cc.readLog();
  assert.equal(row.decision, "keep");
  assert.equal(row.lane, "situation");
  assert.equal(row.original, FUSED);
});

test("trim: the kept text is what is sent; nothing is queued", async () => {
  freshData();
  const r = await cc.coherenceCheck({ message: FUSED, intent: "hum:situation:pickup" },
    { judgeFn: judgeOf(verdict({ decision: "trim", links: failing, kept_text: `  ${KEPT}  ` })), tiers: TWO_TIERS });
  assert.equal(r.decision, "trim");
  assert.equal(r.text, KEPT);
  assert.equal(cc.readSplitQueue().length, 0);
  assert.equal(cc.readLog()[0].kept, KEPT);
});

test("split: the kept text is sent and the part waits as one hum candidate until the day ends", async () => {
  freshData();
  const r = await cc.coherenceCheck({ message: FUSED, intent: "hum:situation:pickup", ping_id: "p-1", source: "hum-ping" },
    { judgeFn: judgeOf(verdict({ decision: "split", links: failing, kept_text: KEPT, detached_text: DETACHED })), tiers: TWO_TIERS });
  assert.equal(r.decision, "split");
  assert.equal(r.text, KEPT);
  assert.ok(r.split_id);
  const [c] = cc.splitCandidates();
  assert.equal(c.topic, "split");
  assert.equal(c.signal, DETACHED);
  assert.equal(c.dedup_key, `split:${r.split_id}`);
  assert.equal(cc.splitIdFromKey(c.dedup_key), r.split_id);
  assert.equal(c.supporting_data.split_from.ping_id, "p-1");
  assert.ok(Date.parse(c.evidence_as_of) <= Date.now(), "dated by when it was split off, never `live`");
  assert.ok(Date.parse(c.temporal_fit.expires_after_iso) > Date.now());
  assert.equal(cc.readLog()[0].detached, DETACHED);
  // lapses at the end of its day
  assert.equal(cc.pendingSplits(Date.parse(c.temporal_fit.expires_after_iso) + 1).length, 0);
  // one chance: consumed once, then gone; a second consume is a no-op
  assert.equal(cc.consumeSplit(r.split_id, { ping_id: "p-2" }), true);
  assert.equal(cc.consumeSplit(r.split_id, { ping_id: "p-3" }), false);
  assert.equal(cc.splitCandidates().length, 0);
  assert.equal(cc.readSplitQueue()[0].ping_id, "p-2");
});

test("the ladder climbs only when a rung's answer fails validation or the call fails", async () => {
  freshData();
  const judge = judgeOf(verdict({ links: failing }), verdict({ decision: "trim", links: failing, kept_text: KEPT }));
  const r = await cc.coherenceCheck({ message: FUSED }, { judgeFn: judge, tiers: TWO_TIERS });
  assert.equal(r.decision, "trim");
  assert.equal(judge.calls.length, 2);
  assert.equal(judge.calls[1].tier.name, "b");
  assert.equal(cc.readLog()[0].attempts, 2);
  assert.equal(r.model, "m-b");
});

test("fail-open, never fail-true: no valid answer anywhere sends the message as written", async () => {
  freshData();
  const r = await cc.coherenceCheck({ message: FUSED }, { judgeFn: judgeOf(new Error("timeout"), verdict({ decision: "trim", links: [] })), tiers: TWO_TIERS });
  assert.equal(r.decision, "error");
  assert.equal(r.text, FUSED);
  assert.match(cc.readLog()[0].reason, /a: timeout \| b: trim with no link/);
});

test("a fatal error (not logged in, usage limit) stops the ladder at once", async () => {
  freshData();
  const judge = judgeOf(Object.assign(new Error("Not logged in"), { fatal: true }), verdict({}));
  const r = await cc.coherenceCheck({ message: FUSED }, { judgeFn: judge, tiers: TWO_TIERS });
  assert.equal(r.decision, "error");
  assert.equal(r.text, FUSED);
  assert.equal(judge.calls.length, 1);
});

test("private lanes are never judged, and their text is never logged", async () => {
  for (const intent of ["hum:finance:late", "hum:stocks:move", "hum:health:hr", "hum:exercise:pre-slot"]) {
    freshData();
    const judge = judgeOf(verdict({}));
    const r = await cc.coherenceCheck({ message: "Balance is low, so move the call." , intent }, { judgeFn: judge, tiers: TWO_TIERS });
    assert.equal(r.decision, "skip", intent);
    assert.equal(judge.calls.length, 0, intent);
    const [row] = cc.readLog();
    assert.equal(row.reason, "private");
    assert.equal(row.original, undefined, `${intent}: no text in the log`);
  }
});

test("a private lane named only by the intent (the --lane is a default) is still skipped", async () => {
  freshData();
  const judge = judgeOf(verdict({}));
  const r = await cc.coherenceCheck({ message: "Spend is up, so move the call.", intent: "hum:finance:spend", lane: "unknown" }, { judgeFn: judge, tiers: TWO_TIERS });
  assert.equal(r.decision, "skip");
  assert.equal(judge.calls.length, 0);
  assert.equal(cc.readLog()[0].original, undefined);
});

test("a message marked as a question is judged with that said (its question is always kept)", async () => {
  freshData();
  const judge = judgeOf(verdict({}));
  await cc.coherenceCheck({ message: "Want me to book it?", question: true }, { judgeFn: judge, tiers: TWO_TIERS });
  assert.match(judge.calls[0].prompt, /ASKS THE PERSON SOMETHING/);
  assert.match(cc.SYSTEM, /question, that question is its main subject and is always kept/);
  await cc.coherenceCheck({ message: "It lands at noon." }, { judgeFn: judge, tiers: TWO_TIERS });
  assert.doesNotMatch(judge.calls[1].prompt, /ASKS THE PERSON SOMETHING/);
});

test("the newest waiting part is offered first, so a declined one never blocks a fresher one", () => {
  freshData();
  const now = Date.now();
  cc.enqueueSplit({ text: "older part", nowMs: now - 60_000 });
  cc.enqueueSplit({ text: "newer part", nowMs: now });
  assert.equal(cc.splitCandidates({ nowMs: now })[0].signal, "newer part");
  assert.equal(cc.splitCandidates({ nowMs: now, max: 2 }).length, 2);
});

test("the off switch skips the check; an empty message is skipped", async () => {
  const d = freshData();
  fs.writeFileSync(path.join(d, ".coherence-check-off"), "");
  const judge = judgeOf(verdict({}));
  assert.equal((await cc.coherenceCheck({ message: FUSED }, { judgeFn: judge })).decision, "skip");
  fs.unlinkSync(path.join(d, ".coherence-check-off"));
  assert.equal((await cc.coherenceCheck({ message: "  " }, { judgeFn: judge })).decision, "skip");
  assert.equal(judge.calls.length, 0);
});

test("stats counts decisions by source and what became of split-off parts", async () => {
  freshData();
  await cc.coherenceCheck({ message: FUSED, source: "hum-ping" }, { judgeFn: judgeOf(verdict({})), tiers: TWO_TIERS });
  await cc.coherenceCheck({ message: FUSED, source: "jori-send-curl" },
    { judgeFn: judgeOf(verdict({ decision: "split", links: failing, kept_text: KEPT, detached_text: DETACHED })), tiers: TWO_TIERS });
  const s = cc.stats();
  assert.equal(s.total, 2);
  assert.deepEqual(s.decisions, { keep: 1, split: 1 });
  assert.equal(s.by_source["jori-send-curl"].split, 1);
  assert.equal(s.splits.queued, 1);
  assert.equal(s.splits.waiting, 1);
});

// ── the CLI ────────────────────────────────────────────────────────────────

test("coherence-check CLI: unreadable input and the off switch both answer keep, exit 0", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "coherence-cli-"));
  const bin = path.join(ROOT, "bin/coherence-check");
  const run = (input) => spawnSync(process.execPath, [bin, "check"], { input, encoding: "utf8", env: { ...process.env, JORI_DATA_DIR: d } });
  let r = run("not json");
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).action, "keep");
  fs.writeFileSync(path.join(d, ".coherence-check-off"), "");
  r = run(JSON.stringify({ message: FUSED }));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.action, "skip");
  assert.equal(out.text, FUSED);
});

// ── jori-send-curl ─────────────────────────────────────────────────────────

const needsRunner = { skip: !underTestRunner() && "run under node --test with its default process isolation (NODE_TEST_CONTEXT is unset)" };

// A stand-in check: records what it was given, answers per FAKE_CC.
const FAKE_CC = `#!${process.execPath}
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.CC_RECORD, input + "\\n");
const m = JSON.parse(input).message;
const mode = process.env.FAKE_CC || "keep";
const kept = m.split(". ")[0] + ".";
process.stdout.write(JSON.stringify(mode === "keep" ? { action: "keep", text: m } : { action: mode, text: kept, decision_id: "cc-t", split_id: mode === "split" ? "sp-t" : undefined }) + "\\n");
`;

function sendBox() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "coherence-send-"));
  fs.mkdirSync(path.join(h, KERNEL_SUBDIR, "data"), { recursive: true });
  fs.writeFileSync(path.join(h, KERNEL_SUBDIR, ".env"), "SUPABASE_SERVICE_ROLE_KEY=fake\n");
  const fakeBin = path.join(h, "fakebin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "curl"), `#!/bin/sh\necho "$@" >> "$CURL_RECORD"\nprintf '%s' 201\n`);
  fs.chmodSync(path.join(fakeBin, "curl"), 0o755);
  const ccBin = path.join(fakeBin, "coherence-check");
  fs.writeFileSync(ccBin, FAKE_CC);
  fs.chmodSync(ccBin, 0o755);
  const record = path.join(h, "curl.txt");
  const ccRecord = path.join(h, "cc.jsonl");
  const run = (args, mode = "trim") => spawnSync(path.join(ROOT, "bin/jori-send-curl"), args, {
    encoding: "utf8", timeout: 20_000,
    env: { ...process.env, HOME: h, JORI_HOME: h, PATH: `${fakeBin}:${process.env.PATH}`, CURL_RECORD: record, CC_RECORD: ccRecord,
      JORI_SEND_TEST_CURL: path.join(fakeBin, "curl"), JORI_COHERENCE_CHECK_BIN: ccBin, FAKE_CC: mode,
      JORI_QUESTION_ROUTE_BIN: path.join(fakeBin, "none"), JORI_PRECHECK_BYPASS: "1", SUPABASE_SERVICE_ROLE_KEY: "fake" },
  });
  const posted = () => { try { return fs.readFileSync(record, "utf8"); } catch { return ""; } };
  const judged = () => { try { return fs.readFileSync(ccRecord, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { run, posted, judged };
}

const TWO = "First thing is coming up at noon. Second thing is due too, so look at it before you go.";

test("jori-send-curl: a proactive chat message is judged and the kept text is what is posted", needsRunner, () => {
  const box = sendBox();
  const r = box.run(["--intent", "some-job", "--no-push", TWO]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /coherence-check: trim/);
  const posted = box.posted();
  assert.ok(posted.includes("First thing is coming up at noon."), posted);
  assert.ok(!posted.includes("Second thing"), "the stapled-on part is not posted");
  const [seen] = box.judged();
  assert.equal(seen.message, TWO);
  assert.equal(seen.intent, "some-job");
  assert.equal(seen.source, "jori-send-curl");
});

test("jori-send-curl: a hum question with --skip-precheck is still judged (it reached resolve-first), marked as a question", needsRunner, () => {
  const box = sendBox();
  box.run(["--skip-precheck", "--intent", "hum:ideas:question", "--no-push", TWO], "keep");
  const [seen] = box.judged();
  assert.ok(seen, "judged");
  assert.equal(seen.question, true);
  assert.ok(box.posted().includes("Second thing"), "keep posts the message unchanged");
});

test("jori-send-curl: an info message is judged as one (question: false)", needsRunner, () => {
  const box = sendBox();
  box.run(["--intent", "some-job", "--no-push", TWO], "keep");
  assert.equal(box.judged()[0].question, false);
});

test("jori-send-curl: out of scope → never judged", needsRunner, () => {
  const cases = [
    ["--coherence-checked", "--intent", "hum:situation:x"],   // hum-ping already judged it
    ["--agent", "chat", "--intent", "some-reply"],             // the chat agent's own reply
    ["--intent", "mention-reply"],                              // an answer the user asked for, from any agent
    ["--intent", "chat-build-result"],                          // a build report the user asked for
    ["--intent", "chat-build-question"],
    ["--conversation", "role:cfo", "--intent", "some-job"],    // a job answering a request where it was asked
    ["--skip-precheck", "--intent", "p1-email"],               // reaches neither resolve-first nor precheck
    ["--intent", "hum:finance:income-late"],                    // private hum lane
    ["--intent", "health-weekly"],                              // private data intent
    ["--channel", "system", "--skip-precheck", "--intent", "watchdog-alert"],
  ];
  for (const flags of cases) {
    const box = sendBox();
    const r = box.run([...flags, "--no-push", TWO]);
    assert.equal(box.judged().length, 0, `${flags.join(" ")}: ${r.stderr}`);
  }
});

// ── hum-ping ───────────────────────────────────────────────────────────────

const FAKE_SENDER = `#!${process.execPath}
const fs = require("node:fs");
const a = process.argv.slice(2);
const cap = a[a.indexOf("--capture-id") + 1];
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv: a }));
if (cap) fs.writeFileSync(cap, "msg-888\\n");
process.stdout.write("Message sent.\\n");
`;

function pingBox() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "coherence-ping-"));
  const bin = path.join(h, "Dev/jori/bin");
  const data = path.join(h, "Dev/jori/data");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(h, "Dev/jori/.env"), "SUPABASE_SERVICE_ROLE_KEY=fake\n");
  fs.writeFileSync(path.join(bin, "jori-send-curl"), FAKE_SENDER);
  fs.chmodSync(path.join(bin, "jori-send-curl"), 0o755);
  const ccBin = path.join(h, "fake-cc");
  fs.writeFileSync(ccBin, FAKE_CC);
  fs.chmodSync(ccBin, 0o755);
  const record = path.join(h, "record.json");
  const ccRecord = path.join(h, "cc.jsonl");
  const run = ({ mode = "trim", lane = "situation", key = "situation:NEXT:x", message = TWO } = {}) => spawnSync(process.execPath, [path.join(ROOT, "bin/hum-ping"),
    "--ping-id", "p-cc-1", "--lane", lane, "--score", "0.6",
    "--findings", JSON.stringify([{ topic: lane, dedup_key: key, signal: message }]),
    "--suppress-hook", "--message", message], {
    encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: h, JORI_HOME: "", JORI_DATA_DIR: "",
      FAKE_RECORD: record, CC_RECORD: ccRecord, JORI_COHERENCE_CHECK_BIN: ccBin, FAKE_CC: mode,
      JORI_PING_ROUTE_BIN: path.join(h, "no-router"), HUM_NOVELTY_THRESHOLD: "2" },
  });
  const sent = () => JSON.parse(fs.readFileSync(record, "utf8")).argv;
  const feedback = () => { try { return fs.readFileSync(path.join(data, "hum-feedback.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const judged = () => { try { return fs.readFileSync(ccRecord, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { h, data, run, sent, feedback, judged };
}

test("hum-ping: judged before routing; the kept text is sent with --coherence-checked; the row records it", () => {
  const box = pingBox();
  const r = box.run({ mode: "split" });
  assert.equal(r.status, 0, r.stderr);
  const argv = box.sent();
  assert.equal(argv[argv.length - 1], "First thing is coming up at noon.");
  assert.ok(argv.includes("--coherence-checked"));
  const [seen] = box.judged();
  assert.equal(seen.source, "hum-ping");
  assert.equal(seen.ping_id, "p-cc-1");
  assert.equal(seen.intent, "hum:situation");
  const [row] = box.feedback();
  assert.deepEqual(row.coherence, { decision_id: "cc-t", action: "split", split_id: "sp-t" });
});

test("hum-ping: a keep sends the text unchanged and leaves no coherence field", () => {
  const box = pingBox();
  const r = box.run({ mode: "keep" });
  assert.equal(r.status, 0, r.stderr);
  const argv = box.sent();
  assert.equal(argv[argv.length - 1], TWO);
  assert.ok(argv.includes("--coherence-checked"), "judged here, so not judged again downstream");
  assert.equal(box.feedback()[0].coherence, undefined);
});

test("hum-ping: a split-off part that has been through the send leaves the queue", () => {
  const box = pingBox();
  process.env.JORI_DATA_DIR = box.data;
  const id = cc.enqueueSplit({ text: "Second thing is due today.", from: { ping_id: "p-0" } });
  assert.equal(cc.pendingSplits().length, 1);
  const r = box.run({ mode: "keep", lane: "split", key: `split:${id}`, message: "Second thing is due today." });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(cc.pendingSplits().length, 0);
  assert.equal(cc.readSplitQueue()[0].ping_id, "p-cc-1");
});
