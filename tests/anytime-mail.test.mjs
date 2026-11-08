// anytime-mail.test.mjs — the envelope judge (lib/anytime-mail-jev.mjs)
// and the chat line (bin/anytime-mail-check composeMessage), on OCR text
// shaped like real envelope scans (synthetic names and addresses).
// Run: node --test tests/anytime-mail.test.mjs

// A made-up installation with no anytime-mail config: the job is off.
import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildQuestions, interpretAnswers, judgeEnvelope, acceptLook, lookPrompt, readSenderFromImage } from "../lib/anytime-mail-jev.mjs";
import { composeMessage, loadConfig, DEFAULTS } from "../bin/anytime-mail-check";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "anytime-mail-check");
const OPTS = { label: "the city mailbox", base: "https://portal.example" };

const POLITICAL = ["Paid political advertisement paid for", "by Vote Yes On 3", "123 Example Avenue", "Springfield, ST 00000", "THE SAMPIE HOUSEHOLD", "100 MAIN ST BOX 7", "PRSRT STD"];
const DEF = {
  sender_min_confidence: 0.7,
  sender_question: { instructions: "which line", line_criterion: "line {{n}} (\"{{text}}\") is the sender's name", none_criterion: "none" },
};

test("the sender question offers every OCR line plus none", () => {
  const q = buildQuestions(POLITICAL, DEF, {});
  assert.equal(q.sender.type, "choice");
  assert.equal(Object.keys(q.sender.criteria).length, POLITICAL.length + 1);
  assert.equal(q.sender.criteria.line_1, "line 1 (\"by Vote Yes On 3\") is the sender's name");
});

test("a confident line pick names the sender; a weak one does not", () => {
  const ans = (pick, p) => ({
    verdict: { type: "choice", choice: "junk", probabilities: { junk: 0.99, important: 0.01 } },
    recipient: { type: "choice", choice: "household", probabilities: { household: 0.97 } },
    sender: { type: "choice", choice: pick, probabilities: { [pick]: p } },
  });
  const strong = interpretAnswers(ans("line_1", 0.99), POLITICAL, 0.7);
  assert.deepEqual(strong.value, { verdict: "junk", recipient: "household", sender: "by Vote Yes On 3" });
  assert.equal(strong.confidence, 0.99);
  // Postage noise was picked at 0.65 on a real envelope.
  assert.equal(interpretAnswers(ans("line_6", 0.65), POLITICAL, 0.7).value.sender, null);
  assert.equal(interpretAnswers(ans("none", 0.9), POLITICAL, 0.7).value.sender, null);
});

test("on fallback, Jev's sender survives when legacy cannot name one", async () => {
  const r = await judgeEnvelope({
    id: 1, lines: POLITICAL, mailbox: {},
    decideImpl: async () => ({ used: "legacy", value: { verdict: "junk", recipient: "household", sender: null }, jev: { value: { sender: "by Vote Yes On 3" }, confidence: 0.6 } }),
  });
  assert.equal(r.sender, "by Vote Yes On 3");
  assert.equal(r.source, "legacy");
});

test("no OCR text is unclear, without asking anyone", async () => {
  const r = await judgeEnvelope({ id: 2, lines: [], mailbox: {}, decideImpl: () => { throw new Error("must not be called"); } });
  assert.equal(r.verdict, "unclear");
});

test("the chat line puts what matters first and says who it came from", () => {
  const msg = composeMessage([
    { verdict: "junk", sender: "by Vote Yes On 3", recipient: "household" },
    { verdict: "important", sender: "FIRST BANK", recipient: "owner" },
    { verdict: "junk", sender: null, recipient: "someone_else" },
  ], OPTS);
  const lines = msg.split("\n");
  assert.equal(lines[0], "📬 3 pieces of mail came in at the city mailbox — 1 worth opening, 2 junk");
  assert.equal(lines[1], "- FIRST BANK — looks important");
  assert.equal(lines[2], "- by Vote Yes On 3 — junk (to household)");
  assert.equal(lines[3], "- Sender unidentified — junk (not addressed to you)");
  assert.equal(lines[4], "https://portal.example/app/mailbox/inbox");
});

test("a single junk piece reads naturally", () => {
  assert.ok(composeMessage([{ verdict: "junk", sender: "CARD CO", recipient: "owner" }], OPTS).startsWith("📬 One piece of mail came in at the city mailbox — it's junk\n- CARD CO — junk"));
});

test("unconfigured: generic label, no portal link, and the run is off", () => {
  assert.deepEqual(loadConfig(), { ...DEFAULTS });
  const msg = composeMessage([{ verdict: "junk", sender: "CARD CO", recipient: "owner" }]);
  assert.ok(msg.startsWith(`📬 One piece of mail came in at ${DEFAULTS.label} — it's junk`), msg);
  assert.ok(!msg.includes("http"), "no portal link without a base_url");
  const r = spawnSync(process.execPath, [BIN, "--dry-run", "--now"], { encoding: "utf8", timeout: 20000,
    env: { ...process.env, JORI_LOCAL_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "anytime-off-")) } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no portal configured/);
});

// ---- reading the sender off the envelope image ----------------------------

test("an envelope look is accepted only when it names a sender confidently", () => {
  assert.equal(acceptLook({ sender: "FIRST BANK", confidence: 0.9 }), "FIRST BANK");
  assert.equal(acceptLook({ sender: " FIRST BANK ", confidence: 0.7 }), "FIRST BANK");
  assert.equal(acceptLook({ sender: "FIRST BANK", confidence: 0.5 }), null);
  assert.equal(acceptLook({ sender: null, confidence: 0.99 }), null);
  assert.equal(acceptLook({ sender: "", confidence: 0.99 }), null);
  assert.equal(acceptLook({ sender: "FIRST BANK" }), null);
  assert.equal(acceptLook(null), null);
});

test("the look prompt names the image and tells the model the owners are the recipient", () => {
  const p = lookPrompt("/tmp/x/1.jpg", { owners: ["Sam Pie"] });
  assert.ok(p.includes("/tmp/x/1.jpg"));
  assert.ok(p.includes("Sam Pie"));
  assert.ok(p.includes("untrusted"));
});

test("readSenderFromImage: the model sees a temp copy in its own cwd, and the copy is removed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-test-"));
  const scan = path.join(dir, "42.jpg");
  fs.writeFileSync(scan, "jpeg-bytes");
  let seen;
  const r = await readSenderFromImage({
    file: scan, mailbox: { owners: ["Sam Pie"] }, tmpRoot: dir,
    run: async ({ prompt, cwd }) => {
      const copy = path.join(cwd, "42.jpg");
      seen = { cwd, hasCopy: fs.existsSync(copy), inPrompt: prompt.includes(copy) };
      return 'Looked. {"sender":"FIRST BANK","return_address":"PO Box 1, Springfield","confidence":0.95}';
    },
  });
  assert.deepEqual(r, { sender: "FIRST BANK", return_address: "PO Box 1, Springfield" });
  assert.ok(seen.hasCopy && seen.inPrompt);
  assert.equal(fs.existsSync(seen.cwd), false);
  assert.ok(fs.existsSync(scan), "the original scan stays");
});

test("readSenderFromImage: no file, no answer, a weak answer or a crash all leave it unidentified", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-test-"));
  const scan = path.join(dir, "7.jpg");
  fs.writeFileSync(scan, "x");
  assert.equal(await readSenderFromImage({ file: path.join(dir, "missing.jpg"), run: async () => { throw new Error("must not run"); } }), null);
  assert.equal(await readSenderFromImage({ file: scan, tmpRoot: dir, run: async () => "" }), null);
  assert.equal(await readSenderFromImage({ file: scan, tmpRoot: dir, run: async () => '{"sender":"X","confidence":0.3}' }), null);
  assert.equal(await readSenderFromImage({ file: scan, tmpRoot: dir, run: async () => { throw new Error("boom"); } }), null);
});
