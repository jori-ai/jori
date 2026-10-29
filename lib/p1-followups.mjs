// Pure helper for the email_followups hum harvester: from Gmail threads
// (messages with id/internalDate/labelIds/payload.headers), pick the oldest
// still-open starred P1 message with the highest follow-up urgency, skipping
// threads the user already answered and the agent's own mail.
// Reuses decideThread from p1-reply.js (same test as bin/p1-reply-sweep).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { decideThread } = require("./p1-reply.js");
const { agentAddresses } = require("./instance.cjs");

const DAY = 24 * 3600 * 1000;
const ts = (m) => parseInt(m && m.internalDate, 10) || 0;
const has = (m, l) => Array.isArray(m && m.labelIds) && m.labelIds.includes(l);
const header = (m, name) => {
  const h = ((m.payload && m.payload.headers) || []).find((x) => (x.name || "").toLowerCase() === name);
  return h ? h.value : "";
};

// The agent's own addresses (agent_email plus agent_email_aliases), read once
// per call; a fresh install with none configured skips nothing on this test.
const ownTest = (own) => (m) => { const f = header(m, "from").toLowerCase(); return own.some((a) => f.includes(a)); };

export function pickTopOpenP1(threads, p1LabelId, nowMs = Date.now(), minAgeDays = 1, { ownAddresses = agentAddresses() } = {}) {
  const isJoriOwn = ownTest(ownAddresses);
  const open = [];
  for (const t of threads || []) {
    const msgs = (t.messages || []).filter((m) => m && m.id && !has(m, "DRAFT"));
    if (!msgs.length) continue;
    const newest = msgs.reduce((a, b) => (ts(b) > ts(a) ? b : a));
    if (has(newest, "SENT") || decideThread(msgs, p1LabelId).resolved.length) continue;
    for (const m of msgs) {
      if (!has(m, p1LabelId) || !has(m, "STARRED") || has(m, "SENT") || isJoriOwn(m)) continue;
      const ageDays = Math.floor((nowMs - ts(m)) / DAY);
      if (ageDays >= minAgeDays) {
        open.push({
          messageId: m.id, threadId: t.id, ageDays, date: new Date(ts(m)).toISOString(),
          subject: header(m, "subject"), from: header(m, "from"),
        });
      }
    }
  }
  open.sort((a, b) => followupUrgency(b.ageDays) - followupUrgency(a.ageDays) || a.date.localeCompare(b.date));
  return { top: open[0] || null, oldest: open[0] || null, open };
}

export const pickOldestOpenP1 = pickTopOpenP1;

// Existing urgency formula with the 0.5^(age/7) decay.
export function followupUrgency(ageDays) {
  return Math.min(0.8, (0.3 + 0.08 * ageDays) * 0.5 ** (ageDays / 7));
}
