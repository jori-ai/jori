// partner-invite-ask — a restaurant reservation asks the user before inviting
// the partner. Pure parts of the lib, plus the CLI's answer path against stub
// jori-calendar / jori-send-curl binaries. Synthetic partner in a temp local dir.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "partner-invite-ask-"));
const LOCAL = path.join(tmp, "local");
fs.mkdirSync(path.join(LOCAL, "config"), { recursive: true });
fs.writeFileSync(path.join(LOCAL, "config", "partner-invite.json"), JSON.stringify({
  partner_name: "Robin", invite_email: "robin@example.com", partner_emails: ["robin@example.com"],
}));
process.env.JORI_LOCAL_DIR = LOCAL;
process.env.JORI_OWNER_NAME = "Alex";
process.env.PARTNER_INVITE_ASKS_FILE = path.join(tmp, "asks.json");
const L = await import("../lib/partner-invite-ask.mjs");

const NOW = Date.parse("2026-10-22T12:00:00Z");
const START = "2026-11-06T20:00:00-05:00";
const TZ = "America/Chicago"; // the reservation's own zone; 7:00 PM there

test("the question names the partner, the restaurant and the local day/time, with yes/no buttons of our own", () => {
  const b = L.buildAsk({ eventId: "ev1", title: "Trattoria Uno", start: START, tz: TZ, promptId: "p", now: NOW });
  assert.equal(b.question, "Invite Robin to Trattoria Uno, Fri, Nov 6, 7:00 PM?");
  assert.equal(b.choices.kind, "partner_invite");
  assert.equal(b.choices.ref, "ev1");
  assert.deepEqual(b.choices.options.map((o) => o.label), ["Yes, invite Robin", "No, just me"]);
  assert.deepEqual(b.choices.options.map((o) => o.value), ["yes", "no"]);
  assert.equal(b.choices.expires_at, new Date(START).toISOString());
});

test("one ask per event, never for a reservation already started, never with no partner", () => {
  const state = { asks: [] };
  assert.equal(L.canAsk({ eventId: "ev1", start: START, state, now: NOW }).ok, true);
  L.recordAsk({ eventId: "ev1", title: "Trattoria Uno", start: START, when: "x", state, now: NOW });
  assert.equal(L.canAsk({ eventId: "ev1", start: START, state, now: NOW }).ok, false);
  assert.equal(L.canAsk({ eventId: "ev2", start: "2026-10-01T20:00:00Z", state, now: NOW }).ok, false);
  const off = { ...L.config(), invite_email: "" };
  assert.equal(L.canAsk({ eventId: "ev3", start: START, state, now: NOW, cfg: off }).ok, false);
});

test("yes plans an invite quoting the user's answer to that exact question; no and repeats do not", () => {
  const state = { asks: [] };
  L.recordAsk({ eventId: "ev1", title: "Trattoria Uno", start: START, when: "Fri, Nov 6, 8:00 PM", state, now: NOW });
  const yes = L.planAnswer({ ref: "ev1", answer: "yes", state, now: NOW });
  assert.equal(yes.invite, true);
  assert.match(yes.authorization, /^Alex answered "Yes, invite Robin" \(tapped\) to "Invite Robin to Trattoria Uno, Fri, Nov 6, 8:00 PM\?"/);
  assert.ok(yes.authorization.length >= 12);
  const typed = L.planAnswer({ ref: "ev1", answer: "yes", words: "sure, invite them", state, now: NOW });
  assert.match(typed.authorization, /"sure, invite them"/);
  assert.equal(L.planAnswer({ ref: "ev1", answer: "no", state, now: NOW }).invite, false);
  assert.equal(L.planAnswer({ ref: "nope", answer: "yes", state, now: NOW }).ok, false);
  L.markAnswered({ ref: "ev1", answer: "no", state, now: NOW });
  const again = L.planAnswer({ ref: "ev1", answer: "yes", state, now: NOW });
  assert.equal(again.already, true);
  assert.equal(again.invite, false);
});

test("an unanswered ask is the newest open one only inside the window; silence never invites", () => {
  const state = { asks: [] };
  L.recordAsk({ eventId: "old", title: "A", start: START, when: "x", state, now: NOW - 100 * 3600e3 });
  assert.equal(L.latestOpenAsk({ state, now: NOW }), null);
  L.recordAsk({ eventId: "new", title: "B", start: START, when: "x", state, now: NOW - 3600e3 });
  assert.equal(L.latestOpenAsk({ state, now: NOW }).ref, "new");
  assert.equal(state.asks.every((a) => !a.invited_at), true);
});

test("CLI: yes adds the partner through jori-calendar with the quote; no leaves the event alone", () => {
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const calLog = path.join(tmp, "cal.log");
  fs.writeFileSync(path.join(bin, "jori-calendar"), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${calLog}\n`, { mode: 0o755 });
  const asks = path.join(tmp, "cli-asks.json");
  const future = new Date(Date.now() + 7 * 86400e3).toISOString();
  fs.writeFileSync(asks, JSON.stringify({ asks: [
    { ref: "evY", event_id: "evY", calendar: "primary", title: "Trattoria Uno", start: future, when: "soon", asked_at: new Date().toISOString(), status: "asked" },
    { ref: "evN", event_id: "evN", calendar: "primary", title: "Bistro Due", start: future, when: "soon", asked_at: new Date().toISOString(), status: "asked" },
  ] }));
  const env = { ...process.env, PARTNER_INVITE_ASKS_FILE: asks, PARTNER_INVITE_BIN_DIR: bin };
  const cli = path.join(here, "../bin/partner-invite-ask");
  const y = spawnSync(process.execPath, [cli, "answer", "--ref", "evY", "--yes"], { env, encoding: "utf8" });
  assert.equal(y.status, 0, y.stderr);
  assert.equal(JSON.parse(y.stdout).invited, true);
  const logged = fs.readFileSync(calLog, "utf8");
  assert.match(logged, /update\nevY\n/);
  assert.match(logged, /--add-attendee\nrobin@example\.com/);
  assert.match(logged, /--attendee-authorized\nAlex answered/);
  fs.writeFileSync(calLog, "");
  const n = spawnSync(process.execPath, [cli, "answer", "--ref", "evN", "--no"], { env, encoding: "utf8" });
  assert.equal(n.status, 0, n.stderr);
  assert.equal(fs.readFileSync(calLog, "utf8"), "");
  const saved = JSON.parse(fs.readFileSync(asks, "utf8")).asks;
  assert.deepEqual(saved.map((a) => [a.ref, a.answer, !!a.invited_at]), [["evY", "yes", true], ["evN", "no", false]]);
});

test("CLI: ask with no partner configured sends nothing (exit 5)", () => {
  const empty = fs.mkdtempSync(path.join(tmp, "empty-"));
  const env = { ...process.env, JORI_LOCAL_DIR: empty, PARTNER_INVITE_ASKS_FILE: path.join(tmp, "none.json"), PARTNER_INVITE_BIN_DIR: path.join(tmp, "nobin") };
  const r = spawnSync(process.execPath, [path.join(here, "../bin/partner-invite-ask"), "ask", "--event-id", "e", "--title", "T", "--start", new Date(Date.now() + 86400e3).toISOString()], { env, encoding: "utf8" });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /no partner configured/);
});
