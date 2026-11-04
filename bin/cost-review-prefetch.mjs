#!/usr/bin/env node
// cost-review-prefetch — derive, in the un-sandboxed trigger process, the facts
// the cost review re-derives with an agent turn every single night.
//
// WHY (2026-09-13). The review is the largest ephemeral-Opus workload on the
// account — $119 list / 8.9% of weekly spend over the 7d to 2026-09-13 — and
// 95% of its tokens are cache-read, which is `turns x context`. Measured over
// 10 complete runs it takes 76-123 turns at ~$0.17/turn. The state-file pruner
// (an approved card) cut its largest INPUT 45% and the cost did not move, because
// the state file is read in filtered slices and never enters context whole.
// Turns are the multiplicand, so turns are the lever.
//
// Seven derivations account for the bulk of the mechanical turns, and every one
// is deterministic arithmetic over files this process already has open:
//   1. per-job ledger rollup, today vs yesterday, gmail:<id> folded to gmail:*
//   2. the mix-vs-drift decomposition of turns_per_dispatch
//   3. the always-loaded mtime sweep + wiki bundle chars + pinned count
//   4. context-guard runaway candidates, the runaway discriminators applied
//   5. this job's own per-run cost series from the transcript tree
//   6. job_cost_index comparability (thin-volume test vs 7d daily median)
//   7. lane activity: dark-lane gaps + $/day over RUNNING days, not calendar
//
// Same rationale as the report pre-fetch above it in the trigger: the fetch
// belongs in the un-sandboxed process, the agent reads plain JSON.
//
// Deterministic, idempotent, fails open — writes what it can and exits 0 so it
// can never block the night's review. No model, no network.
//
// Usage: cost-review-prefetch <today.json> <7d.json> <out.json>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const HOME = os.homedir();
const ROOT = createRequire(import.meta.url)('../lib/root.cjs').installRoot();
// Claude Code names a session's transcript dir after its cwd, with every
// character that is not a letter or digit turned into '-'. The supervisor dirs
// are derived from ROOT rather than spelled out, so a layout move cannot leave
// the transcript scans below reading a dir that no longer exists (they did,
// silently, after the switch from <root>/tools to the Jori root).
// lang-regex-ok: encodes a filesystem path into Claude Code's project-dir name, machine structure only
const projectDir = (agentDir) => path.join(HOME, '.claude/projects', path.join(ROOT, 'agent', agentDir).replace(/[^a-zA-Z0-9]/g, '-'));
// Imported, not restated: the compaction-cliff arithmetic must track the live
// guard. context-guard.mjs is a pure module (index.mjs is the CLI entrypoint),
// so importing it does not start a supervisor.
import {
  CONTEXT_COMPACT_THRESHOLD_TOKENS,
  CONTEXT_ROTATE_THRESHOLD_TOKENS,
  MIN_COMPACTABLE_TOKENS,
} from '../agent/supervisor/context-guard.mjs';
const GUARD_THRESHOLDS = {
  compact: CONTEXT_COMPACT_THRESHOLD_TOKENS,
  rotate: CONTEXT_ROTATE_THRESHOLD_TOKENS,
  min_compactable: MIN_COMPACTABLE_TOKENS,
};

const [todayPath, weekPath, outPath] = process.argv.slice(2);
if (!todayPath || !weekPath || !outPath) {
  console.error('usage: cost-review-prefetch <today.json> <7d.json> <out.json>');
  process.exit(64);
}

const readJson = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } };
const today = readJson(todayPath, null);
const week = readJson(weekPath, {});
const out = { generated_at: new Date().toISOString(), errors: [] };
const guard = (name, fn) => { try { out[name] = fn(); } catch (e) { out.errors.push(`${name}: ${e.message}`); out[name] = null; } };

if (!today || !today.since) {
  fs.writeFileSync(outPath, JSON.stringify({ ...out, fatal: 'today.json unreadable' }, null, 2));
  process.exit(0);
}

const SINCE = Date.parse(today.since);
const WINDOW_MS = 24 * 3600 * 1000;
const TIERS = ['ops', 'ops-light', 'ops-haiku'];

// --- ledger rollup: this window vs the one before it ------------------------
function rollup() {
  const cur = {}, prev = {}, runawayRows = [];
  let curT = { runs: 0, turns: 0, usd: 0 }, prevT = { runs: 0, turns: 0, usd: 0 };
  for (const tier of TIERS) {
    const f = path.join(ROOT, `agent/logs/supervisor-${tier}/job-costs.ndjson`);
    let content; try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(r.ts || 0); if (!ts) continue;
      const inCur = ts >= SINCE;
      const inPrev = ts >= SINCE - WINDOW_MS && ts < SINCE;
      if (!inCur && !inPrev) continue;
      const bucket = inCur ? cur : prev;
      const tot = inCur ? curT : prevT;
      // gmail:<messageId> is one row per message; fold the family so the
      // rollup is not shattered into singletons.
      const raw = r.source || '(none)';
      const src = raw.startsWith('gmail:') ? 'gmail:*' : raw;
      const b = bucket[src] || (bucket[src] = { runs: 0, turns: 0, usd: 0, cache_read: 0, cache_write: 0, output: 0 });
      b.runs++; b.turns += (r.num_turns || 0); b.usd += (r.total_cost_usd || 0);
      b.cache_read += (r.cache_read_tokens || 0);
      b.cache_write += (r.cache_creation_tokens || 0);
      b.output += (r.output_tokens || 0);
      tot.runs++; tot.turns += (r.num_turns || 0); tot.usd += (r.total_cost_usd || 0);
      // A context-guard row reading >1M cache tokens MIGHT be a runaway
      // /compact. Apply the runaway discriminators here so the agent never
      // has to re-derive them: a compaction issues no web searches and is not
      // a turn loop. Either test failing means the row is another job's work
      // wearing the compactor's name.
      if (inCur && src === 'context-guard' && (r.cache_read_tokens || 0) > 1e6) {
        const ws = r.web_search_requests || 0, turns = r.num_turns || 0;
        runawayRows.push({
          ts: r.ts, cache_read: r.cache_read_tokens, num_turns: turns,
          web_search_requests: ws, usd: r.total_cost_usd,
          could_have_been_a_compaction: ws === 0 && turns <= 1,
          verdict: ws > 0 ? 'misattributed (web searches)' : turns > 1 ? 'misattributed (turn loop)' : 'GENUINE runaway candidate',
        });
      }
    }
  }
  const fmt = (o) => Object.entries(o).map(([job, v]) => ({
    job, ...v, usd: +v.usd.toFixed(2),
    turns_per_run: +(v.turns / v.runs).toFixed(1),
    usd_per_run: +(v.usd / v.runs).toFixed(3),
  })).sort((a, b) => b.usd - a.usd);
  return { current: fmt(cur), previous: fmt(prev), totals: { current: curT, previous: prevT }, runaway_candidates: runawayRows, _cur: cur, _prev: prev };
}
guard('ledger', rollup);

// --- mix vs per-job drift on turns_per_dispatch -----------------------------
// turns_per_dispatch is total_turns/dispatches, so it is MIX-SENSITIVE in
// exactly the way $/dispatch and context_overhead_pct already are. A quiet day
// that drops the high-volume low-turn lanes (session-handoff 1 turn,
// context-guard 0, location-enrich ~3) while the weekly research lanes run
// their normal single passes will raise it 40% with no job getting heavier.
// Decompose before flagging.
guard('turns_decomposition', () => {
  const L = out.ledger; if (!L) return null;
  const cur = L._cur, prev = L._prev;
  const C = L.totals.current, P = L.totals.previous;
  let cfNum = 0, cfDen = 0, baseNum = 0;
  for (const [job, p] of Object.entries(prev)) {
    const c = cur[job]; if (!c) continue;
    cfNum += (c.turns / c.runs) * p.runs;
    baseNum += p.turns;
    cfDen += p.runs;
  }
  const counterfactual = cfDen ? cfNum / cfDen : null;   // today's per-job rates, yesterday's mix
  const baseline = cfDen ? baseNum / cfDen : null;       // yesterday's per-job rates, yesterday's mix
  const observed = C.runs ? C.turns / C.runs : null;
  const previous = P.runs ? P.turns / P.runs : null;
  const drift = (counterfactual != null && baseline != null) ? counterfactual - baseline : null;
  const shrank = Object.entries(prev)
    .map(([job, p]) => ({ job, previous_runs: p.runs, current_runs: cur[job] ? cur[job].runs : 0, their_turns_per_run: +(p.turns / p.runs).toFixed(1) }))
    .filter((r) => r.previous_runs - r.current_runs >= 4)
    .sort((a, b) => (b.previous_runs - b.current_runs) - (a.previous_runs - a.current_runs));
  return {
    observed_turns_per_dispatch: observed != null ? +observed.toFixed(2) : null,
    previous_window: previous != null ? +previous.toFixed(2) : null,
    per_job_drift_contribution: drift != null ? +drift.toFixed(2) : null,
    mix_contribution: (observed != null && previous != null && drift != null) ? +((observed - previous) - drift).toFixed(2) : null,
    note: 'per_job_drift_contribution is the part a job actually getting heavier explains. The rest is mix.',
    jobs_that_shrank: shrank,
  };
});
if (out.ledger) { delete out.ledger._cur; delete out.ledger._prev; }

// --- always-loaded surface sweep -------------------------------------------
// mtimes FIRST: they catch committed AND working-tree edits, and the live
// agents read the working tree, not HEAD. Every mtime older than the window
// start means the prefix did not change, full stop. tools-mcp/health-mcp are
// in the list because .mcp.json only NAMES a server — the tool schemas that
// land in the prefix live in the server's own source (card
// cost-mcp-floor-sweep-20260827).
guard('always_loaded_surfaces', () => {
  const files = [
    'agent/CLAUDE.md', 'agent/ops-agent/CLAUDE.md',
    // the instance's local rules, appended to every ops system prompt
    'agent/local/shared.md', 'agent/local/ops.md',
    'agent/config/agents.json', 'agent/ops-agent/.mcp.json',
    // the instance's additions merged into agents.json at spawn (loadAgentConfig)
    'agent/local/config/agents.json',
    'bin/wiki-session-context', 'agent/tools-mcp/index.mjs',
    'agent/health-mcp/index.mjs',
  ];
  const sweep = files.map((rel) => {
    try {
      const st = fs.statSync(path.join(ROOT, rel));
      return { file: rel, mtime: st.mtime.toISOString(), inside_window: st.mtime.getTime() >= SINCE };
    } catch { return { file: rel, mtime: null, inside_window: null, note: 'unreadable — absence of data, NOT absence of change' }; }
  });
  return { window_start: new Date(SINCE).toISOString(), files: sweep, any_inside_window: sweep.some((f) => f.inside_window === true) };
});

// --- MCP tool listing in the prefix ----------------------------------------
// The mtime sweep above cannot see this at all. The deferred-tool listing is
// part of every session's cached prefix, and it is built from the CONNECTED
// servers — including claude.ai ACCOUNT connectors, which live in the user's
// Anthropic account and touch no file on this machine. On 2026-09-18 the
// claude.ai Vercel connector went 37 -> 212 tools and put +4,245 tokens on
// every ops / ops-light session start and every turn (+3,055 on ops-haiku),
// while every file in the sweep above read clean. Same defect family as
// cost-mcp-floor-sweep-20260827, one level further out: a check that reads
// absence of a file change as absence of a prefix change.
//
// The listing also ignores allowedTools: a tool the CLI will refuse to call is
// still named in the prefix and still paid on every turn. So the split that
// matters is granted vs ungranted, not present vs absent.
//
// The listing FLICKERS — a connector can be missing from one session start and
// present in the next — so `current` is taken from the LARGEST listing in the
// window, not the newest, and every distinct size seen is reported alongside it.
guard('mcp_tool_listing', () => {
  const PROJECTS = path.join(HOME, '.claude/projects');
  // Measured 2026-09-19 on the Vercel step: +175 names = +7,500 chars = +4,245
  // Sonnet tokens. These identifiers tokenize far denser than prose (underscore
  // splits), so a prose chars/token ratio would understate them badly.
  const TOK_PER_CHAR = 0.566;
  const HAIKU_RATIO = 0.725;   // the standing ops-haiku:ops-light floor ratio
  let agents = {}; try { agents = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent/config/agents.json'), 'utf8')).agents || {}; } catch {}
  // lang-regex-ok: matches an allowedTools GLOB against a tool id — both are machine-generated identifiers, no language judgement
  const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  const listingOf = (file) => {
    let content; try { content = fs.readFileSync(file, 'utf8'); } catch { return null; }
    let n = 0;
    for (const line of content.split('\n')) {
      if (++n > 12) break;
      if (!line || line.indexOf('deferred_tools') < 0) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      const a = d.attachment || {};
      if (!String(a.type || '').includes('deferred_tools')) continue;
      const names = a.addedNames || [];
      if (names.length) return names;
    }
    return null;
  };
  // The ops-agent project dir holds THREE populations: the `ops` supervisor, every
  // Opus launchd fork (run-ephemeral-opus.sh runs with that cwd), and Sonnet
  // `claude -p` forks with the same cwd (daily-summary-run via job-run and the
  // other scripted model calls). Until
  // 2026-10-09 both were read as `ops`, so the fork connector gap went
  // unseen for two days after the supervisor deny, and `ops.current`
  // kept listing Resend/Gusto from fork sessions the deny never reached
  // (fork_listing_invisible_to_deriver_20261008, mcp_listing_current_reads_stale_
  // transcript_20261007). The supervisor is identified by its session id (the
  // transcript file name) appearing in its own ledger; the rest split on the
  // session's model id, which the transcript records on its first assistant turn
  // (~450-670KB in, after the session-start attachments). Machine-generated JSON
  // keys, not language.
  const MODEL_KEY = '"model":"claude-';
  const isOpusText = (s) => { const i = s.indexOf(MODEL_KEY); return i >= 0 && s.startsWith('opus', i + MODEL_KEY.length); };
  const opsSessionIds = new Set();
  try {
    const since = new Date(Date.now() - 35 * 86400e3).toISOString();
    for (const line of fs.readFileSync(path.join(ROOT, 'agent/logs/supervisor-ops/job-costs.ndjson'), 'utf8').split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.session_id && String(r.ts || '') >= since) opsSessionIds.add(r.session_id);
    }
  } catch {}
  const stemOf = (file) => path.basename(file, '.jsonl');
  const isOpusFile = (file) => {
    let fd; try { fd = fs.openSync(file, 'r'); } catch { return false; }
    try {
      const buf = Buffer.alloc(1_500_000);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return isOpusText(buf.toString('utf8', 0, n));
    } catch { return false; } finally { try { fs.closeSync(fd); } catch {} }
  };
  // A tool the agent is ALLOWED to call and never does costs exactly as much as
  // one it is forbidden to call. `ungranted` was the only axis until 2026-09-25,
  // and it pointed the wrong way twice: claude.ai Sonos (799 tok) and claude.ai
  // Supabase (619 tok) are ungranted AND duplicate capabilities Jori already
  // has locally, while Vercel — the largest ungranted server at 6,128 tok — is
  // genuinely called, just 26 times in 30 days. Ranking a connector cut needs
  // the CALL COUNT beside the token count, so compute it here rather than by
  // hand in the agent turn (self_cost_ceiling_20260910).
  //
  // Counted by substring over the four supervisor transcript trees, 30 days,
  // streamed rather than split — ~1.6GB, ~15s in the un-sandboxed trigger. A
  // tier with no transcripts yields null, never 0: absence of data is not
  // absence of calls (cost-churn-coverage-20260814).
  const USAGE_DAYS = 30;
  const usageCutoff = Date.now() - USAGE_DAYS * 86400e3;
  // keep = { pre(file), text(content) }, both optional: `pre` filters on the
  // file name before any read, so a predicate that needs only the session id
  // does not re-read the ~1.1GB ops-agent dir.
  const countServerCalls = (dir, keep = null) => {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dir, f))
        .filter((f) => { try { return fs.statSync(f).mtimeMs >= usageCutoff; } catch { return false; } })
        .filter((f) => !(keep && keep.pre) || keep.pre(f));
    } catch { return null; }
    if (!files.length) return null;
    const counts = {};
    const NEEDLE = '"name":"mcp__';
    for (const f of files) {
      let s; try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
      if (keep && keep.text && !keep.text(s)) continue;
      let i = 0;
      for (;;) {
        i = s.indexOf(NEEDLE, i);
        if (i < 0) break;
        i += NEEDLE.length;
        const end = s.indexOf('__', i);
        if (end < 0) break;
        const srv = s.slice(i, end);
        // lang-regex-ok: none — plain substring slice of a machine-generated tool id
        if (srv && srv.length < 64) counts[srv] = (counts[srv] || 0) + 1;
      }
    }
    return counts;
  };
  const USAGE_DIRS = { ops: 'ops-agent', 'ops-light': 'ops-light-agent', 'ops-haiku': 'ops-haiku-agent', chat: 'chat-agent', 'opus-forks': 'ops-agent', 'sonnet-forks': 'ops-agent' };
  const notOps = (f) => !opsSessionIds.has(stemOf(f));
  const USAGE_KEEP = {
    ops: { pre: (f) => opsSessionIds.has(stemOf(f)) },
    'opus-forks': { pre: notOps, text: isOpusText },
    'sonnet-forks': { pre: notOps, text: (s) => !isOpusText(s) },
  };
  const perTierUsage = {}, fleetUsage = {};
  for (const [tier, suffix] of Object.entries(USAGE_DIRS)) {
    const c = countServerCalls(projectDir(suffix), USAGE_KEEP[tier] || null);
    perTierUsage[tier] = c;
    if (c) for (const [k, v] of Object.entries(c)) fleetUsage[k] = (fleetUsage[k] || 0) + v;
  }

  const summarise = (names, tier) => {
    const res = (((agents[tier] || {}).allowedTools) || []).map(globToRe);
    const scale = tier === 'ops-haiku' ? HAIKU_RATIO : 1;
    const tok = (chars) => Math.round(chars * TOK_PER_CHAR * scale);
    const servers = {};
    let chars = 0, ungrantedChars = 0;
    for (const t of names) {
      chars += t.length + 1;
      if (!t.startsWith('mcp__')) continue;
      const srv = t.split('__')[1];
      const ok = res.some((r) => r.test(t));
      const e = servers[srv] || (servers[srv] = { granted_tools: 0, ungranted_tools: 0, chars: 0, ungranted_chars: 0 });
      e.chars += t.length + 1;
      if (ok) e.granted_tools++; else { e.ungranted_tools++; e.ungranted_chars += t.length + 1; ungrantedChars += t.length + 1; }
    }
    return {
      names: names.length, chars, tokens_est: tok(chars), ungranted_tokens_est: tok(ungrantedChars),
      servers: Object.fromEntries(Object.entries(servers)
        .sort((a, b) => b[1].ungranted_chars - a[1].ungranted_chars || b[1].chars - a[1].chars)
        .map(([k, v]) => [k, {
          granted_tools: v.granted_tools, ungranted_tools: v.ungranted_tools,
          tokens_est: tok(v.chars), ungranted_tokens_est: tok(v.ungranted_chars),
          calls_30d: (perTierUsage[tier] || {})[k] ?? (perTierUsage[tier] ? 0 : null),
          calls_30d_fleet: fleetUsage[k] ?? 0,
        }])),
    };
  };
  const tiers = { ops: 'ops-agent', 'ops-light': 'ops-light-agent', 'ops-haiku': 'ops-haiku-agent', 'opus-forks': 'ops-agent', 'sonnet-forks': 'ops-agent' };
  const TIER_KEEP = {
    ops: (f) => opsSessionIds.has(stemOf(f)),
    'opus-forks': (f) => !opsSessionIds.has(stemOf(f)) && isOpusFile(f),
    'sonnet-forks': (f) => !opsSessionIds.has(stemOf(f)) && !isOpusFile(f),
  };
  const out = {};
  for (const [tier, dirSuffix] of Object.entries(tiers)) {
    const dir = projectDir(dirSuffix);
    let files = [];
    try {
      const keep = TIER_KEEP[tier] || (() => true);
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m).slice(0, 120).filter((x) => keep(x.f)).slice(0, 60);
    } catch { out[tier] = { note: 'no transcripts — absence of data, NOT absence of change' }; continue; }
    if (!files.length) { out[tier] = { note: 'no transcripts — absence of data, NOT absence of change' }; continue; }
    const pick = (inWindow) => {
      const seen = [];
      let best = null;
      for (const x of files) {
        if (inWindow ? x.m < SINCE : x.m >= SINCE) continue;
        const names = listingOf(x.f);
        if (!names) continue;
        seen.push(names.length);
        if (!best || names.length > best.length) best = names;
      }
      return { best, sizes: [...new Set(seen)].sort((a, b) => b - a) };
    };
    const cur = pick(true), prev = pick(false);
    out[tier] = {
      current: cur.best ? summarise(cur.best, tier) : null,
      previous_window: prev.best ? summarise(prev.best, tier) : null,
      in_window_listing_sizes: cur.sizes,
      before_window_listing_sizes: prev.sizes,
      delta_tokens_est: (cur.best && prev.best) ? summarise(cur.best, tier).tokens_est - summarise(prev.best, tier).tokens_est : null,
      delta_names: (cur.best && prev.best) ? cur.best.length - prev.best.length : null,
    };
  }
  // Roll the two axes together on the tier that pays the most (ops), so a cut can
  // be ranked without re-deriving. `never_called` is the honest headline number;
  // `rarely_called` is listed separately because a monthly-cadence connector at
  // low single-digit calls is a JUDGEMENT, not a dead weight, and the Guardrails
  // rule requires saying so rather than folding it into a total.
  // Since the 2026-10-09 split the forks carry connectors the supervisor no
  // longer lists, so rank over the union of the three ops-dir populations:
  // a server counts if ANY of them still pays for it, `carried_by` says which.
  const opsServers = ((out.ops || {}).current || {}).servers || {};
  const ranked = {};
  for (const t of ['ops', 'opus-forks', 'sonnet-forks']) {
    for (const [srv, v] of Object.entries(((out[t] || {}).current || {}).servers || {})) {
      const r = ranked[srv] || (ranked[srv] = { tools: 0, tokens_est: 0, calls_30d_fleet: v.calls_30d_fleet, carried_by: [] });
      r.tools = Math.max(r.tools, v.granted_tools + v.ungranted_tools);
      r.tokens_est = Math.max(r.tokens_est, v.tokens_est);
      r.carried_by.push(t);
    }
  }
  const never = [], rarely = [];
  for (const [srv, v] of Object.entries(ranked)) {
    if ((opsServers[srv] || {}).granted_tools > 0) continue;  // granted to the supervisor: in use by construction
    if (v.tokens_est < 200) continue;               // below the noise floor of a single tool name
    const row = { server: srv, tools: v.tools, tokens_est_ops: v.tokens_est, calls_30d_fleet: v.calls_30d_fleet, carried_by: v.carried_by };
    if (v.calls_30d_fleet === 0) never.push(row);
    else if (v.calls_30d_fleet <= 30) rarely.push(row);
  }
  const sum = (a) => a.reduce((n, r) => n + r.tokens_est_ops, 0);
  out.usage_30d = {
    window_days: USAGE_DAYS,
    per_tier_scanned: Object.fromEntries(Object.entries(perTierUsage).map(([k, v]) => [k, v ? Object.values(v).reduce((a, b) => a + b, 0) : null])),
    never_called: never.sort((a, b) => b.tokens_est_ops - a.tokens_est_ops),
    never_called_tokens_est_ops: sum(never),
    rarely_called: rarely.sort((a, b) => b.tokens_est_ops - a.tokens_est_ops),
    rarely_called_tokens_est_ops: sum(rarely),
    note: 'Ranked over the union of ops, opus-forks and sonnet-forks (since 2026-10-09; before, ops alone, which then included the forks) — carried_by names the populations still paying for it; tokens are the largest of their listings. A server here is NOT automatically a cut: claude.ai connectors are ACCOUNT-level, so disabling one removes it from the user\'s own interactive sessions too — state that trade every time (Guardrails). null in per_tier_scanned means no transcripts in the window, which is absence of DATA, not absence of calls.',
  };
  out.note = 'tokens_est = chars x 0.566 (measured on the 2026-09-18 Vercel step), x0.725 on ops-haiku. ' +
    'ungranted_tokens_est is the part allowedTools forbids the agent from calling yet the prefix still names and pays for every turn. ' +
    'A non-trivial delta_tokens_est with a CLEAN always_loaded_surfaces sweep means an ACCOUNT-level connector changed, not a file. ' +
    'calls_30d / calls_30d_fleet are ACTUAL call counts from the supervisor transcripts — rank any connector cut on those, not on ungranted_tokens_est alone; see usage_30d. ' +
    'ops.delta_tokens_est and usage_30d.per_tier_scanned.ops RE-BASED on 2026-10-09 when the forks left the ops tier: a one-time jump, not a change. ' +
    'Since 2026-10-09 the ops-agent project dir is split three ways: `ops` = sessions in the supervisor-ops ledger only; `opus-forks` = Opus launchd forks; `sonnet-forks` = other `claude -p` runs with that cwd (daily-summary-run and the other scripted model calls). Forks have no agents.json entry, so their ungranted_* fields mean nothing: read tokens_est, the listing sizes and calls_30d. Subagent transcripts (subagents/*.jsonl) are not scanned.';
  return out;
});

// --- list rates for the transcript scans below -----------------------------
// Per Mtok: [input, output, cache_write (5m), cache_read]. Same prices as
// MODEL_RATES in jori-cost-report (sources and quotes there). An id's
// earlier price lives in RATES_BEFORE and applies to messages stamped before
// `until`; a LONG_PROMPT id charges `rate` for a whole request whose prompt
// (input + cache reads + cache writes) is over `over` tokens. A transcript
// line is one request, so both are exact here.
const MODEL_RATES = {
  'claude-opus-5-5': [4, 20, 5, 0.2], // 2026-10-06 — the improvement family's model since then
  'claude-opus-5': [5, 25, 6.25, 0.5], 'claude-opus-4-8': [5, 25, 6.25, 0.5],
  'claude-sonnet-5': [2, 10, 2.5, 0.2],
  'claude-sonnet-5-5': [2, 10, 2.5, 0.1], // cache read $0.20 before 2026-10-07
  'claude-haiku-4-5-20251001': [1, 5, 1.25, 0.1],
  'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.01], // prompt up to 100k tokens
};
const RATES_BEFORE = {
  'claude-sonnet-5-5': { until: Date.parse('2026-10-07T00:00:00Z'), rate: [2, 10, 2.5, 0.2] },
};
const LONG_PROMPT = {
  'claude-haiku-5-5': { over: 100000, rate: [0.5, 2.5, 0.625, 0.05] },
};
// USD for one assistant message, or null when its model has no rate.
function messageUsd(model, ts, usage) {
  if (!MODEL_RATES[model]) return null;
  const i = usage.input_tokens || 0, o = usage.output_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0, cw = usage.cache_creation_input_tokens || 0;
  let r = MODEL_RATES[model];
  const old = RATES_BEFORE[model], long = LONG_PROMPT[model];
  if (old && Date.parse(ts) < old.until) r = old.rate;
  else if (long && i + cr + cw > long.over) r = long.rate;
  return (i * r[0] + o * r[1] + cw * r[2] + cr * r[3]) / 1e6;
}

// --- sessions no ledger row covers (2026-10-09) ------------------------------
// The ledgers see the three supervisors and the forks that call
// fork-cost-record. Anything else that runs `claude -p` with a supervisor's cwd
// leaves a transcript and no row, and every number in this report silently
// excludes it. Found 2026-10-09: daily-summary-run (a job-run Sonnet fork,
// launched 1-6x a day, 40-170 turns each) had never appeared anywhere in this
// review, and jori-allowance-coverage counts it as ON-ledger because an
// unprobed fork is labelled `ops`. A session is off-ledger when its id (the
// transcript's file name) appears in no ledger row since the window began.
// Usage is de-duplicated by message id: the transcript repeats a turn's usage
// once per content block, so summing lines roughly doubles every figure.
guard('offledger_sessions', () => {
  const PROJECTS = path.join(HOME, '.claude/projects');
  const LOOKBACK_DAYS = 7;
  const cutoff = Date.now() - LOOKBACK_DAYS * 86400e3;
  const cutoffIso = new Date(cutoff - 86400e3).toISOString();
  const ledgerIds = new Set();
  const ledgers = ['ops', 'ops-light', 'ops-haiku'].map((t) => path.join(ROOT, `agent/logs/supervisor-${t}/job-costs.ndjson`))
    .concat([path.join(ROOT, 'agent/logs/ephemeral-forks/job-costs.ndjson')]);
  for (const f of ledgers) {
    let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.session_id && String(r.ts || '') >= cutoffIso) ledgerIds.add(r.session_id);
    }
  }
  // $/token by model family: the fallback for a model MODEL_RATES has no row for.
  const RATES = {
    opus: { in: 4e-6, out: 20e-6, cr: 0.20e-6, cw: 5e-6 },
    sonnet: { in: 2e-6, out: 10e-6, cr: 0.20e-6, cw: 2.5e-6 },
    haiku: { in: 1e-6, out: 5e-6, cr: 0.10e-6, cw: 1.25e-6 },
  };
  const DIRS = { 'ops-agent': 'ops', 'ops-light-agent': 'ops-light', 'ops-haiku-agent': 'ops-haiku' };
  const byLabel = {};
  let scanned = 0, onLedger = 0;
  const missingDirs = [];
  for (const [suffix, cwdTier] of Object.entries(DIRS)) {
    const dir = projectDir(suffix);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { missingDirs.push(dir); continue; }
    for (const name of files) {
      const fp = path.join(dir, name);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      scanned++;
      const sid = name.slice(0, -'.jsonl'.length);
      if (ledgerIds.has(sid)) { onLedger++; continue; }
      let txt; try { txt = fs.readFileSync(fp, 'utf8'); } catch { continue; }
      let first = null, day = null, family = null;
      const seen = new Set();
      const u = { turns: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, usd: 0 };
      for (const line of txt.split('\n')) {
        if (!line || line[0] !== '{') continue;
        let d; try { d = JSON.parse(line); } catch { continue; }
        if (first === null && d.type === 'user') {
          const c = d.message && d.message.content;
          const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.type === 'text' ? x.text : '')).join(' ') : '';
          if (t.trim()) {
            // The supervisors prefix every dispatch with a <live-state> block; label by what follows it.
            const k = t.indexOf('</live-state>');
            first = (k >= 0 ? t.slice(k + 13) : t).trim().slice(0, 72);
            day = String(d.timestamp || '').slice(0, 10) || null;
          }
        }
        const m = d.type === 'assistant' ? d.message : null;
        if (!m || !m.usage || seen.has(m.id)) continue;
        seen.add(m.id);
        if (!family) family = String(m.model || '').includes('opus') ? 'opus' : String(m.model || '').includes('haiku') ? 'haiku' : 'sonnet';
        u.turns++;
        const mi = m.usage.input_tokens || 0, mo = m.usage.output_tokens || 0;
        const mcr = m.usage.cache_read_input_tokens || 0, mcw = m.usage.cache_creation_input_tokens || 0;
        u.input += mi; u.output += mo; u.cache_read += mcr; u.cache_write += mcw;
        const priced = messageUsd(m.model, d.timestamp, m.usage);
        const r = RATES[family] || RATES.sonnet;
        u.usd += priced ?? (mi * r.in + mo * r.out + mcr * r.cr + mcw * r.cw);
      }
      if (!u.turns) continue;
      const usd = u.usd;
      const label = `${cwdTier} cwd · ${family} · ${first || '(no prompt)'}`;
      const e = byLabel[label] || (byLabel[label] = { sessions: 0, turns: 0, output: 0, cache_read: 0, cache_write: 0, usd: 0, days: {} });
      e.sessions++; e.turns += u.turns; e.output += u.output; e.cache_read += u.cache_read; e.cache_write += u.cache_write; e.usd += usd;
      if (day) { const dd = e.days[day] || (e.days[day] = { sessions: 0, turns: 0, usd: 0 }); dd.sessions++; dd.turns += u.turns; dd.usd += usd; }
    }
  }
  const round = (x) => Math.round(x * 100) / 100;
  const rows = Object.entries(byLabel).map(([label, e]) => ({
    label, sessions: e.sessions, turns: e.turns, usd_7d: round(e.usd), usd_per_day: round(e.usd / LOOKBACK_DAYS),
    usd_per_session: round(e.usd / e.sessions), turns_per_session: Math.round(e.turns / e.sessions),
    cache_read_per_turn: Math.round(e.cache_read / e.turns), output: e.output,
    days: Object.fromEntries(Object.entries(e.days).sort().map(([k, v]) => [k, { sessions: v.sessions, turns: v.turns, usd: round(v.usd) }])),
  })).sort((a, b) => b.usd_7d - a.usd_7d);
  // No readable dir at all is absence of DATA: report null, never a measured 0.
  if (missingDirs.length === Object.keys(DIRS).length) {
    return { lookback_days: LOOKBACK_DAYS, transcripts_scanned: null, off_ledger_usd_7d: null, missing_dirs: missingDirs,
      note: 'none of the supervisor transcript dirs is readable: UNMEASURED, not zero off-ledger spend' };
  }
  return {
    lookback_days: LOOKBACK_DAYS,
    missing_dirs: missingDirs,
    transcripts_scanned: scanned, on_ledger: onLedger, off_ledger: scanned - onLedger,
    off_ledger_usd_7d: round(rows.reduce((n, r) => n + r.usd_7d, 0)),
    workloads: rows.slice(0, 15),
    note: 'Sessions in the three supervisor project dirs whose id is in NO ledger row (supervisor or ephemeral-forks). These are NOT in weighted_cost_usd, top_jobs or by_tier. usd is list rate with cache writes at the 5-minute price, the weighted_cost_usd basis; a ledger total_cost_usd for the same session runs ~12% higher. The label is the first dispatch text (machine-generated prompts), grouped verbatim. Two inflations to discount: the ephemeral-forks ledger starts 2026-10-06T09:46Z, so Opus forks before that count here until they age out (~10-13); and the run reading this file is in-flight and not yet on its ledger.',
  };
});

// --- this job's own per-run cost, from the transcript tree ------------------
// The review writes no job-costs.ndjson row (it is an ephemeral fork), so the
// transcript tree is the only place its real consumption is visible.
// Usage is de-duplicated by message id, as in offledger_sessions: a reply with
// several content blocks is written as several lines carrying the SAME usage.
// Counting lines read 164 turns / $15.59 for the 2026-10-10 run, whose 78
// replies cost $7.06 (its ledger row: 80 turns).
guard('self_cost_series', () => {
  const PROJECTS = path.join(HOME, '.claude/projects');
  const runs = [];
  let dirs = []; try { dirs = fs.readdirSync(PROJECTS); } catch { return null; }
  for (const dir of dirs) {
    let files = []; try { files = fs.readdirSync(path.join(PROJECTS, dir)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const file of files) {
      const p = path.join(PROJECTS, dir, file);
      let content, mtimeMs; try { content = fs.readFileSync(p, 'utf8'); mtimeMs = fs.statSync(p).mtimeMs; } catch { continue; }
      let head = null, usd = 0, tokens = 0, turns = 0, first = null, cacheRead = 0, output = 0;
      const seen = new Set();
      for (const line of content.split('\n')) {
        if (!line) continue;
        let d; try { d = JSON.parse(line); } catch { continue; }
        const msg = d.message || {};
        if (head === null && d.type === 'user') {
          const c = msg.content;
          if (typeof c === 'string') head = c.slice(0, 120);
          else if (Array.isArray(c)) { const t = c.find((x) => x && x.type === 'text'); if (t) head = String(t.text).slice(0, 120); }
        }
        const u = msg.usage; if (!u || !msg.model || !d.timestamp) continue;
        if (!MODEL_RATES[msg.model]) continue;
        if (msg.id) { if (seen.has(msg.id)) continue; seen.add(msg.id); }
        const i = u.input_tokens || 0, o = u.output_tokens || 0;
        const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
        usd += messageUsd(msg.model, d.timestamp, u);
        tokens += i + o + cr + cw; turns++; cacheRead += cr; output += o;
        if (!first) first = d.timestamp;
      }
      if (!head || !head.toUpperCase().includes('COST EFFICIENCY REVIEW')) continue;
      runs.push({
        date: (first || '').slice(0, 10), usd: +usd.toFixed(2), mtok: +(tokens / 1e6).toFixed(1),
        turns, cache_read_pct: tokens ? +(100 * cacheRead / tokens).toFixed(1) : null, output_tokens: output,
        usd_per_turn: turns ? +(usd / turns).toFixed(3) : null,
        in_flight: Date.now() - mtimeMs < 15 * 60e3,
      });
    }
  }
  runs.sort((a, b) => (a.date < b.date ? -1 : 1));
  // A row is in flight only if its transcript was written in the last 15 min.
  // The trigger runs this BEFORE the review's first turn, so the newest row is
  // normally YESTERDAY's finished run; dropping the last row unconditionally
  // threw that run away every night.
  const complete = runs.filter((r) => !r.in_flight);
  return {
    note: 'Turns and usd are de-duplicated by message id. A row with in_flight: true is a run still writing (transcript touched in the last 15 min) and is not a measurement; every other row is complete.',
    runs: runs.slice(-14),
    complete_runs_excluding_current: complete.slice(-10),
  };
});

// --- job_cost_index comparability ------------------------------------------
// A member that barely ran is not comparable (rule 2026-08-31). Thin volume is
// under 25% of the job's own 7d daily median; absence from top_jobs is UNKNOWN,
// not zero, because top_jobs is a top-12 cut.
//
// Each member also carries its own CALENDAR-DAY series, a 30-day band and the
// shape of its recent run (added 2026-10-03). Two separate errors made the
// index unreadable on three consecutive nights, and both are arithmetic the
// agent should never have to re-derive:
//
//   1. The window straddle. `usd_per_run` is computed over a 24h window that
//      crosses two calendar days, so a lane whose volume is unevenly spread
//      through the day shows a double-digit per-run move with no drift at all.
//      The 2026-10-02 rule says decompose by calendar day BEFORE flagging —
//      which cost that run four hand-rolled ledger passes, and cost the run
//      before it a wrong attribution (tier density, in the wrong direction).
//   2. The band that is too short. 2026-10-02 opened a `hum` WATCH on $0.894
//      against a "$0.618-0.746 band over the preceding six days". Over 30 days
//      the lane's own band is $0.496-0.921 and $0.921 had already happened on
//      09-22, so there was nothing to watch. A six-day band around a noisy
//      lane manufactures steps.
//
// The band deliberately excludes thin days (under 25% of the member's own
// median daily runs, the same test as above) so a 1-run day cannot widen it.
// `recent_trend` names the shape and does not judge it: a monotonic multi-day
// climb in BOTH measures is what distinguishes a regime change (2026-10-01:
// location-enrich 4.0 -> 6.7 turns/run when the user landed abroad, a shape
// an earlier trip already showed at 5.0-11.2) from a one-day outlier.
// Which of those it is stays a judgement for the agent — that needs the travel
// timeline, which is network, and this process has none by design (see header).
guard('job_cost_index', () => {
  // gmail:* joined 2026-10-07. Three of the original five stopped being
  // measurable within three days, each by design: session-handoff retired and
  // ops-light went rotate-only (context-guard) on 10-04, and location-enrich
  // moved into code on 10-05 (the agent only sees residue). An index
  // with two live members cannot separate drift from mix, and email triage is
  // the highest-volume lane left (~30-40 runs/day) with a stable payload. The
  // retired members stay so their non-comparable reason is still reported.
  const MEMBERS = ['location-enrich', 'session-handoff', 'hum', 'hum:moment', 'context-guard', 'gmail:*'];
  const fold = (job) => (job.startsWith('gmail:') ? 'gmail:*' : job);
  const BAND_DAYS = 30, SERIES_DAYS = 14, TREND_WINDOW = 8, TREND_MIN_DAYS = 4, RECENT_DAYS = 3, STEP_PCT = 15;
  const byJob = (rep) => Object.fromEntries((rep.top_jobs || []).map((j) => [fold(j.job), j]));
  const t = byJob(today), w = byJob(week);
  const ledgerCur = Object.fromEntries(((out.ledger || {}).current || []).map((j) => [j.job, j]));

  // One pass over the ledgers, bucketed by UTC day to match the rotation
  // series in this same file. A mixed day convention inside one output would
  // be its own defect; what matters here is trend shape, not wall-clock edges.
  const wanted = new Set(MEMBERS);
  const bandFrom = new Date(SINCE + WINDOW_MS - BAND_DAYS * 86400000).toISOString().slice(0, 10);
  const perDay = Object.fromEntries(MEMBERS.map((m) => [m, {}]));
  for (const tier of TIERS) {
    let content;
    try { content = fs.readFileSync(path.join(ROOT, `agent/logs/supervisor-${tier}/job-costs.ndjson`), 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const src = fold(r.source || '');
      if (!wanted.has(src)) continue;
      const d = (r.ts || '').slice(0, 10);
      if (!d || d < bandFrom) continue;
      const a = perDay[src][d] || (perDay[src][d] = { runs: 0, usd: 0, turns: 0 });
      a.runs++; a.usd += (r.total_cost_usd || 0); a.turns += (r.num_turns || 0);
    }
  }
  // The newest UTC day is still in flight when this runs just after 06:37Z, so
  // it is reported and never allowed into the band or the trend.
  const lastDay = new Date(SINCE + WINDOW_MS - 1).toISOString().slice(0, 10);
  const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };
  // A daily series is noisy, so the step is measured between MEANS, not by
  // requiring every single day to move the same way. Requiring a strictly
  // monotonic run was tried first and read 'mixed' on location-enrich's real
  // 09-28 -> 10-02 climb, because one day dipped — a detector that a true
  // regime change can fail is worse than none.
  const mean = (rows, k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;

  return Object.fromEntries(MEMBERS.map((m) => {
    const row = t[m] || ledgerCur[m] || null;
    const wk = w[m] || null;
    const dailyMedian = wk ? wk.runs / 7 : null;
    const runs = row ? row.runs : (ledgerCur[m] ? ledgerCur[m].runs : null);
    let comparable = true, reason = null;
    if (runs == null) { comparable = false; reason = 'absent from top_jobs AND ledger rollup — UNKNOWN, not zero'; }
    else if (dailyMedian && runs < 0.25 * dailyMedian) { comparable = false; reason = `thin volume: ${runs} runs vs 7d daily median ${dailyMedian.toFixed(1)} (under 25%)`; }

    const days = Object.entries(perDay[m]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, a]) => ({
        date, runs: a.runs,
        usd_per_run: +(a.usd / a.runs).toFixed(3),
        turns_per_run: +(a.turns / a.runs).toFixed(1),
        partial_day: date >= lastDay,
      }));
    const settled = days.filter((d) => !d.partial_day);
    const medRuns = median(settled.map((d) => d.runs));
    const bandDays = settled.filter((d) => d.runs >= 0.25 * medRuns);
    const band = bandDays.length >= 5
      ? {
          days: bandDays.length, over_days: BAND_DAYS,
          from: bandDays[0].date, to: bandDays[bandDays.length - 1].date,
          excluded_thin_days: settled.length - bandDays.length,
          median_daily_runs: medRuns,
          usd_per_run: [Math.min(...bandDays.map((d) => d.usd_per_run)), Math.max(...bandDays.map((d) => d.usd_per_run))],
          turns_per_run: [Math.min(...bandDays.map((d) => d.turns_per_run)), Math.max(...bandDays.map((d) => d.turns_per_run))],
        }
      : { days: bandDays.length, insufficient: true, note: 'fewer than 5 non-thin days — no band, do not manufacture one' };

    let trend = null;
    const recent = bandDays.slice(-TREND_WINDOW);
    if (recent.length >= TREND_MIN_DAYS) {
      const head = recent.slice(-RECENT_DAYS), tail = recent.slice(0, -RECENT_DAYS);
      const pct = (a, b) => (b ? +(((a - b) / b) * 100).toFixed(1) : null);
      const step = tail.length >= 2
        ? { usd_per_run: pct(mean(head, 'usd_per_run'), mean(tail, 'usd_per_run')), turns_per_run: pct(mean(head, 'turns_per_run'), mean(tail, 'turns_per_run')) }
        : null;
      const newest = recent[recent.length - 1];
      const atCeiling = !band.insufficient && newest.usd_per_run >= band.usd_per_run[1] && newest.turns_per_run >= band.turns_per_run[1];
      const atFloor = !band.insufficient && newest.usd_per_run <= band.usd_per_run[0] && newest.turns_per_run <= band.turns_per_run[0];
      let shape = 'flat';
      if (step && step.usd_per_run >= STEP_PCT && step.turns_per_run >= STEP_PCT) shape = 'step_up';
      else if (step && step.usd_per_run <= -STEP_PCT && step.turns_per_run <= -STEP_PCT) shape = 'step_down';
      trend = {
        shape, step_pct: step,
        recent_days: head.length, recent_from: head[0].date, recent_to: newest.date,
        recent_mean: { usd_per_run: +mean(head, 'usd_per_run').toFixed(3), turns_per_run: +mean(head, 'turns_per_run').toFixed(1) },
        prior_days: tail.length,
        prior_mean: tail.length ? { usd_per_run: +mean(tail, 'usd_per_run').toFixed(3), turns_per_run: +mean(tail, 'turns_per_run').toFixed(1) } : null,
        newest_settled_day: newest.date,
        at_band_ceiling: atCeiling, at_band_floor: atFloor,
        note: shape === 'step_up'
          ? 'both measures stepped up — a regime change or real drift. Check what changed about the INPUT (is the user somewhere new?) before calling it drift.'
          : atCeiling ? 'no step, but the newest settled day sits at the 30-day ceiling in both measures — the top of normal, not above it'
          : 'inside its own 30-day band; read today against band_30d, not against yesterday',
      };
    }

    return [m, {
      runs,
      usd_per_run: row ? (row.usd_per_run || null) : null,
      turns_per_run: row ? (row.turns_per_run != null ? row.turns_per_run : null) : null,
      seven_day_daily_median_runs: dailyMedian != null ? +dailyMedian.toFixed(1) : null,
      comparable, reason,
      window_note: 'the two figures above are the 24h WINDOW, which straddles two calendar days. calendar_days is the decomposition the 2026-10-02 rule requires; band_30d is what to compare them against.',
      calendar_days: days.slice(-SERIES_DAYS),
      band_30d: band,
      recent_trend: trend,
    }];
  }));
});

// --- lane activity: which lanes went dark, and what a RUNNING day costs -----
// Two fields, one defect family (2026-09-21).
//
// A lane that stops dispatching removes its load SILENTLY. Nothing in the
// report says "absent" — an absent job is simply not in top_jobs — so the day
// looks cheap and well-behaved. The cost lands twice: first as a flattered
// allowance projection while the lane is dark, then as an apparent regression
// on the day it comes back. hum was dark 2026-09-13..09-19 and its return on
// 09-20 was 37% of that day's ledger increase, which cost three rounds of
// ad-hoc ledger querying to attribute.
//
// running_usd_per_day is the half that actually bit. Sizing an absent lane by
// dividing its spend by a CALENDAR window understates it by however much of
// that window the lane was ALREADY dark: hum was sized at $3.57/day over
// 09-05..09-11, a week it ran two days of. Over seven consecutive RUNNING days
// its real rate is $14.31/day — 4.0x — and the allowance projection inherited
// the wrong number. Same family as cost-index-comparability-20260831: a
// measurement reading an absent input as a valid value.
//
// Report-only, in both directions. A dark lane is a RELIABILITY fact and this
// job may not author a health alert (§ System Channel); a deliberate retirement
// looks identical here to a silent failure, so the field names the gap and
// never diagnoses it.
guard('lane_activity', () => {
  const DARK_AFTER_DAYS = 3;   // shorter than this is an ordinary weekly cadence
  const MIN_RUNS_30D = 5;      // below this, silence says nothing
  const LOOKBACK_MS = 30 * 24 * 3600 * 1000;
  const now = Date.parse(today.since) + WINDOW_MS;   // the window's end, not wall clock
  const lanes = {};
  for (const tier of TIERS) {
    const f = path.join(ROOT, `agent/logs/supervisor-${tier}/job-costs.ndjson`);
    let content; try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(r.ts || 0); if (!ts || ts < now - LOOKBACK_MS) continue;
      const raw = r.source || '(none)';
      const job = raw.startsWith('gmail:') ? 'gmail:*' : raw;
      const l = lanes[job] || (lanes[job] = { runs: 0, usd: 0, last: 0, days: new Set() });
      l.runs++; l.usd += (r.total_cost_usd || 0);
      if (ts > l.last) l.last = ts;
      l.days.add((r.ts || '').slice(0, 10));
    }
  }
  const dark = [], rates = {};
  for (const [job, l] of Object.entries(lanes)) {
    const silent = (now - l.last) / 86400000;
    if (l.runs >= MIN_RUNS_30D && silent > DARK_AFTER_DAYS) {
      dark.push({ job, last_run: new Date(l.last).toISOString(), days_silent: +silent.toFixed(1), runs_30d: l.runs });
    }
    // The rate a lane costs on a day it ACTUALLY RAN. Never divide by the
    // calendar — that is the understatement this field exists to prevent.
    rates[job] = {
      runs_30d: l.runs, usd_30d: +l.usd.toFixed(2), running_days: l.days.size,
      running_usd_per_day: +(l.usd / l.days.size).toFixed(2),
      usd_per_run: +(l.usd / l.runs).toFixed(3),
    };
  }
  dark.sort((a, b) => b.days_silent - a.days_silent);
  const top = Object.entries(rates).sort((a, b) => b[1].usd_30d - a[1].usd_30d).slice(0, 15);
  return {
    note: 'running_usd_per_day divides by days the lane RAN, not calendar days. dark_lanes is report-only — a deliberate retirement and a silent failure look identical here.',
    dark_after_days: DARK_AFTER_DAYS, lookback_days: 30,
    dark_lanes: dark,
    running_rates: Object.fromEntries(top),
  };
});

// --- rotation overhead + the compaction cliff -------------------------------
// The 40k working-window alarm says the floor is big. It does not say what
// BREAKS, and the thing that breaks is the context guard itself.
//
// A /compact only fires when ctx is in [COMPACT, ROTATE) AND at least
// MIN_COMPACTABLE tokens sit above the floor. So the band in which a session
// can actually compact is [max(COMPACT, floor+MIN_COMPACTABLE), ROTATE) — it
// NARROWS as the floor grows, and at floor >= ROTATE-MIN_COMPACTABLE it is
// EMPTY and the session can never compact at all. context-guard.mjs has said
// this in prose since 2026-08-06; nothing measured it.
//
// Measured 2026-09-24, the first day both Sonnet floors sat above
// COMPACT-MIN_COMPACTABLE: ops-light's band fell 15,000 -> 6,792 tokens and it
// logged 95 skip polls / 11 episodes / 126 minutes parked against 3 compacts
// and 22 rotates. Parking itself is cheap and correct (see the context-guard
// header) — the cost is that the compaction is replaced by a ROTATION, which
// cold-writes the whole prefix.
//
// Hence the second half: rotation overhead as a share of raw spend, split into
// its two multiplicands. Both moved. 2026-09-16 -> 2026-09-23, comparable work
// volume: handoffs 17 -> 50 and $/handoff 0.235 -> 0.360, share 15.4% -> 22.6%.
// The count ratio ALONE is noisy (this is why the 2026-09-21 run checked
// handoff-per-dispatch and correctly found nothing); the dollar share is not,
// because each rotation also rewrites a bigger prefix.
//
// Thresholds are IMPORTED from the live guard, never restated here, so the
// detector cannot drift from the rule it is measuring. Env overrides on the
// supervisor are not visible from this process — the module defaults are what
// is reported, and `thresholds` names them so a mismatch is readable.
guard('rotation_overhead', () => {
  const ROT_JOBS = new Set(['session-handoff', 'context-guard']);
  const SERIES_DAYS = 14;
  const T = GUARD_THRESHOLDS;
  // The floor this arithmetic runs on must be the one the GUARD compares
  // against, not the one the ledger implies. They agreed to within 0.2% from
  // 2026-08-14 (when the runtime floor was first validated) until
  // 2026-09-27T23:17Z, when ops' only fully-cold session start in eight days
  // re-seeded its prompt cache and the LEDGER floor fell 9,150 tokens while the
  // runtime floor did not move. `floor_tokens` is cache_read+cache_creation at
  // a session start, so it carries whatever the provider's cache happened to
  // re-bill; the guard's own `floorTokens` does not. The contradiction that
  // surfaced it: ops-light reported floor 138,248 (band 15,000, dead zone 0,
  // i.e. compaction perfectly healthy) on a night it logged 24 skip polls / 3
  // episodes / 31.5 stuck-minutes against a runtime floor of 147,967 — parking
  // that is arithmetically impossible at 138,248.
  //
  // Read the runtime floor from `context_guard.compact` events ONLY. Skip
  // events are a selected tail — a session only reaches skip-compact when its
  // uncompactable portion is already large — and conflating the two is the
  // 2026-08-14 `runtime_floor_closed` mistake. Falls back to the ledger floor
  // when a tier has too few compact events to be worth trusting.
  const RUNTIME_FLOOR_MIN_SAMPLES = 3;
  const runtimeFloors = {};
  for (const tier of TIERS) {
    let content;
    try { content = fs.readFileSync(path.join(ROOT, `agent/logs/supervisor-${tier}/events.ndjson`), 'utf8'); } catch { continue; }
    const vals = [];
    for (const line of content.split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.kind !== 'context_guard.compact') continue;
      const ts = Date.parse(e.ts);
      if (!(ts >= SINCE && ts < SINCE + WINDOW_MS)) continue;
      if (typeof e.floorTokens === 'number' && e.floorTokens > 0) vals.push(e.floorTokens);
    }
    if (!vals.length) continue;
    vals.sort((a, b) => a - b);
    runtimeFloors[tier] = { floor: vals[Math.floor(vals.length / 2)], samples: vals.length };
  }

  // The SKIP tail, read for a different question than the floor.
  //
  // Everything above answers "how big is the floor". `tokens_to_compaction_death`
  // then subtracts it from the cliff — but it subtracts the SESSION-START floor,
  // and the guard's gate is the RUNTIME floorTokens at poll time, which carries
  // whatever uncompactable content the session has accumulated SINCE its start.
  // So the margin reported above is an UPPER bound on a live session's margin,
  // never the margin, and the cliff can be crossed with it still reading healthy.
  //
  // It was, on 2026-09-29: ops parked at runtime floor 161,427 (36 polls, ctx to
  // 175,985) and ops-light at 173,040 (20 polls, ctx to 184,988 — twelve tokens
  // under ROTATE), both past the 160,000 cliff, on a night
  // compaction_death_margin_under_10k was EMPTY and the margins read
  // 14,901 / 12,259.
  //
  // Skip events are the right source here and only here: they are a selected
  // tail (a session reaches skip-compact only once its uncompactable portion is
  // already large), which is exactly why they must stay OUT of the floor
  // estimate above — the 2026-08-14 `runtime_floor_closed` finding — and exactly
  // why they are the population to ask when the tail ITSELF is the question.
  //
  // Direct cost is ~$0.13 per occurrence (a rotate standing in for a compact),
  // so this is an instrument, not a cut. Judge it on whether it sees the next
  // crossing, not on dollars.
  const CLIFF_FLOOR = GUARD_THRESHOLDS.rotate - GUARD_THRESHOLDS.min_compactable;
  const SKIP_EPISODE_GAP_MS = 15 * 60 * 1000;
  const skipFloors = {};
  for (const tier of TIERS) {
    let content;
    try { content = fs.readFileSync(path.join(ROOT, `agent/logs/supervisor-${tier}/events.ndjson`), 'utf8'); } catch { continue; }
    const polls = [];
    for (const line of content.split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.kind !== 'context_guard.compact_skipped') continue;
      const ts = Date.parse(e.ts);
      if (!(ts >= SINCE && ts < SINCE + WINDOW_MS)) continue;
      if (typeof e.floorTokens !== 'number' || !(e.floorTokens > 0)) continue;
      polls.push({ ts, floor: e.floorTokens });
    }
    if (!polls.length) continue;
    polls.sort((a, b) => a.ts - b.ts);
    // Episodes: consecutive polls inside SKIP_EPISODE_GAP_MS are one stuck
    // session, same grouping the churn counters use. A poll is a re-check on a
    // fixed tick, so counting polls would read one bad half hour as twenty.
    let pastCliffEpisodes = 0, inPastCliffEpisode = false, prevTs = null;
    for (const p of polls) {
      const newEpisode = prevTs == null || (p.ts - prevTs) > SKIP_EPISODE_GAP_MS;
      if (newEpisode) inPastCliffEpisode = false;
      if (p.floor >= CLIFF_FLOOR && !inPastCliffEpisode) { pastCliffEpisodes++; inPastCliffEpisode = true; }
      prevTs = p.ts;
    }
    skipFloors[tier] = {
      polls: polls.length,
      max_floor: Math.max(...polls.map((p) => p.floor)),
      past_cliff_polls: polls.filter((p) => p.floor >= CLIFF_FLOOR).length,
      past_cliff_episodes: pastCliffEpisodes,
    };
  }

  // Tiers with `compactOnContext: false` in agents.json (ops-light, ops-haiku
  // since 2026-10-04) rotate where they would otherwise /compact, so the
  // compaction cliff is not a condition for them: a session past it simply
  // rotates at ROTATE like every other session on that tier. Their bands are
  // still computed (the floor arithmetic is real), but they are kept OUT of the
  // cliff flags below — on 2026-10-06 ops-light fired
  // `compaction_died_on_a_live_session` for a compaction it was never going to
  // perform. Fails open: an unreadable agents.json treats every tier as compacting.
  const noCompactTiers = new Set();
  try {
    const agents = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent/config/agents.json'), 'utf8')).agents || {};
    for (const [name, a] of Object.entries(agents)) if (a && a.compactOnContext === false) noCompactTiers.add(name);
  } catch {}
  const bands = {};
  for (const s of (today.supervisors || [])) {
    const ledgerFloor = s.floor_tokens || 0;
    const rt = runtimeFloors[s.supervisor];
    const sk = skipFloors[s.supervisor];
    const useRuntime = !!rt && rt.samples >= RUNTIME_FLOOR_MIN_SAMPLES;
    const floor = useRuntime ? rt.floor : ledgerFloor;
    if (!floor) { bands[s.supervisor] = { floor_tokens: 0, note: 'floor unmeasured — no band arithmetic' }; continue; }
    const liveFrom = Math.max(T.compact, floor + T.min_compactable);
    bands[s.supervisor] = {
      floor_tokens: floor,
      compacts_by_design: !noCompactTiers.has(s.supervisor),
      floor_source: useRuntime ? 'runtime:context_guard.compact' : 'ledger:job-costs',
      ledger_floor_tokens: ledgerFloor || null,
      runtime_floor_tokens: rt ? rt.floor : null,
      runtime_floor_samples: rt ? rt.samples : null,
      // Positive = the ledger floor reads HIGHER than the guard's. Anything
      // past ~2k means one of the two is being misread; do not reason about
      // the band, the working window or a floor cut until it is explained.
      floor_disagreement_tokens: (rt && ledgerFloor) ? (ledgerFloor - rt.floor) : null,
      floor_samples: s.floor_samples ?? null,
      live_compact_band_tokens: Math.max(0, T.rotate - liveFrom),
      live_compact_band_from: liveFrom,
      dead_zone_tokens: Math.max(0, Math.min(T.rotate, floor + T.min_compactable) - T.compact),
      // Tokens of further floor growth before /compact becomes impossible.
      // UPPER BOUND on a live session's margin — it is measured off the
      // session-start floor, while the guard gates on the runtime floor at poll
      // time. Read it together with the three fields below, which measure the
      // same thing where it actually bites.
      tokens_to_compaction_death: (T.rotate - T.min_compactable) - floor,
      // Measured off the skip tail: the largest runtime floor the guard
      // actually refused to compact at, and how often that floor was already
      // past the cliff. past_cliff_episodes > 0 means compaction DIED on a live
      // session in this window, whatever tokens_to_compaction_death says.
      max_skip_floor_tokens: sk ? sk.max_floor : null,
      skip_polls_measured: sk ? sk.polls : null,
      past_cliff_polls: sk ? sk.past_cliff_polls : null,
      past_cliff_episodes: sk ? sk.past_cliff_episodes : null,
      // A tier with no skip polls is UNMEASURED for the live-session question,
      // not proven clear — absence of data, not absence of condition
      // (`log_sources_that_do_not_cover_yesterday`, 2026-08-16).
      live_margin_measured: !!sk,
      compacts: s.compacts ?? null,
      rotates: s.rotates ?? null,
      compacts_skipped_episodes: s.compacts_skipped_episodes ?? null,
      compacts_skipped_stuck_min: s.compacts_skipped_stuck_min ?? null,
      churn_partial: s.churn_partial ?? null,
    };
  }
  // Daily raw-dollar series straight off the ledgers. RAW, not model-weighted:
  // it sums tiers at their own prices, which is what "what did churn cost"
  // means here. The final row is a PARTIAL day — the window ends mid-date.
  const byDay = {};
  const firstDay = new Date(SINCE + WINDOW_MS - SERIES_DAYS * 86400000).toISOString().slice(0, 10);
  for (const tier of TIERS) {
    let content;
    try { content = fs.readFileSync(path.join(ROOT, `agent/logs/supervisor-${tier}/job-costs.ndjson`), 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const d = (r.ts || '').slice(0, 10);
      if (!d || d < firstDay) continue;
      const b = byDay[d] || (byDay[d] = { all_usd: 0, rot_usd: 0, handoffs: 0, handoff_usd: 0, handoff_cw: 0, work_runs: 0 });
      const usd = r.total_cost_usd || 0;
      b.all_usd += usd;
      if (ROT_JOBS.has(r.source)) b.rot_usd += usd; else b.work_runs++;
      if (r.source === 'session-handoff') { b.handoffs++; b.handoff_usd += usd; b.handoff_cw += (r.cache_creation_tokens || 0); }
    }
  }
  const lastDay = new Date(SINCE + WINDOW_MS - 1).toISOString().slice(0, 10);
  const series = Object.keys(byDay).sort().map((d) => {
    const b = byDay[d];
    return {
      date: d,
      raw_usd: +b.all_usd.toFixed(2),
      rotation_usd: +b.rot_usd.toFixed(2),
      rotation_pct: b.all_usd ? +(100 * b.rot_usd / b.all_usd).toFixed(1) : null,
      handoffs: b.handoffs,
      usd_per_handoff: b.handoffs ? +(b.handoff_usd / b.handoffs).toFixed(3) : null,
      cache_write_per_handoff: b.handoffs ? Math.round(b.handoff_cw / b.handoffs) : null,
      handoff_per_work_run: b.work_runs ? +(b.handoffs / b.work_runs).toFixed(3) : null,
      partial_day: d === lastDay,
    };
  });
  const full = series.filter((r) => !r.partial_day);
  const latest = full[full.length - 1] || null;
  const baseline = full.length >= 8 ? full[full.length - 8] : full[0] || null;
  return {
    note: 'Thresholds imported from agent/supervisor/context-guard.mjs. rotation_usd is RAW (per-tier prices), not model-weighted. The last series row is a PARTIAL day — never compare against it.',
    thresholds: T,
    bands,
    series,
    latest_full_day: latest,
    week_ago_full_day: baseline,
    // Tripwire inputs, pre-decided so the review does not re-derive them.
    flags: {
      band_under_10k: Object.entries(bands).filter(([, b]) => b.compacts_by_design !== false && b.live_compact_band_tokens != null && b.live_compact_band_tokens < 10000).map(([t]) => t),
      compaction_death_margin_under_10k: Object.entries(bands).filter(([, b]) => b.compacts_by_design !== false && b.tokens_to_compaction_death != null && b.tokens_to_compaction_death < 10000).map(([t]) => t),
      // The condition the two flags above only PROXY for: a session that was
      // already past the cliff when the guard declined to compact it. This can
      // fire while both of the above are empty, and on 2026-09-29 it did.
      compaction_died_on_a_live_session: Object.entries(bands).filter(([, b]) => b.compacts_by_design !== false && (b.past_cliff_episodes || 0) > 0).map(([t]) => t),
      // Tiers where the live-session question has no data this window. Never
      // read these as clear.
      live_margin_unmeasured: Object.entries(bands).filter(([, b]) => b.compacts_by_design !== false && b.live_margin_measured === false).map(([t]) => t),
      rotation_pct_over_20: latest && latest.rotation_pct != null && latest.rotation_pct > 20,
      skip_episodes_over_1_per_day: Object.entries(bands).filter(([, b]) => !b.churn_partial && (b.compacts_skipped_episodes || 0) > 1).map(([t]) => t),
      // A tier whose two floor measurements disagree. Every floor-derived
      // number for it — band, dead zone, cliff margin, working window, and any
      // claimed floor-cut saving — is unsafe until the gap is explained.
      // Tiers left out of the four cliff flags above because they rotate
      // instead of compacting — listed so "absent" is never read as "clear".
      cliff_not_applicable_rotate_only: Object.entries(bands).filter(([, b]) => b.compacts_by_design === false).map(([t]) => t),
      floor_disagreement_over_2k: Object.entries(bands).filter(([, b]) => b.floor_disagreement_tokens != null && Math.abs(b.floor_disagreement_tokens) > 2000).map(([t]) => t),
    },
  };
});

// ── Floor attribution: the always-loaded PREFIX vs the dispatch's own inline
//    payload (added 2026-10-06) ─────────────────────────────────────────────
//
// `supervisors[].floor_tokens` and the guard's runtime `floorTokens` both
// measure ONE SESSION's uncompactable context — and that includes the dispatch
// message itself, which for a scheduled job is its entire playbook, injected
// inline. `jobs/hum.md` is 95,659 chars; at the calibrated ~0.35 tok/char that
// is ~33k tokens of "floor" belonging to the JOB, not to the tier.
//
// So a tier's reported floor is a function of WHICH JOBS happened to start
// sessions in the window, while the 1.5k/day growth tripwire, the 40k
// working-window alarm and the cliff arithmetic all read it as structural.
//
// Measured 2026-10-06, the night a ~24k always-loaded cut was due to
// be measured: ops-light's 19 session-start floors were BIMODAL. gmail:*,
// chat-consolidate and a nightly watch job read 126,168-128,761 — the real
// post-cut prefix, -23,500 against a predicted -23,970 — while all eight
// hum-family sessions read 159,851-160,484, straddling the 160,000 cliff. The
// median landed in the high mode, so the tier reported floor 160,484 (+9,998
// vs the day before) and fired `compaction_died_on_a_live_session`, on a night
// its prefix had FALLEN 23,500 tokens exactly as predicted.
//
// `prefix_floor_tokens` is the LOWEST per-source median: the cohort whose
// dispatch carries no large inline payload. That is the number the
// always-loaded tripwires must read. The per-session floor in
// `rotation_overhead.bands` is left exactly as it is — it is the right input
// for the cliff question, which is genuinely per session (a hum session really
// cannot compact). Same defect family as cost-churn-coverage-20260814,
// cost-skip-episodes-20260819 and cost-index-comparability-20260831: a
// measurement reading a changed input as a valid comparison.
guard('floor_attribution', () => {
  const JOIN_MS = 5 * 60 * 1000;
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const tiers = {};
  for (const tier of TIERS) {
    let content;
    try { content = fs.readFileSync(path.join(ROOT, `agent/logs/supervisor-${tier}/events.ndjson`), 'utf8'); } catch { continue; }
    const floors = [], dispatches = [];
    for (const line of content.split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(e.ts);
      if (!(ts >= SINCE && ts < SINCE + WINDOW_MS)) continue;
      if (e.kind === 'context.floor_measured' && typeof e.floorTokens === 'number' && e.floorTokens > 0) {
        floors.push({ ts, sid: e.sessionId || null, floor: e.floorTokens });
      } else if (e.kind === 'dispatcher.dispatching' && e.item && e.item.source) {
        dispatches.push({ ts, source: e.item.source });
      }
    }
    if (!floors.length) { tiers[tier] = { samples: 0, note: 'no context.floor_measured events in window' }; continue; }
    // One reading per session, the FIRST. A later floor_measured on the same
    // sessionId is a mid-life re-measure (observed at 332,268 with a working
    // window of 0) and is not a session-start floor.
    floors.sort((a, b) => a.ts - b.ts);
    const seen = new Set(), starts = [];
    for (const f of floors) {
      const key = f.sid || `ts:${f.ts}`;
      if (seen.has(key)) continue;
      seen.add(key); starts.push(f);
    }
    // Join each session start to the NEAREST dispatch, not the first one in
    // range — two jobs can dispatch inside the same 5 minutes.
    const bySource = {};
    for (const f of starts) {
      let best = null;
      for (const d of dispatches) {
        const dt = Math.abs(d.ts - f.ts);
        if (dt > JOIN_MS) continue;
        if (!best || dt < best.dt) best = { dt, source: d.source };
      }
      let src = best ? best.source : 'unjoined';
      // Fold the per-message Gmail sources into one cohort, as the ledger
      // rollup does — they are one job, not hundreds.
      if (src.startsWith('gmail:')) src = 'gmail:*';
      (bySource[src] = bySource[src] || []).push(f.floor);
    }
    const perSource = {};
    for (const [src, vals] of Object.entries(bySource)) {
      perSource[src] = {
        n: vals.length,
        median_floor_tokens: med(vals),
        min_floor_tokens: Math.min(...vals),
        max_floor_tokens: Math.max(...vals),
      };
    }
    const ranked = Object.entries(perSource).sort((a, b) => a[1].median_floor_tokens - b[1].median_floor_tokens);
    // Prefer the lightest cohort that is actually SAMPLED. A bare minimum over
    // per-source medians picks whichever thin cohort happened to land lowest:
    // on 2026-10-06 that was a nightly watch job at n=1 / 126,737, over gmail:* at
    // n=6 / 126,844 — 107 tokens lower and six times less evidence. Fall back
    // to the outright minimum only when no cohort clears the bar, and let
    // prefix_floor_thinly_sampled say so.
    const PREFIX_MIN_SAMPLES = 3;
    const [lightestSrc, lightest] = ranked.find(([, v]) => v.n >= PREFIX_MIN_SAMPLES) || ranked[0];
    const [heaviestSrc, heaviest] = ranked[ranked.length - 1];
    tiers[tier] = {
      samples: starts.length,
      sources: ranked.length,
      // THE always-loaded prefix. Compare this day over day for floor growth.
      prefix_floor_tokens: lightest.median_floor_tokens,
      prefix_floor_source: lightestSrc,
      prefix_floor_samples: lightest.n,
      // What the tier reports today, for the record — mix-dependent.
      session_floor_median_tokens: med(starts.map((f) => f.floor)),
      min_session_floor_tokens: ranked[0][1].median_floor_tokens,
      min_session_floor_source: ranked[0][0],
      ledger_floor_tokens: (today.supervisors || []).find((s) => s.supervisor === tier)?.floor_tokens ?? null,
      // How much of the heaviest cohort's floor is its own inline playbook.
      payload_inflation_tokens: heaviest.median_floor_tokens - lightest.median_floor_tokens,
      heaviest_source: heaviestSrc,
      heaviest_floor_tokens: heaviest.median_floor_tokens,
      // The working window an ordinary (short-dispatch) session actually gets.
      working_window_on_prefix_tokens: GUARD_THRESHOLDS.rotate - lightest.median_floor_tokens,
      floor_by_source: perSource,
    };
  }
  return {
    note: 'prefix_floor_tokens is the always-loaded prefix (the lowest-payload dispatch cohort) and is what the floor-growth and working-window tripwires must read. floor_tokens and bands[].floor_tokens are PER-SESSION and include the dispatch playbook — correct for the cliff question, wrong for a day-over-day floor comparison.',
    join_window_ms: JOIN_MS,
    tiers,
    flags: {
      // The reported floor is not comparable day over day on these tiers: the
      // gap between the lightest and heaviest dispatch cohort clears the
      // 1.5k/day growth tripwire several times over, so which jobs happened to
      // start sessions decides the number.
      floor_reading_is_mix_contaminated: Object.entries(tiers)
        .filter(([, v]) => (v.payload_inflation_tokens || 0) > 5000).map(([t]) => t),
      // A prefix floor resting on one or two cohort samples is a hint, not a
      // measurement — same bar as floor_samples.
      prefix_floor_thinly_sampled: Object.entries(tiers)
        .filter(([, v]) => v.samples > 0 && (v.prefix_floor_samples || 0) < 3).map(([t]) => t),
      // The prefix is BELOW the cohort chosen for it, i.e. some thinner cohort
      // read lower. Not necessarily wrong — but the prefix may be overstated.
      prefix_floor_above_min: Object.entries(tiers)
        .filter(([, v]) => v.prefix_floor_tokens != null && v.min_session_floor_tokens != null
          && v.prefix_floor_tokens > v.min_session_floor_tokens).map(([t]) => t),
      // No session start measured a floor at all this window: UNMEASURED, not
      // clear (log_sources_that_do_not_cover_yesterday, 2026-08-16).
      prefix_floor_unmeasured: Object.entries(tiers)
        .filter(([, v]) => !v.samples).map(([t]) => t),
    },
  };
});

fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`cost-review-prefetch: wrote ${outPath} (${fs.statSync(outPath).size} bytes, ${out.errors.length} soft errors)`);
