// self-status — what Jori is doing right now, and how it is going.
//
// One read of every place Jori's own work lives, so an agent answers "is it
// done?", "what are you working on?" or "why did that stop?" from live state
// instead of from memory or a guess (agent/CLAUDE.md Rule #1, § Your own state).
//
// Sections (each collected on its own; one that cannot be read is reported
// under `unknown` with the reason, never as an empty list):
//   dispatches  the four supervisors: in flight (/health), queued (their
//               persisted queues), recent `disp … → / done / error` log lines,
//               a dispatch that started and never finished (interrupted)
//   forks       background sub-agents (delegate) from the fork queue
//   purchases   the purchase queue (data/purchases/queue.json) and the
//               Face-ID approvals (purchase_approvals), with the poller's result
//   builds      build requests (data/build-queue): pending, held (and why),
//               running, asking the user, done, failed
//   jobs        job-run background jobs (data/jobs)
//   cron        scheduled jobs whose last run failed (data/cron-runs.jsonl),
//               open job-failure incidents and repairs, supervisors whose new
//               code has not loaded yet (watchdog.log)
//   questions   open questions the user has not answered (open-questions)
//   approvals   action and self-improvement approvals waiting for Face ID
//   roles       role-session messages waiting for their role
//   watches     standing watches (counts only)
//   doctor      `jori doctor --json` failures (only with deep: true; ~10 s)
//
// Every item: { section, bucket, id, what, state, at, age_s, detail }.
// Buckets: running, queued, waiting (on the user), stuck, failed, done.
// Statuses are reported raw, as their source wrote them: "placed" is the
// purchase poller's word, not a promise that a booking exists, so the result
// fields go along with it.
//
// Fast by design (default path well under 2 s): logs are read from their tail,
// HTTP calls carry short timeouts and run in parallel. Read-only throughout.

import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { CLICK_SIGNAL_TEXT } from "./purchase-approval.mjs";

const require = createRequire(import.meta.url);

const HERE = path.dirname(new URL(import.meta.url).pathname);

export const BUCKETS = ["running", "waiting", "stuck", "failed", "queued", "done"];
export const BUCKET_TITLES = {
  running: "Running now",
  waiting: "Waiting on the user",
  stuck: "Stuck or stopped",
  failed: "Failed",
  queued: "Queued",
  done: "Done recently",
};
export const SECTIONS = ["dispatches", "forks", "purchases", "builds", "jobs", "cron", "questions", "approvals", "roles", "watches", "doctor"];

// Supervisors: health port name, persisted queue, log stem.
export const AGENTS = [
  { id: "chat", health: "chat_health", queue: "agent/supervisor/state/chat/queue.json", log: null },
  { id: "ops", health: "ops_health", queue: "data/dispatcher-queue.json", log: "ops-supervisor" },
  { id: "ops-light", health: "ops_light_health", queue: "data/dispatcher-queue-ops-light.json", log: "ops-light-supervisor" },
  { id: "ops-haiku", health: "ops_haiku_health", queue: "data/dispatcher-queue-ops-haiku.json", log: "ops-haiku-supervisor" },
];

const H = 3600e3;
const RECENT_MS = 24 * H;       // done / failed items shown
const PURCHASE_MS = 48 * H;     // purchase history shown
const INTERRUPT_MS = 10 * 60e3;  // a dispatch started this long ago with no done/error, not in flight
const LOG_TAIL = 400_000;
const BUILD_TIMEOUT_MS = 135 * 60e3;   // trigger-chat-build.sh TIMEOUT_MIN (120) + slack
const ROLE_TIMEOUT_MS = 20 * 60e3;     // role-session-trigger --timeout-min 15 + slack
const CRON_TAIL = 4_000_000;
// Purchase-queue statuses (bin/purchase-queue, jobs/purchase.md) by bucket.
const PQ_DONE = new Set(["placed", "clicked", "done", "denied", "expired", "cancelled", "canceled"]);
// purchase_approvals statuses (system/migrations/0020_approvals.sql).
const PA_RUNNING = new Set(["signed", "executing"]);
const PA_DONE = new Set(["placed", "clicked", "denied", "expired", "cancelled"]);

const clip = (s, n = 160) => {
  const t = String(s ?? "").split(/\s+/).filter(Boolean).join(" "); // lang-regex-ok: whitespace collapse of stored text for display
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const toMs = (v) => { if (v == null || v === "") return null; const n = typeof v === "number" ? v : Date.parse(v); return Number.isFinite(n) ? n : null; };

/** Last `bytes` of a file as text, starting at a whole line. "" when missing. */
export function tailText(file, bytes = LOG_TAIL) {
  try {
    const st = fs.statSync(file);
    const n = Math.min(st.size, bytes);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, st.size - n);
    fs.closeSync(fd);
    let t = buf.toString("utf8");
    if (n < st.size) t = t.slice(t.indexOf("\n") + 1);
    return t;
  } catch { return ""; }
}

function item(section, bucket, o, now) {
  const atMs = toMs(o.at);
  return {
    section, bucket, id: o.id ?? null, what: o.what ?? "", state: o.state ?? bucket,
    at: atMs ? new Date(atMs).toISOString() : null,
    age_s: atMs ? Math.max(0, Math.round((now - atMs) / 1000)) : null,
    ...(o.detail && Object.values(o.detail).some((v) => v != null && v !== "") ? { detail: Object.fromEntries(Object.entries(o.detail).filter(([, v]) => v != null && v !== "")) } : {}),
  };
}

// ── dispatches ──────────────────────────────────────────────────────────────

/**
 * Parse supervisor log lines (agent/supervisor/index.mjs):
 *   <iso> [supervisor] disp <id6> → <source>: <task head>...
 *   <iso> [supervisor] disp <id6> done <source> <ms>ms $<cost> turns=<n>
 *   <iso> [supervisor] disp <id6> error <source>: <error>
 * Returns dispatches by short id, in start order.
 */
export function parseDispatchLog(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    const at = line.indexOf(" [supervisor] disp ");
    if (at < 0) continue;
    const ts = line.slice(0, at);
    const rest = line.slice(at + " [supervisor] disp ".length);
    const sp = rest.indexOf(" ");
    if (sp < 0) continue;
    const id = rest.slice(0, sp);
    const tail = rest.slice(sp + 1);
    if (tail.startsWith("→ ")) {
      const body = tail.slice(2);
      const colon = body.indexOf(": ");
      const source = colon >= 0 ? body.slice(0, colon) : body;
      const task = colon >= 0 ? body.slice(colon + 2).replace(/\.\.\.$/, "") : ""; // lang-regex-ok: strip the log's own truncation marker
      out.set(id, { id, source, task, started: ts, status: "started" });
    } else if (tail.startsWith("done ")) {
      const [, source, ms, cost, turns] = tail.split(" ");
      const d = out.get(id) || { id, source, task: "", started: null };
      Object.assign(d, { status: "done", finished: ts, ms: parseInt(ms, 10) || null, cost: cost ? cost.replace("$", "") : null, turns: turns ? Number(turns.split("=")[1]) : null });
      out.set(id, d);
    } else if (tail.startsWith("error ")) {
      const body = tail.slice(6);
      const colon = body.indexOf(": ");
      const d = out.get(id) || { id, source: colon >= 0 ? body.slice(0, colon) : body, task: "", started: null };
      Object.assign(d, { status: "error", finished: ts, error: colon >= 0 ? body.slice(colon + 2) : "" });
      out.set(id, d);
    }
  }
  return [...out.values()];
}

/** The supervisor's log: today's file plus the newest dated, uncompressed one. */
function supervisorLogText(logsDir, stem) {
  let dated = "";
  try {
    const f = fs.readdirSync(logsDir).filter((x) => x.startsWith(stem + "-") && x.endsWith(".log")).sort().pop();
    if (f) dated = tailText(path.join(logsDir, f), LOG_TAIL / 2);
  } catch {}
  return dated + "\n" + tailText(path.join(logsDir, stem + ".log"));
}

async function collectDispatches(ctx) {
  const { root, now, fetchJson, port } = ctx;
  const items = [], unknown = [], supervisors = [];
  const healths = await Promise.all(AGENTS.map(async (a) => {
    let p; try { p = port(a.health); } catch { p = null; }
    return p ? fetchJson(`http://127.0.0.1:${p}/health`, 1500) : null;
  }));
  AGENTS.forEach((a, i) => {
    const h = healths[i];
    if (!h) {
      unknown.push({ section: "dispatches", why: `${a.id} supervisor health unreachable` });
      items.push(item("dispatches", "stuck", { id: a.id, what: `${a.id} supervisor`, state: "unreachable", at: now }, now));
    } else {
      supervisors.push({ agent: a.id, alive: !!h.childAlive, model: h.model || null, queue: h.queueDepth ?? null, in_flight: h.inFlight?.source || null, last_event_age_s: h.lastEventAgeMs != null ? Math.round(h.lastEventAgeMs / 1000) : null });
      if (h.childAlive === false) items.push(item("dispatches", "stuck", { id: a.id, what: `${a.id} agent session`, state: "child not alive", at: h.lastEventTs }, now));
      if (h.dispatcherPaused) items.push(item("dispatches", "stuck", { id: a.id, what: `${a.id} dispatcher`, state: "paused", at: h.lastEventTs }, now));
      const hold = toMs(h.rateLimitHoldUntil);
      if (hold && hold > now) items.push(item("dispatches", "stuck", { id: a.id, what: `${a.id} dispatcher`, state: `rate-limit hold until ${new Date(hold).toISOString()}`, at: now }, now));
    }
    // Queued work, as the supervisor persisted it.
    const q = readJson(path.join(root, a.queue), null);
    for (const it of (q?.queue || [])) {
      items.push(item("dispatches", "queued", { id: String(it.id || "").slice(0, 6), what: `${a.id}: ${it.source || "?"}`, state: "queued", at: it.enqueuedAt }, now));
    }
    // In flight, as /health sees it.
    const inflight = h?.inFlight;
    let inflightTask = "";
    let started = inflight?.enqueuedAt;
    let recent = [];
    if (a.log) {
      recent = parseDispatchLog(supervisorLogText(path.join(root, "agent/logs"), a.log));
      const live = inflight && recent.find((d) => String(inflight.id || "").startsWith(d.id));
      if (live) { inflightTask = live.task; started = live.started || started; }
    }
    if (inflight) {
      items.push(item("dispatches", "running", { id: String(inflight.id || "").slice(0, 6), what: `${a.id}: ${inflight.source}${inflightTask ? ` — ${clip(inflightTask, 90)}` : ""}`, state: "in flight", at: started }, now));
    }
    for (const d of recent) {
      if (inflight && String(inflight.id || "").startsWith(d.id)) continue;
      const fin = toMs(d.finished), st = toMs(d.started);
      if (d.status === "done" && fin && now - fin < RECENT_MS) {
        items.push(item("dispatches", "done", { id: d.id, what: `${a.id}: ${d.source}`, state: "done", at: d.finished, detail: { ms: d.ms, cost_usd: d.cost, turns: d.turns } }, now));
      } else if (d.status === "error" && fin && now - fin < RECENT_MS) {
        items.push(item("dispatches", "failed", { id: d.id, what: `${a.id}: ${d.source}`, state: "error", at: d.finished, detail: { error: clip(d.error, 200) } }, now));
      } else if (d.status === "started" && h && st && now - st < RECENT_MS && now - st > INTERRUPT_MS) {
        // Started, never reported done or error, not the one in flight: the
        // session was restarted or rotated under it.
        items.push(item("dispatches", "stuck", { id: d.id, what: `${a.id}: ${d.source} — ${clip(d.task, 90)}`, state: "interrupted (started, never finished)", at: d.started }, now));
      }
    }
  });
  return { items, unknown, extra: { supervisors } };
}

// ── forks (delegate) ────────────────────────────────────────────────────────

async function collectForks(ctx) {
  const { root, now } = ctx;
  const items = [];
  const dbPath = path.join(root, "data/memory-index.db");
  if (!fs.existsSync(dbPath)) return { items, unknown: [] };
  let rows = [];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const d = new DatabaseSync(dbPath, { readOnly: true });
    try {
      rows = d.prepare("SELECT id, session_id, task, status, error, created_at, finished_at FROM pending_forks WHERE created_at > ? ORDER BY created_at DESC LIMIT 30").all(now - RECENT_MS);
    } finally { d.close(); }
  } catch (e) {
    if (/no such table/.test(String(e.message))) return { items, unknown: [] }; // lang-regex-ok: sqlite error text, machine-generated
    return { items, unknown: [{ section: "forks", why: e.message }] };
  }
  for (const r of rows) {
    const bucket = r.status === "running" ? "running" : r.status === "queued" ? "queued" : r.status === "failed" ? "failed" : "done";
    items.push(item("forks", bucket, { id: `#${r.id}`, what: `${r.session_id} background task: ${clip(r.task, 110)}`, state: r.status, at: r.finished_at || r.created_at, detail: r.error ? { error: clip(r.error, 160) } : undefined }, now));
  }
  return { items, unknown: [] };
}

// ── purchases ───────────────────────────────────────────────────────────────

export function purchaseQueueItems(queue, now) {
  const items = [];
  // The purchase job runs one request at a time, and a retry is a new request,
  // so a request that stopped short with a later one after it is history
  // (failed bucket), not the thing that is stuck now.
  let later = null;
  for (const r of (queue || []).slice().reverse()) {
    const at = toMs(r.done_at || r.claimed_at || r.queued_at);
    if (!at || now - at > PURCHASE_MS) continue;
    let bucket, state = r.status;
    if (r.status === "queued") bucket = "queued";
    else if (r.status === "in_progress") bucket = now - toMs(r.claimed_at) < 45 * 60e3 ? "running" : "stuck";
    else if (PQ_DONE.has(r.status)) bucket = "done";
    else bucket = "stuck"; // needs_card, needs_code_fix, stale, failed, abandoned, …: the job stopped short
    if (bucket === "stuck" && later) { bucket = "failed"; state = `${r.status} (a later request followed: ${later})`; }
    items.push(item("purchases", bucket, { id: r.id, what: `purchase request${r.site ? ` on ${r.site}` : ""}: ${clip(r.asked, 140)}`, state, at }, now));
    later = later || r.id;
  }
  return items;
}

export function purchaseApprovalItems(rows, now) {
  const items = [];
  for (const r of rows || []) {
    const item0 = r.item_json || {};
    const total = Number.isFinite(item0.total_cents) ? `${(item0.total_cents / 100).toFixed(2)} ${item0.currency || ""}`.trim() : null;
    const titles = (item0.items || []).map((x) => x.title).filter(Boolean).join("; ");
    const what = `purchase approval${titles ? `: ${clip(titles, 90)}` : ""}${total ? ` (${total})` : ""}`;
    const exp = toMs(r.expires_at_ms);
    let bucket, state = r.status;
    if (r.status === "pending") {
      if (exp && exp < now) { bucket = "done"; state = "expired (never decided)"; } else bucket = "waiting";
    } else if (PA_RUNNING.has(r.status)) bucket = "running";
    else if (PA_DONE.has(r.status)) bucket = "done";
    else bucket = "failed"; // stale, failed
    const res = r.result || null;
    const detail = {};
    if (res) {
      for (const k of ["reason", "missing", "clicked", "after_title", "error"]) if (res[k] != null) detail[k] = Array.isArray(res[k]) ? res[k].join(", ") : clip(res[k], 160);
      // Which evidence the executor's "placed" rests on (bin/purchase-approval-poll,
      // clickOutcome). Rows from before it recorded `signal`: "placed" with the
      // same URL can only mean the Place Order button left the page.
      const signal = res.signal || (r.status === "placed" && res.before_url && res.before_url === res.after_url ? "button_gone"
        : r.status === "placed" && res.after_url && res.after_url !== res.before_url ? "url_changed" : null);
      if (signal) detail.after_click = CLICK_SIGNAL_TEXT[signal] || signal;
      if (r.status === "clicked") detail.after_click = "the page did not change after the click: not confirmed";
    }
    if (r.executed_at) detail.executed_at = r.executed_at;
    items.push(item("purchases", bucket, { id: r.id, what, state, at: r.executed_at || r.decided_at || r.created_at, detail: Object.keys(detail).length ? detail : undefined }, now));
  }
  return items;
}

async function collectPurchases(ctx) {
  const { root, now, supabase, pluginOn } = ctx;
  const items = [], unknown = [];
  const qf = path.join(root, "data/purchases/queue.json");
  const on = pluginOn("purchases");
  if (!on && !fs.existsSync(qf)) return { items, unknown };
  if (fs.existsSync(qf)) {
    const q = readJson(qf, null);
    if (!Array.isArray(q)) unknown.push({ section: "purchases", why: "purchase queue unreadable" });
    else items.push(...purchaseQueueItems(q, now));
  }
  if (!supabase) {
    if (on) unknown.push({ section: "purchases", why: "Face-ID approvals (purchase_approvals) not read: no Supabase access in this read" });
  } else {
    const since = new Date(now - PURCHASE_MS).toISOString();
    const rows = await supabase(`purchase_approvals?select=id,status,item_json,expires_at_ms,created_at,decided_at,executed_at,result&created_at=gte.${since}&order=created_at.desc&limit=6`);
    if (rows == null) unknown.push({ section: "purchases", why: "purchase_approvals unreachable" });
    else items.push(...purchaseApprovalItems(rows, now));
  }
  return { items, unknown };
}

// ── builds ──────────────────────────────────────────────────────────────────

function heldReason(root, id) {
  const t = tailText(path.join(root, "agent/logs/chat-build.log"), 300_000);
  const key = `${id}: held by the allowance governor: `;
  const i = t.lastIndexOf(key);
  if (i < 0) return null;
  return clip(t.slice(i + key.length, t.indexOf("\n", i) > 0 ? t.indexOf("\n", i) : undefined), 160);
}

function resultHead(root, id) {
  const f = path.join(root, "data/build-queue/results", `${id}.md`);
  try {
    const line = fs.readFileSync(f, "utf8").split("\n").map((s) => s.trim()).find((s) => s && !s.startsWith("#"));
    return line ? clip(line, 200) : null;
  } catch { return null; }
}

async function collectBuilds(ctx) {
  const { root, now } = ctx;
  const q = path.join(root, "data/build-queue");
  const items = [];
  if (!fs.existsSync(q)) return { items, unknown: [] };
  const states = { pending: "queued", held: "stuck", running: "running", asks: "waiting", parked: "waiting", done: "done", failed: "failed" };
  for (const [dir, bucket] of Object.entries(states)) {
    let files = [];
    try { files = fs.readdirSync(path.join(q, dir)).filter((f) => f.endsWith(".json") && !f.startsWith(".")); } catch { continue; }
    for (const f of files) {
      const p = path.join(q, dir, f);
      const id = f.replace(/\.json$/, ""); // lang-regex-ok: file extension
      let mtime = null; try { mtime = fs.statSync(p).mtimeMs; } catch {}
      if ((bucket === "done" || bucket === "failed") && (!mtime || now - mtime > RECENT_MS)) continue;
      const rec = readJson(p, {}) || {};
      const detail = {};
      if (dir === "held") detail.held_because = heldReason(root, id) || "held by the allowance governor (the reason is not in chat-build.log)";
      if (dir === "asks" || dir === "parked") detail.question = clip(rec.question || rec.ask?.question || "", 160) || undefined;
      if (bucket === "done" || bucket === "failed") { const r = resultHead(root, id); if (r) detail.result = r; }
      if (rec.requested_at) detail.requested_at = rec.requested_at;
      let state = dir === "asks" || dir === "parked" ? "asking the user" : dir;
      let b = bucket;
      if (dir === "running") {
        // The file stays in running/ when the run is killed; only the next build
        // run moves it to failed/. So check the run is really there.
        const started = toMs(rec.requested_at) || mtime;
        const alive = ctx.procAlive("run-ephemeral-opus.sh chat-build");
        if (started && now - started > BUILD_TIMEOUT_MS) { b = "stuck"; state = "running past the build timeout (probably cut off)"; }
        else if (alive === false) { b = "stuck"; state = "no build process alive (cut off; the next build run moves it to failed)"; }
      }
      items.push(item("builds", b, { id, what: `build${rec.size ? ` (${rec.size})` : ""}: ${clip(rec.spec, 140)}`, state, at: (bucket === "done" || bucket === "failed") ? mtime : (rec.requested_at || mtime), detail: Object.values(detail).some(Boolean) ? detail : undefined }, now));
    }
  }
  return { items, unknown: [] };
}

// ── job-run jobs ────────────────────────────────────────────────────────────

async function collectJobs(ctx) {
  const { root, now } = ctx;
  const dir = path.join(root, "data/jobs");
  const items = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes(".tmp")); } catch { return { items, unknown: [] }; }
  for (const f of files) {
    const j = readJson(path.join(dir, f), null);
    if (!j) continue;
    const fin = toMs(j.finished_at);
    let bucket;
    if (j.status === "running" || j.status === "starting") bucket = "running";
    else if (j.status === "failed" || j.status === "lost") bucket = "failed";
    else if (j.status === "done" && j.exit_code && j.exit_code !== 0) bucket = "failed";
    else bucket = "done";
    if (bucket !== "running" && (!fin || now - fin > RECENT_MS)) continue;
    items.push(item("jobs", bucket, { id: j.id, what: `background job ${j.name}`, state: j.status + (j.exit_code ? ` (exit ${j.exit_code})` : ""), at: bucket === "running" ? j.started_at : j.finished_at, detail: { log: j.log_file || undefined } }, now));
  }
  return { items, unknown: [] };
}

// ── cron / job health ───────────────────────────────────────────────────────

export function cronFailures(text, now) {
  const last = new Map(), streak = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r.label) continue;
    const bad = r.exit !== 0 || !!r.signal;
    streak.set(r.label, bad ? (streak.get(r.label) || 0) + 1 : 0);
    last.set(r.label, r);
  }
  const out = [];
  for (const [label, r] of last) {
    const n = streak.get(label) || 0;
    const end = toMs(r.end || r.start);
    if (!n || !end || now - end > RECENT_MS) continue;
    out.push({ label, runs_failed_in_a_row: n, exit: r.exit, signal: r.signal || null, at: r.end || r.start });
  }
  return out.sort((a, b) => b.runs_failed_in_a_row - a.runs_failed_in_a_row);
}

/** watchdog.log lines are host-local time with no zone: "YYYY-MM-DD HH:MM:SS [tag] text". */
export function codeReloadHolds(text, now) {
  const latest = new Map();
  for (const line of text.split("\n")) {
    const i = line.indexOf(" [supervisor-code-reload] ");
    if (i < 0) continue;
    const at = new Date(line.slice(0, i).replace(" ", "T")).getTime(); // local time, as written
    const msg = line.slice(i + " [supervisor-code-reload] ".length);
    const c = msg.indexOf(": ");
    if (c < 0) continue;
    latest.set(msg.slice(0, c), { at, msg: msg.slice(c + 2) });
  }
  const out = [];
  for (const [agent, v] of latest) {
    if (!Number.isFinite(v.at) || now - v.at > 30 * 60e3) continue;
    if (v.msg.startsWith("stale")) out.push({ agent, state: v.msg, at: v.at });
  }
  return out;
}

async function collectCron(ctx) {
  const { root, now } = ctx;
  const items = [], unknown = [];
  const runs = path.join(root, "data/cron-runs.jsonl");
  let extra = {};
  if (fs.existsSync(runs)) {
    const text = tailText(runs, CRON_TAIL);
    try { const first = JSON.parse(text.slice(0, text.indexOf("\n"))); const from = toMs(first.start); if (from && now - from < RECENT_MS) extra = { cron_checked_since: new Date(from).toISOString() }; } catch {}
    for (const f of cronFailures(text, now)) {
      items.push(item("cron", "failed", { id: f.label, what: `scheduled job ${f.label}`, state: `last ${f.runs_failed_in_a_row} run(s) failed${f.signal ? ` (${f.signal})` : ` (exit ${f.exit})`}`, at: f.at }, now));
    }
  } else unknown.push({ section: "cron", why: "data/cron-runs.jsonl missing" });
  const st = readJson(path.join(root, "data/job-failure-state.json"), null);
  for (const [label, inc] of Object.entries(st?.incidents || {})) {
    items.push(item("cron", "stuck", { id: label, what: `failing-job incident ${label}`, state: inc.status || "open", at: inc.opened_at || inc.since, detail: inc.error ? { error: clip(inc.error, 160) } : undefined }, now));
  }
  const rq = readJson(path.join(root, "data/job-repair-queue.json"), null);
  for (const r of rq?.pending || []) {
    items.push(item("cron", r.status === "claimed" ? "running" : "queued", { id: r.id, what: `job repair for ${r.label}`, state: r.status || "pending", at: r.claimed_at || r.queued_at }, now));
  }
  for (const h of codeReloadHolds(tailText(path.join(root, "agent/logs/watchdog.log"), 200_000), now)) {
    items.push(item("cron", "stuck", { id: h.agent, what: `${h.agent} supervisor runs old code (new code landed, reload held)`, state: h.state, at: h.at }, now));
  }
  return { items, unknown, extra };
}

// ── questions, approvals, roles, watches ────────────────────────────────────

async function collectQuestions(ctx) {
  const { now, openQuestions } = ctx;
  if (!openQuestions) return { items: [], unknown: [] };
  try {
    const qs = await openQuestions();
    return { items: qs.map((q) => item("questions", "waiting", { id: q.id, what: `open question: ${clip(q.question, 150)}`, state: `asked ${q.asks}x`, at: q.first_asked_at }, now)), unknown: [] };
  } catch (e) { return { items: [], unknown: [{ section: "questions", why: e.message }] }; }
}

async function collectApprovals(ctx) {
  const { now, supabase } = ctx;
  if (!supabase) return { items: [], unknown: [{ section: "approvals", why: "no Supabase access" }] };
  const items = [], unknown = [];
  const [acts, sis] = await Promise.all([
    supabase("action_approvals?status=eq.pending&select=id,item_json,created_at,expires_at_ms&order=created_at.desc&limit=10"),
    supabase("self_improve_approvals?status=in.(pending,signed)&skipped=eq.false&select=id,summary,status,created_at&order=created_at.desc&limit=10"),
  ]);
  if (acts == null) unknown.push({ section: "approvals", why: "action_approvals unreachable" });
  for (const r of acts || []) {
    const exp = toMs(r.expires_at_ms);
    if (exp && exp < now) continue;
    const it = r.item_json || {};
    items.push(item("approvals", "waiting", { id: r.id, what: `Face-ID approval: ${clip(it.title || `${it.plugin || ""} ${it.action || ""}`, 140)}`, state: "pending", at: r.created_at }, now));
  }
  if (sis == null) unknown.push({ section: "approvals", why: "self_improve_approvals unreachable" });
  for (const r of sis || []) {
    items.push(item("approvals", r.status === "signed" ? "running" : "waiting", { id: r.id, what: `improvement card: ${clip(r.summary, 140)}`, state: r.status, at: r.created_at }, now));
  }
  return { items, unknown };
}

async function collectRoles(ctx) {
  const { root, now } = ctx;
  const items = [];
  for (const [dir, bucket] of [["pending", "queued"], ["running", "running"], ["failed", "failed"]]) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, "data/role-queue", dir)).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      const r = readJson(path.join(root, "data/role-queue", dir, f), {}) || {};
      let mtime = null; try { mtime = fs.statSync(path.join(root, "data/role-queue", dir, f)).mtimeMs; } catch {}
      if (bucket === "failed" && (!mtime || now - mtime > RECENT_MS)) continue;
      let b = bucket, st = dir === "failed" ? "role session failed" : dir;
      if (dir === "running") {
        const alive = ctx.procAlive("run-ephemeral-opus.sh role-");
        if (mtime && now - mtime > ROLE_TIMEOUT_MS) { b = "stuck"; st = "running past the role-session timeout (probably cut off)"; }
        else if (alive === false) { b = "stuck"; st = "no role session alive (cut off)"; }
      }
      items.push(item("roles", b, { id: f.replace(/\.json$/, ""), what: `message for ${(r.roles || [r.role]).filter(Boolean).join(", ") || "a role"} in ${r.conversation_id || "?"}`, state: st, at: dir === "failed" ? mtime : (r.created_at || mtime) }, now)); // lang-regex-ok: file extension
    }
  }
  return { items, unknown: [] };
}

async function collectWatches(ctx) {
  const { watchCounts } = ctx;
  if (!watchCounts) return { items: [], unknown: [] };
  try { return { items: [], unknown: [], extra: { watches: await watchCounts() } }; }
  catch (e) { return { items: [], unknown: [{ section: "watches", why: e.message }] }; }
}

async function collectDoctor(ctx) {
  const { now, runDoctor } = ctx;
  if (!ctx.deep) return { items: [], unknown: [] };
  const checks = await runDoctor();
  if (!Array.isArray(checks)) return { items: [], unknown: [{ section: "doctor", why: "jori doctor --json gave no result" }] };
  const items = [];
  for (const c of checks) {
    const level = c.level || (c.ok === false ? "fail" : c.warn ? "warn" : "ok");
    if (level === "ok" || c.ok === true && !c.warn) continue;
    items.push(item("doctor", level === "warn" ? "stuck" : "failed", { id: c.name, what: `doctor: ${c.name}`, state: level, at: now, detail: c.detail ? { detail: clip(c.detail, 200) } : undefined }, now));
  }
  return { items, unknown: [] };
}

const COLLECTORS = { dispatches: collectDispatches, forks: collectForks, purchases: collectPurchases, builds: collectBuilds, jobs: collectJobs, cron: collectCron, questions: collectQuestions, approvals: collectApprovals, roles: collectRoles, watches: collectWatches, doctor: collectDoctor };

// ── default I/O (overridable for tests) ─────────────────────────────────────

async function defaultFetchJson(url, timeoutMs = 1500, headers = undefined) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function defaultSupabase() {
  try { require("./load-env.js").loadEnv(); } catch {}
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let base = null;
  try { base = require("./instance.cjs").supabaseUrl(); } catch {}
  if (!key || !base) return null;
  return (q) => defaultFetchJson(`${base}/rest/v1/${q}`, 2500, { apikey: key, Authorization: `Bearer ${key}` });
}

function defaultRunDoctor(root) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(root, "bin/jori"), "doctor", "--json"], { timeout: 45000, maxBuffer: 4e6 }, (err, stdout) => {
      try { const j = JSON.parse(stdout); resolve(Array.isArray(j) ? j : j.checks || null); } catch { resolve(null); }
    });
  });
}

/** true / false when pgrep can tell; null when it cannot (then nothing is inferred). */
function defaultProcAlive(pattern) {
  try { execFileSync("pgrep", ["-f", pattern], { stdio: "ignore", timeout: 2000 }); return true; }
  catch (e) { return e.status === 1 ? false : null; }
}

function defaultRoot() {
  try { return require("./root.cjs").installTools(); } catch { return path.join(HERE, ".."); }
}

/**
 * Collect the snapshot.
 * @param {object} o
 * @param {string[]} [o.sections]  subset of SECTIONS (default: all but doctor unless deep)
 * @param {boolean} [o.deep]       also run `jori doctor --json` (~10 s)
 * @param {string}  [o.match]      keep only items whose text contains this (case-insensitive, plain substring)
 * @param {boolean} [o.remote]     query Supabase (default true)
 */
export async function collect(o = {}) {
  const now = o.now ?? Date.now();
  const root = o.root || defaultRoot();
  const ctx = {
    root, now, deep: !!o.deep,
    fetchJson: o.fetchJson || defaultFetchJson,
    port: o.port || ((name) => require("./ports.cjs").port(name)),
    supabase: o.remote === false ? null : (o.supabase !== undefined ? o.supabase : defaultSupabase()),
    pluginOn: o.pluginOn || ((n) => { try { return require("./plugins.cjs").isEnabled(n); } catch { return false; } }),
    openQuestions: o.openQuestions !== undefined ? o.openQuestions : async () => (await import("./open-questions.mjs")).openQuestions(now),
    watchCounts: o.watchCounts !== undefined ? o.watchCounts : async () => {
      const W = await import("./watches.mjs");
      const rules = W.listRules({ all: true });
      const counts = {};
      for (const r of rules) counts[r.status] = (counts[r.status] || 0) + 1;
      return counts;
    },
    runDoctor: o.runDoctor || (() => defaultRunDoctor(root)),
    procAlive: o.procAlive || defaultProcAlive,
  };
  const wanted = (o.sections && o.sections.length ? o.sections : SECTIONS).filter((s) => COLLECTORS[s] && (s !== "doctor" || ctx.deep));
  const results = await Promise.all(wanted.map(async (s) => {
    try { return await COLLECTORS[s](ctx); }
    catch (e) { return { items: [], unknown: [{ section: s, why: `collector failed: ${e.message}` }] }; }
  }));
  let items = results.flatMap((r) => r.items);
  const unknown = results.flatMap((r) => r.unknown);
  const extra = Object.assign({}, ...results.map((r) => r.extra || {}));
  if (o.match) {
    const m = String(o.match).toLowerCase();
    items = items.filter((it) => JSON.stringify([it.id, it.what, it.state, it.detail]).toLowerCase().includes(m));
  }
  const order = (it) => BUCKETS.indexOf(it.bucket);
  items.sort((a, b) => order(a) - order(b) || (a.age_s ?? 1e12) - (b.age_s ?? 1e12));
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, items.filter((i) => i.bucket === b).length]));
  return { as_of: new Date(now).toISOString(), sections: wanted, counts, items, unknown, ...extra };
}

export function fmtAge(s) {
  if (s == null) return "?";
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 48 * 3600) return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Compact text for agents and people. `doneLimit` caps the done list. */
export function render(snap, { tz = undefined, doneLimit = 12, footer = true, compact = false } = {}) {
  const when = new Date(snap.as_of).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const lines = [`What Jori is doing, as of ${when}`];
  const c = snap.counts;
  lines.push(BUCKETS.map((b) => `${c[b]} ${b}`).join(" · "));
  for (const b of BUCKETS) {
    const its = snap.items.filter((i) => i.bucket === b);
    if (!its.length) continue;
    lines.push("", `${BUCKET_TITLES[b]} (${its.length}${b === "done" || b === "failed" ? ", last 24h" : ""})`);
    const shown = b === "done" ? its.slice(0, doneLimit) : its;
    for (const i of shown) {
      const d = i.detail && !compact ? "  " + Object.entries(i.detail).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}: ${v}`).join("; ") : "";
      lines.push(`- [${i.section}] ${compact ? clip(i.what, 100) : i.what} — ${i.state}, ${fmtAge(i.age_s)} ago${i.id ? ` (${i.id})` : ""}${d ? `\n   ${d.trim()}` : ""}`);
    }
    if (shown.length < its.length) lines.push(`- … ${its.length - shown.length} more (use --json or a section filter)`);
  }
  if (snap.supervisors?.length) {
    lines.push("", "Supervisors: " + snap.supervisors.map((s) => `${s.agent} ${s.alive ? "up" : "DOWN"}${s.in_flight ? `, busy (${s.in_flight})` : ", idle"}${s.queue ? `, ${s.queue} queued` : ""}`).join(" | "));
  }
  if (snap.cron_checked_since) lines.push(`Failing schedules checked since ${new Date(snap.cron_checked_since).toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", timeZoneName: "short" })} (the run log's tail), not the full 24h`);
  if (snap.watches) lines.push("Watches: " + Object.entries(snap.watches).map(([k, v]) => `${v} ${k}`).join(", "));
  if (snap.unknown.length) {
    lines.push("", "Could not read (so unknown, not empty):");
    for (const u of snap.unknown) lines.push(`- ${u.section}: ${u.why}`);
  }
  if (!snap.items.length && !snap.unknown.length) lines.push("", "Nothing running, waiting, stuck or failed.");
  if (footer) lines.push("", "Not here: what Jori said (recall_events, the chat transcript) and how Jori is built (system/architecture.md).");
  return lines.join("\n");
}
