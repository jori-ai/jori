// event-ld.mjs — pull schema.org Event objects out of a venue page's
// <script type="application/ld+json"> blocks. Most venue sites (comedy rooms, clubs) publish
// them (their ticketing CMS emits them for search engines), which turns a
// calendar page into structured {name, startDate, url, performers} rows with
// no scraping of visible text and no model.
//
// Structure only: this reads the venue's machine-published metadata.

const EVENT_TYPES = /Event$/; // Event, ComedyEvent, TheaterEvent, MusicEvent…

function* walk(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) yield* walk(n); return; }
  yield node;
  for (const k of ["@graph", "itemListElement", "item", "subEvent", "event", "events"]) {
    if (node[k]) yield* walk(node[k]);
  }
}

function text(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(", ");
  return v.name || v["@id"] || "";
}

function decode(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** All Event-typed objects in the page's JSON-LD, normalised. */
export function eventsFromHtml(html, baseUrl = "") {
  const out = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    for (const n of walk(data)) {
      const types = [].concat(n["@type"] || []);
      if (!types.some((t) => EVENT_TYPES.test(String(t)))) continue;
      let url = n.url || n.offers?.url || (Array.isArray(n.offers) ? n.offers[0]?.url : "") || "";
      try { url = url ? new URL(url, baseUrl).href : ""; } catch {}
      const offers = [].concat(n.offers || []);
      out.push({
        name: decode(text(n.name)).trim(),
        start: n.startDate || null,
        url,
        location: decode(text(n.location)).trim(),
        performers: [].concat(n.performer || []).map((p) => decode(text(p)).trim()).filter(Boolean),
        availability: String(offers[0]?.availability || "").split("/").pop() || null,
        description: decode(String(n.description || "")).slice(0, 500),
      });
    }
  }
  // Same event can be emitted twice (list + detail); dedupe on url+start+name.
  const seen = new Set();
  return out.filter((e) => {
    const k = `${e.url}|${e.start}|${e.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
