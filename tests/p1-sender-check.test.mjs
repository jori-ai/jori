// p1-sender-check.test.mjs — `p1-sender check` against a synthetic allowlist.
//
// A monitor that sends its alerts from the user's own address is P1 only for
// its alert subject (only_subject_re): the recovery email, a reply to the
// alert and the user's other self-sent mail are not. Also: unless_subject_re
// carves a shape out of an always-P1 sender, a bad only-regex fails closed and
// a bad unless-regex fails open, pattern_re matches the address, and a spoofed
// display name never matches. Exit codes: 0 match, 3 no match.
//
// Run: node --test tests/p1-sender-check.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT as ROOT } from "../lib/root.cjs";

const OFFLINE = "🔴 Studio host OFFLINE — no beat for 12 min";
const BACK = "🟢 Studio host is back online (down ~7 min)";
const SELF = "Host Monitor <owner@example.com>";

const SENDERS = { senders: [
  { pattern: "owner@example.com", label: "personal", reason: "host monitor alert", only_subject_re: "^🔴 Studio host OFFLINE — no beat for \\d+ min$" },
  { pattern: "alerts@vendor.example", label: "personal", reason: "vendor alerts", unless_subject_re: "^\\s*\\[Sandbox\\]" },
  { pattern_re: "@(mail\\.)?clinic\\.example$", label: "personal", reason: "clinic" },
  { pattern: "broken-only@example.org", label: "personal", only_subject_re: "([unclosed" },
  { pattern: "broken-unless@example.org", label: "personal", unless_subject_re: "([unclosed" },
] };

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "p1-sender-"));
fs.mkdirSync(path.join(HOME, "Dev/jori/data"), { recursive: true });
fs.writeFileSync(path.join(HOME, "Dev/jori/data/p1-senders.json"), JSON.stringify(SENDERS));
process.on("exit", () => fs.rmSync(HOME, { recursive: true, force: true }));

function check(sender, subject = "") {
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin/p1-sender"), "check", "--sender", sender, "--subject", subject], {
    encoding: "utf8", env: { ...process.env, HOME },
  });
  return r.status;
}

test("the monitor's OFFLINE alert from the user's own address is P1", () => {
  assert.equal(check(SELF, OFFLINE), 0);
});

test("the recovery email, a reply to the alert and other self-sent mail are not", () => {
  assert.equal(check(SELF, BACK), 3);
  assert.equal(check(SELF, `Re: ${OFFLINE}`), 3);
  assert.equal(check(SELF, "Notes for the weekly call"), 3);
});

test("unless_subject_re carves one shape out of an always-P1 sender", () => {
  assert.equal(check("alerts@vendor.example", "Payout failed"), 0);
  assert.equal(check("alerts@vendor.example", "[Sandbox] Payout failed"), 3);
});

test("a bad only-regex fails closed; a bad unless-regex fails open", () => {
  assert.equal(check("broken-only@example.org", "anything"), 3);
  assert.equal(check("broken-unless@example.org", "anything"), 0);
});

test("pattern_re matches the address; a display name alone never matches", () => {
  assert.equal(check("Front Desk <results@mail.clinic.example>", "Your results"), 0);
  assert.equal(check("owner@example.com <someone@elsewhere.example>", OFFLINE), 3);
});
