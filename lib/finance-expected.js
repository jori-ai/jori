"use strict";
// finance-expected — the two forward-looking questions every finance surface
// asks, answered ONLY from facts the user recorded (fin_expected_income,
// fin_scheduled_payments). Shared by the weekly review and the `finance` hum
// harvester so the two can never disagree.
//
// Until 2026-10-04 both answered from history alone: any inflow seen twice
// became an "income stream" (two credit-card payment credits were reported as
// income 15 and 53 days late), and any large debit seen twice became an
// "autopay" (a manual epay was announced as "autopay set to pull from
// checking"). A pattern in history is a prediction. These functions only speak
// about what was recorded, and say nothing about the rest.

const DAY = 86400000;
const dayAdd = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Next date on or after `today` that falls on `dueDay` (clamped to month length). */
function nextDueDate(dueDay, today) {
  const [y, m] = today.split("-").map(Number);
  const mk = (yy, mm) => {
    const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    return `${yy}-${String(mm).padStart(2, "0")}-${String(Math.min(dueDay, last)).padStart(2, "0")}`;
  };
  const thisMonth = mk(y, m);
  return thisMonth >= today ? thisMonth : mk(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
}

/**
 * Status of each registered income stream for its current cycle.
 * received: a transaction the classifier tied to this stream arrived since a
 * week before the cycle's due date. late: past due + grace, nothing arrived.
 */
function incomeStatus(expected, posted, cls, today) {
  const rows = [];
  for (const e of expected || []) {
    if (e.active_from > today || (e.active_to && e.active_to < today)) continue;
    if (e.due_day == null) {
      // No due day recorded (an amount invoiced by weeks worked): report what
      // arrived this month, never call it late.
      const hits = (posted || []).filter((t) => cls.get(t.transaction_id)?.expected_income_id === e.id && t.date >= `${today.slice(0, 7)}-01`);
      rows.push({ stream: e, cycle_due: null, status: hits.length ? "received this month" : "none yet this month", received_on: hits[0]?.date || null });
      continue;
    }
    // The cycle is the due date of the window actually being judged — this
    // month's, or (more than a week before it) LAST month's real due date.
    // Callers key dedup on cycle_due, so it must name the missed window: the
    // 2026-10 "15d late" ping that carried month "2026-08" (it keyed on the
    // last date SEEN) is the failure this guards. Last month is computed as a
    // calendar month, not "minus 30 days", which drifted for due days 29-31.
    const [y, m] = today.split("-").map(Number);
    const dueIn = (yy, mm) => {
      const day = Math.min(e.due_day, new Date(Date.UTC(yy, mm, 0)).getUTCDate());
      return `${yy}-${String(mm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    };
    const dueThis = dueIn(y, m);
    const cycleDue = today >= dayAdd(dueThis, -7) ? dueThis : (m === 1 ? dueIn(y - 1, 12) : dueIn(y, m - 1));
    const hits = (posted || []).filter((t) => cls.get(t.transaction_id)?.expected_income_id === e.id && t.date >= dayAdd(cycleDue, -7));
    const status = hits.length ? "received" : today > dayAdd(cycleDue, e.grace_days ?? 3) ? "late" : "not yet due";
    rows.push({ stream: e, cycle_due: cycleDue, status, received_on: hits[0]?.date || null });
  }
  return rows;
}

/**
 * Confirmed scheduled payments due within `horizonDays`, with the amount when
 * the rule makes it knowable and the funding account's available balance.
 */
function scheduledDue(scheduled, accounts, today, horizonDays) {
  const byId = new Map((accounts || []).map((a) => [a.account_id, a]));
  const num = (v) => { const n = Number(v); return v == null || !Number.isFinite(n) ? null : n; };
  const out = [];
  for (const s of scheduled || []) {
    if (s.active === false) continue;
    const due = nextDueDate(s.due_day, today);
    if ((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY > horizonDays) continue;
    let amount = null, basis;
    if (s.amount_rule === "fixed") { amount = num(s.fixed_amount); basis = "fixed amount"; }
    else if (s.amount_rule === "current_balance" && s.target_account_id && byId.has(s.target_account_id)) {
      amount = num(byId.get(s.target_account_id).balance_current); basis = "up to the card's current balance";
    } else basis = "amount not known — no statement data (Plaid liabilities is off)";
    const f = byId.get(s.funding_account_id) || {};
    const available = num(f.balance_available) ?? num(f.balance_current);
    out.push({
      payment: s, due, amount, amount_basis: basis, available,
      short: amount != null && f.type === "depository" && available != null && available < amount,
    });
  }
  return out;
}

module.exports = { nextDueDate, incomeStatus, scheduledDue };
