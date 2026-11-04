// family-sender-add — the one guarded path that adds a family member's new
// address. The guard is the point of this file: an address that is
// not exactly a held one, or that the user never typed, must never get in.
// A stray "yes" contains no address, so it can never satisfy the second check.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareInbound } from "../lib/email-inbound-gate.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin/family-sender-add");
const NEW = "sam.second@example.com";

function sandbox({ messages = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "family-sender-add-"));
  const data = path.join(root, "data");
  fs.mkdirSync(data, { recursive: true });
  const deny = ["reference_door_codes"];
  fs.writeFileSync(path.join(data, "wiki-share-scopes.json"), JSON.stringify({
    identities: {
      "owner@example.com": { label: "Owner", unrestricted: true },
      "robin@example.com": { label: "Robin", unrestricted: false, allow_ids: ["reference_accounts"] },
      "sam@example.com": { label: "Sam", inherits: "robin@example.com", email_qa: true, email_deny_ids: deny },
      "kit@example.com": { label: "Kit", inherits: "robin@example.com", email_qa: true, email_deny_ids: deny },
    },
  }, null, 2));
  fs.writeFileSync(path.join(data, "p1-senders.json"), JSON.stringify({ senders: [{ pattern: "sam@example.com", label: "personal", reason: "family" }] }, null, 2));
  const msgFile = path.join(root, "messages.json");
  fs.writeFileSync(msgFile, JSON.stringify(messages));
  return { root, data, msgFile };
}

function hold(data, from = NEW, ts = new Date(Date.now() - 60000)) {
  return prepareInbound({ from, subject: "Properties", message_id: `<${Math.random()}@x>`, auth: { aligned: true }, envelope: { from } }, { dataDir: data, now: ts });
}

function run(sb, args) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, FAMILY_SENDER_ADD_ROOT: sb.root, FAMILY_SENDER_ADD_MESSAGES_FILE: sb.msgFile, FAMILY_SENDER_ADD_NO_SIDE_EFFECTS: "1" },
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const scopes = (sb) => JSON.parse(fs.readFileSync(path.join(sb.data, "wiki-share-scopes.json"), "utf8"));
const later = () => new Date().toISOString();

test("the user's explicit 'add <address>' adds exactly that address with Sam's own view", () => {
  const sb = sandbox({ messages: [{ role: "user", content: `add ${NEW} — that's Sam`, created_at: later() }] });
  hold(sb.data);
  const r = run(sb, [NEW, "--as", "Sam"]);
  assert.equal(r.code, 0, r.out);
  const e = scopes(sb).identities[NEW];
  assert.equal(e.label, "Sam");
  assert.equal(e.inherits, "robin@example.com");
  assert.equal(e.email_qa, true);
  assert.deepEqual(e.email_deny_ids, ["reference_door_codes"]);
  assert.ok(e.note.includes("add sam.second@example.com"), "the user's words are recorded");
  const p1 = JSON.parse(fs.readFileSync(path.join(sb.data, "p1-senders.json"), "utf8"));
  assert.ok(p1.senders.some((s) => s.pattern === NEW), "joins the P1 list like the member's other address");
  // The hold is resolved: running again is refused.
  assert.equal(run(sb, [NEW, "--as", "Sam"]).code, 3);
});

test("a stray 'yes' never counts: the user's message must contain the address", () => {
  const sb = sandbox({ messages: [{ role: "user", content: "yes", created_at: later() }, { role: "assistant", content: `add ${NEW}`, created_at: later() }] });
  hold(sb.data);
  const r = run(sb, [NEW, "--as", "Sam"]);
  assert.equal(r.code, 3);
  assert.match(r.out, /address itself has to be written/);
  assert.equal(scopes(sb).identities[NEW], undefined);
});

test("an address typed BEFORE the email was held does not count", () => {
  const sb = sandbox({ messages: [{ role: "user", content: `add ${NEW}`, created_at: new Date(Date.now() - 3600000).toISOString() }] });
  hold(sb.data);
  assert.equal(run(sb, [NEW, "--as", "Sam"]).code, 3);
});

test("the address must appear whole in the user's message, not as a prefix of another", () => {
  const sb = sandbox({ messages: [{ role: "user", content: `add ${NEW}m please`, created_at: later() }] });
  hold(sb.data);
  assert.equal(run(sb, [NEW, "--as", "Sam"]).code, 3);
});

test("only an address that is actually held can be added — not a near miss", () => {
  const sb = sandbox({ messages: [{ role: "user", content: "add sam.second@example.co", created_at: later() }] });
  hold(sb.data);
  const r = run(sb, ["sam.second@example.co", "--as", "Sam"]);
  assert.equal(r.code, 3);
  assert.match(r.out, /not holding any email/);
});

test("--as must be an existing family member with email access; never the owner or a new person", () => {
  const sb = sandbox({ messages: [{ role: "user", content: `add ${NEW}`, created_at: later() }] });
  hold(sb.data);
  assert.equal(run(sb, [NEW, "--as", "Owner"]).code, 3);
  assert.equal(run(sb, [NEW, "--as", "Stranger"]).code, 3);
  assert.equal(run(sb, [NEW, "--as", "Robin"]).code, 3);
  assert.equal(scopes(sb).identities[NEW], undefined);
});

test("--dry-run checks everything and writes nothing; dismiss adds nothing", () => {
  const sb = sandbox({ messages: [{ role: "user", content: `add ${NEW}`, created_at: later() }] });
  hold(sb.data);
  assert.equal(run(sb, [NEW, "--as", "Sam", "--dry-run"]).code, 0);
  assert.equal(scopes(sb).identities[NEW], undefined);
  assert.equal(run(sb, ["dismiss", NEW]).code, 0);
  assert.equal(run(sb, [NEW, "--as", "Sam"]).code, 3, "a dismissed hold cannot be added");
});
