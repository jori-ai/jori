// p1-reply — decide, from a Gmail thread's message list alone, whether the
// user has replied on a live P1 and which P1 message(s) that reply resolves.
//
// The rule (2026-09-11): a starred `p1` message is handled once a LATER message
// in the same thread carries Gmail's SENT label — the user's reply from Gmail,
// or a `gmail-action send --from <owner address>` on their behalf. Drafts
// never count (nothing has been sent yet). A newer inbound after the reply
// means the thread is waiting on the user again: the newest message is not SENT, so
// nothing is resolved — and normal triage's reply-to-me rule has already
// re-flagged that inbound as P1.
//
// Pure and deterministic: thread membership, label sets and timestamps are
// machine facts (same footing as gmail-action reply-to-me). No language read.

"use strict";

function ts(m) { return parseInt(m && m.internalDate, 10) || 0; }
function has(m, label) { return Array.isArray(m && m.labelIds) && m.labelIds.includes(label); }

// messages: Gmail threads.get messages (id, internalDate, labelIds).
// p1LabelId: the user label id behind `p1` (e.g. Label_28).
// Returns { resolved: [<p1 messageId>...], replyId, replyAt } — resolved is
// empty unless the newest non-draft message is SENT and at least one starred
// p1 message is older than it.
function decideThread(messages, p1LabelId) {
  const live = (messages || []).filter((m) => m && m.id && !has(m, "DRAFT"));
  if (!live.length) return { resolved: [], replyId: null, replyAt: null };
  const newest = live.reduce((a, b) => (ts(b) > ts(a) ? b : a));
  if (!has(newest, "SENT")) return { resolved: [], replyId: null, replyAt: null };
  const resolved = live
    .filter((m) => m.id !== newest.id && has(m, p1LabelId) && has(m, "STARRED") && ts(m) < ts(newest))
    .map((m) => m.id);
  return {
    resolved,
    replyId: resolved.length ? newest.id : null,
    replyAt: resolved.length ? new Date(ts(newest)).toISOString() : null,
  };
}

module.exports = { decideThread };
