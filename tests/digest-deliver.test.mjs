// digest-deliver labelDigest: the Gmail half of the long-form delivery rule.
// Background: a digest turn once ran `gmail-action label-archive` and the
// summary never reached the inbox. These pin that the helper never archives
// and restores INBOX if something else did.

// A made-up installation (agent address, tz), the same in every checkout.
import { SYNTHETIC } from "./synthetic-instance.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { labelDigest, findSentMessageId, todayLocal, todayET, ownerEmail } from "../lib/digest-deliver.mjs";

function seams(labelIds) {
  const calls = [];
  return {
    calls,
    opts: {
      findId: async () => "m1",
      action: (args) => { calls.push(args); return 0; },
      labels: async () => labelIds,
    },
  };
}

test("labels, stars, marks read — never archives", async () => {
  const { calls, opts } = seams(["INBOX", "STARRED"]);
  assert.equal(await labelDigest("S", opts), "m1");
  assert.deepEqual(calls, [["label", "m1", "personal"], ["star", "m1"], ["mark-read", "m1"]]);
});

test("restores INBOX when the message ended up archived", async () => {
  const { calls, opts } = seams(["STARRED", "Label_31"]);
  await labelDigest("S", opts);
  assert.deepEqual(calls.at(-1), ["unarchive", "m1"]);
});

test("custom label is honored", async () => {
  const { calls, opts } = seams(["INBOX"]);
  await labelDigest("S", { ...opts, label: "projects" });
  assert.deepEqual(calls[0], ["label", "m1", "projects"]);
});

test("not found returns false and touches nothing", async () => {
  const { calls, opts } = seams(["INBOX"]);
  assert.equal(await labelDigest("S", { ...opts, findId: async () => null }), false);
  assert.equal(calls.length, 0);
});

test("a failed verify does not throw", async () => {
  const { opts } = seams([]);
  assert.equal(await labelDigest("S", { ...opts, labels: async () => { throw new Error("boom"); } }), "m1");
});

test("findSentMessageId skips a 'Re:' reply in the same thread", async () => {
  const msgs = {
    reply: { payload: { headers: [{ name: "Subject", value: "Re: Day of Sunday, October 4, 2026" }] } },
    digest: { payload: { headers: [{ name: "Subject", value: "Day of Sunday, October 4, 2026" }] } },
  };
  const gmail = { searchIds: async () => ["reply", "digest"], getMessage: async (id) => msgs[id] };
  assert.equal(await findSentMessageId("Day of Sunday, October 4, 2026", { attempts: 1, gmail }), "digest");
  assert.equal(await findSentMessageId("Day of Monday, October 5, 2026", { attempts: 1, gmail }), null);
});

test("findSentMessageId searches from the agent's own addresses; none configured → null", async () => {
  let q = "";
  const gmail = { searchIds: async (query) => { q = query; return []; }, getMessage: async () => ({}) };
  assert.equal(await findSentMessageId("Digest — Mon", { attempts: 1, gmail }), null);
  assert.ok(q.startsWith(`{from:${SYNTHETIC.agent_email}} subject:"Digest — Mon"`), q);
  q = "";
  assert.equal(await findSentMessageId("X", { attempts: 3, gmail, fromAddresses: [] }), null);
  assert.equal(q, "", "no Gmail call without an address");
});

test("the owner is the instance's owner_email; today is in the instance tz", () => {
  assert.equal(ownerEmail(), SYNTHETIC.owner_email);
  assert.equal(todayLocal(new Date("2026-03-01T23:30:00Z")), "2026-03-01"); // synthetic tz is UTC
  assert.equal(todayET, todayLocal);
});

// ── email-send --check-delivery: "the mail service accepted it" is not "it arrived".
// A held message is reported as in transit (never as delivered), a bounce or a
// message the service never took ends the wait as a failure, and the mailbox
// itself is the proof of arrival.

import { classifyDelivery, checkDelivery, findSentLogEntry, messageIdFor, mailboxLookup, providerEvents, DELIVERY_EXIT } from "../lib/digest-deliver.mjs";

const T0 = Date.parse("2026-01-02T12:00:00Z");
const SENT = { ts: new Date(T0).toISOString(), email_id: "1abc-DEF-ghi", to: [SYNTHETIC.owner_email], subject: "Weekly memo" };
const ev = (event, atMs, extra = {}) => ({ email_id: SENT.email_id, event, date: new Date(atMs).toISOString().slice(0, 19) + "Z", ...extra });

// A fake clock and sources: `rounds` is what each poll sees, the last one repeating.
function fakeDeps(rounds) {
  let t = T0 + 5000, i = 0;
  const cur = () => rounds[Math.min(i, rounds.length - 1)];
  return {
    polls: () => i,
    events: async () => { const r = cur(); if (r.events === "throw") throw new Error("down"); return r.events; },
    mailbox: async () => { const r = cur(); if (r.mailbox === "throw") throw new Error("down"); return r.mailbox; },
    now: () => t,
    sleep: async (ms) => { t += ms; i++; },
  };
}

test("lands once the message is in the owner's inbox, after waiting through a held stretch", async () => {
  const deps = fakeDeps([
    { events: [ev("processed", T0)], mailbox: null },
    { events: [ev("processed", T0)], mailbox: null },
    { events: [ev("processed", T0), ev("delivered", T0 + 465000)], mailbox: { id: "m1", labels: ["INBOX", "UNREAD"] } },
  ]);
  const r = await checkDelivery(SENT, { owner: SYNTHETIC.owner_email, waitMs: 600000, intervalMs: 15000, deps });
  assert.equal(r.status, "landed");
  assert.equal(r.exit, DELIVERY_EXIT.landed);
  assert.equal(r.exit, 0);
  assert.match(r.detail, /7m 45s/);
  assert.equal(deps.polls(), 2);
});

test("a message the service is still holding when the wait runs out is in transit, not delivered", async () => {
  const deps = fakeDeps([{ events: [ev("processed", T0)], mailbox: null }]);
  const r = await checkDelivery(SENT, { owner: SYNTHETIC.owner_email, waitMs: 60000, intervalMs: 15000, deps });
  assert.equal(r.status, "in-transit");
  assert.equal(r.exit, 2);
});

test("a hard bounce ends the wait at once with the server's reason", async () => {
  const deps = fakeDeps([{ events: [ev("processed", T0), ev("hard-bounced", T0 + 2000, { smtp_response: "550 no such user" })], mailbox: null }]);
  const r = await checkDelivery(SENT, { owner: SYNTHETIC.owner_email, waitMs: 600000, deps });
  assert.equal(r.status, "bounced");
  assert.equal(r.exit, 3);
  assert.match(r.detail, /550 no such user/);
  assert.equal(deps.polls(), 0);
});

test("a soft bounce is a deferral: keep waiting", () => {
  const r = classifyDelivery({ events: [ev("processed", T0), ev("soft-bounced", T0 + 1000, { smtp_response: "421 try later" })], mailbox: null, ownerRecipient: true, sentAt: T0, now: T0 + 60000 });
  assert.equal(r.status, "in-transit");
  assert.equal(r.done, false);
  assert.match(r.detail, /421 try later/);
});

test("Spam or Trash counts as arrived but not in the inbox", () => {
  const r = classifyDelivery({ events: [], mailbox: { id: "m", labels: ["SPAM"] }, ownerRecipient: true, sentAt: T0, now: T0 + 10000 });
  assert.equal(r.status, "not-in-inbox");
  assert.equal(r.done, true);
});

test("the service having no record of the message ten minutes later means it was never taken", () => {
  assert.equal(classifyDelivery({ events: [], mailbox: null, ownerRecipient: true, sentAt: T0, now: T0 + 4 * 60000 }).status, "in-transit");
  const r = classifyDelivery({ events: [], mailbox: null, ownerRecipient: true, sentAt: T0, now: T0 + 11 * 60000 });
  assert.equal(r.status, "bounced");
});

test("a failed activity lookup is never read as 'no record', nor as 'held' when the wait ends", () => {
  const args = { events: null, mailbox: null, ownerRecipient: true, sentAt: T0, now: T0 + 10 * 60000 };
  assert.equal(classifyDelivery(args).status, "in-transit");
  assert.equal(classifyDelivery({ ...args, final: true }).status, "unknown");
});

test("an old sent-log row with a string recipient still finds the owner", async () => {
  const deps = fakeDeps([{ events: [], mailbox: { id: "m", labels: ["INBOX"] } }]);
  const r = await checkDelivery({ ...SENT, to: SYNTHETIC.owner_email }, { owner: SYNTHETIC.owner_email, waitMs: 0, deps });
  assert.equal(r.status, "landed");
});

test("delivered by the provider but not yet searchable stays in transit until that is no longer a search lag", () => {
  const args = { events: [ev("delivered", T0 + 3000)], mailbox: null, ownerRecipient: true, sentAt: T0, now: T0 + 30000 };
  assert.equal(classifyDelivery(args).done, false);
  // The wait ends seconds after the receiving server took it: look again, never "not in your inbox".
  assert.equal(classifyDelivery({ ...args, final: true }).status, "in-transit");
  assert.equal(classifyDelivery({ ...args, now: T0 + 5 * 60000, final: true }).status, "not-in-inbox");
});

test("archived out of the inbox is not 'landed'", () => {
  const r = classifyDelivery({ events: [], mailbox: { id: "m", labels: ["UNREAD"] }, ownerRecipient: true, sentAt: T0, now: T0 + 10000 });
  assert.equal(r.status, "not-in-inbox");
});

test("another recipient's mail is judged by the provider alone", async () => {
  const deps = fakeDeps([{ events: [ev("delivered", T0 + 4000)], mailbox: "throw" }]);
  const r = await checkDelivery({ ...SENT, to: ["someone@example.org"] }, { owner: SYNTHETIC.owner_email, waitMs: 60000, deps });
  assert.equal(r.status, "landed");
});

test("both sources down for the whole wait is 'could not check', not a delivery", async () => {
  const deps = fakeDeps([{ events: "throw", mailbox: "throw" }]);
  const r = await checkDelivery(SENT, { owner: SYNTHETIC.owner_email, waitMs: 30000, intervalMs: 15000, deps });
  assert.equal(r.status, "unknown");
  assert.equal(r.exit, 1);
});

test("findSent picks the newest send with exactly the subject, within a day", () => {
  const log = [
    { ts: new Date(T0 - 2 * 86400000).toISOString(), email_id: "old", subject: "Weekly memo" },
    { ts: new Date(T0 - 60000).toISOString(), email_id: "a", subject: "Weekly memo" },
    { ts: new Date(T0 - 30000).toISOString(), email_id: "reply", subject: "Re: Weekly memo" },
    { ts: new Date(T0 - 10000).toISOString(), email_id: "b", subject: "Weekly memo" },
  ].map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n";
  assert.equal(findSentLogEntry({ subject: "Weekly memo", logText: log, now: T0 }).email_id, "b");
  assert.equal(findSentLogEntry({ emailId: "old", logText: log, now: T0 }).email_id, "old");
  assert.equal(findSentLogEntry({ subject: "Other", logText: log, now: T0 }), null);
});

test("the mailbox is searched by the provider's Message-ID, Spam and Trash included", async () => {
  let q = null;
  const gmail = { searchIds: async (query) => { q = query; return ["m9"]; }, getMessage: async () => ({ labelIds: ["INBOX"], internalDate: String(T0) }) };
  const r = await mailboxLookup("1abc-DEF-ghi", { gmail });
  assert.equal(q, `in:anywhere rfc822msgid:${messageIdFor("1abc-DEF-ghi")}`);
  assert.equal(messageIdFor("1abc-DEF-ghi"), "E1abc-DEF-ghi@message-id.smtpcorp.com"); // kernel-guard-ok: the provider's Message-ID format, not a mailbox
  assert.deepEqual(r, { id: "m9", labels: ["INBOX"], receivedAt: T0 });
});

test("providerEvents keeps only this message's events and surfaces API errors", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: { events: [{ email_id: "x", event: "processed" }, { email_id: "1abc-DEF-ghi", event: "delivered" }] } }) });
  const evs = await providerEvents("1abc-DEF-ghi", { since: T0, until: T0 + 1000, apiKey: "k", fetchImpl });
  assert.deepEqual(evs.map((e) => e.event), ["delivered"]);
  const bad = async () => ({ ok: false, status: 400, json: async () => ({ data: { error: "denied" } }) });
  await assert.rejects(providerEvents("x", { since: T0, until: T0, apiKey: "k", fetchImpl: bad }), /denied/);
  await assert.rejects(providerEvents("x", { since: T0, until: T0, apiKey: "", fetchImpl }), /SMTP2GO_API_KEY/);
});
