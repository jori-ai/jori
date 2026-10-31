// Holland America Line cruise-watch extractor.
//
// HAL exposes a Solr REST endpoint that returns cruise inventory in one shot:
//   GET /search/halcruisesearch?start=...&rows=...&fq=...&fl=...&expand=true
// Field collapsing groups by itineraryId so each "doc" is the lead sailing for
// that itinerary, and the `expanded` block returns up to 50 additional sailings
// per itinerary (no N+1 fan-out — one request gives everything).
//
// Per-stateroom prices are dynamic Solr field names: `price_USD_VN_anonymous_d`
// is the Verandah/Balcony price for an anonymous (non-logged-in) shopper. -1.0
// means "no balcony inventory on this sailing" (older ships without balconies,
// or sold out). Other room codes: IN=Inside, OV=Ocean View, VS=Verandah Suite,
// NS=Neptune Suite, PH=Pinnacle, SS=Signature, LA=Lanai.
//
// Discovered via DevTools network capture, 2026-05-03. Bare curl works (no
// Akamai bot challenge on the public Solr API; the wall is in front of HTML
// pages). Custom request headers `currencycode: USD`, `brand: hal`, `country: US`,
// `locale: en_US` are forwarded by the page; we replicate them to ensure
// USD pricing.

import { cleanCalls } from "./itinerary.mjs";
import { cruiseConfig } from "./config.mjs";

const ORIGIN = "https://www.hollandamerica.com";
const SEARCH_PATH = "/search/halcruisesearch";

// Plan-relevant embarkation ports (within ~150mi of a home city), from the
// cruise-watch config `line_embark_ports.holland`. HAL uses FAA-style
// 3-letter port codes.
const DEFAULT_EMB_PORTS = () => cruiseConfig().line_embark_ports.holland || [];

const PAGE_SIZE = 100;

// Fields to request — keep narrow to control payload size.
const FIELD_LIST = [
  "cruiseId",
  "itineraryId",
  "name",
  "shipName",
  "shipId",
  "embarkPortCode",
  "embarkPortName",
  "disembarkPortCode",
  "disembarkPortName",
  "sortedPortNames_ss",
  "departDate",
  "arrivalDate",
  "duration",
  "soldOut",
  "contentPath",
  "cruiseOverviewImage",
  "price_USD_VN_anonymous_d",
  "price_USD_anonymous",
  "taxesAndFeesCombined_USD_anonymous",
].join(",");

function commonHeaders() {
  // Note: do NOT send `origin` — HAL's Akamai treats a cross-origin Node fetch
  // as suspicious and returns 403. Same-origin browser requests carry origin
  // implicitly, but server-to-server we omit it. The `currencycode`/`brand`/
  // `country`/`locale`/`clientid` headers are forwarded by the page and we
  // replicate to ensure USD pricing.
  return {
    accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    referer: `${ORIGIN}/en/us/find-a-cruise`,
    currencycode: "USD",
    country: "US",
    locale: "en_US",
    brand: "hal",
    clientid: "WEB",
  };
}

function buildSearchUrl({ start, rows, embPorts }) {
  // Filter queries — order doesn't matter to Solr but matches the page's request.
  const fqs = [
    "departDate:[NOW/DAY+1DAY TO *]",
    "{!tag=collapse}{!collapse field=itineraryId}",
  ];
  if (embPorts?.length) {
    fqs.push(`embarkPortCode:(${embPorts.join(" OR ")})`);
  }

  const params = new URLSearchParams();
  params.set("start", String(start));
  params.set("rows", String(rows));
  params.set("country", "us");
  params.set("language", "en");
  for (const fq of fqs) params.append("fq", fq);
  params.set("expand", "true");
  params.set("expand.rows", "50");
  params.set("fl", FIELD_LIST);

  return `${ORIGIN}${SEARCH_PATH}?${params}`;
}

async function fetchSearchPage({ start, rows, embPorts, signal }) {
  const url = buildSearchUrl({ start, rows, embPorts });
  const res = await fetch(url, { headers: commonHeaders(), signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`holland search ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function splitHashName(s) {
  if (typeof s !== "string") return s;
  const i = s.indexOf("#@#");
  return i >= 0 ? s.slice(0, i) : s;
}

function isoDate(s) {
  // HAL returns "2026-05-10T00:00:00Z" — strip time, keep YYYY-MM-DD.
  return typeof s === "string" ? s.slice(0, 10) : null;
}

function buildBookingUrl(contentPath) {
  if (!contentPath) return null;
  // contentPath is like "/find-a-cruise/e6n14a/y631"; the public page sits at
  // /en/us/find-a-cruise/<itinerary-slug>/<cruise-slug>.
  return `${ORIGIN}/en/us${contentPath}`;
}

function buildHeroImageUrl(overviewPath) {
  if (!overviewPath || typeof overviewPath !== "string") return null;
  return overviewPath.startsWith("http") ? overviewPath : `${ORIGIN}${overviewPath}`;
}

function normalizeDoc(doc) {
  const balcony = Number(doc?.price_USD_VN_anonymous_d);
  if (!Number.isFinite(balcony) || balcony <= 0) return null;
  const ship = splitHashName(doc.shipName);
  const portName = splitHashName(doc.embarkPortName);
  const departDate = isoDate(doc.departDate);
  const returnDate = isoDate(doc.arrivalDate);
  const nights = Number(doc.duration);
  if (!ship || !portName || !departDate || !Number.isFinite(nights)) return null;

  // HAL's search core exposes the itinerary only as `sortedPortNames_ss` —
  // SORTED, not sailed. There is no sequence to recover here, so the ports ship
  // as an unordered set with ports_ordered false and the site joins them with
  // "·" instead of arrows. `portsOfCall` holds codes but is a different length
  // and order than the names, so the two cannot be zipped; names win, codes go
  // null. Sea days and canal-transit pseudo-ports are dropped.
  const disembarkName = splitHashName(doc.disembarkPortName) || null;
  const calls = cleanCalls(
    (doc.sortedPortNames_ss || []).map((n) => ({ code: null, name: splitHashName(String(n || "")) })),
    { ends: [{ name: portName }, { name: disembarkName }], ordered: false },
  );

  return {
    source: "holland",
    sailing_id: `holland:${doc.cruiseId || `${doc.itineraryId}_${departDate}`}`,
    cruise_id: doc.itineraryId || null,
    ship_name: ship,
    ship_built_year: null,
    departure_port: portName,
    departure_port_code: doc.embarkPortCode || null,
    departure_port_region: null,
    ports_of_call: calls,
    ports_ordered: false,
    disembark_port: disembarkName ? disembarkName.split(",")[0].trim() : null,
    disembark_port_code: doc.disembarkPortCode || null,
    depart_date: departDate,
    return_date: returnDate,
    nights,
    lowest_balcony_per_person_usd: balcony,
    taxes_fees_included: doc.taxesAndFeesCombined_USD_anonymous === true,
    currency: "USD",
    booking_url: buildBookingUrl(doc.contentPath),
    product_url: buildBookingUrl(doc.contentPath),
    hero_image_url: buildHeroImageUrl(doc.cruiseOverviewImage),
  };
}

export async function fetchSailings({
  signal,
  embPorts = DEFAULT_EMB_PORTS(),
  pageDelayMs = 750,
  maxPages = 10,
} = {}) {
  if (!embPorts || !embPorts.length) return { sailings: [], total_cruises: 0, pages: 0 }; // no ports configured: not searched
  const sailings = [];
  let total = null;
  let start = 0;
  let pages = 0;

  while (pages < maxPages) {
    const page = await fetchSearchPage({ start, rows: PAGE_SIZE, embPorts, signal });
    if (total === null) total = page?.response?.numFound ?? 0;
    const docs = page?.response?.docs || [];
    if (docs.length === 0) break;

    // Lead sailings (one per itineraryId, post-collapse).
    for (const doc of docs) {
      const norm = normalizeDoc(doc);
      if (norm) sailings.push(norm);
    }

    // Expanded block — additional sailings under each represented itinerary.
    const expanded = page?.expanded || {};
    for (const inner of Object.values(expanded)) {
      for (const doc of inner?.docs || []) {
        const norm = normalizeDoc(doc);
        if (norm) sailings.push(norm);
      }
    }

    start += docs.length;
    pages += 1;
    if (start >= total) break;
    if (pageDelayMs > 0) await new Promise((r) => setTimeout(r, pageDelayMs));
  }

  return { sailings, total_cruises: total ?? 0, pages };
}

// CLI smoke-test: `node lib/cruise/holland.mjs`
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
      `[holland] ${pages} pages, ${total_cruises} total itineraries (after collapse), ${sailings.length} balcony-priced sailings in ${dt}s`,
    );
    if (sailings.length) console.log(JSON.stringify(sailings.slice(0, 3), null, 2));
  } finally {
    clearTimeout(timer);
  }
}
