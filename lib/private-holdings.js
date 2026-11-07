"use strict";
// private-holdings — funded private stakes (SPVs, direct rounds), each valued
// at its latest round: value = committed × mark valuation / entry valuation.
//
// ONE valuer for every net-worth figure. Net worth, the weekly finance review
// and the hum net-worth line each used to add up their own assets, and only
// net worth had this one — so the three quoted different totals for the same
// day, the others silently missing an investment.
//
// Data file: agent/local/config/investments.json `net_worth.private_holdings_file`
// (relative to the installation's kernel tree), shaped
//   { holdings: [{ name, status: "funded", committed_usd, entry_valuation_usd?,
//                  mark_valuation_usd?, mark_as_of?, vehicle? }] }
// Not configured / unreadable → [] (no private line, never a throw).

const fs = require("node:fs");
const { localConfig } = require("./instance.cjs");
const { installTools } = require("./root.cjs");

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Pure: value the registry's funded holdings. */
function valueHoldings(reg) {
  return ((reg && reg.holdings) || []).filter((h) => h.status === "funded" && num(h.committed_usd))
    .map((h) => {
      const entry = num(h.entry_valuation_usd);
      const mark = num(h.mark_valuation_usd);
      const value = entry && mark ? num(h.committed_usd) * mark / entry : num(h.committed_usd);
      return { name: h.name, vehicle: h.vehicle || null, committed: num(h.committed_usd), value, mark, mark_as_of: h.mark_as_of || null };
    });
}

/** Read the configured registry and value it. `file` overrides the config. */
function privateHoldings(file) {
  const rel = file !== undefined ? file : (localConfig("investments", { net_worth: {} }).net_worth || {}).private_holdings_file;
  if (!rel) return [];
  try {
    return valueHoldings(JSON.parse(fs.readFileSync(rel.startsWith("/") ? rel : installTools(rel), "utf8")));
  } catch {
    return [];
  }
}

function privateTotal(list) {
  return (list || []).reduce((s, h) => s + (Number(h.value) || 0), 0);
}

module.exports = { privateHoldings, valueHoldings, privateTotal };
