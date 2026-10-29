#!/usr/bin/env node
// tier3-sentinel.mjs — the code half of a daily Tier-3 portfolio sentinel.
//
// The sentinel's model turn (its playbook) reads the news and writes its
// candidates to the sentinel state file (a JSON file the caller passes).
// Whether that starts an off-cycle weekly-monitor run is decided HERE, in code,
// from the structured fields the model wrote — never by reading its prose.
//
// Fire rule: a candidate with `hard_event: true` whose `id` has not already
// started an off-cycle run (`fired_ids`). One off-cycle run per event, ever:
// the weekly monitor owns everything after that, including the Phase 2A
// second-half check five trading days later.
//
// Usage:
//   tier3-sentinel.mjs decide <state.json>         → prints {"fire":bool,"ids":[...],"summary":"..."}
//   tier3-sentinel.mjs mark-fired <state.json> <id,...>

import fs from 'node:fs';

export function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function pendingFire(state) {
  if (!state || !Array.isArray(state.candidates)) return [];
  const fired = new Set(Array.isArray(state.fired_ids) ? state.fired_ids : []);
  return state.candidates.filter(
    (c) => c && c.hard_event === true && typeof c.id === 'string' && c.id && !fired.has(c.id),
  );
}

export function markFired(state, ids, now = new Date()) {
  const fired = new Set(Array.isArray(state.fired_ids) ? state.fired_ids : []);
  for (const id of ids) fired.add(id);
  return { ...state, fired_ids: [...fired], last_fired_at: now.toISOString() };
}

function main(argv) {
  const [cmd, file, idList] = argv;
  if (cmd === 'decide' && file) {
    const hits = pendingFire(readState(file));
    const summary = hits.map((c) => `${c.row || 'tier3'}: ${c.headline || c.id}${c.event_date ? ` (${c.event_date})` : ''}`).join('; ');
    process.stdout.write(JSON.stringify({ fire: hits.length > 0, ids: hits.map((c) => c.id), summary }) + '\n');
    return 0;
  }
  if (cmd === 'mark-fired' && file && idList) {
    const state = readState(file);
    if (!state) return 1;
    const next = markFired(state, idList.split(',').filter(Boolean));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return 0;
  }
  process.stderr.write('usage: tier3-sentinel.mjs decide <state.json> | mark-fired <state.json> <id,...>\n');
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
