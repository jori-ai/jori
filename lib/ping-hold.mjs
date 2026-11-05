// ping-hold — the re-ping list for non-urgent pushes sent while the user is moving.
//
// Paired with lib/motion-state.mjs and drained by bin/ping-flush.
//
// SINCE 2026-11-05 NOTHING IS HELD BACK. A push sent while the user walks or
// drives goes out at once (so AirPods and CarPlay read it aloud) and is noted
// here with `sent_at`. When the user stops, ping-flush re-pings it once if its
// message is still unread: the buzz that landed in a pocket with no
// headphones gets a second chance, and one already read is dropped. Entries
// without `sent_at` are alerts the old gate parked; they flush as before.
//
// WHAT IS ACTUALLY BEING DEFERRED. Only the ALERT — never the content. Every
// user-facing ping reaches the phone by two independent paths: the row in
// `jori_messages` (written first, by jori-send) and the APNs banner that
// announces it. Holding the banner leaves the message sitting in the app,
// readable the moment the user opens it. That is what makes this safe to do at the
// chokepoint: the worst case for a held ping is a late buzz, never lost words.
//
// It is also why expiry is not data loss. A proximity rec that went stale while
// the user walked on is worth less than the interruption it would cost, and the text
// is still in the thread if the user goes looking.

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";

import { installTools } from "./root.cjs";
import { assistantName } from "./instance.cjs";
// JORI_PING_QUEUE overrides the path so tests (and a dry run) never touch
// the live queue.
export const QUEUE_FILE =
  process.env.JORI_PING_QUEUE ||
  installTools("data/ping-hold-queue.json");

// Past this, a held alert is no longer worth a buzz — the moment it belonged to
// has passed. The message itself stays in the app either way.
export const MAX_HOLD_MS = 90 * 60 * 1000;

// A runaway producer must not turn this file into a megabyte of stale pings.
// Oldest are dropped first; they were closest to expiring anyway.
export const MAX_QUEUE = 50;

export function readQueue(file = QUEUE_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeQueue(entries, file = QUEUE_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Atomic: ping-flush and every held send read this; a torn read is [] (D15).
    writeFileAtomic(file, JSON.stringify(entries, null, 2));
    return true;
  } catch (err) {
    console.error(`[ping-hold] queue write failed: ${err?.message || err}`);
    return false;
  }
}

/**
 * Park one push for later. Returns the stored entry.
 */
export function holdPing(entry, { file = QUEUE_FILE, nowMs = Date.now() } = {}) {
  const stored = {
    body: entry.body,
    title: entry.title || assistantName(),
    messageId: entry.messageId || null,
    channel: entry.channel || "chat",
    held_at: new Date(nowMs).toISOString(),
    reason: entry.reason || "mobile",
  };
  if (entry.sentAt) stored.sent_at = entry.sentAt;
  const queue = [...readQueue(file), stored].slice(-MAX_QUEUE);
  writeQueue(queue, file);
  return stored;
}

/**
 * Split a queue into what still deserves a buzz and what has gone stale. Pure.
 *
 * @returns {{due: object[], expired: object[]}}
 */
export function partitionQueue(entries, nowMs = Date.now(), maxAgeMs = MAX_HOLD_MS) {
  const due = [];
  const expired = [];
  for (const e of entries) {
    const t = Date.parse(e?.held_at ?? "");
    // An entry with no readable timestamp cannot be aged out on evidence, so
    // deliver it rather than silently dropping it — fail open, as everywhere
    // else on this path.
    if (!Number.isFinite(t)) due.push(e);
    else if (nowMs - t > maxAgeMs) expired.push(e);
    else due.push(e);
  }
  return { due, expired };
}

/**
 * Collapse a batch of due pings into one push per channel, so a 40-minute walk
 * that queued four pings costs one buzz instead of four. Pure.
 *
 * Channels stay separate because they mean different things downstream: `chat`
 * carries a badge count, `system` deliberately never touches the badge.
 * The newest ping supplies the visible text and the deep link — it is the one
 * most likely to still matter — and the rest are acknowledged by a count.
 */
export function coalesce(due) {
  const byChannel = new Map();
  for (const e of due) {
    const ch = e.channel || "chat";
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch).push(e);
  }

  const pushes = [];
  for (const [channel, entries] of byChannel) {
    const sorted = [...entries].sort(
      (a, b) => (Date.parse(a.held_at ?? "") || 0) - (Date.parse(b.held_at ?? "") || 0)
    );
    const newest = sorted[sorted.length - 1];
    const extra = sorted.length - 1;
    pushes.push({
      body: extra > 0 ? `${newest.body} (+${extra} more)` : newest.body,
      title: newest.title || assistantName(),
      messageId: newest.messageId || null,
      channel,
      count: sorted.length,
    });
  }
  return pushes;
}

/**
 * Of the pushes already sent while the user was moving, which deserve one more
 * buzz now? Only those whose message is still unread. Pure.
 *
 * @param {object[]} sent         queue entries carrying `sent_at`
 * @param {Map<string, boolean>|null} readById  message id → read flag, from
 *                                jori_messages; null when the lookup failed
 * @returns {{reping: object[], skipped: Array<{entry, reason}>}}
 */
export function selectRepings(sent, readById) {
  const reping = [], skipped = [];
  for (const e of sent || []) {
    // It already buzzed once. Without the read flag there is no evidence it was
    // missed, so a failed lookup or a vanished row costs no second buzz.
    if (!readById) skipped.push({ entry: e, reason: "read state unavailable" });
    else if (!e?.messageId || !readById.has(e.messageId)) skipped.push({ entry: e, reason: "message gone" });
    else if (readById.get(e.messageId)) skipped.push({ entry: e, reason: "already read" });
    else reping.push(e);
  }
  return { reping, skipped };
}
