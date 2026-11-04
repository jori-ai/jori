"use strict";
// Live-day signal gatherers — pull non-GPS, non-calendar evidence and shape
// it as timestamped claims that attach to the matching interval's
// evidence_log on every refresh.
//
// Today's sources:
//   - chat_signal: jori_messages where the user explicitly states/implies
//     a place ("at X", "going to X", "just left X")
//   - task_completion: Google Tasks completed during the day; the title
//     becomes a narrative hint for the covering interval
//
// Adding a new signal type is a single-function change: write a gatherer
// that returns `[{ ts_ms, source, claim, place_hint?, activity_hint? }]`,
// hand its output to `attachSignals` in live-day.js. No schema migration,
// no reader churn.

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { instance, supabaseUrl } = require("./instance.cjs");
const { dayWindow } = require("./day-window.js");

// gog: $GOG_BIN, else a package-manager install (cron's PATH has neither), else PATH.
const GOG = process.env.GOG_BIN || ["/opt/homebrew/bin/gog", "/usr/local/bin/gog"].find((p) => fs.existsSync(p)) || "gog";
const SUPABASE_URL = process.env.SUPABASE_URL || supabaseUrl();

async function supabaseSelect(table, query) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || !SUPABASE_URL) return [];
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  try {
    const r = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

// Cheap heuristic patterns — explicit place mentions in chat. The local
// LLM helper at lib/local-llm.mjs could do better classification of
// implicit signals (e.g., "what's the wait at Pho Grand?" → near Pho
// Grand), but this is V1: catch the easy 80% with regex, iterate later.
const CHAT_PATTERNS = [
  { re: /\b(?:i'?m|i am|we'?re|we are)\s+at\s+(?:the\s+)?([A-Z][\w\s'&-]{2,40})/, kind: "currently_at" },
  { re: /\b(?:going|heading|on\s+my\s+way)\s+to\s+(?:the\s+)?([A-Z][\w\s'&-]{2,40})/, kind: "planning_visit" },
  { re: /\bjust\s+(?:left|got\s+to|arrived\s+at)\s+(?:the\s+)?([A-Z][\w\s'&-]{2,40})/, kind: "transit_marker" },
  { re: /\b(?:had|having|grabbing|got)\s+(?:lunch|dinner|breakfast|coffee|drinks)\s+at\s+(?:the\s+)?([A-Z][\w\s'&-]{2,40})/, kind: "meal_at" },
];

function extractChatHint(text) {
  if (!text) return null;
  for (const p of CHAT_PATTERNS) {
    const m = text.match(p.re);
    if (m) return { kind: p.kind, place: m[1].trim().replace(/[.,;!?]+$/, "") };
  }
  return null;
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function gatherChatSignals(dateStr, etBoundaryUtcIso) {
  const startIso = etBoundaryUtcIso(dateStr);
  const endIso = etBoundaryUtcIso(addDays(dateStr, 1));
  const rows = await supabaseSelect(
    "jori_messages",
    `select=role,content,created_at` +
      `&role=eq.user` +
      `&created_at=gte.${encodeURIComponent(startIso)}` +
      `&created_at=lt.${encodeURIComponent(endIso)}` +
      `&order=created_at.asc`,
  );
  const out = [];
  for (const r of rows || []) {
    const hint = extractChatHint(r.content || "");
    if (!hint) continue;
    const ts_ms = Date.parse(r.created_at);
    if (!Number.isFinite(ts_ms)) continue;
    out.push({
      ts_ms,
      source: "chat_signal",
      // lang-regex-ok: collapses whitespace in a quoted excerpt, does not interpret it
      claim: `${hint.kind}: "${hint.place}" — chat said: "${(r.content || "").slice(0, 80).replace(/\s+/g, " ")}"`,
      place_hint: hint.place,
      activity_hint: hint.kind,
    });
  }
  return out;
}

function gatherTaskSignals(dateStr, tz) {
  // The day in the home zone (or `tz`), DST-correct (day-window.js).
  // The account is the owner's (instance owner_email); GOG_ACCOUNT mirrors the
  // calendar fetch path (gog needs explicit account resolution even when only
  // one is registered). No owner_email: no task signals.
  const account = process.env.JORI_CAL_ACCOUNT || instance().owner_email;
  if (!account) return [];
  const w = dayWindow(dateStr, tz || undefined);
  const args = [
    "tasks", "list", "@default",
    "-a", account,
    "--show-completed", "--show-hidden",
    "--completed-min", w.start,
    "--completed-max", new Date(w.endMs - 1000).toISOString(),
    "--no-input", "--json", "--results-only",  // --results-only flattens the {nextPageToken, tasks} envelope
  ];
  const env = { ...process.env, GOG_ACCOUNT: account };
  const res = spawnSync(GOG, args, { encoding: "utf8", env, timeout: 15_000 });
  if (res.status !== 0) return [];
  let tasks;
  try { tasks = JSON.parse(res.stdout || "[]"); } catch { return []; }
  // gog with --results-only returns the bare array of tasks
  if (!Array.isArray(tasks)) return [];
  const out = [];
  for (const t of tasks) {
    if (!t.completed) continue;
    const ts_ms = Date.parse(t.completed);
    if (!Number.isFinite(ts_ms)) continue;
    const title = t.title || (t.notes || "").slice(0, 80) || "untitled task";
    out.push({
      ts_ms,
      source: "task_completion",
      claim: `Completed task: "${title}"`,
      activity_hint: title,
    });
  }
  return out;
}

function attachSignals(intervals, signals) {
  for (const sig of signals) {
    const iv = intervals.find(i => i.start_ts_ms <= sig.ts_ms && i.end_ts_ms >= sig.ts_ms);
    if (!iv) continue;
    iv.evidence_log.push({
      ts: new Date(sig.ts_ms).toISOString(),
      source: sig.source,
      claim: sig.claim,
      outcome: "evidence_attached",
    });
    // First non-empty activity_hint wins per interval — preserves the most
    // specific narrative anchor (a chat "currently_at" beats a generic task
    // title only because we apply chat signals first; tasks fill in
    // otherwise-empty intervals).
    if (sig.activity_hint && !iv.activity_hint) {
      iv.activity_hint = sig.activity_hint;
    }
  }
}

module.exports = {
  gatherChatSignals,
  gatherTaskSignals,
  attachSignals,
  // exported for tests
  _internal: { extractChatHint },
};
