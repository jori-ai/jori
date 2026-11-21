#!/usr/bin/env node
// jori-send — Insert a message into jori_messages and send a push notification.
// Usage:
//   jori-send "Your message here"
//   jori-send --notify "Short summary" "Full message body..."
//   jori-send --silent "Message without any push"
//
// Auth: SUPABASE_SERVICE_ROLE_KEY from .env. NOT the anon key — the
// jori_messages INSERT policy is
//   (auth.role() = 'service_role') OR (role = 'user' AND auth.uid() IS NOT NULL)
// and this tool inserts role='assistant', so an anon client fails BOTH branches
// and every send is rejected by RLS. That is what happened until 2026-08-04:
// the key was hardcoded here as the anon JWT, so the location-confirm ask
// channel (its only caller, trigger-location-confirm.sh) never delivered a
// single message. Its sibling in the same pipeline,
// location-confirm-resolve.mjs, already read the service-role key correctly.

import { createClient } from "@supabase/supabase-js";
import { sendApnsPush } from "../lib/apns-push.mjs";
import { loadEnv, underTestRunner } from "../lib/load-env.js";
import { createRequire } from "node:module";

// Inside a test run (node --test sets NODE_TEST_CONTEXT, and what a test spawns
// inherits it) this tool never posts: its only target is the real chat. See
// "Test runs" in lib/load-env.js.
if (underTestRunner()) {
  console.error("jori-send: not sent — this is a test run (NODE_TEST_CONTEXT is set), and a test never posts to the real chat.");
  process.exit(9);
}

loadEnv();

const SUPABASE_URL = `https://${createRequire(import.meta.url)("../lib/instance.cjs").instance().supabase_project}.supabase.co`;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Fail loudly rather than falling back to the anon key. A silent fallback is
// exactly the failure mode this replaced: RLS rejects the insert, the tool
// exits non-zero into a log nobody reads, and the channel looks alive.
if (!SUPABASE_KEY) {
  console.error(
    "jori-send: SUPABASE_SERVICE_ROLE_KEY not found in env or .env — refusing to send."
  );
  process.exit(1);
}

const args = process.argv.slice(2);
let notifySummary = null;
let silent = false;
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--notify" || a === "-n") notifySummary = args[++i];
  else if (a === "--silent" || a === "-s") silent = true;
  else positional.push(a);
}

let message = positional.join(" ");
if (!message) {
  console.error("Usage: jori-send [--notify <summary>] [--silent] <message>");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// The speak gate, before the user sees it (system/speak-gate.md § Live): a
// rewrite is sent as the gate's text, a held message is not written at all.
// Fails open.
const { gateOutbound, recordReview } = await import("../lib/speak-gate-live.mjs");
let gate = { deliver: true, text: message, review: null };
try { gate = await gateOutbound({ message, kind: "proactive", channel: "chat", intent: process.env.JORI_JOB || "jori-send" }); } catch {}
if (!gate.deliver) {
  console.log(`Not sent: held by the speak gate (${gate.verdict}: ${gate.reason || ""}). The user sees it folded in the conversation.`);
  process.exit(0);
}
message = gate.text || message;

const { data: inserted, error } = await supabase.from("jori_messages").insert({
  role: "assistant",
  content: message,
  read: false,
}).select("id").single();

if (error) {
  console.error(`Failed to insert: ${error.message}`);
  process.exit(1);
}

if (gate.review && inserted?.id) await recordReview(gate.review, inserted.id);

console.log(`Message sent to ${createRequire(import.meta.url)("../lib/instance.cjs").assistantName()}.`);

if (silent) process.exit(0);

// Delay so foreground apps get a chance to mark as read via realtime
await new Promise((r) => setTimeout(r, 1500));

const msgId = inserted?.id;
if (msgId) {
  const { data: row } = await supabase
    .from("jori_messages")
    .select("read")
    .eq("id", msgId)
    .single();
  if (row?.read) {
    console.log("Message already read, skipping push.");
    process.exit(0);
  }
}

const body = notifySummary
  || (message.length > 100 ? message.slice(0, 100) + "…" : message);

try {
  const res = await sendApnsPush(supabase, { body, messageId: msgId });
  // Sent while the user was moving: ping-flush re-pings it once when they stop,
  // if it is still unread. Say so, so a log reader knows a second buzz may follow.
  if (res?.repingIfUnread) console.log(`Push notification sent while moving (${res.reason}) — ping-flush re-pings it once on stopping if still unread.`);
  else console.log("Push notification sent.");
} catch (e) {
  console.error(`Push skipped: ${e.message}`);
}

process.exit(0);
