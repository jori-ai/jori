"use strict";
// daily-summary-transactions — pick the STANDOUT purchases of a day and match
// them to the day's GPS stops, for the daily-summary spine.
//
// Why this exists: the daily summary surfaces what the user bought
// that day — but only the *standout* purchases (a real meal, a shop run, a
// big-ticket buy), never the full ledger of taps, autopays, and transfers.
// The matched transactions also pin down stop names: when the GPS resolver only
// guessed a restaurant/shop, an in-person card charge at that place names it
// with certainty.
//
// Pure + deterministic (no I/O): the caller (`daily-summary-build`) fetches the
// rows from `plaid_transactions` via the service-role REST client and passes
// them in. Money math lives here, never in the LLM prose step (the same
// principle as the finance review: LLMs don't do the money math).
//
// BANK-DATA POLICY: the rows handled here are bank transactions — jori-model
// -only (agent/CLAUDE.md § Financial Operations rule 5). They may render
// into the self-addressed daily-summary email under the narrow carve-out
// documented in that rule; they must NEVER be forwarded to a third-party/
// external LLM or any claude.ai connector call.

// Plaid sign convention: amount > 0 is money OUT (a spend), < 0 is money IN.
const isOutflow = (t) => Number(t.amount) > 0;

// Categories that are never "what we purchased": internal transfers, loan and
// credit-card payments. (A card autopay is money moving, not a purchase.)
const NOISE_CATS = new Set(["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"]);

// "Experiential" categories — the spend that represents what the user actually
// DID that day (a meal, a show, an outing, a shop run). These clear the
// standout bar at a lower floor than, say, a utility bill or a transport tap,
// because a $40 dinner or $66 movie ticket is exactly the kind of purchase the
// daily summary should narrate.
const EXPERIENTIAL_CATS = new Set([
  "FOOD_AND_DRINK",
  "ENTERTAINMENT",
  "TRAVEL",
  "GENERAL_MERCHANDISE",
  "PERSONAL_CARE",
]);

// Name patterns for card payments / autopay that slip through without a category.
const CC_PAYMENT_RE = /\b(payment thank you|autopay|online payment|e-payment|epay|card payment|bill pay|pymt)\b/i;

// Friendly one-word labels for Plaid's personal_finance_category.primary.
const CATEGORY_LABEL = {
  FOOD_AND_DRINK: "dining",
  GENERAL_MERCHANDISE: "shopping",
  GENERAL_SERVICES: "services",
  TRANSPORTATION: "transport",
  TRAVEL: "travel",
  ENTERTAINMENT: "entertainment",
  PERSONAL_CARE: "personal care",
  MEDICAL: "medical",
  HOME_IMPROVEMENT: "home",
  RENT_AND_UTILITIES: "utilities",
  GOVERNMENT_AND_NON_PROFIT: "charity/gov",
  BANK_FEES: "fees",
};

function categoryLabel(primary) {
  if (!primary) return "";
  return CATEGORY_LABEL[primary] || String(primary).toLowerCase().replace(/_/g, " ");
}

function usd(n) {
  const v = Math.abs(Number(n) || 0);
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Natural money string for narrative prose: whole dollars drop the cents
// ("$120", "$66"), fractional amounts keep them ("$8.50"). This is what the
// agent quotes verbatim into a sentence.
function money(n) {
  const v = Math.abs(Number(n) || 0);
  return Number.isInteger(v) ? `$${v.toLocaleString("en-US")}` : usd(v);
}

// The home metros' own names (agent/local/config/travel.json: the keys and
// aliases of `home_metros`), word by word: a merchant descriptor names the city
// it is in, which says nothing about which shop it was. Empty without config.
function homeMetroWords() {
  const { localConfig } = require("./instance.cjs");
  const cfg = localConfig("travel", { metros: [], home_metros: [] });
  const homes = new Set((cfg.home_metros || []).map(String));
  const out = [];
  for (const m of cfg.metros || []) {
    if (!m || !homes.has(String(m.key))) continue;
    for (const name of [m.key, ...(m.aliases || [])]) out.push(...String(name).toLowerCase().split(/[^a-z0-9]+/));
  }
  return out.filter(Boolean);
}

// Words that carry no identifying signal when matching a merchant to a place.
const STOPWORDS = new Set([
  "the", "and", "of", "a", "an", "llc", "inc", "co", "corp", "ltd",
  "restaurant", "cafe", "caffe", "bar", "grill", "kitchen", "store", "shop",
  "market", "deli", "pizza", "coffee", "usa",
  "company", "group", "services", "service",
  "ave", "san", "los", "las", "old", "mkt", // short geographic/generic noise
  ...homeMetroWords(),
]);

// Normalize a merchant/place string into significant lowercase tokens.
function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\b(x{2,}\d+|\d{3,})\b/g, " ") // strip card-mask / long digit runs
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    // length >= 3 so short brand names (AMC, REI, CVS) still match a stop; the
    // stopword list strips the short generic noise (bar, deli, the city, …).
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

const merchantText = (t) => t.merchant_name || t.name || "";

// Best-effort match of a transaction to one of the day's stops by shared
// significant token between the merchant and the stop's place name. Returns the
// stop id or null. Conservative on purpose: a stray match only annotates a stop
// and surfaces a name candidate the LLM still vets — it never silently renames.
//
// NOTE (2026-06-28): this token match is CIRCULAR for venue-naming — it can only
// confirm a stop whose GUESSED name already shares a word with the merchant, so
// it can never CORRECT a wrong guess. It survives only as the standout↔stop
// annotator (a charge at a stop the resolver happened to name right). The
// venue-NAMING path is `matchTransactions` below, which binds in-person charges
// to stops by channel + geo + date, independent of the guessed name, so a card
// charge can name a stop the GPS only guessed (rule-5 carve-out: in-person
// merchant = certainty the GPS lacked).
function matchStop(t, stops = []) {
  const mTok = new Set(tokens(merchantText(t)));
  if (!mTok.size) return null;
  for (const s of stops) {
    const name = s.place && s.place.name;
    if (!name) continue;
    const pTok = tokens(name);
    if (pTok.some((w) => mTok.has(w))) return s.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mobility taps — transactions that confirm HOW the user moved, not what
// was "bought". A $3 MTA tap, a toll, an Uber, a parking/gas charge are mobility
// evidence the travel-leg narrator should use, but they are NOT "standout
// purchases" (the old selectStandouts dropped them, which is how the 2026-06-27
// subway tap vanished while the narrative invented walking language).
// ---------------------------------------------------------------------------
const MOBILITY_PATTERNS = [
  { re: /\b(mta|metrocard|omny|subway|transit authority|nyct|path train)\b/i, mode: "subway" },
  { re: /\b(uber|lyft|via rideshare|curb taxi|taxi|yellow cab|gett)\b/i, mode: "rideshare" },
  { re: /\b(toll|e-?zpass|ez pass|sunpass|verrazano|port authority|tbta|mta b&t)\b/i, mode: "toll" },
  { re: /\b(citi ?bike|lime|bird scooter|revel)\b/i, mode: "micromobility" },
  { re: /\b(parking|park(?:ng)?|garage|icon parking|spothero|laz parking)\b/i, mode: "parking" },
  { re: /\b(shell|exxon|mobil|chevron|bp|sunoco|gulf|wawa fuel|gas station|fuel)\b/i, mode: "fuel" },
  { re: /\b(amtrak|nj transit|lirr|metro-?north|septa)\b/i, mode: "rail" },
  { re: /\b(american airlines|delta|united|jetblue|spirit|southwest|airlines|airways)\b/i, mode: "flight" }, // kernel-guard-ok: public airline brands, the same for every user
];

// Delivery apps share a brand with ride apps; a meal brought to the door is
// not a way the user moved (a "Uber Eats $78.93" was listed as rideshare
// beside a real MTA tap, muddying the one leg the tap could have settled).
const NOT_MOBILITY = /\b(uber ?eats|doordash|grubhub|seamless|postmates|caviar|instacart)\b/i;

function mobilityMode(t) {
  const text = merchantText(t);
  if (!text) return null;
  if (NOT_MOBILITY.test(text)) return null;
  for (const m of MOBILITY_PATTERNS) if (m.re.test(text)) return m.mode;
  if (t.category_primary === "TRANSPORTATION") return "transport";
  return null;
}

// Extract the day's mobility taps (deduped by mode+merchant). Each: { merchant,
// amount, mode, pending }. These corroborate travel legs; they never render as a
// "purchase".
function selectMobility(txns = []) {
  const seen = new Set();
  const out = [];
  for (const t of txns) {
    if (!isOutflow(t)) continue;
    const mode = mobilityMode(t);
    if (!mode) continue;
    const key = `${mode}:${merchantText(t).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ merchant: merchantText(t) || mode, amount: Math.abs(Number(t.amount)) || 0, mode, pending: !!t.pending });
  }
  return out;
}

// Bind an IN-PERSON purchase to one of the day's stops, geo + date based and
// independent of the resolver's guessed name. Plaid carries no intra-day time,
// so this matches by: payment_channel "in store" (a physical tap) AND the
// charge's merchant city (from raw.location) matching the stop's place address/
// city when available; otherwise it falls to the day's single best dwell stop of
// a matching category. Returns a stop id or null. Conservative: only confident,
// in-person, food/retail/personal charges name a stop.
const NAMING_CATS = new Set(["FOOD_AND_DRINK", "GENERAL_MERCHANDISE", "PERSONAL_CARE", "ENTERTAINMENT"]);
function inPersonStopMatch(t, stops = []) {
  if ((t.payment_channel || "").toLowerCase() !== "in store") return null;
  if (!NAMING_CATS.has(t.category_primary)) return null;
  // First try the token path (names a right-guessed stop with certainty).
  const tok = matchStop(t, stops);
  if (tok) return tok;
  // Geo path: city of the charge vs the stop's address string.
  const city = t.raw && t.raw.location && t.raw.location.city;
  if (city) {
    const c = String(city).toLowerCase();
    const dwell = stops.filter(s => s.pattern !== "browse");
    const hit = dwell.find(s => {
      const addr = (s.place && s.place.address) || "";
      return addr.toLowerCase().includes(c);
    });
    if (hit) return hit.id;
  }
  return null;
}

// Full transaction match for the confirmed-fact backbone. Returns:
//   { byStopId:{<id>:[{merchant,amount,...}]}, mobility:[...], standouts:[...] }
// byStopId holds in-person NAMING charges (a merchant that can name/corroborate
// a stop's venue); mobility holds travel taps; standouts is the existing
// notable-purchase set (for weaving into prose).
function matchTransactions(txns = [], stops = []) {
  const byStopId = {};
  for (const t of txns) {
    if (!isOutflow(t)) continue;
    if (NOISE_CATS.has(t.category_primary)) continue;
    if (CC_PAYMENT_RE.test(merchantText(t))) continue;
    if (mobilityMode(t)) continue; // mobility handled separately
    const stop_id = inPersonStopMatch(t, stops);
    if (!stop_id) continue;
    (byStopId[stop_id] = byStopId[stop_id] || []).push({
      merchant: merchantText(t) || "unknown",
      amount: Math.abs(Number(t.amount)) || 0,
      category: t.category_primary || null,
      category_label: categoryLabel(t.category_primary),
      payment_channel: t.payment_channel || null,
      pending: !!t.pending,
      stop_id,
    });
  }
  const mobility = selectMobility(txns);
  const { standouts } = selectStandouts(txns, stops);
  return { byStopId, mobility, standouts };
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// Select the day's standout purchases.
//
// A non-noise outflow is "standout" if ANY of:
//   • amount >= `min` (default $75) — a big purchase of any kind is notable; OR
//   • it's an experiential category (dining/entertainment/travel/shopping/
//     personal-care) AND amount >= `experientialMin` (default $25) — the meal,
//     show, or shop run that represents what the day actually was; OR
//   • it ties to a visited stop AND amount >= `inPersonMin` (default $15) — the
//     in-person charge that names/characterizes where the user was, even if small.
// Capped at `max` (default 6), sorted by amount descending. Pending in-person
// charges are kept (they're the freshest same-day signal) and flagged.
//
// Returns { standouts:[{merchant, amount, category, category_label, stop_id,
// pending, payment_channel}], byStopId:{<id>:[...]}, total }.
function selectStandouts(txns = [], stops = [], opts = {}) {
  const MIN = num(opts.min ?? process.env.DS_STANDOUT_MIN, 75);
  const EXPERIENTIAL_MIN = num(opts.experientialMin ?? process.env.DS_STANDOUT_EXPERIENTIAL_MIN, 25);
  const INPERSON_MIN = num(opts.inPersonMin ?? process.env.DS_STANDOUT_INPERSON_MIN, 15);
  const MAX = num(opts.max ?? process.env.DS_STANDOUT_MAX, 6);

  const candidates = [];
  for (const t of txns) {
    if (!isOutflow(t)) continue;
    if (NOISE_CATS.has(t.category_primary)) continue;
    if (CC_PAYMENT_RE.test(merchantText(t))) continue;
    const amount = Math.abs(Number(t.amount));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const stop_id = matchStop(t, stops);
    const standout =
      amount >= MIN ||
      (EXPERIENTIAL_CATS.has(t.category_primary) && amount >= EXPERIENTIAL_MIN) ||
      (stop_id && amount >= INPERSON_MIN);
    if (!standout) continue;
    candidates.push({
      transaction_id: t.transaction_id,
      merchant: merchantText(t) || "unknown",
      amount,
      category: t.category_primary || null,
      category_label: categoryLabel(t.category_primary),
      payment_channel: t.payment_channel || null,
      pending: !!t.pending,
      stop_id,
    });
  }

  candidates.sort((a, b) => b.amount - a.amount);
  const standouts = candidates.slice(0, MAX);

  const byStopId = {};
  for (const s of standouts) {
    if (s.stop_id) (byStopId[s.stop_id] = byStopId[s.stop_id] || []).push(s);
  }
  const total = standouts.reduce((acc, s) => acc + s.amount, 0);
  return { standouts, byStopId, total };
}

module.exports = {
  selectStandouts,
  matchStop,
  matchTransactions,
  selectMobility,
  mobilityMode,
  categoryLabel,
  usd,
  money,
  isOutflow,
  _internal: { tokens, merchantText, NOISE_CATS, CC_PAYMENT_RE, EXPERIENTIAL_CATS, MOBILITY_PATTERNS, inPersonStopMatch },
};
