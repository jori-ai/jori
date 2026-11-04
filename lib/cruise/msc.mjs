// MSC Cruises (US) cruise-watch extractor.
//
// MSC's US site is at msccruisesusa.com (the global msccruises.com 301-redirects
// US visitors there). Behind the search page is an Algolia BFF proxy:
//   GET https://algoliabff-prod-eastus2-001.msccruises.com/v1/search/cruises/
//
// Each "hit" is a (cruise, cabin-tier) row keyed by `objectID`. The default
// query returns the cheapest tier per sailing (Interior). Passing
// `macroCategory=BAL` filters server-side to balcony rows only — exactly what
// we want. Categories: INS=Interior, OUT=Ocean View, BAL=Balcony, SUI=Suite.
//
// Pricing (`prices.adultPrice`) is per person, taxes/fees inclusive, double
// occupancy. `priceWithoutGft` is the pre-tax base; `priceWithGft` matches
// `adultPrice`.
//
// cruiseID format encodes everything we need:
//   `SE20260928MIAMIA` = ship_code + YYYYMMDD + embark_code + disembark_code
// Booking URL: https://www.msccruisesusa.com/Booking?CruiseID=...&...
// Itinerary detail URL: /itinerary-details/<slug>?cruiseid=<cruiseID>
//
// Discovered via DevTools network capture, 2026-05-03. Bare curl works (no
// Akamai bot wall on the Algolia BFF — it's hosted on Azure Front Door behind
// a separate edge from the website).

import { cleanCalls } from "./itinerary.mjs";
import { cruiseConfig } from "./config.mjs";

const ALGOLIA_ORIGIN = "https://algoliabff-prod-eastus2-001.msccruises.com";
const SITE_ORIGIN = "https://www.msccruisesusa.com";
const SEARCH_PATH = "/v1/search/cruises/";

// Plan-relevant embarkation ports, from the cruise-watch config
// `line_embark_ports.msc` (MSC's own port codes). A seasonal port is worth
// listing too, so any future inventory flows through automatically.
const DEFAULT_EMB_PORTS = () => cruiseConfig().line_embark_ports.msc || [];

// Forward window for the MSC search — keep wide enough to catch booking-far-
// ahead inventory without going past the planning horizon. The
// cruise-watch filter still drops anything outside the actual plan
// windows.
const DEFAULT_DATE_FROM = "2026-01-01";
const DEFAULT_DATE_TO = "2027-12-31";

const PAGE_SIZE = 200;

function commonHeaders() {
  // Algolia BFF returns 200 to bare requests — no special headers needed.
  // We mimic the browser's UA + accept just to be polite and to avoid
  // Azure Front Door's default bot heuristics flagging an unknown UA.
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    referer: `${SITE_ORIGIN}/`,
  };
}

function buildSearchUrl({ page, hitsPerPage, embPorts, dateFrom, dateTo }) {
  const params = new URLSearchParams({
    country: "US",
    lang: "en",
    macroCategory: "BAL",
    noofAdults: "2",
    sortBy: "price",
    sortOrder: "asc",
    hitsPerPage: String(hitsPerPage),
    page: String(page),
    departureDateFrom: dateFrom,
    departureDateTo: dateTo,
  });
  if (embPorts?.length) params.set("embkPort", embPorts.join(","));
  return `${ALGOLIA_ORIGIN}${SEARCH_PATH}?${params}`;
}

async function fetchSearchPage(opts) {
  const url = buildSearchUrl(opts);
  const res = await fetch(url, { headers: commonHeaders(), signal: opts.signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`msc search ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function pickValue(obj) {
  // MSC encodes coded fields as `{key, value}` — return value (display name).
  if (obj && typeof obj === "object") return obj.value || obj.key || null;
  return obj || null;
}

function pickKey(obj) {
  if (obj && typeof obj === "object") return obj.key || null;
  return obj || null;
}

function dateAddDays(yyyymmdd, days) {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildBookingUrl(hit) {
  // CruiseID alone is enough — MSC's /Booking page resolves to the live
  // limited-time offers for that sailing. Don't bake in PriceCode/PriceType
  // captured at extract time; MSC rotates pricing and the stale code can
  // break the link days later.
  const params = new URLSearchParams({ CruiseID: hit.cruiseID });
  return `${SITE_ORIGIN}/Booking?${params}`;
}

// MSC's /itinerary-details/<slug> URLs route through Akamai's waiting-room
// (queue page) for first-time visitors — Gmail link previews and clicks land
// on a "you are in line" page, not the cruise. Skip product_url for MSC and
// rely solely on the booking_url action link.
function buildProductUrl() {
  return null;
}

function buildHeroImageUrl(hit) {
  // Algolia hits carry { mobile, desktop } as relative paths under
  // /-/media/...?bc=transparent&mw=... — prepend the site origin.
  const rel = hit?.itineraryImages?.desktop || hit?.itineraryImages?.mobile;
  if (!rel || typeof rel !== "string") return null;
  return rel.startsWith("http") ? rel : `${SITE_ORIGIN}${rel}`;
}

function normalizeHit(hit) {
  const adult = Number(hit?.prices?.adultPrice);
  if (!Number.isFinite(adult) || adult <= 0) return null;
  if (hit?.prices?.availability === false) return null;
  const ship = pickValue(hit.shipCd);
  const portName = pickValue(hit.embkPort);
  const portCode = pickKey(hit.embkPort);
  const departDate = hit.departureStartDate;
  const nights = Number(hit.numberOfNights);
  if (!ship || !portName || !departDate || !Number.isFinite(nights)) return null;
  const returnDate = dateAddDays(departDate, nights);
  // visitingPorts is an Algolia FACET array, not an itinerary: it is unordered
  // (a round trip lists its home port in the middle), it repeats a port once per
  // call day, and it carries SEADAY entries as if they were places. Probed
  // 2026-09-01 — `portOfCalls`, `itinCd` and `cruiseID` carry no sequence
  // either, so MSC genuinely cannot be ordered from this endpoint and ships as
  // a set. cleanCalls drops the sea days and the endpoints.
  const disemName = pickValue(hit.disembkPort);
  const calls = cleanCalls(
    (hit.visitingPorts || []).map((v) => ({ code: pickKey(v), name: pickValue(v) })),
    {
      ends: [
        { code: portCode, name: portName },
        { code: pickKey(hit.disembkPort), name: disemName },
      ],
      ordered: false,
    },
  );
  return {
    source: "msc",
    sailing_id: `msc:${hit.cruiseID}`,
    cruise_id: hit.itinCd || hit.cruiseID,
    ship_name: ship,
    ship_built_year: null,
    departure_port: portName,
    departure_port_code: portCode,
    departure_port_region: null,
    ports_of_call: calls,
    ports_ordered: false,
    // MSC publishes discount CODES, not names — "MSVG5W" means nothing to a
    // reader, so the label repeats the code. The signal is the set CHANGING.
    promos: [...new Set(hit.discountCodes || [])]
      .filter(Boolean)
      .sort()
      .map((c) => ({ code: String(c), label: String(c) })),
    disembark_port: disemName ? String(disemName).split(",")[0].trim() : null,
    disembark_port_code: pickKey(hit.disembkPort),
    depart_date: departDate,
    return_date: returnDate,
    nights,
    lowest_balcony_per_person_usd: adult,
    taxes_fees_included: true,
    currency: "USD",
    booking_url: buildBookingUrl(hit),
    product_url: buildProductUrl(),
    hero_image_url: buildHeroImageUrl(hit),
  };
}

export async function fetchSailings({
  signal,
  embPorts = DEFAULT_EMB_PORTS(),
  dateFrom = DEFAULT_DATE_FROM,
  dateTo = DEFAULT_DATE_TO,
  pageDelayMs = 500,
  maxPages = 6,
} = {}) {
  if (!embPorts || !embPorts.length) return { sailings: [], total_cruises: 0, pages: 0 }; // no ports configured: not searched
  const sailings = [];
  let total = null;
  let page = 0;
  let pages = 0;

  while (pages < maxPages) {
    const resp = await fetchSearchPage({
      page,
      hitsPerPage: PAGE_SIZE,
      embPorts,
      dateFrom,
      dateTo,
      signal,
    });
    if (total === null) total = resp?.nbHits ?? 0;
    const hits = resp?.hits || [];
    if (hits.length === 0) break;
    for (const hit of hits) {
      const norm = normalizeHit(hit);
      if (norm) sailings.push(norm);
    }
    pages += 1;
    page += 1;
    const nbPages = resp?.nbPages ?? 1;
    if (page >= nbPages) break;
    if (pageDelayMs > 0) await new Promise((r) => setTimeout(r, pageDelayMs));
  }

  return { sailings, total_cruises: total ?? 0, pages };
}

// CLI smoke-test: `node lib/cruise/msc.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const t0 = Date.now();
    const { sailings, total_cruises, pages } = await fetchSailings({
      signal: ctrl.signal,
      maxPages: 3,
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(
      `[msc] ${pages} pages, ${total_cruises} total balcony hits, ${sailings.length} normalized in ${dt}s`,
    );
    if (sailings.length) console.log(JSON.stringify(sailings.slice(0, 3), null, 2));
  } finally {
    clearTimeout(timer);
  }
}
