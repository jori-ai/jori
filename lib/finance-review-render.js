"use strict";
// finance-review-render — the weekly finance review email, as HTML, from the
// packet alone.
//
// Code renders every table and every flag, so nothing in the body can say what
// the packet does not. The model's only text is the verified summary
// (finance-review-verify.js), placed at the top when it passes; when it does
// not, the email goes without it.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const CSS = `
body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d1d1f;max-width:760px;margin:0 auto;padding:16px;font-size:14px;line-height:1.45}
h1{font-size:20px;margin:0 0 2px}h2{font-size:16px;margin:22px 0 6px;border-bottom:1px solid #e5e5e5;padding-bottom:3px}
.sub{color:#6e6e73;font-size:12px;margin-bottom:12px}
table{border-collapse:collapse;width:100%;margin:4px 0 8px;font-size:13px}
th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #f0f0f0;vertical-align:top}
th{color:#6e6e73;font-weight:600;font-size:12px}td.n,th.n{text-align:right;white-space:nowrap}
.flag{margin:3px 0}.warn{color:#b3261e;font-weight:600}.muted{color:#6e6e73;font-size:12px}
.summary{background:#f5f5f7;border-radius:8px;padding:10px 12px;margin:10px 0}
.q{margin:6px 0}.q code{font-size:11px;color:#6e6e73;display:block;white-space:pre-wrap}
tr.roll td{font-weight:600;background:#fafafa}`;

function table(head, rows, numericCols = []) {
  if (!rows.length) return "";
  const th = head.map((h, i) => `<th${numericCols.includes(i) ? ' class="n"' : ""}>${esc(h)}</th>`).join("");
  const tr = rows.map((r) => `<tr${r._class ? ` class="${r._class}"` : ""}>${r.cells.map((c, i) => `<td${numericCols.includes(i) ? ' class="n"' : ""}>${c}</td>`).join("")}</tr>`).join("");
  return `<table><tr>${th}</tr>${tr}</table>`;
}
const row = (cells, cls) => ({ cells: cells.map((c) => (c && c.__html ? c.__html : esc(c))), _class: cls });
const html = (s) => ({ __html: s });
const line = (s) => `<div class="flag">${esc(s)}</div>`;

/**
 * @param {object} p        the packet
 * @param {object|null} summary  verified summary ({sentences}) or null
 */
const cap = (x) => String(x).charAt(0).toUpperCase() + String(x).slice(1);

function renderReview(p, summary) {
  const out = [];
  const m = p.meta;
  out.push(`<h1>Weekly finance review — week ending ${esc(fmtLong(m.week_end))}</h1>`);
  out.push(`<div class="sub">Generated ${esc(m.generated_at)}. Every figure is computed from records; nothing here is estimated by a model.${m.ledger_available ? "" : ` <span class="warn">${esc(cap(m.ledger_label || "rental ledger"))} unavailable (${esc(m.ledger_error)}): property and deposit sections are absent.</span>`}</div>`);

  if (summary && summary.sentences?.length) {
    out.push(`<div class="summary">${summary.sentences.map((s) => esc(s.text)).join(" ")}</div>`);
  }

  // 1. Attention
  out.push("<h2>⚠️ Worth your attention</h2>");
  out.push(p.attention.length ? p.attention.map((a) => line(a.text)).join("") : line("Nothing urgent this week."));

  // 2. Cash position
  const cp = p.cash.position;
  if (cp) {
    out.push("<h2>Cash position</h2>");
    out.push(table(["Bucket", "Total", "Week Δ"], [
      ...cp.buckets.map((b) => row([b.label, b.total_fmt, b.week_delta_fmt])),
      row(["Free cash", cp.free_cash_fmt, cp.free_cash_week_delta_fmt], "roll"),
    ], [1, 2]));
    const brokerage = cp.buckets.find((b) => b.key === "brokerage_taxable");
    if (brokerage?.detail) out.push(`<div class="muted">${esc(brokerage.label)}: ${esc(brokerage.detail)}.</div>`);
    out.push(`<div class="muted">Outside free cash: ${esc(cp.restricted_fmt)} in the security-deposit account (tenant money) · ${esc(cp.retirement_cash_fmt)} of cash inside 401k/Roth/HSA${cp.unmapped.length ? ` · unmapped: ${esc(cp.unmapped.join(", "))}` : ""}. Card balances: ${esc(p.cash.card_debt_fmt)}. ${esc(cp.delta_note)}.</div>`);
  }

  // 3. Flow + runway + next 14 days
  const f = p.cash.flow;
  out.push("<h2>This week's money, by what it was</h2>");
  out.push(table(["", "Amount"], [
    row(["Income arrived", f.income_in_fmt]),
    row(["Tenant deposits arrived (deposit account)", f.deposits_in_fmt]),
    row(["Arrived, not yet explained", f.unexplained_in_fmt]),
    row(["Spending (cards + bank)", f.spending_fmt]),
    row(["Refunds", f.refunds_fmt]),
    row(["Card payments from bank accounts", f.card_payments_from_bank_fmt]),
    row(["Moved to / from your other institutions", `${f.to_your_other_accounts_fmt} out · ${f.from_your_other_accounts_fmt} in`]),
    row(["Capital (asset purchases you classified)", f.capital_fmt]),
    row(["Large outflows not yet classified", f.unreviewed_large_fmt]),
  ], [1]));
  if (p.cash.runway_days != null) out.push(`<div>Runway: <b>${esc(p.cash.runway_days)} days</b> at ${esc(p.cash.daily_spend_fmt)}/day. <span class="muted">${esc(p.cash.runway_basis)}.</span></div>`);
  if (p.cash.upcoming_14d.length) {
    out.push("<h2>Next 14 days</h2>");
    out.push(table(["Due", "What", "Amount", "From", "Source"], p.cash.upcoming_14d.map((u) => row([
      u.due_fmt, u.label, u.amount_fmt, u.account,
      u.source === "confirmed" ? `confirmed by you${u.autopay ? ", autopay" : ""}` : `predicted by ${m.recurring_label || "the Recurring tracker"} from ${u.predicted_from} charge(s)`,
    ])), [2]));
  }
  if (p.cash.unconfirmed_card_payments.length) {
    out.push(`<div class="muted">Card payments seen in the last 45 days that no confirmed schedule explains (history, not a forecast): ${esc(p.cash.unconfirmed_card_payments.map((u) => `${u.who} ${u.amount_fmt} on ${u.last_date_fmt} from ${u.account}`).join("; "))}.</div>`);
  }

  // 4. Income
  out.push("<h2>Income &amp; rent</h2>");
  if (p.income.registered.length) {
    out.push(table(["Stream", "Amount", "Due", "Status", "Into"], p.income.registered.map((r) => row([r.label, r.amount_fmt, r.due_fmt, r.status + (r.received_on ? ` (${r.received_on})` : ""), r.account])), [1]));
  } else if (p.income.note) out.push(`<div class="muted">${esc(p.income.note)}</div>`);
  if (p.income.rent.length) {
    out.push(table(["Long-term property", "Rent roll / mo", "Rental income this month"], p.income.rent.map((r) => row([r.name + (r.has_account ? "" : " (no bank account in registry)"), r.rent_roll_fmt, r.received_mtd_fmt])), [1, 2]));
  }
  if (p.income.rent_invoices_open?.length) out.push(`<div class="muted">Hub rent invoices past due and still open: ${esc(p.income.rent_invoices_open.map((r) => `${r.property_name} ${r.count} (${r.total_fmt}, oldest due ${r.oldest_due_fmt})`).join("; "))}.</div>`);

  // 4b. The user's own invoices, reconciled
  const iv = p.invoices;
  if (iv) {
    out.push(`<h2>${esc(p.invoices_label || "Client")} invoices (yours)</h2>`);
    out.push(`<div>${esc(iv.invoiced_fmt)} invoiced = ${esc(iv.paid_fmt)} paid + ${esc(iv.outstanding_fmt)} open — ${iv.ok ? "reconciled to the cent" : `<span class="warn">does not reconcile</span>`} <span class="muted">(${esc(iv.scope)})</span>.</div>`);
    if (iv.open.length) out.push(table(["Invoice", "Dated", "Amount", "Open", "Due", "Status"], iv.open.map((x) => row([x.number, x.date_fmt, x.amount_fmt, x.open_fmt, x.due_fmt, x.status])), [2, 3]));
    else out.push(`<div class="muted">No open invoices. Latest paid: ${esc(iv.recent.map((x) => `${x.number} (${x.date_fmt}) paid ${x.paid_on_fmt}, ${x.days} days`).join("; "))}.</div>`);
  }

  // 5. Real estate
  const re = p.real_estate;
  if (re) {
    out.push("<h2>Real estate</h2>");
    const pr = (x, cls) => row([x.name || x.label, x.cash_fmt, x.week_net_fmt, x.mtd_net_fmt, x.ytd_net_fmt, x.reserve_fmt ? (x.reserve_fmt + (x.reserve_low ? " ⚠" : "")) : "", x.value_fmt], cls);
    const st = re.properties.filter((x) => x.rental_type === "short-term"), lt = re.properties.filter((x) => x.rental_type === "long-term");
    out.push(table(["Property", "Cash", "Week net", "MTD net", "YTD net", "Reserve", "Value"], [
      ...st.map((x) => pr(x)), ...(re.short_term ? [pr(re.short_term, "roll")] : []),
      ...lt.map((x) => pr(x)), ...(re.long_term ? [pr(re.long_term, "roll")] : []),
      ...(re.portfolio ? [pr(re.portfolio, "roll")] : []),
    ], [1, 2, 3, 4, 5, 6]));
    for (const s of re.sold_this_year) out.push(`<div class="muted">${esc(s.name)} (sold ${esc(s.disposed_on_fmt)}) YTD net ${esc(s.ytd_net_fmt)}; portfolio YTD net including it: ${esc(re.portfolio_ytd_net_including_sold_fmt)}.</div>`);
    for (const u of re.unsplit_values) out.push(`<div class="muted">${esc(u)}</div>`);
    out.push(`<div class="muted">${esc(re.note)}</div>`);
  }

  // 6. Deposits — the reconciliation, as recorded
  const d = p.deposits;
  if (d) {
    out.push("<h2>Security deposits</h2>");
    out.push(`<div>Owed back to tenants: <b>${esc(d.liability_fmt)}</b>. Deposit account (${esc(d.deposit_account)}): <b>${esc(d.balance_fmt)}</b> = ${esc(d.located_fmt)} of current deposits located there + ${esc(d.unattributed_fmt)} tied to no current deposit — ${d.ok ? "reconciled to the cent" : `<span class="warn">off by ${esc(d.difference_fmt)}</span>`}.</div>`);
    if (d.missing.length || d.groups.length) {
      out.push(`<div class="warn">Not in the deposit account:</div>`);
      out.push(table(["Property", "Lease", "Tenant", "Amount", "Where it is"], d.missing.map((m) => row([`${m.property_name}${m.state ? ` (${m.state})` : ""}`, m.lease_number, m.tenant, m.amount_fmt, m.where])), [3]));
      for (const g of d.groups) out.push(`<div class="muted">${esc(g)}</div>`);
    }
    if (d.in_transit?.length) out.push(`<div class="muted">On the way to the deposit account (hub transfer in flight): ${esc(d.in_transit.join("; "))}.</div>`);
    out.push(table(["Property", "Lease", "Tenant", "Amount", "Location"], d.rows.map((r) => row([r.property_name, r.lease_number, r.tenant, r.amount_fmt, r.location + (r.exception ? " — exception" : "")])), [3]));
    if (d.unattributed.length) out.push(`<div class="muted">In the account but tied to no current deposit: ${esc(d.opening_fmt)} from before the bank history, plus ${esc(d.unattributed.join("; "))}.</div>`);
    out.push(`<div class="muted">Read ${esc(String(d.run_at).slice(0, 16).replace("T", " "))} UTC from the hub's per-tenant deposit record (Financials -> Security deposits).</div>`);
  }

  // 7. Spending
  const s = p.spending;
  out.push("<h2>Spending</h2>");
  out.push(`<div>${esc(s.week_total_fmt)} this week vs ${esc(s.prior_week_total_fmt)} the week before (classified spending only).</div>`);
  out.push(table(["Category", "This week", "Prior week", "Avg week, 90d"], s.by_category.slice(0, 8).map((c) => row([c.category, c.this_week_fmt, c.prior_week_fmt, c.avg_week_90d_fmt])), [1, 2, 3]));
  out.push(table(["Largest", "Account", "Date", "Amount"], s.largest.map((t) => row([t.who, t.account, t.date_fmt, t.amount_fmt])), [3]));
  if (s.leakage.length) out.push(`<div class="muted">Category/owner mismatches: ${esc(s.leakage.map((l) => `${l.who} ${l.amount_fmt} on ${l.account} (${l.direction})`).join("; "))}.</div>`);

  // 8. Cards
  const c = p.cards;
  out.push("<h2>Cards</h2>");
  out.push(table(["Card", "Balance", "Limit", "Utilization"], c.items.map((i) => row([i.label, i.balance_fmt, i.limit_fmt, i.utilization_fmt])), [1, 2, 3]));
  out.push(`<div class="muted">Aggregate utilization ${esc(c.aggregate_utilization_fmt)} (${esc(c.utilization_basis)}). Interest charges in the last 14 days: ${c.interest.length ? esc(c.interest.map((i) => `${i.amount_fmt} on ${i.account}`).join("; ")) : "none"}.</div>`);

  // 9. Recurring
  const r = p.recurring;
  out.push("<h2>Recurring</h2>");
  out.push(`<div>${esc(r.active_count)} active recurring items, ${esc(r.monthly_equivalent_fmt)}/mo equivalent; ${esc(r.undecided_count)} without a decision. <span class="muted">Source: ${esc(r.source)}.</span></div>`);
  if (r.price_changes.length) out.push(`<div class="muted">Amount changes this week: ${esc(r.price_changes.map((x) => `${x.name} ${x.from_fmt} → ${x.to_fmt}`).join("; "))}.</div>`);
  if (r.renewals_30d.length) out.push(`<div class="muted">Annual renewals in 30 days: ${esc(r.renewals_30d.map((x) => `${x.name} ${x.amount_fmt} ~${x.due_fmt} (${x.decision})`).join("; "))}.</div>`);

  // 10. Net worth
  const nw = p.networth;
  out.push("<h2>Net worth (awareness)</h2>");
  out.push(table(["", "Value", "As of"], [...nw.lines.map((l) => row([l.label + (l.note ? ` — ${l.note}` : ""), l.value_fmt, l.as_of || ""])), row(["Net worth", nw.net_worth_fmt, ""], "roll")], [1]));
  out.push(`<div class="muted">${esc(nw.note)}</div>`);

  // 11. Tax
  if (p.tax.next_due_fmt) out.push(`<h2>Tax (awareness)</h2><div>Next federal estimated-tax date: ${esc(p.tax.next_due_fmt)} (${esc(p.tax.days_until)} days).</div>`);

  // 12. Questions
  if (p.questions.length) {
    out.push("<h2>Open questions (the review will not guess these)</h2>");
    out.push(p.questions.map((q) => `<div class="q">• ${esc(q.text)}<code>${esc(q.answer_with)}</code></div>`).join(""));
  }

  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${out.join("\n")}</body></html>`;
}

function fmtLong(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

module.exports = { renderReview };
