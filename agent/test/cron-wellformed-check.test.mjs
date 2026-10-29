// cron-wellformed-check.test.mjs — doctor check (8d3): is every ACTIVE crontab
// entry still a well-formed 5-field schedule followed by a real command?
//
// Run: node --test agent/test/cron-wellformed-check.test.mjs
//
// The headline case is the real regression: on 2026-09-05 cron-tz-sync matched
// a DISABLED entry by its --label and rewrote it positionally, overwriting the
// `#HUMPAUSE#` marker with the minute and shifting every field one place right.
// The result — `0 23 23 * * * /…/cron-run …` — runs `*` as its command and
// fires on the 23rd of the month; it also lost the marker, so lifting the pause
// would have restored every other lane and left this one dead.
//
// The equally important cases are the NEGATIVES. This check reads a real
// crontab where bare-word commands, quoted `bash -c '…'` bodies, @reboot
// shortcuts, env-assignment lines, JAN/MON name forms and step syntax are all
// legal — flagging any of them would make the check noise, and a noisy health
// dashboard is how the next real one gets scrolled past.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import mod from "../../lib/cron-wellformed-check.js";

const { findMalformedCronEntries, describeMalformed } = mod;

const RUN = "/Users/example/Dev/jori/bin/cron-run";
const SH = "/Users/example/Dev/jori/agent/scripts";

describe("the 2026-09-05 regression", () => {
  it("flags the shifted trigger-hum-daily line and names it", () => {
    const { bad } = findMalformedCronEntries([
      `0 23 23 * * * ${RUN} --label trigger-hum-daily -- ${SH}/trigger-hum-daily.sh`,
    ]);
    assert.equal(bad.length, 1);
    assert.equal(bad[0].label, "trigger-hum-daily");
    assert.match(bad[0].reason, /schedule glyph, not a command/);
  });

  it("passes the same line once it is repaired", () => {
    const { bad } = findMalformedCronEntries([
      `0 23 * * * ${RUN} --label trigger-hum-daily -- ${SH}/trigger-hum-daily.sh`,
    ]);
    assert.deepEqual(bad, []);
  });

  it("describeMalformed leads with the label, not 40 chars of path", () => {
    const { bad } = findMalformedCronEntries([
      `0 23 23 * * * ${RUN} --label trigger-hum-daily -- ${SH}/trigger-hum-daily.sh`,
    ]);
    assert.match(describeMalformed(bad), /^trigger-hum-daily: /);
  });
});

describe("other shift shapes", () => {
  it("flags a numeric token in the command position", () => {
    const { bad } = findMalformedCronEntries([`*/20 0 * * * 5 ${RUN} --label x -- ${SH}/x.sh`]);
    assert.equal(bad.length, 1);
    assert.match(bad[0].reason, /"5"/);
  });

  it("flags a step glyph in the command position", () => {
    const { bad } = findMalformedCronEntries([`0 6,11,14,19 * * * */20 ${RUN} --label y -- ${SH}/y.sh`]);
    assert.equal(bad.length, 1);
  });

  it("flags a schedule field that is not a cron field at all", () => {
    const { bad } = findMalformedCronEntries([`#HUMPAUSE# 0 23 * * ${RUN} --label z -- ${SH}/z.sh`]);
    assert.equal(bad.length, 1);
    assert.match(bad[0].reason, /schedule field 1/);
  });

  it("flags a line with a schedule and nothing after it", () => {
    const { bad } = findMalformedCronEntries(["0 23 * * *"]);
    assert.equal(bad.length, 1);
    assert.match(bad[0].reason, /no command follows/);
  });
});

describe("negatives — real crontab shapes that must stay green", () => {
  const good = [
    `*/20 * * * * ${RUN} --label trigger-hum -- ${SH}/trigger-hum.sh`,
    `15 0,10 * * * ${RUN} --label trigger-plaid-sync -- ${SH}/trigger-plaid-sync.sh`,
    `30 9 * * 0 ${RUN} --label trigger-hum-review -- ${SH}/trigger-hum-review.sh`,
    `0 8 23 6 * /Users/example/Dev/jori/bin/hum-channel-audit --days 3 >> /tmp/a.log 2>&1`,
    `15 10 * * * ${RUN} --label e -- bash -c '${SH}/e.sh >> /tmp/e.log 2>&1'`,
    `0 3 * * MON-FRI /usr/bin/find /tmp -delete`,
    `0 0 1 JAN * /bin/echo new-year`,
    "@reboot /Users/example/Dev/jori/bin/watchdog.sh",
    "@daily /usr/bin/true",
    "PATH=/opt/homebrew/bin:/usr/bin:/bin",
    "MAILTO=",
    "SHELL=/bin/zsh",
  ];

  it("passes every one of them", () => {
    const { bad } = findMalformedCronEntries(good);
    assert.deepEqual(bad.map((b) => b.line), []);
  });

  it("counts only real schedule entries as scanned", () => {
    const { scanned } = findMalformedCronEntries(good);
    assert.equal(scanned, 9); // 12 lines minus the 3 env assignments
  });

  it("accepts a bare-word command, which shares its alphabet with JAN/MON", () => {
    const { bad } = findMalformedCronEntries(["0 3 * * * bash /tmp/x.sh"]);
    assert.deepEqual(bad, []);
  });

  it("is silent on an empty crontab", () => {
    assert.deepEqual(findMalformedCronEntries([]), { bad: [], scanned: 0 });
  });
});
