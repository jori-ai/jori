'use strict';
/**
 * Consecutive calendar-fetch-failure tracking for bin/exercise-schedule.
 *
 * Regression guard — exercise-calendar-silent-outage.
 * Defends against: weeks of consecutive days on which exercise-schedule's
 * calendar read failed (gog returned `tls: failed to verify certificate:
 * x509: OSStatus -26276` on the OAuth token refresh), the defensive fallback
 * row was written, no exercise event was created, and the process exited 0.
 * Nothing anywhere said so. An earlier fix made a persistent failure
 * *visible* — but only to a person who opens data/logs/exercise-schedule.log,
 * and nobody did for three weeks. The gap this closes is detection, not the
 * fetch itself: a run that cannot read the calendar is still a silent skip for
 * the day (that part is deliberate, see the _fetchFailed branch in
 * exercise-schedule), but a *streak* of them now says so out loud, once, with
 * the real error attached.
 *
 * Deliberately NOT in this module: any interpretation of the error. The page
 * that finally surfaced this asserted "OAuth token refresh may be needed",
 * which the evidence does not support — a Security-framework internal error
 * during TLS verification is not a stale token. We report the error verbatim
 * and let a human read it.
 */

const fs = require('fs');

// A run that cannot read the calendar is survivable; three days of them is not.
const ESCALATE_AFTER_DAYS = 3;
// After the first page, re-page at most weekly while the condition persists,
// so a long outage stays visible without becoming the noise this system already
// has too much of.
const RE_ESCALATE_EVERY_DAYS = 7;

function emptyState() {
  return {
    consecutive_days: 0,
    first_failed_date: null,
    last_failed_date: null,
    last_error: null,
    last_alerted_date: null,
  };
}

function readState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyState();
    return Object.assign(emptyState(), raw);
  } catch {
    return emptyState();
  }
}

function writeState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function daysBetween(aDate, bDate) {
  const a = Date.parse(`${aDate}T00:00:00Z`);
  const b = Date.parse(`${bDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Fold today's failure into the streak. Counts DAYS, not runs — a second run
 * on a date already counted does not advance the streak (exercise-schedule can
 * be re-dispatched, and a re-dispatch is not a second day of outage).
 */
function recordFailure(state, dateStr, errorText) {
  const next = Object.assign(emptyState(), state);
  if (next.last_failed_date === dateStr) {
    next.last_error = errorText || next.last_error;
    return next;
  }
  next.consecutive_days = (next.consecutive_days || 0) + 1;
  if (!next.first_failed_date) next.first_failed_date = dateStr;
  next.last_failed_date = dateStr;
  next.last_error = errorText || null;
  return next;
}

/**
 * Should this failure be said out loud? True on the day the streak reaches
 * ESCALATE_AFTER_DAYS, and then at most once every RE_ESCALATE_EVERY_DAYS.
 */
function shouldEscalate(state, dateStr) {
  if (!state || (state.consecutive_days || 0) < ESCALATE_AFTER_DAYS) return false;
  if (!state.last_alerted_date) return true;
  if (state.last_alerted_date === dateStr) return false;
  const since = daysBetween(state.last_alerted_date, dateStr);
  if (since === null) return true;
  return since >= RE_ESCALATE_EVERY_DAYS;
}

/**
 * The message. Factual and job-scoped by construction: it names this job, the
 * count, the consequence, and quotes the observed error. It makes no claim
 * about the machine, no claim about a cause, and proposes no remedy — all
 * three are how the earlier page got it wrong.
 */
function escalationMessage(state) {
  const days = state.consecutive_days;
  const firstPart = state.first_failed_date ? ` since ${state.first_failed_date}` : '';
  const err = String(state.last_error || '').trim().split('\n')[0].slice(0, 300) || '(no error text captured)';
  return `⚠️ exercise-schedule hasn't been able to read the calendar for ${days} days running${firstPart}, so no exercise block has been put on the calendar on any of them. The run itself finishes cleanly, which is why this went unnoticed. What gog reports, verbatim: ${err}`;
}

module.exports = {
  ESCALATE_AFTER_DAYS,
  RE_ESCALATE_EVERY_DAYS,
  emptyState,
  readState,
  writeState,
  recordFailure,
  shouldEscalate,
  escalationMessage,
  daysBetween,
};
