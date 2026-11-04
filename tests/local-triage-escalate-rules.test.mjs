// local-triage-escalate-rules.test.mjs — a never-auto-handle rule in the local
// triage rules file (lib/local-triage.mjs) wins before any sender-history
// consensus, so mail whose triage has a side effect (a booking confirmation
// that must become a calendar event) always reaches the agent.
//
// The intake settles a message locally ONLY when the verdict is escalate:false,
// priority P3 and a label. The rules here are synthetic (LOCAL_TRIAGE_RULES_FILE),
// the senders invented; no email-mem or model call is made.
//
// Run: node --test tests/local-triage-escalate-rules.test.mjs

import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "local-triage-rules-"));
const RULES = { rules: [
  { id: "booking-platform", from: "[@.]tablebook\\.example|[@.]seatnow\\.example", label: "personal", priority: "P2", escalate: true, reason: "booking: creates a calendar event — never auto-handle" },
  { id: "urgent-subject", subject: "account locked", label: "personal", priority: "P1", reason: "P1 escalates by default" },
  { id: "store-receipts", from: "@shop\\.example", subject_not: "refund", label: "receipts", priority: "P3", escalate: false, reason: "routine receipt" },
] };
process.env.LOCAL_TRIAGE_RULES_FILE = path.join(TMP, "rules.json");
fs.writeFileSync(process.env.LOCAL_TRIAGE_RULES_FILE, JSON.stringify(RULES));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));

const { applyRules, classifyEmail, loadRules } = await import("../lib/local-triage.mjs");
loadRules();

const settledLocally = (v) => v.escalate === false && v.priority === "P3" && !!v.label;

const BOOKINGS = [
  { from: "TableBook Reservations <noreply@tablebook.example>", subject: "Your reservation at Harbor Noodle is confirmed" },
  { from: "TableBook <noreply@tablebook.example>", subject: "Your reservation at Corner Bistro has been canceled" },
  { from: "SeatNow <reservations@mail.seatnow.example>", subject: "Reservation confirmed" },
];

for (const m of BOOKINGS) {
  test(`escalates, never auto-handles: ${m.subject}`, () => {
    const v = applyRules({ from: m.from, subject: m.subject, body: "" });
    assert.equal(v?.source, "rule:booking-platform");
    assert.equal(v.escalate, true);
  });
}

test("look-alike senders are not pulled in by the narrow rule", () => {
  for (const from of ["Promo <deals@nottablebook.example>", "Promo <hello@myseatnow.example.org>", "Tickets <news@tickets.example>"]) {
    const v = applyRules({ from, subject: "Don't miss this great show", body: "" });
    assert.ok(!v || v.source !== "rule:booking-platform", `${from} matched ${v && v.source}`);
  }
});

test("through the full pipeline a booking verdict is one the intake will not settle", async () => {
  for (const m of BOOKINGS) {
    const v = await classifyEmail({ from: m.from, subject: m.subject, body: "" }, { noMem: true });
    assert.equal(settledLocally(v), false, m.subject);
  }
});

test("escalate defaults from priority; subject_not carves a shape out of a P3 rule", () => {
  assert.equal(applyRules({ from: "it@example.com", subject: "Your account locked", body: "" }).escalate, true);
  const receipt = applyRules({ from: "orders@shop.example", subject: "Your receipt", body: "" });
  assert.equal(receipt.source, "rule:store-receipts");
  assert.equal(settledLocally(receipt), true);
  assert.equal(applyRules({ from: "orders@shop.example", subject: "Your refund", body: "" }), null);
});

test("with no rule and no sender history the verdict defers to the agent", async () => {
  const v = await classifyEmail({ from: "someone@example.org", subject: "Hello", body: "" }, { noMem: true });
  assert.equal(v.escalate, true);
  assert.equal(settledLocally(v), false);
});
