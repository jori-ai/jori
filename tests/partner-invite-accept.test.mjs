// partner-invite-accept — the user's rule "accept all my partner's invites".
// Accepts only the partner's invitations that still wait for the user's
// answer; never overrides an answer the user gave, never touches anyone
// else's invite. Off with no partner configured. Runs against a fake gog.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin/partner-invite-accept");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "partner-invite-accept-"));
const LOCAL = path.join(TMP, "local");
fs.mkdirSync(path.join(LOCAL, "config"), { recursive: true });
fs.writeFileSync(path.join(LOCAL, "config", "partner-invite.json"), JSON.stringify({
  partner_name: "Robin", invite_email: "robin@example.com", partner_emails: ["robin@example.com", "robin.alt@example.net"],
}));
const EMPTY_LOCAL = path.join(TMP, "empty-local");
fs.mkdirSync(EMPTY_LOCAL, { recursive: true });
const CALLS = path.join(TMP, "calls.jsonl");
const FAKE = path.join(TMP, "gog.mjs");
fs.writeFileSync(FAKE, [
  "#!/usr/bin/env node",
  'import fs from "node:fs";',
  "const a = process.argv.slice(2);",
  "fs.appendFileSync(process.env.CALLS, JSON.stringify(a) + '\\n');",
  'if (a[1] === "events") { if (process.env.FAIL) process.exit(1); process.stdout.write(fs.readFileSync(process.env.EVENTS, "utf8")); process.exit(0); }',
  "process.exit(0);",
].join("\n"));
fs.chmodSync(FAKE, 0o755);

const me = (status) => ({ email: "owner@example.com", self: true, responseStatus: status });
const ev = (id, organizer, status, extra = {}) => ({ id, summary: `e${id}`, organizer: { email: organizer }, attendees: [{ email: organizer, organizer: true }, me(status)], start: { dateTime: "2026-11-01T19:00:00-04:00" }, ...extra });

function run(items, extraEnv = {}) {
  fs.writeFileSync(CALLS, "");
  const events = path.join(TMP, "events.json");
  fs.writeFileSync(events, JSON.stringify({ items }));
  const r = spawnSync(process.execPath, [BIN, "--json"], {
    encoding: "utf8",
    env: { ...process.env, JORI_LOCAL_DIR: LOCAL, JORI_OWNER_EMAIL: "owner@example.com", PARTNER_INVITE_ACCEPT_GOG_BIN: FAKE, PARTNER_INVITE_ACCEPT_LOG: path.join(TMP, "log.jsonl"), CALLS, EVENTS: events, ...extraEnv },
  });
  const calls = fs.readFileSync(CALLS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout || "{}") : null, calls, responds: calls.filter((c) => c[1] === "respond") };
}

test("accepts the partner's waiting invites, a series once, and nothing else", () => {
  const r = run([
    ev("a", "robin@example.com", "needsAction"),
    ev("b", "Robin@Example.com", "accepted"),
    ev("c", "robin@example.com", "declined"),
    ev("d", "robin@example.com", "tentative"),
    ev("e", "colleague@example.org", "needsAction"),
    ev("f1", "robin.alt@example.net", "needsAction", { recurringEventId: "f" }),
    ev("f2", "robin.alt@example.net", "needsAction", { recurringEventId: "f" }),
    ev("g", "robin@example.com", "needsAction", { status: "cancelled" }),
  ]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.responds.map((c) => c[3]).sort(), ["a", "f"]);
  for (const c of r.responds) assert.deepEqual(c.slice(4, 6), ["--status", "accepted"]);
  assert.equal(r.out.accepted, 2);
});

test("a calendar read failure exits 1 so the intake falls back to normal triage", () => {
  const r = run([], { FAIL: "1" });
  assert.equal(r.code, 1);
  assert.equal(r.responds.length, 0);
});

test("no partner configured: off — the calendar is not even read", () => {
  const r = run([ev("a", "robin@example.com", "needsAction")], { JORI_LOCAL_DIR: EMPTY_LOCAL });
  assert.equal(r.code, 0);
  assert.equal(r.out.configured, false);
  assert.equal(r.calls.length, 0);
});
