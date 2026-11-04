"use strict";
// finance-real-estate — the real-estate half of the financial reviews:
// account attribution, cash buckets, the per-property / short-term / long-term
// / portfolio roll-up. (Deposits: lib/finance-deposit-reconcile.js (via bin/finance-deposits-reconcile).)
//
// WHY THIS IS SEPARATE FROM THE REVIEW BUILDERS. They are the orchestrators:
// it fetches, it assembles the packet, it ranks the attention flags. This file
// holds the money rules that are specific to the properties, and it holds them
// where they can be read on their own — because they are the part with real
// accounting in them, and accounting that is hard to find is accounting nobody
// checks.
//
// EVERY FIGURE HERE COMES FROM THE LEDGER, NOT FROM PLAID'S CATEGORY GUESS.
// `lib/rental-ledger.js` is the one implementation of the books'
// semantics — overrides beat classifications, group charges fan out and divide
// against the transaction's own date, excluded rows count nowhere, and the sign
// flips exactly once. Cash balances are the only thing taken from Plaid,
// because a bank balance is a bank fact and the ledger does not hold one.
//
// READ-ONLY. Nothing here writes to either store.
//
// CONFIG. agent/local/config/rental-finance.json (merged under the `config`
// a caller passes, which wins): `property_value_keys` / `parcel_property` (how
// the valuation feed's holdings and parcels map onto the books' property ids),
// `brokerage_taxable_accounts`, and `brokerage_key` — the legacy prefix an
// installation's own review builder uses for its brokerage inputs and output
// bucket (`<key>Accounts`, `buckets.<key>_taxable`). With no config the
// brokerage half is simply empty.

const { localConfig } = require("./instance.cjs");
const { statement } = require("./rental-ledger.js");
const RF_DEFAULTS = { property_value_keys: {}, parcel_property: {}, brokerage_key: "", brokerage_taxable_accounts: null };
const rfConfig = (config = {}) => {
  const base = localConfig("rental-finance", RF_DEFAULTS);
  const key = config.brokerage_key || base.brokerage_key || "";
  return {
    ...base, ...config,
    property_value_keys: { ...base.property_value_keys, ...(config.property_value_keys || {}) },
    parcel_property: { ...base.parcel_property, ...(config.parcel_property || {}) },
    brokerage_key: key,
    brokerage_taxable_accounts: config.brokerage_taxable_accounts || (key && config[`${key}_taxable_accounts`]) || base.brokerage_taxable_accounts || null,
  };
};

const DAY = 86400000;
const dayAdd = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const monthsBetween = (a, b) => Math.max(0, (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / (DAY * 30.4375));
const round2 = (n) => Math.round(n * 100) / 100;
const sum = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);

// ── Which brokerage accounts hold money you can actually spend ──────────────
//
// A weekly review is about liquidity, and the cash inside a 401k is not
// liquidity — it is a rounding error inside a retirement plan you cannot draw
// on. So the taxable accounts are separated from the rest, and the rest is
// reported once, as awareness, rather than folded into anything called "cash".
//
// The default rule is a name test over ACCOUNT LABELS, not over anything a
// person wrote — an account label is a field with a small closed vocabulary,
// which is what makes matching it safe. It is still only a default: set
// `brokerage_taxable_accounts` to name them explicitly, and this is never
// consulted.
const RETIREMENT_RE = /\b(401\s?k|403\s?b|457|roth|ira|sep|simple|hsa|529|custodial|utma|ugma|annuity)\b/i;

// The valuation feed keys its parcels by its own holding names, which are not
// always the registry ids and are not always derivable from them (a registry id
// `city-e118` may be `city_118` there). Deriving them by replacing hyphens is
// only the fallback; a wrong key silently returns "no valuation", which reads
// as missing data rather than as a wrong key, so the real map lives in config
// (`property_value_keys`: registry id → holding).
//
// One holding can be several properties in the books (two apartments on one
// deed, one let short-term and one long-term). Pricing by holding would put
// both apartments' value on one of them and none on the other, so parcels that
// are a property of their own are mapped explicitly (`parcel_property`: parcel
// id → registry id); every other parcel follows its holding.

/**
 * Property value from the reconciled per-parcel table — the same rows the
 * portfolio total is the sum of, so a property's value and net worth can never
 * disagree again. A holding priced only at its closing total
 * (`holding:<name>`) is credited to its property when the holding is one
 * property, and to nobody when it spans several: splitting a closing total
 * would be a number nobody could defend.
 */
function valueByProperty(reconciled, propertyIds, config) {
  const cfg = rfConfig(config);
  const parcelMap = cfg.parcel_property;
  const holdingToProps = {};
  for (const id of propertyIds) {
    const h = cfg.property_value_keys[id] || id.replace(/-/g, "_");
    (holdingToProps[h] = holdingToProps[h] || []).push(id);
  }
  const out = {};
  const unsplit = [];
  for (const r of reconciled || []) {
    let pid = parcelMap[r.parcel_id] || null;
    if (!pid) {
      const props = holdingToProps[r.holding] || [];
      if (props.length === 1) pid = props[0];
      else if (String(r.parcel_id).startsWith("holding:")) { unsplit.push(r); continue; }
      else pid = props[0] || null;
    }
    if (!pid) { unsplit.push(r); continue; }
    out[pid] = (out[pid] || 0) + Number(r.value || 0);
  }
  return { byProperty: out, unsplit };
}
const isTaxableBrokerage = (accountName, configured) =>
  configured && configured.length
    ? configured.some((n) => n.toLowerCase() === String(accountName || "").toLowerCase())
    : !RETIREMENT_RE.test(String(accountName || ""));

/**
 * Which property (or business / personal / deposit pot) an account belongs to
 * ON A DATE.
 *
 * This replaces a hand-maintained mask table. It had to: an account belongs to
 * a property on a date, because each 1031 exchange sold one property and bought
 * another and the bank account and card followed — one card can be the sold
 * property's until the closing and the new one's after it. A static mask→property map is right for at most one
 * of those two eras and silently wrong for the other, and it is wrong again
 * every time a property is bought or sold. The registry already knows, and it
 * is maintained by the people who do the exchanges.
 *
 * `onDate` defaults to today because balances are a today fact; pass a
 * transaction's own date when attributing a transaction.
 */
function attributionFor(registryAccounts, plaidAccount, onDate) {
  const mask = plaidAccount.mask;
  const reg = (registryAccounts || []).find((a) => a.mask && mask && String(a.mask) === String(mask));
  if (!reg) return { propertyId: null, mapped: false };
  const held = (reg.ownership || []).find(
    (o) => (!o.from || onDate >= String(o.from).slice(0, 10)) && (!o.to || onDate <= String(o.to).slice(0, 10))
  );
  return { propertyId: held ? held.propertyId : null, mapped: true, registryName: reg.name };
}

/** Bucket an account into the four cash pots, plus restricted and unmapped. */
function bucketOf(propertyId, mapped, registryProperties) {
  if (!mapped || !propertyId) return "unmapped";
  const p = (registryProperties || []).find((x) => x.id === propertyId);
  if (!p) return "unmapped";
  if (p.kind === "property") return "real_estate";
  if (p.kind === "business") return "business";
  if (p.kind === "buffer") return "deposits";
  if (p.kind === "personal") return "personal";
  return "unmapped";
}

/**
 * The cash position, in four pots (real estate, business, personal, taxable
 * brokerage), plus the money that is in an account but is not the user's to
 * spend.
 *
 * THE TWO CARVE-OUTS ARE THE POINT.
 *
 * Security deposits are tenant money. They sit in a bank account the user
 * controls and they are owed back in full, so counting them as cash overstates
 * what the user has by exactly the amount held for somebody else. They are
 * reported, never totalled, and net worth carries them against the matching
 * liability.
 *
 * Retirement cash is the user's, and it is not spendable this week. A weekly
 * review that counts a sweep balance inside a 401k as cash has told the user
 * something false about the week.
 *
 * The third case is the one that used to be silent: an account Plaid syncs that
 * the registry has never heard of. It gets its own line and a flag rather than
 * being quietly filed under "bank", because a mystery account in a cash total
 * is how a cash total stops being trustworthy.
 */
function buildCashBuckets(args) {
  const { plaidAccounts, registry, posted, today } = args;
  const config = rfConfig(args.config);
  // Brokerage inputs by their generic names, or by the installation's legacy
  // prefix (`<brokerage_key>Accounts`, ...).
  const B = config.brokerage_key;
  const pick = (suffix) => args[`brokerage${suffix}`] ?? (B ? args[`${B}${suffix}`] : undefined);
  const brokerageAccounts = pick("Accounts"), brokeragePositions = pick("Positions");
  const brokerageAccountHistory = pick("AccountHistory"), brokeragePositionHistory = pick("PositionHistory");
  const wkAgo = dayAdd(today, -7);
  const pots = { real_estate: [], business: [], personal: [], deposits: [], unmapped: [] };

  for (const a of (plaidAccounts || []).filter((x) => x.type === "depository")) {
    const { propertyId, mapped, registryName } = attributionFor(registry.accounts, a, today);
    const bucket = bucketOf(propertyId, mapped, registry.properties);
    const balance = Number(a.balance_current) || 0;

    // A week ago, reconstructed from what has posted since. Plaid's convention:
    // a positive amount is money OUT of the account, so adding the week's
    // postings back walks the balance backwards. Only posted rows count —
    // pending ones have not moved the balance yet, so including them would
    // invent a change that has not happened.
    const since = (posted || []).filter((t) => t.account_id === a.account_id && t.date > wkAgo && t.date <= today);
    const weekAgoBalance = since.length ? round2(balance + sum(since, (t) => Number(t.amount))) : null;

    pots[bucket].push({
      label: registryName || a.name,
      mask: a.mask,
      property_id: propertyId,
      balance: round2(balance),
      available: a.balance_available == null ? null : round2(Number(a.balance_available)),
      week_ago_balance: weekAgoBalance,
      week_delta: weekAgoBalance == null ? null : round2(balance - weekAgoBalance),
      delta_basis: weekAgoBalance == null ? "no postings this week" : "derived from posted transactions",
    });
  }

  // ── Brokerage, split taxable from retirement ──
  const configured = config.brokerage_taxable_accounts || null;
  const cashEqNow = {};
  for (const p of (brokeragePositions || [])) {
    if (p.asset_type !== "CASH_EQUIVALENT") continue;
    cashEqNow[p.account_hash] = (cashEqNow[p.account_hash] || 0) + (Number(p.market_value) || 0);
  }
  const brokerageRows = (brokerageAccounts || []).map((a) => ({
    label: a.account_name,
    taxable: isTaxableBrokerage(a.account_name, configured),
    sweep: round2(Number(a.cash_balance) || 0),
    money_market: round2(cashEqNow[a.account_hash] || 0),
    cash: round2((Number(a.cash_balance) || 0) + (cashEqNow[a.account_hash] || 0)),
    as_of: a.as_of,
  }));

  // The brokerage has real per-account history, so its week-ago figure is measured
  // rather than reconstructed — the one bucket where that is true today.
  const histDate = (brokerageAccountHistory || [])
    .map((r) => r.as_of_date)
    .filter((d) => d <= wkAgo)
    .sort()
    .pop() || null;
  let brokerageTaxableWeekAgo = null;
  if (histDate) {
    const accts = (brokerageAccountHistory || []).filter((r) => r.as_of_date === histDate && isTaxableBrokerage(r.account_name, configured));
    const mm = (brokeragePositionHistory || []).filter((r) => r.as_of_date === histDate && r.asset_type === "CASH_EQUIVALENT" && isTaxableBrokerage(r.account_name, configured));
    if (accts.length) brokerageTaxableWeekAgo = round2(sum(accts, (r) => r.cash_balance) + sum(mm, (r) => r.market_value));
  }

  const taxable = brokerageRows.filter((r) => r.taxable);
  const retirement = brokerageRows.filter((r) => !r.taxable);
  const potTotal = (k) => round2(sum(pots[k], (r) => r.balance));

  const buckets = {
    real_estate: { total: potTotal("real_estate"), accounts: pots.real_estate },
    business: { total: potTotal("business"), accounts: pots.business },
    personal: { total: potTotal("personal"), accounts: pots.personal },
    brokerage_taxable: {
      total: round2(sum(taxable, (r) => r.cash)),
      sweep: round2(sum(taxable, (r) => r.sweep)),
      money_market: round2(sum(taxable, (r) => r.money_market)),
      accounts: taxable,
      week_ago_total: brokerageTaxableWeekAgo,
      week_delta: brokerageTaxableWeekAgo == null ? null : round2(sum(taxable, (r) => r.cash) - brokerageTaxableWeekAgo),
      delta_basis: brokerageTaxableWeekAgo ? `measured, vs ${histDate}` : "no history yet",
      // Only money-market shares settle T+1; sweep cash moves the same day, so
      // the caveat is attached only when money-market shares are held.
      settlement_note: sum(taxable, (r) => r.money_market) > 0
        ? "money-market shares settle T+1 — about a day to reach checking"
        : null,
      as_of: taxable[0]?.as_of || null,
    },
  };
  // The installation's own review reads the bucket under its legacy name.
  if (B) buckets[`${B}_taxable`] = buckets.brokerage_taxable;

  const freeCash = round2(buckets.real_estate.total + buckets.business.total + buckets.personal.total + buckets.brokerage_taxable.total);
  const weekDeltas = [
    ...pots.real_estate, ...pots.business, ...pots.personal,
  ].map((r) => r.week_delta).filter((d) => d != null);

  return {
    buckets,
    free_cash: freeCash,
    free_cash_week_delta: round2(sum(weekDeltas, (d) => d) + (buckets.brokerage_taxable.week_delta || 0)),
    restricted: {
      security_deposits: { total: potTotal("deposits"), accounts: pots.deposits, note: "tenant money — owed back in full, never counted as cash" },
    },
    not_spendable: {
      retirement_cash: round2(sum(retirement, (r) => r.cash)),
      accounts: retirement,
      note: "cash sitting inside 401k / Roth / HSA — the user's, but not available this week",
    },
    unmapped: { total: potTotal("unmapped"), accounts: pots.unmapped },
  };
}

// ── The properties ──────────────────────────────────────────────────────────

/** Ledger P&L for one property over one window. */
const statementIn = (txns, reg, property, since, until) =>
  statement(txns.filter((t) => t.source.date >= since && t.source.date <= until), reg, property);

/**
 * Per property, then short-term and long-term as groups, then everything.
 *
 * The group level is not decoration. A short-term unit and a long-term unit are
 * different businesses wearing the same asset: one carries cleaning, platform
 * fees and lumpy nightly revenue, the other carries a rent roll and turnover.
 * Averaging the five together hides which of the two models is actually working
 * this year, and reading five separate rows makes the comparison by eye. The
 * membership of each group is resolved against the transaction's own date, so a
 * property that changed hands mid-year lands in the right group for each half.
 */
function buildRealEstate({ registry, ledgerTxns, cash, propertyValues, reconciledValues, unitAvailability, tenants, leases, today, config: given }) {
  const config = rfConfig(given);
  const held = registry.properties.filter((p) => p.kind === "property" && !p.disposedOn);
  const values = valueByProperty(reconciledValues, held.map((p) => p.id), config);
  const monthStart = `${today.slice(0, 7)}-01`;
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const weekStart = dayAdd(today, -7);
  const valueKey = (id) => config.property_value_keys[id] || id.replace(/-/g, "_");

  const rows = held.map((p) => {
    const acctRows = cash.buckets.real_estate.accounts.filter((a) => a.property_id === p.id);
    const propCash = round2(sum(acctRows, (a) => a.balance));

    const week = statementIn(ledgerTxns, registry, p, weekStart, today);
    const mtd = statementIn(ledgerTxns, registry, p, monthStart, today);
    const ytd = statementIn(ledgerTxns, registry, p, yearStart, today);

    // Reserve = months of this property's own running costs its own cash covers.
    // The window is six months, or the whole time it has been held if that is
    // shorter — for a property bought two months ago a six-month average would
    // divide by four months that do not exist.
    const monthsHeld = p.acquiredOn ? monthsBetween(String(p.acquiredOn).slice(0, 10), today) : 12;
    const window = Math.max(1, Math.min(6, monthsHeld));
    const trailing = statementIn(ledgerTxns, registry, p, dayAdd(today, -Math.round(window * 30.4375)), today);
    const monthlyBurn = trailing.expenses > 0 ? trailing.expenses / window : 0;
    const reserveMonths = monthlyBurn > 0 ? round2(propCash / monthlyBurn) : null;

    // Rent roll, for the long-term units: what the signed leases say should
    // arrive every month. This is a fact from the books, which is the whole
    // reason to prefer it over inferring an expected amount from history.
    const slug = p.publicSlug || null;
    const avail = slug ? (unitAvailability || []).find((u) => u.id === slug) : null;
    const currentTenants = (tenants || []).filter((t) => t.propertySlug === slug && t.status === "current");
    const units = Object.entries(avail?.units || {}).map(([unitId, u]) => {
      const occupants = currentTenants.filter((t) => t.unitId === unitId);
      const lease = (leases || []).find((l) => l.status === "completed" && l.terms?.unitId === unitId
        && String(l.terms?.startDate || "").slice(0, 10) <= today && String(l.terms?.endDate || "").slice(0, 10) >= today);
      return {
        unit: unitId,
        rent: Number(u.monthlyRent) || Number(lease?.terms?.rentAmount) || 0,
        occupied: occupants.length > 0,
        next_free: u.availableFrom ? String(u.availableFrom).slice(0, 10) : null,
      };
    });
    const rentRoll = p.rentalType === "long-term" ? round2(sum(units.filter((u) => u.occupied), (u) => u.rent)) : null;
    // Vacancy is a long-term idea. A short-term unit with no tenant on it is
    // not vacant, it is available to book — that is the product. Reporting an
    // empty Tuesday at a short-term rental as "$9,000/mo not being collected" would
    // fire a flag every single week and mean nothing, and a flag that always
    // fires is how the flags stop being read.
    const vacant = p.rentalType === "long-term" ? units.filter((u) => !u.occupied) : [];

    const expiring = currentTenants
      .filter((t) => t.leaseEndDate && String(t.leaseEndDate).slice(0, 10) <= dayAdd(today, 90))
      .map((t) => ({ name: `${t.firstName} ${t.lastName}`, unit: t.unitId, ends: String(t.leaseEndDate).slice(0, 10) }));

    const estimate = values.byProperty[p.id] != null ? round2(values.byProperty[p.id]) : null;
    const pv = (propertyValues || []).filter((v) => v.holding === valueKey(p.id) && v.owned);
    const basis = pv.length ? round2(sum(pv, (v) => v.acquisition_price)) : null;
    // Annualise over the months this property was actually EARNING in this
    // year, not over the year. For a property bought in July, scaling its two
    // months of net up by the eight months of the calendar year that have
    // elapsed reports a yield a third of the real one, and reports it as fact.
    const earningFrom = p.acquiredOn && String(p.acquiredOn).slice(0, 10) > yearStart ? String(p.acquiredOn).slice(0, 10) : yearStart;
    const earningMonths = Math.max(0.5, monthsBetween(earningFrom, today));
    const annualised = ytd.noi * (12 / earningMonths);

    return {
      id: p.id,
      name: p.name,
      rental_type: p.rentalType,
      acquired_on: p.acquiredOn ? String(p.acquiredOn).slice(0, 10) : null,
      cash: propCash,
      accounts: acctRows.map((a) => ({ label: a.label, mask: a.mask, balance: a.balance, week_delta: a.week_delta })),
      week: { income: round2(week.income), expenses: round2(week.expenses), net: round2(week.noi) },
      mtd: { income: round2(mtd.income), expenses: round2(mtd.expenses), net: round2(mtd.noi) },
      ytd: { income: round2(ytd.income), expenses: round2(ytd.expenses), net: round2(ytd.noi), unclassified_count: ytd.unclassifiedCount },
      // A property with no ledger rows at all this year has NO DATA, which is
      // not the same as a $0 year. A property carrying a signed lease once
      // printed "+$0" in every column; the reader must be told it is a gap.
      ledger_empty_ytd: !ytd.income && !ytd.expenses,
      reserve_months: reserveMonths,
      monthly_burn: round2(monthlyBurn),
      reserve_window_months: round2(window),
      rent_roll: rentRoll,
      units: units.length ? units : null,
      vacant_units: vacant.length ? vacant.map((u) => ({ unit: u.unit, rent: u.rent, next_free: u.next_free })) : [],
      leases_expiring_90d: expiring,
      value_estimate: estimate,
      acquisition_price: basis,
      // NOT round2'd: these are ratios, and rounding a ratio to two decimal
      // places rounds a 2.5% yield to 2% and a 0.26% yield to zero. The
      // formatter does the rounding, at the point where it is a percentage.
      yield_on_value: estimate ? annualised / estimate : null,
      yield_on_cost: basis ? annualised / basis : null,
      annualised_net: round2(annualised),
      earning_months: round2(earningMonths),
    };
  });

  const rollup = (label, members) => {
    if (!members.length) return null;
    return {
      label,
      properties: members.map((m) => m.id),
      cash: round2(sum(members, (m) => m.cash)),
      week_net: round2(sum(members, (m) => m.week.net)),
      mtd_net: round2(sum(members, (m) => m.mtd.net)),
      ytd_income: round2(sum(members, (m) => m.ytd.income)),
      ytd_expenses: round2(sum(members, (m) => m.ytd.expenses)),
      ytd_net: round2(sum(members, (m) => m.ytd.net)),
      value_estimate: round2(sum(members, (m) => m.value_estimate || 0)) || null,
      rent_roll: round2(sum(members, (m) => m.rent_roll || 0)) || null,
    };
  };

  const shortTerm = rows.filter((r) => r.rental_type === "short-term");
  const longTerm = rows.filter((r) => r.rental_type === "long-term");

  // A property sold during the year still earned during the year. The five
  // rows above are the ones held today, which is the right list for cash
  // and reserves — but a portfolio year-to-date that quietly omits a sold
  // property's half-year does not reconcile against the books, and the first
  // time that is noticed will be at tax time. So it is carried, separately,
  // named, and never mixed into the short/long-term groups, whose whole point
  // is to compare two live operating models.
  const soldThisYear = registry.properties
    .filter((p) => p.kind === "property" && p.disposedOn && String(p.disposedOn).slice(0, 10) >= yearStart)
    .map((p) => {
      const ytd = statementIn(ledgerTxns, registry, p, yearStart, today);
      return {
        id: p.id, name: p.name, rental_type: p.rentalType,
        disposed_on: String(p.disposedOn).slice(0, 10),
        ytd: { income: round2(ytd.income), expenses: round2(ytd.expenses), net: round2(ytd.noi) },
      };
    })
    .filter((r) => r.ytd.income || r.ytd.expenses);

  const portfolio = rollup("All real estate", rows);
  if (portfolio && soldThisYear.length) {
    portfolio.ytd_income_including_sold = round2(portfolio.ytd_income + sum(soldThisYear, (r) => r.ytd.income));
    portfolio.ytd_expenses_including_sold = round2(portfolio.ytd_expenses + sum(soldThisYear, (r) => r.ytd.expenses));
    portfolio.ytd_net_including_sold = round2(portfolio.ytd_net + sum(soldThisYear, (r) => r.ytd.net));
  }

  return {
    unsplit_values: values.unsplit,
    properties: rows.sort((a, b) => a.ytd.net - b.ytd.net),
    groups: { short_term: rollup("Short-term", shortTerm), long_term: rollup("Long-term", longTerm) },
    portfolio,
    sold_this_year: soldThisYear,
    group_membership_note: "short/long-term membership is resolved against each transaction's own date, so a property bought or sold mid-year lands in the right group for each part of the year",
  };
}

// ── Security deposits ───────────────────────────────────────────────────────
// Deposits are read from the hub's per-tenant records in
// lib/finance-deposit-reconcile.js (via bin/finance-deposits-reconcile).
// Reconstructing them from bank lines produced false "never received" /
// "unaccounted for" alarms.

module.exports = { attributionFor, bucketOf, buildCashBuckets, buildRealEstate, isTaxableBrokerage, valueByProperty };
