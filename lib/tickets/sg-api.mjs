// lib/tickets/sg-api.mjs — SeatGeek Platform API wrapper.
// Docs: https://platform.seatgeek.com/
// Credentials live in .env as SEATGEEK_CLIENT_ID (and optionally SEATGEEK_CLIENT_SECRET).

import { loadEnv } from "./config.mjs";

const BASE = "https://api.seatgeek.com/2";

function clientId() {
  loadEnv();
  const id = process.env.SEATGEEK_CLIENT_ID;
  if (!id) {
    throw new Error(
      "Missing SEATGEEK_CLIENT_ID in .env. Apply at https://seatgeek.com/build (requires manual approval, typically ~1 business day)."
    );
  }
  return id;
}

export function isConfigured() {
  loadEnv();
  return Boolean(process.env.SEATGEEK_CLIENT_ID);
}

async function sgFetch(endpoint, params = {}) {
  const url = new URL(`${BASE}${endpoint}`);
  url.searchParams.set("client_id", clientId());
  const secret = process.env.SEATGEEK_CLIENT_SECRET;
  if (secret) url.searchParams.set("client_secret", secret);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SG API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function searchEvents({ q, city, perPage = 20 } = {}) {
  const data = await sgFetch("/events", { q, "venue.city": city, per_page: perPage });
  return (data.events || []).map(normalizeEvent);
}

export async function eventById(id) {
  const data = await sgFetch(`/events/${id}`);
  return normalizeEvent(data);
}

export async function performersByName(name, perPage = 5) {
  const data = await sgFetch("/performers", { q: name, per_page: perPage });
  return (data.performers || []).map((p) => ({
    id: p.id,
    name: p.name,
    url: p.url,
    type: p.type,
    popularity: p.popularity,
  }));
}

export async function eventsByPerformerSlug(slug, perPage = 25) {
  const data = await sgFetch("/events", { "performers.slug": slug, per_page: perPage });
  return (data.events || []).map(normalizeEvent);
}

function normalizeEvent(ev) {
  if (!ev) return null;
  const stats = ev.stats || {};
  return {
    source: "seatgeek",
    id: `sg-${ev.id}`,
    raw_id: ev.id,
    name: ev.title || ev.short_title,
    url: ev.url,
    date: ev.datetime_local?.slice(0, 10),
    time: ev.datetime_local?.slice(11, 16),
    timezone: ev.venue?.timezone,
    status: undefined,
    venue: ev.venue?.name,
    city: ev.venue?.city,
    state: ev.venue?.state,
    country: ev.venue?.country,
    address: ev.venue?.address,
    price_min: stats.lowest_price ?? null,
    price_max: stats.highest_price ?? null,
    price_currency: "USD",
    attractions: (ev.performers || []).map((p) => p.name),
    image: ev.performers?.[0]?.image || null,
  };
}
