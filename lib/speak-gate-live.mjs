// speak-gate-live — the speak gate in front of delivery (system/speak-gate.md
// § Live). Every message to the user in the app passes bin/speak-gate.mjs
// BEFORE it is written to jori_messages or pushed, and the verdict is acted on:
//
//   send     delivered as written
//   rewrite  the gate's text is delivered; the original is kept on the review
//   drop / digest / resolve (proactive only)
//            held: never written to jori_messages, never pushed. The review row
//            (no message_id, held = true) carries the original, and the app
//            shows it as a folded "held" line in its conversation.
//
// A reply to something the user wrote is only ever sent or rewritten.
// Every verdict is still shown to the user to grade, folded under the message
// (the original hidden until they open it): the user, 2026-11-11, "review and
// act — below tell me what was the original and still ask if made the right
// decision"; "show the reviewed result as primary and the original as hidden
// until exposed".
//
// Fail-open: a gate error, timeout or a missing database delivers the message
// as written (and records the error as its review). A judge with no Max login
// (a cron sender) is first relayed to the GUI session (§ Relay below). Off switch, no deploy:
// data/.speak-gate-off, or `"live": false` in agent/local/config/speak-gate.json.
//
// Scope: EVERY message to the user, on every channel (chat, questions,
// system, improvements…), and email to the user alone (bin/email-send: plain
// text = proactive, HTML report = "report", a reply in one of the user's
// threads = reply). The user, 2026-11-12: "everything goes through the gate
// unless the issue is with the gate itself" — the gate rewrites and fact-checks
// system alerts too. The only exceptions: a message about the gate itself
// (intent starting "speak-gate", or SPEAK_GATE_SELF=1 — a broken gate must not
// judge its own alarm), and a test run. A gate that is down fails open.
//
// Node callers import gateOutbound + recordReview; shell and Python callers use
// bin/speak-gate-live (gate / record).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { installTools } = require(path.join(ROOT, "lib", "root.cjs"));
const { localConfig } = require(path.join(ROOT, "lib", "instance.cjs"));
try { require(path.join(ROOT, "lib", "load-env.js")).loadEnv(); } catch { /* env may be set */ }

const HOLD = new Set(["drop", "digest", "resolve"]);
// Live budgets: a reply keeps the user waiting, a proactive ping does not.
const LIVE_TIMEOUT_S = { reply: 60, report: 180, proactive: 240 };

export function liveEnabled() {
  if (process.env.SPEAK_GATE_LIVE === "0") return false;
  if (process.env.NODE_TEST_CONTEXT && process.env.SPEAK_GATE_LIVE !== "1") return false;
  try { if (existsSync(installTools("data", ".speak-gate-off"))) return false; } catch {}
  try { return localConfig("speak-gate", {}).live !== false; } catch { return true; }
}

/** A message about the gate itself: never judged by it. */
export function aboutGate({ intent } = {}) {
  return process.env.SPEAK_GATE_SELF === "1" || /^speak-gate/i.test(String(intent || ""));
}

/** Is this message one the live gate judges? Every one, on every channel,
 *  except a message about the gate itself. */
export function inScope(m = {}) {
  return liveEnabled() && !aboutGate(m);
}

function runGate(input, timeoutS) {
  const bin = process.env.SPEAK_GATE_BIN || path.join(ROOT, "bin", "speak-gate.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin], {
      env: { ...process.env, SPEAK_GATE_TIMEOUT_S: String(timeoutS) },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    // Belt: the gate times its own judge out, but never wait past budget + 90 s
    // (the evidence step runs before the judge).
    const kill = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, (timeoutS + 90) * 1000);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(kill); resolve(null); });
    child.on("close", () => {
      clearTimeout(kill);
      try { resolve(JSON.parse(out.trim().split("\n").pop())); } catch { resolve(null); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

// ─── Relay: a sender with no Max login (cron) ──────────────────────────────
//
// The judge is `claude -p` on the Max subscription, whose credential only the
// GUI session can read from the login keychain. From cron it answers "Not
// logged in", and until 2026-11-12 every cron-started message (the 6:30
// rain-walk summary, the Broadway lottery list, project-task cards) went out
// unchecked: "Gate: Check failed, sent as written · judge_unavailable:
// not_logged_in". So on that answer the judge is handed to the on-demand
// launchd agent ai.claude.speak-gate-relay (bin/speak-gate-relay), which runs
// it in the GUI session: a request file in data/speak-gate-relay/, a kick,
// then wait for the verdict file. If Max is really down the relayed judge says
// so too and the message fails open as before. Not relayed: inside the relay
// itself (SPEAK_GATE_RELAYED=1), or SPEAK_GATE_NO_RELAY=1.

export const RELAY_LABEL = "ai.claude.speak-gate-relay";
const NO_LOGIN = "gate_error:judge_unavailable:not_logged_in";
export const relayDir = () => process.env.SPEAK_GATE_RELAY_DIR || installTools("data", "speak-gate-relay");

function kickRelay(first) {
  // Test seam: SPEAK_GATE_RELAY_KICK is a command run (via sh) instead of launchd.
  if (process.env.SPEAK_GATE_RELAY_KICK) {
    return spawnSync("/bin/sh", ["-c", process.env.SPEAK_GATE_RELAY_KICK], { stdio: "ignore" }).status === 0;
  }
  if (first) {
    // launchd_kick installs the repo plist if it was never installed, and pages
    // the System tab when it cannot.
    const sh = path.join(ROOT, "agent", "scripts", "lib", "launchd-kick.sh");
    return spawnSync("/bin/bash", ["-c", 'source "$1" && launchd_kick "$2" speak-gate-relay', "_", sh, RELAY_LABEL],
      { stdio: "ignore", timeout: 30000 }).status === 0;
  }
  // A later kick while a run is going is a no-op; it catches a request filed
  // just as the runner was exiting.
  spawnSync("launchctl", ["kickstart", `gui/${process.getuid()}/${RELAY_LABEL}`], { stdio: "ignore", timeout: 10000 });
  return true;
}

async function relayGate(input, timeoutS) {
  const dir = relayDir();
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const req = path.join(dir, `${id}.in.json`);
  const out = path.join(dir, `${id}.out.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${req}.tmp`, JSON.stringify({ input, timeoutS }));
    renameSync(`${req}.tmp`, req);
  } catch { return null; }
  if (!kickRelay(true)) { try { unlinkSync(req); } catch {} return null; }
  const deadline = Date.now() + (timeoutS + 120) * 1000;
  let nextKick = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (existsSync(out)) {
      try { const r = JSON.parse(readFileSync(out, "utf8")); unlinkSync(out); return r; } catch {}
    }
    if (Date.now() >= nextKick) { kickRelay(false); nextKick = Date.now() + 15000; }
    await new Promise((r) => setTimeout(r, 500));
  }
  try { unlinkSync(req); } catch {}
  return null;
}

async function judgeOutbound(input, timeoutS) {
  const r = await runGate(input, timeoutS);
  if (r && r.reason === NO_LOGIN && process.env.SPEAK_GATE_RELAYED !== "1" && process.env.SPEAK_GATE_NO_RELAY !== "1") {
    const relayed = await relayGate(input, timeoutS);
    if (relayed) return relayed;
  }
  return r;
}

/** The conversation a message lands in when its writer names none — the same
 *  rule as the jori_messages_route trigger (migration 0180), for a held
 *  message that is never inserted. */
async function conversationFor({ conversation_id, sender, channel }) {
  if (conversation_id) return conversation_id;
  if (sender) return `role:${sender}`;
  if (process.env.SPEAK_GATE_REVIEW_SINK) return "role:chief-of-staff";
  try {
    const rest = require(path.join(ROOT, "lib", "supabase-rest.js"));
    const rows = await rest.request(`/rest/v1/jori_channel_roles?select=role_id&channel=eq.${encodeURIComponent(channel || "chat")}&limit=1`);
    if (rows && rows[0] && rows[0].role_id) return `role:${rows[0].role_id}`;
  } catch {}
  return "role:chief-of-staff";
}

/**
 * Judge one outbound message before delivery.
 * @param {object} m {message, sender?, intent?, channel?, kind?: "proactive"|"reply",
 *   reply_to_text?, conversation_id?, fixed_choices?: string[], supporting_data?}
 * @returns {Promise<{deliver:boolean, text:string, verdict:string, reason?:string,
 *   review:object|null, skipped?:boolean}>} — `review` is the row to record once
 *   the message is inserted (recordReview); for a held message it is already recorded.
 */
export async function gateOutbound(m) {
  const message = String(m.message || "");
  if (!message.trim() || !inScope(m)) return { deliver: true, text: message, verdict: "send", review: null, skipped: true };
  const kind = ["reply", "report"].includes(m.kind) ? m.kind : "proactive";
  const t0 = Date.now();
  const r = await judgeOutbound({
    message, intent: m.intent || m.channel || "chat", sender: m.sender || null, channel: m.channel || "chat",
    kind, reply_to_text: m.reply_to_text || null, supporting_data: m.supporting_data || undefined,
    fixed_choices: Array.isArray(m.fixed_choices) && m.fixed_choices.length ? m.fixed_choices : undefined,
  }, Number(process.env.SPEAK_GATE_LIVE_TIMEOUT_S || LIVE_TIMEOUT_S[kind]));
  const conversation_id = await conversationFor(m);
  const base = { conversation_id, sender: m.sender || null, channel: m.channel || "chat", kind, live: true, original: message };

  if (!r || !r.verdict || String(r.reason || "").startsWith("gate_error")) {
    const reason = r ? String(r.reason || "gate_error") : "gate_error:no output";
    return { deliver: true, text: message, verdict: "error", reason,
      review: { ...base, verdict: "error", reason: reason.slice(0, 300), ms: Date.now() - t0 } };
  }
  let verdict = r.verdict;
  // A reply, or a report the user set up, is only ever sent or corrected.
  if (kind !== "proactive" && verdict !== "rewrite") verdict = "send";
  const review = {
    ...base, verdict, reason: r.reason || null,
    suggestion: verdict === "resolve" ? (r.research_plan || null) : null,
    checks: r.checks || null, sources: r.sources || null, ms: r.ms || (Date.now() - t0),
  };
  if (HOLD.has(verdict)) {
    await recordReview({ ...review, held: true }, null);
    return { deliver: false, text: message, verdict, reason: r.reason, review: null };
  }
  const text = verdict === "rewrite" && String(r.message || "").trim() ? String(r.message).trim() : message;
  if (verdict === "rewrite" && text === message) review.verdict = "send";
  return { deliver: true, text, verdict: review.verdict, reason: r.reason, review };
}

/** Write a review row; with a message id it is linked to the delivered row. Never throws. */
export async function recordReview(review, messageId) {
  if (!review) return false;
  // Test seam: SPEAK_GATE_REVIEW_SINK names a JSONL file that stands in for the table.
  if (process.env.SPEAK_GATE_REVIEW_SINK) {
    writeFileSync(process.env.SPEAK_GATE_REVIEW_SINK, JSON.stringify({ ...review, message_id: messageId || null }) + "\n", { flag: "a" });
    return true;
  }
  try {
    const rest = require(path.join(ROOT, "lib", "supabase-rest.js"));
    const row = { ...review, message_id: messageId || null };
    const q = messageId ? "?on_conflict=message_id" : "";
    await rest.request(`/rest/v1/jori_gate_reviews${q}`, {
      method: "POST", body: row, prefer: messageId ? "resolution=merge-duplicates,return=minimal" : "return=minimal",
    });
    return true;
  } catch (e) {
    // The review is lost, the message is not: park it for a look.
    try {
      const f = installTools("data", "speak-gate-live-unrecorded.jsonl");
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify({ ts: new Date().toISOString(), message_id: messageId || null, review, error: String(e.message || e) }) + "\n", { flag: "a" });
    } catch {}
    return false;
  }
}

// ─── After a hold: digest and resolve (migration 0185) ─────────────────────

function restClient() { return require(path.join(ROOT, "lib", "supabase-rest.js")); }
const enc = encodeURIComponent;

/**
 * Held `digest` messages for the daily summary of `date`: every one not yet
 * printed that was held before the day ended, plus any already printed in
 * THIS day's summary (so a re-render of the day still shows them).
 * @param {string} date YYYY-MM-DD   @param {string} dayEndIso the day's end instant
 * @returns {Promise<Array<{id, judged_at, sender, text, reason}>>}
 */
export async function heldDigests(date, dayEndIso) {
  const sel = "id,judged_at,sender,original,reason,digested_on";
  const q = `/rest/v1/jori_gate_reviews?select=${sel}&held=eq.true&verdict=eq.digest`
    + `&or=(and(digested_on.is.null,judged_at.lt.${enc(dayEndIso)}),digested_on.eq.${enc(date)})&order=judged_at.asc&limit=100`;
  const rows = await restClient().request(q);
  return (rows || []).filter((r) => String(r.original || "").trim())
    .map((r) => ({ id: r.id, judged_at: r.judged_at, sender: r.sender || null, text: String(r.original).trim(), reason: r.reason || null }));
}

/** Mark held digests as printed in `date`'s summary. */
export async function markDigested(ids, date) {
  if (!ids || !ids.length) return;
  await restClient().request(`/rest/v1/jori_gate_reviews?id=in.(${ids.join(",")})`,
    { method: "PATCH", body: { digested_on: date }, prefer: "return=minimal" });
}

/**
 * Answers the gate found instead of letting a question through (held
 * `resolve`), newest first.
 * @param {{sender?: string, since?: string, before?: string, notHandedBack?: boolean, limit?: number}} o
 */
export async function resolvedAnswers(o = {}) {
  const since = o.since || new Date(Date.now() - 14 * 864e5).toISOString();
  let q = `/rest/v1/jori_gate_reviews?select=id,judged_at,sender,original,suggestion,reason&held=eq.true&verdict=eq.resolve`
    + `&judged_at=gt.${enc(since)}`;
  if (o.before) q += `&judged_at=lt.${enc(o.before)}`;
  if (o.sender) q += `&sender=eq.${enc(o.sender)}`;
  if (o.notHandedBack) q += `&handed_back_at=is.null`;
  q += `&order=judged_at.desc&limit=${Number(o.limit || 20)}`;
  const rows = await restClient().request(q);
  return (rows || []).filter((r) => String(r.suggestion || "").trim());
}

/** Mark resolved answers as given to their role. */
export async function markHandedBack(ids) {
  if (!ids || !ids.length) return;
  await restClient().request(`/rest/v1/jori_gate_reviews?id=in.(${ids.join(",")})`,
    { method: "PATCH", body: { handed_back_at: new Date().toISOString() }, prefer: "return=minimal" });
}
