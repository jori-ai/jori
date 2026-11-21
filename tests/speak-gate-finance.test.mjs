// Money claims at the speak gate (system/speak-gate.md § Money claims): a
// finance-lane message is judged with the owner's recorded income expectations and
// scheduled payments in front of the judge and the rewrite check; the judge reports
// the premise of a message that calls money late, and a proactive message whose
// premise is contradicted or unbacked is held (resolve / drop), never rewritten into
// a question. Made-up payer and amounts; the real replay case is
// speak-gate-finance-replay-local.test.mjs. The judge, the check's model and gog
// are stand-ins; the database is unreachable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { financeScope, financeRecords, applyPremiseRule, incomeLine, paymentLine, PREMISE_RULE, FINANCE_EVIDENCE_TITLE } from "../lib/speak-gate-finance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "sg-finance-"));
const FIX = {
  input: { message: "Sasha: the Acme retainer that is usually in by the 6th has not shown up. Is it still owed?", intent: "hum:finance:income-late", sender: "cfo", kind: "proactive", as_of: "2026-11-21T13:26:30Z" },
  finance_rows: {
    income: [
      { label: "Acme (monthly retainer)", payer_contains: "acme", amount: 1000, tolerance: 0, cadence: "monthly", due_day: 6, grace_days: 3, active_from: "2026-01-01", active_to: null,
        note: "Owner: billed at the end of each month, usually paid by the 6th." },
      { label: "Acme (second invoice)", payer_contains: "acme", amount: null, cadence: "monthly", due_day: null, grace_days: 3, active_from: "2026-01-01", active_to: null,
        note: "Owner: Acme can pay both invoices in ONE ACH; a single Acme credit larger than $1,000 is that combined payment, not an anomaly." },
    ],
    payments: [{ label: "Card autopay", kind: "card_payment", amount_rule: "current_balance", fixed_amount: null, due_day: 30, autopay: true, descriptor_contains: "CARD PMT", note: "Statement balance." }],
  },
};

const rowsFile = path.join(dir, "rows.json");
writeFileSync(rowsFile, JSON.stringify(FIX.finance_rows));
const gog = path.join(dir, "gog.sh");
writeFileSync(gog, "#!/bin/sh\necho '[]'\n");
chmodSync(gog, 0o755);
const sentLog = path.join(dir, "email-sent.jsonl");
writeFileSync(sentLog, "");

let n = 0;
function stub(out) {
  const id = `s${++n}`;
  const bin = path.join(dir, `${id}.sh`), seen = path.join(dir, `${id}.prompt`);
  const outFile = path.join(dir, `${id}.out`);
  writeFileSync(outFile, `${out}\n`); // a file, not a shell string: the answers hold dollar amounts
  writeFileSync(bin, `#!/bin/sh\ncat > ${JSON.stringify(seen)}\ncat ${JSON.stringify(outFile)}\n`);
  chmodSync(bin, 0o755);
  return { bin, prompt: () => readFileSync(seen, "utf8") };
}

function gate(input, judgeOut, checkOut = JSON.stringify({ added: [], contradicted: [] })) {
  const judge = stub(judgeOut), check = stub(checkOut);
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin", "speak-gate.mjs")], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 120000,
    env: { ...process.env, SPEAK_GATE_NO_LOG: "1", SPEAK_GATE_NO_LESSONS: "1", SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_ANON_KEY: "",
      SPEAK_GATE_CLAUDE_BIN: judge.bin, SPEAK_GATE_CHECK_BIN: check.bin, SPEAK_GATE_GOG_BIN: gog, OUTBOUND_PRECHECK_GOG_BIN: "/usr/bin/false",
      SPEAK_GATE_SENT_LOG: sentLog, SPEAK_GATE_FINANCE_ROWS: rowsFile },
  });
  return { out: JSON.parse(r.stdout.trim().split("\n").pop()), judge, check };
}

const OLD = { message: "Nothing from Acme has posted since the 2nd. Want me to draft a note asking when the retainer lands?", checks: { true: "no later Acme deposit found" }, sources: ["bank rows"], reason: "asked as a question" };
const judgeAnswer = (extra) => JSON.stringify({ verdict: "rewrite", message: OLD.message, checks: OLD.checks, sources: OLD.sources, reason: OLD.reason, ...extra });

test("the finance judge is shown the recorded expectations, notes and cadence, and the premise rule", () => {
  const { judge } = gate(FIX.input, judgeAnswer({ premise: "backed" }));
  const p = judge.prompt();
  assert.ok(p.includes(FINANCE_EVIDENCE_TITLE));
  assert.match(p, /Acme \(monthly retainer\).*\$1,000.*monthly, due day 6, 3 grace days.*billed at the end of each month, usually paid by the 6th/);
  assert.match(p, /pay both invoices in ONE ACH/);
  assert.match(p, /\[scheduled payment\] Card autopay/);
  assert.ok(p.includes(PREMISE_RULE));
  assert.match(p, /"premise":"n\/a\|backed\|unbacked\|contradicted"/);
});

test("a contradicted premise: the rewrite into a question is not delivered, it is resolved with the record's answer", () => {
  const { out, check } = gate(FIX.input, judgeAnswer({ premise: "contradicted", premise_note: "the note says one larger credit is both invoices; the $1,500 on the 2nd is it" }));
  assert.equal(out.verdict, "resolve");
  assert.equal(out.message, undefined);
  assert.match(out.research_plan, /\$1,500 on the 2nd/);
  assert.deepEqual(out.checks.premise, { premise: "contradicted", was: "rewrite" });
  assert.match(out.reason, /contradicted by a recorded expectation/);
  assert.throws(() => check.prompt(), "a held message is never sent on to the rewrite check");
});

test("an unbacked premise: dropped, never a softer question", () => {
  const { out } = gate(FIX.input, judgeAnswer({ premise: "unbacked", premise_note: "no record gives the 6th for this amount" }));
  assert.equal(out.verdict, "drop");
  assert.equal(out.message, undefined);
  assert.match(out.reason, /not backed by a recorded expectation/);
});

test("a premise the records back is left to the rest of the gate, and the rewrite check reads the records too", () => {
  const { out, check } = gate(FIX.input, judgeAnswer({ premise: "backed" }));
  assert.equal(out.verdict, "rewrite");
  assert.equal(out.rewrite_added_claim, false);
  assert.match(check.prompt(), /usually paid by the 6th/);
});

test("a message from outside the finance lane gets the rule but not the records, and an unbacked premise still holds it", () => {
  const input = { message: "The retainer is 15 days late.", intent: "hum:calendar:note", sender: "ops", kind: "proactive", as_of: FIX.input.as_of };
  const { out, judge } = gate(input, JSON.stringify({ verdict: "send", checks: {}, sources: [], reason: "ok", premise: "unbacked", premise_note: "no recorded expectation" }));
  const p = judge.prompt();
  assert.ok(p.includes(PREMISE_RULE));
  assert.ok(!p.includes(FINANCE_EVIDENCE_TITLE), "records are loaded for the finance lane only; the judge has finance-facts for the rest");
  assert.equal(out.verdict, "drop");
});

test("a reply is never held: the judge's fix stands", () => {
  const input = { ...FIX.input, kind: "reply", reply_to_text: "is the retainer late?" };
  const { out } = gate(input, judgeAnswer({ premise: "contradicted" }));
  assert.equal(out.verdict, "rewrite");
});

test("a message that is not about money is untouched by the premise rule", () => {
  const input = { message: "Your package arrives today.", intent: "hum:packages", sender: "ops", kind: "proactive", as_of: FIX.input.as_of };
  const { out } = gate(input, JSON.stringify({ verdict: "send", checks: {}, sources: [], reason: "ok", premise: "n/a" }));
  assert.equal(out.verdict, "send");
});

test("financeScope reads the intent and the sender, not the wording", () => {
  assert.equal(financeScope({ intent: "hum:finance:income-late" }), true);
  assert.equal(financeScope({ intent: "finance-review" }), true);
  assert.equal(financeScope({ intent: "fin-abc" }), true);
  assert.equal(financeScope({ sender: "cfo", intent: "x" }), true);
  assert.equal(financeScope({ intent: "hum:calendar", sender: "ops", message: "money is late" }), false);
});

test("financeRecords: every row with its note and cadence; a failed read is empty, not an error", async () => {
  const t = await financeRecords({ fetch: async () => FIX.finance_rows });
  assert.equal(t.split("\n").length, FIX.finance_rows.income.length + FIX.finance_rows.payments.length);
  assert.match(t, /^- \[expected income\]/);
  assert.equal(await financeRecords({ fetch: async () => { throw new Error("db down"); } }), "");
  assert.match(incomeLine({ label: "Rent", payer_contains: "acme", amount: 500, tolerance: 2.5, cadence: "monthly", due_day: 1, grace_days: 2, note: "n" }), /\$500 ±\$2\.5 · monthly, due day 1, 2 grace days · note: n/);
  assert.match(incomeLine({ label: "Varies", amount: null }), /amount varies/);
  assert.match(paymentLine({ label: "Card", kind: "card_payment", amount_rule: "current_balance", fixed_amount: null, autopay: true, due_day: 30 }), /card_payment · current_balance · due day 30 · autopay/);
});

test("applyPremiseRule: only a proactive send or rewrite with a bad premise is changed", () => {
  const base = { verdict: "rewrite", message: "m", reason: "r", checks: { true: "x" } };
  assert.equal(applyPremiseRule({ kind: "proactive" }, { ...base, premise: "n/a" }).verdict, "rewrite");
  assert.equal(applyPremiseRule({ kind: "proactive" }, { ...base, premise: "backed" }).verdict, "rewrite");
  assert.equal(applyPremiseRule({ kind: "proactive" }, { ...base, premise: "unbacked" }).verdict, "drop");
  assert.equal(applyPremiseRule({ kind: "proactive" }, { ...base, verdict: "send", premise: "contradicted", premise_note: "a" }).verdict, "resolve");
  assert.equal(applyPremiseRule({ kind: "proactive" }, { ...base, verdict: "digest", premise: "unbacked" }).verdict, "drop", "a digest would print the alarm in the daily summary");
  assert.equal(applyPremiseRule({ kind: "proactive" }, { ...base, verdict: "resolve", premise: "unbacked" }).verdict, "resolve");
  assert.equal(applyPremiseRule({ kind: "report" }, { ...base, premise: "unbacked" }).verdict, "rewrite");
  assert.equal(applyPremiseRule({ kind: "proactive" }, { verdict: "send" }).verdict, "send");
});
