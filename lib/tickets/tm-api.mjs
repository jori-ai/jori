// lib/tickets/tm-api.mjs — Ticketmaster Discovery API wrapper.
// Docs: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
// Key lives in .env as TICKETMASTER_API_KEY.

import { loadEnv } from "./config.mjs";

const BASE = "https://app.ticketmaster.com/discovery/v2";

// TM Discovery API uses the "Consumer Key" from developer.ticketmaster.com
// as the `apikey` query param. The Consumer Secret is only needed for OAuth
// flows (Partner API), not Discovery. Accept either name for convenience.
function key() {
  loadEnv();
  const k = process.env.TICKETMASTER_CONSUMER_KEY || process.env.TICKETMASTER_API_KEY;
  if (!k) {
    throw new Error(
      "Missing TICKETMASTER_CONSUMER_KEY in .env. Get one at https://developer.ticketmaster.com (free, 5k req/day)."
    );
  }
  return k;
}

export function isConfigured() {
  loadEnv();
  return Boolean(process.env.TICKETMASTER_CONSUMER_KEY || process.env.TICKETMASTER_API_KEY);
}

async function tmFetch(endpoint, params = {}) {
  const url = new URL(`${BASE}${endpoint}`);
  url.searchParams.set("apikey", key());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TM API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function searchEvents({ q, city, countryCode = "US", size = 20 } = {}) {
  const data = await tmFetch("/events.json", {
    keyword: q,
    city,
    countryCode,
    size,
    sort: "date,asc",
  });
  return (data._embedded?.events || []).map(normalizeEvent);
}

export async function eventById(id) {
  const data = await tmFetch(`/events/${id}.json`);
  return normalizeEvent(data);
}

export async function attractionsByName(name, size = 5) {
  const data = await tmFetch("/attractions.json", { keyword: name, size });
  return (data._embedded?.attractions || []).map((a) => ({
    id: a.id,
    name: a.name,
    url: a.url,
    type: a.type,
  }));
}

export async function eventsByAttractionId(attractionId, size = 25) {
  const data = await tmFetch("/events.json", { attractionId, size, sort: "date,asc" });
  return (data._embedded?.events || []).map(normalizeEvent);
}

function normalizeEvent(ev) {
  if (!ev) return null;
  const venue = ev._embedded?.venues?.[0];
  const priceRange = ev.priceRanges?.[0];
  return {
    source: "ticketmaster",
    id: `tm-${ev.id}`,
    raw_id: ev.id,
    name: ev.name,
    url: ev.url,
    date: ev.dates?.start?.localDate,
    time: ev.dates?.start?.localTime,
    timezone: ev.dates?.timezone,
    status: ev.dates?.status?.code,
    venue: venue?.name,
    city: venue?.city?.name,
    state: venue?.state?.stateCode,
    country: venue?.country?.countryCode,
    address: venue?.address?.line1,
    price_min: priceRange?.min ?? null,
    price_max: priceRange?.max ?? null,
    price_currency: priceRange?.currency ?? null,
    attractions: (ev._embedded?.attractions || []).map((a) => a.name),
    image: ev.images?.find?.((i) => i.ratio === "16_9" && i.width > 500)?.url || ev.images?.[0]?.url || null,
  };
}
