"use strict";
// finance-deposit-reconcile — where every tenant's security deposit is, as the
// HUB records it, shaped for the reviews.
//
// Requirement: the real-estate review looks at the metadata the hub keeps about
// every deposit before declaring anything missing, not only at the deposits
// account.
//
// This used to work deposits out here, from the deposit account's bank rows:
// sweeps matched to the deposits whose amounts added up, ambiguities answered
// by a deposit-move command. That declared a tenant's deposit missing on
// the strength of one transfer that fitted two sets of tenants, and money was
// moved because of it. The answers that settle such a row are now made in the
// hub, where a person attributes them:
//
//   - every bank row that moved deposit money carries a `depositLink` naming
//     the tenants (rules link the certain ones; Financials -> Security deposits
//     asks a person about the rest);
//   - every `billing-deposits` doc carries `whereabouts` (where the money is,
//     received and returned dates), `startingPoint` and `outsideAllowed`;
//   - `billing-deposit-reports/latest` holds the account-level check and the
//     rows nobody has answered.
//
// So this module only READS that, and never declares a deposit missing that
// the hub's record does not show outside the deposit account. A row the hub
// has not attributed is reported as a question, never resolved into "missing".
//
// The hub's table is the only source. No notes kept here override it: whose a
// transfer was, where a deposit started and whether it may sit outside are
// answered in the hub, attributed to a person, and read back from it
// (2026-11-15: an Oct 18 note kept calling a deposit missing that the hub
// showed in the deposit account; the owner: "only use verified data").
//
// Pure: no I/O.
// bin/finance-deposits-reconcile loads and persists.

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const HELD = new Set(["paid", "pending_release", "refund_processing"]);

/**
 * The hub's places, as the reviews' location codes. A position in an account
 * mask other than the deposit account is that account; the hub's own words for
 * the rest.
 */
function locationOf(place, depositMask) {
  if (place === depositMask) return { location: "deposit_account", account: depositMask };
  if (/^\d{4}$/.test(place)) return { location: "operating_account", account: place };
  if (place === "stripe") return { location: "stripe_paid", account: null };
  if (place === "closing-credit") return { location: "closing_credit_unfunded", account: null };
  if (place === "returned") return { location: "refunded", account: null };
  return { location: "untraced", account: null };
}

/**
 * @param {object} p
 * @param {object[]} p.deposits  [{id, lease_number, property_id, property_name, state, tenant, amount, hub_status, paid_via, lease_start, lease_end, whereabouts, outside_allowed}]
 * @param {object|null} p.report  billing-deposit-reports/latest
 * @param {string} p.depositMask
 * @param {object[]} p.hubTransfers  hub deposit transfers still in flight: [{id, arrival, status, shares: [{deposit_id}]}]
 */
function depositsFromHub({ deposits: all, report, depositMask, hubTransfers = [] }) {
  const inFlight = new Map();
  for (const tr of hubTransfers) if (tr.status !== "paid") for (const x of tr.shares) inFlight.set(x.deposit_id, tr);
  // Payouts the hub's own record says were paid into the deposit account. When
  // a deposit still reads "Stripe balance", the hub has not matched the bank row
  // yet (2026-11-08: the hub's daily sync had not run for two days, so three
  // deposits that had landed in the deposit account were called missing).
  // That is not money missing; it is a record behind.
  const sentPaid = new Map();
  for (const tr of hubTransfers) if (tr.status === "paid" && (!tr.bank_last4 || String(tr.bank_last4) === String(depositMask))) for (const x of tr.shares) sentPaid.set(x.deposit_id, tr);

  const rows = all.filter((d) => Number(d.amount) > 0).map((d) => {
    const w = d.whereabouts || null;
    // Returned in full by the hub's own trail, even while its status still
    // reads held (2026-11-08: a deposit refunded weeks earlier, with the return
    // in the hub's trail, kept being reported as still held because its status
    // was never moved off "paid").
    const returnedInFull = Boolean(w?.returnedOn) && Number(w?.returnedAmount || 0) >= Number(d.amount) - 0.005;
    const held = HELD.has(d.hub_status) && !returnedInFull;
    let location, account = null, basis = "hub:whereabouts";
    if (d.hub_status === "unpaid") location = "unpaid";
    else if (returnedInFull && HELD.has(d.hub_status)) { location = "refunded"; basis = `hub:whereabouts (returned ${w.returnedOn}; the hub's status still reads "${d.hub_status}")`; }
    else if (!held) location = d.hub_status === "released" ? "refunded" : "closed";
    else if (!w) { location = "untraced"; basis = "hub: whereabouts not computed yet"; }
    // "Outside" counts only other bank accounts: a deposit credited at closing
    // and never funded has no money in the deposit account either, so where the
    // hub's positions put it decides (2026-11-08: an inherited deposit read as
    // "in the deposit account" with $0 there).
    else if (w.outside <= 0.005 && !((w.positions || []).some((p) => p.place !== depositMask && p.place !== "stripe-fee" && p.amount > 0.005) && !((w.positions || []).some((p) => p.place === depositMask && p.amount > 0.005)))) ({ location, account } = locationOf(depositMask, depositMask));
    else {
      // Name where the money that is NOT in the deposit account sits: the largest such position.
      const elsewhere = (w.positions || []).filter((p) => p.place !== depositMask && p.place !== "stripe-fee" && p.amount > 0)
        .sort((a, b) => b.amount - a.amount)[0];
      ({ location, account } = elsewhere ? locationOf(elsewhere.place, depositMask) : { location: "untraced", account: null });
    }
    const tr = inFlight.get(d.id);
    if (held && location === "stripe_paid" && tr) location = "in_transit";
    const sent = held && location === "stripe_paid" ? sentPaid.get(d.id) : null;
    if (sent) { location = "payout_sent"; basis = `hub payout ${sent.id}: paid to ••${depositMask}${sent.arrival ? ` on ${sent.arrival}` : ""}; the hub has not matched the bank row yet`; }
    // A return paid from an account that never held the money: the hub's
    // record leaves that account below zero for this tenant and the money
    // still sitting where it was held.
    const neg = returnedInFull ? (w.positions || []).find((p) => /^\d{4}$/.test(p.place) && p.amount < -0.005) : null;
    const stillIn = neg ? (w.positions || []).find((p) => /^\d{4}$/.test(p.place) && p.place !== neg.place && p.amount > 0.005) : null;
    const inAccount = (w?.positions || []).find((p) => p.place === depositMask)?.amount ?? 0;
    const fee = (w?.positions || []).find((p) => p.place === "stripe-fee")?.amount ?? 0;
    return {
      id: d.id, lease_number: d.lease_number, property_id: d.property_id, property_name: d.property_name, state: d.state,
      tenant: d.tenant, amount: round2(d.amount), hub_status: d.hub_status, paid_via: d.paid_via,
      lease_start: d.lease_start || null, lease_end: d.lease_end || null,
      location, location_account_mask: account, location_basis: basis,
      amount_in_deposit_account: location === "deposit_account" ? round2(inAccount) : null,
      fee_absorbed: round2(fee), fee_shortfall: 0,
      expected_location: d.outside_allowed ? "exception" : "deposit_account", exception_reason: d.outside_allowed?.note || null,
      outside: w ? round2(w.outside) : null,
      owed: w && w.owed != null ? round2(w.owed) : null,
      positions: w?.positions || [],
      received_on: w?.receivedOn || null, returned_on: w?.returnedOn || null,
      candidates: tr ? { transfer: tr.id, expected_arrival: tr.arrival } : null,
      expected_arrival: tr?.arrival || sent?.arrival || null,
      returned_from_other: neg && stillIn ? { paid_from: neg.place, paid_from_label: neg.label, held_in: stillIn.place, held_in_label: stillIn.label, amount: round2(Math.min(-neg.amount, stillIn.amount)) } : null,
      hub_status_stale: returnedInFull && HELD.has(d.hub_status) ? d.hub_status : null,
    };
  });

  const tracked = rows.filter((r) => !["closed", "unpaid", "refunded"].includes(r.location));
  // Missing = the hub's record shows a held deposit's money outside the deposit
  // account, with no admin saying that is fine. Nothing else.
  const missing = tracked.filter((r) => r.expected_location === "deposit_account" && !["deposit_account", "in_transit", "payout_sent"].includes(r.location));
  const inTransit = tracked.filter((r) => r.location === "in_transit");
  // The hub stores each candidate set as { members } (Firestore holds no array inside an array).
  const setsOf = (u) => (u.options || []).map((o) => (Array.isArray(o) ? o : o.members || []));
  const unanswered = (report?.unlinked || []).map((u) => ({ ...u, options: setsOf(u) })).map((u) => ({
    kind: u.options?.length ? "sweep" : "unlinked",
    plaid_transaction_id: String(u.id || "").replace(/^plaid:/, ""), date: u.date, amount: u.amount, description: u.description,
    options: (u.options || []).map((set) => set.map((x) => ({ id: x.depositId, tenant: x.tenantName, amount: x.amount }))),
    text: u.options?.length
      ? `The ${usd(u.amount)} on ${u.date} ("${String(u.description).slice(0, 50)}") is not attributed to any tenant yet; it could be ${u.options.map((set) => set.map((x) => `${x.tenantName} (${usd(x.amount)})`).join(" + ")).join("  OR  ")}. Answer it in the hub: Financials -> Security deposits.`
      : `The ${usd(u.amount)} on ${u.date} ("${String(u.description).slice(0, 50)}") is not attributed to any tenant yet. Answer it in the hub: Financials -> Security deposits.`,
  }));
  const p = report?.proof || null;
  return {
    rows, movements: [], ambiguities: unanswered,
    proof: {
      deposit_account_balance: round2(p?.balance ?? 0), located_total: round2(p?.deposits ?? 0),
      unattributed_total: round2((p?.other ?? 0) + (p?.unlinked ?? 0) + (p?.unexplained ?? 0)),
      opening_before_history: round2(p?.unexplained ?? 0),
      unattributed_txns: (report?.unlinked || []).map((u) => ({ id: u.id, date: u.date, amount: round2(u.amount), name: String(u.description || "").slice(0, 70) })),
      // The balance is the sum of its parts by construction now; the hub's
      // per-tenant record is the check that matters. No report = not ok.
      difference: 0, ok: Boolean(report),
    },
    report_at: report?.computedAt || null,
    missing, in_transit: inTransit,
    fee_shortfall_total: 0,
    fee_absorbed_total: round2(rows.reduce((s, r) => s + (r.fee_absorbed || 0), 0)),
    // What is still owed back, as the hub counts it: a refund paid in parts
    // (2026-11-13: $2,000 of $3,700 back, the rest to follow) owes only the rest.
    liability: round2(tracked.reduce((s, r) => s + (r.owed ?? r.amount), 0)),
  };
}

const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The reviews' view of the latest persisted reconciliation
 * (fin_deposit_reconciliations.report): formatted rows and the flags to raise.
 * Every statement is a row of the reconciliation; nothing is inferred here.
 */
function depositSection(run, today, fmtD = (d) => d) {
  if (!run) return { flags: [{ priority: 95, tag: "deposit-recon-missing", text: "No deposit reconciliation has run — run bin/finance-deposits-reconcile." }], section: null };
  const r = run.report;
  const p = r.proof;
  const flags = [];
  const ageDays = Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(run.run_at)) / 86400000);
  if (ageDays > 2) flags.push({ priority: 90, tag: "deposit-recon-stale", text: `The deposit reconciliation is ${ageDays} days old (last run ${fmtD(String(run.run_at).slice(0, 10))}).` });
  // The hub's own record behind: its daily sync computes it, and when that
  // does not run, everything here is as of that day.
  const hubAgeH = r.report_at ? (Date.parse(`${today}T12:00:00Z`) - Date.parse(r.report_at)) / 3600000 : null;
  if (hubAgeH != null && hubAgeH > 36) flags.push({ priority: 88, tag: "deposit-hub-stale", text: `The hub's deposit record was last computed ${fmtD(String(r.report_at).slice(0, 10))}; deposit locations below are as of that day.` });
  if (!p.ok) flags.push({ priority: 96, tag: "deposit-recon-unbalanced", text: `The deposit account does not reconcile: ${usd(p.deposit_account_balance)} in the account vs ${usd(p.located_total)} of located deposits + ${usd(p.unattributed_total)} not tied to a current deposit — off by ${usd(p.difference)}.` });
  const where = (x) => x.location === "operating_account" ? `in ••${x.location_account_mask || "?"} (the property's operating account)`
    : x.location === "stripe_paid" ? "paid through Stripe, no payout has reached the deposit account"
    : x.location === "payout_sent" ? `paid out to the deposit account${x.expected_arrival ? ` on ${fmtD(x.expected_arrival)}` : ""} (the hub's payout record); the hub has not matched the bank row yet`
    : x.location === "closing_credit_unfunded" ? "credited at closing, never funded into any account"
    : x.location === "untraced" ? "no bank row shows where it is: link its rows, or set where it started, on the tenant's card in the hub"
    : x.location;
  const groups = (r.ambiguities || []).filter((a) => a.kind === "stripe-group");
  const grouped = new Set(groups.flatMap((g) => g.deposits));
  const missing = (r.missing || []).filter((x) => !grouped.has(x.id)).map((x) => ({
    property_name: x.property_name, state: x.state, lease_number: x.lease_number, tenant: x.tenant, amount_fmt: usd(x.amount), where: where(x), basis: x.location_basis,
  }));
  // A deposit sitting in one of the owner's own accounts has one fix, and the
  // flag says it: the move, from where to where, for how much.
  const depLabel = r.deposit_account || "the deposit account";
  for (const [i, m] of missing.entries()) {
    const x = (r.missing || []).filter((y) => !grouped.has(y.id))[i];
    // The account by its name, as the hub records it ("12 Oak St ••1234"), not a bare number.
    const fromLabel = x ? ((x.positions || []).find((p) => String(p.place) === String(x.location_account_mask))?.label || `••${x.location_account_mask}`) : null;
    const action = x && x.location === "operating_account" && x.location_account_mask ? `Move ${m.amount_fmt} from ${fromLabel} to ${depLabel}.` : null;
    flags.push({ priority: 86, tag: "deposit-missing", text: `${m.tenant}'s ${m.amount_fmt} deposit (${m.property_name}) is not in the deposit account: ${m.where}.`, action });
  }
  for (const g of groups) {
    const ds = (r.rows || []).filter((x) => g.deposits.includes(x.id));
    const paid = ds.reduce((s, x) => s + x.amount, 0);
    flags.push({ priority: 84, tag: "deposit-missing", text: `${ds[0]?.property_name} lease ${g.lease_number}: ${ds.length} deposits paid through Stripe (${usd(paid)}, ${ds.map((x) => x.tenant).join(", ")}); ${g.payouts} payout(s) totalling ${usd(g.arrived_total)} have reached the deposit account, so ${ds.length - g.payouts} have not — which ones needs Stripe payout data.` });
  }
  for (const x of r.in_transit || []) flags.push({ priority: 40, tag: "deposit-in-transit", text: `${x.tenant}'s ${usd(x.amount)} deposit (${x.property_name}) is on its way to the deposit account; expected ${fmtD(x.expected_arrival)}.` });
  const shortRows = (r.rows || []).filter((x) => x.fee_shortfall > 0);
  if (shortRows.length) flags.push({ priority: 62, tag: "deposit-fee-shortfall", text: `Beyond the accepted $2.50 Stripe fee, the deposit account is ${usd(shortRows.reduce((s, x) => s + x.fee_shortfall, 0))} short of what it owes: ${shortRows.map((x) => `${x.tenant} ${usd(x.fee_shortfall)}`).join(", ")}.` });
  for (const a of (r.ambiguities || []).filter((a) => a.kind === "sweep")) flags.push({ priority: 70, tag: "deposit-ambiguous", text: a.text, action: "Attribute it in the hub: Financials → Security deposits." });
  // Whose a row was is answered in the hub, never here.
  const questions = [];
  // Rows nobody has attributed, with no tenant set that fits them: mostly the
  // years before the hub tracked deposits. One line, not one flag each.
  const loose = (r.ambiguities || []).filter((a) => a.kind === "unlinked");
  if (loose.length) flags.push({
    priority: 45, tag: "deposit-unattributed-rows",
    text: `${loose.length} row(s) on the deposit account are not attributed to any tenant: ${loose.map((a) => `${fmtD(a.date)} ${usd(a.amount)} ("${String(a.description || "").replace(/\s+/g, " ").slice(0, 40).trim()}")`).join("; ")}.`,
    action: "Attribute them in the hub: Financials → Security deposits.",
  });
  const rows = (r.rows || []).filter((x) => x.location !== "closed");
  const unpaid = rows.filter((x) => x.location === "unpaid" && x.lease_start && x.lease_start <= today);
  for (const x of unpaid) flags.push({ priority: 82, tag: "deposit-unpaid", text: `${x.tenant} has not paid a ${usd(x.amount)} deposit (${x.property_name}, lease started ${fmtD(x.lease_start)}).` });
  const ended = rows.filter((x) => x.lease_end && x.lease_end < today && !["refunded", "unpaid", "closed"].includes(x.location));
  for (const x of rows.filter((x) => x.returned_from_other)) {
    const o = x.returned_from_other;
    // The refund came out of an account that never had this tenant's money, so
    // that account covered it with someone else's, and the account that held it
    // still does. One transfer puts both right; the flag leads with it
    // (the user, 2026-11-08: "there should be a clear call to action").
    flags.push({
      priority: 79, tag: "deposit-returned-from-other-account",
      text: `${x.tenant}'s ${usd(x.amount)} deposit (${x.property_name}) was held in ${o.held_in_label}, never in ${o.paid_from_label}, but the ${fmtD(x.returned_on)} refund was paid from ${o.paid_from_label}. So ${o.paid_from_label} covered it with other money, and ${o.held_in_label} still holds ${usd(o.amount)} of it.`,
      action: `Move ${usd(o.amount)} from ${o.held_in_label} to ${o.paid_from_label}.`,
    });
  }
  for (const x of rows.filter((x) => x.hub_status_stale)) flags.push({ priority: 47, tag: "deposit-hub-status", text: `${x.tenant}'s deposit (${x.property_name}) was returned on ${fmtD(x.returned_on)}, but the hub still lists it as "${x.hub_status_stale}".`, action: "Mark it returned on the tenant's card in the hub." });
  for (const x of ended) flags.push({ priority: 80, tag: "deposit-not-returned", text: `${x.tenant}'s ${usd(x.amount)} deposit (${x.property_name}) is still held; the lease ended ${fmtD(x.lease_end)}.` });
  const big = (p.unattributed_txns || []).filter((t) => Math.abs(t.amount) >= 1);
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  const locatedHere = round2((r.rows || []).filter((x) => x.location === "deposit_account").reduce((t, x) => t + Number(x.amount_in_deposit_account ?? x.amount ?? 0), 0));
  // What the rest of the balance is: refunds this account paid for deposits it
  // never held (they come off it), and what is left over — money that was here
  // before the hub tracked deposits per tenant, plus interest. Owed to no one.
  const depMask = String(r.deposit_account || "").match(/(\d{4})\s*$/)?.[1] || null;
  const refundedHere = round2((r.rows || []).filter((x) => x.returned_from_other && (!depMask || String(x.returned_from_other.paid_from) === depMask)).reduce((t, x) => t + Number(x.returned_from_other.amount || 0), 0));
  const leftover = round2(p.deposit_account_balance - locatedHere + refundedHere);
  if (leftover >= 1) flags.push({
    priority: 38, tag: "deposit-buffer", optional: true,
    text: `${usd(leftover)} in the deposit account is no tenant's deposit: it was there before the hub tracked deposits per tenant (and interest since).${refundedHere ? ` Once the money for refunds paid from this account is moved back, the account holds every deposit it owes plus this.` : ""}`,
    action: `Move ${usd(leftover)} out of the deposit account if you don't want it as a cushion there; otherwise nothing to do.`,
  });
  return {
    flags, questions,
    section: {
      run_at: run.run_at, deposit_account: r.deposit_account, ok: p.ok,
      // Located = the deposits this table shows in the account, so the line and
      // the table agree; the rest of the balance is what no current deposit explains.
      balance_fmt: usd(p.deposit_account_balance), located_fmt: usd(locatedHere), unattributed_fmt: usd(round2(p.deposit_account_balance - locatedHere)),
      located_hub_fmt: usd(p.located_total),
      refunded_here_fmt: refundedHere ? usd(refundedHere) : null, leftover_fmt: leftover >= 1 ? usd(leftover) : null,
      fees_fmt: (() => { const f = round2((r.rows || []).filter((x) => x.location === "deposit_account").reduce((t, x) => t + Number(x.fee_absorbed || 0), 0)); return f >= 0.01 ? usd(f) : null; })(),
      opening_fmt: usd(p.opening_before_history), difference_fmt: usd(p.difference), liability_fmt: usd(r.liability), liability: r.liability,
      missing, groups: groups.map((g) => g.text),
      in_transit: (r.in_transit || []).map((x) => `${x.tenant} ${usd(x.amount)} (expected ${fmtD(x.expected_arrival)})`),
      rows: rows.map((x) => ({ property_name: x.property_name, lease_number: x.lease_number, tenant: x.tenant, amount_fmt: usd(x.amount), location: x.location === "deposit_account" ? (x.fee_shortfall ? `deposit account (${usd(x.fee_shortfall)} short beyond the accepted fee)` : x.fee_absorbed ? `deposit account (less ${usd(x.fee_absorbed)} Stripe fee — accepted)` : "deposit account") : x.location === "in_transit" ? `in transit, expected ${fmtD(x.expected_arrival)}` : where(x), exception: x.expected_location === "exception" ? x.exception_reason : null, basis: x.location_basis })),
      unattributed: big.map((t) => `${t.date} ${usd(t.amount)} ${t.name}`),
    },
  };
}

/**
 * Tenant deposits owed back, from the latest reconciliation run — the amount
 * every net-worth figure subtracts (the deposits are the tenants' money, but
 * the cash sits in the owner's bank balances). 0 when no run is on record.
 */
function depositLiability(run) {
  try {
    const n = Number(run && run.report && run.report.liability);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

module.exports = { depositsFromHub, depositSection, depositLiability };
