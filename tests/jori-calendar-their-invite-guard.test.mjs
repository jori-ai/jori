// bin/jori-calendar refuses to send our invite when the invitees already sent
// one for that meeting (exit 10), and bin/calendar-their-invite takes ours off
// when theirs arrives after it. The user's rule, 2026-11-27: "if someone
// already sent me an invite ... there's no need to send our own invite. we
// should just use theirs." gog, jori-calendar (for the sweep) and the sender
// are fakes; nothing here touches a real calendar.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin/jori-calendar");
const SWEEP = path.join(ROOT, "bin/calendar-their-invite");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "their-invite-"));
const LOG = path.join(TMP, "calendar-writes.jsonl");
const CALLS = path.join(TMP, "calls.jsonl");

const FAKE_GOG = path.join(TMP, "fake-gog.mjs");
fs.writeFileSync(FAKE_GOG, `#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
const items = process.env.GOG_FAKE_EVENTS_FILE ? JSON.parse(fs.readFileSync(process.env.GOG_FAKE_EVENTS_FILE, "utf8")).items : [];
if (argv[0] === "calendar" && argv[1] === "events") { process.stdout.write(JSON.stringify({ items })); process.exit(0); }
if (argv[0] === "calendar" && argv[1] === "event") { const ev = items.find((e) => e.id === argv[3]); if (!ev) process.exit(1); process.stdout.write(JSON.stringify(ev)); process.exit(0); }
process.exit(0);
`);
fs.chmodSync(FAKE_GOG, 0o755);
const RECORDER = path.join(TMP, "recorder.mjs");
fs.writeFileSync(RECORDER, `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ bin: process.env.REC_NAME, argv: process.argv.slice(2) }) + "\\n");
`);
fs.chmodSync(RECORDER, 0o755);
const wrap = (name) => { const p = path.join(TMP, name); fs.writeFileSync(p, `#!/bin/sh\nREC_NAME=${name} exec node ${RECORDER} "$@"\n`); fs.chmodSync(p, 0o755); return p; };
const FAKE_CAL = wrap("jori-calendar");
const FAKE_SEND = wrap("jori-send-curl");

const OWNER = "owner@example.com";
const fixture = (items) => { const fp = path.join(TMP, `ev-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(fp, JSON.stringify({ items })); return fp; };
const env = (extra) => ({ ...process.env, JORI_CALENDAR_GOG_BIN: FAKE_GOG, JORI_CALENDAR_LOG_FILE: LOG, JORI_OWNER_EMAIL: OWNER, ...extra });
const run = (args, extra = {}) => { const r = spawnSync(BIN, args, { encoding: "utf8", env: env(extra) }); return { code: r.status, err: (r.stderr || "") + (r.stdout || "") }; };

const SLOT = ["--from", "2026-12-10T11:00:00-05:00", "--to", "2026-12-10T12:00:00-05:00"];
const AUTH = ["--attendee-authorized", "invite them to tour the apartments in person"];
const THEIRS = {
  id: "THEIRS", summary: "onsite with the owner", status: "confirmed",
  organizer: { email: "pat@builder.test", displayName: "Pat P" },
  attendees: [{ email: "pat@builder.test", organizer: true }, { email: OWNER, self: true, responseStatus: "accepted" }, { email: "lee@builder.test" }],
  start: { dateTime: "2026-12-10T11:00:00-05:00", timeZone: "America/New_York" }, end: { dateTime: "2026-12-10T12:00:00-05:00" },
};
const OURS = {
  id: "OURS", summary: "Walkthrough", status: "confirmed",
  organizer: { email: OWNER, self: true },
  attendees: [{ email: "lee@builder.test" }, { email: "pat@builder.test" }],
  extendedProperties: { private: { jori_created: "1" } },
  start: { dateTime: "2026-12-10T11:00:00-05:00" }, end: { dateTime: "2026-12-10T12:00:00-05:00" },
};

test("an invite to people who already sent one for this slot is refused (exit 10)", () => {
  const { code, err } = run(["create", "--calendar", "primary", "--summary", "Walkthrough", ...SLOT,
    "--attendees", "lee@builder.test,pat@builder.test", ...AUTH], { GOG_FAKE_EVENTS_FILE: fixture([THEIRS]) });
  assert.equal(code, 10, err);
  assert.match(err, /already sent the user an invitation/);
  assert.match(err, /THEIRS/);
});

test("--overlap-ok does not wave it through", () => {
  const { code } = run(["create", "--calendar", "primary", "--summary", "Walkthrough", ...SLOT,
    "--attendees", "lee@builder.test", ...AUTH, "--overlap-ok", "a second separate event"], { GOG_FAKE_EVENTS_FILE: fixture([THEIRS]) });
  assert.equal(code, 10);
});

test("--their-invite-ok with a reason is honored and logged", () => {
  const reason = "a second, separate meeting with the same company";
  const { code, err } = run(["create", "--calendar", "primary", "--summary", "Walkthrough", ...SLOT,
    "--attendees", "lee@builder.test", ...AUTH, "--their-invite-ok", reason, "--overlap-ok", "separate meeting, see above"], { GOG_FAKE_EVENTS_FILE: fixture([THEIRS]) });
  assert.equal(code, 0, err);
  const rows = fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.at(-1).their_invite_override, reason);
});

test("an event with no guests is not affected (the overlap guard still speaks)", () => {
  const { code } = run(["create", "--calendar", "primary", "--summary", "Walkthrough", ...SLOT], { GOG_FAKE_EVENTS_FILE: fixture([THEIRS]) });
  assert.equal(code, 7);
});

test("adding a guest on update checks too", () => {
  const mine = { ...OURS, attendees: [] };
  const { code } = run(["update", "OURS", "--calendar", "primary", "--add-attendee", "lee@builder.test", ...AUTH],
    { GOG_FAKE_EVENTS_FILE: fixture([mine, THEIRS]) });
  assert.equal(code, 10);
});

test("the sweep deletes ours with a cancellation to its guests and tells the user", () => {
  try { fs.unlinkSync(CALLS); } catch {}
  const r = spawnSync(SWEEP, ["sweep"], { encoding: "utf8", env: env({
    GOG_FAKE_EVENTS_FILE: fixture([OURS, THEIRS]),
    JORI_THEIR_INVITE_CALENDAR_BIN: FAKE_CAL, JORI_THEIR_INVITE_SEND_BIN: FAKE_SEND,
    JORI_THEIR_INVITE_LOG: path.join(TMP, "sweep.jsonl"),
  }) });
  assert.equal(r.status, 0, r.stderr);
  const calls = fs.readFileSync(CALLS, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const del = calls.find((c) => c.bin === "jori-calendar");
  assert.deepEqual(del.argv, ["delete", "OURS", "--calendar", "primary", "--send-updates", "all"]);
  const sent = calls.find((c) => c.bin === "jori-send-curl");
  assert.ok(sent && sent.argv.join(" ").includes("Pat"));
});

test("the sweep dry run writes nothing", () => {
  try { fs.unlinkSync(CALLS); } catch {}
  const r = spawnSync(SWEEP, ["sweep", "--dry-run"], { encoding: "utf8", env: env({
    GOG_FAKE_EVENTS_FILE: fixture([OURS, THEIRS]), JORI_THEIR_INVITE_CALENDAR_BIN: FAKE_CAL, JORI_THEIR_INVITE_SEND_BIN: FAKE_SEND,
  }) });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /would remove/);
  assert.ok(!fs.existsSync(CALLS));
});
