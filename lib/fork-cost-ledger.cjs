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
// A fork is a fresh session, so its result's usage IS per-run — no cumulative
// cursor diffing like the supervisors need.
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

/** Convenience: build + append. Returns the row written, or null. */
function recordForkCost(args) {
  const transcript = args.transcript !== undefined
    ? args.transcript
    : transcriptStats(args.result && args.result.session_id);
  const row = rowFromResult({ ...args, transcript });
  return appendForkCost(row) ? row : null;
}

module.exports = { rowFromResult, appendForkCost, recordForkCost, transcriptStats, ledgerPath, LEDGER_DIR };
