// message-followup — the one ping left on the messaging channels: an urgent
// message the user has not answered in 24 hours.
//
// message-alert (lib/message-alert.mjs) judges every inbound message and
// logs it; nothing is pushed then. This step, code only, reads that log: a row
// judged `urgent` whose message is 24 to 72 hours old, with nothing the user
// (or Jori as the user) sent in the same chat after it, is asked about
// once, all such rows in one message. "Answered" is structure: any row of the
// user's own in that chat's channel inbox later than the message. Rows logged before
// the log carried chat_id have none and are never asked about.
//
// State: data/message-followup-state.json { asked: { <channel>:<message_id>: ISO } }.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { instanceValue } = require("./instance.cjs");

export const WAIT_MS = 24 * 3600 * 1000;
export const STALE_MS = 72 * 3600 * 1000;
const LABEL = { imessage: "iMessage", whatsapp: "WhatsApp", slack: "Slack" };
// Each channel's inbox and the field its rows name the chat by.
export const INBOXES = {
  imessage: { file: "data/imessage-inbox.jsonl", chatKey: "chat_id" },
  whatsapp: { file: "data/whatsapp-inbox.jsonl", chatKey: "chat_id" },
  slack: { file: "data/slack-inbox.jsonl", chatKey: "channel_id" },
};

export function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").flatMap((l) => {
      if (!l) return [];
      try { return [JSON.parse(l)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

const sentMs = (row) => Date.parse(row.sent_at || row.ts);

/** Urgent judged rows in the ask window, not asked before. */
export function dueRows(logRows, state, now = Date.now()) {
  const seen = new Set();
  return logRows.filter((r) => {
    if (r.level !== "urgent" || !r.chat_id || !r.message_id) return false;
    const key = `${r.channel}:${r.message_id}`;
    if (seen.has(key) || state?.asked?.[key]) return false;
    seen.add(key);
    const age = now - sentMs(r);
    return Number.isFinite(age) && age >= WAIT_MS && age < STALE_MS;
  });
}

/** Did the user write in that chat after the message? `inboxRows` is that channel's inbox. */
export function answered(row, inboxRows, chatKey) {
  const after = sentMs(row);
  return inboxRows.some((r) => r[chatKey] === row.chat_id && (r.from_me === true || r.kind === "sent") && Date.parse(r.ts) > after);
}

function when(iso, tz = instanceValue("tz") || "UTC") {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** The ask: a one-line header, then one short bullet per message. */
export function composeAsk(rows) {
  const lines = rows.map((r) => {
    const where = r.is_group && r.chat ? `${r.from || "someone"} in ${r.chat}` : r.from || r.chat || "someone";
    const text = String(r.text || "").split("\n").join(" ").slice(0, 120);
    return `- ${where} (${LABEL[r.channel] || r.channel}, ${when(r.sent_at || r.ts)}): ${text}`;
  });
  const head = rows.length === 1 ? "Urgent message still unanswered after 24h:" : `${rows.length} urgent messages still unanswered after 24h:`;
  return `${head}\n${lines.join("\n")}`;
}

/**
 * One pass. `root` is the tools dir. Returns { due, unanswered, text|null }.
 * `send(text)` delivers; state is written only after a send that did not throw.
 */
export function runFollowup({ root, now = Date.now(), send, dryRun = false }) {
  const stateFile = path.join(root, "data/message-followup-state.json");
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
  const due = dueRows(readJsonl(path.join(root, "data/message-alert-log.jsonl")), state, now);
  const inboxes = new Map();
  const open = due.filter((r) => {
    const box = INBOXES[r.channel];
    if (!box) return false;
    if (!inboxes.has(r.channel)) inboxes.set(r.channel, readJsonl(path.join(root, box.file)));
    return !answered(r, inboxes.get(r.channel), box.chatKey);
  });
  const text = open.length ? composeAsk(open) : null;
  if (!dryRun) {
    if (text) send(text);
    // Answered rows are settled too, so they are not re-read every hour.
    const asked = { ...(state.asked || {}) };
    for (const r of due) asked[`${r.channel}:${r.message_id}`] = new Date(now).toISOString();
    // Forget keys older than the window, so the file stays small.
    for (const [k, v] of Object.entries(asked)) if (now - Date.parse(v) > STALE_MS * 2) delete asked[k];
    if (due.length) {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ asked }, null, 2));
    }
  }
  return { due: due.length, unanswered: open.length, text };
}
