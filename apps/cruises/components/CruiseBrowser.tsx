"use client";

import { useMemo, useState } from "react";
import {
  decodeSailings,
  lineLabel,
  type Sailing,
  type SailingIndex,
} from "@/lib/sailing-row";
import type { DeepLink } from "@/lib/deep-link";
import { FAVORITE_PORTS } from "@/lib/config";
import { setFavorite } from "@/lib/favorites";
import {
  DEFAULT_MAX_CABIN_PER_NIGHT,
  MONTH_LABELS,
  OCCUPANCY,
  PRICE_BANDS,
  REGIONS,
  regionForPort,
  type Region,
} from "@/lib/sailing-taxonomy";

// The whole site. The server hands down every future priced sailing in one
// dictionary-encoded payload (see lib/sailing-row.ts), so every filter, sort and
// search here is in-memory — no round-trip per keystroke or slider drag on a
// ~6,800-row list.
//
// Facet counts are computed against the OTHER filters, not the final result
// set: with Celebrity selected, the Royal Caribbean row still shows how many
// sailings you would get by switching to it. Counting against the final set
// would show 0 next to every unselected line, which reads as "no inventory"
// rather than "not currently selected".

const PAGE = 24;

// FAVORITE_PORTS (lib/config) are pinned to the top of the port filter, in the
// configured order. Names must match what normalizePort produces; two terminals
// serving one metro are two different ports, not two spellings of one.

type NightBand = { key: string; label: string; min: number; max: number };
const NIGHT_BANDS: NightBand[] = [
  { key: "2-4", label: "2–4", min: 2, max: 4 },
  { key: "5-7", label: "5–7", min: 5, max: 7 },
  { key: "8-14", label: "8–14", min: 8, max: 14 },
  { key: "15+", label: "15+", min: 15, max: 999 },
];

type SortKey = "pppn" | "price" | "depart" | "nights" | "nightsDesc" | "drop" | "changed";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "depart", label: "Departing soonest" },
  { key: "pppn", label: "Cheapest per night" },
  { key: "price", label: "Cheapest total" },
  { key: "nights", label: "Shortest trip" },
  { key: "nightsDesc", label: "Longest trip" },
  { key: "drop", label: "Biggest price drop" },
  { key: "changed", label: "Recently repriced" },
];

type Filters = {
  q: string;
  lines: string[];
  ports: string[];
  regions: string[];
  months: number[]; // 0-11
  years: number[];
  /**
   * Departure between `fromDate` and `toDate` ("YYYY-MM-DD", inclusive).
   * Either end may be left open: no `fromDate` is "leaves by the 20th", no
   * `toDate` is "leaves on or after the 3rd". Departure only — plain
   * "between" on the departure date, so a 14-night sailing leaving on the
   * 19th is in a 3rd–20th window even though it comes back in the next month.
   */
  fromDate: string | null;
  toDate: string | null;
  bands: string[];
  priceBands: string[];
  /** Ceiling on the cabin's nightly rate (2 people, balcony). */
  maxCabinPerNight: number | null;
  builtAfter: number | null;
  minRating: number | null;
  onlyMatch: boolean;
  onlyStarred: boolean;
  onlyDrops: boolean;
  onlyAtl: boolean;
  /**
   * Four answers, because there are genuinely four questions here and a
   * checkbox can only ask one of them:
   *   any      don't filter
   *   oneway   REPOSITIONING as the UI now calls it: ends in a different port
   *   round    round trips only, back where you started
   * Briefly had a fourth state for region-crossing sailings specifically;
   * it was collapsed — one label, one filter, and the region detail lives in
   * the badge's tooltip.
   */
  routeShape: "any" | "oneway" | "round";
};

/**
 * The view the user lands on. `onlyMatch` starts ON: the corpus is ~6,800
 * sailings and ~60 of them are ones the user could actually take — the plan filter is
 * the difference between a browsable page and a wall. "Clear filters" returns
 * HERE, not to an empty object, so clearing restores the useful default rather
 * than dumping all 6,800 rows on the page; unticking the box is how you get those.
 */
const DEFAULTS: Filters = {
  q: "",
  lines: [],
  ports: [],
  regions: [],
  months: [],
  years: [],
  fromDate: null,
  toDate: null,
  bands: [],
  priceBands: [],
  maxCabinPerNight: DEFAULT_MAX_CABIN_PER_NIGHT,
  builtAfter: null,
  minRating: null,
  onlyMatch: true,
  onlyStarred: false,
  onlyDrops: false,
  onlyAtl: false,
  routeShape: "any",
};

/** Which filter to ignore, so a facet can count what selecting it would give. */
type Facet = "lines" | "ports" | "regions" | "priceBands" | "months" | "years" | "routeShape" | null;

/** Sailing plus the derived fields the filters key on. */
type Row = Sailing & {
  region: Region;
  /**
   * Every port the sailing touches — where it leaves, each call, where it ends —
   * deduped. The port filter matches against this, not just the departure
   * port: "anything that stops in Lisbon" is the question, wherever it boards.
   */
  allPorts: string[];
  /**
   * A genuine repositioning cruise: one-way AND it changes cruising region.
   *
   * `oneWay` alone is far too broad — a Barcelona→Lisbon sailing ends in
   * another port but both ends are the Mediterranean, and the ship runs the
   * mirror image the following week. That is a one-way itinerary, not a
   * seasonal relocation. Requiring the two ends to sit in DIFFERENT known
   * regions is what separates "Galveston → Barcelona" (a real
   * transatlantic reposition) from "Barcelona → Lisbon" (a shuttle).
   *
   * Both regions must be known: two unmapped ports both resolve to "Other" and
   * would otherwise compare equal, and an unmapped port against a known one
   * would read as a region change on no evidence. Unknown means no claim.
   */
  repositioning: boolean;
  /** Where it ends, when that differs from where it starts. */
  endRegion: Region;
  month: number;
  year: number;
  /** What two people pay for the balcony cabin, whole sailing. */
  cabinTotal: number;
  /** ...and per night — THE price on this site: what every card leads with,
   *  every price filter cuts on, and both price sorts order by. A hotel quotes
   *  a room for a night; this is the number that compares to it. The
   *  per-person fares the lines publish (`price`, `pppn`) are kept for the
   *  secondary line only. */
  cabinPerNight: number;
};

/** Has this price gone unconfirmed long enough to be worth flagging? */
function stalePrice(lastSeen: string | null): boolean {
  if (!lastSeen) return true;
  const days = (Date.now() - Date.parse(lastSeen)) / 86_400_000;
  return Number.isFinite(days) && days >= 14;
}

function haystack(s: Row): string {
  // Every port on the route, not just the departure — "Nassau" is almost always
  // a call, so a departure-only haystack answered it with zero sailings.
  return `${s.ship} ${s.allPorts.join(" ")} ${lineLabel(s.line)} ${s.city ?? ""} ${s.depart}`.toLowerCase();
}

function passes(s: Row, f: Filters, terms: string[], skip: Facet, stars: Set<string>): boolean {
  // Reachability, not is_match: the label says "travel plan", and is_match also
  // folds in a $120/night ceiling and a ship-age rule that the price-band and
  // build-year filters beside it already express. See the is_reachable
  // migration — the strict flag is the EMAIL's definition, not the site's.
  if (f.onlyMatch && !s.isReachable) return false;
  if (f.onlyStarred && !stars.has(s.id)) return false;
  if (skip !== "routeShape" && f.routeShape !== "any") {
    if (f.routeShape === "round" && s.oneWay) return false;
    if (f.routeShape === "oneway" && !s.oneWay) return false;
  }
  if (f.onlyDrops && !(s.changePct !== null && s.changePct < 0)) return false;
  if (f.onlyAtl && !s.atl) return false;
  if (skip !== "lines" && f.lines.length && !f.lines.includes(s.line)) return false;
  if (skip !== "ports" && f.ports.length && !f.ports.some((p) => s.allPorts.includes(p))) return false;
  if (skip !== "regions" && f.regions.length && !f.regions.includes(s.region)) return false;
  // Month and year compose: "Dec" + "2026" is December 2026, "Dec" alone is
  // every December in the corpus, "2027" alone is all of 2027.
  if (skip !== "months" && f.months.length && !f.months.includes(s.month)) return false;
  if (skip !== "years" && f.years.length && !f.years.includes(s.year)) return false;
  // ISO dates compare correctly as strings.
  if (f.fromDate && s.depart < f.fromDate) return false;
  if (f.toDate && s.depart > f.toDate) return false;
  if (f.bands.length) {
    const band = NIGHT_BANDS.find((b) => f.bands.includes(b.key) && s.nights >= b.min && s.nights <= b.max);
    if (!band) return false;
  }
  if (skip !== "priceBands" && f.priceBands.length) {
    const band = PRICE_BANDS.find((b) => f.priceBands.includes(b.key) && s.cabinPerNight >= b.min && s.cabinPerNight < b.max);
    if (!band) return false;
  }
  // The cap and the bands are two controls over one number, and the cap is on by
  // default — so it silently emptied the upper bands: 1,085 live sailings sat in
  // the top band and the default $440 cap made every one of
  // them invisible, leaving the button reading 0 and DISABLED. Clicking it did
  // nothing: selecting a price filter didn't refresh the results. A band is the more specific ask, so it wins: selecting one
  // clears the cap (see `toggle`), and the band's own count is computed as if it
  // already had, so the number on the button predicts what the click will show.
  if (skip !== "priceBands" && f.maxCabinPerNight !== null && s.cabinPerNight > f.maxCabinPerNight) return false;
  if (f.builtAfter !== null && (s.built === null || s.built < f.builtAfter)) return false;
  // An unrated ship is filtered OUT here rather than kept: asking for 4.0+ and
  // getting ships with no rating at all would not be an answer to the question.
  if (f.minRating !== null && (s.rating === null || s.rating < f.minRating)) return false;
  if (terms.length) {
    const hay = haystack(s);
    for (const t of terms) if (!hay.includes(t)) return false;
  }
  return true;
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

const MONTHS = MONTH_LABELS;

/** "Dec 7 – 11, 2026", collapsing the month when both ends share it. */
function dateRange(depart: string, ret: string): string {
  const [dy, dm, dd] = depart.split("-").map(Number);
  const [ry, rm, rd] = ret.split("-").map(Number);
  const left = `${MONTHS[dm - 1]} ${dd}`;
  const right = dm === rm && dy === ry ? `${rd}` : `${MONTHS[rm - 1]} ${rd}`;
  return `${left} – ${right}, ${ry}`;
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

function longDate(iso: string): string {
  return `${shortDate(iso)}, ${iso.slice(0, 4)}`;
}

function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" />
    </svg>
  );
}
function StarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.6l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.45 6.19 20.5 7.3 14.03 2.6 9.45l6.5-.95L12 2.6z" />
    </svg>
  );
}
function PinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}

/** Waypoints on a line — the ports the sailing calls at between its ends. */
function RouteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
    </svg>
  );
}

/**
 * Turn an email's link into the state the browser starts in.
 *
 * A focused link (`?sailing=…`) starts from a CLEARED set, not from DEFAULTS:
 * the whole point of pointing at one sailing is that it shows up, and the
 * defaults — a $440/night cabin cap and the travel-plan filter — are exactly the
 * things liable to hide the sailing the email was excited about. A link that
 * lands on "no results" is worse than no link.
 */
function initialFilters(link: DeepLink): Filters {
  if (link.focusSailing) {
    return { ...DEFAULTS, maxCabinPerNight: null, onlyMatch: false, onlyStarred: false, priceBands: [], routeShape: "any" };
  }
  const f: Filters = { ...DEFAULTS };
  if (link.drops) f.onlyDrops = true;
  if (link.atl) f.onlyAtl = true;
  if (link.plan !== null) f.onlyMatch = link.plan;
  if (link.lines.length) f.lines = link.lines;
  if (link.ports.length) f.ports = link.ports;
  if (link.regions.length) f.regions = link.regions;
  if (link.months.length) f.months = link.months;
  if (link.years.length) f.years = link.years;
  if (link.q) f.q = link.q;
  if (link.maxCabinPerNight === "any") f.maxCabinPerNight = null;
  else if (typeof link.maxCabinPerNight === "number") f.maxCabinPerNight = link.maxCabinPerNight;
  // A bucket link means "show me these", so don't let the default price cap
  // silently drop the very drops the email just reported.
  if (link.drops || link.atl) f.maxCabinPerNight = null;
  return f;
}

export default function CruiseBrowser({
  index,
  link,
  favorites = [],
  email = "",
}: {
  index: SailingIndex;
  link?: DeepLink;
  /** Sailing ids this user has starred — the list the weekly email watches. */
  favorites?: string[];
  /** The signed-in user, needed to write a star back under RLS. */
  email?: string;
}) {
  const all: Row[] = useMemo(
    () =>
      decodeSailings(index).map((s) => ({
        ...s,
        region: regionForPort(s.port),
        allPorts: [...new Set([s.port, ...s.calls, ...(s.disembark ? [s.disembark] : [])].filter(Boolean))],
        endRegion: s.disembark ? regionForPort(s.disembark) : regionForPort(s.port),
        repositioning: (() => {
          if (!s.oneWay || !s.disembark) return false;
          const from = regionForPort(s.port);
          const to = regionForPort(s.disembark);
          // "Other" means the port is not in the region map, which is not
          // evidence of a region change — see the Row comment.
          if (from === "Other" || to === "Other") return false;
          return from !== to;
        })(),
        month: Number(s.depart.slice(5, 7)) - 1,
        year: Number(s.depart.slice(0, 4)),
        cabinTotal: s.price * OCCUPANCY,
        cabinPerNight: Math.round(((s.price * OCCUPANCY) / Math.max(s.nights, 1)) * 100) / 100,
      })),
    [index],
  );

  const [f, setF] = useState<Filters>(() => (link?.any ? initialFilters(link) : DEFAULTS));
  // A link from the email naming one sailing (?sailing=…) pins the view to it.
  const [focusId, setFocusId] = useState<string | null>(link?.focusSailing ?? null);
  // Departure date, not price: with the plan filter on by default the list is
  // already the affordable subset, so the question left is "when", and a
  // chronological list is one you can read against a calendar. An email link
  // may override it.
  const [sort, setSort] = useState<SortKey>(() => {
    const s = link?.sort;
    return s && SORTS.some((x) => x.key === s) ? (s as SortKey) : "depart";
  });
  const [shown, setShown] = useState(PAGE);
  // Held locally and toggled optimistically — a star must feel instant, and the
  // Supabase write settles behind it. On a failed write the star reverts, which
  // is the honest outcome: it is a watchlist the email acts on, so silently
  // keeping a star that was never saved would mean silently not watching it.
  const [stars, setStars] = useState<Set<string>>(() => new Set(favorites));
  const [starError, setStarError] = useState<string | null>(null);

  async function toggleStar(id: string) {
    const on = !stars.has(id);
    setStars((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
    setStarError(null);
    const ok = await setFavorite(id, email, on);
    if (!ok) {
      setStars((prev) => {
        const next = new Set(prev);
        if (on) next.delete(id); else next.add(id);
        return next;
      });
      setStarError(on ? "Could not save that star — it is not being watched." : "Could not remove that star.");
    }
  }
  const [railOpen, setRailOpen] = useState(false);
  const [allPorts, setAllPorts] = useState(false);
  const [portQ, setPortQ] = useState("");

  const minBuilt = useMemo(() => {
    let lo = 9999;
    for (const s of all) if (s.built !== null && s.built < lo) lo = s.built;
    return lo === 9999 ? 2000 : lo;
  }, [all]);
  const maxBuilt = useMemo(() => {
    let hi = 0;
    for (const s of all) if (s.built !== null && s.built > hi) hi = s.built;
    return hi || new Date().getFullYear();
  }, [all]);

  const years = useMemo(
    () => [...new Set(all.map((s) => s.year))].sort((a, b) => a - b),
    [all],
  );

  const terms = useMemo(() => f.q.toLowerCase().split(/\s+/).filter(Boolean), [f.q]);

  const results = useMemo(() => {
    // A focused link short-circuits every filter — it names one sailing.
    if (focusId) return all.filter((s) => s.id === focusId);
    const out = all.filter((s) => passes(s, f, terms, null, stars));
    const byDepart = (a: Row, b: Row) => (a.depart < b.depart ? -1 : a.depart > b.depart ? 1 : 0);
    const cmp: Record<SortKey, (a: Row, b: Row) => number> = {
      pppn: (a, b) => a.cabinPerNight - b.cabinPerNight,
      price: (a, b) => a.cabinTotal - b.cabinTotal,
      depart: byDepart,
      nights: (a, b) => a.nights - b.nights,
      nightsDesc: (a, b) => b.nights - a.nights,
      // Sailings that never moved sort last rather than mixing into the drops.
      drop: (a, b) => (a.changePct ?? 1e9) - (b.changePct ?? 1e9),
      changed: (a, b) => (b.changedAt ?? "").localeCompare(a.changedAt ?? ""),
    };
    // Departure date breaks every tie, so equal prices or lengths still read
    // chronologically rather than in database order.
    return out.sort((a, b) => cmp[sort](a, b) || byDepart(a, b));
  }, [all, f, terms, sort, focusId, stars]);

  // One pass per facet, each ignoring its own filter — see the header comment.
  const facets = useMemo(() => {
    const lines = new Map<string, number>();
    const ports = new Map<string, number>();
    const regions = new Map<string, number>();
    const priceBands = new Map<string, number>();
    const months = new Map<number, number>();
    const yearC = new Map<number, number>();
    const bump = <K,>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);

    for (const s of all) {
      if (passes(s, f, terms, "lines", stars)) bump(lines, s.line);
      if (passes(s, f, terms, "ports", stars)) for (const p of s.allPorts) bump(ports, p);
      if (passes(s, f, terms, "regions", stars)) bump(regions, s.region);
      if (passes(s, f, terms, "months", stars)) bump(months, s.month);
      if (passes(s, f, terms, "years", stars)) bump(yearC, s.year);
      if (passes(s, f, terms, "priceBands", stars)) {
        const b = PRICE_BANDS.find((x) => s.cabinPerNight >= x.min && s.cabinPerNight < x.max);
        if (b) bump(priceBands, b.key);
      }
    }
    // Counted with the repositioning filter itself ignored, so each option
    // says what choosing it would give rather than what is on screen now.
    let oneway = 0;
    let repo = 0;
    let round = 0;
    for (const s of all) {
      if (!passes(s, f, terms, "routeShape", stars)) continue;
      if (s.oneWay) { oneway++; if (s.repositioning) repo++; } else round++;
    }
    return { lines, ports, regions, priceBands, months, years: yearC, oneway, repo, round };
  }, [all, f, terms, stars]);

  const allLines = useMemo(
    () => [...index.lines].sort((a, b) => lineLabel(a).localeCompare(lineLabel(b))),
    [index.lines],
  );
  // The configured home ports come first by name, then everything else by
  // inventory. Volume alone nearly gets there — home ports are often the
  // biggest anyway — but "nearly" moves them around as inventory shifts, and
  // these are the ones the user actually sails from.
  //
  // The list is every port any sailing touches (departures, calls and
  // disembarkations), since the filter matches a port anywhere on the route.
  const portsByVolume = useMemo(
    () => {
      const rank = (p: string) => {
        const i = FAVORITE_PORTS.indexOf(p);
        return i === -1 ? FAVORITE_PORTS.length : i;
      };
      return [...new Set([...index.ports, ...index.callPorts])].filter(Boolean).sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (facets.ports.get(b) ?? 0) - (facets.ports.get(a) ?? 0) ||
          a.localeCompare(b),
      );
    },
    [index.ports, index.callPorts, facets.ports],
  );
  // Several hundred ports, so the list gets its own find box. Selected ports
  // stay listed whatever is typed, so one can always be unticked.
  const portList = useMemo(() => {
    const q = portQ.trim().toLowerCase();
    if (q) return portsByVolume.filter((p) => f.ports.includes(p) || p.toLowerCase().includes(q));
    if (allPorts) return portsByVolume;
    const top = portsByVolume.slice(0, 8);
    return [...top, ...f.ports.filter((p) => !top.includes(p))];
  }, [portsByVolume, portQ, allPorts, f.ports]);
  const visibleRegions = useMemo(
    () => REGIONS.filter((r) => (facets.regions.get(r) ?? 0) > 0 || f.regions.includes(r)),
    [facets.regions, f.regions],
  );

  const matchCount = useMemo(() => all.filter((s) => s.isReachable).length, [all]);
  const dropCount = useMemo(() => all.filter((s) => s.changePct !== null && s.changePct < 0).length, [all]);
  const atlCount = useMemo(() => all.filter((s) => s.atl).length, [all]);

  function set<K extends keyof Filters>(key: K, value: Filters[K]) {
    setF((prev) => ({ ...prev, [key]: value }));
    setShown(PAGE);
  }
  function toggle<K extends keyof Filters>(key: K, value: Filters[K] extends (infer T)[] ? T : never) {
    setF((prev) => {
      const cur = prev[key] as unknown[];
      const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
      const out = { ...prev, [key]: next as Filters[K] };
      // Turning ON a price band lifts the max-cabin cap — the two controls
      // overlap and the cap is on by default, so without this an explicit ask
      // for "$300+" is answered with nothing. Clearing it rather than quietly
      // overriding keeps the panel honest: the slider visibly reads "Any".
      if (key === "priceBands" && next.length > cur.length) out.maxCabinPerNight = null;
      return out;
    });
    setShown(PAGE);
  }

  const activeCount =
    f.lines.length + f.ports.length + f.regions.length + f.months.length + f.years.length +
    f.bands.length + f.priceBands.length +
    (f.builtAfter !== null ? 1 : 0) + (f.minRating !== null ? 1 : 0) +
    (f.maxCabinPerNight !== null ? 1 : 0) +
    (f.onlyMatch ? 1 : 0) + (f.onlyStarred ? 1 : 0) + (f.onlyDrops ? 1 : 0) + (f.onlyAtl ? 1 : 0) +
    (f.routeShape === "any" ? 0 : 1) +
    (f.fromDate ? 1 : 0) + (f.toDate ? 1 : 0);
  // Every filter currently narrowing the list, as a removable chip above the
  // results. The rail is closed on a phone and scrolled away on a desktop, so
  // without this a short list gives no hint WHY it is short — including the two
  // filters that are on by default (travel plan and the per-night cap).
  const ROUTE_LABEL = { round: "Round trip", oneway: "Repositioning" } as const;
  const activeChips: { key: string; label: string; clear: () => void }[] = [];
  const chip = (key: string, label: string, patch: Partial<Filters>) =>
    activeChips.push({ key, label, clear: () => { setF((prev) => ({ ...prev, ...patch })); setShown(PAGE); } });
  const without = <T,>(arr: T[], v: T) => arr.filter((x) => x !== v);
  if (f.q.trim()) chip("q", `“${f.q.trim()}”`, { q: "" });
  if (f.onlyStarred) chip("starred", "Starred", { onlyStarred: false });
  if (f.onlyMatch) chip("match", "Where I’ll be", { onlyMatch: false });
  if (f.onlyDrops) chip("drops", "Price dropped", { onlyDrops: false });
  if (f.onlyAtl) chip("atl", "Lowest ever", { onlyAtl: false });
  if (f.routeShape !== "any") chip("route", ROUTE_LABEL[f.routeShape], { routeShape: "any" });
  if (f.fromDate || f.toDate) {
    const label = f.fromDate && f.toDate
      ? `Departs ${longDate(f.fromDate)} – ${longDate(f.toDate)}`
      : f.fromDate ? `Departs on/after ${longDate(f.fromDate)}` : `Departs by ${longDate(f.toDate!)}`;
    chip("dates", label, { fromDate: null, toDate: null });
  }
  for (const m of f.months) chip(`m${m}`, MONTHS[m], { months: without(f.months, m) });
  for (const y of f.years) chip(`y${y}`, String(y), { years: without(f.years, y) });
  for (const r of f.regions) chip(`r${r}`, r, { regions: without(f.regions, r) });
  for (const p of f.ports) chip(`p${p}`, `Port: ${p}`, { ports: without(f.ports, p) });
  for (const l of f.lines) chip(`l${l}`, lineLabel(l), { lines: without(f.lines, l) });
  for (const b of f.bands) {
    const band = NIGHT_BANDS.find((x) => x.key === b);
    chip(`n${b}`, `${band?.label ?? b} nights`, { bands: without(f.bands, b) });
  }
  for (const b of f.priceBands) {
    const band = PRICE_BANDS.find((x) => x.key === b);
    chip(`pb${b}`, `${band?.label ?? b} / night`, { priceBands: without(f.priceBands, b) });
  }
  if (f.maxCabinPerNight !== null) chip("cap", `≤ ${money(f.maxCabinPerNight)} / night`, { maxCabinPerNight: null });
  if (f.minRating !== null) chip("rating", `Rated ${f.minRating.toFixed(1)}+`, { minRating: null });
  if (f.builtAfter !== null) chip("built", `Built ${f.builtAfter}+`, { builtAfter: null });

  // Show the reset link only once the view differs from the landing view;
  // the badge still counts plan-match, because on a phone the rail is closed
  // and "61 of 6,773" needs an explanation the user can see.
  const dirty = JSON.stringify(f) !== JSON.stringify(DEFAULTS);

  return (
    <>
      {starError && <div className="starerr" role="status">{starError}</div>}
      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="Search ship, port of call, line…"
          value={f.q}
          onChange={(e) => set("q", e.target.value)}
          aria-label="Search sailings"
        />
        <select
          className="sortsel"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Sort by"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
        <button className="filters-toggle" onClick={() => setRailOpen((v) => !v)}>
          {railOpen ? "Hide filters" : "Filters"}
          {activeCount > 0 && <span className="pill">{activeCount}</span>}
        </button>
        <div className="count">
          <b>{results.length.toLocaleString("en-US")}</b> of {all.length.toLocaleString("en-US")} sailings
          {dirty && (
            <>
              {" · "}
              <button className="linkbtn" onClick={() => { setF(DEFAULTS); setFocusId(null); setShown(PAGE); }}>
                reset filters
              </button>
            </>
          )}
        </div>
      </div>

      {focusId && (
        <div className="focusbar">
          {results.length > 0
            ? "Showing the one sailing your email linked to."
            : "That sailing is no longer in the current scan — it may have sold out or been repriced."}
          <button className="linkbtn" onClick={() => { setFocusId(null); setF(DEFAULTS); setShown(PAGE); }}>
            browse everything
          </button>
        </div>
      )}

      {!focusId && activeChips.length > 0 && (
        <div className="activebar" aria-label="Active filters">
          <span className="activelbl">Filtered by</span>
          {activeChips.map((c) => (
            <button key={c.key} type="button" className="activechip" onClick={c.clear} title="Remove this filter">
              {c.label}<span aria-hidden="true">×</span>
              <span className="sr">remove</span>
            </button>
          ))}
        </div>
      )}

      <div className="split">
        <aside className={`rail${railOpen ? " open" : ""}`}>
          <div className="fgroup">
            <h3 className={f.onlyStarred || f.onlyMatch || f.onlyDrops || f.onlyAtl || f.routeShape !== "any" ? "on" : undefined}>Highlights</h3>
            <label className="frow">
              <input type="checkbox" checked={f.onlyStarred} onChange={(e) => set("onlyStarred", e.target.checked)} />
              <span className="lbl">Starred</span>
              <span className="n">{stars.size}</span>
            </label>
            <label className="frow">
              <input type="checkbox" checked={f.onlyMatch} onChange={(e) => set("onlyMatch", e.target.checked)} />
              <span className="lbl">Where I&apos;ll be</span>
              <span className="n">{matchCount}</span>
            </label>
            <label className="frow">
              <input type="checkbox" checked={f.onlyDrops} onChange={(e) => set("onlyDrops", e.target.checked)} />
              <span className="lbl">Price dropped</span>
              <span className="n">{dropCount}</span>
            </label>
            <label className="frow">
              <input type="checkbox" checked={f.onlyAtl} onChange={(e) => set("onlyAtl", e.target.checked)} />
              <span className="lbl">At its lowest ever</span>
              <span className="n">{atlCount}</span>
            </label>
            <div className="trirow">
              <span className="trilbl">Route</span>
              <div className="tri">
                {([
                  ["any", "Any", null, "Don\u2019t filter on the shape of the route"],
                  ["round", "Round trip", "round", "Comes back to the port it left from"],
                  ["oneway", "Repositioning", "oneway", "Ends in a different port — you fly home from the far end"],
                ] as const).map(([key, label, countKey, tip]) => (
                  <button
                    key={key}
                    type="button"
                    className="chipbtn"
                    aria-pressed={f.routeShape === key}
                    onClick={() => set("routeShape", key)}
                    title={tip}
                  >
                    {label}
                    {countKey && <span className="cn">{facets[countKey]}</span>}
                  </button>
                ))}
              </div>
              <p className="hint">
                Repositioning means the sailing ends somewhere other than it started — you fly home
                from the far end.
              </p>
            </div>
          </div>

          <div className="fgroup">
            <h3 className={f.fromDate || f.toDate ? "on" : undefined}>Departure date</h3>
            <div className="daterow">
              <label>
                <span>From</span>
                <input
                  type="date"
                  value={f.fromDate ?? ""}
                  max={f.toDate ?? undefined}
                  onChange={(e) => set("fromDate", e.target.value || null)}
                />
              </label>
              <label>
                <span>To</span>
                <input
                  type="date"
                  value={f.toDate ?? ""}
                  min={f.fromDate ?? undefined}
                  onChange={(e) => set("toDate", e.target.value || null)}
                />
              </label>
            </div>
            {(f.fromDate || f.toDate) && (
              <button className="linkbtn" onClick={() => setF((prev) => ({ ...prev, fromDate: null, toDate: null }))}>
                clear dates
              </button>
            )}
            <p className="hint">Departs between the two dates. Leave either one empty for an open end.</p>
          </div>

          <div className="fgroup">
            <h3 className={f.months.length || f.years.length ? "on" : undefined}>Departure month</h3>
            <div className="chips">
              {MONTHS.map((m, i) => {
                const n = facets.months.get(i) ?? 0;
                return (
                  <button
                    key={m}
                    className="chipbtn"
                    aria-pressed={f.months.includes(i)}
                    disabled={n === 0 && !f.months.includes(i)}
                    onClick={() => toggle("months", i)}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
            <div className="chips" style={{ marginTop: 8 }}>
              {years.map((y) => {
                const n = facets.years.get(y) ?? 0;
                return (
                  <button
                    key={y}
                    className="chipbtn year"
                    aria-pressed={f.years.includes(y)}
                    disabled={n === 0 && !f.years.includes(y)}
                    onClick={() => toggle("years", y)}
                  >
                    {y} <span className="cn">{n}</span>
                  </button>
                );
              })}
            </div>
            <p className="hint">Month and year combine — “Dec” + “2026” is that December; either alone is every one.</p>
          </div>

          <div className="fgroup">
            <h3 className={f.regions.length ? "on" : undefined}>Region</h3>
            {visibleRegions.map((r) => (
              <label key={r} className={`frow${(facets.regions.get(r) ?? 0) === 0 ? " off" : ""}`}>
                <input type="checkbox" checked={f.regions.includes(r)} onChange={() => toggle("regions", r)} />
                <span className="lbl">{r}</span>
                <span className="n">{facets.regions.get(r) ?? 0}</span>
              </label>
            ))}
            <p className="hint">Derived from the departure port — the lines don’t publish an itinerary region.</p>
          </div>

          <div className="fgroup">
            <h3 className={f.maxCabinPerNight !== null ? "on" : undefined}>Max per night</h3>
            <div className="range">
              <input
                type="range"
                min={100}
                max={1200}
                step={20}
                value={f.maxCabinPerNight ?? 1200}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  set("maxCabinPerNight", v >= 1200 ? null : v);
                }}
                aria-label="Maximum cabin price per night"
              />
              <span className="val">
                {f.maxCabinPerNight === null ? "Any" : `\u2264 ${money(f.maxCabinPerNight)}`}
              </span>
            </div>
            <p className="hint">Two people in a balcony cabin — the same number the cards lead with.</p>
          </div>

          <div className="fgroup">
            <h3 className={f.priceBands.length ? "on" : undefined}>Price per night · balcony for 2</h3>
            <div className="stack">
              {PRICE_BANDS.map((b) => {
                const n = facets.priceBands.get(b.key) ?? 0;
                return (
                  <button
                    key={b.key}
                    className="chipbtn wide"
                    aria-pressed={f.priceBands.includes(b.key)}
                    disabled={n === 0 && !f.priceBands.includes(b.key)}
                    onClick={() => toggle("priceBands", b.key)}
                  >
                    <span>{b.label}</span>
                    <span className="cn">{n}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="fgroup">
            <h3 className={f.lines.length ? "on" : undefined}>Cruise line</h3>
            {allLines.map((l) => {
              const n = facets.lines.get(l) ?? 0;
              return (
                <label key={l} className={`frow${n === 0 ? " off" : ""}`}>
                  <input type="checkbox" checked={f.lines.includes(l)} onChange={() => toggle("lines", l)} />
                  <span className="lbl">{lineLabel(l)}</span>
                  <span className="n">{n}</span>
                </label>
              );
            })}
          </div>

          <div className="fgroup">
            <h3 className={f.bands.length ? "on" : undefined}>Nights</h3>
            <div className="chips">
              {NIGHT_BANDS.map((b) => (
                <button
                  key={b.key}
                  className="chipbtn"
                  aria-pressed={f.bands.includes(b.key)}
                  onClick={() => toggle("bands", b.key)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>

          <div className="fgroup">
            <h3 className={f.ports.length ? "on" : undefined}>Port</h3>
            <input
              className="portq"
              type="search"
              placeholder="Find a port…"
              value={portQ}
              onChange={(e) => setPortQ(e.target.value)}
              aria-label="Find a port"
            />
            <div className="stack tight">
              {portList.map((p) => {
                const n = facets.ports.get(p) ?? 0;
                return (
                  <label key={p} className={`frow${n === 0 ? " off" : ""}`}>
                    <input type="checkbox" checked={f.ports.includes(p)} onChange={() => toggle("ports", p)} />
                    <span className="lbl" title={p}>{p}</span>
                    <span className="n">{n}</span>
                  </label>
                );
              })}
            </div>
            {portQ.trim() && portList.length === 0 && <p className="hint">No port by that name.</p>}
            {!portQ.trim() && portsByVolume.length > 8 && (
              <button className="linkbtn" style={{ marginTop: 8 }} onClick={() => setAllPorts((v) => !v)}>
                {allPorts ? "Show fewer" : `Show all ${portsByVolume.length} ports`}
              </button>
            )}
            <p className="hint">Matches a sailing that leaves from, stops at, or ends in any ticked port.</p>
          </div>

          <div className="fgroup">
            <h3 className={f.minRating !== null ? "on" : undefined}>Cruise Critic rating</h3>
            <div className="chips">
              {[3.5, 4, 4.5].map((r) => (
                <button
                  key={r}
                  className="chipbtn"
                  aria-pressed={f.minRating === r}
                  onClick={() => set("minRating", f.minRating === r ? null : r)}
                >
                  {r.toFixed(1)}+
                </button>
              ))}
            </div>
            <p className="hint">Member rating out of 5. Ships with no rating are hidden while this is on.</p>
          </div>

          <div className="fgroup">
            <h3 className={f.builtAfter !== null ? "on" : undefined}>Ship built from</h3>
            <div className="range">
              <input
                type="range"
                min={minBuilt}
                max={maxBuilt}
                step={1}
                value={f.builtAfter ?? minBuilt}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  set("builtAfter", v <= minBuilt ? null : v);
                }}
                aria-label="Earliest ship build year"
              />
              <span className="val">{f.builtAfter === null ? "Any" : f.builtAfter}</span>
            </div>
          </div>
        </aside>

        <section>
          {results.length === 0 ? (
            <div className="empty-state">
              <b>Nothing matches those filters.</b>
              {f.onlyMatch
                ? "Only sailings matching your travel plan are shown — untick that to see everything."
                : dirty
                  ? "Try widening the price band or the months."
                  : "The weekly scan found no priced sailings."}
            </div>
          ) : (
            <>
              <div className="cards">
                {results.slice(0, shown).map((s) => (
                  <SailingCard key={s.id} s={s} starred={stars.has(s.id)} onStar={() => toggleStar(s.id)} />
                ))}
              </div>
              {shown < results.length && (
                <button className="more" onClick={() => setShown((n) => n + PAGE * 2)}>
                  Show more — {(results.length - shown).toLocaleString("en-US")} remaining
                </button>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}

function SailingCard({ s, starred, onStar }: { s: Row; starred: boolean; onStar: () => void }) {
  const dropped = s.changePct !== null && s.changePct < 0;
  const rose = s.changePct !== null && s.changePct > 0;

  return (
    <article className={`card${s.isReachable ? " match" : ""}`}>
      <div className="hero">
        {s.hero ? (
          // eslint-disable-next-line @next/next/no-img-element -- the lines' own
          // CDNs already serve these sized; next/image would proxy thousands of
          // distinct billable URLs for a two-person site.
          <img src={s.hero} alt="" loading="lazy" decoding="async" />
        ) : (
          <div className="hero-fallback" aria-hidden="true">🚢</div>
        )}
        {s.isReachable && (
          <span className="badge match hero-badge">
            Plan match{s.city ? ` · ${s.city}` : ""}
          </span>
        )}
        <span className="hero-line">{lineLabel(s.line)}</span>
        {/* The watchlist control. A starred sailing is what the weekly email
            actually monitors, so the label says that rather than "favorite" —
            it is a promise about what happens next, not a decoration. */}
        <button
          type="button"
          className={`star${starred ? " on" : ""}`}
          onClick={onStar}
          aria-pressed={starred}
          title={starred ? "Watched — you'll be emailed on a 10% drop or a new promotion" : "Watch this sailing for price drops"}
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill={starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3.2l2.7 5.5 6.1.9-4.4 4.3 1.04 6.05L12 17.1l-5.44 2.85L7.6 13.9 3.2 9.6l6.1-.9L12 3.2z" />
          </svg>
          <span className="sr">{starred ? "Watched" : "Watch for price drops"}</span>
        </button>
      </div>

      <div className="body">
        <h2>{s.ship}</h2>
        <div className="sub">
          {lineLabel(s.line)}
          {s.built !== null && ` · built ${s.built}`}
        </div>

        {s.rating !== null && (
          <div className="rating" title={`Cruise Critic member rating${s.reviews ? ` from ${s.reviews.toLocaleString("en-US")} reviews` : ""}`}>
            <span className="stars" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className={i < Math.round(s.rating!) ? "on" : ""}><StarIcon /></span>
              ))}
            </span>
            <b>{s.rating!.toFixed(1)}</b>
            {s.reviews !== null && <span className="rc">{s.reviews.toLocaleString("en-US")} reviews</span>}
          </div>
        )}

        <div className="facts">
          <div className="fact"><CalendarIcon />{dateRange(s.depart, s.ret)} · {s.nights} night{s.nights === 1 ? "" : "s"}</div>
          {/* The route, not just the departure port: a one-way sailing ends
              somewhere else and that is the single most decision-changing fact
              on the card, so it sits on the same line as where it leaves. */}
          <div className="fact">
            <PinIcon />
            {s.oneWay ? `${s.port} → ${s.disembark}` : s.port}
          </div>
          {s.calls.length > 0 && (
            <div className="fact ports" title={s.callsOrdered ? undefined : "This line publishes the ports but not their order"}>
              <RouteIcon />
              <span>{s.calls.join(s.callsOrdered ? " → " : " · ")}</span>
            </div>
          )}
        </div>

        <div className="price">
          <span className="pn">{money(s.cabinPerNight)}</span>
          <span className="per">
            / night for 2{s.taxIncl === true ? ", taxes incl." : s.taxIncl === false ? " + taxes" : ""}
          </span>
        </div>
        <div className="total">
          {money(s.cabinTotal)} for the cabin · {money(s.price)} per person
        </div>
        {/* The site shows the whole database, not just the latest sweep, so a
            price that has not been re-confirmed lately says so rather than the
            sailing quietly disappearing. */}
        {stalePrice(s.lastSeen) && (
          <div className="asof" title="This price has not been re-confirmed in the last two weeks">
            price last checked {shortDate(s.lastSeen!)}
          </div>
        )}

        {(dropped || rose || s.atl || s.oneWay) && (
          <div className="badges">
            {/* ONE label: anything ending in a different port is Repositioning
                (one way and repositioning are the same thing to the reader);
                the region-crossing distinction survives only as tooltip detail,
                where it adds nuance without asking the reader to hold two
                badges in mind. */}
            {s.oneWay && (
              <span
                className="badge repo"
                title={
                  s.repositioning
                    ? `Ends in ${s.disembark}, not ${s.port} — and crosses from ${s.region} to ${s.endRegion}. You fly home from the far end.`
                    : `Ends in ${s.disembark}, not ${s.port} — you fly home from the far end.`
                }
              >
                Repositioning
              </span>
            )}
            {dropped && (
              <span className="badge drop">
                ▼ {Math.abs(Math.round(s.changePct!))}%
                {s.prevPrice !== null && ` from ${money(s.prevPrice)}`}
                {s.changedAt && ` · ${shortDate(s.changedAt)}`}
              </span>
            )}
            {rose && (
              <span className="badge rise">
                ▲ {Math.round(s.changePct!)}%{s.changedAt && ` · ${shortDate(s.changedAt)}`}
              </span>
            )}
            {s.atl && <span className="badge atl">Lowest ever</span>}
          </div>
        )}

        {s.book && (
          <div className="actions">
            <a className="book" href={s.book} target="_blank" rel="noopener noreferrer">
              Book on {lineLabel(s.line)}
            </a>
          </div>
        )}
      </div>
    </article>
  );
}
