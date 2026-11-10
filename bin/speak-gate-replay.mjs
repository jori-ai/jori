#!/usr/bin/env node
// speak-gate-replay — run past messages to the user through bin/speak-gate as
// of the moment each was sent, sending nothing (system/speak-gate.md § Replay).
//
//   speak-gate-replay [--days 7] [--n 100] [--out <file.jsonl>] [--concurrency 3]
//
// Picks a sample across the channels (questions, proactive chat, replies,
// system, improvements), works out whether each was a reply (reply_to, or a
// user message in the same conversation within 15 minutes before it), and
// writes one row per message: the original, the gate's verdict, its checks,
// lookups and time. A summary prints at the end. Must run where `claude -p`
// can read the Max login (launchd, not ssh/cron).
"use strict";

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try { require(path.join(ROOT, "lib", "load-env.js")).loadEnv(); } catch {}
const rest = require(path.join(ROOT, "lib", "supabase-rest.js"));

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const DAYS = Number(flag("days", 7));
const N = Number(flag("n", 100));
const OUT = flag("out", path.join(ROOT, "data", `speak-gate-replay-${new Date().toISOString().slice(0, 10)}.jsonl`));
const CONC = Number(flag("concurrency", 3));
const SHARE = { questions: 0.3, proactive: 0.4, reply: 0.2, system: 0.05, improvements: 0.05 };

function shuffle(a, seed = 7) { let s = seed; for (let i = a.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor((s / 233280) * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

async function load() {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const rows = await rest.requestAll(`/rest/v1/jori_messages?select=id,role,content,created_at,channel,sender,conversation_id,reply_to,metadata&created_at=gt.${encodeURIComponent(since)}&order=created_at.asc`);
  const byConv = new Map();
  for (const r of rows) { const k = r.conversation_id || r.channel; if (!byConv.has(k)) byConv.set(k, []); byConv.get(k).push(r); }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = [];
  for (const list of byConv.values()) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.role !== "assistant" || !String(m.content || "").trim()) continue;
      let replyText = null;
      if (m.reply_to && byId.get(m.reply_to)?.role === "user") replyText = byId.get(m.reply_to).content;
      else {
        const prev = list[i - 1];
        if (prev && prev.role === "user" && Date.parse(m.created_at) - Date.parse(prev.created_at) < 15 * 60e3) replyText = prev.content;
      }
      const bucket = replyText ? "reply" : m.channel === "questions" ? "questions" : m.channel === "system" ? "system" : m.channel === "improvements" ? "improvements" : "proactive";
      out.push({ m, bucket, replyText });
    }
  }
  return out;
}

function gate(item) {
  const { m } = item;
  const input = {
    message: m.content, intent: (m.metadata && (m.metadata.intent || m.metadata.question_id)) || `${m.channel}`,
    sender: m.sender, channel: m.channel, kind: item.bucket === "reply" ? "reply" : "proactive",
    reply_to_text: item.replyText, as_of: new Date(Date.parse(m.created_at) - 1000).toISOString(), replay_id: m.id,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "bin", "speak-gate.mjs")], { env: { ...process.env, SPEAK_GATE_LOG: OUT.replace(/\.jsonl$/, ".gate-log.jsonl") } });
    let so = "";
    child.stdout.on("data", (d) => { so += d; });
    child.on("close", () => { try { resolve(JSON.parse(so.trim().split("\n").pop())); } catch { resolve({ verdict: "error", reason: so.slice(0, 200) }); } });
    child.stdin.end(JSON.stringify(input));
  });
}

(async () => {
  const all = await load();
  const pick = [];
  for (const [b, share] of Object.entries(SHARE)) pick.push(...shuffle(all.filter((x) => x.bucket === b)).slice(0, Math.round(N * share)));
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, "");
  console.log(`replay: ${all.length} messages in ${DAYS}d, sampling ${pick.length} → ${OUT}`);
  let i = 0;
  const tally = {};
  async function worker() {
    while (i < pick.length) {
      const item = pick[i++];
      const r = await gate(item);
      const row = { id: item.m.id, at: item.m.created_at, bucket: item.bucket, sender: item.m.sender, channel: item.m.channel,
        original: item.m.content, asked: item.replyText ? String(item.replyText).slice(0, 300) : null, ...r };
      appendFileSync(OUT, JSON.stringify(row) + "\n");
      const k = `${item.bucket}:${r.verdict}`; tally[k] = (tally[k] || 0) + 1;
      console.log(`[${Object.values(tally).reduce((a, b) => a + b, 0)}/${pick.length}] ${item.bucket} → ${r.verdict} (${Math.round((r.ms || 0) / 1000)}s) ${String(r.reason || "").slice(0, 100)}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log("SUMMARY " + JSON.stringify(tally));
})().catch((e) => { console.error(e); process.exit(1); });
