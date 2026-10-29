// hum-interventions-reconcile — backfills hum-interventions.jsonl rows staged
// by hum-action-executor's approval-gated path (2026-08-23) once their
// self_improve_approvals Face-ID card has actually landed.
//
// REGRESSION GUARD: hum-i-20260823-04.
// hum-action-executor.md Step 3 stages every jori_autonomous idea as a
// self-improve-request Face-ID card instead of committing directly. The
// hum-interventions.jsonl row it appends carries `commit: null` +
// `approval_id: "<uuid>"` in place of a commit sha, because nothing in the
// shared self-improve-approval-poll machinery tags its own commit message
// with a `[hum-intervention id=...]` trailer on this caller's behalf (see
// that file's applyItem() — it writes a fixed
// "self-improve: apply owner-approved fix (Face-ID) — <summary>" message with
// no hook for one). hum-metrics-collect --measure's own guard
// (`commit in (None, "pending")` -> skip) then leaves the row stuck FOREVER,
// however long it waits: the 7-day before/after attribution measurement never
// runs for anything approved through this path. As of 2026-09-10 five real
// rows are stuck this way (hum-i-20260802-04, -0809-01, -0809-02, -0816-01,
// -0816-04), all still `awaiting_approval` days to weeks after filing.
//
// This module is the pure half of the fix — option (b) from hum-i-20260823-04
// (a small reconciliation pass, not a change to the generic self-improve
// approval machinery on behalf of one caller). bin/hum-interventions-
// reconcile is the IO half: it fetches the matching self_improve_approvals
// row, recovers the commit sha applyItem() never stores anywhere by
// reconstructing its own deterministic commit-message template and looking it
// up in git history (self_improve_approvals has no commit-sha column at all —
// applyItem()'s gitCommit() only ever records the string "committed" or an
// error, never a sha), and calls reconcileRows() below to fold the result
// back into hum-interventions.jsonl. Split out (mirrors
// lib/system-issue-writeback.mjs) so the merge/pick logic is
// unit-testable without a live Supabase row or a real git history.

/** Matches `jori hum intervention record`'s own measure_at math
 * (bin/jori cmdHumIntervention) — 7 days from applied_at. */
export const MEASURE_WINDOW_MS = 7 * 24 * 3600 * 1000;

/**
 * The exact commit message self-improve-approval-poll's applyItem() writes
 * for this approval — reconstructed from the SAME row fields and the SAME
 * template applyItem() uses (row.summary/row.id for a code-fix, item_json.name
 * for a new-capability) — so `git log -F --grep=<this>` finds the landed
 * commit without applyItem ever having recorded its own sha anywhere.
 *
 * Every hum idea stages via `--type code-fix` (hum-action-executor.md Step
 * 3.3), so the new-capability branch is defensive, not the common case.
 */
export function expectedCommitMessage(approvalRow) {
  const label = approvalRow?.summary || approvalRow?.id;
  if (approvalRow?.item_type === "new-capability") {
    return `self-improve: load owner-approved capability '${approvalRow?.item_json?.name || label}' (Face-ID)`;
  }
  return `self-improve: apply owner-approved fix (Face-ID) — ${label}`;
}

/** Repo-relative paths applyItem() recorded as written for this approval —
 * used only to disambiguate when more than one commit shares the identical
 * message (e.g. two different ideas that happened to land on the same
 * title). */
export function approvalFiles(approvalRow) {
  const files = approvalRow?.result?.files;
  return Array.isArray(files) ? files.filter((f) => typeof f === "string") : [];
}

/**
 * Choose the one commit this approval actually produced out of every git-log
 * candidate whose message matched.
 *
 *   0 candidates  -> null. Not committed yet under this exact message (or
 *                    never will be) — caller leaves the row alone and tries
 *                    again next run.
 *   1 candidate   -> it, unconditionally.
 *   2+ candidates -> prefer whichever overlaps `approvalFiles(approvalRow)`
 *                    (only meaningful when the caller attached a `.files`
 *                    array per candidate — bin/hum-interventions-
 *                    reconcile only bothers fetching that when there's more
 *                    than one candidate to break the tie). Among remaining
 *                    ties, whichever candidate's `.iso` author date is
 *                    closest to `approvalRow.applied_at`.
 *
 * This never invents an answer for a genuine tie it can't break — it just
 * falls through to "closest in time", which is a deterministic ordering over
 * machine-generated timestamps (Rule 0b: geometry, not meaning), not a guess
 * at what the user intended.
 *
 * @param {{sha: string, iso?: string, files?: string[]}[]} candidates
 * @param {object} approvalRow
 * @returns {string|null}
 */
export function pickCommit(candidates, approvalRow) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  if (candidates.length === 1) return candidates[0].sha;

  const wanted = new Set(approvalFiles(approvalRow));
  const overlaps = (c) => Array.isArray(c.files) && c.files.some((f) => wanted.has(f));
  const pool = wanted.size && candidates.some(overlaps) ? candidates.filter(overlaps) : candidates;
  if (pool.length === 1) return pool[0].sha;

  const appliedMs = Date.parse(approvalRow?.applied_at || "");
  if (!Number.isFinite(appliedMs)) return pool[0].sha; // no better tiebreaker available

  let best = pool[0];
  let bestDelta = Math.abs(Date.parse(best.iso || "") - appliedMs);
  for (const c of pool.slice(1)) {
    const delta = Math.abs(Date.parse(c.iso || "") - appliedMs);
    if (Number.isFinite(delta) && delta < bestDelta) {
      best = c;
      bestDelta = delta;
    }
  }
  return best.sha;
}

/**
 * Pure merge. `resolved` maps approval_id -> { commitSha, appliedAt } for
 * every approval id the caller could actually resolve to a landed commit
 * (already filtered to status:"applied" with a usable applied_at and a
 * recovered commit sha). Accepts either a Map or a plain object.
 *
 * Only rows with `commit == null` AND a string `approval_id` present in
 * `resolved` are touched; every other row — already backfilled, still
 * unresolved, or nothing to do with this path at all — is returned by the
 * SAME reference, so nothing else in the file can drift.
 *
 * measure_at is computed here (applied_at + 7d) rather than left for a later
 * pass: hum-action-executor.md Step 3.5 appends the row with measure_at
 * already null (it can't be known before the approval lands), so without
 * this the backfilled row would still never clear hum-metrics-collect's own
 * `if not measure_at: continue` guard — commit + applied_at alone is not
 * enough to actually unstick measurement.
 *
 * @param {object[]} rows            parsed hum-interventions.jsonl rows
 * @param {Map<string,{commitSha:string,appliedAt:string}>|Record<string,{commitSha:string,appliedAt:string}>} resolved
 * @returns {{rows: object[], changed: boolean, updates: {id:string, approval_id:string, commit:string}[]}}
 */
export function reconcileRows(rows, resolved) {
  const updates = [];
  let changed = false;
  const lookup = (id) => (resolved instanceof Map ? resolved.get(id) : resolved?.[id]);

  const out = (Array.isArray(rows) ? rows : []).map((row) => {
    if (!row || typeof row !== "object") return row;
    if (row.commit != null) return row; // already backfilled, or shipped the ordinary way
    const approvalId = row.approval_id;
    if (typeof approvalId !== "string" || !approvalId) return row;
    const res = lookup(approvalId);
    if (!res || !res.commitSha || !res.appliedAt) return row;
    const appliedMs = Date.parse(res.appliedAt);
    if (!Number.isFinite(appliedMs)) return row;

    changed = true;
    updates.push({ id: row.id, approval_id: approvalId, commit: res.commitSha });
    return {
      ...row,
      commit: res.commitSha,
      applied_at: res.appliedAt,
      measure_at: row.measure_at || new Date(appliedMs + MEASURE_WINDOW_MS).toISOString(),
      status: "applied",
    };
  });

  return { rows: out, changed, updates };
}
