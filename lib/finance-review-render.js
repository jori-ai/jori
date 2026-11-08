"use strict";
// finance-review-render — the weekly finance review email, as HTML, from the
// packet alone.
//
// Code renders every table and every flag, so nothing in the body can say what
// the packet does not. The model's only text is the verified summary
// (finance-review-verify.js), placed at the top when it passes; when it does
// not, the email goes without it.
//
// Layout (the user, 2026-11-08: "do a proper design for the entire email"):
// a header with the four numbers that matter, then "Worth your attention" in
// tiers with the one action each flag has, then one card per section. Styles
// are inline: mail clients drop or rewrite <style> blocks, and a table-based
// layout is the one every client lays out the same way. Design arranges and
// colours the packet's text; it adds none.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const cap = (x) => String(x).charAt(0).toUpperCase() + String(x).slice(1);

// ── Design tokens ───────────────────────────────────────────────────────────
const C = {
  ink: "#1d1d1f", muted: "#6e6e73", faint: "#8e8e93", line: "#e5e5ea", soft: "#f5f5f7", page: "#eef0f3", card: "#ffffff",
  green: "#1b7f3b", greenBg: "#e8f5ec", red: "#b3261e", redBg: "#fdf0ef", amber: "#a15c00", amberBg: "#fff4e0",
  blue: "#0b57d0", blueBg: "#e8f0fe", gray: "#5f6368", grayBg: "#f1f3f4",
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const NUM = "font-variant-numeric:tabular-nums;white-space:nowrap";
const TONES = { green: [C.green, C.greenBg], red: [C.red, C.redBg], amber: [C.amber, C.amberBg], blue: [C.blue, C.blueBg], gray: [C.gray, C.grayBg] };

// The repeated pieces (table cells, pills, cards, notes) are classes in one
// <style> block: inlined on every cell they made the email ~130 KB, past the
// ~102 KB at which Gmail clips a message and hides the rest behind a link.
// One-off accents stay inline.
const CSS = `
.t{border-collapse:collapse;width:100%;font-size:13px;line-height:1.4;margin:4px 0 2px}
.t th{text-align:left;padding:6px 8px;border-bottom:1px solid ${C.line};color:${C.faint};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.t td{text-align:left;padding:6px 8px;border-bottom:1px solid ${C.line};vertical-align:top}
.t .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.t tr.g td{font-weight:700;background:${C.soft}}.t tr.tot td{font-weight:700;border-top:2px solid ${C.ink}}
.t tr.s td{color:${C.muted}}.t tr.s td.i{padding-left:22px}
.x{color:${C.faint};font-size:11px;line-height:1.35;margin-top:1px}.m{color:${C.muted}}
.p{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;line-height:17px;white-space:nowrap}
.pgreen{background:${C.greenBg};color:${C.green}}.pred{background:${C.redBg};color:${C.red}}.pamber{background:${C.amberBg};color:${C.amber}}.pblue{background:${C.blueBg};color:${C.blue}}.pgray{background:${C.grayBg};color:${C.gray}}
.note{color:${C.muted};font-size:12px;line-height:1.45;margin-top:6px}
.card{border-collapse:separate;background:${C.card};border-radius:12px;margin:0 0 14px;border:1px solid ${C.line}}
.ct{font-size:16px;font-weight:700;color:${C.ink};padding:0 0 4px}.cf{text-align:right;font-size:16px;font-weight:700;padding:0 0 4px;font-variant-numeric:tabular-nums;white-space:nowrap}
.cn{color:${C.muted};font-size:12px;padding:0 0 6px}
.bar{display:inline-block;vertical-align:middle;height:6px;border-radius:3px;background:${C.line};overflow:hidden}.bar div{height:6px;border-radius:3px}
.k{font-size:12px;font-weight:700;color:${C.muted};text-transform:uppercase;letter-spacing:.05em;margin:12px 0 0}
`;
const pill = (text, tone = "gray") => `<span class="p p${TONES[tone] ? tone : "gray"}">${esc(text)}</span>`;
const muted = (s) => `<div class="note">${s}</div>`;
// A figure that carries its own sign: "+$1,200" green, "−$300" red.
const signedFig = (fmt) => {
  const s = String(fmt ?? "");
  const color = s.startsWith("+") && !/^\+\$0$/.test(s) ? C.green : s.startsWith("−") || s.startsWith("-") ? C.red : C.ink;
  return `<span style="color:${color}">${esc(s)}</span>`;
};
const bar = (fraction, tone = "gray", width = 72) => {
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  const [fg] = TONES[tone] || TONES.gray;
  return `<div class="bar" style="width:${width}px"><div style="width:${Math.round(f * 100)}%;background:${fg}"></div></div>`;
};
const parseUsd = (fmt) => { const n = Number(String(fmt ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : 0; };

/**
 * A table. `cols` = [{ label, num?, width? }]; each row is an array of HTML
 * cells (already escaped) or { cells, kind: "total" | "group" | "sub" }.
 */
function table(cols, rows) {
  if (!rows.length) return "";
  const th = cols.map((c) => `<th${c.num ? ' class="n"' : ""}${c.width ? ` style="width:${c.width}"` : ""}>${esc(c.label)}</th>`).join("");
  const ROW = { total: ' class="tot"', group: ' class="g"', sub: ' class="s"' };
  const tr = rows.map((r) => {
    const { cells, kind } = Array.isArray(r) ? { cells: r, kind: null } : r;
    return `<tr${ROW[kind] || ""}>${cells.map((c, i) => {
      const cls = [(cols[i] || {}).num ? "n" : "", kind === "sub" && i === 0 ? "i" : ""].filter(Boolean).join(" ");
      return `<td${cls ? ` class="${cls}"` : ""}>${c ?? ""}</td>`;
    }).join("")}</tr>`;
  }).join("");
  return `<table role="presentation" class="t" width="100%" cellpadding="0" cellspacing="0"><tr>${th}</tr>${tr}</table>`;
}

/** One section card: a title, an optional headline figure on the right, a body. */
function card(title, body, figure = "", note = "") {
  if (!body) return "";
  return `<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:16px 18px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="ct">${esc(title)}</td>${figure ? `<td class="cf">${figure}</td>` : ""}</tr>${note ? `<tr><td colspan="2" class="cn">${note}</td></tr>` : ""}</table>
${body}</td></tr></table>`;
}

// ── The email ───────────────────────────────────────────────────────────────

/**
 * @param {object} p        the packet
 * @param {object|null} summary  verified summary ({sentences}) or null
 */
function renderReview(p, summary) {
  const m = p.meta;
  const out = [];

  out.push(renderHeader(p));
  if (summary && summary.sentences?.length) {
    out.push(`<div style="background:${C.card};border:1px solid ${C.line};border-left:4px solid ${C.ink};border-radius:8px;padding:12px 14px;margin:0 0 14px;font-size:14px;line-height:1.5">${summary.sentences.map((s) => esc(s.text)).join(" ")}</div>`);
  }
  out.push(renderTodo(p.attention));
  out.push(renderAttention(p.attention));
  out.push(renderCash(p));
  out.push(renderFlow(p));
  out.push(renderUpcoming(p));
  out.push(renderIncome(p));
  out.push(renderInvoices(p));
  out.push(renderRealEstate(p));
  out.push(renderDeposits(p));
  out.push(renderSpending(p));
  out.push(renderCards(p));
  out.push(renderRecurring(p));
  out.push(renderNetWorth(p));
  out.push(renderFooter(p));

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><style>${CSS}</style><title>Weekly finance review — ${esc(fmtLong(m.week_end))}</title></head>`
    + `<body style="margin:0;padding:0;background:${C.page};color:${C.ink};font-family:${FONT};font-size:14px;line-height:1.45">`
    + `<div style="max-width:680px;margin:0 auto;padding:18px 12px 28px">${out.filter(Boolean).join("\n")}</div></body></html>`;
}

function renderHeader(p) {
  const m = p.meta, cp = p.cash.position, f = p.cash.flow || {};
  const tile = (label, value, sub) => `<td width="50%" style="padding:6px;vertical-align:top"><div style="background:${C.soft};border-radius:10px;padding:10px 12px"><div style="color:${C.muted};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">${esc(label)}</div><div style="font-size:22px;font-weight:700;margin-top:2px;${NUM}">${value}</div>${sub ? `<div style="color:${C.muted};font-size:12px;margin-top:1px">${sub}</div>` : ""}</div></td>`;
  const tiles = [
    cp ? tile("Free cash", esc(cp.free_cash_fmt), `${signedFig(cp.free_cash_week_delta_fmt)} this week${p.cash.runway_days != null ? ` · ${esc(p.cash.runway_days)}-day runway` : ""}`) : null,
    tile("Spent this week", esc(p.spending.week_total_fmt), `vs ${esc(p.spending.prior_week_total_fmt)} the week before`),
    f.income_in_fmt != null ? tile("Income arrived", esc(f.income_in_fmt), f.deposits_in_fmt && f.deposits_in_fmt !== "$0" ? `+ ${esc(f.deposits_in_fmt)} tenant deposits` : "this week") : null,
    tile("Net worth", esc(p.networth.net_worth_fmt), "awareness only"),
  ].filter(Boolean);
  const rows = [];
  for (let i = 0; i < tiles.length; i += 2) rows.push(`<tr>${tiles[i]}${tiles[i + 1] || '<td width="50%"></td>'}</tr>`);
  const warn = m.ledger_available ? "" : `<div style="margin:8px 6px 0;padding:8px 10px;border-radius:8px;background:${C.redBg};color:${C.red};font-size:13px;font-weight:600">${esc(cap(m.ledger_label || "rental ledger"))} unavailable (${esc(m.ledger_error)}): property and deposit sections are absent.</div>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;background:${C.card};border-radius:12px;margin:0 0 14px;border:1px solid ${C.line}"><tr><td style="padding:16px 12px 10px">
<div style="padding:0 6px"><div style="color:${C.muted};font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">Weekly finance review</div>
<div style="font-size:22px;font-weight:700;margin:2px 0 0">Week ending ${esc(fmtLong(m.week_end))}</div>
<div style="color:${C.muted};font-size:12px;margin:2px 0 8px">${m.week_start ? `${esc(fmtLong(m.week_start))} – ${esc(fmtLong(m.week_end))} · ` : ""}generated ${esc(m.generated_at)}</div></div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join("")}</table>${warn}</td></tr></table>`;
}

// ── Worth your attention ────────────────────────────────────────────────────
// The section the user reads first. The packet's flags arrive ranked but flat;
// this lays them out in three tiers by the priority the packet already gave
// them, groups flags of one kind under a single label, bolds the figures so
// the eye lands on the amounts, and puts a flag's one action (when the packet
// names one) on its own line. The label for a kind is a fixed word per tag,
// never a reading of the flag.
const ACT_FROM = 70, WATCH_FROM = 50;
const TIERS = [
  { key: "act", title: "Act on", sub: "ranked highest this week", color: C.red, bg: C.redBg, min: ACT_FROM },
  { key: "watch", title: "Keep an eye on", sub: "ranked next", color: C.amber, bg: C.amberBg, min: WATCH_FROM },
  { key: "tidy", title: "Housekeeping", sub: "ranked lowest", color: C.gray, bg: C.grayBg, min: -Infinity },
];
const TAG_LABELS = {
  shortfall: "Cash shortfall", "shortfall-recurring": "Cash shortfall", "income-late": "Income late", "rent-short": "Rent short",
  "rent-failed": "Rent invoice failed", interest: "Interest charged", "unreviewed-large": "Unclassified charge",
  duplicate: "Possible duplicate", unusual: "Unusual charge", "new-merchant": "New merchant", "charged-after-cancel": "Charged after cancelling",
  "income-in-personal": "Income in a personal account", utilization: "Card near its limit", fee: "Fee", renewal: "Renewal",
  "spend-increase": "Spend increase", "price-increase": "Spend increase", leakage: "Category mismatch", reserve: "Low reserve", vacancy: "Vacancy", "lease-ending": "Lease ending",
  "new-property": "New property", "ledger-empty": "Ledger gap", "unmapped-account": "Unmapped account", "idle-cash": "Idle cash",
  "deposit-returned-from-other-account": "Deposit refunded from the wrong account", "deposit-hub-status": "Hub record to update",
  "deposit-unattributed-rows": "Deposit account rows", "deposit-missing": "Deposit not in its account", "deposit-unpaid": "Deposit unpaid",
  "deposit-not-returned": "Deposit not returned", "deposit-in-transit": "Deposit in transit", "deposit-fee-shortfall": "Deposit short by fees",
  "invoice-late": "Invoice late", "invoice-recon-unbalanced": "Invoices do not reconcile", "invoice-ambiguous": "Invoice to match",
};
const tagLabel = (tag) => TAG_LABELS[tag] || cap(String(tag).split("-").join(" "));
// Bold the dollar amounts and percentages in a flag the packet's own code wrote.
const emphasise = (s) => esc(s).replace(/[−-]?\$-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?%/g, (m) => `<b>${m}</b>`); // lang-regex-ok: figures in a sentence this repo's code generated
// What the review's own investigation did (playbook Step 1b, merged by compose
// --resolve): labelled, so the flag's text stays the record's words.
const investigation = (a) => `${a.fixed ? `<div style="margin-top:4px;font-size:12px;color:${C.green}">✔ Fixed: ${esc(a.fixed)}</div>` : ""}${a.checked ? `<div style="margin-top:4px;font-size:12px;color:${C.muted}">Checked: ${esc(a.checked)}</div>` : ""}`;
const actionLine = (a, color) => `${investigation(a)}${a.action ? `<div style="margin-top:6px;padding:6px 10px;background:${C.card};border-radius:6px;color:${color};font-weight:700;font-size:13px">→ ${emphasise(a.action)}</div>` : ""}`;

// Every flag with something left for the admin, highest priority first, then
// the Questions tab, as one numbered list at the top (the user, 2026-11-08:
// "clearly explain the to do").
function renderTodo(attention) {
  // An optional action (cancel a renewal only if it is unwanted) is not a to-do.
  const items = (attention || []).filter((a) => a.tag !== "questions" && a.action && !a.optional).sort((x, y) => y.priority - x.priority);
  const q = (attention || []).find((a) => a.tag === "questions");
  if (!items.length && !q) return "";
  const li = items.map((a) => `<li style="margin:6px 0"><b>${emphasise(a.action)}</b><div style="font-size:12px;color:${C.muted};margin-top:2px">Why: ${esc(a.text)}</div></li>`);
  if (q) li.push(`<li style="margin:6px 0"><b>Answer the open questions in the Questions tab.</b><div style="font-size:12px;color:${C.muted};margin-top:2px">${esc(q.text)}</div></li>`);
  return card("✅ To do this week", `<ol style="margin:4px 0 0;padding-left:20px;font-size:14px;line-height:1.45">${li.join("")}</ol>`);
}

function attentionGroups(items) {
  const byTag = new Map();
  for (const a of items) {
    if (!byTag.has(a.tag)) byTag.set(a.tag, []);
    byTag.get(a.tag).push(a);
  }
  return [...byTag.entries()].map(([tag, list]) => ({ tag, list, top: Math.max(...list.map((a) => a.priority)) })).sort((a, b) => b.top - a.top);
}

function renderAttention(attention) {
  const flags = (attention || []).filter((a) => a.tag !== "questions");
  const questions = (attention || []).find((a) => a.tag === "questions");
  if (!flags.length && !questions) return card("⚠️ Worth your attention", `<div style="color:${C.green};font-weight:600">Nothing urgent this week.</div>`);

  const tiers = TIERS.map((t, i) => ({ ...t, items: flags.filter((a) => a.priority >= t.min && (i === 0 || a.priority < TIERS[i - 1].min)) }));
  const pills = tiers.filter((t) => t.items.length).map((t) => `<span style="display:inline-block;margin:0 6px 4px 0;padding:2px 9px;border-radius:10px;background:${t.bg};color:${t.color};font-size:12px;font-weight:600">${t.items.length} ${esc(t.title.toLowerCase())}</span>`).join("");
  const body = [];
  if (flags.length) body.push(`<div style="margin:2px 0 4px">${pills}</div>`);

  let first = true;
  for (const t of tiers) {
    if (!t.items.length) continue;
    body.push(`<div style="margin:14px 0 6px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${t.color}">${esc(t.title)} <span style="font-weight:400;letter-spacing:0;text-transform:none;color:${C.muted}">· ${esc(t.sub)}</span></div>`);
    for (const g of attentionGroups(t.items)) {
      const many = g.list.length > 1;
      const chip = `<span style="display:inline-block;padding:1px 7px;border-radius:4px;background:${t.color};color:#fff;font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase">${esc(tagLabel(g.tag))}${many ? ` · ${g.list.length}` : ""}</span>`;
      const start = first && t.key === "act" ? ` <span style="font-size:11px;font-weight:700;color:${t.color}">← START HERE</span>` : "";
      first = false;
      const inner = many
        ? `<ul style="margin:6px 0 0;padding-left:18px">${g.list.map((a) => `<li style="margin:4px 0">${emphasise(a.text)}${actionLine(a, t.color)}</li>`).join("")}</ul>`
        : `<div style="margin-top:6px">${emphasise(g.list[0].text)}</div>${actionLine(g.list[0], t.color)}`;
      body.push(`<div style="margin:0 0 8px;padding:10px 12px;border-left:4px solid ${t.color};background:${t.bg};border-radius:0 8px 8px 0;font-size:${t.key === "act" ? 14 : 13}px;line-height:1.45">${chip}${start}${inner}</div>`);
    }
  }
  if (questions) body.push(`<div style="margin:12px 0 0;padding:8px 12px;border:1px dashed #c7c7cc;border-radius:8px;font-size:13px">💬 ${emphasise(questions.text)}</div>`);
  return card("⚠️ Worth your attention", body.join(""));
}

// ── Cash ────────────────────────────────────────────────────────────────────
function renderCash(p) {
  const cp = p.cash.position;
  if (!cp) return "";
  const rows = [];
  for (const b of cp.buckets) {
    rows.push({ cells: [esc(b.label), esc(b.total_fmt), signedFig(b.week_delta_fmt)], kind: "group" });
    for (const a of b.accounts || []) rows.push({ cells: [`${esc(a.label)} <span style="color:${C.faint}">••${esc(a.mask)}</span>`, esc(a.balance_fmt), signedFig(a.week_delta_fmt)], kind: "sub" });
    if (b.detail) rows.push({ cells: [esc(b.detail), "", ""], kind: "sub" });
  }
  rows.push({ cells: ["Free cash", esc(cp.free_cash_fmt), signedFig(cp.free_cash_week_delta_fmt)], kind: "total" });
  const notes = [
    `Not counted as free cash: <b>${esc(cp.restricted_fmt)}</b> in the security-deposit account (tenant money) and <b>${esc(cp.retirement_cash_fmt)}</b> of cash inside 401k/Roth/HSA.`,
    cp.unmapped.length ? `Not in the account registry: ${esc(cp.unmapped.join(", "))}.` : "",
    `Card balances: ${esc(p.cash.card_debt_fmt)}. ${esc(cap(cp.delta_note))}.`,
  ].filter(Boolean).join(" ");
  return card("Cash position", table([{ label: "Where" }, { label: "Balance", num: true }, { label: "Week Δ", num: true }], rows) + muted(notes), esc(cp.free_cash_fmt));
}

function renderFlow(p) {
  const f = p.cash.flow || {};
  const keep = (fmt, always) => always || (fmt && fmt !== "$0");
  const inRows = [
    ["Income", f.income_in_fmt, true], ["Tenant deposits (into the deposit account)", f.deposits_in_fmt], ["Arrived, not yet explained", f.unexplained_in_fmt],
    ["From your other institutions", f.from_your_other_accounts_fmt], ["Refunds", f.refunds_fmt],
  ].filter(([, v, a]) => keep(v, a));
  const outRows = [
    ["Spending (cards + bank)", f.spending_fmt, true], ["Card payments from bank accounts", f.card_payments_from_bank_fmt], ["To your other institutions", f.to_your_other_accounts_fmt],
    ["Capital (asset purchases you classified)", f.capital_fmt], ["Large outflows not yet classified", f.unreviewed_large_fmt],
  ].filter(([, v, a]) => keep(v, a));
  const rows = [
    { cells: ["Money in", ""], kind: "group" }, ...inRows.map(([l, v]) => ({ cells: [esc(l), esc(v)], kind: "sub" })),
    { cells: ["Money out", ""], kind: "group" }, ...outRows.map(([l, v]) => ({ cells: [esc(l), l.startsWith("Large outflows") ? `<span style="color:${C.red}">${esc(v)}</span>` : esc(v)], kind: "sub" })),
  ];
  const runway = p.cash.runway_days != null ? muted(`Runway <b>${esc(p.cash.runway_days)} days</b> at ${esc(p.cash.daily_spend_fmt)}/day — ${esc(p.cash.runway_basis)}.`) : "";
  const unconf = p.cash.unconfirmed_card_payments.length ? muted(`Card payments in the last 45 days no confirmed schedule explains (history, not a forecast): ${esc(p.cash.unconfirmed_card_payments.map((u) => `${u.who} ${u.amount_fmt} on ${u.last_date_fmt} from ${u.account}`).join("; "))}.`) : "";
  return card("This week's money", table([{ label: "By what it was" }, { label: "Amount", num: true }], rows) + runway + unconf);
}

function renderUpcoming(p) {
  const up = p.cash.upcoming_14d;
  if (!up.length) return "";
  const rows = up.map((u) => [esc(u.due_fmt), esc(u.label), esc(u.amount_fmt), esc(u.account),
    u.source === "confirmed" ? pill(u.autopay ? "confirmed · autopay" : "confirmed", "green") : pill(`predicted from ${u.predicted_from} charge${u.predicted_from === 1 ? "" : "s"}`, "gray")]);
  return card("Next 14 days", table([{ label: "Due", width: "56px" }, { label: "What" }, { label: "Amount", num: true }, { label: "From" }, { label: "Basis" }], rows),
    "", `Predictions come from ${esc(p.meta.recurring_label || "the Recurring tracker")}; confirmed ones are schedules you recorded.`);
}

// ── Income ──────────────────────────────────────────────────────────────────
function renderIncome(p) {
  const inc = p.income;
  const parts = [];
  if (inc.registered.length) {
    const tone = (s) => (s === "received" ? "green" : s === "late" ? "red" : "gray");
    parts.push(table([{ label: "Stream" }, { label: "Amount", num: true }, { label: "Due" }, { label: "Status" }, { label: "Into" }],
      inc.registered.map((r) => [esc(r.label), esc(r.amount_fmt), esc(r.due_fmt), pill(r.status + (r.received_on ? ` ${r.received_on}` : ""), tone(r.status)), esc(r.account)])));
  } else if (inc.note) parts.push(muted(esc(inc.note)));
  if (inc.rent.length) {
    parts.push(table([{ label: "Long-term property" }, { label: "Rent roll / mo", num: true }, { label: "Arrived this month", num: true }, { label: "", width: "84px" }],
      inc.rent.map((r) => {
        const roll = parseUsd(r.rent_roll_fmt), got = parseUsd(r.received_mtd_fmt);
        const fr = roll ? got / roll : 0;
        return [`${esc(r.name)}${r.has_account ? "" : `<div class="x">no bank account in the registry</div>`}`, esc(r.rent_roll_fmt), esc(r.received_mtd_fmt), bar(fr, fr >= 0.999 ? "green" : "amber")];
      })));
  }
  if (inc.rent_invoices_open?.length) parts.push(muted(`Hub rent invoices past due and still open: ${esc(inc.rent_invoices_open.map((r) => `${r.property_name} ${r.count} (${r.total_fmt}, oldest due ${r.oldest_due_fmt})`).join("; "))}.`));
  return card("Income & rent", parts.join(""));
}

function renderInvoices(p) {
  const iv = p.invoices;
  if (!iv) return "";
  const head = `<div style="font-size:13px">${esc(iv.invoiced_fmt)} invoiced = ${esc(iv.paid_fmt)} paid + ${esc(iv.outstanding_fmt)} open ${iv.ok ? pill("reconciled to the cent", "green") : pill("does not reconcile", "red")}</div>${muted(esc(iv.scope))}`;
  const body = iv.open.length
    ? table([{ label: "Invoice" }, { label: "Dated" }, { label: "Amount", num: true }, { label: "Open", num: true }, { label: "Due" }, { label: "Status" }], iv.open.map((x) => [esc(x.number), esc(x.date_fmt), esc(x.amount_fmt), esc(x.open_fmt), esc(x.due_fmt), pill(x.status, x.status === "late" ? "red" : "gray")]))
    : muted(`No open invoices. Latest paid: ${esc(iv.recent.map((x) => `${x.number} (${x.date_fmt}) paid ${x.paid_on_fmt}, ${x.days} days`).join("; "))}.`);
  return card(`${p.invoices_label || "Client"} invoices`, head + body);
}

// ── Real estate ─────────────────────────────────────────────────────────────
function renderRealEstate(p) {
  const re = p.real_estate;
  if (!re) return "";
  const pr = (x, kind) => ({
    cells: [esc(x.name || x.label), esc(x.cash_fmt), signedFig(x.week_net_fmt), signedFig(x.mtd_net_fmt), signedFig(x.ytd_net_fmt),
      x.reserve_fmt ? (x.reserve_low ? `<span style="color:${C.amber};font-weight:700">${esc(x.reserve_fmt)} ⚠</span>` : esc(x.reserve_fmt)) : "", esc(x.value_fmt)],
    kind,
  });
  const st = re.properties.filter((x) => x.rental_type === "short-term"), lt = re.properties.filter((x) => x.rental_type === "long-term");
  const rows = [
    ...st.map((x) => pr(x)), ...(re.short_term ? [pr(re.short_term, "group")] : []),
    ...lt.map((x) => pr(x)), ...(re.long_term ? [pr(re.long_term, "group")] : []),
    ...(re.portfolio ? [pr(re.portfolio, "total")] : []),
  ];
  const notes = [
    ...re.sold_this_year.map((s) => `${esc(s.name)} (sold ${esc(s.disposed_on_fmt)}) YTD net ${esc(s.ytd_net_fmt)}; portfolio YTD net including it: ${esc(re.portfolio_ytd_net_including_sold_fmt)}.`),
    ...re.unsplit_values.map(esc), esc(re.note),
  ].join(" ");
  return card("Real estate", table([{ label: "Property" }, { label: "Cash", num: true }, { label: "Week", num: true }, { label: "MTD", num: true }, { label: "YTD", num: true }, { label: "Reserve", num: true }, { label: "Value", num: true }], rows) + muted(notes),
    re.portfolio ? signedFig(re.portfolio.ytd_net_fmt) : "", re.portfolio ? "Net is income less expenses; the figure is the portfolio's YTD net." : "");
}

// ── Security deposits ───────────────────────────────────────────────────────
// One row per held deposit, grouped by property, with where it is as a short
// status. Refunded deposits leave the table for a line beneath it; the
// location wording the packet gives is kept, in the status or the note.
function depositStatus(r) {
  const loc = String(r.location || "");
  if (loc.startsWith("deposit account")) {
    const detail = loc.slice("deposit account".length).replace(/^\s*\(|\)\s*$/g, "").trim();
    const short = /short/.test(detail);
    return { badge: pill(short ? "In account · short" : "In account", short ? "amber" : "green"), note: detail };
  }
  if (loc.startsWith("in transit")) return { badge: pill("In transit", "blue"), note: loc };
  if (loc.startsWith("not known")) return { badge: pill("Whereabouts unknown", "amber"), note: loc.replace(/^not known\s*\(?/, "").replace(/\)$/, "") };
  return { badge: pill("Not in the account", "red"), note: loc };
}

function renderDeposits(p) {
  const d = p.deposits;
  if (!d) return "";
  const held = d.rows.filter((r) => r.location !== "refunded");
  const refunded = d.rows.filter((r) => r.location === "refunded");
  const byProp = new Map();
  for (const r of held.slice().sort((a, b) => String(a.property_name).localeCompare(String(b.property_name)) || String(a.tenant).localeCompare(String(b.tenant)))) {
    if (!byProp.has(r.property_name)) byProp.set(r.property_name, []);
    byProp.get(r.property_name).push(r);
  }
  const rows = [];
  for (const [prop, list] of byProp) {
    const total = list.reduce((s, r) => s + parseUsd(r.amount_fmt), 0);
    rows.push({ cells: [`${esc(prop)} <span style="font-weight:400;color:${C.muted}">· ${list.length}</span>`, "", `$${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, ""], kind: "group" });
    for (const r of list) {
      const s = depositStatus(r);
      const notes = [s.note, r.exception ? `Exception: ${r.exception}` : ""].filter(Boolean);
      rows.push([`${esc(String(r.tenant).replace(/\s+/g, " "))}${notes.length ? `<div class="x">${esc(notes.join(" · "))}</div>` : ""}`,
        `<span class="m">${esc(r.lease_number)}</span>`, esc(r.amount_fmt), r.exception && s.badge.includes("In account") ? pill("Exception", "gray") : s.badge]);
    }
  }
  const head = `<div style="font-size:13px;line-height:1.5">Owed back to tenants <b>${esc(d.liability_fmt)}</b>. The deposit account (${esc(d.deposit_account)}) holds <b>${esc(d.balance_fmt)}</b> = ${esc(d.located_fmt)} of current deposits located there ${String(d.unattributed_fmt).startsWith("$-") || String(d.unattributed_fmt).startsWith("−") ? "−" : "+"} ${esc(String(d.unattributed_fmt).replace(/^\$-|^−/, "$"))} tied to no current deposit. ${d.ok ? pill("reconciled to the cent", "green") : pill(`off by ${d.difference_fmt}`, "red")}</div>`;
  const missing = d.missing.length || d.groups.length
    ? `<div style="margin:10px 0 2px;color:${C.red};font-weight:700;font-size:13px">Not in the deposit account</div>`
      + table([{ label: "Property" }, { label: "Lease" }, { label: "Tenant" }, { label: "Amount", num: true }, { label: "Where it is" }], d.missing.map((x) => [esc(`${x.property_name}${x.state ? ` (${x.state})` : ""}`), esc(x.lease_number), esc(x.tenant), esc(x.amount_fmt), esc(x.where)]))
      + d.groups.map((g) => muted(esc(g))).join("")
    : "";
  const transit = d.in_transit?.length ? muted(`On the way to the deposit account (hub transfer in flight): ${esc(d.in_transit.join("; "))}.`) : "";
  const notes = [
    refunded.length ? `Refunded and closed out: ${esc(refunded.map((r) => `${String(r.tenant).replace(/\s+/g, " ")} ${r.amount_fmt} (${r.property_name})`).join("; "))}.` : "",
    d.unattributed.length ? `In the account but tied to no current deposit: ${esc(d.opening_fmt)} from before the bank history, plus ${esc(d.unattributed.join("; "))}.` : "",
    `Read ${esc(String(d.run_at).slice(0, 16).replace("T", " "))} UTC from the hub's per-tenant deposit record (Financials → Security deposits).`,
  ].filter(Boolean).join(" ");
  return card("Security deposits", head + missing + transit + table([{ label: "Tenant" }, { label: "Lease" }, { label: "Amount", num: true }, { label: "Where" }], rows) + muted(notes), esc(d.liability_fmt), "Owed back to tenants");
}

// ── Spending ────────────────────────────────────────────────────────────────
function renderSpending(p) {
  const s = p.spending;
  const cats = s.by_category.slice(0, 8);
  const max = Math.max(1, ...cats.map((c) => c.this_week ?? parseUsd(c.this_week_fmt)));
  const catTable = table([{ label: "Category" }, { label: "This week", num: true }, { label: "", width: "84px" }, { label: "Prior week", num: true }, { label: "Avg week, 90d", num: true }],
    cats.map((c) => [esc(cap(c.category)), esc(c.this_week_fmt), bar((c.this_week ?? parseUsd(c.this_week_fmt)) / max, "blue"), `<span class="m">${esc(c.prior_week_fmt)}</span>`, `<span class="m">${esc(c.avg_week_90d_fmt)}</span>`]));
  const largest = s.largest.length
    ? `<div class="k">Largest charges</div>`
      + table([{ label: "Who" }, { label: "Account" }, { label: "Date" }, { label: "Amount", num: true }],
        s.largest.map((t) => [`${esc(t.who)}${t.explained ? `<div style="color:${C.green};font-size:11px">${esc(t.explained)}</div>` : ""}`, `<span class="m">${esc(t.account)}</span>`, esc(t.date_fmt), esc(t.amount_fmt)]))
    : "";
  const leak = s.leakage.length ? muted(`Category/owner mismatches: ${esc(s.leakage.map((l) => `${l.who} ${l.amount_fmt} on ${l.account} (${l.direction})`).join("; "))}.`) : "";
  return card("Spending", catTable + largest + leak, esc(s.week_total_fmt), `${esc(s.week_total_fmt)} this week vs ${esc(s.prior_week_total_fmt)} the week before (classified spending only).`);
}

// ── Cards ───────────────────────────────────────────────────────────────────
function renderCards(p) {
  const c = p.cards;
  const rows = c.items.map((i) => [esc(i.label), esc(i.balance_fmt), `<span class="m">${esc(i.limit_fmt)}</span>`,
    i.utilization == null ? `<span style="color:${C.faint}">—</span>` : `${bar(i.utilization, i.utilization >= 0.75 ? "amber" : "gray", 56)} ${esc(i.utilization_fmt)}`]);
  const note = `Aggregate utilization ${esc(c.aggregate_utilization_fmt)} (${esc(c.utilization_basis)}). Interest charged in the last 14 days: ${c.interest.length ? esc(c.interest.map((i) => `${i.amount_fmt} on ${i.account}`).join("; ")) : "none"}.${c.fees?.length ? ` Fees this week: ${esc(c.fees.map((f) => `${f.amount_fmt} ${f.who} on ${f.account}`).join("; "))}.` : ""}`;
  return card("Cards", table([{ label: "Card" }, { label: "Balance", num: true }, { label: "Limit", num: true }, { label: "Utilization", num: true }], rows) + muted(note), esc(p.cash.card_debt_fmt), "Total card balances");
}

// ── Recurring ───────────────────────────────────────────────────────────────
function renderRecurring(p) {
  const r = p.recurring;
  const parts = [`<div style="font-size:13px">${esc(r.active_count)} active recurring items · <b>${esc(r.monthly_equivalent_fmt)}/mo</b> equivalent · ${esc(r.undecided_count)} without a decision</div>${muted(`Source: ${esc(r.source)}.`)}`];
  if (r.renewals_30d.length) {
    parts.push(`<div class="k">Annual charges due in 30 days</div>`);
    parts.push(table([{ label: "What" }, { label: "Typical", num: true }, { label: "Expected" }, { label: "Status" }], r.renewals_30d.map((x) => {
      const status = x.paid
        ? `${pill(`paid ${x.paid.total_fmt} · ${x.paid.on_fmt}`, "green")}${x.paid.last_cycle_fmt && x.paid.last_cycle_count > 1 ? `<div style="color:${C.faint};font-size:11px;margin-top:2px">last cycle ${esc(x.paid.last_cycle_fmt)} in ${esc(x.paid.last_cycle_count)} payments</div>` : ""}`
        : pill(x.decision, x.decision === "undecided" ? "amber" : "gray");
      return [esc(x.name), esc(x.amount_fmt), esc(x.due_fmt), status];
    })));
  }
  if (r.price_changes.length) {
    const changes = r.price_changes.slice().sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
    parts.push(`<div class="k">Amount changes this week</div>`);
    parts.push(table([{ label: "What" }, { label: "Was", num: true }, { label: "Now", num: true }, { label: "Change", num: true }], changes.map((x) => {
      const d = (x.to ?? 0) - (x.from ?? 0);
      const fmt = `${d >= 0 ? "+" : "−"}$${Math.abs(d).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      return [esc(x.name), `<span class="m">${esc(x.from_fmt)}</span>`, esc(x.to_fmt), `<span style="color:${d > 0 ? C.red : C.green}">${fmt}</span>`];
    })));
  }
  return card("Recurring", parts.join(""), `${esc(r.monthly_equivalent_fmt)}<span style="font-size:12px;color:${C.muted};font-weight:400">/mo</span>`);
}

// ── Net worth ───────────────────────────────────────────────────────────────
function renderNetWorth(p) {
  const nw = p.networth;
  const rows = [...nw.lines.map((l) => [`${esc(l.label)}${l.note ? `<div class="x">${esc(l.note)}</div>` : ""}`, esc(l.value_fmt), `<span class="m">${esc(l.as_of || "")}</span>`]),
    { cells: ["Net worth", esc(nw.net_worth_fmt), ""], kind: "total" }];
  return card("Net worth", table([{ label: "" }, { label: "Value", num: true }, { label: "As of", num: true }], rows) + muted(esc(nw.note)), esc(nw.net_worth_fmt), "Awareness only — no action is suggested here.");
}

function renderFooter(p) {
  const bits = [];
  if (p.tax.next_due_fmt) bits.push(`Next federal estimated-tax date: <b>${esc(p.tax.next_due_fmt)}</b> (${esc(p.tax.days_until)} days).`);
  // The questions themselves go to the Questions tab (bin/finance-review-ask;
  // the user, 2026-11-08: "in the questions channel - not in the email").
  if (p.questions.length) bits.push(`${p.questions.length} question(s) the review will not guess are in your Questions tab in the app.`);
  bits.push("Every figure here is computed from records; nothing is estimated by a model.");
  return `<div style="color:${C.muted};font-size:12px;line-height:1.6;padding:4px 8px;text-align:center">${bits.join("<br>")}</div>`;
}

function fmtLong(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

module.exports = { renderReview };
