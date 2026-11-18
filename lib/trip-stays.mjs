// trip-stays.mjs — turn the travel timeline (travel_segments rows) into the
// ordered list of STAYS the trip actually makes, and match each stay to its
// area guide (trip_reservoirs row).
//
// Shared, pure, no I/O. Two callers load the rows and hand them in:
//   - the travel-guide site (apps/itin, which carries a byte-for-byte copy at
//     apps/itin/lib/trip-stays.mjs — tests/app-sites.test.mjs holds them equal)
//     builds its location ribbon from it, live, on every page load;
//   - lib/reservoir-dates.js (the nightly trip-reservoir-mark-done pass) writes
//     each guide's dates from it.
//
// Why stays and not one range per metro (the old reservoir-dates rule): a trip
// visits a place more than once (home → city B → home → abroad → home, or a
// loop out of a gateway city and back to it), and segments overlap — a flights
// "destination" row spans arrival to final departure (the gateway's row covers
// the whole loop), with the real legs as manual/lodging rows inside it.
// Widening one range per metro gave the gateway one three-week range and hid
// every stop in between.
//
// Overlap rule — the same one lib/presence.js resolvePresenceAt() uses for
// "where is the user at T": among the segments covering T, the most specific
// wins = the latest to have started, with source=manual breaking exact ties.

/** Shortest stay worth a chip: drops layovers and the hour-long slivers a
 *  coarse flights row shows between two manual legs. */
export const MIN_STAY_HOURS = 12;

function ms(ts) {
  const v = Date.parse(ts);
  return Number.isNaN(v) ? null : v;
}

/** YYYY-MM-DD of an instant in an IANA zone (UTC when tz is empty). */
export function localDate(msValue, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC" }).format(new Date(msValue));
}

/**
 * Resolve overlapping timeline segments into non-overlapping stays.
 *
 * @param {Array<{metro:string, source?:string|null, arrive_at:string, depart_at?:string|null}>} segments
 * @param {{tz?: string, minStayHours?: number}} [opts]
 * @returns {Array<{metro:string, startMs:number, endMs:number|null, start:string, end:string|null}>}
 *   ordered by start; `end`/`endMs` null = open-ended (no departure yet).
 *   `start`/`end` are local dates (YYYY-MM-DD) in `tz`.
 */
export function resolveStays(segments, opts = {}) {
  const tz = opts.tz || "UTC";
  const minMs = (opts.minStayHours ?? MIN_STAY_HOURS) * 3600000;

  const segs = [];
  for (const s of segments || []) {
    if (!s || !s.metro) continue;
    const a = ms(s.arrive_at);
    if (a == null) continue;
    const d = s.depart_at ? ms(s.depart_at) : null;
    segs.push({ metro: s.metro, manual: s.source === "manual", a, d: d == null ? Infinity : d });
  }
  if (!segs.length) return [];

  // Every instant where the winner can change.
  const cuts = [...new Set(segs.flatMap((s) => (Number.isFinite(s.d) ? [s.a, s.d] : [s.a])))].sort((x, y) => x - y);

  const winnerAt = (t) => {
    let best = null;
    for (const s of segs) {
      if (!(s.a <= t && t < s.d)) continue;
      if (!best || s.a > best.a || (s.a === best.a && s.manual && !best.manual)) best = s;
    }
    return best;
  };

  // Walk the intervals between cuts; the last one runs open-ended.
  const pieces = [];
  for (let i = 0; i < cuts.length; i++) {
    const from = cuts[i];
    const to = i + 1 < cuts.length ? cuts[i + 1] : Infinity;
    const w = winnerAt(from);
    const metro = w ? w.metro : null;
    const last = pieces[pieces.length - 1];
    if (last && last.metro === metro && last.to === from) last.to = to;
    else pieces.push({ metro, from, to });
  }

  // Drop gaps, transit and slivers, then join what the drop left adjacent.
  const kept = pieces.filter(
    (p) => p.metro && p.metro !== "transit" && (!Number.isFinite(p.to) || p.to - p.from >= minMs),
  );
  const joined = [];
  for (const p of kept) {
    const last = joined[joined.length - 1];
    if (last && last.metro === p.metro) last.to = Math.max(last.to, p.to);
    else joined.push({ ...p });
  }
  const stays = joined.map((p) => ({
    metro: p.metro,
    startMs: p.from,
    endMs: Number.isFinite(p.to) ? p.to : null,
    start: localDate(p.from, tz),
    end: Number.isFinite(p.to) ? localDate(p.to, tz) : null,
  }));

  // Dates are in one zone (the home zone), so a departure late at night there
  // (a morning flight out of a city twelve hours ahead lands on the evening
  // before at home) would end
  // a stay a day before the trip's own plan says. When the next stay starts
  // within a day of this one ending, the travel day is one continuous move:
  // end this stay on the date the next one starts.
  for (let i = 0; i + 1 < stays.length; i++) {
    const cur = stays[i], next = stays[i + 1];
    if (cur.endMs != null && next.startMs - cur.endMs <= 24 * 3600000 && next.start > cur.end) {
      cur.end = next.start;
    }
  }
  return stays;
}

/**
 * The guide (reservoir area key) a timeline metro belongs to, or null.
 * Exact key first ("hong_kong"); else a combined guide whose key carries the
 * metro as whole "_"-separated words ("city_a_city_b" covers both "city_a"
 * and "city_b" — the guide for a stay that is one of two cities).
 */
export function guideFor(metro, areaKeys) {
  if (!metro) return null;
  const keys = [...(areaKeys || [])];
  if (keys.includes(metro)) return metro;
  const needle = `_${metro}_`;
  return keys.find((k) => `_${k}_`.includes(needle)) || null;
}

/** "san_jose" → "San Jose", "abc" → "ABC" (a short slug is an acronym). */
export function prettyMetro(metro) {
  const words = String(metro || "").split("_").filter(Boolean);
  if (words.length === 1 && words[0].length <= 3) return words[0].toUpperCase();
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * The location ribbon: every stay on the timeline plus every guide the timeline
 * doesn't cover (a cruise port, a trip whose rows were pruned), in date order.
 *
 * @param {ReturnType<typeof resolveStays>} stays
 * @param {Array<{area:string, label:string, date_range?: {start?:string,end?:string,from?:string,to?:string}|null}>} guides
 * @param {string} today YYYY-MM-DD in the site's zone
 * @returns {Array<{key:string, area:string, label:string, start:string|null, end:string|null, hasGuide:boolean, past:boolean}>}
 */
export function ribbonItems(stays, guides, today) {
  const byArea = new Map((guides || []).map((g) => [g.area, g]));
  const keys = [...byArea.keys()];
  const covered = new Set();
  const items = [];

  for (const s of stays || []) {
    const area = guideFor(s.metro, keys);
    const past = s.end != null && s.end < today;
    // A past stop with no guide is history with nothing to open — leave it off.
    if (!area && past) continue;
    if (area) covered.add(area);
    const g = area ? byArea.get(area) : null;
    items.push({
      key: `${s.metro}:${s.start}`,
      area: area || s.metro,
      // An exact guide names itself; a stay inside a combined guide (one city
      // of a two-city guide) and a stay with no guide yet name the city.
      label: g && area === s.metro ? g.label : prettyMetro(s.metro),
      start: s.start,
      end: s.end,
      hasGuide: !!g,
      past,
    });
  }

  for (const g of guides || []) {
    if (covered.has(g.area)) continue;
    const r = g.date_range || {};
    const start = r.start || r.from || null;
    const end = r.end || r.to || start;
    items.push({
      key: `${g.area}:${start || "undated"}`,
      area: g.area,
      label: g.label,
      start,
      end,
      hasGuide: true,
      past: !!end && end < today,
    });
  }

  // Undated guides go last; ties keep the timeline's own order.
  return items
    .map((it, i) => ({ it, i }))
    .sort((x, y) => {
      const a = x.it.start, b = y.it.start;
      if (a && b && a !== b) return a < b ? -1 : 1;
      if (a && !b) return -1;
      if (!a && b) return 1;
      return x.i - y.i;
    })
    .map((x) => x.it);
}

/** The ribbon item a page for `area` should highlight: its current stay, else
 *  its next one, else its most recent. Null when the area has no item. */
export function focusItem(items, area, today) {
  const mine = (items || []).filter((it) => it.area === area);
  if (!mine.length) return null;
  return (
    mine.find((it) => it.start && it.start <= today && (it.end == null || today <= it.end)) ||
    mine.find((it) => it.start && it.start > today) ||
    mine[mine.length - 1]
  );
}

/** Where the site lands: the stay under way today (on a changeover day, the
 *  one being arrived into), else the next one, else the most recent — guides
 *  first, so the landing page has content when any guide is in play. */
export function landingArea(items, today) {
  const pick = (list) => {
    let current = null;
    for (const it of list) {
      if (it.start && it.start <= today && (it.end == null || today <= it.end)) current = it;
    }
    if (current) return current.area;
    const next = list.find((it) => it.start && it.start > today);
    if (next) return next.area;
    const dated = list.filter((it) => it.start);
    if (dated.length) return dated[dated.length - 1].area;
    return list.length ? list[0].area : null;
  };
  return pick((items || []).filter((it) => it.hasGuide)) || pick(items || []);
}
