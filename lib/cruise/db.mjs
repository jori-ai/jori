// cruise-watch DB upsert — persists every sailing each extractor returns into
// Supabase `cruise_sailings`, flagging the run's filter matches with
// `is_match = true`. Goal: make the full corpus queryable at any time (ad-hoc
// "what's the cheapest balcony out of the home port right now?", future analytics)
// without changing the alert pipeline. Non-matches still get rows; their
// `is_match` stays false and `matched_*` fields stay null.
//
// Schema lives in data/migrations/20260504_cruise_sailings.sql. Apply
// via Supabase SQL Editor or `mcp__supabase-jori__apply_migration` before
// the orchestrator's first non-dry run; until then, upserts gracefully no-op
// (any 404/relation-missing error is swallowed and counted as a skip so the
// alert pipeline doesn't fail).
//
// Auth: SUPABASE_SERVICE_ROLE_KEY from .env (already used by phone-
// channel + email-send). PostgREST upsert via POST + Prefer:
// resolution=merge-duplicates,return=minimal.
//
// PRICE HISTORY (added 2026-08-31). The upsert overwrites
// `lowest_balcony_per_person_usd` in place, so before writing we read every
// existing row's price back and diff against it. That diff is what the weekly
// email now runs on (it alerts on movement, not on inventory — see
// alerts.mjs); without it "did this get cheaper?" has no answer, because the
// previous number is destroyed the moment the new one lands.
//
// Two places the diff is persisted, for two different readers:
//   - sticky delta columns on cruise_sailings (prev_*, price_change_*,
//     lowest_ever_*) — these describe the most recent observed CHANGE and
//     survive weeks where the price held, so the browsing site can show
//     "-19% since Aug 24" on a sailing that moved once a month ago.
//     `price_changed_at` is how the email tells a new drop from an old one.
//   - cruise_price_history — append-only, written ONLY when the price actually
//     changed. Writing every sailing every run would be ~430k rows/yr of
//     mostly-identical numbers for a 6-line corpus that mostly sits still.
// Schema: data/migrations/20260831_cruise_price_history.sql.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cruiseSupabaseUrl } from "./config.mjs";

const { installTools } = createRequire(import.meta.url)("../root.cjs");
// This installation's project (instance supabase_project; SUPABASE_URL wins).
const SUPABASE_URL = cruiseSupabaseUrl();
// No project configured reads as no key everywhere below: every call no-ops.
const ENV_PATH = installTools(".env");
const TABLE = "cruise_sailings";
const HISTORY_TABLE = "cruise_price_history";
const BATCH_SIZE = 250;
const PRIOR_PAGE_SIZE = 1000;

let envLoadPromise = null;
/**
 * Bootstrap `.env` into process.env, once per process.
 *
 * Exported because it is not really DB-specific: cruisefeed.mjs needs
 * `CRUISEFEED_API_KEY` and runs BEFORE the first DB call, so relying on the
 * upsert to have loaded the env left the primary source silently skipping with
 * "no CRUISEFEED_API_KEY" on a machine where the key was present.
 */
export async function loadEnvOnce() {
  // MEMOIZE THE PROMISE, NOT A BOOLEAN. The old form set `envLoaded = true`
  // and only then awaited the read, so a second caller starting in the same
  // tick returned immediately with process.env still unpopulated. That is not
  // hypothetical: `Promise.all([loadFavorites(), loadShipRatings()])` raced
  // exactly this way on 2026-09-01 and loadShipRatings silently got no service
  // key, returned an empty map, and every rating-based age override stopped
  // firing — 880 well-reviewed sailings kept being dropped as "too
  // old" while the same code passed when tested on its own.
  if (envLoadPromise) return envLoadPromise;
  envLoadPromise = (async () => {
  try {
    const text = await readFile(ENV_PATH, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    // missing .env is fine — upsertSailings will see no key and skip
  }
  })();
  return envLoadPromise;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Extract the two numbers everything downstream keys on. Number(null) is 0,
// which would persist as a real $0 balcony fare, so gate on the raw value
// being a finite positive number before trusting it.
function priceOf(s) {
  const rawBalcony = s.lowest_balcony_per_person_usd;
  const balcony = typeof rawBalcony === "number" && Number.isFinite(rawBalcony) && rawBalcony > 0
    ? rawBalcony
    : null;
  const rawNights = s.nights;
  const nights = typeof rawNights === "number" && Number.isFinite(rawNights) ? rawNights : null;
  const ppPerNight = balcony !== null && nights !== null && nights > 0
    ? round2(balcony / nights)
    : null;
  return { balcony, nights, ppPerNight };
}

/**
 * Build the upsert row plus the price event describing how this sailing moved
 * since the last run.
 *
 * The delta columns are STICKY: on a run where the price didn't move we carry
 * the prior run's prev_ and price_change_ fields forward untouched, so the site keeps
 * showing the last real movement instead of blanking out. `price_changed_at`
 * is therefore the only safe "is this new?" test — it equals `now` exactly on
 * the run that observed the change.
 *
 * @param {object} prior  the existing DB row's price state, or undefined
 * @param {string} now    ONE timestamp for the whole run (see upsertSailings)
 */
/**
 * Promotions, and when the SET last changed.
 *
 * Stamped on exactly the same rule as price: `promos_changed_at === run_at`
 * means "new this run", and the value is otherwise carried forward so the site
 * can show a standing promo without the email re-alerting on it every Monday.
 * Comparison is on the sorted code list, so a line reordering its own offers is
 * not a change. A line that publishes nothing (royal, celebrity) keeps
 * `promos` null and never trips the rule.
 */
function promoFields(s, prior, now) {
  const next = Array.isArray(s.promos) ? s.promos : null;
  if (next === null) {
    return { promos: prior?.promos ?? null, promos_changed_at: prior?.promos_changed_at ?? null };
  }
  const key = (list) => (list || []).map((p) => p?.code).filter(Boolean).sort().join("|");
  const changed = !prior || prior.promos === null || key(prior.promos) !== key(next);
  return {
    promos: next,
    promos_changed_at: changed ? now : (prior?.promos_changed_at ?? null),
  };
}

function rowFrom(s, isMatch, prior, now, touchLastRun = true, priceOnly = false) {
  const { balcony, nights, ppPerNight } = priceOf(s);

  // "New" covers both a sailing we've never seen and one that existed without
  // a price (Virgin publishes most of its inventory unpriced) and now has one.
  // Neither can register a drop, and both are candidates for the new-deal rule.
  const isNew = !prior || prior.price === null || prior.price === undefined;

  let prevPrice = prior?.prev_price ?? null;
  let prevAt = prior?.prev_price_at ?? null;
  let changeUsd = prior?.change_usd ?? null;
  let changePct = prior?.change_pct ?? null;
  let changedAt = prior?.changed_at ?? null;
  let lowestEver = prior?.lowest_ever ?? null;
  let lowestEverAt = prior?.lowest_ever_at ?? null;
  let historyRow = null;

  if (balcony !== null) {
    if (isNew) {
      lowestEver = balcony;
      lowestEverAt = now;
      historyRow = { sailing_id: s.sailing_id, observed_at: now, balcony_per_person_usd: balcony, per_person_per_night_usd: ppPerNight };
    } else if (balcony !== Number(prior.price)) {
      prevPrice = Number(prior.price);
      // When the previous price was last confirmed — that is the date the
      // email means by "down from $X".
      prevAt = prior.last_seen_at ?? null;
      changeUsd = round2(balcony - prevPrice);
      changePct = round2(((balcony - prevPrice) / prevPrice) * 100);
      changedAt = now;
      historyRow = { sailing_id: s.sailing_id, observed_at: now, balcony_per_person_usd: balcony, per_person_per_night_usd: ppPerNight };
      if (lowestEver === null || balcony < Number(lowestEver)) {
        lowestEver = balcony;
        lowestEverAt = now;
      }
    }
  }

  // "Sitting at its floor", not "hit a new floor this run" — the site wants the
  // standing fact. Requires at least one observed change (prevPrice non-null),
  // or every sailing would be at its all-time low the day we first saw it.
  const isAllTimeLow = !isNew
    && prevPrice !== null
    && balcony !== null
    && lowestEver !== null
    && balcony <= Number(lowestEver);

  const row = {
    sailing_id: s.sailing_id,
    source: s.source,
    // 'cruisefeed' (primary) or 'direct' (our own scrape, which verifies it).
    data_source: s.data_source || "direct",
    cruise_id: s.cruise_id ?? null,
    ship_name: s.ship_name ?? null,
    ship_built_year: typeof s.ship_built_year === "number" && Number.isFinite(s.ship_built_year)
      ? s.ship_built_year
      : null,
    departure_port: s.departure_port ?? null,
    departure_port_code: s.departure_port_code ?? null,
    departure_port_region: s.departure_port_region ?? null,
    // Itinerary — see 20260901_cruise_itinerary_ports. NULL (not []) when an
    // extractor returned nothing, so "line does not give us ports" stays
    // distinguishable from "genuinely a no-call sailing".
    ...promoFields(s, prior, now),
    ports_of_call: priceOnly
      ? (prior?.ports_of_call ?? (Array.isArray(s.ports_of_call) ? s.ports_of_call : null))
      : (Array.isArray(s.ports_of_call) ? s.ports_of_call : null),
    ports_ordered: typeof s.ports_ordered === "boolean" ? s.ports_ordered : null,
    disembark_port: priceOnly ? (prior?.disembark_port ?? s.disembark_port ?? null) : (s.disembark_port ?? null),
    disembark_port_code: s.disembark_port_code ?? null,
    depart_date: s.depart_date ?? null,
    return_date: s.return_date ?? null,
    nights,
    lowest_balcony_per_person_usd: balcony,
    per_person_per_night_usd: ppPerNight,
    taxes_fees_included: typeof s.taxes_fees_included === "boolean" ? s.taxes_fees_included : null,
    currency: s.currency ?? null,
    booking_url: s.booking_url ?? null,
    product_url: s.product_url ?? null,
    matched_port: priceOnly ? (prior?.matched_port ?? null) : (s.matched_port ?? null),
    matched_city: priceOnly ? (prior?.matched_city ?? null) : (s.matched_city ?? null),
    matched_window: priceOnly ? (prior?.matched_window ?? null) : (s.matched_window ?? null),
    hero_image_url: s.hero_image_url ?? null,
    is_match: priceOnly ? (prior?.is_match ?? false) : !!isMatch,
    // Set by the filter the moment the port/window test passes, which now runs
    // ahead of the price gate — so this is true for sailings is_match rejects
    // purely on cost. See the 20260831_cruise_is_reachable migration.
    // PRICE-ONLY REFRESH: carry forward everything this run did not observe.
    //
    // The daily favourites refresh looks up a handful of sailings by ship and
    // date to re-read a price. It knows nothing about the travel plan, so it
    // passes no matches and no reachable set — and on 2026-09-01 that wiped
    // `is_reachable` on 11 of 12 starred sailings, which is what made them
    // vanish from "Where I'll be". A refresh must only write what it looked at.
    is_reachable: priceOnly ? (prior?.is_reachable ?? false) : s.is_reachable === true,
    matched_window_assumed: priceOnly
      ? (prior?.matched_window_assumed ?? false)
      : s.matched_window_assumed === true,
    prev_balcony_per_person_usd: prevPrice,
    prev_price_at: prevAt,
    price_change_usd: changeUsd,
    price_change_pct: changePct,
    price_changed_at: changedAt,
    lowest_ever_per_person_usd: lowestEver,
    lowest_ever_at: lowestEverAt,
    is_all_time_low: isAllTimeLow,
    // `last_run_at` means "when this LINE's catalogue was last swept", and the
    // site's staleness filter hides any row older than its source's newest run.
    // A favourites-only refresh touches a handful of rows, so bumping it here
    // would make every OTHER row of that line look stale and vanish from the
    // site. It observes, it does not sweep: `last_seen_at` moves, `last_run_at`
    // is carried forward.
    last_run_at: touchLastRun ? now : (prior?.last_run_at ?? now),
    last_seen_at: now,
  };

  const event = {
    sailing_id: s.sailing_id,
    current: balcony,
    prev: prevPrice,
    prev_at: prevAt,
    change_usd: changeUsd,
    change_pct: changePct,
    changed_at: changedAt,
    is_new: isNew,
    is_all_time_low: isAllTimeLow,
    lowest_ever: lowestEver,
  };

  return { row, event, historyRow };
}

// Read back every existing row's price state so the upsert can diff against it.
// Paginated rather than filtered by id: an `in.(...)` over ~8,300 sailing_ids
// is a multi-hundred-KB URL, and we rewrite essentially the whole table each
// run anyway, so a straight scan of five narrow columns is both simpler and
// fewer round-trips.
async function fetchPriors(key) {
  const cols = [
    "sailing_id",
    "lowest_balcony_per_person_usd",
    "prev_balcony_per_person_usd",
    "prev_price_at",
    "price_change_usd",
    "price_change_pct",
    "price_changed_at",
    "lowest_ever_per_person_usd",
    "lowest_ever_at",
    "last_seen_at",
    "promos",
    "promos_changed_at",
    "last_run_at",
    "is_match",
    "is_reachable",
    "matched_port",
    "matched_city",
    "matched_window",
    "matched_window_assumed",
    "ports_of_call",
    "disembark_port",
  ].join(",");
  const priors = new Map();
  for (let offset = 0; ; offset += PRIOR_PAGE_SIZE) {
    const url = `${SUPABASE_URL}/rest/v1/${TABLE}?select=${cols}&order=sailing_id.asc`;
    const res = await fetch(url, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        Range: `${offset}-${offset + PRIOR_PAGE_SIZE - 1}`,
        "Range-Unit": "items",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`cruise_sailings priors HTTP ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const page = await res.json();
    for (const r of page) {
      priors.set(r.sailing_id, {
        price: r.lowest_balcony_per_person_usd === null ? null : Number(r.lowest_balcony_per_person_usd),
        prev_price: r.prev_balcony_per_person_usd === null ? null : Number(r.prev_balcony_per_person_usd),
        prev_price_at: r.prev_price_at,
        change_usd: r.price_change_usd === null ? null : Number(r.price_change_usd),
        change_pct: r.price_change_pct === null ? null : Number(r.price_change_pct),
        changed_at: r.price_changed_at,
        lowest_ever: r.lowest_ever_per_person_usd === null ? null : Number(r.lowest_ever_per_person_usd),
        lowest_ever_at: r.lowest_ever_at,
        last_seen_at: r.last_seen_at,
        promos: r.promos ?? null,
        promos_changed_at: r.promos_changed_at ?? null,
        last_run_at: r.last_run_at ?? null,
        is_match: r.is_match ?? false,
        is_reachable: r.is_reachable ?? false,
        matched_port: r.matched_port ?? null,
        matched_city: r.matched_city ?? null,
        matched_window: r.matched_window ?? null,
        matched_window_assumed: r.matched_window_assumed ?? false,
        ports_of_call: r.ports_of_call ?? null,
        disembark_port: r.disembark_port ?? null,
      });
    }
    if (page.length < PRIOR_PAGE_SIZE) break;
  }
  return priors;
}

async function postBatch(rows, key, { table = TABLE, onConflict = "sailing_id", resolution = "merge-duplicates" } = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: `resolution=${resolution},return=minimal`,
    },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`${table} upsert HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
}

/**
 * Upsert every sailing, diffing each against its stored price first.
 *
 * @returns {{inserted:number, batches:number, error:?string, price_events:Map<string,object>, history_rows:number, changed:number, run_at:string}}
 *   `price_events` is what alerts.mjs classifies; `run_at` is the single
 *   timestamp stamped on every row this run, and the value an event's
 *   `changed_at` must equal for the change to be new.
 */
export async function upsertSailings(allSailings, matches, reachable, { touchLastRun = true, priceOnly = false } = {}) {
  await loadEnvOnce();
  const key = SUPABASE_URL ? process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY : null;
  const now = new Date().toISOString();
  if (!key) {
    return { skipped: "no_key", inserted: 0, batches: 0, price_events: new Map(), history_rows: 0, changed: 0, run_at: now };
  }

  // One timestamp for the whole run. Per-row `new Date()` would stamp rows
  // milliseconds apart, and `price_changed_at === run_at` — the test that
  // separates a new drop from last week's — would then be unreliable.
  let priors;
  try {
    priors = await fetchPriors(key);
  } catch (err) {
    // No priors → treat everything as first-seen rather than failing the run.
    // A single week of missed drop detection beats losing the upsert entirely.
    // lang-regex-ok: matches PostgREST's own error string, not human language
    if (err?.status === 404 || /does not exist|undefined_table/i.test(String(err?.message || ""))) {
      return { skipped: "table_missing", inserted: 0, batches: 0, error: err.message, price_events: new Map(), history_rows: 0, changed: 0, run_at: now };
    }
    priors = new Map();
  }

  // Prefer the post-filter match objects when present (they carry
  // per_person_per_night_usd and matched_* fields); fall back to the raw
  // sailing for non-matches.
  const byId = new Map();
  const events = new Map();
  const historyRows = [];
  const build = (s, isMatch) => {
    const { row, event, historyRow } = rowFrom(s, isMatch, priors.get(s.sailing_id), now, touchLastRun, priceOnly);
    byId.set(s.sailing_id, row);
    events.set(s.sailing_id, event);
    if (historyRow) historyRows.push(historyRow);
  };
  for (const s of allSailings || []) {
    if (s?.sailing_id && !byId.has(s.sailing_id)) build(s, false);
  }
  // Reachable-but-not-matching sailings carry matched_* and is_reachable that
  // the raw object above does not, so rebuild them before the matches pass.
  for (const s of reachable || []) {
    if (!s?.sailing_id) continue;
    byId.delete(s.sailing_id);
    const idx = historyRows.findIndex((h) => h.sailing_id === s.sailing_id);
    if (idx !== -1) historyRows.splice(idx, 1);
    build(s, false);
  }
  for (const m of matches || []) {
    // Rebuild rather than patch: the match object carries the matched_* fields
    // and the tax-adjusted per-night price the raw sailing doesn't have. The
    // history row it produces replaces the non-match one (same PK, same run).
    if (m?.sailing_id) {
      byId.delete(m.sailing_id);
      const idx = historyRows.findIndex((h) => h.sailing_id === m.sailing_id);
      if (idx !== -1) historyRows.splice(idx, 1);
      build(m, true);
    }
  }

  const rows = Array.from(byId.values());
  if (rows.length === 0) return { skipped: "empty", inserted: 0, batches: 0, price_events: events, history_rows: 0, changed: 0, run_at: now };

  let batches = 0;
  let inserted = 0;
  let lastError = null;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    try {
      await postBatch(batch, key);
      inserted += batch.length;
      batches += 1;
    } catch (err) {
      lastError = err;
      // First batch failing on 404/relation-missing → schema not applied yet,
      // bail out cleanly so alerts still go through.
      // lang-regex-ok: matches PostgREST's own error string, not human language
    if (err?.status === 404 || /does not exist|undefined_table/i.test(String(err?.message || ""))) {
        return { skipped: "table_missing", inserted, batches, error: err.message, price_events: events, history_rows: 0, changed: 0, run_at: now };
      }
      // Other errors: log and stop — better to surface than silently skip data.
      break;
    }
  }

  // Append-only series, best-effort: a history write that fails must not cost
  // us the corpus upsert or the alerts, both of which are already done.
  let historyWritten = 0;
  for (let i = 0; i < historyRows.length; i += BATCH_SIZE) {
    const batch = historyRows.slice(i, i + BATCH_SIZE);
    try {
      await postBatch(batch, key, {
        table: HISTORY_TABLE,
        onConflict: "sailing_id,observed_at",
        resolution: "ignore-duplicates",
      });
      historyWritten += batch.length;
    } catch (err) {
      lastError = lastError || err;
      break;
    }
  }

  return {
    inserted,
    batches,
    error: lastError?.message || null,
    price_events: events,
    history_rows: historyWritten,
    changed: historyRows.length,
    run_at: now,
  };
}


/**
 * Every starred sailing id, across all users.
 *
 * The weekly email goes to the user, but the table is per-user because each
 * person in the household keeps a separate list — so the WATCH is the union:
 * if anyone starred it, it is worth telling the user the price moved. Read with the service
 * role, which bypasses the per-user RLS the browser writes under.
 *
 * Returns an empty Set when the credentials are missing or the read fails, and
 * the caller treats that as "no watchlist" — which sends no email rather than
 * emailing about everything. Failing quiet beats failing loud here: a missed
 * week is recoverable, a 6,000-sailing email is not.
 */
export async function loadFavorites() {
  await loadEnvOnce();
  const key = SUPABASE_URL ? process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY : null;
  if (!key) return new Set();
  try {
    const url = `${SUPABASE_URL}/rest/v1/cruise_favorites?select=sailing_id`;
    const res = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return new Set();
    const rows = await res.json();
    return new Set((rows || []).map((r) => r.sailing_id).filter(Boolean));
  } catch {
    return new Set();
  }
}


/**
 * Every not-yet-departed row, with the columns the plan gate needs.
 * See regate.mjs for why the whole corpus is re-gated, not just this run's.
 */
export async function loadFutureSailingsForRegate(cols, today = new Date().toISOString().slice(0, 10)) {
  await loadEnvOnce();
  const key = SUPABASE_URL ? process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY : null;
  if (!key) return null;
  const out = [];
  for (let offset = 0; ; offset += PRIOR_PAGE_SIZE) {
    const url = `${SUPABASE_URL}/rest/v1/${TABLE}?select=${cols.join(",")}&depart_date=gte.${today}&order=sailing_id.asc`;
    const res = await fetch(url, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        Range: `${offset}-${offset + PRIOR_PAGE_SIZE - 1}`,
        "Range-Unit": "items",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`cruise_sailings regate read HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < PRIOR_PAGE_SIZE) break;
  }
  return out;
}

/**
 * Apply grouped flag patches from regatePatches. PATCH, not upsert: these rows
 * exist, and a partial-column upsert would trip NOT NULL on the insert path.
 * @returns {number} rows patched
 */
export async function applyRegatePatches(groups) {
  await loadEnvOnce();
  const key = SUPABASE_URL ? process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY : null;
  if (!key) return 0;
  let patched = 0;
  for (const { fields, ids } of groups) {
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100).map((id) => `"${String(id).replace(/"/g, "")}"`).join(",");
      const url = `${SUPABASE_URL}/rest/v1/${TABLE}?sailing_id=in.(${encodeURIComponent(chunk)})`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(fields),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`cruise_sailings regate PATCH HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      patched += Math.min(100, ids.length - i);
    }
  }
  return patched;
}

/**
 * The full rows behind a set of starred sailing ids.
 *
 * `loadFavorites` returns ids; the daily refresh needs ship and date to look a
 * sailing up at the source, so this fetches the rows themselves. Ids are sent
 * in chunks: an `in.(...)` over a long list makes a multi-hundred-KB URL, the
 * same reason the prior-price scan pages instead of filtering.
 */
export async function loadFavoriteRows(ids) {
  await loadEnvOnce();
  const key = SUPABASE_URL ? process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY : null;
  const list = [...(ids || [])];
  if (!key || !list.length) return [];

  const cols = "sailing_id,source,data_source,ship_name,depart_date,nights,lowest_balcony_per_person_usd";
  const out = [];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50).map((id) => `"${String(id).replace(/"/g, '')}"`).join(",");
    const url = `${SUPABASE_URL}/rest/v1/${TABLE}?select=${cols}&sailing_id=in.(${encodeURIComponent(chunk)})`;
    try {
      const res = await fetch(url, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      out.push(...(await res.json()));
    } catch { /* a chunk that fails simply is not refreshed this run */ }
  }
  return out;
}

/**
 * Record CruiseFeed's own price for a sailing, in its OWN series.
 *
 * WHY NOT THE MAIN PRICE COLUMNS. CruiseFeed and the operator quote the same
 * sailing differently — CruiseFeed's docs note that 222 of 1,013 same-sailing
 * record pairs differ by more than 10%. On 2026-09-01 the daily favourites
 * refresh wrote CruiseFeed's number into the column the weekly scrape owns, and
 * Odyssey of the Seas began oscillating 2937.65 ↔ 1735.96 between runs. The
 * watchlist alerts at 10%, so that manufactured a **-40.9% drop** out of
 * nothing but a change of source. Two measurements of one thing belong in two
 * series; the alert compares like with like.
 *
 * Writes only the cf_* columns, so nothing here can disturb the scraped price,
 * its deltas, its history, or the plan flags.
 *
 * @returns {Map<string,object>} sailing_id → { prev, next, change_pct } for
 *   every sailing whose CruiseFeed price actually moved.
 */
export async function recordCruisefeedPrices(rows, now = new Date().toISOString()) {
  await loadEnvOnce();
  const key = SUPABASE_URL ? process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY : null;
  const list = (rows || []).filter((r) => r?.sailing_id
    && Number.isFinite(Number(r.lowest_balcony_per_person_usd)));
  if (!key || !list.length) return new Map();

  // Read the prior CruiseFeed values only — the scraped price is irrelevant here.
  const priors = new Map();
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50).map((r) => `"${String(r.sailing_id).replace(/"/g, "")}"`).join(",");
    const url = `${SUPABASE_URL}/rest/v1/${TABLE}`
      + `?select=sailing_id,cf_balcony_per_person_usd&sailing_id=in.(${encodeURIComponent(chunk)})`;
    try {
      const res = await fetch(url, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      for (const r of await res.json()) {
        priors.set(r.sailing_id, r.cf_balcony_per_person_usd === null ? null : Number(r.cf_balcony_per_person_usd));
      }
    } catch { /* a chunk we cannot read is simply not compared this run */ }
  }

  const moved = new Map();
  for (const r of list) {
    const next = Number(r.lowest_balcony_per_person_usd);
    const prev = priors.get(r.sailing_id) ?? null;
    const changePct = prev !== null && prev > 0 ? round2(((next - prev) / prev) * 100) : null;

    const patch = {
      cf_balcony_per_person_usd: next,
      cf_price_at: now,
      // Sticky, exactly like the scraped delta: only overwritten when the
      // CruiseFeed price actually moves, so a quiet week does not blank it.
      ...(prev !== null && next !== prev
        ? { cf_prev_balcony_per_person_usd: prev, cf_price_change_pct: changePct }
        : {}),
    };
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/${TABLE}?sailing_id=eq.${encodeURIComponent(r.sailing_id)}`,
        {
          method: "PATCH",
          headers: {
            apikey: key, Authorization: `Bearer ${key}`,
            "Content-Type": "application/json", Prefer: "return=minimal",
          },
          body: JSON.stringify(patch),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (res.ok && prev !== null && next !== prev) {
        moved.set(r.sailing_id, { prev, next, change_pct: changePct });
      }
    } catch { /* a row that fails to write is simply not alerted on */ }
  }
  return moved;
}


/**
 * ship name (lower-cased) → Cruise Critic member rating.
 *
 * Read by the filter so a well-reviewed ship can outrank the built-year floor.
 */
export async function loadShipRatings() {
  await loadEnvOnce();
  const key = SUPABASE_URL ? process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY : null;
  const out = new Map();
  if (!key) return out;
  try {
    const url = `${SUPABASE_URL}/rest/v1/cruise_ship_ratings?select=ship_name,rating&rating=not.is.null`;
    const res = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return out;
    for (const r of await res.json()) {
      if (r.ship_name && r.rating != null) out.set(String(r.ship_name).toLowerCase(), Number(r.rating));
    }
  } catch { /* no ratings simply means no override */ }
  return out;
}
