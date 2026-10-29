// Plan-window shaping for cruise-watch.
//
// The travel plan (data/travel-plan-*.json, the shape cruise-watch --plan
// reads) only ever reaches as far as the user has actually decided. Every
// sailing departing after it matched nothing, so a corpus holding inventory
// years out could only ever surface the planned months of it. Requirement:
// where the plan does not say where the user is, assume a home city, and show
// every announced sailing up to two years ahead.
//
// So: explicit windows still win outright, and only the GAPS between and after
// them are filled with the home cities. That distinction is the whole point. A
// blanket "home city, always" window would be simpler and wrong — a plan leg
// abroad makes a home-port departure inside it one the user cannot take.
// Filling only uncovered days keeps every deliberate "I am elsewhere" intact
// while opening up the unplanned future.
//
// Default cities are the installation's home cities (cruise-watch config
// `home_cities`). The port matcher's 150-mile radius then pulls in the nearby
// ports on its own.

import { cruiseConfig } from "./config.mjs";

/** Where the user is when the plan doesn't say (config `home_cities`). */
export function defaultCities() {
  return cruiseConfig().home_cities || [];
}

/** How far past the plan to keep looking (config `horizon_days`, default two years). */
export function defaultHorizonDays() {
  return Number(cruiseConfig().horizon_days) || 730;
}

function toDay(iso) {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
}

function fromDay(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

/**
 * Return `windows` plus a default window per city over every day between
 * `from` and `from + horizonDays` that no explicit window already covers.
 *
 * @param {{city:string,start:string,end:string}[]} windows  explicit plan windows
 * @param {object} [opts]
 * @param {string} [opts.from]          ISO date to start filling from (default: today UTC)
 * @param {number} [opts.horizonDays]   how far ahead to fill
 * @param {string[]} [opts.cities]      cities to assume in a gap
 */
export function withDefaultWindows(windows, opts = {}) {
  const {
    from = new Date().toISOString().slice(0, 10),
    horizonDays = defaultHorizonDays(),
    cities = defaultCities(),
  } = opts;

  const given = (windows ?? []).filter((w) => w?.city && w?.start && w?.end);
  // A window flagged `assumed` is a PREFERENCE, not a decision — "we're usually
  // in that city that spring, but it's not set yet". It still matches sailings,
  // so a cruise leaving from there is reachable; it just does not CLAIM those
  // days, so the default fill still offers the other home cities alongside it.
  //
  // Without this the distinction had nowhere to live: a tentative home-city
  // window that was never a booking silently excluded every departure from the
  // other home metro in those months — including sailings the user had
  // starred. A preference should widen what is considered, not narrow it.
  const explicit = given.filter((w) => w.assumed !== true);
  const startDay = toDay(from);
  const endDay = startDay + horizonDays;
  if (endDay <= startDay) return [...explicit];

  // Mark every explicitly-covered day in the horizon. Windows are inclusive at
  // both ends (a window ending 10-28 covers the 28th), matching findPlanWindow.
  const covered = new Set();
  for (const w of explicit) {
    const a = Math.max(toDay(w.start), startDay);
    const b = Math.min(toDay(w.end), endDay);
    for (let d = a; d <= b; d++) covered.add(d);
  }

  // Collapse the uncovered days back into maximal spans, so the output is a
  // handful of windows rather than 730 one-day ones.
  const gaps = [];
  let runStart = null;
  for (let d = startDay; d <= endDay; d++) {
    if (covered.has(d)) {
      if (runStart !== null) {
        gaps.push([runStart, d - 1]);
        runStart = null;
      }
    } else if (runStart === null) {
      runStart = d;
    }
  }
  if (runStart !== null) gaps.push([runStart, endDay]);

  const filled = [...given];
  for (const [a, b] of gaps) {
    for (const city of cities) {
      filled.push({ city, start: fromDay(a), end: fromDay(b), assumed: true });
    }
  }
  return filled;
}
