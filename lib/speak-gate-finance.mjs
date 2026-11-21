// speak-gate-finance — what the owner RECORDED about money, put in front of the
// speak gate's judge and its rewrite check, and the rule that follows from it.
// system/speak-gate.md § Money claims.
//
// The rule (wiki feedback_finance_no_guess_as_fact): money is "late", "missing"
// or "short" only against a recorded expectation (fin_expected_income,
// fin_scheduled_payments), never against a pattern read out of past bank rows.
// The gate used to judge money messages without reading those rows, so an alarm
// the records contradict could survive as a rewritten question.
//
// Code owns the structure (which messages get the records: a finance intent or
// sender, read from metadata; what a premise verdict does). The judge owns the
// language (does the message call money late, and is its premise backed): the
// premise it reports is a field of its JSON answer, never a pattern in the text.
"use strict";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FINANCE_INTENT_PREFIXES = ["hum:finance", "finance", "fin-"];
const FINANCE_SENDERS = new Set(["cfo"]);
const MAX_ROWS = 40;
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** True for a message from the finance lane, read from its intent and sender (metadata, not wording). */
export function financeScope(input = {}) {
  const intent = String(input.intent || "").toLowerCase();
  return FINANCE_SENDERS.has(String(input.sender || "")) || FINANCE_INTENT_PREFIXES.some((p) => intent.startsWith(p));
}

const money = (n) => (n === null || n === undefined || n === "" ? null : `$${Number(n).toLocaleString("en-US")}`);

export function incomeLine(r) {
  const bits = [
    r.payer_contains ? `payer contains "${r.payer_contains}"` : "",
    money(r.amount) ? `${money(r.amount)}${r.tolerance ? ` ±${money(r.tolerance)}` : ""}` : "amount varies",
    [r.cadence, r.due_day ? `due day ${r.due_day}` : "", r.grace_days ? `${r.grace_days} grace days` : ""].filter(Boolean).join(", "),
    r.active_from ? `from ${r.active_from}` : "", r.active_to ? `until ${r.active_to}` : "",
    r.note ? `note: ${clip(r.note, 900)}` : "",
  ].filter(Boolean);
  return `- [expected income] ${clip(r.label, 120)} · ${bits.join(" · ")}`;
}

export function paymentLine(r) {
  const amt = r.fixed_amount !== null && r.fixed_amount !== undefined ? money(r.fixed_amount) : r.amount_rule;
  const bits = [
    r.kind, amt, r.due_day ? `due day ${r.due_day}` : "", r.autopay ? "autopay" : "",
    r.descriptor_contains ? `bank text contains "${r.descriptor_contains}"` : "",
    r.note ? `note: ${clip(r.note, 900)}` : "",
  ].filter(Boolean);
  return `- [scheduled payment] ${clip(r.label, 120)} · ${bits.join(" · ")}`;
}

async function fetchRows(asOf) {
  // A test stand-in: {income: [...], payments: [...]} (the database is not reachable there).
  if (process.env.SPEAK_GATE_FINANCE_ROWS) {
    const j = JSON.parse(readFileSync(process.env.SPEAK_GATE_FINANCE_ROWS, "utf8"));
    return { income: j.income || [], payments: j.payments || [] };
  }
  const rest = require(path.join(ROOT, "lib", "supabase-rest.js"));
  const day = String(asOf || new Date().toISOString()).slice(0, 10);
  const [income, payments] = await Promise.all([
    rest.request(`/rest/v1/fin_expected_income?select=label,payer_contains,amount,tolerance,cadence,due_day,grace_days,active_from,active_to,note&or=${encodeURIComponent(`(active_to.is.null,active_to.gte.${day})`)}&limit=${MAX_ROWS}`, { timeoutMs: 6000 }),
    rest.request(`/rest/v1/fin_scheduled_payments?select=label,kind,amount_rule,fixed_amount,due_day,autopay,descriptor_contains,note&active=is.true&limit=${MAX_ROWS}`, { timeoutMs: 6000 }),
  ]);
  return { income: Array.isArray(income) ? income : [], payments: Array.isArray(payments) ? payments : [] };
}

/**
 * The owner's recorded money expectations as evidence text: every active income
 * stream and scheduled payment, with its note and cadence. All of them, not the
 * ones whose payer the message seems to name (deciding that would be reading the
 * message with code); the table is a handful of rows. "" when there is nothing
 * or the read fails (the judge then has the finance-facts tool, as before).
 */
export async function financeRecords({ asOf, fetch = fetchRows } = {}) {
  try {
    const { income, payments } = await fetch(asOf);
    return [...income.map(incomeLine), ...payments.map(paymentLine)].join("\n");
  } catch { return ""; }
}

export const FINANCE_EVIDENCE_TITLE = "RECORDED MONEY EXPECTATIONS (what the owner told us: income streams and scheduled payments, with their notes and cadence. Money is late, missing or short ONLY against one of these)";

// Prompt text: what the judge does with a message that calls money late, missing
// or short. Applies to every message, whatever its sender or intent.
export const PREMISE_RULE = `MONEY CLAIMS. A message that calls money late, missing, short, overdue or unpaid is true only against a RECORDED expectation: an income stream, a scheduled payment, a lease or an invoice the owner stated (the recorded expectations are shown below for the finance lane; \`finance-facts list income\` and \`finance-facts list payment\` show them for any message). A pattern read out of past bank rows ("usually by the 6th", "the usual deposit") is a guess, not a recorded expectation. Read the recorded notes and cadence before judging: a retainer billed at month end and paid by the 6th of the next month is not late on the 3rd, and a notes line saying one credit larger than the stream's amount is two invoices paid together means a larger credit is the payment, not a missing one. Report "premise" for such a message: "backed" (a recorded expectation shows it is due and unpaid), "contradicted" (a recorded expectation or a payment you found shows it is not late or not missing), "unbacked" (nothing recorded shows the date, the amount or the cadence it relies on). Use "n/a" for any other message. For a proactive message with "contradicted" or "unbacked" the verdict is NEVER "rewrite", "send" or "digest", and never a rewrite into a softer question: "resolve" when you found the answer (research_plan says what the record shows), otherwise "drop". A question that keeps an unbacked alarm alive is the same alarm. A reply or a report is never held: correct the money claim in a rewrite, or send it if the records back it.`;

/**
 * The premise rule in code. A proactive message whose money premise the judge
 * found contradicted or unbacked is held (not sent, rewritten or digested): contradicted
 * becomes "resolve" (the record answers it), unbacked becomes "drop". A reply or
 * a report is only ever sent or corrected, so it is left to the judge's fix.
 */
export function applyPremiseRule(input, r) {
  const premise = String(r?.premise || "").toLowerCase();
  if (input?.kind !== "proactive" || !["contradicted", "unbacked"].includes(premise)) return r;
  if (!["send", "rewrite", "digest"].includes(r.verdict)) return r; // a held digest is printed in the daily summary: the alarm would still surface there
  const note = clip(r.premise_note || r.reason, 280);
  const base = r.checks && typeof r.checks === "object" && !Array.isArray(r.checks) ? r.checks : { judge: r.checks ?? null };
  const checks = { ...base, premise: { premise, was: r.verdict } };
  const { message, ...rest } = r; // eslint-disable-line no-unused-vars -- a held message has no replacement text
  if (premise === "contradicted") {
    return { ...rest, verdict: "resolve", research_plan: clip(r.research_plan || note, 600), checks,
      reason: `Money premise contradicted by a recorded expectation: ${note}`.slice(0, 300) };
  }
  return { ...rest, verdict: "drop", checks, reason: `Money premise not backed by a recorded expectation: ${note}`.slice(0, 300) };
}
