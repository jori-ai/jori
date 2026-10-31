import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const streak = require('../lib/exercise-calendar-fail-streak.js');

// Regression guard — exercise-calendar-silent-outage: weeks of consecutive days
// with no exercise event and no alert. These cases pin the day on which that
// becomes audible.

test('a single bad day stays quiet', () => {
  let s = streak.recordFailure(streak.emptyState(), '2026-08-22', 'boom');
  assert.equal(s.consecutive_days, 1);
  assert.equal(streak.shouldEscalate(s, '2026-08-22'), false);
});

test('three consecutive days escalates once', () => {
  let s = streak.emptyState();
  for (const d of ['2026-08-22', '2026-08-23', '2026-08-24']) s = streak.recordFailure(s, d, 'boom');
  assert.equal(s.consecutive_days, 3);
  assert.equal(s.first_failed_date, '2026-08-22');
  assert.equal(streak.shouldEscalate(s, '2026-08-24'), true);
  s.last_alerted_date = '2026-08-24';
  assert.equal(streak.shouldEscalate(s, '2026-08-24'), false, 'same day never re-pages');
  s = streak.recordFailure(s, '2026-08-25', 'boom');
  assert.equal(streak.shouldEscalate(s, '2026-08-25'), false, 'day 4 rides the weekly cooldown');
});

test('a persistent outage re-pages weekly, not daily', () => {
  let s = streak.emptyState();
  for (const d of ['2026-08-22', '2026-08-23', '2026-08-24']) s = streak.recordFailure(s, d, 'boom');
  s.last_alerted_date = '2026-08-24';
  s = streak.recordFailure(s, '2026-08-31', 'boom');
  assert.equal(streak.shouldEscalate(s, '2026-08-31'), true);
});

test('two runs on the same date count as one day', () => {
  let s = streak.recordFailure(streak.emptyState(), '2026-08-22', 'first');
  s = streak.recordFailure(s, '2026-08-22', 'second');
  assert.equal(s.consecutive_days, 1);
  assert.equal(s.last_error, 'second');
});

test('the message quotes the observed error and diagnoses nothing', () => {
  let s = streak.emptyState();
  const real = 'failed to get primary calendar: Post "https://oauth2.googleapis.com/token": tls: failed to verify certificate: x509: OSStatus -26276';
  for (const d of ['2026-09-10', '2026-09-11', '2026-09-12']) s = streak.recordFailure(s, d, real);
  const msg = streak.escalationMessage(s);
  assert.match(msg, /OSStatus -26276/);  // lang-regex-ok: checks the code-composed alert text
  assert.match(msg, /3 days running/);  // lang-regex-ok: checks the code-composed alert text
  // An earlier page asserted a cause the evidence does not support.
  assert.doesNotMatch(msg, /OAuth token refresh may be needed/i);
  // Job-scoped: must never read as a machine-wide outage claim
  // (bin/jori-send-curl's fabricated-outage gate).
  assert.doesNotMatch(msg, /crontab empty|no scheduled jobs|supervisors unreachable|manual restart/i);
});

test('a missing or corrupt state file reads as an empty streak', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exstreak-'));
  const f = path.join(dir, 'state.json');
  assert.equal(streak.readState(f).consecutive_days, 0);
  fs.writeFileSync(f, 'not json');
  assert.equal(streak.readState(f).consecutive_days, 0);
  streak.writeState(f, streak.recordFailure(streak.emptyState(), '2026-09-12', 'boom'));
  assert.equal(streak.readState(f).consecutive_days, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
