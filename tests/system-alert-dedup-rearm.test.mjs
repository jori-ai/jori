// system-alert-dedup-rearm.test.mjs — a condition that goes quiet and comes
// BACK is a new incident, not a repeat.
//
// Defends a real miss: a token watch pages exactly once per ~7-day OAuth
// re-auth cycle. Cycle 1 sent; cycle 2 was suppressed as "repeat 2 of a
// condition first seen <cycle 1>" and the user was told nothing about a window
// only they can renew. Because each cycle refreshed last_seen, the 14-day forget
// sweep could never fire either — every later cycle would have been silent too.
//
// The second half of this file is the other half of the bargain: the chronic
// conditions this helper exists for (sub-daily re-firings) must STILL collapse.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = process.env.DEDUP_BIN
  || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "system-alert-dedup");

let STATE;
function fresh() {
  STATE = path.join(os.tmpdir(), `sad-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
}
function send(message, intent = "broker-token") {
  return spawnSync(BIN, ["--intent", intent, "--message", message], {
    env: { ...process.env, JORI_ALERT_DEDUP_STATE: STATE },
    encoding: "utf8",
  }).status;
}
function state() { return JSON.parse(fs.readFileSync(STATE, "utf8")); }
function quietFor(hours) {
  const s = state();
  const when = new Date(Date.now() - hours * 3600_000).toISOString();
  for (const v of Object.values(s)) v.last_seen = when;
  fs.writeFileSync(STATE, JSON.stringify(s));
}

const WARN = '⚠️ Broker "primary" needs re-linking in 1.1 days — re-link at https://broker.example.com/tokens';

test("a 7-day re-auth cycle pages every time, not just the first", () => {
  fresh();
  assert.equal(send(WARN), 0, "cycle 1 must page");
  quietFor(24 * 7);
  assert.equal(send(WARN), 0, "cycle 2 must page — the original miss");
  quietFor(24 * 7);
  assert.equal(send(WARN), 0, "cycle 3 must page");
  quietFor(24 * 7);
  assert.equal(send(WARN), 0, "cycle 4 must page (previously suppressed for good)");
  assert.equal(Object.values(state())[0].cycles, 4);
});

test("48h of quiet re-arms; 47h does not", () => {
  fresh();
  assert.equal(send(WARN), 0);
  quietFor(47);
  assert.equal(send(WARN), 1, "47h is still the same incident");
  quietFor(49);
  assert.equal(send(WARN), 0, "49h means it cleared and came back");
});

test("chronic sub-daily noise still collapses", () => {
  fresh();
  const hang = "⚠️ Ops turn from village-watch hung 10min — killing and restarting";
  assert.equal(send(hang, "turn-hang"), 0, "first one pages");
  assert.equal(send(hang, "turn-hang"), 1, "immediate repeat suppressed");
  quietFor(6);
  assert.equal(send(hang, "turn-hang"), 1, "6h later still the same condition");
  quietFor(24);
  assert.equal(send(hang, "turn-hang"), 1, "next day still the same condition");
});

test("third-distinct-day escalation is unchanged", () => {
  fresh();
  const msg = "⚠️ unstar-scan: gmail-action fetch failed";
  assert.equal(send(msg, "unstar"), 0);
  const s = state();
  const k = Object.keys(s)[0];
  s[k].days = ["2026-09-17", "2026-09-18"];
  s[k].count = 2;
  s[k].last_seen = new Date(Date.now() - 3600_000).toISOString();
  fs.writeFileSync(STATE, JSON.stringify(s));
  assert.equal(send(msg, "unstar"), 0, "third distinct day escalates once");
  assert.equal(send(msg, "unstar"), 1, "and only once");
});

test("🔴 and ✅ are untouched by the re-arm", () => {
  fresh();
  const crit = "🔴 Supabase DB unreachable";
  assert.equal(send(crit, "supabase"), 0);
  assert.equal(send(crit, "supabase"), 0, "critical is never deduped");
  assert.equal(send("✅ Recovered: Supabase is back to normal", "supabase"), 0);
  assert.deepEqual(state(), {}, "recovery clears the intent");
});

test("a condition that never stops keeps escalating instead of going silent for good", () => {
  fresh();
  // The plaintext-credentials page.
  // watchdog.sh already throttles it to once a day and wants it every day until
  // a human moves ~/.claude/.credentials.json aside. Before this fix it paged
  // day 1, was swallowed day 2, escalated day 3 — and was suppressed for good
  // from day 4 with the hazard still on disk. It is also why the suppression
  // must stay bounded for system-issue-review: jori-send-curl skips the
  // jori_messages insert on suppress, so a permanently-silenced condition is
  // one nobody can review either.
  const CREDS = "⚠️ There is a plaintext copy of the Max login at ~/.claude/.credentials.json on the mini.";
  // Fixed past dates, so "distinct day" never collides with the real today.
  const day = (n) => `2025-01-0${n}`;

  assert.equal(send(CREDS, "watchdog-alert"), 0, "day 1 pages");
  const k = Object.keys(state())[0];

  // Walk forward one day at a time. 24h of quiet is under the 48h re-arm, so
  // this stays ONE condition throughout — the case that previously had no exit.
  const onDay = (n) => {
    const s = state();
    s[k].days = Array.from({ length: n - 1 }, (_, i) => day(i + 1));
    s[k].count = n - 1;
    s[k].last_seen = new Date(Date.now() - 24 * 3600_000).toISOString();
    fs.writeFileSync(STATE, JSON.stringify(s));
    return send(CREDS, "watchdog-alert");
  };

  assert.equal(onDay(2), 1, "day 2 collapses");
  assert.equal(onDay(3), 0, "day 3 escalates");
  assert.equal(onDay(4), 1, "day 4 collapses");
  assert.equal(onDay(5), 1, "day 5 collapses");
  assert.equal(onDay(6), 0, "day 6 escalates again — never permanently silent");
  assert.equal(onDay(9), 0, "and again on day 9");
});

test("an entry written before the fix does not re-page on the day it already escalated", () => {
  fresh();
  const msg = "⚠️ episode-archive missing for last night";
  assert.equal(send(msg, "watchdog-alert"), 0);
  const s = state();
  const k = Object.keys(s)[0];
  // The pre-2026-09-25 shape: escalated_at set, escalated_on_days absent.
  s[k].days = ["2025-01-01", "2025-01-02"];
  s[k].count = 2;
  s[k].escalated_at = new Date(Date.now() - 3600_000).toISOString();
  s[k].last_seen = new Date(Date.now() - 3600_000).toISOString();
  fs.writeFileSync(STATE, JSON.stringify(s));
  assert.equal(send(msg, "watchdog-alert"), 1, "day 3 already escalated before the upgrade");
});
