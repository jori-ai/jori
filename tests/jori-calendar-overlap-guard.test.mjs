// Regression guard for the duplicate-lunch incident.
//
// What this defends against: `jori-calendar create` used to build and send
// a brand-new event whenever asked, with no awareness of what already sat in
// that time slot. Asked to put a lunch on the calendar, an agent found a plain
// "Lunch" placeholder already occupying that exact hour, created earlier the
// same day — and instead of amending it, created a SECOND, overlapping event.
// The correct behaviour is to amend the existing event and enhance it. Per agent/CLAUDE.md § Rule 0b
// (code owns geometry, a model owns language), the fix is a deterministic
// interval-overlap check in the wrapper itself, not a reminder in a skill.
//
// Unlike the attendee-guard test file, these cases exercise both the refusal
// AND the allow path — safe to do here because the wrapper's `gog` binary and
// audit-log path are both env-overridable for tests
// (JORI_CALENDAR_GOG_BIN, JORI_CALENDAR_LOG_FILE), so nothing here ever
// touches the real calendar, the real gog CLI, or the real
// data/logs/calendar-writes.jsonl.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = process.env.JORI_CALENDAR_BIN
  || path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin/jori-calendar");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "jori-calendar-overlap-"));
const LOG = path.join(TMP, "calendar-writes.jsonl");

// A stand-in for `gog` that never touches the network. `calendar events`
// returns the fixture named by GOG_FAKE_EVENTS_FILE (or an empty list, or a
// simulated failure via GOG_FAKE_EVENTS_FAIL); `calendar create`/`update`
// just exits 0, simulating a successful write with no real side effect.
const FAKE_GOG = path.join(TMP, "fake-gog.mjs");
fs.writeFileSync(FAKE_GOG, [
  "#!/usr/bin/env node",
  'import fs from "node:fs";',
  "const argv = process.argv.slice(2);",
  'if (argv[0] === "calendar" && argv[1] === "events") {',
  "  const fixture = process.env.GOG_FAKE_EVENTS_FILE;",
  "  if (fixture && fs.existsSync(fixture)) {",
  '    process.stdout.write(fs.readFileSync(fixture, "utf8"));',
  "    process.exit(0);",
  "  }",
  "  const fail = process.env.GOG_FAKE_EVENTS_FAIL;",
  '  if (fail === "nonzero") process.exit(1);',
  '  if (fail === "badjson") { process.stdout.write("not json"); process.exit(0); }',
  "  process.stdout.write(JSON.stringify({ items: [] }));",
  "  process.exit(0);",
  "}",
  "// calendar create / update / delete — simulate success, no real write.",
  "process.exit(0);",
  "",
].join("\n"));
fs.chmodSync(FAKE_GOG, 0o755);

function run(args, envExtra = {}) {
  const r = spawnSync(BIN, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      JORI_CALENDAR_GOG_BIN: FAKE_GOG,
      JORI_CALENDAR_LOG_FILE: LOG,
      ...envExtra,
    },
  });
  return { code: r.status, err: (r.stderr || "") + (r.stdout || "") };
}

function logSize() {
  try { return fs.statSync(LOG).size; } catch { return 0; }
}

function fixture(items) {
  const fp = path.join(TMP, `events-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(fp, JSON.stringify({ items }));
  return fp;
}

const LUNCH_SLOT = ["--from", "2026-09-29T13:00:00-04:00", "--to", "2026-09-29T14:00:00-04:00"];
const EXISTING_LUNCH = () => fixture([{
  id: "EV_LUNCH", summary: "Lunch", status: "confirmed",
  start: { dateTime: "2026-09-29T13:00:00-04:00" },
  end: { dateTime: "2026-09-29T14:00:00-04:00" },
}]);

// The exact shape of the 2026-09-25 incident: a busy event already sits in the
// requested window, and no override reason was given.
test("an overlapping opaque event refuses create without --overlap-ok", () => {
  const { code, err } = run(
    ["create", "--calendar", "primary", "--summary", "Lunch at Omar Khayyam", ...LUNCH_SLOT],
    { GOG_FAKE_EVENTS_FILE: EXISTING_LUNCH() },
  );
  assert.equal(code, 7, "must hit the overlap refusal, not silently create a duplicate");
  assert.match(err, /REFUSED/);
  assert.match(err, /Lunch/);
  assert.match(err, /EV_LUNCH/);
  assert.match(err, /jori-calendar update/);
});

test("a too-short --overlap-ok reason still refuses", () => {
  const { code } = run(
    ["create", "--calendar", "primary", "--summary", "Lunch at Omar Khayyam", ...LUNCH_SLOT, "--overlap-ok", "sure"],
    { GOG_FAKE_EVENTS_FILE: EXISTING_LUNCH() },
  );
  assert.equal(code, 7, "a shrug is not an override");
});

test("a genuine --overlap-ok reason is honored and recorded in the audit log", () => {
  const reason = "the user explicitly wants two separate concurrent holds";
  const { code } = run(
    ["create", "--calendar", "primary", "--summary", "Second lunch option", ...LUNCH_SLOT, "--overlap-ok", reason],
    { GOG_FAKE_EVENTS_FILE: EXISTING_LUNCH() },
  );
  assert.equal(code, 0);
  const rows = fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows[rows.length - 1].overlap_override, reason);
});

test("a transparent (free) existing event does not block create", () => {
  const fx = fixture([{
    id: "EV_FREE", summary: "Awareness block", status: "confirmed", transparency: "transparent",
    start: { dateTime: "2026-09-29T13:00:00-04:00" },
    end: { dateTime: "2026-09-29T14:00:00-04:00" },
  }]);
  const { code } = run(
    ["create", "--calendar", "primary", "--summary", "Lunch at Omar Khayyam", ...LUNCH_SLOT],
    { GOG_FAKE_EVENTS_FILE: fx },
  );
  assert.equal(code, 0, "a transparent existing event must not be treated as a double-booking");
});

test("a cancelled existing event does not block create", () => {
  const fx = fixture([{
    id: "EV_CANCELLED", summary: "Old lunch", status: "cancelled",
    start: { dateTime: "2026-09-29T13:00:00-04:00" },
    end: { dateTime: "2026-09-29T14:00:00-04:00" },
  }]);
  const { code } = run(
    ["create", "--calendar", "primary", "--summary", "Lunch at Omar Khayyam", ...LUNCH_SLOT],
    { GOG_FAKE_EVENTS_FILE: fx },
  );
  assert.equal(code, 0);
});

test("no existing events in the window creates cleanly", () => {
  const { code } = run(
    ["create", "--calendar", "primary", "--summary", "Standalone event", ...LUNCH_SLOT],
    { GOG_FAKE_EVENTS_FILE: fixture([]) },
  );
  assert.equal(code, 0);
});

test("the guard fails open when the events read errors", () => {
  const { code } = run(
    ["create", "--calendar", "primary", "--summary", "Lunch at Omar Khayyam", ...LUNCH_SLOT],
    { GOG_FAKE_EVENTS_FAIL: "nonzero" },
  );
  assert.equal(code, 0, "a broken read must not block every create");
});

test("the guard fails open when the events read returns unparseable output", () => {
  const { code } = run(
    ["create", "--calendar", "primary", "--summary", "Lunch at Omar Khayyam", ...LUNCH_SLOT],
    { GOG_FAKE_EVENTS_FAIL: "badjson" },
  );
  assert.equal(code, 0);
});

test("update is not subject to the overlap guard", () => {
  const { code } = run(
    // --from-confirmation: a time change on an event that may be the user's own
    // needs it since 2026-10-22 (D13, jori-calendar-owner-event.test.mjs).
    ["update", "EV_LUNCH", "--calendar", "primary", "--from-confirmation", "test-confirmation-id", ...LUNCH_SLOT],
    { GOG_FAKE_EVENTS_FILE: EXISTING_LUNCH() },
  );
  assert.equal(code, 0, "update operates on a known eventId; the overlap guard must not apply");
});

test("create without --from/--to is not touched by the overlap guard", () => {
  const { code } = run(["create", "--calendar", "primary", "--summary", "No time given"]);
  assert.equal(code, 0);
});

test("an overlap refusal does not write a row to the audit log", () => {
  const before = logSize();
  run(
    ["create", "--calendar", "primary", "--summary", "Dup", ...LUNCH_SLOT],
    { GOG_FAKE_EVENTS_FILE: EXISTING_LUNCH() },
  );
  assert.equal(logSize(), before, "refusals must not touch the audit log");
});
