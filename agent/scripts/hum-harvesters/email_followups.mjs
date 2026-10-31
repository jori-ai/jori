#!/usr/bin/env node
// Email followups — live open P1s (Gmail label:p1 is:starred) older than 1 day
// whose thread the user has not replied on (same test as bin/p1-reply-sweep,
// via lib/p1-reply.js). No longer reads the email-mem triage log.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { readStdinJson, emit, emitNull, stampRun, PREVIEW } from "./_common.mjs";
import { pickTopOpenP1, followupUrgency } from "../../../lib/p1-followups.mjs";

const require = createRequire(import.meta.url);
const { getAccessToken, fetchWithRetry, describeError } = require("../../../lib/google-auth.js");
const { installTools } = require("../../../lib/root.cjs");

const { situation: sit, context } = await readStdinJson(); void sit; void context;
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_THREADS = 40;
const STALE_DAYS = 14;
const ASKED_FILE = installTools("data/hum-email-followups-stale-asked.json");

function readAsked() {
  try { return JSON.parse(fs.readFileSync(ASKED_FILE, "utf8")) || {}; } catch { return {}; }
}

async function gmail(endpoint, token) {
  const r = await fetchWithRetry(`${API}${endpoint}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json();
  if (data.error) throw new Error(`${data.error.message} (http ${r.status})`);
  return data;
}

try {
  const token = await getAccessToken();
  const q = encodeURIComponent("label:p1 is:starred newer_than:60d");
  const list = await gmail(`/threads?q=${q}&maxResults=${MAX_THREADS}`, token);
  const labels = await gmail("/labels", token);
  const p1 = (labels.labels || []).find((l) => (l.name || "").toLowerCase() === "p1");
  if (!p1) { emitNull("no p1 label"); process.exit(0); }
  const threads = [];
  for (const t of list.threads || []) {
    threads.push(await gmail(`/threads/${t.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, token));
  }
  const { open: allOpen } = pickTopOpenP1(threads, p1.id);
  // A P1 open 14+ days is asked about once ("still need it?"), then left alone so
  // younger P1s surface instead of the same stale one re-emitting every hour.
  const asked = readAsked();
  const open = allOpen.filter((m) => m.ageDays < STALE_DAYS || !asked[m.messageId]);
  const oldest = open[0] || null;
  if (!oldest) {
    stampRun("email_followups", false);
    emitNull(threads.length ? "no open P1 older than 1d" : "no live P1 threads");
    process.exit(0);
  }
  stampRun("email_followups", true);
  if (oldest.ageDays >= STALE_DAYS) {
    if (!PREVIEW) {
      fs.mkdirSync(path.dirname(ASKED_FILE), { recursive: true });
      fs.writeFileSync(ASKED_FILE, JSON.stringify({ ...asked, [oldest.messageId]: new Date().toISOString() }, null, 1));
    }
    emit({
      topic: "email_followups",
      signal: `Still need "${oldest.subject.slice(0, 100)}" from ${oldest.from.slice(0, 60)} (open ${oldest.ageDays}d), or can I downgrade it?`,
      urgency: followupUrgency(oldest.ageDays),
      freshness_min: 0,
      dedup_key: `${oldest.messageId}:stale-ask`,
      supporting_data: {
        evidence_as_of: oldest.date,
        message_id: oldest.messageId,
        ask_kind: "p1_stale",
        fix_hint: `if the user says it is done: ${installTools("bin/p1-downgrade")} ${oldest.messageId} --source hum-stale-ask`,
      },
    });
    process.exit(0);
  }
  emit({
    topic: "email_followups",
    signal: `P1 email pending ${oldest.ageDays}d: "${oldest.subject.slice(0, 100)}" from ${oldest.from.slice(0, 60)}`,
    urgency: followupUrgency(oldest.ageDays),
    freshness_min: 0,
    dedup_key: oldest.messageId,
    supporting_data: {
      evidence_as_of: oldest.date,
      message_id: oldest.messageId,
      open_count: open.length,
      open: open.slice(0, 5).map(({ messageId, ageDays, subject, from }) => ({ messageId, ageDays, subject, from })),
    },
  });
} catch (e) {
  emitNull(`gmail p1 lookup failed: ${typeof describeError === "function" ? describeError(e) : e.message}`);
}
