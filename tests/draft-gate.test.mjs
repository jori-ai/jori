// draft-gate.test — pins the two configured draft rules (no em/en dashes to a
// third party; a configured signature token), plus the scope decision that
// keeps them off the user's own note-to-self drafts, and that a fresh install
// (no config) gates nothing.
//
// The gate is a pure module precisely so this file needs no Gmail token and no
// network; gmail-action itself runs main() on import and cannot be required.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// This test's own installation config, set before the gate first reads it.
const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "draft-gate-"));
fs.mkdirSync(path.join(LOCAL, "config"));
fs.writeFileSync(path.join(LOCAL, "config", "draft-gate.json"), JSON.stringify({ forbid_dashes: true, signature_token: "Jordan Example" }));
process.env.JORI_LOCAL_DIR = LOCAL;

const require = createRequire(import.meta.url);
const { checkDraft, parseAddressList, externalRecipients } = require("../lib/draft-gate.js");

const SELF = "user@example.com";
const THIRD_PARTY = '"Jane Doe" <jane@acme.com>';
const SIGNED_BODY = [
  "Hi Jane,",
  "",
  "Tuesday at 10am works. I'll bring the draft plan (attached).",
  "",
  "Thanks,",
  "Jordan Example",
  "Phone: (555) 010-0000",
].join("\n");

test("a clean signed third-party draft passes", () => {
  const v = checkDraft({ to: THIRD_PARTY, subject: "Unit 7", body: SIGNED_BODY, selfAddress: SELF });
  assert.equal(v.ok, true);
  assert.deepEqual(v.external, ["jane@acme.com"]);
});

test("an em dash in the body of a third-party draft is refused", () => {
  const body = SIGNED_BODY.replace("Tuesday at 10am works.", "Tuesday at 10am works — happy to move it.");
  const v = checkDraft({ to: THIRD_PARTY, subject: "Unit 7", body, selfAddress: SELF });
  assert.equal(v.ok, false);
  assert.equal(v.rule, "em-dash");
  assert.ok(v.detail.includes("—"), "detail should quote the offending span");
});

test("an en dash in the SUBJECT of a third-party draft is refused", () => {
  const v = checkDraft({ to: THIRD_PARTY, subject: "Unit 7 – next steps", body: SIGNED_BODY, selfAddress: SELF });
  assert.equal(v.ok, false);
  assert.equal(v.rule, "em-dash");
});

// The reply path carries the other party's subject forward verbatim, and third
// parties use em dashes constantly ("Re: The lease — can you come Thursday
// instead?").
test("an inherited reply subject with an em dash does NOT block the draft", () => {
  const v = checkDraft({
    to: "service@vendor.example",
    subject: "Re: The lease — can you come Thursday instead?",
    body: SIGNED_BODY,
    inheritedSubject: true,
    selfAddress: SELF,
  });
  assert.equal(v.ok, true);
});

test("an em dash in the BODY of a reply is still refused", () => {
  const v = checkDraft({
    to: "service@vendor.example",
    subject: "Re: The lease — can you come Thursday instead?",
    body: SIGNED_BODY.replace("Tuesday at 10am works.", "Thursday works — come any time."),
    inheritedSubject: true,
    selfAddress: SELF,
  });
  assert.equal(v.ok, false);
  assert.equal(v.rule, "em-dash");
});

test("an inherited subject does not waive the signature rule", () => {
  const v = checkDraft({
    to: "service@vendor.example",
    subject: "Re: The lease — can you come Thursday instead?",
    body: "Thursday works, thanks.",
    inheritedSubject: true,
    selfAddress: SELF,
  });
  assert.equal(v.ok, false);
  assert.equal(v.rule, "signature");
});

test("a plain hyphen is fine - it is what the user actually uses", () => {
  const body = SIGNED_BODY.replace("Tuesday at 10am works.", "Just to be clear - Tuesday at 10am works.");
  const v = checkDraft({ to: THIRD_PARTY, subject: "Unit 7 - next steps", body, selfAddress: SELF });
  assert.equal(v.ok, true);
});

test("an unsigned third-party draft is refused", () => {
  const v = checkDraft({
    to: THIRD_PARTY,
    subject: "Unit 7",
    body: "Hi Jane,\n\nTuesday at 10am works.\n\nThanks,",
    selfAddress: SELF,
  });
  assert.equal(v.ok, false);
  assert.equal(v.rule, "signature");
});

test("the signature match is case-insensitive and accepts the pipe variant", () => {
  const v = checkDraft({
    to: THIRD_PARTY,
    subject: "Unit 7",
    body: "Hi Jane,\n\nTuesday works.\n\njordan example | (555) 010-0000",
    selfAddress: SELF,
  });
  assert.equal(v.ok, true);
});

test("a note to self is exempt from both rules", () => {
  const v = checkDraft({
    to: SELF,
    subject: "reminder — call the contractor",
    body: "no signature here at all",
    selfAddress: SELF,
  });
  assert.equal(v.ok, true);
  assert.deepEqual(v.external, []);
});

test("self-addressing is matched case-insensitively and through a display name", () => {
  const v = checkDraft({
    to: '"Me" <User@Example.com>',
    subject: "note — to self",
    body: "unsigned",
    selfAddress: SELF,
  });
  assert.equal(v.ok, true);
});

test("a draft to self AND a third party is treated as third-party", () => {
  const v = checkDraft({
    to: `${SELF}, jane@acme.com`,
    subject: "Unit 7",
    body: "unsigned",
    selfAddress: SELF,
  });
  assert.equal(v.ok, false);
  assert.equal(v.rule, "signature");
  assert.deepEqual(v.external, ["jane@acme.com"]);
});

test("the em-dash rule is reported first when a draft breaks both", () => {
  const v = checkDraft({
    to: THIRD_PARTY,
    subject: "Unit 7 — next steps",
    body: "unsigned",
    selfAddress: SELF,
  });
  assert.equal(v.rule, "em-dash");
});

test("GMAIL_ACTION_ALLOW_DASHES waives only the dash rule", () => {
  const dashed = checkDraft({
    to: THIRD_PARTY,
    subject: "Unit 7 — next steps",
    body: SIGNED_BODY,
    selfAddress: SELF,
    allowDashes: true,
  });
  assert.equal(dashed.ok, true);

  const stillUnsigned = checkDraft({
    to: THIRD_PARTY,
    subject: "Unit 7 — next steps",
    body: "unsigned",
    selfAddress: SELF,
    allowDashes: true,
  });
  assert.equal(stillUnsigned.ok, false);
  assert.equal(stillUnsigned.rule, "signature");
});

test("GMAIL_ACTION_ALLOW_UNSIGNED waives only the signature rule", () => {
  const unsigned = checkDraft({
    to: THIRD_PARTY,
    subject: "Unit 7",
    body: "no sign-off",
    selfAddress: SELF,
    allowUnsigned: true,
  });
  assert.equal(unsigned.ok, true);

  const stillDashed = checkDraft({
    to: THIRD_PARTY,
    subject: "Unit 7 — next steps",
    body: "no sign-off",
    selfAddress: SELF,
    allowUnsigned: true,
  });
  assert.equal(stillDashed.ok, false);
  assert.equal(stillDashed.rule, "em-dash");
});

test("parseAddressList handles display names, angle brackets and bare addresses", () => {
  assert.deepEqual(
    parseAddressList('"Jane Doe" <jane@acme.com>, bob@example.com, <carol@x.io>'),
    ["jane@acme.com", "bob@example.com", "carol@x.io"]
  );
});

test("an empty or missing To yields no external recipients", () => {
  assert.deepEqual(externalRecipients("", SELF), []);
  assert.deepEqual(externalRecipients(undefined, SELF), []);
  // ...and therefore cannot be blocked by a gate that only guards third parties.
  assert.equal(checkDraft({ to: "", body: "unsigned", selfAddress: SELF }).ok, true);
});

// checkSend: the em-dash rule on gmail-action `send --from`, moved here from
// gmail-action's sendMessage so the kernel carries no writing-style rule.
const { checkSend } = require("../lib/draft-gate.js");

test("checkSend refuses an em/en dash in the subject or body, quoting it", () => {
  const v = checkSend({ subject: "Hello", body: "works — thanks" });
  assert.equal(v.ok, false);
  assert.equal(v.rule, "em-dash");
  assert.ok(v.message.startsWith("em/en dash found in subject or body"));
  assert.ok(v.message.includes(JSON.stringify("works — thanks")));
  assert.equal(checkSend({ subject: "a–b", body: "plain" }).ok, false);
});

test("checkSend passes plain text, and any text under the override", () => {
  assert.equal(checkSend({ subject: "Hello", body: "plain - hyphen only" }).ok, true);
  assert.equal(checkSend({ subject: "Hello", body: "dash — here", allowDashes: true }).ok, true);
});

test("with no rules configured (a fresh install) nothing is gated", () => {
  const v = checkDraft({ to: THIRD_PARTY, subject: "Unit 7 — next steps", body: "unsigned", selfAddress: SELF, forbidDashes: false, signatureToken: "" });
  assert.equal(v.ok, true);
  assert.equal(checkSend({ subject: "Hello", body: "dash — here", forbidDashes: false }).ok, true);
});
