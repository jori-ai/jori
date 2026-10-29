// Virgin Voyages cruise-watch extractor.
//
// Virgin's voyage list is served as a Next.js 13 server-rendered React stream.
// The booking site at https://www.virginvoyages.com/book/voyage-planner/find-
// a-voyage embeds the entire current inventory in `<script>self.__next_f.push(
// [1, "..."])</script>` chunks. There is no public client-side search API:
// the page's only client GraphQL calls (`PROMO_BANNERS_V2`, `STRIKETHROUGH`,
// `BLACK_FRIDAY_PROMOTIONS`) are decoration; the voyage data ships in the
// initial HTML payload. So we fetch the page with bare curl, reassemble the
// streamed payload, and lift the sailings out.
//
// The page returns ~420 sailings across all 4 active ships in one shot — no
// pagination needed.
//
// Pricing caveat: the listing only exposes `startingPrice` (cheapest cabin
// tier on the sailing). When `minPricedGenericCategoryCode` is "SEA TERRACE"
// the floor IS balcony — we use it directly. Otherwise (most sailings, where
// INSIDER or SEAVIEW is cheapest) we don't know balcony price from the
// listing alone; emit `lowest_balcony_per_person_usd: null` and let the
// filter pipeline drop them. Virgin Sea Terrace cabins typically clear $200/
// pp/night anyway, so the chance of a Virgin sailing meeting the ≤$120
// balcony threshold is slim — accepting this gap rather than fanning out 400+
// detail calls is the right tradeoff.
//
// Discovered via DevTools network capture, 2026-05-04. Bare curl works
// (no Akamai bot wall on the booking site).

import { cleanCalls, placeName } from "./itinerary.mjs";

const SITE_ORIGIN = "https://www.virginvoyages.com";
const FIND_A_VOYAGE_PATH = "/book/voyage-planner/find-a-voyage?currencyCode=USD";

// Ship code → display name. The page renders the full name elsewhere but the
// sailing payload only carries `shipCode`, so we map locally.
const SHIP_CODE_TO_NAME = {
  SC: "Scarlet Lady",
  VL: "Valiant Lady",
  RS: "Resilient Lady",
  BR: "Brilliant Lady",
};

function commonHeaders() {
  return {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    referer: `${SITE_ORIGIN}/`,
  };
}

async function fetchFindAVoyage({ signal }) {
  const url = `${SITE_ORIGIN}${FIND_A_VOYAGE_PATH}`;
  const res = await fetch(url, { headers: commonHeaders(), signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`virgin find-a-voyage ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.text();
}

// Pull the chunk-content out of every `self.__next_f.push([1,"..."])` script.
// The string body is JSON-encoded (uses \" \\ \n \uXXXX); we wrap it as a
// JSON literal and parse to get the raw text.
function extractStreamedPayload(html) {
  const re = /self\.__next_f\.push\(\[\s*1\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]\)/g;
  let out = "";
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      out += JSON.parse(`"${m[1]}"`);
    } catch {
      // Skip malformed chunk; payload may still be parseable from the rest.
    }
  }
  return out;
}

// Walk the assembled payload and pull every JSON object literal that contains
// a "sailingList":[...] field. We anchor on the outer object's opening brace
// (the one introducing `packageCode`) and brace-match to the matching close.
function extractPackageObjects(text) {
  const out = [];
  const re = /"packageCode":"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // Walk backwards from m.index to the nearest unmatched '{'.
    let depth = 0;
    let start = -1;
    for (let i = m.index; i >= 0; i--) {
      const c = text[i];
      if (c === "}") depth++;
      else if (c === "{") {
        if (depth === 0) {
          start = i;
          break;
        }
        depth--;
      }
    }
    if (start < 0) continue;
    // Walk forward to the matching close.
    let d = 0;
    let end = -1;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === "{") d++;
      else if (c === "}") {
        d--;
        if (d === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) continue;
    const slice = text.slice(start, end + 1);
    try {
      const obj = JSON.parse(slice);
      if (obj && Array.isArray(obj.sailingList)) out.push(obj);
    } catch {
      // Some matches are nested under non-JSON-parseable wrappers; skip.
    }
    re.lastIndex = end + 1;
  }
  return out;
}

function buildBookingUrl(packageCode, voyageId) {
  const params = new URLSearchParams({
    currencyCode: "USD",
    packageCode,
    voyageId,
  });
  return `${SITE_ORIGIN}/book/voyage-planner/pre-checkout?${params}`;
}

function buildProductUrl(packageCode) {
  const params = new URLSearchParams({
    currencyCode: "USD",
    packageCode,
  });
  return `${SITE_ORIGIN}/book/voyage-planner/fullCruiseDetails?${params}`;
}

/**
 * Virgin states a discount two ways and neither is a named offer: a struck
 * `originalAmount` above the fare, and `classificationCodes` like ["10%"].
 * Both are turned into a promo so a NEW discount on a watched sailing shows up
 * even in the week the headline fare does not otherwise move enough to trip
 * the 10% rule.
 */
function virginPromos(pkg, sailing) {
  const out = [];
  const sp = sailing?.startingPrice || {};
  const amt = Number(sp.amount), orig = Number(sp.originalAmount);
  if (Number.isFinite(amt) && Number.isFinite(orig) && orig > amt) {
    const pct = Math.round(((orig - amt) / orig) * 100);
    out.push({ code: `was-${Math.round(orig)}`, label: `${pct}% off ${Math.round(orig)}` });
  }
  for (const c of sailing?.classificationCodes || pkg?.classificationCodes || []) {
    if (c) out.push({ code: String(c), label: String(c) });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

function normalizeSailing(pkg, sailing) {
  if (!sailing?.id || !sailing.startDate || !sailing.endDate) return null;
  const ship = SHIP_CODE_TO_NAME[sailing.shipCode] || null;
  if (!ship) return null;

  const portCode = pkg.departurePortCode || sailing?.ports?.[0]?.code || null;
  const portName = sailing?.ports?.[0]?.name || null;
  const nights = Number(sailing.duration);
  if (!portName || !Number.isFinite(nights)) return null;

  // Balcony price: only known when the cheapest cabin on the sailing IS Sea
  // Terrace (Virgin's name for balcony). Virgin price is per-Sailor (per-
  // person), taxes inclusive (`amount` includes `taxAmount`).
  const minGen = sailing?.startingPrice?.minPricedGenericCategoryCode || "";
  const startingAmt = Number(sailing?.startingPrice?.amount);
  const balconyPpp =
    minGen === "SEA TERRACE" && Number.isFinite(startingAmt) ? startingAmt : null;

  // Package-level landscapeHero — Virgin's editorial photo for the itinerary
  // (e.g. Tortola landscape for an Eastern Caribbean run). Already absolute
  // imgix URL in the SSR payload.
  const heroImage = pkg?.landscapeHero?.src || null;

  // sailing.ports is the full ordered itinerary, day 1 embarkation through the
  // final day's disembarkation, so the middle is the calls and the last is
  // where the voyage ends. Virgin also states pkg.tripType ("Round trip"), but
  // the port pair is what the repositioning label is actually derived from, so
  // it is used here too rather than trusting a second, redundant field.
  const seq = (sailing.ports || [])
    .map((p) => ({ code: p?.code || null, name: placeName(p?.name) }))
    .filter((p) => p.name);
  const disembark = seq.length > 1 ? seq[seq.length - 1] : null;
  const calls = seq.length
    ? cleanCalls(seq.slice(1, -1), { ends: [seq[0], disembark], ordered: true })
    : null;

  return {
    source: "virgin",
    sailing_id: `virgin:${sailing.id}`,
    cruise_id: pkg.packageCode || null,
    ship_name: ship,
    ship_built_year: null,
    departure_port: portName,
    departure_port_code: portCode,
    departure_port_region: null,
    ports_of_call: calls,
    ports_ordered: calls ? true : null,
    promos: virginPromos(pkg, sailing),
    disembark_port: disembark?.name ?? null,
    disembark_port_code: disembark?.code ?? pkg.arrivalPortCode ?? null,
    depart_date: sailing.startDate,
    return_date: sailing.endDate,
    nights,
    lowest_balcony_per_person_usd: balconyPpp,
    taxes_fees_included: true,
    currency: "USD",
    booking_url: buildBookingUrl(pkg.packageCode, sailing.id),
    product_url: buildProductUrl(pkg.packageCode),
    hero_image_url: heroImage,
  };
}

export async function fetchSailings({ signal } = {}) {
  const html = await fetchFindAVoyage({ signal });
  const payload = extractStreamedPayload(html);
  const packages = extractPackageObjects(payload);

  const sailings = [];
  let total = 0;
  const seen = new Set();
  for (const pkg of packages) {
    for (const s of pkg.sailingList || []) {
      total += 1;
      const norm = normalizeSailing(pkg, s);
      if (!norm) continue;
      if (seen.has(norm.sailing_id)) continue;
      seen.add(norm.sailing_id);
      sailings.push(norm);
    }
  }

  return { sailings, total_cruises: total, pages: 1 };
}

// CLI smoke-test: `node lib/cruise/virgin.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const t0 = Date.now();
    const { sailings, total_cruises, pages } = await fetchSailings({ signal: ctrl.signal });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const withBalcony = sailings.filter((s) => s.lowest_balcony_per_person_usd != null).length;
    console.error(
      `[virgin] ${pages} page, ${total_cruises} sailings in payload, ${sailings.length} normalized, ${withBalcony} with balcony price in ${dt}s`,
    );
    if (sailings.length) console.log(JSON.stringify(sailings.slice(0, 3), null, 2));
  } finally {
    clearTimeout(timer);
  }
}
