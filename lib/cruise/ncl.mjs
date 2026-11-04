// Norwegian Cruise Line cruise-watch extractor.
//
// NCL exposes two unauthenticated JSON APIs we chain together:
//   1. /api/v2/vacations/search — itinerary-level results, filterable by
//      stateroomTypes=BALCONY and embPorts. Returns up to ~750 itineraries.
//      We restrict to plan-relevant departure ports to keep the per-itinerary
//      detail fan-out tractable.
//   2. /api/vacations/sailings/{itineraryCode}?guests=2 — per-sailing detail
//      across all stateroom types. We pick the BALCONY rows where
//      status=AVAILABLE and emit one NormalizedSailing per row.
//
// Discovered via DevTools network capture, 2026-05-03. Both endpoints are
// behind Akamai but bare curl with no cookies works (the public booking flow
// is intentionally open — the bot wall sits in front of pages, not the API).
//
// Per-line wrapper, not a shared base — NCL's API shape is too different from
// RCL Group's GraphQL or Costco's session-bound flows to warrant abstraction.

import { cleanCalls, placeName } from "./itinerary.mjs";
import { cruiseConfig } from "./config.mjs";

const ORIGIN = "https://www.ncl.com";
const SEARCH_PATH = "/api/v2/vacations/search";
const SAILINGS_PATH = "/api/vacations/sailings";

// Plan-relevant embarkation ports (within ~150mi of a home city), from the
// cruise-watch config `line_embark_ports.ncl`. The
// cruise-watch port matcher does the final radius check; this just trims
// the universe before the per-itinerary fan-out so a single run doesn't
// download 1.5GB of irrelevant inventory.
const DEFAULT_EMB_PORTS = () => cruiseConfig().line_embark_ports.ncl || [];

const PAGE_SIZE = 100;

function commonHeaders() {
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    referer: `${ORIGIN}/vacations`,
    origin: ORIGIN,
  };
}

async function fetchSearchPage({ skip, count, embPorts, signal }) {
  const params = new URLSearchParams({
    filterConfig: "search-filters-configuration",
    limit: String(count),
    offset: String(skip),
    stateroomTypes: "BALCONY",
  });
  if (embPorts?.length) params.set("embPorts", embPorts.join(","));
  const url = `${ORIGIN}${SEARCH_PATH}?${params}`;
  const res = await fetch(url, { headers: commonHeaders(), signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ncl search ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchItinerarySailings(itineraryCode, { signal }) {
  const url = `${ORIGIN}${SAILINGS_PATH}/${encodeURIComponent(itineraryCode)}?guests=2`;
  const res = await fetch(url, { headers: commonHeaders(), signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ncl sailings ${itineraryCode} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function isoDate(s) {
  // NCL returns "2026-05-04T00:00" — strip time, return YYYY-MM-DD.
  if (!s || typeof s !== "string") return null;
  return s.slice(0, 10);
}

function buildBookingUrl(itineraryCode, sailDate) {
  const params = new URLSearchParams({
    itineraryCode,
    guests: "2",
    gateway: "NONE",
  });
  if (sailDate) params.set("sailDate", sailDate);
  return `${ORIGIN}/vacation-builder/planning/cruiseItinerary?${params}`;
}

function buildProductUrl(itineraryCode) {
  return `${ORIGIN}/vacation-builder?itineraryCode=${encodeURIComponent(itineraryCode)}`;
}

function buildHeroImageUrl(itinSearch, sailingsResp) {
  // Prefer the itinerary detail's image (richer landscape) when present;
  // fall back to the search-result image. NCL serves both as relative paths
  // under www.ncl.com.
  const candidates = [
    sailingsResp?.itineraryDetails?.image?.src,
    itinSearch?.image?.src,
  ];
  for (const src of candidates) {
    if (!src || typeof src !== "string") continue;
    return src.startsWith("http") ? src : `${ORIGIN}${src}`;
  }
  return null;
}

/**
 * NCL's ports, in the order they are actually sailed.
 *
 * `portsOfCall` is a SET — the API returns it in no useful order at all (the
 * 22-night Bliss reads Acapulco, Puerto Quetzal, Colón, ... for a voyage that
 * actually runs from its home port → Puerto Plata → Cartagena → Colón → ...).
 * The order does exist, encoded in the itinerary code: `BLISS22` + `<home>
 * POP CTG CLN PCL PRQ ACA PVR CSL SFO VIC SEA`, a ship/nights prefix followed
 * by three-letter port codes in sailed sequence.
 *
 * Parsing an id is a heuristic, so this one CHECKS ITSELF: the codes it reads
 * must reproduce exactly the set of ports the API separately reported (calls
 * plus both ends). If they do, the sequence is trustworthy and `ordered` is
 * true; if the format ever changes, the check fails and the ports fall back to
 * the unordered set with `ordered` false — the site then joins them with "·"
 * instead of arrows, which is honest rather than wrong. Verified 2026-09-01
 * against 40 live itineraries: 40 reproduced the set exactly, 0 mismatched.
 *
 * NCL titles ports "Nassau, Bahamas"; the site wants the bare place, so the
 * region is dropped here (normalizePort lives in the site's module and cannot
 * be imported from the scraper).
 */
function buildItinerary(itineraryCode, portsOfCall, dep, disem) {
  const place = placeName;
  const ends = [
    { code: dep?.code, name: place(dep?.title) },
    { code: disem?.code, name: place(disem?.title) },
  ];
  const unordered = cleanCalls(
    (portsOfCall || []).map((p) => ({ code: p?.code || null, name: place(p?.title) })),
    { ends, ordered: false },
  );

  const nameByCode = new Map();
  for (const p of portsOfCall || []) if (p?.code) nameByCode.set(p.code, place(p.title));
  if (dep?.code) nameByCode.set(dep.code, place(dep.title));
  if (disem?.code) nameByCode.set(disem.code, place(disem.title));

  const m = String(itineraryCode || "").match(/^[A-Z]+?\d+([A-Z0-9]+)$/);
  const tail = m?.[1] || "";
  const codes = tail.match(/.{1,3}/g) || [];
  const reproducesTheSet =
    codes.length > 0
    && codes.length * 3 === tail.length
    && new Set(codes).size === nameByCode.size
    && codes.every((c) => nameByCode.has(c));
  if (!reproducesTheSet) return { calls: unordered, ordered: false };

  // Drop the two ends and collapse a port called on consecutive days.
  const calls = cleanCalls(
    codes.slice(1, -1).map((code) => ({ code, name: nameByCode.get(code) })),
    { ends, ordered: true },
  );
  return { calls, ordered: true };
}

function normalizeSailings(itinSearch, sailingsResp) {
  const details = sailingsResp?.itineraryDetails || itinSearch || {};
  const itineraryCode = sailingsResp?.itineraryCode || itinSearch?.code;
  const ship = details?.ship?.title || itinSearch?.ship?.title;
  const dep = details?.embarkationPort || itinSearch?.embarkationPort;
  const nights =
    details?.duration?.itinerary ?? details?.duration?.cruising ?? itinSearch?.duration?.days;
  if (!itineraryCode || !ship || !dep?.title || !Number.isFinite(nights)) return [];
  const heroImage = buildHeroImageUrl(itinSearch, sailingsResp);
  const disem = details?.disembarkationPort || itinSearch?.disembarkationPort || null;
  // NCL is the only line of the six that names its offers ("Wi-Fi Package",
  // "Unlimited Open Bar", "Kids Sail Free"), so its promos are readable rather
  // than a bare code. Sorted so an unchanged set never looks like a change.
  const promos = (details?.deals || itinSearch?.deals || [])
    .map((d) => ({ code: String(d?.code || ""), label: String(d?.title || d?.code || "") }))
    .filter((d) => d.code && d.label)
    .sort((a, b) => a.code.localeCompare(b.code));
  const { calls, ordered } = buildItinerary(
    itineraryCode,
    details?.portsOfCall || itinSearch?.portsOfCall || [],
    dep,
    disem,
  );

  const out = [];
  for (const row of sailingsResp?.pricingStateRooms || []) {
    if (row?.stateroomType !== "BALCONY") continue;
    if (row?.status !== "AVAILABLE") continue;
    const price = Number(row.combinedPrice);
    if (!Number.isFinite(price) || price <= 0) continue;
    const depDate = isoDate(row.sailStartDate || row.vacationStartDate);
    const retDate = isoDate(row.sailEndDate || row.vacationEndDate);
    if (!depDate || !retDate) continue;
    const sailId = row.sailId || `${itineraryCode}_${depDate}`;
    out.push({
      source: "ncl",
      sailing_id: `ncl:${sailId}`,
      cruise_id: itineraryCode,
      ship_name: ship,
      ship_built_year: null,
      departure_port: dep.title,
      departure_port_code: dep.code || null,
      departure_port_region: null,
      ports_of_call: calls,
      ports_ordered: ordered,
      promos,
      disembark_port: disem?.title ? String(disem.title).split(",")[0].trim() : null,
      disembark_port_code: disem?.code || null,
      depart_date: depDate,
      return_date: retDate,
      nights,
      // NCL's combinedPrice is per-person, double-occupancy, taxes/fees included.
      lowest_balcony_per_person_usd: price,
      taxes_fees_included: true,
      currency: row.currencyCode || "USD",
      booking_url: buildBookingUrl(itineraryCode, depDate),
      product_url: buildProductUrl(itineraryCode),
      hero_image_url: heroImage,
    });
  }
  return out;
}

export async function fetchSailings({
  signal,
  embPorts = DEFAULT_EMB_PORTS(),
  pageDelayMs = 750,
  itineraryDelayMs = 250,
  maxPages = 10,
  maxItineraries = 250,
} = {}) {
  if (!embPorts || !embPorts.length) return { sailings: [], total_cruises: 0, pages: 0 }; // no ports configured: not searched
  // Step 1 — paginate search to collect itineraries.
  const itineraries = [];
  let total = null;
  let skip = 0;
  let pages = 0;
  while (pages < maxPages) {
    const page = await fetchSearchPage({ skip, count: PAGE_SIZE, embPorts, signal });
    if (total === null) total = page?.total ?? 0;
    const batch = page?.itineraries || [];
    if (batch.length === 0) break;
    itineraries.push(...batch);
    skip += batch.length;
    pages += 1;
    if (skip >= total) break;
    if (itineraries.length >= maxItineraries) break;
    if (pageDelayMs > 0) await new Promise((r) => setTimeout(r, pageDelayMs));
  }

  // Dedupe by itineraryCode — search occasionally returns the same itinerary
  // twice with different objectId suffixes (cabin tier permutations).
  const byCode = new Map();
  for (const it of itineraries) {
    if (!it?.code) continue;
    if (!byCode.has(it.code)) byCode.set(it.code, it);
  }
  const uniqueItineraries = [...byCode.values()].slice(0, maxItineraries);

  // Step 2 — fan out per-itinerary sailings detail.
  const sailings = [];
  for (const it of uniqueItineraries) {
    try {
      const detail = await fetchItinerarySailings(it.code, { signal });
      sailings.push(...normalizeSailings(it, detail));
    } catch (err) {
      // One bad itinerary shouldn't fail the whole run; log and continue.
      console.error(`[ncl] sailings ${it.code} failed: ${err?.message || err}`);
    }
    if (itineraryDelayMs > 0) await new Promise((r) => setTimeout(r, itineraryDelayMs));
  }

  return {
    sailings,
    total_cruises: total ?? 0,
    pages,
    itineraries_fetched: uniqueItineraries.length,
  };
}

// CLI smoke-test: `node lib/cruise/ncl.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 240_000);
  try {
    const t0 = Date.now();
    const { sailings, total_cruises, pages, itineraries_fetched } = await fetchSailings({
      signal: ctrl.signal,
      maxPages: 2,
      maxItineraries: 8,
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(
      `[ncl] ${pages} pages, ${total_cruises} total itineraries, fetched ${itineraries_fetched}, ${sailings.length} balcony sailings in ${dt}s`,
    );
    if (sailings.length) console.log(JSON.stringify(sailings.slice(0, 3), null, 2));
  } finally {
    clearTimeout(timer);
  }
}
