#!/usr/bin/env node
// speak-gate-audit — the speak gate's nightly audit (system/speak-gate.md
// § Nightly audit). The user, 2026-11-13: "add an opus process nightly for a
// week to double check the decisions made that day and provide feedback to the
// decision maker." It replaces the user grading each verdict in the app (the
// gate's lines were taken out of the chats the same day).
//
// For one day (default: yesterday, the user's display zone), every LIVE gate
// verdict not yet audited is re-checked by an Opus research session with the
// gate's own read-only tools (lib/speak-gate-agent.mjs), several to a session.
// Each gets a grade (right | partly | wrong), why, and what the gate should
// have done instead, written to its jori_gate_reviews row (migration 0189;
// the user's own grade/note columns are left alone).
//
// The feedback to the decision maker: the night's findings, the user's own
// grades and the existing lessons are distilled into at most 12 standing
// lessons in data/speak-gate-lessons.json, which bin/speak-gate.mjs reads into
// every judgment from then on.
//
// One week: the first run sets ends_at = now + 7 days in
// data/speak-gate-audit.json; after it every run exits at once (--force runs
// anyway). The last run emails the user one summary of the week.
//
//   speak-gate-audit [YYYY-MM-DD] [--batch 6] [--concurrency 2] [--limit N] [--dry-run] [--force] [--no-email]
//
// Run by launchd (ai.claude.speak-gate-audit, nightly) through
// speak-gate-audit-trigger, which sources the Max-auth guard.
"use strict";

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { OWNER, ASSISTANT, TOOLS_DOC, webAllowed, runAgent, lastJson, readLessons, lessonsPath } from "../../../lib/speak-gate-agent.mjs";

const require = createRequire(import.meta.url);
const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KERNEL = path.resolve(PLUGIN, "..", "..");
const { installTools } = require(path.join(KERNEL, "lib", "root.cjs"));
const { localConfig } = require(path.join(KERNEL, "lib", "instance.cjs"));
const { MODELS } = require(path.join(KERNEL, "lib", "models.cjs"));
try { require(path.join(KERNEL, "lib", "load-env.js")).loadEnv(); } catch {}
const rest = require(path.join(KERNEL, "lib", "supabase-rest.js"));

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const BATCH = Number(flag("batch", 6));
const CONC = Number(flag("concurrency", 2));
const LIMIT = Number(flag("limit", 0));
const DRY = args.includes("--dry-run");
const FORCE = args.includes("--force");
const NO_EMAIL = args.includes("--no-email");
const TZ = process.env.SPEAK_GATE_AUDIT_TZ || "America/New_York";
const STATE = installTools("data", "speak-gate-audit.json");
const LOCK = installTools("data", ".speak-gate-audit.lock");
const REPORTS = installTools("data", "speak-gate-audit");
const CFG = localConfig("speak-gate", { standing_rules: [] });
const WEEK_MS = 7 * 864e5;
const MAX_LESSONS = 12;
const enc = encodeURIComponent;
const oneLine = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
const log = (...a) => console.log(new Date().toISOString(), ...a);

function readState() { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; } }
function writeState(s) { mkdirSync(path.dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 1) + "\n"); }

function lock() {
  try {
    if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs < 4 * 3600e3) return false;
    writeFileSync(LOCK, String(process.pid));
    return true;
  } catch { return false; }
}

// ─── The day ────────────────────────────────────────────────────────────────

function ymdIn(tz, d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
/** The UTC instant of local midnight starting `ymd` in `tz`. */
function midnight(ymd, tz) {
  const guess = Date.parse(`${ymd}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(guess)).reduce((o, p) => (o[p.type] = p.value, o), {});
  const asLocal = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
  return new Date(guess - (asLocal - guess));
}
function dayWindow(ymd) {
  const start = midnight(ymd, TZ);
  const next = ymdIn(TZ, new Date(start.getTime() + 36 * 3600e3));
  return { start: start.toISOString(), end: midnight(next, TZ).toISOString() };
}
const fmtLocal = (iso) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(new Date(iso));

// ─── What to audit ──────────────────────────────────────────────────────────

async function reviewsFor(day) {
  const { start, end } = dayWindow(day);
  const sel = "id,message_id,conversation_id,sender,channel,kind,verdict,reason,suggestion,checks,sources,original,held,judged_at,grade,note";
  const rows = await rest.request(`/rest/v1/jori_gate_reviews?select=${sel}&live=eq.true&verdict=neq.error&audited_at=is.null`
    + `&judged_at=gte.${enc(start)}&judged_at=lt.${enc(end)}&order=judged_at.asc&limit=500`);
  return rows || [];
}

/** The delivered text of each reviewed message, and what the user wrote next in that conversation. */
async function enrich(rows) {
  const ids = rows.map((r) => r.message_id).filter(Boolean);
  const delivered = {};
  for (let i = 0; i < ids.length; i += 50) {
    const got = await rest.request(`/rest/v1/jori_messages?select=id,content&id=in.(${ids.slice(i, i + 50).join(",")})`);
    for (const m of got || []) delivered[m.id] = m.content;
  }
  for (const r of rows) {
    r.delivered = r.message_id ? delivered[r.message_id] || null : null;
    r.after = [];
    if (!r.conversation_id) continue;
    try {
      const until = new Date(Date.parse(r.judged_at) + 3 * 3600e3).toISOString();
      const next = await rest.request(`/rest/v1/jori_messages?select=content,created_at&conversation_id=eq.${enc(r.conversation_id)}&role=eq.user`
        + `&created_at=gt.${enc(r.judged_at)}&created_at=lt.${enc(until)}&order=created_at.asc&limit=3`);
      r.after = (next || []).map((m) => `[${fmtLocal(m.created_at)}] ${oneLine(m.content, 300)}`);
    } catch {}
  }
  return rows;
}

// ─── The audit ──────────────────────────────────────────────────────────────

function itemText(r, n) {
  const L = [`### Case ${n} — id ${r.id}`,
    `judged ${fmtLocal(r.judged_at)} (${r.judged_at}) · sender ${r.sender || "?"} · channel ${r.channel || "?"} · kind ${r.kind}`,
    `GATE VERDICT: ${r.verdict}${r.held ? " (held: never delivered)" : ""}`,
    `gate's reason: ${oneLine(r.reason, 400)}`];
  if (r.checks) L.push(`gate's checks: ${oneLine(JSON.stringify(r.checks), 500)}`);
  if (r.sources) L.push(`gate's sources: ${oneLine(JSON.stringify(r.sources), 400)}`);
  L.push(`WHAT THE ROLE WROTE:\n"""${String(r.original || "").slice(0, 2500)}"""`);
  if (r.verdict === "rewrite" && r.delivered) L.push(`WHAT THE GATE DELIVERED INSTEAD:\n"""${String(r.delivered).slice(0, 2500)}"""`);
  if (r.suggestion) L.push(`answer the gate found (resolve): ${oneLine(r.suggestion, 600)}`);
  if (r.grade) L.push(`${OWNER}'S OWN GRADE: ${r.grade}${r.note ? ` — "${oneLine(r.note, 300)}"` : ""}`);
  L.push(r.after.length ? `${OWNER} wrote next in that conversation (3h): ${r.after.join(" | ")}` : `${OWNER} wrote nothing in that conversation in the next 3h.`);
  return L.join("\n");
}

function auditPrompt(items) {
  const rules = (CFG.standing_rules || []).map((r) => `- ${r}`).join("\n");
  const lessons = readLessons().map((l) => `- ${l.text}`).join("\n");
  return `You are the senior reviewer of the "think before you speak" gate of ${OWNER}'s assistant (${ASSISTANT}). Every message to ${OWNER} passes the gate first. It answers four questions about a PROACTIVE message: 1 TRUE & CURRENT (every claim holds against the sources), 2 SELF-RESOLVE (could ${ASSISTANT} answer or close it without asking ${OWNER}?), 3 PHRASING (one point; a question is one decision with choices and a recommendation; short, plain), 4 VALUE (new, actionable or genuinely interesting, timely). A REPLY to ${OWNER} gets only 1 and 3 and can only be sent or rewritten; a REPORT email ${OWNER} set up the same. Verdicts: send (as written), rewrite (the gate's text is delivered instead), resolve (held; the answer goes back to the role), digest (held for the daily summary email), drop (held, discarded).

Below are the gate's decisions from one day. Double-check each one. RESEARCH, do not glance: verify the claims yourself with the tools, look for what the gate missed, and use what happened afterwards (${OWNER}'s next words, later rows) as evidence about whether the decision served him. Grade the DECISION against what was knowable when it was made; if later facts change the picture but the gate could not have known, it is still "right" and you say so.

For each case:
- grade: "right" (the verdict and any rewrite were what a careful chief of staff would do), "partly" (right verdict, flawed execution: a rewrite that lost or garbled something, a weak reason, a held message that should have been held differently), or "wrong" (a false claim let through, a message held that ${OWNER} needed, noise let through, a rewrite that made it worse, an answer it should have found and didn't).
- note: ≤300 chars, what you found and where.
- better: only when not right: the verdict it should have given, and for send/rewrite the text it should have delivered.
- lesson: only when not right AND the mistake generalizes: one sentence the gate should apply to future messages (a rule, not a case: no names of this one message's specifics unless they recur).

${TOOLS_DOC}
${rules ? `\n## ${OWNER.toUpperCase()}'S STANDING RULES (their own words; the gate must follow them, so a decision that follows one is right even if you'd have chosen otherwise)\n${rules}\n` : ""}${lessons ? `\n## LESSONS THE GATE WAS ALREADY GIVEN\n${lessons}\n` : ""}
## THE DECISIONS
${items.map((r, i) => itemText(r, i + 1)).join("\n\n")}

When done, end your answer with ONE LINE of compact JSON (nothing after it):
{"audits":[{"id":"<case id>","grade":"right|partly|wrong","note":"…","better":"…","lesson":"…"}]}`;
}

async function auditBatch(items) {
  const web = items.every((r) => webAllowed({ sender: r.sender, intent: r.channel }, CFG));
  const { text, err } = await runAgent(auditPrompt(items), { model: MODELS.opus, effort: "high", timeoutMs: 30 * 60e3, web });
  if (!text) return { error: `no output (${err?.killed ? "timeout" : err?.code || "empty"})` };
  if (text.startsWith("Not logged in")) return { error: "not logged in" };
  const p = lastJson(text);
  if (!p || !Array.isArray(p.audits)) return { error: `no json: ${oneLine(text.slice(-160), 160)}` };
  const ids = new Set(items.map((r) => r.id));
  return { audits: p.audits.filter((a) => a && ids.has(a.id) && ["right", "partly", "wrong"].includes(a.grade)) };
}

async function writeAudit(a) {
  if (DRY) return;
  await rest.request(`/rest/v1/jori_gate_reviews?id=eq.${a.id}`, {
    method: "PATCH", prefer: "return=minimal",
    body: { audit_grade: a.grade, audit_note: oneLine(a.note, 600) || null, audit_better: a.grade === "right" ? null : (String(a.better || "").slice(0, 3000) || null), audited_at: new Date().toISOString() },
  });
}

// ─── Feedback to the gate: the lessons ─────────────────────────────────────

async function distillLessons(day, audits, rows) {
  const current = readLessons();
  const misses = audits.filter((a) => a.grade !== "right").map((a) => {
    const r = rows.find((x) => x.id === a.id) || {};
    return `- [${a.grade}] ${r.kind || "?"} ${r.verdict || "?"} from ${r.sender || "?"}: ${oneLine(a.note, 300)}${a.lesson ? `\n  proposed lesson: ${oneLine(a.lesson, 300)}` : ""}`;
  });
  const userGrades = rows.filter((r) => r.grade).map((r) => `- ${OWNER} graded ${r.verdict} on "${oneLine(r.original, 160)}" as ${r.grade}${r.note ? `: "${oneLine(r.note, 200)}"` : ""}`);
  if (!misses.length && !userGrades.length) return { changed: false, lessons: current };
  const prompt = `You maintain the standing lessons of the "think before you speak" gate of ${OWNER}'s assistant: short rules, read by the gate before every judgment, distilled from a senior reviewer's nightly audit of its decisions. No research is needed for this task; do not use tools.

CURRENT LESSONS:
${current.length ? current.map((l, i) => `${i + 1}. ${l.text}`).join("\n") : "(none yet)"}

TONIGHT'S AUDIT OF ${day} — the decisions graded partly or wrong:
${misses.join("\n") || "(none)"}
${userGrades.length ? `\n${OWNER}'S OWN GRADES THAT DAY (they outrank the reviewer):\n${userGrades.join("\n")}\n` : ""}
Return the updated list: keep a lesson that still holds, merge duplicates, sharpen one that tonight's cases show is too vague, drop one tonight's evidence shows is wrong, and add a new one only for a mistake that will recur. A lesson is ONE sentence, ≤200 chars, a rule about a kind of message, never about one message. At most ${MAX_LESSONS}. Never contradict ${OWNER}'s standing rules:
${(CFG.standing_rules || []).map((r) => `- ${r}`).join("\n") || "(none)"}

End with ONE LINE of compact JSON: {"lessons":["…","…"]}`;
  const { text } = await runAgent(prompt, { model: MODELS.opus, effort: "medium", timeoutMs: 10 * 60e3, web: false });
  const p = lastJson(text);
  if (!p || !Array.isArray(p.lessons)) return { changed: false, lessons: current, error: "lessons: no json" };
  const since = new Map(current.map((l) => [l.text, l.since]));
  const next = p.lessons.map((t) => oneLine(t, 240)).filter(Boolean).slice(0, MAX_LESSONS).map((t) => ({ text: t, since: since.get(t) || day }));
  const changed = JSON.stringify(next.map((l) => l.text)) !== JSON.stringify(current.map((l) => l.text));
  if (changed && !DRY) {
    mkdirSync(path.dirname(lessonsPath()), { recursive: true });
    writeFileSync(lessonsPath(), JSON.stringify({ updated_at: new Date().toISOString(), source: "plugins/speak-gate/bin/speak-gate-audit.mjs", lessons: next }, null, 1) + "\n");
  }
  return { changed, lessons: next };
}

// ─── The week's summary email ───────────────────────────────────────────────

const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function weekSummary(state) {
  const nights = Object.entries(state.nights || {}).sort(([a], [b]) => a.localeCompare(b));
  const tot = nights.reduce((t, [, n]) => ({ audited: t.audited + (n.audited || 0), right: t.right + (n.right || 0), partly: t.partly + (n.partly || 0), wrong: t.wrong + (n.wrong || 0) }), { audited: 0, right: 0, partly: 0, wrong: 0 });
  if (!tot.audited) return false;
  const since = state.started_at;
  const wrong = await rest.request(`/rest/v1/jori_gate_reviews?select=judged_at,sender,kind,verdict,original,audit_grade,audit_note,audit_better`
    + `&audit_grade=eq.wrong&audited_at=gte.${enc(since)}&order=judged_at.desc&limit=8`).catch(() => []);
  const lessons = readLessons();
  const pct = (n) => `${Math.round((100 * n) / tot.audited)}%`;
  const html = `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:640px;line-height:1.45">
<h2 style="margin:0 0 8px">Speak gate: the week's audit</h2>
<p>Each night an Opus reviewer re-checked every decision the gate made that day: ${tot.audited} decisions over ${nights.length} night${nights.length === 1 ? "" : "s"}. <b>${pct(tot.right)} right</b>, ${pct(tot.partly)} partly, ${pct(tot.wrong)} wrong.</p>
<table style="border-collapse:collapse;font-size:14px">${nights.map(([d, n]) => `<tr><td style="padding:2px 12px 2px 0">${esc(d)}</td><td style="padding:2px 12px 2px 0">${n.audited} checked</td><td style="padding:2px 12px 2px 0">${n.right} right</td><td style="padding:2px 12px 2px 0">${n.partly} partly</td><td>${n.wrong} wrong</td></tr>`).join("")}</table>
${(wrong || []).length ? `<h3 style="margin:18px 0 6px">Wrong calls (latest ${wrong.length})</h3><ul>${wrong.map((w) => `<li style="margin-bottom:8px"><b>${esc(w.verdict)}</b> on a ${esc(w.kind)} from ${esc(w.sender || "?")}: “${esc(oneLine(w.original, 160))}”<br><span style="color:#555">${esc(w.audit_note)}</span>${w.audit_better ? `<br><span style="color:#555">Should have: ${esc(oneLine(w.audit_better, 240))}</span>` : ""}</li>`).join("")}</ul>` : ""}
<h3 style="margin:18px 0 6px">What the gate now applies (${lessons.length} lesson${lessons.length === 1 ? "" : "s"})</h3>
${lessons.length ? `<ol>${lessons.map((l) => `<li>${esc(l.text)}</li>`).join("")}</ol>` : "<p>No lessons: nothing it got wrong generalized.</p>"}
<p style="color:#777;font-size:13px">The nightly audit has ended; the lessons stay in effect (data/speak-gate-lessons.json). Each decision's audit is on its row in jori_gate_reviews.</p></div>`;
  if (DRY || NO_EMAIL) { log("summary email (not sent):", tot); return true; }
  const r = spawnSync(path.join(KERNEL, "bin", "email-send"), ["--to", "me", "--subject", `Speak gate audit: ${pct(tot.right)} of ${tot.audited} decisions right this week`, "--html", "--body", html],
    { encoding: "utf8", timeout: 600e3, env: process.env });
  log("summary email:", r.status, oneLine(r.stdout, 200), oneLine(r.stderr, 200));
  return r.status === 0;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

async function main() {
  const state = readState();
  if (!state.started_at) { state.started_at = new Date().toISOString(); state.ends_at = new Date(Date.now() + WEEK_MS).toISOString(); state.nights = {}; }
  if (Date.now() > Date.parse(state.ends_at) && !FORCE) {
    if (!state.summary_sent && await weekSummary(state)) { state.summary_sent = new Date().toISOString(); writeState(state); }
    log(`audit week ended ${state.ends_at}; nothing to do`); return;
  }
  if (!lock()) { log("another audit is running; skip"); return; }
  try {
    const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || ymdIn(TZ, new Date(Date.now() - 864e5));
    let rows = await reviewsFor(day);
    if (LIMIT) rows = rows.slice(0, LIMIT);
    log(`${day}: ${rows.length} live decisions to audit`);
    if (!rows.length) { state.nights[day] = state.nights[day] || { audited: 0, right: 0, partly: 0, wrong: 0 }; }
    else {
      await enrich(rows);
      // Money and health cases are researched without the web, so they batch apart.
      const groups = [[], []];
      for (const r of rows) groups[webAllowed({ sender: r.sender, intent: r.channel }, CFG) ? 0 : 1].push(r);
      const batches = groups.flatMap((g) => { const b = []; for (let i = 0; i < g.length; i += BATCH) b.push(g.slice(i, i + BATCH)); return b; });
      const audits = []; const errors = [];
      await pool(batches, CONC, async (b, k) => {
        const t0 = Date.now();
        const r = await auditBatch(b);
        if (r.error) { errors.push(r.error); log(`batch ${k + 1}/${batches.length}: ${r.error}`); return; }
        for (const a of r.audits) { await writeAudit(a).catch((e) => errors.push(`write ${a.id}: ${e.message}`)); audits.push(a); }
        log(`batch ${k + 1}/${batches.length}: ${r.audits.length}/${b.length} audited in ${Math.round((Date.now() - t0) / 1000)}s`);
      });
      const count = (g) => audits.filter((a) => a.grade === g).length;
      const les = await distillLessons(day, audits, rows);
      const night = { audited: audits.length, of: rows.length, right: count("right"), partly: count("partly"), wrong: count("wrong"), errors: errors.length, lessons: les.lessons.length, lessons_changed: les.changed, at: new Date().toISOString() };
      const prev = state.nights[day];
      state.nights[day] = prev ? { ...night, audited: night.audited + (prev.audited || 0), right: night.right + (prev.right || 0), partly: night.partly + (prev.partly || 0), wrong: night.wrong + (prev.wrong || 0) } : night;
      if (!DRY) {
        mkdirSync(REPORTS, { recursive: true });
        writeFileSync(path.join(REPORTS, `${day}.json`), JSON.stringify({ day, night, audits, lessons: les.lessons, errors }, null, 1) + "\n");
      }
      log(`${day}: ${JSON.stringify(night)}`);
    }
    if (!DRY) writeState(state);
    // The last night of the week: one summary to the user.
    if (!DRY && !state.summary_sent && Date.now() + 864e5 > Date.parse(state.ends_at) && await weekSummary(state)) {
      state.summary_sent = new Date().toISOString(); writeState(state);
    }
  } finally { try { unlinkSync(LOCK); } catch {} }
}

main().catch((e) => { log("audit failed:", e.stack || e.message); try { unlinkSync(LOCK); } catch {} process.exit(1); });
