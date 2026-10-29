// Princess Cruises extractor.
//
// Added 2026-09-01 as the seventh line (other lines of that group were judged
// not relevant) and the first that needed a browser to read at all.
//
// HOW IT DIFFERS FROM THE OTHER SIX. Every other extractor calls a JSON
// endpoint with a plain fetch. Princess's inventory lives in a Redux store the
// page hydrates client-side, and its own gateway
// (`gw.api.princess.com/pcl-web/internal/resdb/p1.0/products`) rejects a bare
// call: without the `pcl-client-id` header it is 401 "Client id missing", and
// with it — the id is extractable from `princess-libs.combined.js` at runtime —
// it becomes 400 "required API parameters are missing" on every parameter set
// and header combination tried (probed 2026-09-01). Rather than keep guessing
// at an undocumented contract, this reads the store the page has already built.
// One render yields the WHOLE catalogue, not one port's worth: ~1,000 priced
// itineraries with their sailings, fares, ships and ports.
//
// WHAT THAT BUYS. Princess is also the only line of the seven whose search data
// carries PROMOTIONS (`promo.id`, `includedPromos`) alongside per-cabin-grade
// fares — the gap that royal and celebrity leave open.
//
// THE BALCONY FARE. `fares[].metas[]` maps a cabin grade to a meta: S suite,
// M mini-suite, B BALCONY, O oceanview, I interior. `categories[]` carries the
// actual money, each tagged with `metaId`. The balcony fare is the cheapest
// available category whose metaId is "B", read from `averageGuestPrice`, which
// is per person — the same basis as the rest of the corpus.

import { evaluateOnPage } from "./cdp.mjs";
import { cruiseConfig } from "./config.mjs";

// Filtered to the cruise-watch config `princess_departure_port`; with none
// configured the line is not searched.
function resultsUrl() {
  const port = cruiseConfig().princess_departure_port;
  return port ? `https://www.princess.com/cruise-search/results/?departurePort=${encodeURIComponent(port)}` : null;
}

// The results grid asks for INTERIOR lead-in fares (`filters.meta: "I"`), which
// is why reading the store alone yielded a balcony price for 10 of 2,089
// sailings. The pricing endpoint takes filters rather than a voyage list, so the
// same request with `meta: "B"` prices the entire catalogue in one call.
//
// Re-issuing it from inside the page rather than from Node is what makes this
// tractable: the request carries a per-session `AppId`, a client id and a large
// booking-agency body, all of which the app has already assembled correctly.
// Copying its own request beats reconstructing one.
const PRELOAD = `
  window.__pclPricingReq = null;
  const _open = XMLHttpRequest.prototype.open;
  const _setH = XMLHttpRequest.prototype.setRequestHeader;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; this.__h = {}; return _open.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (this.__h) this.__h[k] = v; return _setH.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    try {
      if (String(this.__u || "").includes("/pricing/v1/cruises") && b && !window.__pclPricingReq) {
        window.__pclPricingReq = { url: this.__u, headers: this.__h, body: String(b) };
      }
    } catch (e) {}
    return _send.apply(this, arguments);
  };
`;

// The port filter in that URL only narrows the page's own `filtered` list; the
// store still holds every product, which is what we read.
//
// THE MAPPING RUNS IN THE PAGE, not in Node, and that is load-bearing rather
// than stylistic: the raw store is tens of megabytes (1,000 products, each with
// every cabin grade's fare table for every sailing), and returning it through
// CDP's `returnByValue` serializes the lot — the first version of this hung
// past ten minutes doing exactly that. Transforming first and returning only
// the finished rows moves a few hundred KB instead.
const EXTRACT = `(async () => {
  const s = window.__NEXT_REDUX_STORE__ && window.__NEXT_REDUX_STORE__.getState();
  if (!s) return { error: "no redux store" };
  const asList = (x) => Array.isArray(x) ? x : (x && Array.isArray(x.data) ? x.data : []);

  const products = asList(s.products && s.products.cruises);

  // Ask for BALCONY lead-in fares using the app's own captured request.
  let pricing = asList(s.pricing && s.pricing.cruises);
  const req = window.__pclPricingReq;
  if (req) {
    try {
      const body = JSON.parse(req.body);
      body.filters = Object.assign({}, body.filters, { meta: "B" });
      const res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body) });
      if (res.ok) {
        const j = await res.json();
        const got = Array.isArray(j) ? j : (j && (j.products || j.data || j.itins || j.cruises)) || [];
        if (got.length) pricing = got;
      }
    } catch (e) { /* fall back to the store's interior-scoped pricing */ }
  }
  const shipName = new Map(asList(s.ships).map((x) => [x.id, (x.name || "").trim()]));
  const portName = new Map(asList(s.ports).map((x) => [x.id, (x.name || x.portName || "").trim()]));

  const priceFor = new Map();
  for (const prod of pricing) {
    for (const c of (prod && prod.cruises) || []) {
      if (c && c.id) priceFor.set(prod.id + "|" + c.id, c.pricing);
    }
  }

  const iso = (d) => /^\\d{8}$/.test(String(d || "")) ? String(d).slice(0,4)+"-"+String(d).slice(4,6)+"-"+String(d).slice(6,8) : null;

  // The balcony categories, per fare.
  //
  // Two response shapes carry this and they disagree: the store's copy tags
  // each category with \`metaId\`, while the balcony request's copy omits it and
  // expects you to go through \`metas[]\`, where the entry with id "B" names its
  // \`bestCategory\` (e.g. "BF"). Reading metaId alone silently priced 0 of
  // 2,089 sailings, so both paths are handled.
  const balconyCats = (fare) => {
    const tagged = (fare.categories || []).filter((c) => c.metaId === "B");
    if (tagged.length) return tagged;
    const meta = (fare.metas || []).find((m) => m.id === "B" || m.polarMeta === "B");
    if (!meta || meta.status === "N") return [];
    return (fare.categories || []).filter((c) => c.id === meta.bestCategory);
  };

  // Cheapest sellable balcony fare, per person.
  const balcony = (p) => {
    let best = null;
    for (const fare of (p && p.fares) || []) {
      for (const cat of balconyCats(fare)) {
        if (cat.status === "N") continue;
        const v = Number(cat.averageGuestPrice);
        if (!isFinite(v) || v <= 0) continue;
        if (best === null || v < best) best = v;
      }
    }
    return best;
  };
  const promos = (p) => {
    const m = new Map();
    for (const fare of (p && p.fares) || []) {
      for (const cat of balconyCats(fare)) {
        if (cat.promo && cat.promo.id) m.set(cat.promo.id, { code: String(cat.promo.id), label: String(cat.promo.id) });
        for (const q of cat.includedPromos || []) if (q && q.id) m.set(q.id, { code: String(q.id), label: String(q.id) });
      }
    }
    return [...m.values()].sort((a, b) => a.code.localeCompare(b.code));
  };

  const out = [];
  for (const product of products) {
    for (const cruise of (product && product.cruises) || []) {
      const v = cruise.voyage;
      if (!v) continue;
      const depart = iso(cruise.startDate || v.sailDate);
      const ship = shipName.get(v.ship && v.ship.id);
      const dep = portName.get(v.startPortId) || v.startPortId || null;
      const nights = Number(v.duration);
      if (!depart || !ship || !dep || !isFinite(nights)) continue;

      const p = priceFor.get(product.id + "|" + cruise.id);
      const seq = (v.ports || []).map((id) => ({ code: id, name: portName.get(id) || id }));

      out.push({
        source: "princess",
        sailing_id: "princess:" + cruise.id,
        cruise_id: product.id,
        ship_name: ship,
        ship_built_year: null,
        departure_port: dep,
        departure_port_code: v.startPortId || null,
        departure_port_region: null,
        ports_of_call: seq.length > 2 ? seq.slice(1, -1) : [],
        ports_ordered: true,
        disembark_port: portName.get(v.endPortId) || v.endPortId || null,
        disembark_port_code: v.endPortId || null,
        depart_date: depart,
        return_date: iso(cruise.endDate),
        nights,
        lowest_balcony_per_person_usd: balcony(p),
        taxes_fees_included: null,
        currency: cruise.shipCurrency || "USD",
        booking_url: "https://www.princess.com/cruise-search/details/?voyageCode=" + encodeURIComponent(cruise.id) + "&itineraryCode=" + encodeURIComponent(product.id),
        product_url: "https://www.princess.com/cruise-search/details/?voyageCode=" + encodeURIComponent(cruise.id) + "&itineraryCode=" + encodeURIComponent(product.id),
        hero_image_url: null,
        promos: promos(p),
      });
    }
  }
  return { sailings: out, products: products.length, pricedFrom: req ? "balcony-request" : "store" };
})()`;

export async function fetchSailings({ settleMs = 16_000 } = {}) {
  const t0 = Date.now();
  const url = resultsUrl();
  if (!url) return { sailings: [], pages: 0, total_cruises: 0, duration_ms: 0 };
  const raw = await evaluateOnPage(url, EXTRACT, { settleMs, port: 9341, preload: PRELOAD });
  if (!raw || raw.error || !Array.isArray(raw.sailings)) {
    throw new Error(`princess store unreadable: ${raw?.error || "empty"}`);
  }
  return {
    sailings: raw.sailings,
    pages: 1,
    total_cruises: raw.products,
    duration_ms: Date.now() - t0,
  };
}
