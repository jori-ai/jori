"use strict";
// owner-stays.js — which nights the user slept at a property they also let
// out, and what its books look like once those nights are taken out.
//
// WHY. A short-term rental the family also lives in has a ledger that mixes
// two things: a rental business, and a home. A month the family lived there
// for 29 of 30 nights read "$0 in, $2,813 out, negative". The requirement: the
// time the family is in each such property is excluded, so a property in
// data/owner-use-properties.json is judged on the nights it was available to
// rent.
//
// PRESENCE comes from the phone's location record (location_history), not from
// the travel_segments table: that table is a forward-looking schedule and holds
// no past nights. A night is the 03:00 home-time instant between a date and the
// next (instance().tz; config `night_hour`); it belongs to the property whose
// named location the phone was inside then. Geometry only — no language, no
// model.
//
// THE RULE for money (pure, below): income is left as booked (nobody pays
// rent to himself); a cost that exists only because a guest stayed (cleaning,
// platform fee) is left whole; every other expense is scaled by the share of
// the month the property was available to rent. A full-months-only property
// (`full_months_only`: let by the whole month only) has no partly rentable
// month: any owner night sets the whole month aside. Capital items sit outside
// the P&L and are not touched. The as-booked figures always travel alongside.
//
// With no data/owner-use-properties.json (a fresh install) no property is
// owner-use and every night is rentable.

const fs = require("node:fs");
const { haversineMeters } = require("./known-stops.js");
const { loadNamedLocations } = require("./named-locations.js");
const { instance } = require("./instance.cjs");
const { toolsPath } = require("./root.cjs");

const CONFIG_PATH = toolsPath("data", "owner-use-properties.json");
const HOUR_MS = 3600e3;
// A sample this close to the night instant speaks for it; a phone that sat
// still at home all night records its arrival and nothing after.
const NEAREST_MAX_MS = 6 * HOUR_MS;
// Two samples at the same home on either side of the night bound it, however
// far apart they are (a phone asleep on a charger logs nothing).
const BRIDGE_MAX_MS = 36 * HOUR_MS;

function loadConfig(file = CONFIG_PATH) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** The owner-use entry for a property id, with its coordinates resolved, or null. */
function ownerUseFor(propertyId, config = loadConfig(), named = loadNamedLocations()) {
  const entry = config?.properties?.[propertyId];
  if (!entry) return null;
  const spot = named.find((n) => n.name === entry.named_location);
  if (!spot) return null;
  return {
    propertyId, lat: spot.lat, lon: spot.lon, radiusM: config.radius_m || 250, nightHour: nightHourOf(config),
    fullMonthsOnly: entry.full_months_only === true,
  };
}

/** The night hour (home time) from the config: `night_hour`, or its older name `night_hour_et`; 3 by default. */
const nightHourOf = (config) => config?.night_hour ?? config?.night_hour_et ?? 3;

const pad2 = (n) => String(n).padStart(2, "0");
const addDays = (ds, n) => new Date(Date.parse(`${ds}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

/**
 * UTC ms of `hour`:00 in zone `tz` (default the home zone) on calendar date
 * `ds`, DST-correct: the offset, in quarter hours from UTC-14 to UTC+14, that
 * lands on that local date, hour and minute :00.
 */
function nightInstant(ds, hour, tz = instance().tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false });
  const base = Date.parse(`${ds}T${pad2(hour)}:00:00Z`);
  for (let q = -56; q <= 56; q++) {
    const ms = base + q * (HOUR_MS / 4);
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day}` === ds && Number(p.hour) % 24 === hour && Number(p.minute) === 0) return ms;
  }
  return base;
}

/**
 * Which owner-use property (if any) the phone was at on the night after date `ds`.
 * @param samples  toSamples() output, [{t, lat, lon}] in any order
 * @param homes    [{propertyId, lat, lon, radiusM}]
 * @returns {{at: string|null, basis: string}}  at = propertyId | null (elsewhere/unknown); basis says why
 */
function nightAt(ds, samples, homes, nightHour = 3) {
  const t = nightInstant(addDays(ds, 1), nightHour);
  const homeOf = (s) => {
    for (const h of homes) if (haversineMeters(s.lat, s.lon, h.lat, h.lon) <= h.radiusM) return h.propertyId;
    return null;
  };
  // `departed_at` is deliberately not used: a visit row's departure is often
  // stamped days after its arrival (+59 h has been seen) and would claim
  // nights the phone spent somewhere else. Arrival fixes are the evidence.
  let before = null, after = null;
  for (const s of samples) {
    if (s.t <= t && (!before || s.t > before.t)) before = s;
    if (s.t >= t && (!after || s.t < after.t)) after = s;
  }
  if (before && after) {
    const a = homeOf(before), b = homeOf(after);
    if (a && a === b && after.t - before.t <= BRIDGE_MAX_MS) return { at: a, basis: "bridged" };
  }
  const nearest = [before, after].filter(Boolean).sort((x, y) => Math.abs(x.t - t) - Math.abs(y.t - t))[0];
  if (nearest && Math.abs(nearest.t - t) <= NEAREST_MAX_MS) return { at: homeOf(nearest), basis: "nearest" };
  return { at: null, basis: "unknown" };
}

/** Normalise raw rows into samples; drops rows without a usable fix. */
function toSamples(rows) {
  return (rows || [])
    .filter((r) => r.latitude != null && r.longitude != null && (r.accuracy_m == null || r.accuracy_m <= 200))
    .map((r) => ({ t: Date.parse(r.arrived_at), lat: Number(r.latitude), lon: Number(r.longitude) }))
    .filter((s) => Number.isFinite(s.t));
}

/**
 * Nights per owner-use property over [fromDate, toDate] (YYYY-MM-DD, inclusive;
 * the night counted for a date is the one that begins that evening).
 * @returns {Map<string, {at: string|null, basis: string}>} date → night
 */
function classifyNights(fromDate, toDate, rows, homes, nightHour = 3) {
  const samples = toSamples(rows);
  const out = new Map();
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) out.set(d, nightAt(d, samples, homes, nightHour));
  return out;
}

/**
 * Owner nights vs the rest for one calendar month, from a nights map.
 * `fullMonthsOnly`: the property is let by the whole month only, so any owner night makes the month not rentable at all. A
 * leftover night does not count as available: rentable is 0 and `ineligible` is
 * true, and the caller treats the owner share as 1.
 */
function monthNights(ym, nights, propertyId, { fullMonthsOnly = false } = {}) {
  const [y, m] = ym.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let owner = 0, unknown = 0;
  for (let i = 1; i <= days; i++) {
    const n = nights.get(`${ym}-${pad2(i)}`);
    if (!n) { unknown += 1; continue; }
    if (n.at === propertyId) owner += 1;
    else if (n.basis === "unknown") unknown += 1;
  }
  if (fullMonthsOnly && owner > 0) return { days, owner, rentable: 0, unknown, ineligible: true };
  return { days, owner, rentable: days - owner, unknown };
}

/** The share of a month to set aside as the owner's: all of it for a month a full-months-only property cannot be let. */
const ownerShareOf = (nm) => (nm.ineligible ? 1 : nm.owner / nm.days);

const cents = (n) => Math.round(Number(n) * 100);

/**
 * The statement with the owner's nights taken out.
 * @param stmt       ledger.statement() result {lines, income, expenses, noi}
 * @param ownerShare owner nights / days in the month (0..1)
 * @param guestDriven Set of categoryIds kept whole
 * @returns same shape, plus per-line {asBooked} and totals {asBooked: {income, expenses, noi}}
 */
function adjustStatement(stmt, ownerShare, guestDriven) {
  const keep = 1 - ownerShare;
  let incomeC = 0, expenseC = 0;
  const lines = stmt.lines.map((l) => {
    const bookedC = cents(l.amount);
    const scale = l.kind === "expense" && !guestDriven.has(l.categoryId) ? keep : 1;
    const adjC = scale === 1 ? bookedC : Math.round(bookedC * scale);
    if (l.kind === "income") incomeC += adjC;
    else if (l.kind === "expense") expenseC += adjC;
    return { ...l, amount: adjC / 100, asBooked: bookedC / 100 };
  });
  return {
    ...stmt,
    lines,
    income: incomeC / 100,
    expenses: expenseC / 100,
    noi: (incomeC - expenseC) / 100,
    asBooked: { income: stmt.income, expenses: stmt.expenses, noi: stmt.noi },
  };
}

module.exports = { loadConfig, ownerUseFor, nightHourOf, nightInstant,
  // The historical name (03:00 home time; the home zone was US Eastern).
  etInstant: nightInstant, nightAt, toSamples, classifyNights, monthNights, ownerShareOf, adjustStatement, addDays };
