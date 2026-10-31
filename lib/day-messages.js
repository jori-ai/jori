"use strict";
// day-messages — the day's iMessage, WhatsApp and Slack messages for the daily
// summary harvest (lib/daily-summary-harvest.js), both directions,
// 1:1 and groups.
//
// The daily summary includes all relevant messages. Which messages are
// relevant is the narrator's reading (Rule #0b), so code
// hands it the day's conversations and only bounds the volume by STRUCTURE:
//   - every 1:1 conversation, up to DIRECT_MAX messages per chat;
//   - a group the user wrote in that day: up to GROUP_ACTIVE_MAX (the user's own always kept);
//   - a group the user only read: its last GROUP_PASSIVE_MAX messages;
//   - reactions, protocol rows, story/status broadcasts and newsletters dropped.
// Whatever the caps cut is counted in `dropped`, never hidden.
//
// Sources (each fail-open with its own error):
//   imessage  ~/Library/Messages/chat.db via imessage-db.js (decodes attributedBody)
//   whatsapp  data/whatsapp-inbox.jsonl (gateway log; the user's own phone-typed
//             messages are logged as from_me, Jori's sends as kind "sent")
//   slack     data/slack-inbox.jsonl (slack-channel socket log)

const fs = require("fs");
const { spawnSync } = require("child_process");
const path = require("path");
const { installTools } = require("./root.cjs");

const DATA = installTools("data");
const WA_INBOX = process.env.DAY_MESSAGES_WA_INBOX || path.join(DATA, "whatsapp-inbox.jsonl");
const SLACK_INBOX = process.env.DAY_MESSAGES_SLACK_INBOX || path.join(DATA, "slack-inbox.jsonl");

const TEXT_MAX = 300;
const DIRECT_MAX = 80;
const GROUP_ACTIVE_MAX = 60;
const GROUP_PASSIVE_MAX = 12;

const inWindow = (ms, w) => Number.isFinite(ms) && ms >= w.startMs && ms < w.endMs;
const trim = (s) => String(s || "").trim().slice(0, TEXT_MAX);

// A text that is only a bracketed placeholder ("[reactionMessage]") carries no words.
function hasWords(text) {
  const t = String(text || "").trim();
  return !!t && !(t.startsWith("[") && t.endsWith("]") && !t.includes(" "));
}

function readJsonl(file, w) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  // Inbox logs are append-only and time-ordered; read the tail generously.
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const ms = Date.parse(r.ts);
    if (inWindow(ms, w)) out.push({ ...r, _ms: ms });
  }
  return out;
}

// ── per-source readers → uniform rows ──

function imessageRows(w, { chatDb } = {}) {
  const idb = require("./imessage-db.js");
  const db = chatDb || idb.openChatDb();
  try {
    const startNs = idb.msToAppleNs(w.startMs);
    const r = db.db.prepare("SELECT MIN(ROWID) - 1 AS r FROM message WHERE date >= ?").get(startNs);
    const from = Number(r?.r ?? db.maxRowid());
    const rows = [];
    let cursor = from;
    for (;;) {
      const batch = db.since(cursor, 1000);
      if (!batch.length) break;
      for (const m of batch) {
        cursor = m.rowid;
        const ms = Date.parse(m.ts);
        if (ms >= w.endMs) return rows;
        if (!inWindow(ms, w) || m.kind !== "message" || !hasWords(m.text)) continue;
        rows.push({ channel: "imessage", ms, chat_id: m.chat_id, chat: m.chat_name, is_group: m.is_group,
          from_me: m.from_me, who: m.from_me ? "me" : m.sender_name || m.sender, text: m.text });
      }
      if (batch.length < 1000) break;
    }
    return rows;
  } finally {
    if (!chatDb) db.close();
  }
}

// Group subjects from the live gateway (GET /groups), for rows logged before
// the gateway stored group_name. Empty when the runner is unreachable.
function liveGroupNames(url = process.env.WHATSAPP_RUNNER_URL || "http://localhost:9100") {
  const out = new Map();
  try {
    const r = spawnSync("curl", ["-s", "-m", "5", `${url}/groups`], { encoding: "utf8" });
    for (const g of JSON.parse(r.stdout || "{}").groups || []) if (g.id && g.subject) out.set(g.id, g.subject);
  } catch {
    // runner down: rows keep their own group_name or the generic label
  }
  return out;
}

function whatsappRows(w, { file = WA_INBOX, groupNames = null } = {}) {
  const raw = readJsonl(file, w);
  const needNames = raw.some((r) => r.is_group && !r.group_name);
  const subjects = groupNames || (needNames ? liveGroupNames() : new Map());
  // A 1:1 chat's name is the other person's push name, seen on their own rows.
  const nameOf = new Map();
  for (const r of raw) if (!r.is_group && !r.from_me && r.kind === "message" && r.sender_name) nameOf.set(r.chat_id, r.sender_name);
  const rows = [];
  for (const r of raw) {
    const chatId = String(r.chat_id || "");
    if (chatId === "status@broadcast" || chatId.endsWith("@newsletter")) continue;
    if (r.kind !== "message" && r.kind !== "sent") continue;
    if (!hasWords(r.text)) continue;
    const fromMe = r.kind === "sent" || r.from_me === true;
    const isGroup = r.is_group === true || chatId.endsWith("@g.us");
    rows.push({ channel: "whatsapp", ms: r._ms, chat_id: chatId,
      chat: isGroup ? r.group_name || subjects.get(chatId) || "a WhatsApp group" : nameOf.get(chatId) || chatId.split("@")[0],
      is_group: isGroup, from_me: fromMe, who: fromMe ? (r.kind === "sent" ? "Jori (as me)" : "me") : r.sender_name || r.sender,
      text: r.text });
  }
  return rows;
}

function slackRows(w, { file = SLACK_INBOX } = {}) {
  const rows = [];
  const raw = readJsonl(file, w);
  // A DM's name is the other person, seen on their own rows.
  const dmName = new Map();
  for (const r of raw) if (r.channel_type === "im" && !r.from_me && r.user_name) dmName.set(r.channel_id, r.user_name);
  for (const r of raw) {
    if (r.kind && r.kind !== "message" && r.kind !== "sent") continue;
    if (!hasWords(r.text)) continue;
    const type = r.channel_type || "";
    const isGroup = type !== "im";
    const fromMe = r.kind === "sent" || r.from_me === true;
    const chat = type === "im" ? dmName.get(r.channel_id) || (fromMe ? null : r.user_name) || r.channel_name || "a DM"
      : type === "mpim" ? r.channel_name || "a group DM"
      : r.channel_name ? `#${r.channel_name}` : "a Slack conversation";
    rows.push({ channel: "slack", ms: r._ms, chat_id: r.channel_id || chat, chat, is_group: isGroup,
      from_me: fromMe, who: fromMe ? "me" : r.user_name || r.user_id, text: r.text });
  }
  return rows;
}

// ── volume bounds (structure only) ──

function bound(rows, caps = {}) {
  const { direct = DIRECT_MAX, groupActive = GROUP_ACTIVE_MAX, groupPassive = GROUP_PASSIVE_MAX } = caps;
  const byChat = new Map();
  for (const r of rows) {
    const k = `${r.channel}:${r.chat_id}`;
    if (!byChat.has(k)) byChat.set(k, []);
    byChat.get(k).push(r);
  }
  const kept = [];
  let dropped = 0;
  for (const list of byChat.values()) {
    list.sort((a, b) => a.ms - b.ms);
    const group = list[0].is_group;
    const active = list.some((r) => r.from_me);
    const cap = !group ? direct : active ? groupActive : groupPassive;
    if (list.length <= cap) { kept.push(...list); continue; }
    // Keep the user's own, then the most recent others up to the cap.
    const mine = list.filter((r) => r.from_me);
    const others = list.filter((r) => !r.from_me).slice(-Math.max(0, cap - mine.length));
    const pick = [...mine, ...others].sort((a, b) => a.ms - b.ms);
    dropped += list.length - pick.length;
    kept.push(...pick);
  }
  return { kept, dropped };
}

/**
 * The day's messages as harvest facts, plus counts and per-source errors.
 * @param w day window {startMs, endMs}
 * @param sources test stubs: { imessage, whatsapp, slack } each (w) => rows
 * @param caps per-chat bounds { direct, groupActive, groupPassive } (message-digest
 *   reads more of each group than the daily summary does)
 */
function dayMessages(w, sources = {}, caps = {}) {
  const errors = {};
  const all = [];
  const counts = {};
  const read = (name, fn) => {
    try {
      const rows = fn(w) || [];
      counts[name] = rows.length;
      all.push(...rows);
    } catch (e) {
      errors[name] = String(e.message || e).slice(0, 200);
    }
  };
  read("imessage", sources.imessage || imessageRows);
  read("whatsapp", sources.whatsapp || whatsappRows);
  read("slack", sources.slack || slackRows);
  const { kept, dropped } = bound(all, caps);
  const facts = kept
    .sort((a, b) => a.ms - b.ms)
    .map((r) => ({ kind: "message", at: new Date(r.ms).toISOString(), ms: r.ms, channel: r.channel,
      chat: r.chat, chat_id: r.chat_id, is_group: r.is_group, from_me: r.from_me, who: r.who, text: trim(r.text) }));
  return { facts, counts: { ...counts, kept: facts.length, dropped }, errors };
}

module.exports = { dayMessages, bound, whatsappRows, slackRows, imessageRows, hasWords,
  TEXT_MAX, DIRECT_MAX, GROUP_ACTIVE_MAX, GROUP_PASSIVE_MAX };
