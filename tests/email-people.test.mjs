// email-people.test.mjs — address parsing, role filtering, qualification and
// the wiki ## Email block.
// Run: node --test tests/email-people.test.mjs

// A made-up installation (owner and agent addresses, owner_name "the user").
import { SYNTHETIC } from "./synthetic-instance.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "email-people-"));
process.env.EMAIL_PEOPLE_DB = path.join(dir, "ep.db");

const { createRequire } = await import("node:module");
const ep = createRequire(import.meta.url)(path.resolve("lib/email-people.js"));

const SELF = [SYNTHETIC.owner_email, "owner@work.example"];
const DAY = 864e5;

function msg(id, at, { from, to = "", cc = "", sent = false, listId = null, subject = "Hi" }) {
  const headers = [
    { name: "From", value: from },
    { name: "To", value: to },
    { name: "Cc", value: cc },
    { name: "Subject", value: subject },
  ];
  if (listId) headers.push({ name: "List-Id", value: listId });
  return { id, internalDate: String(at), labelIds: sent ? ["SENT"] : ["INBOX"], snippet: `snip ${id}`, payload: { headers } };
}

after(() => {
  ep.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseAddressList handles quoted commas and bare addresses", () => {
  assert.deepEqual(ep.parseAddressList('"Levi, Dana" <DanaLevi71@example.net>, bob@x.com, Not An Address'), [
    { name: "Levi, Dana", email: "danalevi71@example.net" },
    { name: null, email: "bob@x.com" },
  ]);
});

test("role and relay addresses are not people", () => {
  for (const e of ["noreply@x.example", "support@acme.example", "info@hotel.example", "reply+abcdefghijklmnopqrstuvwxyz123@mail.x.example", "no_reply@email.vendor.example", "drive-shares-dm-noreply@docs.example", "store-news@shop.example", "cardco@welcome.cardco.example"]) {
    assert.equal(ep.isRoleAddress(e), true, e);
  }
  assert.equal(ep.isRoleAddress("abc@reply.github.com"), true); // kernel-guard-ok: a relay domain the filter names, not a mailbox
  for (const e of ["danalevi71@example.net", "omer.hadar@angels.example", "guy+notes@example.net", "ari@arbel.example", "305condosuper@example.net", "kira@kira.example"]) {
    assert.equal(ep.isRoleAddress(e), false, e);
  }
});

test("qualifies 2+ written threads, or 1 when in contacts; ignores lists, roles and inbound-only", () => {
  const t0 = Date.parse("2020-01-01");
  // Dana: two threads the user wrote in.
  ep.ingestThread({ id: "t1", messages: [msg("m1", t0, { from: `Owner <${SYNTHETIC.owner_email}>`, to: "Dana Levi <danalevi71@example.net>", sent: true })] }, { selfEmails: SELF });
  ep.ingestThread({ id: "t2", messages: [
    msg("m2", t0 + DAY, { from: "Dana Levi <danalevi71@example.net>", to: SYNTHETIC.owner_email }),
    msg("m3", t0 + 2 * DAY, { from: "owner@work.example", to: "danalevi71@example.net", cc: "support@acme.com", sent: true }),
  ] }, { selfEmails: SELF });
  // Oded: one written thread, in contacts.
  ep.ingestThread({ id: "t3", messages: [msg("m4", t0 + 3 * DAY, { from: SYNTHETIC.owner_email, to: "Omer <omerhadar@angels.example>", sent: true })] }, { selfEmails: SELF });
  // Stranger: one written thread, not in contacts.
  ep.ingestThread({ id: "t4", messages: [msg("m5", t0, { from: SYNTHETIC.owner_email, to: "clerk@hotel-x.example", sent: true })] }, { selfEmails: SELF });
  // Mailing list the user posted to twice — never qualifies anyone.
  for (const id of ["t5", "t6"]) {
    ep.ingestThread({ id, messages: [msg(`${id}m`, t0, { from: SYNTHETIC.owner_email, to: "group@lists.x.org", sent: true, listId: "<group.lists.x.org>" })] }, { selfEmails: SELF });
  }
  // Inbound-only from someone the user never wrote to.
  ep.ingestThread({ id: "t7", messages: [msg("m7", t0, { from: "rando@x.com", to: SYNTHETIC.owner_email })] }, { selfEmails: SELF });
  ep.upsertContacts([{ email: "OmerHadar@angels.example", name: "Omer Hadar", resource: "people/c1" }]);

  const c = ep.candidates({ selfEmails: SELF });
  assert.deepEqual(c.map((x) => [x.person_key, x.threads_written]).sort(), [
    ["danalevi71@example.net", 2],
    ["omerhadar@angels.example", 1],
  ]);
  // Newest correspondence first.
  assert.ok(c.every((x, i) => i === 0 || c[i - 1].last_at >= x.last_at));
  const dana = c.find((x) => x.person_key === "danalevi71@example.net");
  assert.equal(dana.stale, true);
  assert.deepEqual(dana.names, ["Dana Levi"]);
  assert.equal(c.find((x) => x.person_key === "omerhadar@angels.example").contact.resource, "people/c1");
});

test("merge groups addresses; link + newer mail drives staleness", () => {
  const t0 = Date.parse("2021-01-01");
  ep.ingestThread({ id: "t8", messages: [msg("m8", t0, { from: SYNTHETIC.owner_email, to: "dalevi@rideco.example", sent: true })] }, { selfEmails: SELF });
  ep.merge("danalevi71@example.net", ["dalevi@rideco.example"]);
  let dana = ep.candidates({ selfEmails: SELF }).find((x) => x.person_key === "danalevi71@example.net");
  assert.deepEqual(dana.emails, ["dalevi@rideco.example", "danalevi71@example.net"]);
  assert.equal(dana.threads_written, 3);

  ep.link("dalevi@rideco.example", "user_dana_levi", { summarizedLastAt: dana.last_at });
  dana = ep.candidates({ selfEmails: SELF }).find((x) => x.person_key === "danalevi71@example.net");
  assert.equal(dana.wiki_id, "user_dana_levi");
  assert.equal(dana.stale, false);

  // An inbound-only email from her later makes the summary stale again.
  ep.ingestThread({ id: "t9", messages: [msg("m9", t0 + 400 * DAY, { from: "danalevi71@example.net", to: SYNTHETIC.owner_email })] }, { selfEmails: SELF });
  dana = ep.candidates({ selfEmails: SELF }).find((x) => x.person_key === "danalevi71@example.net");
  assert.equal(dana.stale, true);
  assert.equal(ep.candidates({ selfEmails: SELF, staleOnly: true }).length, 2);

  const timeline = ep.personThreads("dalevi@rideco.example");
  assert.equal(timeline.person_key, "danalevi71@example.net");
  assert.equal(timeline.threads[0].thread_id, "t9");
  assert.equal(timeline.threads[0].from_owner, 0);
});

test("ignore drops an address from the candidates", () => {
  ep.ignore("omerhadar@angels.example", "test");
  assert.ok(!ep.candidates({ selfEmails: SELF }).some((x) => x.person_key === "omerhadar@angels.example"));
});

test("renderSection appends once, then replaces in place", () => {
  const base = "---\nname: x\n---\n# Dana\n\nFriend.\n";
  const opts = { threadsWritten: 3, firstAt: Date.parse("2009-03-02"), lastAt: Date.parse("2026-10-12"), today: Date.parse("2026-10-24") };
  const once = ep.renderSection(base, { ...opts, summary: "Family logistics." });
  assert.match(once, /## Email\n<!-- email-people:start -->\n_From Gmail · 3 threads the user wrote in · first 2009-03-02 · last 2026-10-12 · updated 2026-10-24_\n\nFamily logistics\.\n<!-- email-people:end -->\n$/);
  const twice = ep.renderSection(once + "\n## Later\nkept\n", { ...opts, summary: "Updated." });
  assert.equal(twice.match(/## Email/g).length, 1);
  assert.match(twice, /Updated\.\n<!-- email-people:end -->\n\n## Later\nkept/);
});

test("recomputeOutbound turns an old self address's messages into the user's", () => {
  const t0 = Date.parse("2015-01-01");
  ep.ingestThread({ id: "t10", messages: [msg("m10", t0, { from: "Owner <owner@oldco.example>", to: "colleague@oldco.example" })] }, { selfEmails: SELF });
  ep.ingestThread({ id: "t11", messages: [msg("m11", t0 + DAY, { from: "owner@oldco.example", to: "colleague@oldco.example" })] }, { selfEmails: SELF });
  const self = [...SELF, "owner@oldco.example"];
  assert.ok(ep.candidates({ selfEmails: self }).every((c) => c.person_key !== "colleague@oldco.example"));
  assert.equal(ep.recomputeOutbound(self), 2);
  const c = ep.candidates({ selfEmails: self }).find((x) => x.person_key === "colleague@oldco.example");
  assert.equal(c.threads_written, 2);
  assert.ok(!ep.candidates({ selfEmails: self }).some((x) => x.person_key === "owner@oldco.example"));
});

test("the agent's own address is never a person", () => {
  const t0 = Date.parse("2020-05-01");
  for (const id of ["a1", "a2"]) {
    ep.ingestThread({ id, messages: [msg(`${id}m`, t0, { from: SYNTHETIC.owner_email, to: `Agent <${SYNTHETIC.agent_email}>`, sent: true })] }, { selfEmails: SELF });
  }
  assert.ok(!ep.candidates({ selfEmails: SELF }).some((x) => x.person_key === SYNTHETIC.agent_email));
});
