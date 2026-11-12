#!/usr/bin/env node
// speak-gate-shadow — the speak gate's shadow week (system/speak-gate.md
// § Shadow week). Every message that reached the user in the app, by any route
// (jobs through jori-send-curl, role replies, location, chat answers), is
// judged by bin/speak-gate.mjs as of one second before it was sent. NOTHING
// is held or changed: the verdict goes to public.jori_gate_reviews, and the
// app shows it under the message for the user to grade right or wrong.
//
//   speak-gate-shadow [--max 12] [--concurrency 3] [--dry-run]
//
// Run by launchd (ai.claude.speak-gate-shadow, every 5 min) through
// speak-gate-shadow-trigger, which sources the Max-auth guard: the gate forks
// `claude -p`, which needs the GUI keychain. Cursor and lock:
// data/speak-gate-shadow.json. The first run starts the cursor at "now", so
// only messages sent after the shadow began are judged.
"use strict";

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KERNEL = path.resolve(PLUGIN, "..", "..");
const { installTools } = require(path.join(KERNEL, "lib", "root.cjs"));
try { require(path.join(KERNEL, "lib", "load-env.js")).loadEnv(); } catch {}
const rest = require(path.join(KERNEL, "lib", "supabase-rest.js"));

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const MAX = Number(flag("max", 12));
const CONC = Number(flag("concurrency", 3));
const DRY = args.includes("--dry-run");
const STATE = installTools("data", "speak-gate-shadow.json");
const LOCK = installTools("data", ".speak-gate-shadow.lock");
const SETTLE_MS = 45e3;        // let a message's own conversation settle first
const REPLY_WINDOW_MS = 15 * 60e3;

function readState() { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; } }
function writeState(s) { mkdirSync(path.dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 1) + "\n"); }

function lock() {
  try {
    if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < 30 * 60e3) return false; // a run is still going
    writeFileSync(LOCK, String(process.pid));
    return true;
  } catch { return false; }
}

async function kindOf(m) {
  if (m.reply_to) {
    const p = await rest.request(`/rest/v1/jori_messages?select=role,content&id=eq.${m.reply_to}`);
    if (p && p[0] && p[0].role === "user") return { kind: "reply", replyText: p[0].content };
  }
  const conv = m.conversation_id ? `conversation_id=eq.${encodeURIComponent(m.conversation_id)}` : `channel=eq.${m.channel}`;
  const prev = await rest.request(`/rest/v1/jori_messages?select=role,content,created_at&${conv}&created_at=lt.${encodeURIComponent(m.created_at)}&order=created_at.desc&limit=1`);
  const p = prev && prev[0];
  if (p && p.role === "user" && Date.parse(m.created_at) - Date.parse(p.created_at) < REPLY_WINDOW_MS) return { kind: "reply", replyText: p.content };
  return { kind: "proactive", replyText: null };
}

function judge(input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(KERNEL, "bin", "speak-gate.mjs")], { env: process.env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => { try { resolve(JSON.parse(out.trim().split("\n").pop())); } catch { resolve(null); } });
    child.stdin.end(JSON.stringify(input));
  });
}

async function one(m) {
  const k = await kindOf(m);
  const input = {
    message: m.content, intent: (m.metadata && (m.metadata.intent || m.metadata.question_id)) || m.channel,
    sender: m.sender, channel: m.channel, kind: k.kind, reply_to_text: k.replyText,
    as_of: new Date(Date.parse(m.created_at) - 1000).toISOString(), replay_id: m.id,
  };
  const r = await judge(input);
  if (!r || !r.verdict || String(r.reason || "").startsWith("gate_error")) {
    console.log(`${m.id}: no verdict (${r ? r.reason : "no output"})`);
    return false;
  }
  const row = {
    message_id: m.id, conversation_id: m.conversation_id, sender: m.sender, channel: m.channel, kind: k.kind,
    verdict: r.verdict, reason: r.reason || null,
    suggestion: r.verdict === "rewrite" ? (r.message || null) : r.verdict === "resolve" ? (r.research_plan || null) : null,
    checks: r.checks || null, sources: r.sources || null, ms: r.ms || null,
  };
  if (DRY) { console.log(JSON.stringify(row)); return true; }
  await rest.request("/rest/v1/jori_gate_reviews?on_conflict=message_id", { method: "POST", body: row, prefer: "resolution=merge-duplicates,return=minimal" });
  console.log(`${m.id}: ${k.kind} → ${r.verdict} (${Math.round((r.ms || 0) / 1000)}s)`);
  return true;
}

(async () => {
  if (!lock()) { console.log("another run is going"); return; }
  try {
    const st = readState();
    if (!st.cursor) { st.cursor = new Date().toISOString(); st.started_at = st.cursor; st.ends_at = new Date(Date.now() + 7 * 864e5).toISOString(); writeState(st); console.log(`shadow starts at ${st.cursor}`); return; }
    // No end date any more: since going live this pass is the safety net for
    // routes that bypass the live gate (system/speak-gate.md § Live).
    const until = new Date(Date.now() - SETTLE_MS).toISOString();
    const rows = await rest.request(`/rest/v1/jori_messages?select=id,role,content,created_at,channel,sender,conversation_id,reply_to,metadata&role=eq.assistant&created_at=gt.${encodeURIComponent(st.cursor)}&created_at=lt.${encodeURIComponent(until)}&order=created_at.asc&limit=${MAX}`);
    const fetched = (rows || []).filter((m) => String(m.content || "").trim());
    if (!fetched.length) return;
    // Since the gate went live (lib/speak-gate-live.mjs) most messages are
    // judged BEFORE delivery; this pass is now the safety net for any route
    // that still writes without it. Never re-judge (or overwrite) a message
    // that already has its review.
    let reviewed = new Set();
    try {
      const have = await rest.request(`/rest/v1/jori_gate_reviews?select=message_id&message_id=in.(${fetched.map((m) => m.id).join(",")})`);
      reviewed = new Set((have || []).map((r) => r.message_id));
    } catch {}
    const todo = fetched.filter((m) => !reviewed.has(m.id));
    if (!todo.length) {
      st.cursor = fetched[fetched.length - 1].created_at;
      st.last_run = new Date().toISOString();
      if (!DRY) writeState(st);
      return;
    }
    let i = 0;
    const done = new Set();
    await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, async () => {
      while (i < todo.length) { const m = todo[i++]; try { await one(m); } catch (e) { console.log(`${m.id}: ${e.message}`); } done.add(m.id); }
    }));
    // Advance past every message handled (judged or not: a gate error is
    // logged, not retried forever).
    st.cursor = fetched[fetched.length - 1].created_at;
    st.judged = (st.judged || 0) + todo.length;
    st.last_run = new Date().toISOString();
    if (!DRY) writeState(st);
  } finally {
    try { unlinkSync(LOCK); } catch {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
