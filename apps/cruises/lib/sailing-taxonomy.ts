// Grouping vocabulary the filters need but the database does not store.
//
// Two problems this file solves, both invisible until you try to filter on
// them:
//
// 1. PORT NAMES ARE UNNORMALIZED. Each line's API writes its own spelling, and
//    the extractors pass them through verbatim. "Galveston", "Galveston, Texas" and
//    "Galveston, Texas, US" are three separate rows in a port filter built
//    straight off the column — one port's sailings split three ways,
//    each looking smaller than it is. Port Canaveral, Cape Liberty,
//    Ravenna, Tokyo, Athens, Boston and Honolulu all do the same.
//    Normalizing collapses 50 raw values to ~35 real ports.
//
// 2. THERE IS NO DESTINATION FIELD. `departure_port_region` exists in the
//    schema and is null on every row; no line's search API gives us the
//    itinerary. So "region" here is derived from where the ship LEAVES, which
//    is a good proxy for where it goes (a Galveston departure is a Caribbean
//    cruise, Seward is Alaska, Barcelona is the Mediterranean) and a wrong one
//    for the occasional repositioning voyage. It is labelled "Region" rather
//    than "Destination" in the UI for exactly that reason.
//
// If a line ever starts returning a real itinerary region, prefer it and keep
// this as the fallback — don't delete it, ~⅓ of the corpus predates any such
// field.
//
// `normalizePort` itself lives in sailing-row.ts, beside the encoder that
// applies it: these two files import nothing, from each other or anywhere, so
// Node can load either one directly in a test (its ESM resolver wants a file
// extension that TypeScript's does not, and a cross-import between them is the
// one thing that would need one).

/** Ordered so the UI lists the biggest regions first; "Other" always last. */
export const REGIONS = [
  "Caribbean & Bahamas",
  "Alaska",
  "Mediterranean",
  "Asia",
  "Northeast US",
  "Mexico & West Coast",
  "Australia & NZ",
  "Panama & S. America",
  "Northern Europe",
  "Hawaii",
  "Other",
] as const;

export type Region = (typeof REGIONS)[number];

const PORT_REGION: Record<string, Region> = {
  // Caribbean, Bahamas and the Gulf — one cruising basin from a booker's view.
  Miami: "Caribbean & Bahamas", // kernel-guard-ok: a cruise port's region, world data
  "Fort Lauderdale": "Caribbean & Bahamas", // kernel-guard-ok: a cruise port's region, world data
  "Port Canaveral": "Caribbean & Bahamas",
  Tampa: "Caribbean & Bahamas",
  Galveston: "Caribbean & Bahamas",
  "New Orleans": "Caribbean & Bahamas",
  "San Juan": "Caribbean & Bahamas",

  Vancouver: "Alaska",
  Seward: "Alaska",
  Seattle: "Alaska",
  // Cruisetour ends: an Alaska sailing that disembarks at Anchorage or
  // Fairbanks has not changed cruising region, and without these it looked like
  // it had — 278 sailings between them.
  Anchorage: "Alaska",
  Fairbanks: "Alaska",

  Barcelona: "Mediterranean",
  Rome: "Mediterranean",
  Athens: "Mediterranean",
  Ravenna: "Mediterranean",
  Istanbul: "Mediterranean",
  Lisbon: "Mediterranean",
  Civitavecchia: "Mediterranean",
  Malaga: "Mediterranean",
  "Málaga": "Mediterranean",

  Singapore: "Asia",
  Shanghai: "Asia",
  "Hong Kong": "Asia",
  Tokyo: "Asia",
  Seoul: "Asia",
  Bali: "Asia",

  "New York": "Northeast US", // kernel-guard-ok: a cruise port's region, world data
  "Cape Liberty": "Northeast US",
  Philadelphia: "Northeast US",
  Baltimore: "Northeast US",
  Boston: "Northeast US",
  // Canada/New England sails as one basin with the US northeast here.
  "Québec City": "Northeast US",
  "Quebec City": "Northeast US",
  Montreal: "Northeast US",
  "Montréal": "Northeast US",

  "Los Angeles": "Mexico & West Coast",
  "San Diego": "Mexico & West Coast",

  Sydney: "Australia & NZ",
  Brisbane: "Australia & NZ",
  Auckland: "Australia & NZ",

  Colón: "Panama & S. America",
  Cartagena: "Panama & S. America",
  "Buenos Aires": "Panama & S. America",
  Valparaiso: "Panama & S. America",
  "Valparaíso": "Panama & S. America",
  Santiago: "Panama & S. America",

  Southampton: "Northern Europe",
  Amsterdam: "Northern Europe",
  Rotterdam: "Northern Europe",
  Dover: "Northern Europe",
  Reykjavik: "Northern Europe",

  Honolulu: "Hawaii",
};

/** @param port a name already through normalizePort (sailing-row.ts). */
export function regionForPort(port: string): Region {
  return PORT_REGION[port] ?? "Other";
}

/**
 * Price bands over the CABIN's nightly rate — two people in a balcony.
 *
 * The key price metric is two people in a balcony room per night, because it is
 * comparable to hotels and resorts. That is the whole reason for the unit: a hotel quotes a room for the night, so a cabin
 * for the night is the number that can sit beside it. The lines publish
 * per-person fares, so the site doubles them — everywhere, once, at decode.
 *
 * The edges are the earlier per-person cuts ($100/$150/$200/$300) doubled, so
 * the shape of the filter users were used to survives the change of unit.
 * Cut against the real spread: the corpus runs $118–$2,544 a night.
 */
export const PRICE_BANDS = [
  { key: "u200", label: "Under $200", min: 0, max: 200 },
  { key: "200-300", label: "$200 – $300", min: 200, max: 300 },
  { key: "300-400", label: "$300 – $400", min: 300, max: 400 },
  { key: "400-600", label: "$400 – $600", min: 400, max: 600 },
  { key: "600+", label: "$600+", min: 600, max: Infinity },
] as const;

/**
 * Default ceiling on the CABIN's nightly rate — two people in a balcony, which
 * is both the number the traveller pays and the one that compares to a hotel
 * room. NEXT_PUBLIC_DEFAULT_MAX_CABIN_PER_NIGHT sets it per deployment ("any"
 * = no default cap); $440 otherwise.
 *
 * Deliberately a separate control from the bands above rather than a band edge
 * of its own — $440 lands between two of them, which is the point.
 */
export function parseDefaultCap(raw: string | undefined, fallback = 440): number | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return fallback;
  if (s === "any" || s === "none") return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const DEFAULT_MAX_CABIN_PER_NIGHT: number | null = parseDefaultCap(
  process.env.NEXT_PUBLIC_DEFAULT_MAX_CABIN_PER_NIGHT,
);

/**
 * A published fare is per person at double occupancy; a cabin is two of them.
 * Since the site went per-person this is only used for the secondary "cabin for
 * two" line on a card, never for filtering or sorting.
 */
export const OCCUPANCY = 2;

export const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;
