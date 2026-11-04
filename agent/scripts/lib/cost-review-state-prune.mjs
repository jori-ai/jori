#!/usr/bin/env node
// Prune data/cost-efficiency-review-state.json before each dispatch.
//
// WHY (2026-09-11). The cost review is 9.3% of the ACCOUNT's weekly spend
// ($113 list / 7d, measured by jori-allowance-coverage) against its own
// playbook's ~$3/run bug threshold — the single largest ephemeral-Opus line in
// the fleet, and the one this job actually controls. The measured cause is its
// own state file: 360,372 bytes, +7.4k in a day. Every run parses it and pulls
// large slices into an Opus xhigh context. Its three sections are mostly
// settled: 16 of 40 carry_forward entries are CLOSED ballast, history rows have
// roughly doubled in size (5.8k -> 11.9k bytes/row) because each carries prose
// the tripwires never read, and proposals keeps full detail for cards applied
// weeks ago.
//
// ARCHIVE, NEVER DELETE. Everything removed lands in
// data/cost-efficiency-review-archive.json, same shape, and each live
// entry keeps a stub saying where it went — so a future run can still tell that
// a question was settled, and can go read HOW it was settled if it needs to.
// The point is to stop paying for settled reasoning EVERY night, not to forget
// it. What stays live is exactly what Step 1's tripwires read.
//
// Deterministic by construction (Rule #0b): this decides structure and dates,
// never what anything MEANT. No model, no regex over prose.
//
// Idempotent. Fails open — on any error it leaves both files untouched and
// exits 0, because a prune failure must never block the night's review.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

const [, , STATE, ARCHIVE] = process.argv;
if (!STATE || !ARCHIVE) {
  console.error('usage: cost-review-state-prune.mjs <state.json> <archive.json>');
  process.exit(0);
}

// Tunables. Deliberately generous: the live file must still answer every
// tripwire in Step 1 without reaching for the archive.
const HISTORY_FULL_DAYS = 7;      // rows newer than this keep their prose
const PROPOSAL_DETAIL_DAYS = 14;  // terminal proposals older than this get stubbed
const SETTLED = ['closed', 'retracted', 'superseded'];

// The fields every Step 1 tripwire reads. An older history row keeps these and
// nothing else; its annotations move to the archive.
const HISTORY_KEEP = new Set([
  'date', 'window', 'dispatches', 'context_overhead_pct', 'weighted_cost_usd',
  'usd_per_dispatch', 'cost_per_1k_output_usd', 'turns_per_dispatch',
  'total_turns', 'floors', 'floor_samples', 'working_windows', 'compacts',
  'rotates', 'compacts_skipped', 'compacts_skipped_episodes', 'churn_partial',
  'max_usage', 'job_cost_index', 'written_by', 'agent_annotated', 'delivered',
  'annotations_archived',
]);
const PROPOSAL_KEEP = new Set(['id', 'filed_at', 'summary', 'est_usd_per_day', 'status']);

const isSettled = (status) => {
  if (typeof status !== 'string') return false;
  const s = status.trim().toLowerCase();
  return SETTLED.some((w) => s.startsWith(w) || s.startsWith(`fully ${w}`));
};
const isTerminal = (status) => {
  if (typeof status !== 'string') return false;
  const s = status.trim().toLowerCase();
  return s.startsWith('applied') || s.startsWith('signed') || s.startsWith('verified');
};
const daysOld = (iso, now) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now - t) / 86_400_000 : NaN;
};
const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);

const writeAtomic = (path, obj) => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, path);
};

let state;
try {
  state = JSON.parse(readFileSync(STATE, 'utf8'));
} catch (err) {
  console.log(`prune: cannot read state (${err.message}) — leaving it alone`);
  process.exit(0);
}

const before = JSON.stringify(state).length;
const now = Date.now();

let archive = { _comment: 'Settled cost-review memory, moved out of the live state file by cost-review-state-prune. Nothing here was deleted. Read it when a stub in the live file points at it.', carry_forward: {}, history_annotations: {}, proposals: {} };
if (existsSync(ARCHIVE)) {
  try { archive = { ...archive, ...JSON.parse(readFileSync(ARCHIVE, 'utf8')) }; }
  catch (err) { console.log(`prune: archive unreadable (${err.message}) — starting a fresh one, live file untouched until it writes`); }
}

const moved = { carry_forward: 0, history: 0, proposals: 0 };

// 1. carry_forward — settled entries become a one-line stub.
for (const [key, entry] of Object.entries(state.carry_forward || {})) {
  if (!entry || typeof entry !== 'object' || entry.archived) continue;
  if (!isSettled(entry.status)) continue;
  archive.carry_forward[key] = entry;
  state.carry_forward[key] = {
    archived: true,
    status: clip(entry.status, 160),
    read_it_at: 'data/cost-efficiency-review-archive.json § carry_forward',
  };
  moved.carry_forward++;
}

// 2. history — rows past the full-detail window keep only tripwire fields.
const history = Array.isArray(state.history) ? state.history : [];
const cutoffIdx = Math.max(0, history.length - HISTORY_FULL_DAYS);
history.forEach((row, i) => {
  if (i >= cutoffIdx || !row || typeof row !== 'object' || row.annotations_archived) return;
  const dropped = {};
  for (const k of Object.keys(row)) {
    if (!HISTORY_KEEP.has(k)) { dropped[k] = row[k]; delete row[k]; }
  }
  if (Object.keys(dropped).length) {
    archive.history_annotations[row.date || `row-${i}`] = {
      ...(archive.history_annotations[row.date] || {}), ...dropped,
    };
    row.annotations_archived = true;
    moved.history++;
  }
});

// 3. proposals — terminal and old enough that only the verdict still matters.
const proposals = Array.isArray(state.proposals) ? state.proposals : [];
proposals.forEach((p, i) => {
  if (!p || typeof p !== 'object' || p.detail_archived) return;
  if (!isTerminal(p.status)) return;
  if (!(daysOld(p.filed_at, now) > PROPOSAL_DETAIL_DAYS)) return;
  const dropped = {};
  for (const k of Object.keys(p)) if (!PROPOSAL_KEEP.has(k)) { dropped[k] = p[k]; delete p[k]; }
  p.summary = clip(p.summary, 220);
  p.status = clip(p.status, 140);
  if (Object.keys(dropped).length) {
    archive.proposals[p.id || `proposal-${i}`] = dropped;
    p.detail_archived = true;
    moved.proposals++;
  }
});

const total = moved.carry_forward + moved.history + moved.proposals;
if (!total) { console.log(`prune: nothing settled to move (state ${before} bytes)`); process.exit(0); }

try {
  // Archive first, always. If the process dies between the two writes the
  // worst case is a duplicated entry, never a lost one.
  writeAtomic(ARCHIVE, archive);
  writeAtomic(STATE, state);
} catch (err) {
  console.log(`prune: write failed (${err.message}) — state left as it was`);
  process.exit(0);
}

const after = JSON.stringify(state).length;
console.log(`prune: ${moved.carry_forward} carry_forward, ${moved.history} history rows, ${moved.proposals} proposals archived — state ${before} -> ${after} bytes (-${(100 * (before - after) / before).toFixed(1)}%)`);
