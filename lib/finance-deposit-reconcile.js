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
// Two further rules, so the same warning is not repeated once answered:
//
//   - A transfer the hub credits to one set of tenants, when another set whose
//     money the hub shows still in the same account adds up to the same
//     amount, is a question (kind "transfer-fits-two"). Neither set is called
//     missing or located until the user says whose it was.
//   - The user's answers live in data/finance-deposit-answers.jsonl (gitignored,
//     appended by the installation's deposit-answer command, named in
//     agent/local/config/rental-finance.json `deposit_answer_command`; the hub is read-only from
//     here). An answer names the bank row and the tenants it was ("whose"); every
//     other tenant the hub credits that row to, and any named as "unknown",
//     has no known whereabouts: never flagged, never located. A "whose" tenant
//     is covered until the hub records them moving again; an "unknown" one until
//     the hub both stops crediting them the row and records something newer.
//
// Pure: no I/O (the owner's display name comes from lib/instance.cjs).
// bin/finance-deposits-reconcile loads and persists.

const { instance, localConfig } = require("./instance.cjs");
const owner = () => instance().owner_name;
const answerCommand = () => localConfig("rental-finance", { deposit_answer_command: "" }).deposit_answer_command || "<deposit-answer command>";
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
 * @param {object[]} p.answers  the user's answers (data/finance-deposit-answers.jsonl, latest per row):
 *   [{row_id, date, amount, from, to, whose: [{deposit_id, tenant, amount}], unknown: [{deposit_id, tenant, amount}], said_on, said}]
 */
function depositsFromHub({ deposits: all, report, depositMask, hubTransfers = [], answers = [] }) {
  const inFlight = new Map();
  for (const tr of hubTransfers) if (tr.status !== "paid") for (const x of tr.shares) inFlight.set(x.deposit_id, tr);

  const rows = all.filter((d) => Number(d.amount) > 0).map((d) => {
    const w = d.whereabouts || null;
    const held = HELD.has(d.hub_status);
    let location, account = null, basis = "hub:whereabouts";
    if (d.hub_status === "unpaid") location = "unpaid";
    else if (!held) location = d.hub_status === "released" ? "refunded" : "closed";
    else if (!w) { location = "untraced"; basis = "hub: whereabouts not computed yet"; }
    else if (w.outside <= 0.005) ({ location, account } = locationOf(depositMask, depositMask));
    else {
      // Name where the money that is NOT in the deposit account sits: the largest such position.
      const elsewhere = (w.positions || []).filter((p) => p.place !== depositMask && p.place !== "stripe-fee" && p.amount > 0)
        .sort((a, b) => b.amount - a.amount)[0];
      ({ location, account } = elsewhere ? locationOf(elsewhere.place, depositMask) : { location: "untraced", account: null });
    }
    const tr = inFlight.get(d.id);
    if (held && location === "stripe_paid" && tr) location = "in_transit";
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
      positions: w?.positions || [],
      received_on: w?.receivedOn || null, returned_on: w?.returnedOn || null,
      candidates: tr ? { transfer: tr.id, expected_arrival: tr.arrival } : null,
      expected_arrival: tr?.arrival || null,
    };
  });

  const byId = new Map(rows.map((r) => [r.id, r]));
  const trailOf = new Map(all.map((d) => [d.id, d.whereabouts?.trail || []]));
  const open = (r) => Boolean(r) && !["closed", "unpaid", "refunded"].includes(r.location);
  const names = (xs) => xs.map((x) => x.tenant).join(" and ");

  // The user's answers, applied over the hub's reading.
  const settled = new Set();
  for (const a of answers) {
    settled.add(a.row_id);
    const whose = new Set((a.whose || []).map((w) => w.deposit_id));
    const trail = (r) => trailOf.get(r.id) || [];
    const linked = (r) => trail(r).some((t) => t.rowId === a.row_id);
    const newer = (r) => trail(r).some((t) => t.rowId !== a.row_id && String(t.date || "") > a.date);
    // Whose it was: where the row put the money, until the hub records them moving again.
    for (const w of a.whose || []) {
      const r = byId.get(w.deposit_id);
      if (!open(r) || newer(r)) continue;
      const { location, account } = locationOf(a.to, depositMask);
      Object.assign(r, {
        location, location_account_mask: account,
        location_basis: `${owner()}, ${a.said_on}: the ${usd(a.amount)} moved from ••${a.from} on ${a.date} was ${names(a.whose)}'s`,
        amount_in_deposit_account: location === "deposit_account" ? round2(w.amount) : null,
        answered: { row_id: a.row_id, said_on: a.said_on },
      });
    }
    // Everyone else the hub credits the row to, named or not, lost the only
    // evidence of where their money is. Counting the row for them too would put
    // one transfer in the deposit account twice.
    const unknownIds = new Set([...(a.unknown || []).map((u) => u.deposit_id), ...rows.filter((r) => linked(r)).map((r) => r.id)]);
    for (const id of unknownIds) {
      const r = byId.get(id);
      if (whose.has(id) || !open(r) || (!linked(r) && newer(r))) continue;
      Object.assign(r, {
        location: "unconfirmed", location_account_mask: null, amount_in_deposit_account: null,
        location_basis: `${owner()}, ${a.said_on}: the ${a.date} transfer from ••${a.from} was ${names(a.whose)}'s, not this deposit`,
        answered: { row_id: a.row_id, said_on: a.said_on },
      });
    }
  }

  // One transfer, two readings. A transfer from a home's account into the
  // deposit account that the hub credits to one set of tenants, while another
  // set whose money the hub shows still in that home's account (and already
  // there by that date) adds up to the same amount: the amount cannot say whose
  // it was, so it is asked, and neither set is called missing or located.
  const transfers = new Map();
  for (const d of all) for (const t of d.whereabouts?.trail || []) {
    if (!t.rowId || t.to !== depositMask || t.from === depositMask || !/^\d{4}$/.test(String(t.from)) || settled.has(t.rowId)) continue;
    const x = transfers.get(t.rowId) || { row_id: t.rowId, date: t.date, from: String(t.from), description: t.description || "", total: 0, linked: [] };
    x.total = round2(x.total + Number(t.amount || 0));
    x.linked.push({ id: d.id, tenant: String(d.tenant || "").trim(), amount: round2(t.amount) });
    transfers.set(t.rowId, x);
  }
  const fitsTwo = [];
  for (const x of [...transfers.values()].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))) {
    const linked = new Set(x.linked.map((l) => l.id));
    const arrivedBy = (r) => {
      const ins = (trailOf.get(r.id) || []).filter((t) => String(t.to) === x.from);
      return ins.length ? ins.some((t) => t.date <= x.date) : Boolean(r.received_on && r.received_on <= x.date);
    };
    const cands = rows.filter((r) => !linked.has(r.id) && open(r) && !r.answered && r.expected_location === "deposit_account"
      && r.location === "operating_account" && r.location_account_mask === x.from && arrivedBy(r))
      .map((r) => ({ id: r.id, tenant: r.tenant, amount: round2(r.positions.find((p) => p.place === x.from)?.amount ?? 0) }))
      .filter((c) => c.amount > 0);
    if (!cands.length || cands.length > 16) continue;
    const sets = [];
    for (let m = 1; m < 1 << cands.length; m++) {
      const set = cands.filter((_, i) => m & (1 << i));
      if (Math.abs(set.reduce((s, c) => s + c.amount, 0) - x.total) < 0.005) sets.push(set);
    }
    if (!sets.length) continue;
    const alt = sets[0];
    for (const id of [...linked, ...sets.flat().map((c) => c.id)]) {
      const r = byId.get(id);
      if (!open(r) || r.answered) continue;
      Object.assign(r, {
        location: "ambiguous", location_account_mask: x.from, amount_in_deposit_account: null,
        location_basis: `hub link questioned: the ${usd(x.total)} moved from ••${x.from} on ${x.date} fits more than one set of tenants`,
        question_row: x.row_id,
      });
    }
    const opt = (set) => set.map((c) => `${c.tenant} (${usd(c.amount)})`).join(" + ");
    const plural = alt.length > 1;
    fitsTwo.push({
      kind: "transfer-fits-two", row_id: x.row_id, plaid_transaction_id: String(x.row_id).replace(/^plaid:/, ""),
      date: x.date, amount: x.total, from: x.from, to: depositMask, description: x.description,
      recorded: x.linked, options: [x.linked, ...sets].map((set) => set.map((c) => ({ id: c.id, tenant: c.tenant, amount: c.amount }))),
      text: `The ${usd(x.total)} moved from ••${x.from} into the deposit account on ${x.date} is recorded in the hub as ${names(x.linked)}'s, but ${names(alt)} ${plural ? "add" : "adds"} up to the same amount and the hub shows ${plural ? "their deposits" : "that deposit"} still in ••${x.from}. Whose money it was is an open question; until it is answered, none of them is called missing.`,
      question: `Whose was the ${usd(x.total)} moved from ••${x.from} into the deposit account on ${x.date}: ${opt(x.linked)}, or ${sets.map(opt).join(", or ")}?`,
      answer_with: `${answerCommand()} ${x.row_id} --whose "<tenant>, <tenant>" [--unknown "<tenant>"] --said "<the user's own words>"`,
    });
  }

  const tracked = rows.filter((r) => !["closed", "unpaid", "refunded"].includes(r.location));
  // Missing = the hub's record shows a held deposit's money outside the deposit
  // account, with no admin saying that is fine. Nothing else: a deposit whose
  // transfer is in question, or whose whereabouts the user said are not known, is
  // neither missing nor located.
  const missing = tracked.filter((r) => r.expected_location === "deposit_account" && !["deposit_account", "in_transit", "ambiguous", "unconfirmed"].includes(r.location));
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
    rows, movements: [], ambiguities: [...unanswered, ...fitsTwo],
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
    liability: round2(tracked.reduce((s, r) => s + r.amount, 0)),
  };
}

const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The user's answer to "whose was this transfer?", shaped for
 * data/finance-deposit-answers.jsonl (the `deposit_answer_command`).
 * The row must be one the hub has linked to some deposit (it is in that
 * deposit's whereabouts trail), so its date, accounts and total come from the
 * hub's record, not from the caller; a row nobody has linked is answered in the
 * hub. Tenants are named exactly as the hub has them, or by deposit id.
 * Throws with a plain reason when the answer cannot be recorded.
 *
 * @param {object} p
 * @param {string} p.rowId  bank row id, with or without the "plaid:" prefix
 * @param {object[]} p.deposits  the hub's billing-deposits docs
 * @param {string} p.depositMask
 * @param {string[]} p.whose  tenants whose money the row moved
 * @param {string[]} [p.unknown]  further tenants whose deposit is then of unknown whereabouts
 *   (everyone the hub credits the row to who is not in `whose` is added anyway)
 * @param {string} p.said  the user's own words
 * @param {string} p.saidOn  YYYY-MM-DD
 */
function depositAnswer({ rowId, deposits, depositMask, whose, unknown = [], said, saidOn }) {
  const id = String(rowId).trim().startsWith("plaid:") ? String(rowId).trim() : `plaid:${String(rowId).trim()}`;
  const legs = deposits.flatMap((d) => (d.whereabouts?.trail || []).filter((t) => t.rowId === id));
  if (!legs.length) throw new Error(`no deposit in the hub has ${id} in its record; a row nobody has linked is answered in the hub (Financials -> Security deposits)`);
  if (String(legs[0].to) !== String(depositMask)) throw new Error(`${id} is not a transfer into the deposit account ••${depositMask}`);
  const total = round2(legs.reduce((s, t) => s + Number(t.amount || 0), 0));
  const held = deposits.filter((d) => HELD.has(d.status) && Number(d.amount) > 0);
  const pick = (ref) => {
    const key = String(ref).trim();
    const hits = held.filter((d) => d.id === key || String(d.tenantName || "").trim().toLowerCase() === key.toLowerCase());
    if (hits.length !== 1) throw new Error(`"${key}" matches ${hits.length} held deposits${hits.length ? ` (${hits.map((h) => h.id).join(", ")}): name it by deposit id` : ""}`);
    return { deposit_id: hits[0].id, tenant: String(hits[0].tenantName).trim(), amount: round2(hits[0].amount) };
  };
  const w = whose.map(pick), named = unknown.map(pick);
  if (!w.length) throw new Error("name whose money it was (--whose)");
  if (named.some((x) => w.some((y) => y.deposit_id === x.deposit_id))) throw new Error("a tenant cannot be both whose it was and unknown");
  // Whoever the hub credits the row to and is not in `whose` lost the only
  // evidence of where their money is, so they are unknown whether named or not.
  const credited = held.filter((d) => (d.whereabouts?.trail || []).some((t) => t.rowId === id) && !w.some((y) => y.deposit_id === d.id))
    .map((d) => ({ deposit_id: d.id, tenant: String(d.tenantName).trim(), amount: round2(d.amount) }));
  const u = [...named, ...credited.filter((c) => !named.some((x) => x.deposit_id === c.deposit_id))];
  const sum = round2(w.reduce((s, x) => s + x.amount, 0));
  if (Math.abs(sum - total) >= 0.005) throw new Error(`${w.map((x) => x.tenant).join(" + ")} add up to ${usd(sum)}; the transfer was ${usd(total)}`);
  if (!String(said || "").trim()) throw new Error(`--said needs ${owner()}'s own words`);
  return {
    row_id: id, date: legs[0].date, amount: total, from: String(legs[0].from), to: String(legs[0].to),
    whose: w, unknown: u, said_on: saidOn, said: String(said).trim(),
  };
}

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
  if (!p.ok) flags.push({ priority: 96, tag: "deposit-recon-unbalanced", text: `The deposit account does not reconcile: ${usd(p.deposit_account_balance)} in the account vs ${usd(p.located_total)} of located deposits + ${usd(p.unattributed_total)} not tied to a current deposit — off by ${usd(p.difference)}.` });
  const where = (x) => x.location === "operating_account" ? `in ••${x.location_account_mask || "?"} (the property's operating account)`
    : x.location === "stripe_paid" ? "paid through Stripe, no payout has reached the deposit account"
    : x.location === "closing_credit_unfunded" ? "credited at closing, never funded into any account"
    : x.location === "untraced" ? "no bank row shows where it is: link its rows, or set where it started, on the tenant's card in the hub"
    : x.location === "unconfirmed" ? `not known (${x.location_basis})`
    : x.location === "ambiguous" ? `the deposit account or ••${x.location_account_mask || "?"}: whose the transfer was is an open question`
    : x.location;
  const groups = (r.ambiguities || []).filter((a) => a.kind === "stripe-group");
  const grouped = new Set(groups.flatMap((g) => g.deposits));
  const missing = (r.missing || []).filter((x) => !grouped.has(x.id)).map((x) => ({
    property_name: x.property_name, state: x.state, lease_number: x.lease_number, tenant: x.tenant, amount_fmt: usd(x.amount), where: where(x), basis: x.location_basis,
  }));
  for (const m of missing) flags.push({ priority: 86, tag: "deposit-missing", text: `${m.tenant}'s ${m.amount_fmt} deposit (${m.property_name} lease ${m.lease_number}${m.state ? `, ${m.state}` : ""}) is not in the deposit account: ${m.where}.` });
  for (const g of groups) {
    const ds = (r.rows || []).filter((x) => g.deposits.includes(x.id));
    const paid = ds.reduce((s, x) => s + x.amount, 0);
    flags.push({ priority: 84, tag: "deposit-missing", text: `${ds[0]?.property_name} lease ${g.lease_number}: ${ds.length} deposits paid through Stripe (${usd(paid)}, ${ds.map((x) => x.tenant).join(", ")}); ${g.payouts} payout(s) totalling ${usd(g.arrived_total)} have reached the deposit account, so ${ds.length - g.payouts} have not — which ones needs Stripe payout data.` });
  }
  for (const x of r.in_transit || []) flags.push({ priority: 40, tag: "deposit-in-transit", text: `${x.tenant}'s ${usd(x.amount)} deposit (${x.property_name} lease ${x.lease_number}) is on its way to the deposit account; expected ${fmtD(x.expected_arrival)}.` });
  const shortRows = (r.rows || []).filter((x) => x.fee_shortfall > 0);
  if (shortRows.length) flags.push({ priority: 62, tag: "deposit-fee-shortfall", text: `Beyond the accepted $2.50 Stripe fee, the deposit account is ${usd(shortRows.reduce((s, x) => s + x.fee_shortfall, 0))} short of what it owes: ${shortRows.map((x) => `${x.tenant} ${usd(x.fee_shortfall)}`).join(", ")}.` });
  for (const a of (r.ambiguities || []).filter((a) => a.kind === "sweep" || a.kind === "transfer-fits-two")) flags.push({ priority: 70, tag: "deposit-ambiguous", text: a.text });
  // A transfer that fits two sets of tenants is asked, with the command that answers it.
  const questions = (r.ambiguities || []).filter((a) => a.kind === "transfer-fits-two")
    .map((a) => ({ id: `deposit:${a.row_id}`, text: a.question, answer_with: a.answer_with }));
  // Rows nobody has attributed, with no tenant set that fits them: mostly the
  // years before the hub tracked deposits. One line, not one flag each.
  const loose = (r.ambiguities || []).filter((a) => a.kind === "unlinked");
  if (loose.length) flags.push({ priority: 45, tag: "deposit-unattributed-rows", text: `${loose.length} row(s) on the deposit account are not attributed to any tenant (latest ${loose[0].date}, ${usd(loose[0].amount)}). Answer them in the hub: Financials -> Security deposits.` });
  const rows = (r.rows || []).filter((x) => x.location !== "closed");
  const unpaid = rows.filter((x) => x.location === "unpaid" && x.lease_start && x.lease_start <= today);
  for (const x of unpaid) flags.push({ priority: 82, tag: "deposit-unpaid", text: `${x.tenant} has not paid a ${usd(x.amount)} deposit (${x.property_name} lease ${x.lease_number}, started ${fmtD(x.lease_start)}).` });
  const ended = rows.filter((x) => x.lease_end && x.lease_end < today && !["refunded", "unpaid", "closed"].includes(x.location));
  for (const x of ended) flags.push({ priority: 80, tag: "deposit-not-returned", text: `${x.tenant}'s ${usd(x.amount)} deposit (${x.property_name} lease ${x.lease_number}) is still held; the lease ended ${fmtD(x.lease_end)}.` });
  const big = (p.unattributed_txns || []).filter((t) => Math.abs(t.amount) >= 1);
  return {
    flags, questions,
    section: {
      run_at: run.run_at, deposit_account: r.deposit_account, ok: p.ok,
      balance_fmt: usd(p.deposit_account_balance), located_fmt: usd(p.located_total), unattributed_fmt: usd(p.unattributed_total),
      opening_fmt: usd(p.opening_before_history), difference_fmt: usd(p.difference), liability_fmt: usd(r.liability), liability: r.liability,
      missing, groups: groups.map((g) => g.text),
      unconfirmed: rows.filter((x) => x.location === "unconfirmed").map((x) => `${x.tenant} ${usd(x.amount)}`),
      in_question: rows.filter((x) => x.location === "ambiguous").map((x) => `${x.tenant} ${usd(x.amount)}`),
      in_transit: (r.in_transit || []).map((x) => `${x.tenant} ${usd(x.amount)} (expected ${fmtD(x.expected_arrival)})`),
      rows: rows.map((x) => ({ property_name: x.property_name, lease_number: x.lease_number, tenant: x.tenant, amount_fmt: usd(x.amount), location: x.location === "deposit_account" ? (x.fee_shortfall ? `deposit account (${usd(x.fee_shortfall)} short beyond the accepted fee)` : x.fee_absorbed ? `deposit account (less ${usd(x.fee_absorbed)} Stripe fee — accepted)` : x.answered ? `deposit account (per ${owner()}, ${x.answered.said_on})` : "deposit account") : x.location === "in_transit" ? `in transit, expected ${fmtD(x.expected_arrival)}` : where(x), exception: x.expected_location === "exception" ? x.exception_reason : null, basis: x.location_basis })),
      unattributed: big.map((t) => `${t.date} ${usd(t.amount)} ${t.name}`),
    },
  };
}

module.exports = { depositsFromHub, depositSection, depositAnswer };
