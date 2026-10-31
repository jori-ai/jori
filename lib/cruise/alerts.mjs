// cruise-watch alert classification — turns the run's price events into the
// three things the weekly email is allowed to say.
//
// Until 2026-08-31 the email was a DIGEST: every sailing currently passing the
// plan filter, re-sent every Monday whether or not anything about it had
// changed. Requirement: alert only on significant price drops, not on every
// cruise. The full list moved to the browsing site; the email now carries only
// movement, and this module is the definition of "movement worth an email":
//
//   price_drops    — a plan-matching sailing got cheaper, by BOTH a relative
//                    and an absolute margin (10% and $75/person by default).
//                    Both bars matter: 10% alone fires on a $25 wobble on a
//                    cheap 3-nighter, $75 alone fires on a rounding change to
//                    a $2,000 fare. The change must be NEW this run
//                    (price_changed_at === run_at) or the same drop re-sends
//                    every week until the price moves again.
//   new_deals      — first-seen inventory has no prior price, so it can never
//                    register a drop; a brand-new plan match at or below
//                    $80/person/night (vs. the $120 filter ceiling) is the
//                    one case where "new" is itself the news.
//   all_time_lows  — cheapest this sailing has EVER been observed, even when
//                    this week's step down was small. A sailing that has
//                    ratcheted down $30/wk for two months never trips the 10%
//                    bar on any single week but is now at its floor.
//
// Everything else — the other ~60 currently-matching sailings, every drop
// outside the plan windows, every sailing that merely held its price — is on
// the site. Silence here is the point, not a gap.
//
// Scope: alerts are drawn from the run's `matches` (plan-window + price +
// ship-age filter) only. The corpus is ~8,300 sailings and most of it is 2028
// inventory out of Athens; a 10% drop there is not news. Watched targets
// (the watch-targets CLI) are a separate, hand-curated opt-in path that alerts
// on ANY drop vs. its captured baseline — see the playbook Step 2.5.

import { cruiseConfig, CRUISE_DEFAULTS } from "./config.mjs";

const DEFAULTS = { ...CRUISE_DEFAULTS.alerts };

// The bars from the cruise-watch config `alerts` over the defaults above.
export async function loadAlertThresholds() {
  try {
    return { ...DEFAULTS, ...(cruiseConfig().alerts || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

// A drop qualifies on magnitude alone; freshness is checked separately so the
// caller can distinguish "dropped this run" from "is currently below its
// previous price" (the site shows the latter, the email sends the former).
export function isSignificantDrop(event, thresholds) {
  if (!event) return false;
  const { change_usd, change_pct } = event;
  if (!Number.isFinite(change_usd) || !Number.isFinite(change_pct)) return false;
  if (change_usd >= 0) return false; // a rise is not a drop
  return Math.abs(change_pct) >= thresholds.drop_min_pct
    && Math.abs(change_usd) >= thresholds.drop_min_usd;
}

/**
 * @param {object[]} matches      the run's plan-filter matches (enriched sailings)
 * @param {Map<string, object>} events  sailing_id → price event from db.mjs
 * @param {object} thresholds     from loadAlertThresholds()
 * @param {string} runAt          ISO timestamp this run stamped on its rows
 */
export function classifyAlerts(matches, events, thresholds, runAt) {
  const price_drops = [];
  const new_deals = [];
  const all_time_lows = [];

  for (const m of matches || []) {
    const ev = events?.get(m.sailing_id);
    if (!ev) continue;

    // Fresh significant drop → the headline alert.
    if (ev.changed_at === runAt && isSignificantDrop(ev, thresholds)) {
      price_drops.push({ ...m, ...ev });
      continue; // one sailing, one section — a drop that is also an ATL reads as a drop
    }

    // Brand-new inventory (or newly priced) that lands exceptionally cheap.
    if (ev.is_new) {
      if (Number.isFinite(m.per_person_per_night_usd)
        && m.per_person_per_night_usd <= thresholds.new_deal_max_per_person_per_night) {
        new_deals.push({ ...m, ...ev });
      }
      continue; // a first observation cannot be an all-time low in any useful sense
    }

    // Cheapest ever observed, arrived at by steps too small to trip the drop bar.
    if (ev.is_all_time_low && ev.changed_at === runAt) {
      all_time_lows.push({ ...m, ...ev });
    }
  }

  const byPrice = (a, b) => (a.per_person_per_night_usd ?? 1e9) - (b.per_person_per_night_usd ?? 1e9);
  price_drops.sort((a, b) => a.change_pct - b.change_pct); // steepest drop first
  new_deals.sort(byPrice);
  all_time_lows.sort(byPrice);

  return { price_drops, new_deals, all_time_lows };
}

export { DEFAULTS as ALERT_DEFAULTS };


/**
 * The WATCHLIST alert set — what the weekly email is actually for.
 *
 * Requirement: the starred sailings are the ones to watch (the best fit for
 * timeline, interest and itinerary); alert on a price drop of 10% or more and
 * on any promotion, and send no email in a week where nothing changed.
 *
 * Three things separate this from `classifyAlerts` above:
 *
 * 1. **Scope is the user's stars, not the plan filter.** `cruise_favorites` is a human
 *    judgement about fit; the plan filter is a machine's guess from ports and
 *    dates. On a watchlist the guess is not good enough, and the star list is
 *    small enough that nothing needs to be held back to keep the email short.
 * 2. **The dollar floor is dropped.** `classifyAlerts` requires ≥10% AND ≥$75,
 *    because it screens thousands of sailings and a $25 wobble on a cheap
 *    3-nighter is noise. On a list curated by hand, 10% is the bar that was asked
 *    for and a second hidden bar would silently swallow qualifying drops on
 *    short sailings — exactly the ones the user starred and would want to hear about.
 * 3. **Promotions count as news** — but only where the line publishes them.
 *    royal and celebrity expose no promotion field at all (probed 2026-09-01),
 *    which is 68% of the corpus, so a starred Royal sailing is watched on price
 *    alone. This is a real gap, not an oversight; see the migration comment.
 *
 * Returns `{ drops, promos, gone, any }`. `any === false` means SEND NOTHING —
 * the caller must not fall back to a "nothing changed" email, which is the one
 * thing the user explicitly does not want.
 *
 * @param {Set<string>|string[]} favorites  starred sailing ids
 * @param {Map<string, object>} bySailing   sailing_id → the run's enriched sailing
 * @param {Map<string, object>} events      sailing_id → price event from db.mjs
 * @param {object} thresholds               from loadAlertThresholds()
 * @param {string} runAt                    ISO timestamp this run stamped
 * @param {Set<string>|string[]} [sourcesRun]  which LINES this run actually
 *   scraped. Without it a `--lines princess` run reports every starred Royal
 *   and Celebrity sailing as "no longer offered", because they are simply
 *   absent from `bySailing` — observed doing exactly that on 2026-09-01 against
 *   a real 12-sailing watchlist. A sailing can only be declared gone by a run
 *   that actually looked at its line.
 */
export function classifyWatchlist(favorites, bySailing, events, thresholds, runAt, sourcesRun = null) {
  const stars = favorites instanceof Set ? favorites : new Set(favorites || []);
  const drops = [];
  const promos = [];
  const gone = [];

  for (const id of stars) {
    const m = bySailing?.get(id);
    if (!m) {
      // Absent from this run — and that is NOT a disappearance.
      //
      // The watch runs on its own database: removing a cruise from it would
      // take a cancellation by the line; it must not just disappear. The row stays in
      // cruise_sailings; all we have observed is that a line's search did not
      // return it this time, and those sets churn — Celebrity Ascent
      // 2027-04-19 was present at 03:58, absent at 15:46, and bookable on
      // CruiseFeed at the same $2,419 throughout.
      //
      // So this is recorded as UNSEEN, and the caller decides whether a long
      // enough run of misses is worth mentioning. It is never a headline, and
      // an email is never sent because of it.
      const source = String(id).split(":")[0];
      const looked = !sourcesRun || (sourcesRun instanceof Set ? sourcesRun.has(source) : sourcesRun.includes(source));
      if (looked) gone.push({ sailing_id: id, unseen_this_run: true });
      continue;
    }
    const ev = events?.get(id);

    if (ev && ev.changed_at === runAt && Number.isFinite(ev.change_pct)
        && ev.change_usd < 0 && Math.abs(ev.change_pct) >= thresholds.drop_min_pct) {
      drops.push({ ...m, ...ev });
      continue; // one sailing, one section
    }

    // A promo set that changed THIS run, on a line that publishes promos.
    if (m.promos_changed_at === runAt && Array.isArray(m.promos) && m.promos.length) {
      promos.push({ ...m, ...(ev || {}) });
    }
  }

  drops.sort((a, b) => a.change_pct - b.change_pct); // steepest first
  promos.sort((a, b) => String(a.ship_name || "").localeCompare(String(b.ship_name || "")));

  // `any` is the send/don't-send decision, and unseen sailings are deliberately
  // NOT in it: a sailing we merely failed to see is not news, and mailing about
  // one would be reporting our own scrape's flakiness as if it were the world
  // changing.
  return { drops, promos, gone, any: drops.length + promos.length > 0 };
}
