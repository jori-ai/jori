"use strict";
// finance-invoice-reconcile — the user's invoices to a client, matched to the
// payments that settled them, by code, and proved to the cent.
//
// Requirement: invoices and the payments for them are reconciled like the
// bank, for the user's own invoices only. The invoices come from a sheet (one
// row per invoice); the payments are the client's ACH credits into one
// checking account. An invoice is billed at the end of a month and due by a
// set day of the next (`dueDay`, default the 6th). Which sheet, account and
// client: agent/local/config/rental-finance.json `invoices`
// (bin/finance-invoices-reconcile).
//
// Rules, in order — the first that applies wins:
//   1. A recorded match (fin_invoice_matches.recorded) — a person's answer.
//   2. Invoices are settled oldest first. For each, every set of 1–3 unused
//      client payments dated from 10 days before the invoice to 75 days
//      after, whose amounts add up to exactly what is owed, is a candidate;
//      the set that COMPLETED earliest paid it (one month can be paid in two
//      parts before the next month's invoice amount arrives). Two different
//      sets completing the same day are reported as ambiguous, never picked.
//   3. An invoice nothing settles is open: due on the 6th of the month after
//      its invoice month, late after the grace days.
//   4. A payment no invoice used is reported as not matched to the user's
//      invoices (another payee's invoices to the same client are not tracked).
//   5. Proof: invoiced (in scope, not voided) = matched payments + open balances.
//
// Pure: no I/O. bin/finance-invoices-reconcile loads and persists.

const { localConfig } = require("./instance.cjs");

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const cents = (n) => Math.round(Number(n) * 100);
const dayNum = (d) => Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) / 86400000;
const iso = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

/** 6th of the month after the invoice's month. */
function dueDate(invoiceDate, dueDay = 6) {
  const [y, m] = invoiceDate.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-${String(dueDay).padStart(2, "0")}`;
}

/**
 * @param {object} p
 * @param {object[]} p.invoices  [{number, invoice_date, amount, voided, in_scope}]
 * @param {object[]} p.payments  [{transaction_id, date, amount (positive = received), name}]
 * @param {object[]} p.recorded  recorded matches [{invoice_number, plaid_transaction_id, amount, paid_on}]
 * @param {string} p.today
 * @param {number} [p.graceDays]
 */
function reconcileInvoices({ invoices, payments, recorded = [], today, graceDays = 3, dueDay = 6 }) {
  const live = invoices.filter((i) => i.in_scope && !i.voided).sort((a, b) => a.invoice_date.localeCompare(b.invoice_date) || String(a.number).localeCompare(String(b.number)));
  const used = new Map(); // txn id → remaining cents
  for (const p of payments) used.set(p.transaction_id, cents(p.amount));
  const matches = [];
  const ambiguities = [];
  const paid = new Map(live.map((i) => [i.number, 0]));

  for (const r of recorded) {
    if (!paid.has(r.invoice_number) || !used.has(r.plaid_transaction_id)) continue;
    const c = Math.min(cents(r.amount), used.get(r.plaid_transaction_id));
    used.set(r.plaid_transaction_id, used.get(r.plaid_transaction_id) - c);
    paid.set(r.invoice_number, paid.get(r.invoice_number) + c);
    matches.push({ invoice_number: r.invoice_number, plaid_transaction_id: r.plaid_transaction_id, amount: c / 100, paid_on: r.paid_on, basis: "recorded", recorded: true });
  }

  for (const inv of live) {
    const need = cents(inv.amount) - paid.get(inv.number);
    if (need <= 0) continue;
    const lo = dayNum(inv.invoice_date) - 10, hi = dayNum(inv.invoice_date) + 75;
    const pool = payments
      .filter((p) => used.get(p.transaction_id) === cents(p.amount) && dayNum(p.date) >= lo && dayNum(p.date) <= hi)
      .sort((a, b) => a.date.localeCompare(b.date));
    // Every set of 1–3 unused payments that adds up to exactly what is owed;
    // the one that COMPLETED earliest is what paid it (a later lump sum that
    // happens to match did not). Two sets completing on the same day → ambiguous.
    const cands = [];
    for (let k = 1; k <= 3; k++) {
      for (const set of combos(pool, k)) {
        if (set.reduce((x, p) => x + cents(p.amount), 0) === need) cands.push({ set, done: set.map((p) => p.date).sort().pop() });
      }
    }
    cands.sort((a, b) => a.done.localeCompare(b.done) || a.set.length - b.set.length);
    let chosen = null;
    if (cands.length) {
      const first = cands.filter((c) => c.done === cands[0].done && c.set.length === cands[0].set.length);
      if (first.length === 1) chosen = first[0].set;
      else ambiguities.push({ invoice_number: inv.number, text: `Invoice ${inv.number} (${inv.invoice_date}, ${usd(need / 100)}) is matched exactly by ${first.length} payment sets completing on ${first[0].done}: ${first.map((c) => c.set.map((p) => `${usd(p.amount)} on ${p.date}`).join(" + ")).join("  OR  ")}.` });
    }
    if (!chosen) continue;
    for (const p of chosen) {
      used.set(p.transaction_id, 0);
      paid.set(inv.number, paid.get(inv.number) + cents(p.amount));
      matches.push({ invoice_number: inv.number, plaid_transaction_id: p.transaction_id, amount: round2(p.amount), paid_on: p.date, basis: chosen.length === 1 ? "rule:exact-payment-fifo" : `rule:exact-set-of-${chosen.length}`, evidence: p.name, recorded: false });
    }
  }

  const rows = invoices.map((i) => {
    const due = dueDate(i.invoice_date, dueDay);
    const p = (paid.get(i.number) || 0) / 100;
    const open = i.in_scope && !i.voided ? round2(Number(i.amount) - p) : 0;
    const status = !i.in_scope ? "out_of_scope" : i.voided ? "void"
      : open <= 0.004 ? "paid"
      : dayNum(today) > dayNum(due) + graceDays ? "late"
      : p > 0 ? "part_paid" : "open";
    const ms = matches.filter((m) => m.invoice_number === i.number);
    return { ...i, due_date: due, paid_amount: round2(p), open_amount: open, status, paid_on: ms.length ? ms.map((m) => m.paid_on).sort().pop() : null, days_to_pay: ms.length ? dayNum(ms.map((m) => m.paid_on).sort().pop()) - dayNum(i.invoice_date) : null };
  });
  const unmatched = payments.filter((p) => used.get(p.transaction_id) > 0)
    .map((p) => ({ transaction_id: p.transaction_id, date: p.date, amount: round2(used.get(p.transaction_id) / 100), name: p.name }));
  const invoiced = round2(live.reduce((s, i) => s + Number(i.amount), 0));
  const paidTotal = round2(matches.reduce((s, m) => s + m.amount, 0));
  const outstanding = round2(rows.reduce((s, r) => s + (r.status === "void" || r.status === "out_of_scope" ? 0 : r.open_amount), 0));
  return {
    rows, matches, ambiguities, unmatched,
    proof: { invoiced, paid: paidTotal, outstanding, ok: cents(invoiced) === cents(paidTotal) + cents(outstanding) },
  };
}

function combos(xs, k, start = 0, acc = [], out = []) {
  if (out.length > 5000) return out;
  if (acc.length === k) { out.push([...acc]); return out; }
  for (let i = start; i < xs.length; i++) { acc.push(xs[i]); combos(xs, k, i + 1, acc, out); acc.pop(); }
  return out;
}
const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The reviews' view of the latest persisted run: rows and flags. */
function invoiceSection(run, today, fmtD = (d) => d, label = null) {
  if (!run) return { flags: [], section: null };
  const r = run.report;
  // The invoices' name in a flag ("<label> invoice 164 ..."): the caller's, else
  // the one the run recorded, else plain "Client".
  const L = label || r.label || localConfig("rental-finance", { invoices: {} }).invoices?.label || "Client";
  const flags = [];
  if (!r.proof.ok) flags.push({ priority: 94, tag: "invoice-recon-unbalanced", text: `${L} invoices do not reconcile: ${usd(r.proof.invoiced)} invoiced vs ${usd(r.proof.paid)} paid + ${usd(r.proof.outstanding)} open.` });
  const open = r.rows.filter((x) => ["open", "part_paid", "late"].includes(x.status));
  for (const x of open.filter((x) => x.status === "late")) flags.push({ priority: 93, tag: "invoice-late", text: `${L} invoice ${x.number} (${fmtD(x.invoice_date)}, ${usd(x.amount)}) is unpaid: ${usd(x.open_amount)} open, due ${fmtD(x.due_date)}.` });
  for (const a of r.ambiguities || []) flags.push({ priority: 70, tag: "invoice-ambiguous", text: a.text });
  return {
    flags,
    section: {
      run_at: run.run_at, ok: r.proof.ok, invoiced_fmt: usd(r.proof.invoiced), paid_fmt: usd(r.proof.paid), outstanding_fmt: usd(r.proof.outstanding),
      scope: r.scope,
      open: open.map((x) => ({ number: x.number, date_fmt: fmtD(x.invoice_date), amount_fmt: usd(x.amount), open_fmt: usd(x.open_amount), due_fmt: fmtD(x.due_date), status: x.status })),
      recent: r.rows.filter((x) => x.status === "paid").slice(-4).map((x) => ({ number: x.number, date_fmt: fmtD(x.invoice_date), paid_on_fmt: fmtD(x.paid_on), days: x.days_to_pay })),
      unmatched_count: (r.unmatched || []).length,
    },
  };
}

module.exports = { reconcileInvoices, invoiceSection, dueDate };
