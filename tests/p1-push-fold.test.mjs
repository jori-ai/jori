// p1-push-fold.test.mjs — one push per P1 email, and per near-simultaneous
// same-sender thread burst (2026-10-21).
//
// One P1 email triaged twice — a watchdog RECLASSIFY and the delayed Gmail
// push — once produced two pings ten seconds apart, and several "new mail"
// notices minutes apart on one thread became several pushes.
//
// Fake Gmail lookups and a throwaway ledger; the jori-send-curl cases use a
// fake fold binary and a fake curl, so nothing reaches Gmail, Supabase or the
// phone.
//
// Run: node --test tests/p1-push-fold.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findPrior, decide, claim, release, readLedger, senderAddr } from "../lib/p1-push-fold.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEND_CURL = path.join(ROOT, "bin/jori-send-curl");

const MAILBOX = "no-reply@mailbox.example";
const T0 = Date.parse("2026-10-21T18:38:44Z");
const at = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "p1fold-"));
  return { d, ledger: path.join(d, "ledger.jsonl"), log: path.join(d, "log.jsonl"), offFile: path.join(d, ".off") };
}
// Fake Gmail: id → {threadId, sender, unread}; unknown ids throw like a 404.
const gmail = (msgs) => async (id) => { if (!msgs[id]) throw new Error("Gmail 404"); return msgs[id]; };
const deps = (env, msgs, nowMs) => ({ ...env, meta: gmail(msgs), now: () => nowMs });
const logOf = (env) => fs.readFileSync(env.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// ── pure rules ─────────────────────────────────────────────────────────────

test("senderAddr reads the address out of a From header", () => {
  assert.equal(senderAddr("Mailbox Center <No-Reply@Mailbox.Example>"), MAILBOX);
  assert.equal(senderAddr("closing@title.example"), "closing@title.example");
  assert.equal(senderAddr(""), "");
});

test("findPrior + decide: which earlier push a new one folds into", () => {
  const rows = [
    { messageId: "m1", threadId: "t1", sender: MAILBOX, sent_at: at(T0 - 5 * MIN) },
    { messageId: "x9", threadId: "t9", sender: "lawyer@firm.example", sent_at: at(T0 - 2 * MIN) },
  ];
  const f = (cur, unread = true) => { const p = findPrior(rows, cur, T0); return decide(p, p ? unread : null); };
  assert.equal(f({ messageId: "m1", threadId: "t1", sender: MAILBOX }).reason, "same-message");
  assert.equal(f({ messageId: "m1", threadId: null, sender: null }).action, "fold", "same message folds even without Gmail metadata");
  assert.equal(f({ messageId: "m2", threadId: "t1", sender: MAILBOX }).reason, "same-thread-unread");
  assert.equal(f({ messageId: "m2", threadId: "t1", sender: MAILBOX }, null).action, "fold", "unknown unread state of a just-claimed sibling folds");
  assert.deepEqual(f({ messageId: "m2", threadId: "t1", sender: MAILBOX }, false), { action: "send", reason: "earlier-email-already-read" });
  assert.deepEqual(f({ messageId: "m2", threadId: "t1", sender: MAILBOX }, "error"), { action: "send", reason: "unread-lookup-failed" }, "Gmail could not say → send");
  assert.equal(f({ messageId: "m2", threadId: "t1", sender: "other@x.example" }).action, "send", "another sender on the thread pushes");
  assert.equal(f({ messageId: "m2", threadId: "t2", sender: MAILBOX }).action, "send", "another thread from the same sender pushes");
  assert.equal(f({ messageId: "m2", threadId: "t1", sender: MAILBOX }).action, "fold");
  const later = findPrior(rows, { messageId: "m2", threadId: "t1", sender: MAILBOX }, T0 + 11 * MIN);
  assert.equal(later, null, "16 minutes after the push, a new thread email pushes again");
  assert.equal(findPrior(rows, { messageId: "m1" }, T0 + 25 * 60 * MIN), null, "the same message a day later is a new push");
});

// ── claim(): the ledger, the lock, the incidents ───────────────────────────

test("2026-10-21 replay: one email triaged twice → one push", async () => {
  const env = tmp();
  const msgs = { "msg-alpha": { threadId: "msg-alpha", sender: MAILBOX, unread: true } };
  const a = await claim("msg-alpha", deps(env, msgs, T0));
  const b = await claim("msg-alpha", deps(env, msgs, T0 + 10_000));
  assert.equal(a.action, "send");
  assert.equal(b.action, "fold");
  assert.equal(b.reason, "same-message");
  assert.equal(b.prior.sent_at, at(T0));
  assert.equal(readLedger(env.ledger).length, 1, "only the push that went out is recorded");
  assert.deepEqual(logOf(env).map((r) => r.action), ["send", "fold"]);
});

test("two triage turns racing on one email: exactly one push", async () => {
  const env = tmp();
  const msgs = { m1: { threadId: "t1", sender: MAILBOX, unread: true } };
  const slow = async (id) => { await new Promise((r) => setTimeout(r, 20)); return msgs[id]; };
  const rs = await Promise.all([1, 2, 3].map(() => claim("m1", { ...env, meta: slow, now: () => T0 })));
  assert.deepEqual(rs.map((r) => r.action).sort(), ["fold", "fold", "send"]);
});

test("2026-10-16 replay: three notices five minutes apart on one thread → one push", async () => {
  const env = tmp();
  const th = "msg-b1";
  const msgs = {
    "msg-b1": { threadId: th, sender: MAILBOX, unread: true },
    "msg-b2": { threadId: th, sender: MAILBOX, unread: true },
    "msg-b3": { threadId: th, sender: MAILBOX, unread: true },
  };
  const t = Date.parse("2026-10-16T19:51:31Z");
  const r1 = await claim("msg-b1", deps(env, msgs, t));
  const r2 = await claim("msg-b2", deps(env, msgs, t + 5 * MIN));
  const r3 = await claim("msg-b3", deps(env, msgs, t + 10 * MIN));
  assert.deepEqual([r1.action, r2.action, r3.action], ["send", "fold", "fold"]);
  assert.equal(r3.prior.messageId, "msg-b1", "the window runs from the push that went out");
});

test("once the user has opened the earlier email, a follow-up on the thread pushes again", async () => {
  const env = tmp();
  const msgs = { m1: { threadId: "t1", sender: "lawyer@firm.example", unread: false }, m2: { threadId: "t1", sender: "lawyer@firm.example", unread: true } };
  await claim("m1", deps(env, msgs, T0));
  const r = await claim("m2", deps(env, msgs, T0 + 3 * MIN));
  assert.equal(r.action, "send");
  assert.equal(r.reason, "earlier-email-already-read");
  assert.equal(readLedger(env.ledger).length, 2);
});

test("fails open: if Gmail can't say whether the earlier email was read, the follow-up sends", async () => {
  const env = tmp();
  const msgs = { m2: { threadId: "t1", sender: MAILBOX, unread: true } }; // m1's lookup will 404
  fs.writeFileSync(env.ledger, JSON.stringify({ messageId: "m1", threadId: "t1", sender: MAILBOX, sent_at: at(T0 - 2 * MIN) }) + "\n");
  const r = await claim("m2", deps(env, msgs, T0));
  assert.equal(r.action, "send");
  assert.equal(r.reason, "unread-lookup-failed");
});

test("fails open: a Gmail error on a new email sends, and still dedupes the same id", async () => {
  const env = tmp();
  const r1 = await claim("m-unknown", deps(env, {}, T0));
  assert.equal(r1.action, "send");
  const r2 = await claim("m-unknown", deps(env, {}, T0 + 1000));
  assert.equal(r2.action, "fold", "same message id needs no Gmail lookup");
  const r3 = await claim("m-other", deps(env, {}, T0 + 2000));
  assert.equal(r3.action, "send");
});

test("off switch: always send, nothing recorded", async () => {
  const env = tmp();
  fs.writeFileSync(env.offFile, "");
  const msgs = { m1: { threadId: "t1", sender: MAILBOX, unread: true } };
  assert.equal((await claim("m1", deps(env, msgs, T0))).action, "send");
  assert.equal((await claim("m1", deps(env, msgs, T0 + 1000))).reason, "off-switch");
  assert.equal(readLedger(env.ledger).length, 0);
});

test("release forgets a claim whose post failed, so the next try sends", async () => {
  const env = tmp();
  const msgs = { m1: { threadId: "t1", sender: MAILBOX, unread: true } };
  await claim("m1", deps(env, msgs, T0));
  assert.equal(release("m1", env), 1);
  assert.equal((await claim("m1", deps(env, msgs, T0 + 1000))).action, "send");
  assert.equal(release("nope", env), 0);
});

test("old rows are pruned when a new push is recorded", async () => {
  const env = tmp();
  fs.writeFileSync(env.ledger, JSON.stringify({ messageId: "old", threadId: "t0", sender: MAILBOX, sent_at: at(T0 - 3 * 24 * 60 * MIN) }) + "\n");
  await claim("m1", deps(env, { m1: { threadId: "t1", sender: MAILBOX, unread: true } }, T0));
  assert.deepEqual(readLedger(env.ledger).map((r) => r.messageId), ["m1"]);
});

// ── jori-send-curl wiring ───────────────────────────────────────────────

// A fake p1-push-fold: records each call, answers per FOLD_RC.
const FAKE_FOLD = `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.FOLD_RECORD, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "claim") {
  const rc = Number(process.env.FOLD_RC || 0);
  process.stdout.write(JSON.stringify({ action: rc === 3 ? "fold" : "send", reason: rc === 3 ? "same-message" : "no-earlier-push" }) + "\\n");
  process.exit(rc);
}
`;
// A fake curl: records that a post happened and answers FAKE_HTTP.
const FAKE_CURL = `#!/bin/sh
echo posted >> "$CURL_RECORD"
printf '%s' "\${FAKE_HTTP:-201}"
`;

function sendEnv() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "p1fold-send-"));
  fs.mkdirSync(path.join(h, "Dev/jori/data"), { recursive: true });
  fs.writeFileSync(path.join(h, "Dev/jori/.env"), "SUPABASE_SERVICE_ROLE_KEY=fake\n");
  const fakeBin = path.join(h, "fakebin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "curl"), FAKE_CURL);
  fs.chmodSync(path.join(fakeBin, "curl"), 0o755);
  const fold = path.join(h, "fake-fold");
  fs.writeFileSync(fold, FAKE_FOLD);
  return { h, fold, fakeBin, foldRecord: path.join(h, "fold.txt"), curlRecord: path.join(h, "curl.txt") };
}
// Inside a test run jori-send-curl posts only through a named stand-in
// (JORI_SEND_TEST_CURL), never the real curl.
function send(env, args, extraEnv = {}) {
  return spawnSync(SEND_CURL, args, {
    encoding: "utf8", timeout: 20_000,
    env: { ...process.env, PATH: `${env.fakeBin}:${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: env.h,
      JORI_SEND_TEST_CURL: path.join(env.fakeBin, "curl"),
      P1_PUSH_FOLD_BIN: env.fold, FOLD_RECORD: env.foldRecord, CURL_RECORD: env.curlRecord, ...extraEnv },
  });
}
const lines = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean); } catch { return []; } };

test("jori-send-curl: a folded P1 pointer exits 0 and posts nothing", () => {
  const env = sendEnv();
  const r = send(env, ["--intent", "p1-email", "--evidence-as-of", "2026-10-21T18:31:34Z", "--p1-message", "msg-alpha", "--no-push",
    "🚨 P1 Email: New Mail from the Mailbox Center"], { FOLD_RC: "3" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes("p1-push-fold: not sent"), r.stderr);
  assert.ok(!r.stdout.includes("Message sent"));
  assert.deepEqual(lines(env.foldRecord), ["claim --message msg-alpha"]);
  assert.deepEqual(lines(env.curlRecord), [], "nothing posted");
});

test("jori-send-curl: a claimed pointer posts; a failed post releases the claim", () => {
  const ok = sendEnv();
  const r = send(ok, ["--intent", "p1-email", "--p1-message", "m1", "--no-push", "🚨 P1 Email: X from Y"], { FOLD_RC: "0" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("Message sent to Jori"), r.stderr);
  assert.deepEqual(lines(ok.foldRecord), ["claim --message m1"]);

  const bad = sendEnv();
  send(bad, ["--intent", "p1-email", "--p1-message", "m1", "--no-push", "🚨 P1 Email: X from Y"], { FOLD_RC: "0", FAKE_HTTP: "500" });
  assert.deepEqual(lines(bad.foldRecord), ["claim --message m1", "release --message m1"]);
});

test("jori-send-curl: a broken fold binary fails open, and no --p1-message means no fold", () => {
  const env = sendEnv();
  const r = send(env, ["--p1-message", "m1", "--no-push", "🚨 P1 Email: X from Y"], { FOLD_RC: "1" });
  assert.ok(r.stdout.includes("Message sent to Jori"), r.stderr);
  assert.deepEqual(lines(env.foldRecord), ["claim --message m1"]);

  const plain = sendEnv();
  const r2 = send(plain, ["--intent", "p1-email", "--no-push", "🚨 P1 Email: X from Y"], { FOLD_RC: "3" });
  assert.ok(r2.stdout.includes("Message sent to Jori"), r2.stderr);
  assert.ok(r2.stderr.includes("without --p1-message"), r2.stderr);
  assert.deepEqual(lines(plain.foldRecord), [], "the gate is not consulted");

  const sys = sendEnv();
  send(sys, ["--channel", "system", "--skip-precheck", "--p1-message", "m1", "--no-push", "⚠️ something"], { FOLD_RC: "3" });
  assert.deepEqual(lines(sys.foldRecord), [], "chat channel only");
});
