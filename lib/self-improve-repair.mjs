// self-improve-repair — what the approval poller does after an approved card
// went in but is not running (lib/self-improve-live.mjs said not live), and
// after the fix for such a card went in. Kept out of bin/self-improve-approval-poll
// so both halves are tested (tests/self-improve-repair.test.mjs).
//
// Why. On 2026-11-15 the Shows seen card was "In, not running: its tests fail."
// and every Retry re-ran the identical check and failed identically; nothing
// was fixing it. Now:
//   - failing tests new with the card (result.tests_failed) → a repair is
//     queued once (lib/self-improve-rebuild.mjs, kind "repair"), its request id
//     is stored on the row (result.repair_request: the app reads "In, being
//     fixed"), and the notice says a fix is coming as a fresh card;
//   - when that fix card is applied and running, the original is checked again
//     the same way and, if it now runs, marked applied (result.repaired_by). Its
//     own Retry would re-write files the fix has since changed.
// Anything else that stops a card (a plugin left off, a schedule missing) is
// not something a code fix repairs and still waits for Retry.

import { queueCardRebuild } from "./self-improve-rebuild.mjs";

/**
 * After a not-live apply. Queues a repair when failing tests are what stops it.
 * @param {{o: {id, result}, row?: object, retried?: boolean, title: string, root: string,
 *   update: (id, patch) => Promise, queue?: Function, log?: Function}} a
 * @returns {Promise<{message: string, requestId: string|null}>}
 */
export async function notLiveFollowUp({ o, row, retried = false, title, root, update, queue = queueCardRebuild, log = () => {} }) {
  const r = o.result || {};
  const head = `${retried ? `I retried "${title}"` : `"${title}" is in the code`} but it is not running: ${r.error}`;
  if (!r.tests_failed) {
    return { requestId: null, message: `⚠️ ${head} The card shows it as failed. Tap Retry on it once that's fixed, or ask me in chat.` };
  }
  const rp = queue({ root, row: row || { id: o.id }, error: r.error, kind: "repair", failures: r.failures || [] });
  log(rp.queued ? `${o.id} queued for repair as build request ${rp.requestId}` : `${o.id} not repaired: ${rp.reason}`);
  // A fresh repair, or one already queued by an earlier tick of this card.
  const requestId = rp.queued || rp.kind === "repair" ? rp.requestId || null : null;
  // The apply just rewrote the row's result; put the request id back on it.
  if (requestId) { try { await update(o.id, { result: { ...r, repair_request: requestId } }); } catch { /* the notice still says it */ } }
  let tail;
  if (rp.queued) tail = "I'm fixing it now: the fix comes back as a fresh card for your Face ID, and this one turns green once the fix is in.";
  else if (rp.kind === "repair") tail = "The fix I started for it is still on its way as a fresh card.";
  else if (rp.kind === "rebuild") tail = "A rebuild of it is already queued; it comes back as a fresh card for your Face ID.";
  else if (rp.already) tail = "This card was itself a fix, so I won't start another one on my own. Ask me in chat, or tap Retry once it's sorted.";
  else tail = "The card shows it as failed. Tap Retry on it once that's fixed, or ask me in chat.";
  return { requestId, message: `⚠️ ${head} ${tail}` };
}

/**
 * A fix card (item_json.rebuild_of = origId) was just applied and runs. If the
 * original is still not running, check it again and settle it. Never throws.
 * @param {{origId: string, fixId: string, fixTitle: string,
 *   store: {getApproval: Function, updateApproval: Function},
 *   goLive: (rels: string[], commitMsg: string) => Promise<{ok, error?, notes}>,
 *   commitMsgOf: (row) => string, confirm: (text) => Promise, log?: Function}} a
 * @returns {Promise<"applied"|"still-failing"|"skipped"|"error">}
 */
export async function settleRepaired({ origId, fixId, fixTitle, store, goLive, commitMsgOf, confirm, log = () => {} }) {
  try {
    const x = await store.getApproval(origId);
    if (!x || x.status !== "apply_failed" || !x.result?.not_live || !Array.isArray(x.result.files) || !x.result.files.length) return "skipped";
    const live = await goLive(x.result.files, commitMsgOf(x));
    const title = x.summary || origId;
    if (live.ok) {
      const { tests_failed, failures, error, ...kept } = x.result;
      await store.updateApproval(origId, { status: "applied", result: { ...kept, ok: true, not_live: false, repaired_by: fixId, notes: live.notes || [] } });
      log(`${origId} running after repair ${fixId}`);
      await confirm(`✅ "${title}" is running now too: "${fixTitle}" fixed what stopped it. ${(live.notes || []).join(" ")}`.trim());
      return "applied";
    }
    await store.updateApproval(origId, { result: { ...x.result, error: live.error, notes: live.notes || [], checked_after: fixId } });
    log(`${origId} still not running after repair ${fixId}: ${live.error}`);
    await confirm(`⚠️ "${fixTitle}" went in, but "${title}" still isn't running: ${live.error} Ask me in chat, or tap Retry on it.`);
    return "still-failing";
  } catch (e) {
    log(`settle ${origId} after ${fixId} failed: ${e?.message || e}`);
    return "error";
  }
}
