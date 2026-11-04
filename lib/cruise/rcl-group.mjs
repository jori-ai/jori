// Shared extractor for RCL Group brands (Royal Caribbean, Celebrity).
// Both expose a near-identical Apollo GraphQL endpoint at /cruises/graph
// with `skip_authentication: true` bypassing auth. Differences are confined
// to the config passed in: domain, brand letter, query name, client name.
//
// Discovered via DevTools network capture, 2026-05-03 (Royal) and (Celebrity).
// Per-line wrappers (royal.mjs, celebrity.mjs) just call createRclGroupExtractor
// with their config.

import { randomUUID } from "node:crypto";
import { cleanCalls, isSeaDay } from "./itinerary.mjs";
import { cruiseConfig } from "./config.mjs";

const PAGE_SIZE = 100;

// Minimal query — only fields we need for filter + alert + a single hero
// image per itinerary, plus `days` for the itinerary's port sequence (the
// site renders it on every card, and its last entry is what tells a
// repositioning sailing from a round trip). Still avoids the page query's
// stateroomClasses bloat.
function buildQuery(operationName) {
  return `query ${operationName}($filters: String, $qualifiers: String, $sort: CruiseSearchSort, $pagination: CruiseSearchPagination) {
  cruiseSearch(filters: $filters, qualifiers: $qualifiers, sort: $sort, pagination: $pagination) {
    results {
      total
      cruises {
        id
        productViewLink
        masterSailing {
          itinerary {
            name
            code
            sailingNights
            totalNights
            departurePort { code name region }
            days { number type ports { port { code name region } } }
            ship { code name }
            media { images { path } }
          }
        }
        sailings {
          bookingLink
          id
          sailDate
          startDate
          endDate
          taxesAndFees { value }
          taxesAndFeesIncluded
          stateroomClassPricing {
            price {
              value
              areTaxesAndFeesIncluded
              taxesAndFeesAmount
              currency { code }
            }
            stateroomClass { id content { code } }
          }
        }
      }
    }
  }
}`;
}

function commonHeaders({ origin, brand, clientName, queryName, sessionId }) {
  return {
    "Content-Type": "application/json",
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    referer: `${origin}/cruises?country=USA`,
    origin,
    skip_authentication: "true",
    language: "en",
    countryalpha2code: "US",
    // The search's sales-office code (cruise-watch config `rcl_office`).
    ...(cruiseConfig().rcl_office ? { office: cruiseConfig().rcl_office } : {}),
    "request-timeout": "20",
    "apollographql-query-name": queryName,
    "apollographql-client-name": clientName,
    "x-session-id": sessionId,
    brand,
    currency: "USD",
    country: "USA",
    "app-name": "graph",
  };
}

async function fetchPage(cfg, { skip, count, sessionId, signal }) {
  const body = {
    operationName: cfg.queryName,
    variables: {
      filters: "voyageType:OCEAN",
      sort: { by: "RECOMMENDED" },
      pagination: { count, skip },
    },
    query: buildQuery(cfg.queryName),
  };
  const res = await fetch(`${cfg.origin}/cruises/graph`, {
    method: "POST",
    headers: commonHeaders({ ...cfg, sessionId }),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${cfg.source} graph ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json?.errors?.length) {
    throw new Error(`${cfg.source} graph errors: ${JSON.stringify(json.errors).slice(0, 200)}`);
  }
  return json?.data?.cruiseSearch?.results || { total: 0, cruises: [] };
}

// Royal returns image paths already prefixed with /content/dam/royal/...
// Celebrity returns paths starting with /celebrity/... — those need
// /content/dam prepended. Both serve from their site origin. Skip the
// generic "itinerary-default-image.jpg" placeholder Royal uses for unmapped
// itineraries — better to render no image than the same default repeatedly.
function buildHeroImageUrl(originHost, mediaPath) {
  if (!mediaPath || typeof mediaPath !== "string") return null;
  if (/itinerary-default-image/i.test(mediaPath)) return null;
  const prefix = mediaPath.startsWith("/content/dam") ? "" : "/content/dam";
  return `${originHost}${prefix}${mediaPath}`;
}

function pickItineraryHeroImage(itin, originHost) {
  const images = itin?.media?.images || [];
  for (const img of images) {
    const url = buildHeroImageUrl(originHost, img?.path);
    if (url) return url;
  }
  return null;
}

/**
 * Day-by-day ports → the itinerary as the card shows it.
 *
 * `days` is ordered and includes sea days as type "CRUISING" (port code "CRU"),
 * which are dropped. Day 1 is embarkation and the last day disembarkation; both
 * are pulled out as their own fields, so `calls` is the middle of the voyage.
 * Consecutive repeats collapse — an overnight in port is two days, one call.
 */
function parseItineraryDays(days, departurePort) {
  const seq = [];
  for (const d of days || []) {
    const p = d?.ports?.[0]?.port;
    if (!p?.name) continue;
    if (d?.type === "CRUISING" || isSeaDay(p.name, p.code)) continue;
    if (seq.length && seq[seq.length - 1].code === p.code) continue;
    seq.push({ code: p.code || null, name: p.name });
  }
  if (!seq.length) return { calls: null, disembark: null };
  const embark = seq[0];
  const disembark = seq.length > 1 ? seq[seq.length - 1] : seq[0];
  // Alaska cruisetours prepend land legs (Denali, Talkeetna) before the ship
  // sails, so slicing the ends is not enough on its own to keep the
  // embarkation port out of the middle — cleanCalls also filters by code.
  return {
    calls: cleanCalls(seq.slice(1, -1), {
      // `departurePort` as well as the sequence's own ends: on an Alaska
      // cruisetour the first days are land legs (Denali, Talkeetna, Anchorage)
      // and the ship actually boards at Seward partway down the list, so
      // slicing seq[0] leaves the embarkation port sitting among the calls.
      ends: [embark, disembark, departurePort].filter(Boolean),
      ordered: true,
    }),
    disembark,
  };
}

function normalizeCruise(source, originHost, rcl) {
  const itin = rcl?.masterSailing?.itinerary;
  if (!itin) return [];
  const ship = itin.ship?.name?.trim();
  const dep = itin.departurePort;
  const nights = itin.sailingNights ?? itin.totalNights ?? null;
  if (!ship || !dep || !nights) return [];
  const heroImage = pickItineraryHeroImage(itin, originHost);
  const { calls, disembark } = parseItineraryDays(itin.days, dep);

  const out = [];
  for (const sailing of rcl.sailings || []) {
    let lowestBalcony = null;
    let taxesIncluded = sailing.taxesAndFeesIncluded === true;
    let currency = "USD";
    for (const tier of sailing.stateroomClassPricing || []) {
      if (tier.stateroomClass?.id !== "BALCONY") continue;
      const price = tier.price;
      if (!price) continue;
      const v = Number(price.value);
      if (!Number.isFinite(v) || v <= 0) continue;
      currency = price.currency?.code || "USD";
      const inclusive = price.areTaxesAndFeesIncluded === true;
      if (!inclusive) taxesIncluded = false;
      if (lowestBalcony === null || v < lowestBalcony) lowestBalcony = v;
    }
    if (lowestBalcony === null) continue;

    out.push({
      source,
      sailing_id: `${source}:${sailing.id || `${itin.code}_${sailing.sailDate}`}`,
      cruise_id: rcl.id,
      ship_name: ship,
      ship_built_year: null,
      departure_port: dep.name,
      departure_port_code: dep.code,
      departure_port_region: dep.region || null,
      ports_of_call: calls,
      ports_ordered: calls ? true : null,
      disembark_port: disembark?.name ?? null,
      disembark_port_code: disembark?.code ?? null,
      depart_date: sailing.sailDate || sailing.startDate,
      return_date: sailing.endDate,
      nights,
      lowest_balcony_per_person_usd: lowestBalcony,
      taxes_fees_included: taxesIncluded,
      currency,
      booking_url: sailing.bookingLink ? `${originHost}${sailing.bookingLink}` : null,
      product_url: rcl.productViewLink ? `${originHost}/${rcl.productViewLink}` : null,
      hero_image_url: heroImage,
    });
  }
  return out;
}

export function createRclGroupExtractor(cfg) {
  // cfg: { source, origin, brand, clientName, queryName }
  return async function fetchSailings({
    signal,
    sessionId = randomUUID(),
    pageDelayMs = 750,
    maxPages = 50,
  } = {}) {
    const sailings = [];
    let total = null;
    let skip = 0;
    let pages = 0;

    while (pages < maxPages) {
      const results = await fetchPage(cfg, {
        skip,
        count: PAGE_SIZE,
        sessionId,
        signal,
      });
      if (total === null) total = results.total ?? 0;
      const cruises = results.cruises || [];
      if (cruises.length === 0) break;

      for (const cruise of cruises) {
        sailings.push(...normalizeCruise(cfg.source, cfg.origin, cruise));
      }
      skip += cruises.length;
      pages += 1;
      if (skip >= total) break;
      if (pageDelayMs > 0 && pages < maxPages) {
        await new Promise((r) => setTimeout(r, pageDelayMs));
      }
    }

    return { sailings, total_cruises: total ?? 0, pages };
  };
}
