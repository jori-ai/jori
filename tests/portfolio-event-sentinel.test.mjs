// portfolio-event-sentinel.test.mjs — lib/tier3-sentinel.mjs: a watched hard
// event starts one out-of-cycle review, once. Synthetic holdings and events.
// Run: node --test tests/portfolio-event-sentinel.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pendingFire, markFired } from '../lib/tier3-sentinel.mjs';

const CLI = new URL('../lib/tier3-sentinel.mjs', import.meta.url).pathname;

test('only hard events that have not fired yet start a run', () => {
  const state = {
    candidates: [
      { id: 'acme-bb-2026-10-20', hard_event: true, row: 'Acme Holdings' },
      { id: 'zeta-round-talks', hard_event: false, row: 'Zeta Labs tranche' },
      { id: 'gridco-coupon-2026-10-15', hard_event: true, row: 'GridCo' },
    ],
    fired_ids: ['gridco-coupon-2026-10-15'],
  };
  assert.deepEqual(pendingFire(state).map((c) => c.id), ['acme-bb-2026-10-20']);
});

test('missing or malformed state never fires', () => {
  assert.deepEqual(pendingFire(null), []);
  assert.deepEqual(pendingFire({}), []);
  assert.deepEqual(pendingFire({ candidates: [{ hard_event: true }] }), []);
  assert.deepEqual(pendingFire({ candidates: [{ id: 'x', hard_event: 'true' }] }), []);
});

test('markFired dedups and keeps earlier ids', () => {
  const next = markFired({ fired_ids: ['a'] }, ['b', 'a'], new Date('2026-10-17T06:00:00Z'));
  assert.deepEqual(next.fired_ids, ['a', 'b']);
  assert.equal(next.last_fired_at, '2026-10-17T06:00:00.000Z');
});

test('CLI decide → mark-fired → decide is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3s-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({
    candidates: [{ id: 'bolt-junk-2026-10-21', hard_event: true, row: 'Bolt Systems', headline: 'A rating agency cuts Bolt Systems to BB+', event_date: '2026-10-21' }],
  }));
  const first = JSON.parse(execFileSync('node', [CLI, 'decide', file], { encoding: 'utf8' }));
  assert.equal(first.fire, true);
  assert.deepEqual(first.ids, ['bolt-junk-2026-10-21']);
  assert.match(first.summary, /Bolt Systems: A rating agency cuts Bolt Systems to BB\+ \(2026-10-21\)/);
  execFileSync('node', [CLI, 'mark-fired', file, first.ids.join(',')]);
  const second = JSON.parse(execFileSync('node', [CLI, 'decide', file], { encoding: 'utf8' }));
  assert.equal(second.fire, false);
});
