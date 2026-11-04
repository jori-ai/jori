// meetings.test.mjs — recurring meetings as configuration (lib/meetings.mjs) and
// how one is recognised on the calendar (lib/meeting-event.mjs).
// A synthetic meeting; no calendar, no network.
//
// Run: node --test tests/meetings.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { meetings, meeting, shellEnv, knownSeriesId } = await import(path.join(ROOT, "lib/meetings.mjs"));
const { isMeetingEvent } = await import(path.join(ROOT, "lib/meeting-event.mjs"));
const { pickMeeting } = await import(path.join(ROOT, "bin/meeting-calendar-check"));

const CONFIG = { meetings: [
  { id: "coach", name: "Sam", zoom: { room_id: "123 456 7890", participant: { emails: [" Sam@Example.org "], names: ["Sam Lee"] } } },
  { id: "board-sync", name: "Board", calendar_match: ["board", "directors"], notes_file: "/abs/notes.md" },
  { name: "no id: ignored" },
] };

test("each meeting resolves with defaults; an entry without an id is ignored", () => {
  const [a, b, ...rest] = meetings({ config: CONFIG });
  assert.equal(rest.length, 0);
  assert.equal(a.room_id, "1234567890");
  assert.deepEqual(a.zoom.participant.emails, ["sam@example.org"]);
  assert.deepEqual(a.calendar_match, ["sam"]);
  assert.equal(a.cron_tag, "# MEETING_REMINDER_COACH");
  assert.equal(a.checklist_kind, "meeting_agenda:coach");
  assert.ok(a.paths.notes.endsWith(path.join("data", "meetings", "coach", "notes.md")));
  assert.ok(path.isAbsolute(a.paths.state));
  assert.equal(b.cron_tag, "# MEETING_REMINDER_BOARD_SYNC");
  assert.equal(b.paths.notes, "/abs/notes.md");
  assert.deepEqual(b.calendar_match, ["board", "directors"]);
  assert.ok(a.tz, "a zone always resolves (the installation's, else the host's)");
});

test("no config at all: the module is off, and the shell view says so", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "meetings-off-"));
  const r = spawnSync(process.execPath, [path.join(ROOT, "lib/meetings.mjs"), "env"], { encoding: "utf8", env: { ...process.env, JORI_LOCAL_DIR: empty, MEETING_ID: "" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "MEETING_OK=0\n");
  assert.deepEqual(meetings({ config: { meetings: [] } }), []);
  assert.equal(meeting("nope", { config: CONFIG }), null);
  assert.equal(meeting(null, { config: CONFIG }).id, "coach");
  assert.equal(knownSeriesId(null), null);
});

test("the shell view quotes every value and names the generic reminder's meeting", () => {
  const m = meetings({ config: { meetings: [{ id: "x", name: "O'Brien" }] } })[0];
  const env = shellEnv(m);
  assert.ok(env.includes("MEETING_NAME='O'\\''Brien'"), env);
  assert.ok(env.includes("MEETING_REMINDER_ARGS='--meeting x'"));
  const own = shellEnv(meetings({ config: { meetings: [{ id: "x", reminder_bin: "bin/x-remind" }] } })[0]);
  assert.ok(own.includes("MEETING_REMINDER_ARGS=''"));
  const out = spawnSync("bash", ["-c", `eval "$1"; printf '%s|%s' "$MEETING_NAME" "$MEETING_OK"`, "_", env], { encoding: "utf8" });
  assert.equal(out.stdout, "O'Brien|1");
});

test("the event: the stored series id first, then a configured word as a whole token of title, attendee name or mailbox", () => {
  const m = meetings({ config: CONFIG })[0];
  assert.ok(isMeetingEvent({ summary: "Weekly", recurringEventId: "S1" }, m, "S1"));
  assert.ok(isMeetingEvent({ id: "S1_20261020T200000Z", summary: "renamed" }, m, "S1"));
  assert.ok(isMeetingEvent({ summary: "Sam <> Ann" }, m));
  assert.ok(isMeetingEvent({ summary: "1:1", attendees: [{ email: "sam.lee@example.org" }] }, m));
  assert.ok(isMeetingEvent({ summary: "1:1", attendees: [{ email: "x@example.org", displayName: "Sam Lee" }] }, m));
  assert.ok(!isMeetingEvent({ summary: "Samantha's party" }, m), "a token, not a substring");
  assert.ok(!isMeetingEvent({ summary: "Dentist" }, m));
  assert.ok(!isMeetingEvent(null, m));
});

test("the morning check picks the day's first live instance", () => {
  const m = meetings({ config: CONFIG })[0];
  const ev = (id, start, extra = {}) => ({ id, summary: "Sam <> Ann", start: { dateTime: start }, ...extra });
  const got = pickMeeting([ev("late", "2026-10-20T20:00:00Z"), ev("gone", "2026-10-20T10:00:00Z", { status: "cancelled" }),
    ev("early", "2026-10-20T15:00:00Z"), { id: "allday", summary: "Sam", start: { date: "2026-10-20" } }], m, null);
  assert.equal(got.id, "early");
  assert.equal(pickMeeting([], m, null), null);
});
