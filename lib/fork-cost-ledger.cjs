"use strict";
// fork-cost-ledger.cjs — cost rows for `claude -p` runs that happen OUTSIDE the
// three supervisors (2026-10-06, Self Improvement Review item 11).
//
// jori-cost-report rolls up per-supervisor job-costs.ndjson ledgers. Every
// Opus job — the weekly review, system-issue-review, improvement-plan, the
// cost-efficiency review itself, jev-disagreement-review and an installation's
// own scheduled research jobs — runs as an ephemeral launchd fork, so the report said "opus: 0 dispatches" in a week where four
// Opus jobs ran, and no claude-opus-5 row had ever existed.
//
// This writes those forks' rows in the SAME shape the supervisors write
// (agent/supervisor/index.mjs, turn_complete → appendJobCost), from the
// run's own `--output-format json` result, into one more ledger the report
// unions in:
//     agent/logs/ephemeral-forks/job-costs.ndjson
// Rows carry `runner: "ephemeral-fork"` so anything that needs to tell them
// apart from supervisor dispatches can.
//
// A fork is normally a fresh session, so its result's usage IS per-run. A
// RESUMED session (`--resume`: the team roles' chat sessions) is the exception:
// every result reports the whole session's cost and tokens so far. recordForkCost
// therefore diffs such a row against the session's previous row, so the ledger
// holds each invocation's own spend and a session's rows sum to its real cost.
// The running totals ride on the row as `session_cumulative` (and
// `session_cumulative_cost_usd`); a diffed row carries `session_delta: true`.
// This assumes the CLI reports a resumed session cumulatively: a result whose
// counters are LOWER than the session's previous row is taken as per-invocation
// and kept as reported, never diffed.
//
// Turns and duration are the exception. When a run's agent loop wakes again
// (a background task finishes and starts a new turn), the result's num_turns
// and duration_ms describe only that LAST segment, while total_cost_usd and
// modelUsage cover the whole session. So the row is completed from the run's
// own transcript: when the transcript spans clearly longer than the reported
// duration, num_turns becomes the transcript's count of main-thread assistant
// replies and duration_ms its wall-clock span, and the reported values are
// kept as num_turns_reported / duration_ms_reported (turns_source:
// "transcript"). A run whose result already covers it is left untouched.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { installTools } = require("./root.cjs");
const LEDGER_DIR = "ephemeral-forks";
function ledgerPath() {
  return process.env.JORI_FORK_COST_LEDGER
    || installTools("agent/logs", LEDGER_DIR, "job-costs.ndjson");
}

/**
 * Build a ledger row from a `claude -p --output-format json` result object (or
 * the `result` event of stream-json). Returns null when the result carries no
 * usage at all — an auth failure or a killed run spent nothing measurable, and
 * a zero row would only inflate the dispatch count.
 */
// The result covers the whole run unless the transcript is clearly longer.
const PARTIAL_RESULT_RATIO = 0.8;

function projectsDir() {
  if (process.env.JORI_CLAUDE_PROJECTS_DIR) return process.env.JORI_CLAUDE_PROJECTS_DIR;
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}

/**
 * Read a session's own transcript (<projects>/<any project>/<sessionId>.jsonl)
 * and return { wall_ms, replies }: the span between its first and last
 * timestamp, and the number of distinct main-thread assistant message ids
 * (subagent sidechains excluded, as num_turns excludes them). Null when the
 * transcript cannot be found or read. Never throws.
 */
function transcriptStats(sessionId, dir = projectsDir()) {
  if (!sessionId) return null;
  try {
    const name = `${sessionId}.jsonl`;
    let file = null;
    for (const d of fs.readdirSync(dir)) {
      const f = path.join(dir, d, name);
      if (fs.existsSync(f)) { file = f; break; }
    }
    if (!file) return null;
    let first = Infinity, last = -Infinity;
    const ids = new Set();
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const t = ev && ev.timestamp ? Date.parse(ev.timestamp) : NaN;
      if (Number.isFinite(t)) { if (t < first) first = t; if (t > last) last = t; }
      if (ev && ev.type === "assistant" && !ev.isSidechain && ev.message && ev.message.id) ids.add(ev.message.id);
    }
    if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
    return { wall_ms: last - first, replies: ids.size };
  } catch {
    return null;
  }
}

function rowFromResult({ job, result, model = null, now = new Date(), transcript = null }) {
  if (!result || typeof result !== "object") return null;
  let input = 0, output = 0, cacheRead = 0, cacheCreate = 0, webSearch = 0;
  const models = [];
  const mu = result.modelUsage && typeof result.modelUsage === "object" ? result.modelUsage : null;
  if (mu && Object.keys(mu).length) {
    for (const [m, u] of Object.entries(mu)) {
      models.push(m);
      input += u.inputTokens || 0;
      output += u.outputTokens || 0;
      cacheRead += u.cacheReadInputTokens || 0;
      cacheCreate += u.cacheCreationInputTokens || 0;
      webSearch += u.webSearchRequests || 0;
    }
  } else if (result.usage) {
    const u = result.usage;
    input = u.input_tokens || 0;
    output = u.output_tokens || 0;
    cacheRead = u.cache_read_input_tokens || 0;
    cacheCreate = u.cache_creation_input_tokens || 0;
    webSearch = u.server_tool_use?.web_search_requests || 0;
  }
  if (!models.length && model) models.push(model);
  const cost = Number(result.total_cost_usd) || 0;
  if (!(input + output + cacheRead + cacheCreate) && !cost) return null;
  const sid = result.session_id || null;
  const turns = result.num_turns ?? null;
  const dur = result.duration_ms ?? null;
  const partial = !!(transcript && dur != null && transcript.wall_ms > 0
    && dur < PARTIAL_RESULT_RATIO * transcript.wall_ms
    && transcript.replies > (turns || 0));
  const row = {
    ts: now.toISOString(),
    dispatch_id: null,
    short_id: sid ? String(sid).slice(0, 6) : "------",
    source: job,
    session_id: sid,
    duration_ms: partial ? transcript.wall_ms : dur,
    num_turns: partial ? transcript.replies : turns,
    total_cost_usd: cost,
    session_cumulative_cost_usd: cost,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreate,
    web_search_requests: webSearch,
    models,
    terminal_reason: result.terminal_reason || result.subtype || null,
    runner: "ephemeral-fork",
  };
  if (partial) {
    row.num_turns_reported = turns;
    row.duration_ms_reported = dur;
    row.turns_source = "transcript";
  }
  return row;
}

/** Append a row (fail-soft: a ledger write must never fail the job). */
function appendForkCost(row, file = ledgerPath()) {
  if (!row) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
    return true;
  } catch (err) {
    process.stderr.write(`fork-cost-ledger: could not append to ${file}: ${err.message}\n`);
    return false;
  }
}

// The counters a resumed session reports cumulatively, in the row's own names.
const CUM_FIELDS = [
  ["cost", "total_cost_usd"],
  ["input", "input_tokens"],
  ["output", "output_tokens"],
  ["cache_read", "cache_read_tokens"],
  ["cache_creation", "cache_creation_tokens"],
  ["web_search", "web_search_requests"],
];
const LEDGER_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * The newest ledger row of this session, or null (no session id, no ledger, no
 * earlier row). Reads only the file's tail. Never throws.
 */
function lastSessionRow(sessionId, file = ledgerPath()) {
  if (!sessionId) return null;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, LEDGER_TAIL_BYTES);
    const fd = fs.openSync(file, "r");
    let text;
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i] || !lines[i].includes(sessionId)) continue;
      let r;
      try { r = JSON.parse(lines[i]); } catch { continue; } // also drops a line cut by the tail
      if (r && r.session_id === sessionId) return r;
    }
  } catch { /* no ledger yet */ }
  return null;
}

/** A row's session running totals: its own `session_cumulative`, or, for a row written before those existed, its own fields (a resumed session reported its whole history in them). */
function cumulativeOf(row) {
  if (row.session_cumulative && typeof row.session_cumulative === "object") return row.session_cumulative;
  const c = { turns: row.num_turns || 0 };
  for (const [k, f] of CUM_FIELDS) c[k] = k === "cost" ? (row.session_cumulative_cost_usd ?? row.total_cost_usd) : row[f];
  return c;
}

/**
 * Turn a row built from a resumed session's result (whole-session figures) into
 * this invocation's own spend, given the session's previous row. A first row, or
 * a result whose counters went DOWN against the previous row (not a cumulative
 * report), is kept as reported. Returns null when nothing was spent since the
 * previous row (the same result recorded twice).
 */
function asSessionDelta(row, prior) {
  const cum = { turns: row.num_turns || 0 };
  for (const [k, f] of CUM_FIELDS) cum[k] = row[f] || 0;
  if (!prior) return { ...row, session_cumulative: cum };
  const prev = cumulativeOf(prior);
  if (!CUM_FIELDS.every(([k]) => cum[k] >= (prev[k] || 0))) return { ...row, session_cumulative: cum };
  const out = { ...row, session_delta: true };
  for (const [k, f] of CUM_FIELDS) out[f] = Math.round((cum[k] - (prev[k] || 0)) * 1e6) / 1e6;
  if (row.turns_source === "transcript") {
    // the transcript counts the whole session's replies
    out.num_turns = Math.max(0, cum.turns - (prev.turns || 0));
  } else {
    cum.turns = (prev.turns || 0) + (row.num_turns || 0);
  }
  out.session_cumulative = cum;
  out.session_cumulative_cost_usd = cum.cost;
  return CUM_FIELDS.some(([, f]) => out[f] > 0) ? out : null;
}

/** Convenience: build + append. Returns the row written, or null. */
function recordForkCost(args) {
  const transcript = args.transcript !== undefined
    ? args.transcript
    : transcriptStats(args.result && args.result.session_id);
  const built = rowFromResult({ ...args, transcript });
  const row = built && asSessionDelta(built, lastSessionRow(built.session_id));
  return appendForkCost(row) ? row : null;
}

module.exports = { rowFromResult, appendForkCost, recordForkCost, transcriptStats, ledgerPath, LEDGER_DIR, asSessionDelta, lastSessionRow };
