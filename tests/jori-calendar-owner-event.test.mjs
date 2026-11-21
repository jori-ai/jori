// Events the user created (and, at the end, departures: --transit). Jori may change anything
// (time, name, details) only when the new details come from a confirmation
// email for the same booking (--from-confirmation <gmail messageId>);
// otherwise it may only ADD details. Events Jori created are stamped
// jori_created=1 on create (gandalf_created=1 before 2026-11-05) and stay
// freely editable. Fake gog only.
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
const JORIS = { ...USERS, extendedProperties: { private: { jori_created: "1" } } };
const JORIS_LEGACY = { ...USERS, extendedProperties: { private: { gandalf_created: "1" } } };

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

test("events stamped before 2026-11-05 (gandalf_created) are still Jori's", () => {
  assert.equal(run(["update", "EV1", "--calendar", "primary", ...T], JORIS_LEGACY).code, 0);
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
  assert.equal(r.write[i + 1], "jori_created=1");
});

// ── Departures (--transit / --transit-source) ───────────────────────────────
// A departure time with no timetable behind it is saved, marked unverified (a
// private stamp plus a line in its notes), so the hum never counts down to it;
// a source marks it verified. The departure stamps go on the user's own events
// too, so they must never make one look like Jori's.
const priv = (w) => {
  const out = {};
  w.forEach((t, i) => { if (w[i - 1] === "--private-prop") { const [k, ...v] = t.split("="); out[k] = v.join("="); } });
  return out;
};
const desc = (w) => (w.includes("--description") ? w[w.indexOf("--description") + 1] : undefined);
const lastRow = () => JSON.parse(fs.readFileSync(LOG, "utf8").trim().split("\n").pop());
const CREATE_FERRY = ["create", "--calendar", "primary", "--summary", "Ferry to Island", ...T];
const NOTE = desc(run([...CREATE_FERRY, "--transit"]).write);

test("a departure with no source is saved, marked unverified, never refused", () => {
  const r = run([...CREATE_FERRY, "--transit"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /NOT verified/);
  const p = priv(r.write);
  assert.equal(p.jori_created, "1");
  assert.equal(p.jori_transit, "1");
  assert.equal(p.jori_transit_verified, "0");
  assert.equal(p.jori_transit_source, undefined);
  assert.match(NOTE, /hasn't been checked against a timetable/);
  assert.equal(lastRow().transit_verified, false);
  const r2 = run([...CREATE_FERRY, "--transit", "--description", "Pier 3"]);
  assert.equal(desc(r2.write), `Pier 3\n\n${NOTE}`, "the note goes under the caller's own notes");
});

test("a departure with a source is verified; the source is stored whole, escaped for gog's list syntax", () => {
  const src = "https://ferry.example/timetable?route=5,6";
  const r = run([...CREATE_FERRY, "--transit", "--transit-source", src]);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /NOT verified/);
  const p = priv(r.write);
  assert.equal(p.jori_transit, "1");
  assert.equal(p.jori_transit_verified, "1");
  assert.equal(p.jori_transit_source, "https://ferry.example/timetable?route%3D5%2C6");
  assert.equal(decodeURIComponent(p.jori_transit_source), src);
  assert.equal(desc(r.write), undefined, "a verified departure gets no note");
  assert.equal(lastRow().transit_source, src);
  // --transit-source alone implies --transit.
  assert.equal(priv(run([...CREATE_FERRY, "--transit-source=Booking ABC123"]).write).jori_transit_verified, "1");
});

test("a malformed source is refused before anything is written; delete takes neither flag", () => {
  for (const args of [[...CREATE_FERRY, "--transit-source", "ok"], [...CREATE_FERRY, "--transit-source", "--location", "Pier 3"],
    ["delete", "EV1", "--calendar", "primary", "--transit"]]) {
    const r = run(args);
    assert.equal(r.code, 2, r.err);
    assert.equal(r.write, undefined);
  }
});

test("an event that is not a departure is written exactly as before", () => {
  const r = run(["update", "EV1", "--calendar", "primary", ...T], JORIS);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(Object.keys(priv(r.write)), []);
  assert.equal(desc(r.write), undefined);
  assert.equal(lastRow().transit_verified, null);
  const c = run(["create", "--calendar", "primary", "--summary", "Show", ...T]);
  assert.deepEqual(Object.keys(priv(c.write)), ["jori_created"]);
  assert.equal(desc(c.write), undefined);
});

const FERRY_VERIFIED = { ...JORIS, summary: "Ferry to Island", description: "Pier 3",
  extendedProperties: { private: { jori_created: "1", jori_transit: "1", jori_transit_verified: "1", jori_transit_source: "https://ferry.example/t" } } };
const FERRY_UNVERIFIED = { ...JORIS, summary: "Ferry to Island", description: `Pier 3\n\n${NOTE}`,
  extendedProperties: { private: { jori_created: "1", jori_transit: "1", jori_transit_verified: "0" } } };

test("moving a departure's time without a source makes it unverified again", () => {
  const r = run(["update", "EV1", "--calendar", "primary", ...T], FERRY_VERIFIED);
  assert.equal(r.code, 0, r.err);
  assert.equal(priv(r.write).jori_transit_verified, "0");
  assert.equal(desc(r.write), `Pier 3\n\n${NOTE}`);
});

test("a source on update verifies the departure and takes the note out", () => {
  const r = run(["update", "EV1", "--calendar", "primary", "--transit-source", "Operator timetable page"], FERRY_UNVERIFIED);
  assert.equal(r.code, 0, r.err);
  assert.equal(priv(r.write).jori_transit_verified, "1");
  assert.equal(desc(r.write), "Pier 3");
});

test("a confirmation email that sets the time counts as the departure's source", () => {
  const r = run(["update", "EV1", "--calendar", "primary", "--from-confirmation", "test-confirmation-id", ...T], FERRY_UNVERIFIED);
  assert.equal(r.code, 0, r.err);
  const p = priv(r.write);
  assert.equal(p.jori_transit_verified, "1");
  assert.equal(p.jori_transit_source, "confirmation email test-confirmation-id");
  assert.equal(desc(r.write), "Pier 3");
});

test("an update that neither moves the time nor gives a source leaves the verification alone", () => {
  const loc = run(["update", "EV1", "--calendar", "primary", "--location", "Pier 3"], FERRY_VERIFIED);
  assert.equal(loc.code, 0, loc.err);
  assert.deepEqual(Object.keys(priv(loc.write)), []);
  const again = run(["update", "EV1", "--calendar", "primary", "--transit"], FERRY_VERIFIED);
  assert.equal(again.code, 0, again.err);
  assert.equal(priv(again.write).jori_transit_verified, undefined, "a verified departure is not downgraded by re-declaring it");
  assert.equal(desc(again.write), undefined);
});

test("the user's own event: marking it a departure is additive, and the stamp never makes it Jori's", () => {
  const r = run(["update", "EV1", "--calendar", "primary", "--transit"], USERS);
  assert.equal(r.code, 0, r.err);
  assert.equal(priv(r.write).jori_transit_verified, "0");
  assert.equal(desc(r.write), `the user's notes\n\n${NOTE}`, "their notes stay, the mark goes underneath");
  const stampedUsers = { ...USERS, extendedProperties: { private: { jori_transit: "1", jori_transit_verified: "0", jori_transit_source: "x-source" } } };
  const move = run(["update", "EV1", "--calendar", "primary", ...T], stampedUsers);
  assert.equal(move.code, 8, move.err);
  assert.match(move.err, /an event the user made/);
});

test("a create from a booking confirmation email counts as the departure's source", () => {
  const r = run([...CREATE_FERRY, "--transit", "--from-confirmation", "test-confirmation-id"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(priv(r.write).jori_transit_verified, "1");
  assert.equal(desc(r.write), undefined);
});
