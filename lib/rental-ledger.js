"use strict";
// rental-ledger — a rental portfolio's books: reference data and accounting
// rules, in one place, for every reader.
//
// The books live in a Firestore project (collections financial-properties,
// financial-accounts, financial-categories, financial-transactions) written by
// the portfolio's own hub app. Which project, and the names the user calls the
// properties by, are this installation's: agent/local/config/rentals.json
// (`firebase_project`, `service_account_env`, `aliases`). No project
// configured = no rental books on this installation; readers say so.
//
// WHY THIS IS A LIBRARY AND NOT A COPY. The rules below mirror the hub app's
// financials library line for line, and the reason that mirroring is
// tolerable at all is that there is exactly one mirror. `bin/rentals` held
// them first; when the weekly finance review needed per-property P&L, the
// choice was to copy them a second time or to lift them out. Two tools
// answering "what did one house cost last year" with different numbers is
// worse than one of them not answering — and three tools is how that happens.
// So: one implementation, many readers.
//
// READ-ONLY, by construction. There is no write path here and none in
// lib/firestore-rest.js, which has `get`, `list` and `query` and nothing
// else. The ledger has three authors — sync writes the bank's facts, a
// classifier writes its verdict, the admin writes corrections — and survives
// being continuously re-synced *and* freely corrected precisely because each
// layer has one writer. A fourth author arriving over a CLI is how a
// correction gets silently overwritten at 3am. Corrections happen in the hub's
// Financials tab, where they are attributed to a person.
//
// Callers must have called loadEnv() themselves; this module reads credentials
// but deliberately does not install them.

const { FirestoreClient } = require("./firestore-rest.js");
const { instance, localConfig } = require("./instance.cjs");

/** This installation's rental books: where they live and what the user calls each property. */
function config() {
  return localConfig("rentals", {
    firebase_project: "",        // the Firestore project holding the books; "" = none
    service_account_env: "",     // env var naming its service-account key file
    key_hint: "",                // where the key lives on this machine (shown when it is missing)
    aliases: {},                 // spoken name (lowercase) → registry id
  });
}

// ── Small shared helpers ────────────────────────────────────────────────────

/** Dates are shown in the user's zone; storage stays whatever it is. */
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: instance().tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const has = (haystack, needle) => String(haystack || "").toLowerCase().includes(String(needle).toLowerCase());

// ── Stores ──────────────────────────────────────────────────────────────────

let _fs = null;
function firestore() {
  if (_fs) return _fs;
  const cfg = config();
  if (!cfg.firebase_project) {
    console.error("rentals: no rental books are configured on this installation (agent/local/config/rentals.json `firebase_project`).");
    process.exit(2);
  }
  try {
    _fs = new FirestoreClient({ projectId: cfg.firebase_project, envVar: cfg.service_account_env || undefined });
  } catch (err) {
    // A missing key is the one failure worth explaining rather than stack-tracing:
    // it is what a fresh machine looks like.
    console.error(`rentals: ${err.message}`);
    console.error("The key is the books' Firebase admin SDK service account.");
    if (cfg.key_hint) console.error(`  ${cfg.key_hint}`);
    process.exit(2);
  }
  return _fs;
}

/** The three small reference collections every money answer needs. */
let _registry = null;
async function registry() {
  if (_registry) return _registry;
  const db = firestore();
  const [properties, accounts, categories] = await Promise.all([
    db.list("financial-properties"),
    db.list("financial-accounts"),
    db.list("financial-categories"),
  ]);
  properties.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  categories.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  _registry = {
    properties,
    accounts,
    categories,
    propertyById: new Map(properties.map((p) => [p.id, p])),
    categoryById: new Map(categories.map((c) => [c.id, c])),
    accountById: new Map(accounts.map((a) => [a.id, a])),
    unclassifiedId: categories.find((c) => c.isUnclassified)?.id ?? null,
  };
  return _registry;
}

// ── Naming ──────────────────────────────────────────────────────────────────
//
// One property has up to four names: the financial registry id (`oak-12`),
// the public/site slug the tenants and leases carry (`12OakSt`), the display
// name (`Oak 12`), and whatever the user calls it out loud. The last one is
// why the alias table exists — a spoken name often matches none of the other
// three. The table is this installation's (rentals.json `aliases`).

function lowerKeys(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) if (!k.startsWith("_")) out[k.toLowerCase()] = v;
  return out;
}
const ALIASES = lowerKeys(config().aliases);

/**
 * Resolve however the question named a property to the registry id.
 * Exact id, public slug, alias, then a unique substring of the name or address.
 * An ambiguous name fails loudly rather than picking the first match — two
 * houses on one street share most of an address, and guessing between them
 * misfiles money.
 */
function resolveProperty(properties, q) {
  if (!q) return null;
  const needle = String(q).trim().toLowerCase();
  const byId = properties.find((p) => p.id.toLowerCase() === needle);
  if (byId) return byId;
  const bySlug = properties.find((p) => (p.publicSlug || "").toLowerCase() === needle);
  if (bySlug) return bySlug;
  if (ALIASES[needle]) {
    const aliased = properties.find((p) => p.id === ALIASES[needle]);
    if (aliased) return aliased;
  }
  const matches = properties.filter((p) => has(p.name, needle) || has(p.address, needle));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`"${q}" matches ${matches.length} properties: ${matches.map((m) => m.id).join(", ")}. Name one.`);
  }
  throw new Error(`No property matches "${q}". Known: ${properties.map((p) => p.id).join(", ")}`);
}

/** The unit-availability doc a property's units live under. */
const publicSlugOf = (property) => property.publicSlug || null;

// ── Ledger semantics ────────────────────────────────────────────────────────
//
// Mirrors the hub app's financials library — deliberately, line for line. Two
// tools answering "what did one house cost last year" with different numbers is
// worse than one of them not answering at all, so the rules are copied rather
// than reinvented: override beats classification, splits and group assignments
// fan a charge out, excluded and ignored rows count nowhere, and the sign flips
// exactly once — at the statement.

const effectiveCategoryId = (t) => t.override?.categoryId ?? t.classification?.categoryId ?? null;
const effectivePropertyId = (t) => (t.override?.propertyGroup ? null : (t.override?.propertyId ?? t.classification?.propertyId ?? null));
const countsInReports = (t) => t.override?.excluded !== true && t.override?.ignored !== true;

const onOrAfter = (date, from) => !from || date >= from;
const onOrBefore = (date, to) => !to || date <= to;

/** The properties a group reaches on a date — held that day, of that type. */
function propertiesInGroup(properties, group, onDate) {
  return properties
    .filter((p) => p.kind === "property")
    .filter((p) => group === "all" || p.rentalType === group)
    .filter((p) => onOrAfter(onDate, p.acquiredOn) && onOrBefore(onDate, p.disposedOn))
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
}

/** Divide in cents, remainder to the earliest — no cent invented or lost. */
function divideEvenly(amount, ids) {
  const totalCents = Math.round(amount * 100);
  const base = Math.trunc(totalCents / ids.length);
  let remainder = Math.abs(totalCents - base * ids.length);
  const step = totalCents < 0 ? -1 : 1;
  return ids.map((propertyId) => {
    const extra = remainder > 0 ? step : 0;
    if (remainder > 0) remainder -= 1;
    return { propertyId, amount: (base + extra) / 100 };
  });
}

/** How one transaction lands on the statements: one row, several, or none. */
function contributionsOf(txn, properties) {
  const group = txn.override?.propertyGroup ?? null;
  if (group) {
    const members = propertiesInGroup(properties, group, txn.source.date);
    const categoryId = effectiveCategoryId(txn);
    // No members that day: keep the money visible as unattributed rather than
    // letting it drop out of the statement entirely.
    if (!members.length) return [{ categoryId, propertyId: null, amount: txn.source.amount }];
    return divideEvenly(txn.source.amount, members.map((p) => p.id))
      .map((s) => ({ categoryId, propertyId: s.propertyId, amount: s.amount }));
  }
  if (txn.splits && txn.splits.length) {
    return txn.splits.map((s) => ({
      categoryId: s.categoryId,
      propertyId: s.propertyId ?? effectivePropertyId(txn),
      amount: s.amount,
    }));
  }
  return [{ categoryId: effectiveCategoryId(txn), propertyId: effectivePropertyId(txn), amount: txn.source.amount }];
}

/**
 * Load transactions for a date range. The ledger is denormalised by calendar
 * year (`fiscalYear`) precisely so a report reads one year instead of the whole
 * book, so a range spanning years is fetched a year at a time.
 */
async function loadTransactions({ since, until }) {
  const db = firestore();
  const firstYear = Number(since.slice(0, 4));
  const lastYear = Number(until.slice(0, 4));
  const years = [];
  for (let y = firstYear; y <= lastYear; y++) years.push(y);
  const pages = await Promise.all(
    years.map((y) => db.query("financial-transactions", { where: [["fiscalYear", "EQUAL", y]], limit: 20000 }))
  );
  return pages
    .flat()
    .filter((t) => t.source && t.source.date >= since && t.source.date <= until)
    .sort((a, b) => (a.source.date < b.source.date ? 1 : -1));
}

/** The window a command should read, from --year / --since / --until. */
function dateRange(flags) {
  if (flags.year) return { since: `${flags.year}-01-01`, until: `${flags.year}-12-31` };
  const until = flags.until || today();
  const since = flags.since || `${until.slice(0, 4)}-01-01`;
  return { since, until };
}

/** buildStatement, in cents, mirroring the hub's pnl.ts. */
function statement(txns, reg, property) {
  const reportable = new Set(reg.properties.filter((p) => p.kind === "property").map((p) => p.id));
  const totals = new Map();
  let unclassifiedCount = 0;
  let unclassifiedCents = 0;

  for (const txn of txns) {
    if (!countsInReports(txn)) continue;
    for (const c of contributionsOf(txn, reg.properties)) {
      if (property) { if (c.propertyId !== property.id) continue; }
      else if (c.propertyId === null || !reportable.has(c.propertyId)) continue;

      const category = c.categoryId ? reg.categoryById.get(c.categoryId) : null;
      if (category?.excludedFromReports) continue;   // a transfer is a finished answer
      if (!c.categoryId || c.categoryId === reg.unclassifiedId) {
        unclassifiedCount += 1;
        unclassifiedCents += Math.round(c.amount * 100);
        continue;
      }
      const entry = totals.get(c.categoryId) || { cents: 0, count: 0 };
      entry.cents += Math.round(c.amount * 100);
      entry.count += 1;
      totals.set(c.categoryId, entry);
    }
  }

  const lines = [];
  let incomeCents = 0;
  let expenseCents = 0;
  for (const [categoryId, entry] of totals) {
    const category = reg.categoryById.get(categoryId);
    if (!category) continue;
    // Plaid's convention flips exactly once, here: money in is negative.
    const signed = category.kind === "income" ? -entry.cents : entry.cents;
    if (category.kind === "income") incomeCents += signed; else expenseCents += signed;
    lines.push({ categoryId, name: category.name, kind: category.kind, scheduleELine: category.scheduleELine, amount: signed / 100, count: entry.count, sortOrder: category.sortOrder || 0 });
  }
  lines.sort((a, b) => a.sortOrder - b.sortOrder);
  return {
    lines,
    income: incomeCents / 100,
    expenses: expenseCents / 100,
    noi: Math.round((incomeCents - expenseCents)) / 100,
    unclassifiedCount,
    unclassifiedAmount: unclassifiedCents / 100,
  };
}


module.exports = {
  config,
  today,
  has,
  firestore,
  registry,
  ALIASES,
  resolveProperty,
  publicSlugOf,
  effectiveCategoryId,
  effectivePropertyId,
  countsInReports,
  propertiesInGroup,
  divideEvenly,
  contributionsOf,
  loadTransactions,
  dateRange,
  statement,
};
