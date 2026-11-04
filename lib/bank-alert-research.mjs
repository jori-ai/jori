// bank-alert-research — what Jori already knows about a bank transaction,
// gathered BEFORE the bank-alert judge decides whether to interrupt the user.
//
// The user (2026-11-04), after the first Jev-judged run flagged a $37,000
// client payment, a pension wire and a deposit-account payout that the books
// and memory already explained: "we should pass memory and ledger data to jev
// for the decision. many of these transactions are expected and should be
// researched before alerting."
//
// So for every candidate (lib/bank-alert-judge.mjs) this gathers, in parallel
// and each under its own deadline:
//
//   ledger  — the user's recorded finance facts (fin_* tables, bin/finance-facts):
//             a recorded verdict on this transaction (fin_txn_override), expected
//             income and scheduled payments on this account, invoice and
//             security-deposit rows that name this transaction, open invoices,
//             and the deposits held in this account.
//   books   — the rental books' own entry for this transaction
//             (lib/rental-ledger.js; doc `plaid:<transaction_id>`): category,
//             property, the classifier's reason, a matched receipt, an override.
//   memory  — unified recall (lib/unified-recall.mjs: recent chat, the user's
//             replies, the wiki, indexed mail) for the payee/description.
//   email   — Gmail messages within ten days that contain this exact amount
//             (a payout notice, an invoice, a wire confirmation).
//
// Structure only: account ids, transaction ids, amounts and dates select the
// rows, and the bank's own description is handed to search as-is. Whether any
// of it EXPLAINS the transaction is the judge's reading (Rule #0b).
//
// Every source fails soft: an error or a timeout leaves that source `null`
// with a note, and the judge decides on what came back. A source that is not
// configured on this installation (no rental books, no Gmail token) is simply
// absent. Bank data never leaves Jori's own stores here: Supabase, the user's
// own Firestore books, the local wiki/recall index and the user's own Gmail.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SNIPPET = 280;

function withDeadline(p, ms, what) {
  let t;
  const late = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); t.unref?.(); });
  return Promise.race([p, late]).finally(() => clearTimeout(t));
}

const trim = (s, n = SNIPPET) => {
  const v = String(s ?? "").split(/\s+/).join(" ").trim(); // lang-regex-ok: whitespace collapse for display only
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

function ids(ref) {
  return [...new Set([ref.transaction_id, ref.pending_transaction_id].filter(Boolean))];
}

// ── ledger: the user's recorded finance facts ──────────────────────────────

async function rest(pathAndQuery) {
  const { request } = require("./supabase-rest.js");
  const rows = await request(pathAndQuery, { method: "GET" });
  return Array.isArray(rows) ? rows : [];
}

const inList = (xs) => `in.(${xs.map((x) => `"${x}"`).join(",")})`;

export async function ledgerFacts(ref, { fetchRows = rest } = {}) {
  const tx = ids(ref);
  const acct = ref.account_id;
  const q = (table, params) => fetchRows(`/rest/v1/${table}?${new URLSearchParams(params)}`).catch(() => null);
  const [override, income, payments, invoiceMatch, openInvoices, depositMoves, depositsHere] = await Promise.all([
    tx.length ? q("fin_txn_override", { select: "kind,property_id,note,set_by,set_at", transaction_id: inList(tx) }) : [],
    acct ? q("fin_expected_income", { select: "label,payer_contains,amount,tolerance,cadence,due_day,grace_days,active_from,active_to,note", account_id: `eq.${acct}` }) : [],
    acct ? q("fin_scheduled_payments", { select: "label,kind,amount_rule,fixed_amount,due_day,autopay,active,descriptor_contains,note,funding_account_id,target_account_id", or: `(funding_account_id.eq.${acct},target_account_id.eq.${acct})` }) : [],
    tx.length ? q("fin_invoice_matches", { select: "invoice_number,amount,paid_on,basis", plaid_transaction_id: inList(tx) }) : [],
    q("fin_invoices", { select: "number,payer,invoice_date,amount,due_date,paid_amount,status", status: "neq.paid", voided: "is.false", order: "invoice_date.desc", limit: "6" }),
    tx.length ? q("fin_deposit_movements", { select: "kind,amount,on_date,basis,evidence", plaid_transaction_id: inList(tx) }) : [],
    ref.account_mask ? q("fin_deposits", { select: "tenant,property_name,amount,state,lease_end,location", location_account_mask: `eq.${ref.account_mask}`, limit: "30" }) : [],
  ]);
  const scrub = (rows) => (rows || []).map((r) => {
    const { funding_account_id, target_account_id, ...rest } = r;
    const out = { ...rest };
    if (funding_account_id !== undefined) out.this_account_is = funding_account_id === acct ? "funding" : "target";
    if (out.note) out.note = trim(out.note, 400);
    if (out.evidence) out.evidence = trim(out.evidence, 300);
    return out;
  });
  return {
    recorded_verdict: scrub(override),
    expected_income_on_this_account: scrub(income),
    scheduled_payments_on_this_account: scrub(payments),
    invoice_payment_match: scrub(invoiceMatch),
    open_invoices: scrub(openInvoices),
    security_deposit_movement: scrub(depositMoves),
    security_deposits_held_in_this_account: (depositsHere || []).length
      ? { count: depositsHere.length, total_usd: depositsHere.reduce((s, d) => s + Number(d.amount || 0), 0), tenants: depositsHere.slice(0, 30).map((d) => ({ tenant: d.tenant, property: d.property_name, amount: Number(d.amount), state: d.state, lease_end: d.lease_end })) }
      : null,
  };
}

// ── books: the rental hub's own entry ───────────────────────────────────────

let _books;
function booksClient() {
  if (_books !== undefined) return _books;
  _books = null;
  try {
    const { config } = require("./rental-ledger.js");
    const cfg = config();
    if (!cfg.firebase_project) return null;
    const { FirestoreClient } = require("./firestore-rest.js");
    _books = new FirestoreClient({ projectId: cfg.firebase_project, envVar: cfg.service_account_env || undefined });
  } catch { _books = null; } // no key on this machine: no books source
  return _books;
}

export async function booksEntry(ref, { client = booksClient() } = {}) {
  if (!client) return undefined;
  for (const id of ids(ref)) {
    const d = await client.get("financial-transactions", `plaid:${id}`);
    if (!d) continue;
    const c = d.override || d.classification || {};
    const r = d.receipt || null;
    return {
      category: c.categoryId || null,
      property: c.propertyId || null,
      classified_by: c.method || null,
      confidence: c.confidence ?? null,
      reason: c.reason ? trim(c.reason, 300) : null,
      overridden: Boolean(d.override),
      reviewed: d.reviewed === true,
      entity: d.entity?.classification ? { category: d.entity.classification.categoryId, entity: d.entity.classification.entityId, reason: trim(d.entity.classification.reason, 200) } : null,
      receipt: r ? { vendor: r.vendor || null, lines: (r.lineItems || []).slice(0, 4).map((l) => trim(l.description, 160)) } : null,
    };
  }
  return null;
}

// ── memory: what the user and Jori already know ─────────────────────────────

export async function memoryHits(query, { recallFn = null } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const recall = recallFn || (await import("./unified-recall.mjs")).recall;
  const r = await recall(q, { k: 6, chatSinceDays: 60, events: false, sourceTimeoutMs: 1500 });
  return (r.results || []).slice(0, 6).map((h) => ({
    source: h.source,
    title: h.title || null,
    when: h.created_at || h.date || null,
    text: trim(h.snippet || h.text || "", SNIPPET),
  }));
}

// ── email: messages that carry this exact amount ────────────────────────────

function gmailDate(iso, days) {
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10).split("-").join("/");
}

export function amountQuery(amount, date) {
  const a = Math.abs(Number(amount));
  const fixed = a.toFixed(2);
  const commas = a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const forms = [...new Set([commas, fixed])].map((f) => `"${f}"`).join(" OR ");
  return `(${forms}) after:${gmailDate(date, -10)} before:${gmailDate(date, 4)}`;
}

export async function emailHits(amount, date, { gmail = null } = {}) {
  const g = gmail || (await import("./gmail-read.mjs"));
  const found = await g.searchIds(amountQuery(amount, date), { max: 3 });
  const out = [];
  for (const id of found) {
    const m = await g.getMessage(id);
    out.push({
      from: trim(g.header(m, "From"), 120),
      subject: trim(g.header(m, "Subject"), 160),
      date: g.header(m, "Date"),
      snippet: trim(m.snippet, SNIPPET),
    });
  }
  return out;
}

// ── all of it, for one candidate ────────────────────────────────────────────

/**
 * Research one candidate. `ref` = {transaction_id, pending_transaction_id,
 * account_id, account_mask, amount, date, query}. Never throws.
 * @returns {Promise<object>} {ledger, books, memory, email, notes[]}
 */
export async function researchCandidate(ref, { deadlineMs = 8000, sources = {} } = {}) {
  const notes = [];
  const run = async (name, fn) => {
    try { return await withDeadline(Promise.resolve().then(fn), deadlineMs, name); }
    catch (e) { notes.push(`${name} unavailable: ${trim(e?.message || e, 120)}`); return null; }
  };
  const [ledger, books, memory, email] = await Promise.all([
    run("ledger", () => (sources.ledger || ledgerFacts)(ref)),
    run("books", () => (sources.books || booksEntry)(ref)),
    run("memory", () => (sources.memory || memoryHits)(ref.query)),
    run("email", () => (sources.email || emailHits)(ref.amount, ref.date)),
  ]);
  const out = { ledger, memory, email };
  if (books !== undefined) out.books = books;
  if (notes.length) out.notes = notes;
  return out;
}
