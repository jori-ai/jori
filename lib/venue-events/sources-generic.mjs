// venue-events/sources-generic.mjs — parsers for calendar platforms that publish
// structured data but not through a ticketing API. Each reads one platform's
// machine format, so any venue on that platform is one config row away:
//
//   squarespaceEvents  a Squarespace events collection, `<page>?format=json`
//                      → `upcoming[]` with epoch-ms startDate
//   dice               dice.fm browse pages embed their result set in
//                      `__NEXT_DATA__` (props.pageProps.events[]) — no browser
//   jsonLdPage         any listing page whose CMS emits schema.org Event
//                      JSON-LD for search engines; `pages` > 1 follows ?page=N
//
// Every pattern below reads vendor-generated markup — machine structure, never
// anything the user wrote. Wall-clock times without an offset are read in
// the source's `tz`, else the installation's home zone.

import { makeEvent } from "./normalize.mjs";
import { homeTz } from "./config.mjs";
import { eventsFromHtml } from "../event-ld.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

export async function getText(url, { timeoutMs = 20000, method = "GET", body, headers = {} } = {}) {
  const res = await fetch(url, { method, body, signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": UA, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${String(url).split("?")[0]}`);
  return res.text();
}

export function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)) // lang-regex-ok: HTML entity decoding
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))) // lang-regex-ok: HTML entity decoding
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

export const stripTags = (h) => decodeEntities(String(h || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(); // lang-regex-ok: HTML tag stripping

/** Epoch ms → {date, time} as wall time in `tz` (default: the home zone). */
export function localParts(ms, tz = homeTz()) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return { date: null, time: null };
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

// "2026-10-29T18:30:00.000-04:00" → "18:30" (local wall clock as published);
// a date-only value → null. parseVendorTime would read the UTC offset instead.
export const isoClock = (v) => (typeof v === "string" && v[10] === "T" ? v.slice(11, 16) : null);

// ─── Squarespace events collection ─────────────────────────────────────────

export function parseSquarespaceEvents(json, src, ref, origin) {
  const items = Array.isArray(json?.upcoming) ? json.upcoming : Array.isArray(json?.items) ? json.items : [];
  const out = [];
  for (const it of items) {
    const { date, time } = localParts(it.startDate, src.tz || homeTz());
    const url = it.fullUrl ? new URL(it.fullUrl, origin).toString() : src.url;
    const e = makeEvent(src, {
      title: decodeEntities(it.title), date, time, venue: src.venue, url,
      // Squarespace `tags` mix act names with style words ("Electric", "Band"),
      // so they go to the ranking model as description, not performers.
      category: src.category || "music",
      description: [(it.categories || []).join(" / "), (it.tags || []).map(decodeEntities).join(", "), stripTags(it.excerpt).slice(0, 300)].filter(Boolean).join(" — ") || null,
    }, ref);
    if (e && (!e.date || e.date >= ref)) out.push(e);
  }
  return out;
}

export async function fetchSquarespaceEvents(src, { ref }) {
  const u = new URL(src.url);
  u.searchParams.set("format", "json");
  const json = JSON.parse(await getText(u.toString()));
  return parseSquarespaceEvents(json, src, ref, `${u.protocol}//${u.host}`);
}

// ─── Dice browse pages (__NEXT_DATA__) ─────────────────────────────────────

/** Dice browse HTML → raw events[] from the embedded Next.js page props. */
export function diceEventsFromHtml(html) {
  const m = String(html || "").match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/); // lang-regex-ok: framework data island
  if (!m) return [];
  try { return JSON.parse(m[1])?.props?.pageProps?.events || []; } catch { return []; }
}

/** One Dice event → {title, date, time, venue, url, status, price_min} (wall time in `tz`). */
export function diceRow(ev, tz = homeTz()) {
  const start = ev?.dates?.event_start_date || null;
  const ms = start ? Date.parse(start) : NaN;
  const { date, time } = Number.isFinite(ms) ? localParts(ms, tz) : { date: null, time: null };
  const v = (ev?.venues || [])[0] || {};
  return {
    title: String(ev?.name || "").trim(),
    date, time,
    venue: v.name || null,
    address: v.address || null,
    url: ev?.id ? `https://dice.fm/event/${ev.id}` : null,
    status: ev?.status === "on-sale" ? "onsale" : ev?.status === "sold-out" ? "soldout" : ev?.status || null,
    price_min: ev?.price?.amount != null ? ev.price.amount / 100 : null,
  };
}

export async function fetchDice(src, { ref }) {
  const rows = diceEventsFromHtml(await getText(src.url, { timeoutMs: 25000 })).map((ev) => diceRow(ev, src.tz || homeTz()));
  return rows.map((r) => makeEvent(src, { ...r, venue: r.venue || src.venue, category: src.category || "comedy" }, ref))
    .filter((e) => e && (!e.date || e.date >= ref));
}

// ─── schema.org JSON-LD listing page ───────────────────────────────────────
// One GET per page, no browser, no scraping of visible text.

export async function fetchJsonLdPage(src, { ref }) {
  const out = [];
  for (let p = 1; p <= (src.pages || 1); p++) {
    const u = new URL(src.url);
    if (p > 1) u.searchParams.set("page", String(p));
    const rows = eventsFromHtml(await getText(u.toString(), { timeoutMs: 25000 }), `${u.protocol}//${u.host}`);
    if (!rows.length) break;
    for (const r of rows) {
      const e = makeEvent(src, {
        title: r.name, date: r.start, time: isoClock(r.start), url: r.url, venue: r.location || src.venue,
        performers: r.performers, category: src.category, description: r.description,
        status: /SoldOut/i.test(r.availability || "") ? "soldout" : null, // lang-regex-ok: schema.org availability enum
      }, ref);
      if (e) out.push(e);
    }
  }
  return out;
}
