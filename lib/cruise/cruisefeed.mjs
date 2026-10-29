// CruiseFeed — the PRIMARY cruise data source from 2026-09-01.
//
// Requirement: use it as the primary data source and verify/complement it with
// our own scrapes. CruiseFeed (cruisefeed.io) publishes ~79,600 sailings
// across 61 lines under one schema, where we scrape seven lines under seven.
// The per-line extractors stay: they are now the VERIFICATION path, and the
// only source of the two things CruiseFeed does not carry — promotions, and a
// fare read straight from the operator.
//
// WHAT IT REPLACES. Its schema lines up with ours almost field for field, and
// its measured coverage (published at /v1/coverage, no key needed) is:
// `round_trip` 100% guaranteed, `disembark_port` 98.6%, `itinerary` 96.7%,
// `fares[]` by cabin class 88.2%. Those are the exact things that cost the most
// to derive by hand — one-way vs repositioning, sea-day and endpoint cleanup,
// and a balcony fare on lines that publish only their cheapest cabin.
//
// WHAT IT DOES NOT CARRY, and how that is covered:
//   - PROMOTIONS. No field, at any tier. By design, promos are fetched from
//     the line's own site for STARRED sailings only, which is where they
//     actually matter — see the watchlist in alerts.mjs.
//   - Taxes: `taxes_and_fees` is populated on 16% of rows, so
//     `taxes_fees_included` stays null here rather than being guessed.
//
// THE DUPLICATE TRAP. CruiseFeed's own docs warn that one sailing can appear as
// several records, and that "222 of the 1,013 record pairs that describe one
// sailing quote lead-in fares more than 10% apart". Our watchlist alerts at
// exactly 10%, so naive use would manufacture drops out of the gap between two
// records of the same sailing. `dedupe=true` (their default, set explicitly
// here so it cannot drift) collapses them, first-party source winning, and we
// key on their stable `sailing_id`.
//
// BUDGET, MEASURED 2026-09-01, AND WHY THE QUERY IS SHAPED THE WAY IT IS.
//
// Pulling the ports across a rolling horizon cost 3,343 results against a
// 2,000/month grant — one pass exhausts the month. Restricting to the TRAVEL
// PLAN's own windows (the dates the user is actually near the configured
// ports) and dropping one metro brought the same pull to **825**, which fits
// twice over inside the grant. That is the difference between a
// source that can run monthly and one that cannot run at all.
//
// OLD NOTE, kept because the numbers are the argument for the shape above. The free tier is
// 2,000 results a MONTH, and one unbounded pull of the three configured ports
// was 3,343 balcony sailings — the busiest port alone 1,934. Even capped to a 16-month
// departure window it is 2,402. So a single naive pass exhausts the month and
// the next one returns nothing.
//
// Two defences. `maxResults` is a hard stop counted across every port. And
// every response carries an `allowance` envelope (`remaining`, `resets_at`),
// which is read after each page: the run stops as soon as the remaining grant
// would be spent, keeping a small reserve so an interactive query later in the
// month still works. A budget the server reports beats one we assume.

import { loadEnvOnce } from "./db.mjs";
import { cruiseConfig } from "./config.mjs";

const API = "https://api.cruisefeed.io/v1";
const DAY_MS = 86_400_000;
const PAGE = 500; // their maximum

/**
 * Departure ports to pull — the cruise-watch config `embark_ports`.
 *
 * Keep it to the ports of the plan's cruise-shaped windows: a metered source
 * spends budget only where it adds most, and every other port's inventory
 * still arrives through the per-line scrapers. With none configured nothing
 * is pulled.
 *
 * `embark_port` is a SUBSTRING match on their side, so these are prefixes, not
 * codes.
 */
export function defaultEmbarkPorts() {
  return cruiseConfig().embark_ports || [];
}

/** Their `cruise_line` display names → our extractor keys, so a CruiseFeed row
 *  and a directly-scraped row for the same line agree on `source`. A line we do
 *  not scrape keeps a slug of its own name and simply has no verification path. */
const LINE_KEY = {
  "royal caribbean": "royal",
  "royal caribbean international": "royal",
  "celebrity cruises": "celebrity",
  celebrity: "celebrity",
  "norwegian cruise line": "ncl",
  norwegian: "ncl",
  "msc cruises": "msc",
  msc: "msc",
  "virgin voyages": "virgin",
  "holland america line": "holland",
  "holland america": "holland",
  "princess cruises": "princess",
  princess: "princess",
};

export function lineKeyFor(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return "unknown";
  return LINE_KEY[n] || n.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Collapse plan windows into the fewest date ranges that cover them.
 *
 * The plan is a month-by-month list, so four consecutive months in one city are four
 * windows describing one continuous stay. Querying each separately would pay
 * for the same sailings four times over on a per-result budget. Ranges that
 * touch or overlap merge; a one-day gap counts as touching, because a plan that
 * ends on the 30th and resumes on the 1st is not a real gap.
 */
export function mergeWindows(windows) {
  const clean = (windows || [])
    .map((w) => ({ start: String(w?.start || "").slice(0, 10), end: String(w?.end || "").slice(0, 10) }))
    .filter((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.start) && /^\d{4}-\d{2}-\d{2}$/.test(w.end) && w.start <= w.end)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  const out = [];
  for (const w of clean) {
    const prev = out[out.length - 1];
    if (prev && Date.parse(w.start) <= Date.parse(prev.end) + DAY_MS) {
      if (w.end > prev.end) prev.end = w.end;
    } else {
      out.push({ ...w });
    }
  }
  return out;
}

async function apiKey() {
  // The key lives in .env; this runs before any DB call, so the env has
  // to be bootstrapped here rather than assumed.
  await loadEnvOnce();
  return process.env.CRUISEFEED_API_KEY || null;
}

async function getPage(params, key, signal) {
  const url = `${API}/cruises?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, accept: "application/json" },
    signal: signal ?? AbortSignal.timeout(45_000),
  });
  if (res.status === 401) throw new Error("cruisefeed: invalid or missing API key");
  if (res.status === 429) throw new Error("cruisefeed: rate limited / monthly allowance exhausted");
  if (!res.ok) throw new Error(`cruisefeed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * The cheapest BALCONY fare on a record, per person.
 *
 * `cabin_category` is CruiseFeed's normalized bucket (interior | oceanview |
 * balcony | suite | other) over each operator's own `cabin_class` wording, so
 * it is the field to trust — a line calling it "Sea Terrace" or "Veranda" still
 * buckets as balcony. `available === false` is a fare the line is showing but
 * not selling; `null` means the source does not say, which is not a reason to
 * discard it.
 */
export function balconyFare(record) {
  let best = null;
  for (const f of record?.fares || []) {
    const bucket = String(f?.cabin_category || "").toLowerCase();
    const label = String(f?.cabin_class || "").toLowerCase();
    const isBalcony = bucket === "balcony" || (!bucket && /balcon|veranda|terrace/.test(label));
    if (!isBalcony || f.available === false) continue;
    const v = Number(f.price_amount);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (best === null || v < best) best = v;
  }
  return best;
}

/**
 * Ports of call: their itinerary minus the two ends and the sea days.
 *
 * `seq` is guaranteed and is the documented ordering key — `day_number` is null
 * on about half of all stops, so sorting by it would scramble the list.
 */
export function portsOfCall(record) {
  const stops = [...(record?.itinerary || [])]
    .filter((s) => s && s.port)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return stops
    .filter((s) => !s.is_sea_day && !s.is_embark && !s.is_disembark)
    .map((s) => ({ code: s.port_code || null, name: String(s.port).split(",")[0].trim() }));
}

/** One CruiseFeed record → the shared cruise_sailings shape. */
export function toSailing(r) {
  // `Number(null)` is 0 and `Number.isFinite(0)` is true, so a null night count
  // sails straight through a naive finite check — require a positive number.
  const nights = r?.nights === null || r?.nights === undefined ? NaN : Number(r.nights);
  const depart = r?.departure_date ? String(r.departure_date).slice(0, 10) : null;
  const ship = r?.ship_name ? String(r.ship_name).trim() : null;
  const embark = r?.embark_port ? String(r.embark_port).trim() : null;
  if (!depart || !ship || !embark || !Number.isFinite(nights) || nights <= 0) return null;

  const balcony = balconyFare(r);
  return {
    source: lineKeyFor(r.cruise_line),
    // Their stable id, namespaced so it can never collide with a
    // directly-scraped `<line>:<id>`.
    sailing_id: `cf:${r.sailing_id || r.id}`,
    cruise_id: r.destination_code || null,
    ship_name: ship,
    ship_built_year: null,
    departure_port: embark,
    departure_port_code: null,
    departure_port_region: r.region || null,
    ports_of_call: portsOfCall(r),
    ports_ordered: true,
    // `round_trip` is the one field they guarantee on every row, so a one-way
    // is theirs to assert rather than ours to infer.
    disembark_port: r.disembark_port ? String(r.disembark_port).trim() : (r.round_trip ? embark : null),
    disembark_port_code: null,
    depart_date: depart,
    return_date: r.return_date ? String(r.return_date).slice(0, 10) : null,
    nights,
    lowest_balcony_per_person_usd: balcony,
    // Their `taxes_and_fees` lands on 16% of rows, so neither answer is
    // supportable across the corpus.
    taxes_fees_included: null,
    currency: r.price_currency || "USD",
    booking_url: r.booking_url || r.detail_url || null,
    product_url: r.detail_url || null,
    hero_image_url: null,
    // CruiseFeed carries no promotions at any tier; the per-line scrape fills
    // this for starred sailings only.
    promos: null,
    data_source: "cruisefeed",
  };
}

/**
 * Pull upcoming sailings with a balcony fare from the configured ports.
 *
 * @param {object} opts
 * @param {string[]} opts.embarkPorts   substring matches (see defaultEmbarkPorts)
 * @param {number}   opts.maxResults    hard budget across all ports (free tier: 2,000/month)
 * @param {string}   opts.departureFrom YYYY-MM-DD, defaults to today
 * @param {string}   opts.departureTo   YYYY-MM-DD
 */
export async function fetchSailings({
  embarkPorts = defaultEmbarkPorts(),
  maxResults = 1500,
  departureFrom = null,
  departureTo = null,
  /** Travel-plan windows ({start,end}); merged, and preferred over the pair above. */
  windows = null,
  /** Results left untouched so a later ad-hoc query still has room. */
  allowanceReserve = 200,
  signal,
} = {}) {
  const key = await apiKey();
  if (!key) {
    // Not configured is not a failure: the per-line extractors still run, and
    // the orchestrator treats this as "no primary source this week".
    return { sailings: [], pages: 0, total_cruises: 0, skipped: "no CRUISEFEED_API_KEY" };
  }

  const today = new Date().toISOString().slice(0, 10);
  // Query the plan's own windows when given them, so the budget is spent only
  // on dates the user could actually sail. A past window is dropped rather than
  // clamped: the API's own default is upcoming-only.
  const ranges = (windows && windows.length ? mergeWindows(windows) : [])
    .filter((w) => w.end >= today)
    .map((w) => ({ start: w.start < today ? today : w.start, end: w.end }));
  const spans = ranges.length
    ? ranges
    : [{ start: departureFrom || today, end: departureTo || null }];
  const sailings = [];
  let spent = 0;
  let pages = 0;
  let allowance = null;
  let stoppedOnAllowance = false;

  outer:
  for (const port of embarkPorts) {
   for (const span of spans) {
    for (let offset = 0; spent < maxResults; offset += PAGE) {
      // Never spend the last of the grant: leaving a reserve means an ad-hoc
      // query later in the month is still possible.
      if (allowance && Number.isFinite(allowance.remaining)
          && allowance.remaining <= allowanceReserve) {
        stoppedOnAllowance = true;
        break outer;
      }
      const budget = allowance && Number.isFinite(allowance.remaining)
        ? Math.max(0, allowance.remaining - allowanceReserve)
        : Infinity;
      const limit = Math.min(PAGE, maxResults - spent, budget);
      if (limit <= 0) { stoppedOnAllowance = true; break outer; }
      const params = {
        embark_port: port,
        departure_from: span.start,
        cabin_category: "balcony",
        has_price: "true",
        dedupe: "true",
        sort: "departure_date",
        limit: String(limit),
        offset: String(offset),
      };
      if (span.end) params.departure_to = span.end;

      const page = await getPage(params, key, signal);
      const items = page?.items || page?.results || page?.data || [];
      if (page?.allowance) allowance = page.allowance;
      pages++;
      spent += items.length;
      for (const r of items) {
        const s = toSailing(r);
        if (s) sailings.push(s);
      }
      if (items.length < limit) break;
    }
   }
  }

  return {
    sailings,
    pages,
    total_cruises: sailings.length,
    results_spent: spent,
    allowance,
    stopped_on_allowance: stoppedOnAllowance,
    spans,
  };
}

/**
 * Re-price the starred sailings, one lookup each.
 *
 * Requirement: refresh starred cruises daily, the rest monthly. Which is the
 * right shape for a metered source: the
 * watchlist only needs today's price for the handful starred, and the wider
 * corpus does not change fast enough to pay for weekly. A dozen stars costs
 * ~12 results a day — about 360 a month against a 2,000 grant — where a daily
 * corpus pull would cost 24,750.
 *
 * Matched on SHIP + EXACT DEPARTURE DATE rather than on their `sailing_id`,
 * because most stars predate CruiseFeed and carry our own `<line>:<id>`. One
 * ship sails once from one port on one date, so the pair is a natural key that
 * works whichever source first recorded the sailing.
 *
 * Returns rows in OUR shape, keyed by OUR sailing_id, so the normal upsert
 * computes the price delta and the watchlist reads it as it always has. The
 * caller must upsert these with `touchLastRun: false` — this observes a few
 * sailings, it does not sweep a line's catalogue.
 *
 * @param {object[]} favorites  starred rows from cruise_sailings, needing at
 *   least `sailing_id`, `source`, `ship_name`, `depart_date`, `nights`.
 */
export async function refreshFavorites(favorites, { signal, maxResults = 400 } = {}) {
  const key = await apiKey();
  if (!key) return { rows: [], matched: 0, missed: 0, results_spent: 0, skipped: "no CRUISEFEED_API_KEY" };

  const rows = [];
  let spent = 0;
  let missed = 0;
  let allowance = null;

  for (const fav of favorites || []) {
    if (spent >= maxResults) break;
    if (!fav?.ship_name || !fav?.depart_date) { missed++; continue; }
    if (allowance && Number.isFinite(allowance.remaining) && allowance.remaining <= 50) break;

    const params = {
      ship_name: fav.ship_name,
      departure_from: String(fav.depart_date).slice(0, 10),
      departure_to: String(fav.depart_date).slice(0, 10),
      cabin_category: "balcony",
      dedupe: "true",
      limit: "2",
    };
    let page;
    try {
      page = await getPage(params, key, signal);
    } catch {
      missed++;
      continue;
    }
    if (page?.allowance) allowance = page.allowance;
    const items = page?.items || page?.results || page?.data || [];
    spent += items.length || 1;

    const hit = items.find((r) => Number(r?.nights) === Number(fav.nights)) || items[0];
    const mapped = hit ? toSailing(hit) : null;
    if (!mapped || mapped.lowest_balcony_per_person_usd === null) { missed++; continue; }

    rows.push({
      ...mapped,
      // Keep OUR identity: this updates the row the user starred, not a parallel one.
      sailing_id: fav.sailing_id,
      source: fav.source || mapped.source,
      data_source: fav.data_source || "direct",
    });
  }

  return { rows, matched: rows.length, missed, results_spent: spent, allowance };
}
