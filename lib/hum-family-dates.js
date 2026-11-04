"use strict";
// Pure birthday-window date logic for the `family` hum harvester, extracted
// so it's unit-testable and anchored through gdate.js instead of hand-rolled
// `new Date()` math (the class of bug gdate.js exists to eliminate — see its
// header comment). The harvester previously computed "days until next
// occurrence" via raw Date subtraction using the SERVER's local timezone
// (`new Date()`, `new Date(thisYear, m-1, d)`), with no explicit anchor to
// the user's home zone and no DST-safe day-count arithmetic. gdate.js's
// `todayISO()`/`diffDays()` fix both: todayISO() is always anchored to the
// home zone via Intl.DateTimeFormat regardless of the host's local TZ, and diffDays() does
// whole-day UTC arithmetic so it never drifts across a DST transition.
const gdate = require("./gdate.js");

// Days until the next occurrence of an MM-DD date, anchored at todayIso
// (defaults to gdate's real home-zone "today"). Walks forward year-by-year so a
// Feb-29 birthday resolves to the next actual leap year instead of crashing
// (gdate.assertISO rejects "2027-02-29" as not a real calendar date) or
// silently drifting to March 1 the way plain `new Date(2027, 1, 29)` would.
function daysUntilNextOccurrence(mmdd, todayIso = gdate.todayISO()) {
  const [todayY] = todayIso.split("-").map(Number);
  for (let y = todayY; y <= todayY + 5; y++) {
    const candidate = `${y}-${mmdd}`;
    try {
      gdate.assertISO(candidate);
    } catch {
      continue; // e.g. Feb 29 on a non-leap year
    }
    const diff = gdate.diffDays(todayIso, candidate);
    if (diff >= 0) return diff;
  }
  throw new Error(`could not resolve next occurrence of ${mmdd} within 5 years of ${todayIso}`);
}

// Filter a list of {who, mmdd} to the ones falling in the given T-minus
// windows (default the hum harvester's own [0, 2, 7]).
function birthdayWindowHits(birthdays, windows = [0, 2, 7], todayIso = gdate.todayISO()) {
  return birthdays
    .map((b) => ({ ...b, days: daysUntilNextOccurrence(b.mmdd, todayIso) }))
    .filter((b) => windows.includes(b.days));
}

module.exports = { daysUntilNextOccurrence, birthdayWindowHits };
