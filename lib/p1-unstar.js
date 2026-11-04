// p1-unstar — decide, from Gmail history records alone, which P1 messages
// the user unstarred (Signal A of the P1 resolution system).
//
// The rule (2026-10-04): a message is a user-unstar when Gmail history shows
// a `labelsRemoved` event carrying STARRED for it, Jori's own gmail-action
// did not make that removal (self-unstar ledger), and the message is STILL
// labelled p1 and STILL unstarred when we look. That replaces the old agent
// judgment "was this unstarred-P1 ever starred, or did it just inherit the p1
// label?" — a message that was never starred has no STARRED-removed event, so
// it is never a candidate.
//
// Pure and deterministic: history events and label sets are machine facts
// (same footing as p1-reply.js). No language read.

"use strict";

// historyRecords: Gmail users.history.list `history[]` entries.
// Returns the ids of messages that had STARRED removed, in first-seen order.
function unstarredIds(historyRecords) {
  const out = [];
  const seen = new Set();
  for (const h of historyRecords || []) {
    for (const ev of (h && h.labelsRemoved) || []) {
      const id = ev && ev.message && ev.message.id;
      if (!id || seen.has(id)) continue;
      if (Array.isArray(ev.labelIds) && ev.labelIds.includes("STARRED")) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

// ids: candidate message ids (from unstarredIds).
// current: { [id]: labelIds[] | null }  — null when the message is gone.
// p1LabelId: the Gmail label id of `p1`.
// selfUnstarred: Set of ids gmail-action unstarred itself (recent ledger).
// Returns { downgrade: [id], skipped: [{ id, reason }] }.
function decide({ ids, current, p1LabelId, selfUnstarred }) {
  const downgrade = [];
  const skipped = [];
  const self = selfUnstarred || new Set();
  for (const id of ids || []) {
    const labels = current ? current[id] : undefined;
    if (self.has(id)) { skipped.push({ id, reason: "self-unstar" }); continue; }
    if (!Array.isArray(labels)) { skipped.push({ id, reason: "gone" }); continue; }
    if (!labels.includes(p1LabelId)) { skipped.push({ id, reason: "not-p1" }); continue; }
    if (labels.includes("STARRED")) { skipped.push({ id, reason: "restarred" }); continue; }
    downgrade.push(id);
  }
  return { downgrade, skipped };
}

// ledgerRows: parsed rows of the self-unstar ledger ({ messageId, at }).
// Returns the Set of ids unstarred by Jori within `windowMs` of `now`.
function recentSelfUnstars(ledgerRows, now, windowMs) {
  const out = new Set();
  for (const r of ledgerRows || []) {
    const t = Date.parse(r && r.at);
    if (r && r.messageId && Number.isFinite(t) && now - t <= windowMs) out.add(r.messageId);
  }
  return out;
}

module.exports = { unstarredIds, decide, recentSelfUnstars };
