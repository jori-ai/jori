// Shared shape of the cruise corpus: the wire encoding, its decoder and the
// line labels. Deliberately free of any server-only import — CruiseBrowser is a
// client component and pulls decodeSailings from here, so a `next/headers`
// import anywhere in this module's graph breaks the build. The server-side
// query lives in sailings.ts.
//
// WHY THE ENCODING. ~6,800 future priced sailings as plain JSON objects is
// 5.8 MB, and most of that is repetition: 79 ship names, 50 ports, 710 hero
// image URLs spread across those rows, plus a 12-key object header repeated
// 6,800 times. Dictionary-encoding the repeats and shipping rows as positional
// tuples cuts it to ~1.5 MB (~200 KB over the wire), which is small enough to
// hand the client the WHOLE corpus once and filter it in memory — no server
// round-trip per keystroke, per slider drag, per sort. Booking URLs are the one
// field that genuinely is unique per row and stays inline, because a "Book"
// link that needs a second fetch is a "Book" link that feels broken.
//
// The tuple layout is positional and therefore fragile by construction: any
// change to ROW must change both SailingEncoder and decodeSailings below in
// the same edit. Indexes are named constants rather than open-coded
// numbers so a mismatch is one place to fix, not twenty.

/** Ports whose canonical name isn't just "the part before the first comma". */
const PORT_ALIASES: Record<string, string> = {
  // The parenthetical is the port; the lead word is the metro.
  "orlando (port canaveral)": "Port Canaveral",
  "port canaveral (orlando)": "Port Canaveral",
  "oahu (honolulu)": "Honolulu",
  "honolulu (oahu)": "Honolulu",
  "benoa (bali)": "Bali",
  // The lead word is the port; the parenthetical is the terminal or metro.
  "cape liberty (new york)": "Cape Liberty", // kernel-guard-ok: a cruise terminal's public name, world data
  "rome (civitavecchia)": "Rome",
  "athens (piraeus)": "Athens",
  "ravenna (venice)": "Ravenna",
  "tokyo (yokohama)": "Tokyo",
  "shanghai (baoshan)": "Shanghai",
  "seoul (incheon)": "Seoul",
  "new york, new york": "New York", // kernel-guard-ok: a cruise port's public name, world data
};

/**
 * Collapse a line's spelling of a port to one canonical name.
 *
 * lang-regex-ok: parses a vendor API's machine-written place string
 * (administrative suffixes and parentheticals), not anything a person said.
 */
export function normalizePort(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  const alias = PORT_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;

  // Drop administrative suffixes: "Galveston, Texas, US" → "Galveston".
  let head = trimmed.split(",")[0].trim();
  const aliasHead = PORT_ALIASES[head.toLowerCase()];
  if (aliasHead) return aliasHead;

  // Generic "City (Terminal)" → "City", after the alias table has had its say
  // (it owns the cases where the parenthetical is the canonical half).
  const paren = head.indexOf("(");
  if (paren > 0) head = head.slice(0, paren).trim();
  return head;
}

export const SUPABASE_PAGE = 1000; // PostgREST caps a single response at 1000 rows

/** Column order of an encoded row. Keep in lockstep with encode/decode below. */
export const ROW = {
  ID: 0,
  LINE: 1,        // index into dict.lines
  SHIP: 2,        // index into dict.ships
  BUILT: 3,
  PORT: 4,        // index into dict.ports (NORMALIZED — see sailing-taxonomy)
  DEPART: 5,      // "YYYY-MM-DD"
  RET_OFFSET: 6,  // return_date - depart_date, in days (usually === nights, but
                  // 3.5% of sailings disagree, so it is stored, not derived)
  NIGHTS: 7,
  PRICE: 8,       // lowest balcony, $ per person, whole sailing
  PPPN: 9,        // $ per person per night
  TAX_INCL: 10,   // 1 | 0 | -1 (unknown)
  IS_MATCH: 11,   // 1 | 0 — passes the travel-plan filter
  CITY: 12,       // index into dict.cities, or -1
  CHANGE_PCT: 13, // signed, at the most recent observed change; null if never moved
  CHANGE_USD: 14,
  PREV_PRICE: 15,
  CHANGED_AT: 16, // ISO date (day precision) of that change, or null
  ATL: 17,        // 1 | 0 — currently at its lowest observed price
  REACHABLE: 18,  // 1 | 0 — right port and dates; NO price or ship-age gate
  ASSUMED: 19,    // 1 | 0 — matched a assumed home-city window, not a decided leg
  BOOK: 20,       // booking URL (unique per row — not dictionary-encoded)
  CALLS: 21,      // number[] — indices into dict.callPorts, in sailed order
  DISEMBARK: 22,  // index into dict.callPorts, or -1 (where the sailing ENDS)
  ORDERED: 23,    // 1 | 0 — is CALLS a sequence or just a set? (Holland: 0)
  SEEN: 24,       // "YYYY-MM-DD" the price was last re-observed, or null
} as const;

export type EncodedRow = (string | number | null)[];

export type SailingIndex = {
  lines: string[];
  ships: string[];
  ports: string[];
  /**
   * Ports of call and disembarkation ports — a SEPARATE dictionary from
   * `ports`, which holds only the ~50 departure ports. The site's port filter
   * offers the union of both (it matches a port anywhere on the route); they
   * stay separate here because `ports` is a sailing's departure, which the
   * region map and the one-way test key on.
   */
  callPorts: string[];
  cities: string[];
  /**
   * Ship photos, POSITIONALLY ALIGNED WITH `ships` — shipPhotos[i] is the photo
   * for ships[i], or null. A photo belongs to the ship, not the sailing, so it
   * rides the ship dictionary instead of a per-row field: 79 entries where the
   * old per-sailing hero dictionary held 710, and one fewer column per row.
   */
  shipPhotos: (string | null)[];
  /**
   * Cruise Critic member rating per ship, aligned with `ships` exactly as
   * shipPhotos is: [rating, reviewCount] or null. Per-ship, so it costs 79
   * entries rather than a column on all ~6,800 rows.
   */
  shipRatings: ([number, number | null] | null)[];
  rows: EncodedRow[];
  /** Total rows the query matched, before any client-side filtering. */
  total: number;
  /** Most recent cruise-watch run, ISO — "prices as of" on the page. */
  lastRunAt: string | null;
  truncated: boolean;
};

/** Decoded shape the UI works with. */
export type Sailing = {
  id: string;
  line: string;
  ship: string;
  built: number | null;
  port: string;
  depart: string;
  ret: string;
  nights: number;
  price: number;
  pppn: number;
  taxIncl: boolean | null;
  isMatch: boolean;
  /** Right port and dates. is_match implies this; never the reverse. */
  isReachable: boolean;
  /** The window it matched is an assumed home-city fill, not a decided leg. */
  assumedWindow: boolean;
  city: string | null;
  /** Intermediate ports, excluding embarkation and disembarkation. */
  calls: string[];
  /** False when the line gave us a set with no sailed order (Holland). */
  callsOrdered: boolean;
  /** Where the sailing ends; null when the line did not say. */
  disembark: string | null;
  /**
   * Ends in a different port than it started.
   *
   * This is NOT the same as a repositioning cruise, and conflating them was a
   * live bug: Mariner of the Seas runs Barcelona→Lisbon one week and
   * Lisbon→Barcelona the next, and both were badged "Repositioning" — which
   * can't be: the same ship can't reposition to Europe week after week. Those are ordinary one-way itineraries inside one
   * cruising region. A repositioning cruise is the seasonal move BETWEEN
   * regions, and that extra test lives in CruiseBrowser, which is where the
   * region map is. See `Row.repositioning`.
   */
  oneWay: boolean;
  changePct: number | null;
  changeUsd: number | null;
  prevPrice: number | null;
  changedAt: string | null;
  atl: boolean;
  hero: string | null;
  /**
   * When this sailing's price was last re-observed at the source.
   *
   * The site shows every row in the database rather than only the latest
   * sweep — a line's search set churns and a missing row is not a cancelled
   * cruise. So age is disclosed rather than acted on: a card whose price has
   * not been confirmed lately says when it was.
   */
  lastSeen: string | null;
  /** Cruise Critic member rating, 1–5, and how many reviews back it. */
  rating: number | null;
  reviews: number | null;
  book: string | null;
};


export function addDays(iso: string, days: number): string {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type DbRow = Record<string, unknown>;

function interner(out: string[]) {
  const seen = new Map<string, number>();
  return (v: unknown): number => {
    if (typeof v !== "string" || v === "") return -1;
    const hit = seen.get(v);
    if (hit !== undefined) return hit;
    const idx = out.length;
    out.push(v);
    seen.set(v, idx);
    return idx;
  };
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

/**
 * Accumulates encoded rows and the string dictionaries they index into.
 *
 * Encoder and decoder live in the same file on purpose: ROW is positional, so a
 * column added on one side and forgotten on the other shifts every field after
 * it with no type error and no runtime throw — just quietly wrong data on the
 * page. Keeping them adjacent (and round-tripped in
 * tests/cruise-site-encoding.test.mjs) is what makes that mistake loud.
 */
export class SailingEncoder {
  readonly lines: string[] = [];
  readonly ships: string[] = [];
  readonly ports: string[] = [];
  readonly callPorts: string[] = [];
  readonly cities: string[] = [];
  readonly shipPhotos: (string | null)[] = [];
  readonly shipRatings: ([number, number | null] | null)[] = [];
  readonly rows: EncodedRow[] = [];
  lastRunAt: string | null = null;

  private readonly internLine = interner(this.lines);
  private readonly internShip = interner(this.ships);
  private readonly internPort = interner(this.ports);
  private readonly internCallPort = interner(this.callPorts);
  private readonly internCity = interner(this.cities);

  /** ship name (lower-cased) → photo URL, from cruise_ship_photos. */
  private shipPhotoByName = new Map<string, string>();
  /** ship name (lower-cased) → [rating, reviewCount], from cruise_ship_ratings. */
  private shipRatingByName = new Map<string, [number, number | null]>();

  /** Call before add(); later lookups resolve against these. */
  setShipPhotos(byName: Map<string, string>) {
    this.shipPhotoByName = byName;
  }
  setShipRatings(byName: Map<string, [number, number | null]>) {
    this.shipRatingByName = byName;
  }

  /** @returns whether the row was usable (a row without a date, price or
   *  night count cannot be displayed or sorted, so it is dropped here). */
  add(r: DbRow): boolean {
    const depart = String(r.depart_date ?? "");
    const ret = String(r.return_date ?? "");
    const price = num(r.lowest_balcony_per_person_usd);
    const nights = num(r.nights);
    if (!depart || price === null || nights === null) return false;

    const runAt = typeof r.last_run_at === "string" ? r.last_run_at : null;
    if (runAt && (!this.lastRunAt || runAt > this.lastRunAt)) this.lastRunAt = runAt;

    const row: EncodedRow = [];
    row[ROW.ID] = String(r.sailing_id);
    row[ROW.LINE] = this.internLine(r.source);
    row[ROW.SHIP] = this.internShip(r.ship_name);
    // Keep the per-ship arrays index-aligned with `ships` as names intern.
    while (this.shipPhotos.length < this.ships.length) {
      const name = this.ships[this.shipPhotos.length];
      this.shipPhotos.push(this.shipPhotoByName.get(name.toLowerCase()) ?? null);
      this.shipRatings.push(this.shipRatingByName.get(name.toLowerCase()) ?? null);
    }
    row[ROW.BUILT] = num(r.ship_built_year);
    // Normalized, not raw: each line spells the same port its own way, and an
    // un-collapsed dictionary gives the port filter three "Tampa" rows with a
    // third of the count each. See sailing-taxonomy.ts.
    row[ROW.PORT] = this.internPort(normalizePort(r.departure_port as string));
    row[ROW.DEPART] = depart;
    row[ROW.RET_OFFSET] = ret ? daysBetween(depart, ret) : nights;
    row[ROW.NIGHTS] = nights;
    row[ROW.PRICE] = price;
    row[ROW.PPPN] = num(r.per_person_per_night_usd) ?? Math.round((price / nights) * 100) / 100;
    row[ROW.TAX_INCL] = r.taxes_fees_included === true ? 1 : r.taxes_fees_included === false ? 0 : -1;
    row[ROW.IS_MATCH] = r.is_match ? 1 : 0;
    row[ROW.CITY] = this.internCity(r.matched_city);
    row[ROW.CHANGE_PCT] = num(r.price_change_pct);
    row[ROW.CHANGE_USD] = num(r.price_change_usd);
    row[ROW.PREV_PRICE] = num(r.prev_balcony_per_person_usd);
    row[ROW.CHANGED_AT] = typeof r.price_changed_at === "string" ? r.price_changed_at.slice(0, 10) : null;
    row[ROW.ATL] = r.is_all_time_low ? 1 : 0;
    row[ROW.REACHABLE] = r.is_reachable ? 1 : 0;
    row[ROW.ASSUMED] = r.matched_window_assumed ? 1 : 0;
    row[ROW.BOOK] = typeof r.booking_url === "string" ? r.booking_url : null;
    // Ports of call. Normalized through the same collapser as departure ports
    // so "Nassau, Bahamas" and "Nassau" are one dictionary entry, then deduped
    // — a sailing that calls twice at CocoCay reads better listed once.
    const calls: number[] = [];
    const seen = new Set<string>();
    for (const c of Array.isArray(r.ports_of_call) ? r.ports_of_call : []) {
      const name = normalizePort((c as { name?: string })?.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      calls.push(this.internCallPort(name));
    }
    row[ROW.CALLS] = calls as unknown as number;
    row[ROW.DISEMBARK] = this.internCallPort(normalizePort(r.disembark_port as string) || null);
    row[ROW.ORDERED] = r.ports_ordered === false ? 0 : 1;
    row[ROW.SEEN] = typeof r.last_seen_at === "string" ? r.last_seen_at.slice(0, 10) : null;
    this.rows.push(row);
    return true;
  }

  finish(truncated: boolean): SailingIndex {
    return {
      lines: this.lines,
      ships: this.ships,
      ports: this.ports,
      callPorts: this.callPorts,
      cities: this.cities,
      shipPhotos: this.shipPhotos,
      shipRatings: this.shipRatings,
      rows: this.rows,
      total: this.rows.length,
      lastRunAt: this.lastRunAt,
      truncated,
    };
  }
}

/** The columns SailingEncoder.add reads — the site's select list. */
export const SAILING_COLUMNS = [
  "sailing_id",
  "source",
  "ship_name",
  "ship_built_year",
  "departure_port",
  "ports_of_call",
  "ports_ordered",
  "disembark_port",
  "depart_date",
  "return_date",
  "nights",
  "lowest_balcony_per_person_usd",
  "per_person_per_night_usd",
  "taxes_fees_included",
  "is_match",
  "matched_city",
  "price_change_pct",
  "price_change_usd",
  "prev_balcony_per_person_usd",
  "price_changed_at",
  "is_all_time_low",
  "is_reachable",
  "matched_window_assumed",
  "booking_url",
  "last_run_at",
  "last_seen_at",
  "data_source",
] as const;

/** Inverse of the encoder. Positional — see the ROW comment above. */
export function decodeSailings(ix: SailingIndex): Sailing[] {
  const at = (dict: string[], i: unknown): string | null =>
    typeof i === "number" && i >= 0 ? dict[i] ?? null : null;

  return ix.rows.map((r) => {
    const depart = String(r[ROW.DEPART]);
    const shipIdx = typeof r[ROW.SHIP] === "number" ? (r[ROW.SHIP] as number) : -1;
    return {
      id: String(r[ROW.ID]),
      line: at(ix.lines, r[ROW.LINE]) ?? "",
      ship: at(ix.ships, r[ROW.SHIP]) ?? "",
      built: r[ROW.BUILT] as number | null,
      port: at(ix.ports, r[ROW.PORT]) ?? "",
      depart,
      ret: addDays(depart, Number(r[ROW.RET_OFFSET] ?? 0)),
      nights: Number(r[ROW.NIGHTS]),
      price: Number(r[ROW.PRICE]),
      pppn: Number(r[ROW.PPPN]),
      taxIncl: r[ROW.TAX_INCL] === 1 ? true : r[ROW.TAX_INCL] === 0 ? false : null,
      isMatch: r[ROW.IS_MATCH] === 1,
      isReachable: r[ROW.REACHABLE] === 1,
      assumedWindow: r[ROW.ASSUMED] === 1,
      city: at(ix.cities, r[ROW.CITY]),
      calls: ((r[ROW.CALLS] as unknown as number[]) ?? [])
        .map((i) => ix.callPorts[i] ?? null)
        .filter((n): n is string => !!n),
      callsOrdered: r[ROW.ORDERED] !== 0,
      disembark: at(ix.callPorts, r[ROW.DISEMBARK]),
      oneWay: (() => {
        const end = at(ix.callPorts, r[ROW.DISEMBARK]);
        const start = at(ix.ports, r[ROW.PORT]);
        // Both sides run through normalizePort at encode time, so this compares
        // canonical names — "Rome (Civitavecchia)" vs "Rome" cannot
        // masquerade as a one-way. No disembarkation port means no claim.
        return !!end && !!start && end !== start;
      })(),
      changePct: r[ROW.CHANGE_PCT] as number | null,
      changeUsd: r[ROW.CHANGE_USD] as number | null,
      prevPrice: r[ROW.PREV_PRICE] as number | null,
      changedAt: (r[ROW.CHANGED_AT] as string | null) ?? null,
      atl: r[ROW.ATL] === 1,
      // Looked up through the ship index, not a column of its own.
      hero: shipIdx >= 0 ? ix.shipPhotos[shipIdx] ?? null : null,
      rating: shipIdx >= 0 ? ix.shipRatings[shipIdx]?.[0] ?? null : null,
      reviews: shipIdx >= 0 ? ix.shipRatings[shipIdx]?.[1] ?? null : null,
      lastSeen: (r[ROW.SEEN] as string | null) ?? null,
      book: (r[ROW.BOOK] as string | null) ?? null,
    };
  });
}

/**
 * How far behind its line's newest scrape a sailing may be and still be shown.
 *
 * `last_run_at` is stamped on every row a run upserts, so it doubles as "when
 * did this line last return this sailing." A sailing that stops coming back has
 * almost always sold out of balcony inventory — the search is filtered to
 * balconies — or been withdrawn. Either way it is not bookable, and showing it
 * is worse than hiding it: the card carries a price, a Book button, and (since
 * the itinerary columns landed) no ports at all, because only rows a run has
 * touched since then have one. That is how this surfaced — a card with no
 * ports, last seen one run earlier. 668 of 7,443
 * future sailings were stale, the oldest by seven weeks, every one still priced.
 *
 * PER LINE **AND PER DATA SOURCE**, measured from that combination's newest run
 * rather than from now.
 *
 * The data-source half was added on 2026-09-01 when CruiseFeed landed and Royal
 * collapsed from 3,878 visible sailings to 343. CruiseFeed rows carry the same
 * `source` as our scraped ones — a Royal sailing is `royal` whoever found it —
 * but the two sweep on different cadences (scrapers weekly, CruiseFeed
 * monthly). Keyed on `source` alone, a CruiseFeed pull became "royal's newest
 * run" and instantly aged out every directly-scraped Royal row. The two are
 * separate sweeps and need separate clocks. Lines are scraped independently and one can be re-run on its own
 * (`cruise-watch --lines virgin`), which under a single global cutoff would age
 * out every OTHER line's inventory at a stroke. Anchoring to the newest run
 * rather than the clock also means a scrape that fails or is late never empties
 * the site on a timer.
 *
 * The trade: if one line's scrape breaks, that line disappears from the site
 * after the next successful run of any line, rather than going quietly stale.
 * That is the intended failure — an empty line is noticeable, a seven-week-old
 * price is not.
 */
export const STALE_HOURS = 6;

/**
 * Has this line stopped returning this sailing? `cutoffs` maps a source to the
 * oldest `last_run_at` still current for it (epoch ms). A source with no run
 * recorded, or a row with an unparseable timestamp, is kept — the filter must
 * never empty the site off a missing value.
 */
/** The key a freshness cutoff is stored under: one sweep clock per line+source. */
export function freshnessKey(source: unknown, dataSource: unknown): string {
  return `${String(source ?? "")}|${String(dataSource ?? "direct")}`;
}

export function isStale(
  r: Record<string, unknown>,
  cutoffs: Map<string, number>,
): boolean {
  const cutoff = cutoffs.get(freshnessKey(r.source, r.data_source));
  if (cutoff === undefined) return false;
  const seen = typeof r.last_run_at === "string" ? Date.parse(r.last_run_at) : NaN;
  return Number.isFinite(seen) && seen < cutoff;
}

/** Display names for the six extractor keys. */
export const LINE_LABELS: Record<string, string> = {
  royal: "Royal Caribbean",
  celebrity: "Celebrity",
  ncl: "Norwegian",
  holland: "Holland America",
  msc: "MSC",
  virgin: "Virgin Voyages",
  princess: "Princess",
};

export function lineLabel(key: string): string {
  return LINE_LABELS[key] ?? key;
}
