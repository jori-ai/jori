// Events the user created. Jori may change anything
// (time, name, details) only when the new details come from a confirmation
// email for the same booking (--from-confirmation <gmail messageId>);
// otherwise it may only ADD details. Events Jori created are stamped
// gandalf_created=1 on create and stay freely editable. Fake gog only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = process.env.JORI_CALENDAR_BIN || path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin/jori-calendar");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "jori-calendar-owner-"));
const LOG = path.join(TMP, "calendar-writes.jsonl");
const CALLS = path.join(TMP, "calls.jsonl");
const FAKE = path.join(TMP, "gog.mjs");
fs.writeFileSync(FAKE, [
  "#!/usr/bin/env node",
  'import fs from "node:fs";',
  "const a = process.argv.slice(2);",
  "fs.appendFileSync(process.env.CALLS, JSON.stringify(a) + '\\n');",
  'if (a[1] === "event") { if (!process.env.EVENT) process.exit(1); process.stdout.write(fs.readFileSync(process.env.EVENT, "utf8")); process.exit(0); }',
  'if (a[1] === "events") { process.stdout.write(JSON.stringify({ items: [] })); process.exit(0); }',
  "process.exit(0);",
].join("\n"));
fs.chmodSync(FAKE, 0o755);

function eventFile(ev) {
  const f = path.join(TMP, `ev-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(ev));
  return f;
}
const USERS = { id: "EV1", summary: "Dinner", organizer: { email: "owner@example.com", self: true }, description: "the user's notes", location: "" };
const JORIS = { ...USERS, extendedProperties: { private: { gandalf_created: "1" } } };

function run(args, ev) {
  fs.writeFileSync(CALLS, "");
  const r = spawnSync(BIN, args, {
    encoding: "utf8",
    env: { ...process.env, JORI_OWNER_EMAIL: "owner@example.com", JORI_CALENDAR_GOG_BIN: FAKE, JORI_CALENDAR_LOG_FILE: LOG, CALLS, ...(ev ? { EVENT: eventFile(ev) } : {}) },
  });
  const calls = fs.readFileSync(CALLS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { code: r.status, err: r.stderr || "", write: calls.find((c) => c[1] === "update" || c[1] === "create") };
}
const T = ["--from", "2026-11-01T20:00:00-04:00", "--to", "2026-11-01T21:15:00-04:00"];

test("moving or renaming the user's own event without a confirmation email is refused", () => {
  for (const extra of [T, ["--summary", "Dinner at Example Bistro"]]) {
    const r = run(["update", "EV1", "--calendar", "primary", ...extra], USERS);
    assert.equal(r.code, 8, r.err);
    assert.match(r.err, /an event the user made/);
    assert.equal(r.write, undefined);
  }
});

test("with --from-confirmation <messageId> anything may change", () => {
  const r = run(["update", "EV1", "--calendar", "primary", "--from-confirmation", "test-confirmation-id", "--summary", "Dinner at Example Bistro", ...T], USERS);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.write.includes("--summary"));
  const row = JSON.parse(fs.readFileSync(LOG, "utf8").trim().split("\n").pop());
  assert.equal(row.from_confirmation, "test-confirmation-id");
});

test("a malformed confirmation id is refused", () => {
  assert.equal(run(["update", "EV1", "--calendar", "primary", "--from-confirmation", "yes", ...T], USERS).code, 2);
});

test("adding details is allowed: notes are appended to the user's, a location only where there is none", () => {
  const r = run(["update", "EV1", "--calendar", "primary", "--description", "Tickets: https://x.example/t", "--location", "Example Bistro"], USERS);
  assert.equal(r.code, 0, r.err);
  const d = r.write[r.write.indexOf("--description") + 1];
  assert.equal(d, "the user's notes\n\nTickets: https://x.example/t");
  const r2 = run(["update", "EV1", "--calendar", "primary", "--location", "Elsewhere"], { ...USERS, location: "Example Bistro" });
  assert.equal(r2.code, 8);
  assert.match(r2.err, /replaces the location/);
});

test("events Jori created stay freely editable", () => {
  assert.equal(run(["update", "EV1", "--calendar", "primary", ...T], JORIS).code, 0);
});

test("pre-stamp Jori events: a private property or a job's own-id claim counts as Jori's", () => {
  assert.equal(run(["update", "EV1", "--calendar", "primary", ...T], { ...USERS, extendedProperties: { private: { phStay: "k1" } } }).code, 0);
  const r = run(["update", "EV1", "--calendar", "primary", "--jori-event", "demo-job", ...T], USERS);
  assert.equal(r.code, 0, r.err);
  const row = JSON.parse(fs.readFileSync(LOG, "utf8").trim().split("\n").pop());
  assert.equal(row.jori_event_claim, "demo-job");
});

test("if the event cannot be read, a restricted change fails closed", () => {
  assert.equal(run(["update", "EV1", "--calendar", "primary", ...T]).code, 8);
  assert.equal(run(["update", "EV1", "--calendar", "primary", "--description", "x"]).code, 8);
});

test("every create is stamped as Jori's", () => {
  const r = run(["create", "--calendar", "primary", "--summary", "Show", ...T]);
  assert.equal(r.code, 0, r.err);
  const i = r.write.indexOf("--private-prop");
  assert.ok(i > 0);
  assert.equal(r.write[i + 1], "gandalf_created=1");
});
