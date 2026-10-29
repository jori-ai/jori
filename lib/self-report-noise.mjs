// self-report-noise — how often Jori is wrong about Jori, as a number.
//
// Why: in one weekly Self Improvement Review, 13 of the 25 fixes the user
// signed were the system misdescribing its own state
// — a photo gap-recovery reporting successes as failures, a portfolio memo
// paged missing because its report said "unauthorized", a daily-summary
// success read as a failure — and system-issue-review already marked 18 of 68
// alert clusters `severity: "noise"`. Nobody tracked it as a number, so each
// one arrived as an unrelated surprise and cost its own root-cause pass.
//
// The design: RECOMPUTE every week from state that already exists. No
// running counter (a counter is one more thing that can drift from the truth
// and need its own watchdog). Two independent signals:
//
//   1. Alerts — system-issue-review-state.json clusters. `severity: "noise"`
//      is that job's own verdict that an alert was wrong or reported a
//      self-healing event as a problem. Pure arithmetic over a field.
//
//   2. Fixes — self_improve_approvals rows applied in the window. A fix counts
//      as a self-misreport fix when
//        (a) it is linked to a noise cluster (attempts[].approval_id — the
//            same linkage system-issue-writeback uses), which is structural, or
//        (b) a MODEL read its summary and said its subject is Jori
//            misdescribing its own state. That judgment is language, so it is
//            never made here (Rule #0b): the caller passes it in as `labels`,
//            and every applied card with neither a link nor a label is
//            returned as `unlabelled` so the caller knows the number is not
//            final yet.
//
// Pure: no I/O. bin/self-report-noise-rate does the reading.

import { clusterCarriesApproval, idMatches } from "./system-issue-writeback.mjs";

const ratio = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 1000 : null);

function inWindow(iso, sinceMs, nowMs) {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= sinceMs && t <= nowMs;
}

/**
 * @param {object}   opts
 * @param {object[]} opts.clusters  system-issue-review-state.json `clusters`
 * @param {object[]} opts.cards     self_improve_approvals rows, status applied
 *                                  ({id, summary, risk, applied_at})
 * @param {object}   [opts.labels]  { <card id or 8+ char prefix>: boolean } —
 *                                  the model's reading of each card's subject
 * @param {number}   opts.sinceMs   window start (epoch ms)
 * @param {number}   opts.nowMs     window end (epoch ms)
 */
export function computeSelfReportNoise({ clusters = [], cards = [], labels = {}, sinceMs, nowMs }) {
  const all = (Array.isArray(clusters) ? clusters : []).filter((c) => c && typeof c === "object");
  const isNoise = (c) => c.severity === "noise";

  // A cluster is "this week's" when it fired inside the window.
  const active = all.filter((c) => inWindow(c.last_seen, sinceMs, nowMs));
  const activeNoise = active.filter(isNoise);
  const noiseClusters = all.filter(isNoise);

  const applied = (Array.isArray(cards) ? cards : [])
    .filter((r) => r && r.id && inWindow(r.applied_at, sinceMs, nowMs));

  const labelFor = (id) => {
    for (const [k, v] of Object.entries(labels || {})) {
      if (typeof v === "boolean" && idMatches(k, id)) return v;
    }
    return undefined;
  };

  const linked = [];
  const labelledTrue = [];
  const labelledFalse = [];
  const unlabelled = [];
  for (const card of applied) {
    const cluster = noiseClusters.find((c) => clusterCarriesApproval(c, card.id));
    if (cluster) { linked.push({ id: card.id, cluster_id: cluster.id }); continue; }
    const l = labelFor(card.id);
    if (l === true) labelledTrue.push(card.id);
    else if (l === false) labelledFalse.push(card.id);
    else unlabelled.push({ id: card.id, summary: card.summary || "", risk: card.risk || null });
  }
  const misreport = linked.length + labelledTrue.length;
  const signed = applied.filter((r) => (r.risk || "high") === "high").length;

  return {
    window: { since: new Date(sinceMs).toISOString(), until: new Date(nowMs).toISOString() },
    alerts: {
      clusters_active: active.length,
      noise_active: activeNoise.length,
      noise_rate: ratio(activeNoise.length, active.length),
      noise_active_ids: activeNoise.map((c) => c.id),
      clusters_all_time: all.length,
      noise_all_time: noiseClusters.length,
      noise_rate_all_time: ratio(noiseClusters.length, all.length),
    },
    fixes: {
      applied: applied.length,
      applied_signed: signed,
      applied_auto: applied.length - signed,
      self_misreport: misreport,
      // Over every applied fix, with the unlabelled ones counted as NOT
      // misreports — a floor, final only when `complete` is true.
      self_misreport_rate: ratio(misreport, applied.length),
      complete: unlabelled.length === 0,
      linked_to_noise_cluster: linked,
      labelled_misreport: labelledTrue,
      labelled_not_misreport: labelledFalse,
      unlabelled,
    },
  };
}
