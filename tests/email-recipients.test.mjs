// email-send --to me: the owner's address is filled in inside the tool, so an
// agent never types it into a command (Claude Code's built-in privacy plugin
// refuses a headless shell call that holds the signed-in account's address
// next to a network word such as https or curl).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { resolveRecipients, OWNER_ALIAS } = require("../lib/email-recipients.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test";

test("the alias is `me`", () => {
  assert.equal(OWNER_ALIAS, "me");
});

test("`me` becomes the owner's address", () => {
  assert.deepEqual(resolveRecipients("me", OWNER), { list: [OWNER] });
  assert.deepEqual(resolveRecipients(" ME ", OWNER), { list: [OWNER] });
});

test("`me` works inside a comma list, order kept", () => {
  assert.deepEqual(resolveRecipients("me,partner@example.test", OWNER), { list: [OWNER, "partner@example.test"] });
  assert.deepEqual(resolveRecipients("partner@example.test, me", OWNER), { list: ["partner@example.test", OWNER] });
});

test("plain addresses pass through unchanged", () => {
  assert.deepEqual(resolveRecipients("a@x.test,b@y.test", OWNER), { list: ["a@x.test", "b@y.test"] });
  assert.deepEqual(resolveRecipients("Some One <a@x.test>", OWNER), { list: ["Some One <a@x.test>"] });
});

test("the same address twice is sent once", () => {
  assert.deepEqual(resolveRecipients("me,Owner@Example.test", OWNER), { list: [OWNER] });
});

test("`me` with no owner address configured is an error, not a send", () => {
  const r = resolveRecipients("me", "");
  assert.ok(r.error && /owner/.test(r.error));
  assert.equal(r.list, undefined);
});

test("a word that is neither `me` nor an address is an error", () => {
  const r = resolveRecipients("owner", OWNER);
  assert.ok(r.error && r.error.includes('"owner"'));
  assert.ok(resolveRecipients("me,typo", OWNER).error);
});

test("an empty recipient is an error", () => {
  assert.ok(resolveRecipients("", OWNER).error);
  assert.ok(resolveRecipients(" , ", OWNER).error);
  assert.ok(resolveRecipients(null, OWNER).error);
});

// End to end, on the refusal path only: email-send stops while reading its
// arguments, before the speak gate, the mailbox or the mail service. No test
// here may reach a real send: the mail key is always a dummy (load-env never
// overrides a set variable), and both checks skip against an email-send that
// does not resolve recipients yet, which would otherwise try the service.
const EMAIL_SEND = path.join(ROOT, "bin", "email-send");
const RESOLVES = fs.readFileSync(EMAIL_SEND, "utf8").includes("email-recipients.cjs");
const SAFE_ENV = { ...process.env, SMTP2GO_API_KEY: "unused-in-this-test", EMAIL_SEND_VIA_PROVIDER: "1", SPEAK_GATE_EMAIL: "0" };

test("email-send refuses a recipient that is not an address, before sending", { skip: !RESOLVES && "email-send does not resolve recipients yet" }, () => {
  const r = spawnSync(process.execPath, [EMAIL_SEND, "--to", "nobody", "--subject", "t", "--body", "b"], {
    env: SAFE_ENV,
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /--to: "nobody" is not an email address/);
  assert.doesNotMatch(r.stdout, /Sent:/);
});

test("email-send --help documents `me`", { skip: !RESOLVES && "email-send does not resolve recipients yet" }, () => {
  const r = spawnSync(process.execPath, [EMAIL_SEND, "--help"], {
    env: SAFE_ENV,
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--to <addr\|me>/);
});
