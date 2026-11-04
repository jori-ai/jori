// p1-push-fold.mjs — one push per P1 email, and one per near-simultaneous burst
// from the same sender on the same Gmail thread (2026-10-21).
//
// Why: one P1 email once produced two pushes ten seconds apart — the
// watchdog's stuck-unread sweep dispatched a RECLASSIFY for it while the
// delayed Gmail push dispatched the same message to triage, and each triage
// turn sent its own pointer. The same sender also bursts on its own: several
// "new mail" notices minutes apart on one thread became several pushes.
//
// The fold runs in jori-send-curl, after every other gate has decided to
// send, for any message that names its email with --p1-message <messageId>:
//
//   same message  pushed in the last 24 h                        → fold
//   same thread + same sender address, a push in the last
//     15 min, and that earlier email is still UNREAD              → fold
//   anything else                                                → send, and
//                                                                  record it
//
// "About the same thing" is Gmail's own threading, never a reading of the text
// (Rule #0b): message id, thread id, the From address, timestamps and the UNREAD
// label are all machine structure. The unread condition is what keeps a human
// follow-up safe: once the user has opened the earlier email, a new one on the thread
// pushes again. A folded email is untouched in Gmail (still P1, starred,
// unread) and its task already merges by thread (lib/p1-task.js), so the
// only thing folded away is a second banner pointing at the same place.
//
// FAILS OPEN: an unreadable message, a Gmail error, a lock timeout or any
// exception means send. Off switch: data/.p1-push-fold-off.
// CLI: bin/p1-push-fold. Test: tests/p1-push-fold.test.mjs.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { withFileLock } = require("./file-lock.js");

const { installTools } = require("./root.cjs");
const DATA = installTools("data");
export const LEDGER = process.env.P1_PUSH_FOLD_LEDGER || path.join(DATA, "p1-push-ledger.jsonl");
export const LOG = process.env.P1_PUSH_FOLD_LOG || path.join(DATA, "p1-push-fold-log.jsonl");
export const OFF_FILE = process.env.P1_PUSH_FOLD_OFF || path.join(DATA, ".p1-push-fold-off");

const envMin = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
export const THREAD_WINDOW_MS = envMin("P1_PUSH_FOLD_WINDOW_MIN", 15) * 60_000;
export const SAME_MESSAGE_MS = 24 * 60 * 60_000;

/** The address inside "Name <addr>", lowercased. Header structure, not language. */
export function senderAddr(from) {
  const s = String(from || "");
  const lt = s.lastIndexOf("<"), gt = s.lastIndexOf(">");
  return (lt !== -1 && gt > lt ? s.slice(lt + 1, gt) : s).trim().toLowerCase();
}

export function readLedger(file = LEDGER) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.messageId && r.sent_at);
  } catch { return []; }
}

function writeLedger(rows, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  fs.renameSync(tmp, file);
}

function appendLog(row, file) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(row) + "\n"); } catch {}
}

/**
 * Pure: the earlier push this one would fold into, or null.
 * `cur` = {messageId, threadId, sender}. Same message wins over same thread.
 */
export function findPrior(rows, cur, nowMs, { threadWindowMs = THREAD_WINDOW_MS, sameMessageMs = SAME_MESSAGE_MS } = {}) {
  const age = (r) => nowMs - Date.parse(r.sent_at);
  const latest = (xs) => xs.sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at))[0] || null;
  const same = latest(rows.filter((r) => r.messageId === cur.messageId && age(r) >= 0 && age(r) < sameMessageMs));
  if (same) return { kind: "same-message", prior: same };
  if (!cur.threadId || !cur.sender) return null;
  const sib = latest(rows.filter((r) => r.messageId !== cur.messageId && r.threadId === cur.threadId
    && r.sender === cur.sender && age(r) >= 0 && age(r) < threadWindowMs));
  return sib ? { kind: "same-thread", prior: sib } : null;
}

/**
 * Pure: fold or send, given the prior (from findPrior) and whether that prior
 * email is still unread: true / false / "error" (Gmail could not say) / null
 * (not looked up: a sibling claimed after our pre-lock read).
 */
export function decide(found, priorUnread) {
  if (!found) return { action: "send", reason: "no-earlier-push" };
  if (found.kind === "same-message") return { action: "fold", reason: "same-message" };
  if (priorUnread === false) return { action: "send", reason: "earlier-email-already-read" };
  if (priorUnread === "error") return { action: "send", reason: "unread-lookup-failed" };
  // null: pushed seconds ago by a concurrent sender, so the user cannot have read it.
  return { action: "fold", reason: "same-thread-unread" };
}

// ---- Gmail (structure only: thread id, From header, labels) ----------------

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gfetch(pathAndQuery, timeoutMs) {
  const { getAccessToken } = require("./google-auth.js");
  const tok = await getAccessToken();
  const res = await fetch(`${API}${pathAndQuery}`, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Gmail ${res.status}`);
  return res.json();
}

export async function gmailMeta(messageId, { timeoutMs = 6000 } = {}) {
  const m = await gfetch(`/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From`, timeoutMs);
  const from = (m.payload?.headers || []).find((h) => String(h.name).toLowerCase() === "from")?.value || "";
  return { threadId: m.threadId || null, sender: senderAddr(from) || null, unread: (m.labelIds || []).includes("UNREAD") };
}

/**
 * Decide and, on send, record — atomically against concurrent senders.
 * deps: {meta(id) → {threadId, sender, unread}, now(), ledger, log, offFile}
 * Returns {action: "send"|"fold", reason, messageId, threadId, sender, prior?}.
 */
export async function claim(messageId, deps = {}) {
  const ledger = deps.ledger || LEDGER;
  const log = deps.log || LOG;
  const now = deps.now ? deps.now() : Date.now();
  const meta = deps.meta || gmailMeta;
  const ts = new Date(now).toISOString();
  if (!messageId) return { action: "send", reason: "no-message-id" };
  if (fs.existsSync(deps.offFile || OFF_FILE)) return { action: "send", reason: "off-switch", messageId };

  // Network first, outside the lock: this email's thread and sender, then the
  // unread state of any earlier push on that thread already in the ledger.
  let cur = { messageId, threadId: null, sender: null };
  try { const m = await meta(messageId); cur = { messageId, threadId: m.threadId, sender: m.sender }; } catch {}
  const pre = findPrior(readLedger(ledger), cur, now, deps.windows);
  const unread = new Map();
  if (pre?.kind === "same-thread") {
    try { unread.set(pre.prior.messageId, (await meta(pre.prior.messageId)).unread); } catch { unread.set(pre.prior.messageId, "error"); }
  }

  const out = withFileLock(ledger, () => {
    const rows = readLedger(ledger);
    const found = findPrior(rows, cur, now, deps.windows);
    const d = decide(found, found ? (unread.has(found.prior.messageId) ? unread.get(found.prior.messageId) : null) : null);
    const res = { ...d, ...cur, ...(found ? { prior: { messageId: found.prior.messageId, sent_at: found.prior.sent_at } } : {}) };
    if (d.action === "send") {
      const keepMs = Math.max(SAME_MESSAGE_MS, (deps.windows?.threadWindowMs) || THREAD_WINDOW_MS);
      const kept = rows.filter((r) => now - Date.parse(r.sent_at) < keepMs);
      kept.push({ messageId, threadId: cur.threadId, sender: cur.sender, sent_at: ts });
      writeLedger(kept, ledger);
    }
    return res;
  });
  appendLog({ ts, ...out }, log);
  return out;
}

/** Forget a claimed push whose message never posted (so a retry is not folded). */
export function release(messageId, deps = {}) {
  const ledger = deps.ledger || LEDGER;
  if (!messageId) return 0;
  return withFileLock(ledger, () => {
    const rows = readLedger(ledger);
    // Only the newest claim for this id: an older successful push stays recorded.
    let idx = -1;
    rows.forEach((r, i) => { if (r.messageId === messageId && (idx === -1 || Date.parse(r.sent_at) >= Date.parse(rows[idx].sent_at))) idx = i; });
    if (idx === -1) return 0;
    rows.splice(idx, 1);
    writeLedger(rows, ledger);
    appendLog({ ts: new Date().toISOString(), action: "release", messageId }, deps.log || LOG);
    return 1;
  });
}
