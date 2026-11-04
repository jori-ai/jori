// Re-gate the stored corpus against the CURRENT travel plan.
//
// WHY. `is_reachable` / `is_match` / `matched_*` are written by the upsert, and
// the upsert only touches the sailings a run actually observed. Everything else
// kept whatever the plan said the last time it was seen — so when the plan
// moved (one home city until mid-month, the other only after it), the site
// went on calling ~75 departures from the second city "matches my travel plan"
// under windows like `2026-10-29..2026-11-30` that no longer existed, while
// departures from the first city in the new window stayed hidden. The plan is the input; the
// flags are a function of it; they must be recomputed for every row, every run.
//
// The gate is the same `applyFilters` the scrape uses, fed the stored columns,
// so a re-gated row lands exactly where a fresh scrape would have put it.

/** Columns the gate needs, plus the current flags to diff against. */
export const REGATE_COLUMNS = [
  "sailing_id",
  "source",
  "ship_name",
  "departure_port",
  "departure_port_code",
  "depart_date",
  "nights",
  "lowest_balcony_per_person_usd",
  "taxes_fees_included",
  "is_match",
  "is_reachable",
  "matched_port",
  "matched_city",
  "matched_window",
  "matched_window_assumed",
];

/** A stored row → the shape applyFilters reads (numbers as numbers). */
export function sailingFromRow(r) {
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  return {
    sailing_id: r.sailing_id,
    source: r.source,
    ship_name: r.ship_name,
    departure_port: r.departure_port,
    departure_port_code: r.departure_port_code,
    depart_date: r.depart_date,
    nights: num(r.nights),
    lowest_balcony_per_person_usd: num(r.lowest_balcony_per_person_usd),
    taxes_fees_included: r.taxes_fees_included,
  };
}

/**
 * The plan flags each row should carry, given applyFilters' output.
 * @returns {Map<string, object>} sailing_id → flag fields
 */
export function gateTargets(rows, { matches, reachable }) {
  const matchIds = new Set((matches || []).map((s) => s.sailing_id));
  const byId = new Map((reachable || []).map((s) => [s.sailing_id, s]));
  const out = new Map();
  for (const r of rows) {
    const s = byId.get(r.sailing_id);
    out.set(r.sailing_id, s
      ? {
          is_reachable: true,
          is_match: matchIds.has(r.sailing_id),
          matched_port: s.matched_port ?? null,
          matched_city: s.matched_city ?? null,
          matched_window: s.matched_window ?? null,
          matched_window_assumed: s.matched_window_assumed === true,
        }
      : {
          is_reachable: false,
          is_match: false,
          matched_port: null,
          matched_city: null,
          matched_window: null,
          matched_window_assumed: false,
        });
  }
  return out;
}

/**
 * Rows whose stored flags differ from their target, grouped by identical
 * target so each group is one PATCH (`sailing_id=in.(…)`).
 * @returns {{fields: object, ids: string[]}[]}
 */
export function regatePatches(rows, targets) {
  const groups = new Map();
  for (const r of rows) {
    const t = targets.get(r.sailing_id);
    if (!t) continue;
    const same = Object.keys(t).every((k) => (r[k] ?? null) === (t[k] ?? null)
      || (typeof t[k] === "boolean" && !!r[k] === t[k]));
    if (same) continue;
    const key = JSON.stringify(t);
    if (!groups.has(key)) groups.set(key, { fields: t, ids: [] });
    groups.get(key).ids.push(r.sailing_id);
  }
  return [...groups.values()];
}
