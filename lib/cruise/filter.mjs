// Filter pipeline for cruise-watch.
//
// Input:  Array<NormalizedSailing> from per-line extractors,
//         plan = Array<{city, start, end}>,
//         skipped = Set<sailing_id>  (user-opted-out sailings)
// Output: { matches, reachable, dropped: { reasons } }
//
// Stages, in order (thresholds from the cruise-watch config `filters`, see
// lib/cruise/config.mjs):
//   1. ship_built_year resolves AND > the per-line built_after_year floor
//   2. nights in [nights_min, nights_max] (2..21 by default)
//   3. lowest_balcony_per_person_usd is set
//   4. departure port matches a plan window  → sets `is_reachable`
//   5. (price / nights) ≤ max_per_person_per_night ($120 by default; taxes
//      inclusive — a per-night tax estimate is added if taxes_fees_included=false)
//   6. sailing_id NOT in skipped (user-opt-out blacklist; default behavior is
//      "show every match every week" — only sailings the user explicitly
//      skipped get suppressed)
//
// REACHABLE vs MATCH (split 2026-08-31). The port/window test moved AHEAD of the
// price ceiling so it can be evaluated for every sailing, not just the cheap
// ones, and its result is recorded separately as `is_reachable`. The two answer
// different questions and had been conflated in one flag:
//   is_reachable — could the user get on this ship? (right port, right dates)
//   is_match     — should the weekly email mention it? (also cheap, also modern)
// The email wants the strict one. The SITE wants the loose one: its toggle says
// "Matches my travel plan", it now has price bands of its own, and folding a
// price ceiling into a checkbox labelled about travel left ~2,200 reachable
// sailings invisible behind a filter that never mentioned price.

import { lookupShip } from "./ships.mjs";
import { matchPort, findPlanWindow } from "./ports.mjs";
import { cruiseConfig, CRUISE_DEFAULTS } from "./config.mjs";

const D = CRUISE_DEFAULTS.filters;
const PER_PERSON_PER_NIGHT_CEILING = D.max_per_person_per_night;
const NIGHTS_MIN = D.nights_min;
const NIGHTS_MAX = D.nights_max;
// A member rating at or above `rating_overrides_age` beats the built-year
// floor. The bar is inclusive: ratings land on one decimal, and "over 4.0"
// excluding an exact 4.0 would drop ships that were plainly meant to be in.

function shipMinYearFor(cfg, line) {
  return cfg?.lines?.[line]?.built_after_year ?? cfg?.default?.built_after_year ?? 2000;
}

/**
 * @param {object} [opts]
 * @param {Set<string>} [opts.favorites]  starred sailing ids
 * @param {Map<string,number>} [opts.ratings]  ship name (lower) → rating
 */
export async function applyFilters(sailings, planWindows, skipped, opts = {}) {
  const favorites = opts.favorites instanceof Set ? opts.favorites : new Set(opts.favorites || []);
  const ratings = opts.ratings instanceof Map ? opts.ratings : new Map();
  const lineConfig = cruiseConfig().filters;
  const ceiling = Number(lineConfig.max_per_person_per_night) || PER_PERSON_PER_NIGHT_CEILING;
  const taxEstimate = Number(lineConfig.tax_estimate_per_person_per_night) || 0;
  const nightsMin = Number(lineConfig.nights_min) || NIGHTS_MIN;
  const nightsMax = Number(lineConfig.nights_max) || NIGHTS_MAX;
  const ratingBar = Number(lineConfig.rating_overrides_age) || D.rating_overrides_age;
  const preferred = new Set(lineConfig.preferred_lines || []);
  const matches = [];
  const reachable = [];
  const dropped = {
    no_ship_year: 0,
    ship_too_old: 0,
    age_overridden: 0,
    bad_nights: 0,
    no_balcony_price: 0,
    above_price_ceiling: 0,
    no_port_window_match: 0,
    user_skipped: 0,
  };

  for (const s of sailings) {
    if (!s) continue;

    const ship = await lookupShip(s.source, s.ship_name);
    if (!ship || !ship.built_year) {
      dropped.no_ship_year++;
      continue;
    }
    s.ship_built_year = ship.built_year;
    const minYear = shipMinYearFor(lineConfig, s.source);
    if (s.ship_built_year <= minYear) {
      // TWO THINGS OUTRANK THE BUILT-YEAR FLOOR: a star and a good member
      // rating. The floor is a proxy for "will we enjoy this ship"; a star
      // and a member rating are direct evidence about the same question, so
      // where they exist the proxy should yield. Without this an older ship
      // the user had starred stayed off the site's reachable list — the site
      // quietly disagreeing with a choice the user had explicitly made.
      const starred = favorites.has(s.sailing_id);
      const rating = ratings.get(String(s.ship_name || "").toLowerCase());
      const wellRated = Number.isFinite(rating) && rating >= ratingBar;
      if (!starred && !wellRated) {
        dropped.ship_too_old++;
        continue;
      }
      s.age_override = starred ? "starred" : "rating";
      dropped.age_overridden++;
    }

    if (!Number.isFinite(s.nights) || s.nights < nightsMin || s.nights > nightsMax) {
      dropped.bad_nights++;
      continue;
    }

    if (!Number.isFinite(s.lowest_balcony_per_person_usd) || s.lowest_balcony_per_person_usd <= 0) {
      dropped.no_balcony_price++;
      continue;
    }

    // Port/window FIRST, so `is_reachable` is answered for every sailing rather
    // than only for the ones that already cleared the price ceiling.
    const port = await matchPort({
      name: s.departure_port,
      code: s.departure_port_code,
    });
    const window = findPlanWindow(port, planWindows, s.depart_date);
    if (!port || !window) {
      dropped.no_port_window_match++;
      continue;
    }
    s.matched_port = port.port;
    s.matched_city = window.city;
    s.matched_window = `${window.start}..${window.end}`;
    // The window that carried this sailing may be an assumed home-city fill
    // rather than a decided leg — worth keeping so the site can say so.
    s.matched_window_assumed = window.assumed === true;
    s.is_reachable = true;
    reachable.push(s);

    let priceForCheck = s.lowest_balcony_per_person_usd;
    if (s.taxes_fees_included === false) {
      priceForCheck += s.nights * taxEstimate;
    }
    const perNight = priceForCheck / s.nights;
    s.per_person_per_night_usd = Math.round(perNight * 100) / 100;
    if (perNight > ceiling) {
      dropped.above_price_ceiling++;
      continue;
    }

    if (skipped?.has(s.sailing_id)) {
      dropped.user_skipped++;
      continue;
    }

    matches.push(s);
  }

  // Sort: preferred lines first (config `preferred_lines` — surfaced
  // regardless of price), then ascending per-person-per-night within each.
  const linePriority = (s) => (preferred.has(s.source) ? 0 : 1);
  matches.sort((a, b) => {
    const lp = linePriority(a) - linePriority(b);
    if (lp !== 0) return lp;
    return a.per_person_per_night_usd - b.per_person_per_night_usd;
  });

  return { matches, reachable, dropped };
}

export { PER_PERSON_PER_NIGHT_CEILING, NIGHTS_MIN, NIGHTS_MAX };
