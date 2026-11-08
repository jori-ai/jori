// Regression guard for a rescheduled appointment (2026-11-03).
//
// Triage put a branch appointment on the calendar six days out. The user moved
// it to the same afternoon; the provider's "details have changed" email
// carried the same confirmation number. A fresh triage session searched a
// day either side of the NEW date, missed the Nov 9 event, and created a second
// one. `--booking-ref` makes `create` look the reference up across the calendar
// and refuse, pointing at `update`. Nothing here touches the real calendar: gog
// and the audit log are env-overridden (JORI_CALENDAR_GOG_BIN / _LOG_FILE).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = process.env.JORI_CALENDAR_BIN
  || path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin/jori-calendar");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "jori-calendar-bookingref-"));
const LOG = path.join(TMP, "calendar-writes.jsonl");
const ARGS_OUT = path.join(TMP, "gog-calls.jsonl");

// Fake gog: a booking probe (--query / --private-prop-filter) returns the
// fixture; the plain window read the overlap guard makes returns nothing, so
// these cases isolate the booking guard. Every call is recorded.
const FAKE_GOG = path.join(TMP, "fake-gog.mjs");
fs.writeFileSync(FAKE_GOG, [
  "#!/usr/bin/env node",
  'import fs from "node:fs";',
  "const argv = process.argv.slice(2);",
  'fs.appendFileSync(process.env.GOG_ARGS_OUT, JSON.stringify(argv) + "\\n");',
  'if (argv[0] === "calendar" && argv[1] === "event" && process.env.GOG_FAKE_EVENT_FILE) {',
  '  process.stdout.write(fs.readFileSync(process.env.GOG_FAKE_EVENT_FILE, "utf8")); process.exit(0);',
  "}",
  'if (argv[0] === "calendar" && argv[1] === "events") {',
  '  const booking = argv.includes("--query") || argv.includes("--private-prop-filter");',
  "  const fixture = process.env.GOG_FAKE_EVENTS_FILE;",
  '  if (booking && process.env.GOG_FAKE_EVENTS_FAIL) process.exit(1);',
  "  if (booking && fixture) { process.stdout.write(fs.readFileSync(fixture, \"utf8\")); process.exit(0); }",
  "  process.stdout.write(JSON.stringify({ items: [] }));",
  "  process.exit(0);",
  "}",
  "process.exit(0);",
  "",
].join("\n"));
fs.chmodSync(FAKE_GOG, 0o755);

function run(args, envExtra = {}) {
  fs.rmSync(ARGS_OUT, { force: true });
  const r = spawnSync(BIN, args, {
    encoding: "utf8",
    env: { ...process.env, JORI_CALENDAR_GOG_BIN: FAKE_GOG, JORI_CALENDAR_LOG_FILE: LOG, GOG_ARGS_OUT: ARGS_OUT, ...envExtra },
  });
  const calls = fs.existsSync(ARGS_OUT)
    ? fs.readFileSync(ARGS_OUT, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { code: r.status, err: (r.stderr || "") + (r.stdout || ""), calls };
}

function fixture(items) {
  const fp = path.join(TMP, `events-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(fp, JSON.stringify({ items }));
  return fp;
}

const NOV9 = {
  id: "evt-original-booking",
  status: "confirmed",
  summary: "Bank branch appointment",
  description: "Confirmation #40017733. Bring two forms of valid ID.",
  start: { dateTime: "2026-11-09T11:30:00-05:00" },
  end: { dateTime: "2026-11-09T12:00:00-05:00" },
};

const CREATE_TODAY = [
  "create", "--calendar", "primary",
  "--summary", "Bank branch appointment",
  "--from", "2026-11-03T13:30:00-05:00", "--to", "2026-11-03T14:00:00-05:00",
];

test("a reschedule with the same confirmation number is refused and pointed at the existing event", () => {
  const r = run([...CREATE_TODAY, "--booking-ref", "#40017733"], { GOG_FAKE_EVENTS_FILE: fixture([NOV9]) });
  assert.equal(r.code, 9, r.err);
  assert.match(r.err, /booking 40017733 is already on/);
  assert.match(r.err, /evt-original-booking/);
  assert.match(r.err, /jori-calendar update/);
  assert.ok(!r.calls.some((c) => c[1] === "create"), "no create may reach gog");
});

test("an event stamped with the reference matches even when its text does not mention it", () => {
  const stamped = { ...NOV9, description: "", extendedProperties: { private: { jori_booking_ref: "40017733" } } };
  const r = run([...CREATE_TODAY, "--booking-ref", "40017733"], { GOG_FAKE_EVENTS_FILE: fixture([stamped]) });
  assert.equal(r.code, 9, r.err);
});

test("a longer number that merely contains the reference is not the same booking", () => {
  const other = { ...NOV9, id: "other", description: "Order 1400177339" };
  const r = run([...CREATE_TODAY, "--booking-ref", "40017733"], { GOG_FAKE_EVENTS_FILE: fixture([other]) });
  assert.equal(r.code, 0, r.err);
});

test("a cancelled event with the reference does not block a create", () => {
  const r = run([...CREATE_TODAY, "--booking-ref", "40017733"], { GOG_FAKE_EVENTS_FILE: fixture([{ ...NOV9, status: "cancelled" }]) });
  assert.equal(r.code, 0, r.err);
});

test("no match: create goes through and stamps the reference", () => {
  const r = run([...CREATE_TODAY, "--booking-ref", "40017733"], { GOG_FAKE_EVENTS_FILE: fixture([]) });
  assert.equal(r.code, 0, r.err);
  const create = r.calls.find((c) => c[1] === "create");
  assert.ok(create, "create reached gog");
  const i = create.lastIndexOf("--private-prop");
  assert.equal(create[i + 1], "jori_booking_ref=40017733");
  assert.ok(create.includes("jori_created=1"));
  const row = JSON.parse(fs.readFileSync(LOG, "utf8").trim().split("\n").pop());
  assert.equal(row.booking_ref, "40017733");
});

test("the read failing fails open", () => {
  const r = run([...CREATE_TODAY, "--booking-ref", "40017733"], { GOG_FAKE_EVENTS_FAIL: "1" });
  assert.equal(r.code, 0, r.err);
});

test("--booking-dup-ok with a reason lets a second event through", () => {
  const r = run([...CREATE_TODAY, "--booking-ref", "40017733", "--booking-dup-ok", "two separate visits under one work order"],
    { GOG_FAKE_EVENTS_FILE: fixture([NOV9]) });
  assert.equal(r.code, 0, r.err);
});

test("a malformed reference is refused", () => {
  const r = run([...CREATE_TODAY, "--booking-ref", "see email"]);
  assert.equal(r.code, 2, r.err);
});

test("update with --booking-ref stamps it and the stamp alone does not make the user's event Jori's", () => {
  const r = run(["update", "evt-original-booking", "--calendar", "primary", "--booking-ref", "40017733",
    "--from-confirmation", "msgid0000000001", "--from", "2026-11-03T13:30:00-05:00", "--to", "2026-11-03T14:00:00-05:00"]);
  assert.equal(r.code, 0, r.err);
  const upd = r.calls.find((c) => c[1] === "update");
  assert.ok(upd.includes("jori_booking_ref=40017733"));
});

test("the user's own event carrying only a booking stamp is still theirs: moving it needs the confirmation email", () => {
  const ev = { ...NOV9, organizer: { self: true }, extendedProperties: { private: { jori_booking_ref: "40017733" } } };
  const fp = path.join(TMP, "one-event.json");
  fs.writeFileSync(fp, JSON.stringify(ev));
  const r = run(["update", NOV9.id, "--calendar", "primary", "--from", "2026-11-03T13:30:00-05:00", "--to", "2026-11-03T14:00:00-05:00"],
    { GOG_FAKE_EVENT_FILE: fp });
  assert.equal(r.code, 8, r.err);
});
