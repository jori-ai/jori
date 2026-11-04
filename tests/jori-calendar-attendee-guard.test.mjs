// Regression guard for the calendar-invite bypass.
//
// What this defends against: `jori-calendar` used to key its authorization
// refusal on the `--attendees` flag alone and forward everything else to `gog`
// verbatim. `gog calendar update --add-attendee …` (and the `--flag=value` form
// of either flag) therefore walked past the guard, logged `attendees: []` so the
// nightly calendar-attendee-audit could not reconcile the write, and inherited
// `--send-updates none` — adding a real person to a real event, silently, with
// no authorization quote required. It fired on real events.
//
// Every case here is a REFUSAL, which `jori-calendar` performs before it
// touches the audit log or spawns gog — so this file has no side effects at all:
// no calendar write, no log row, no network. That is deliberate. Do not "improve"
// it by adding an allow-path case that runs the real binary. The audit log and
// gog are pointed at a temp dir anyway, so nothing here can touch a real one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = process.env.JORI_CALENDAR_BIN
  || path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin/jori-calendar");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "jori-calendar-guard-"));
const LOG = path.join(TMP, "calendar-writes.jsonl");
// A gog that must never be reached: every case is refused first.
const FAKE = path.join(TMP, "gog");
fs.writeFileSync(FAKE, "#!/bin/sh\nexit 99\n");
fs.chmodSync(FAKE, 0o755);

const run = (...args) => {
  const r = spawnSync(BIN, args, { encoding: "utf8", env: { ...process.env, JORI_CALENDAR_GOG_BIN: FAKE, JORI_CALENDAR_LOG_FILE: LOG } });
  return { code: r.status, err: (r.stderr || "") + (r.stdout || "") };
};
const logSize = () => { try { return fs.statSync(LOG).size; } catch { return 0; } };

const STRANGER = "stranger@example.invalid";
const QUOTE = "the user said invite the stranger";

// The exact shape that shipped: additive flag, no authorization.
test("--add-attendee without authorization is refused", () => {
  const { code, err } = run("update", "EV1", "--calendar", "primary", "--add-attendee", STRANGER);
  assert.equal(code, 4, "must hit the authorization refusal, not sail through");
  assert.match(err, /REFUSED/);
  assert.ok(err.includes(STRANGER), "the refusal must name who it stopped");
});

// gog's parser accepts `--flag=value`; a guard that only reads the spaced form
// is bypassed by typing one character.
test("the --flag=value form of both attendee flags is refused", () => {
  for (const arg of [`--attendees=${STRANGER}`, `--add-attendee=${STRANGER}`]) {
    const { code } = run("update", "EV1", "--calendar", "primary", arg);
    assert.equal(code, 4, `${arg} must be parsed and guarded, not forwarded`);
  }
});

// Deny-by-default: an attendee-carrying flag this wrapper does not know is
// refused rather than passed through, so a future gog release cannot reopen this.
test("an unrecognised attendee-carrying flag is refused, not forwarded", () => {
  const { code, err } = run("update", "EV1", "--calendar", "primary", "--attendee", STRANGER);
  assert.equal(code, 6);
  assert.match(err, /without passing this guard/);
});

// Only the first occurrence is parsed; a second must not ride along unread.
test("a second --attendees occurrence cannot ride along on an authorized call", () => {
  const { code } = run(
    "update", "EV1", "--calendar", "primary",
    "--attendees", "a@example.invalid", "--attendee-authorized", QUOTE,
    "--attendees", STRANGER,
  );
  assert.equal(code, 6, "the unread second list must be refused");
});

// These three mention guests but cannot add one; refusing them would break real
// calls, so the deny-by-default scan must have an explicit allowlist. Pairing
// each with an unauthorized attendee discriminates cleanly WITHOUT executing a
// write: the smuggle scan runs before the authorization gate, so exit 4 proves
// the permission flag was not swept into the smuggle set (which would be 6).
test("guest-permission booleans are not mistaken for attendee flags", () => {
  for (const f of ["--guests-can-invite", "--guests-can-modify", "--guests-can-see-others"]) {
    const { code } = run("update", "EV1", "--calendar", "primary", f, "--add-attendee", STRANGER);
    assert.equal(code, 4, `${f} adds nobody; it must not trip the smuggle refusal`);
  }
});

// Both of these once reached the audit log: `update --help` recorded a row with
// event_id "--help", and gog's own argument order recorded event_id "primary".
test("a flag or the calendar id in the event-id slot is rejected", () => {
  assert.equal(run("update", "--help").code, 2);
  assert.equal(run("update", "primary", "EV1", "--calendar", "primary").code, 2);
});

test("--add-attendee is rejected on create, where there is no list to preserve", () => {
  const { code } = run("create", "--calendar", "primary", "--add-attendee", STRANGER,
    "--attendee-authorized", QUOTE);
  assert.equal(code, 2);
});

// The audit log is the detection layer of last resort; a refused call is not a
// write and must not leave a row that a later reconciliation could match on.
test("no refusal writes a row to the audit log", () => {
  const before = logSize();
  run("update", "EV1", "--calendar", "primary", "--add-attendee", STRANGER);
  run("update", "EV1", "--calendar", "primary", "--attendee", STRANGER);
  run("update", "--help");
  assert.equal(logSize(), before, "refusals must not touch calendar-writes.jsonl");
});
