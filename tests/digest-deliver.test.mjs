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

// ── Straight into the owner's mailbox: the mail service's own queue held agent
// mail for minutes before trying to deliver it, so mail to the owner alone no
// longer goes through it. These pin who qualifies, that the message is well
// formed, that the mailbox is checked to be the owner's, that a lost answer
// never produces a second copy, and that --check-delivery reads it from the
// mailbox alone.

import {
  ownerMailboxEligible, newMessageId, encodeHeaderWords, buildMimeMessage, rfc5322Date,
  importIntoOwnerMailbox, deliverToOwnerMailbox, bareMessageId,
} from "../lib/digest-deliver.mjs";

const OWNER = SYNTHETIC.owner_email;
const AGENT = SYNTHETIC.agent_email;

test("only agent mail to the owner alone goes straight into the mailbox", () => {
  const base = { owner: OWNER, agents: [AGENT], env: {} };
  assert.equal(ownerMailboxEligible({ ...base, to: [OWNER], from: AGENT }), true);
  assert.equal(ownerMailboxEligible({ ...base, to: [OWNER.toUpperCase()], from: ` ${AGENT.toUpperCase()}` }), true);
  assert.equal(ownerMailboxEligible({ ...base, to: [OWNER, "partner@example.org"], from: AGENT }), false, "a second recipient needs the same message, so the provider");
  assert.equal(ownerMailboxEligible({ ...base, to: ["someone@example.org"], from: AGENT }), false);
  assert.equal(ownerMailboxEligible({ ...base, to: [OWNER], from: "other@example.org" }), false, "never put another sender into the mailbox");
  assert.equal(ownerMailboxEligible({ ...base, to: [OWNER], from: AGENT, env: { EMAIL_SEND_VIA_PROVIDER: "1" } }), false);
  assert.equal(ownerMailboxEligible({ ...base, owner: "", to: [OWNER], from: AGENT }), false);
});

test("the logged id sits inside the Message-ID, so reply matching finds it", () => {
  const { emailId, messageId } = newMessageId(AGENT, { now: 1, rand: "ab12" });
  assert.equal(emailId, "m.1.ab12");
  assert.equal(messageId, `<m.1.ab12@${SYNTHETIC.domain}>`);
  assert.ok(messageId.includes(emailId) && emailId.length >= 8);
  assert.equal(bareMessageId(messageId), `m.1.ab12@${SYNTHETIC.domain}`);
});

function decodeWords(v) {
  return v.split("\r\n ").map((w) => Buffer.from(w.slice("=?UTF-8?B?".length, -2), "base64").toString("utf8")).join("");
}

test("non-ASCII headers become short encoded-words that decode back exactly", () => {
  assert.equal(encodeHeaderWords("Plain subject"), "Plain subject");
  const subject = "Weekly report — October 30 — status ✓ שלום עולם, a long line that needs several words";
  const enc = encodeHeaderWords(subject);
  for (const w of enc.split("\r\n ")) assert.ok(w.length <= 75, `${w.length}: ${w}`);
  assert.equal(decodeWords(enc), subject);
  assert.equal(encodeHeaderWords("line\r\nInjected: x"), "line  Injected: x");
});

function parts(raw) {
  const [head, ...rest] = raw.split("\r\n\r\n");
  return { head, body: rest.join("\r\n\r\n") };
}

test("an HTML memo with an inline image and an attachment is a well-formed 7-bit message", () => {
  const html = "<div><p>Memo — body</p><img src=\"cid:logo.png\"></div>";
  const raw = buildMimeMessage({
    from: AGENT, fromName: "Agent \"Bot\"", to: [OWNER], subject: "Memo — Oct 30",
    html, text: "Memo — body", replyTo: AGENT, inReplyTo: "<a@x>", references: "<a@x> <b@y>",
    messageId: "<m.1.ab12@example.com>", date: new Date("2026-01-02T12:00:00Z"),
    attachments: [
      { filename: "logo.png", cid: "logo.png", mimetype: "image/png", content: Buffer.from([1, 2, 3]) },
      { filename: "מסמך.pdf", mimetype: "application/pdf", content: Buffer.from("pdf") },
    ],
    boundary: (() => { let n = 0; return () => `B${++n}`; })(),
  });
  assert.ok(isAsciiText(raw), "7-bit only");
  for (const line of raw.split("\r\n")) assert.ok(line.length <= 998);
  assert.equal(raw.split("\r\n").join("").includes("\n"), false, "no bare line feeds");
  const { head } = parts(raw);
  assert.ok(head.includes("Date: Fri, 02 Jan 2026 12:00:00 +0000"));
  assert.ok(head.includes("Message-ID: <m.1.ab12@example.com>"));
  assert.ok(head.includes(`From: "Agent \\"Bot\\"" <${AGENT}>`));
  assert.ok(head.includes(`To: ${OWNER}`));
  assert.ok(head.includes(`Reply-To: ${AGENT}`));
  assert.ok(head.includes("In-Reply-To: <a@x>"));
  assert.ok(head.includes("References: <a@x>\r\n <b@y>"));
  assert.ok(head.includes('Content-Type: multipart/mixed; boundary="B3"'));
  // mixed(related(alternative(text, html), inline), attachment)
  assert.ok(raw.indexOf('multipart/related; boundary="B2"') < raw.indexOf('multipart/alternative; boundary="B1"'));
  assert.ok(raw.includes("Content-ID: <logo.png>"));
  assert.ok(raw.includes("filename*=UTF-8''%D7%9E%D7%A1%D7%9E%D7%9A.pdf"));
  const htmlB64 = Buffer.from(html, "utf8").toString("base64");
  assert.ok(raw.includes(htmlB64.slice(0, 60)), "the HTML part is base64 of the exact body");
});

function isAsciiText(s) { return Buffer.byteLength(s, "utf8") === s.length; }

test("a plain-text message with nothing attached is a single text part", () => {
  const raw = buildMimeMessage({ from: AGENT, to: [OWNER], subject: "S", text: "hello", messageId: "<x@y>" });
  const { head, body } = parts(raw);
  assert.ok(head.includes("Content-Type: text/plain; charset=UTF-8"));
  assert.equal(Buffer.from(body.trim(), "base64").toString("utf8"), "hello");
  const multi = parts(buildMimeMessage({ from: AGENT, to: [OWNER], subject: "S", text: "a\nb\r\nc", messageId: "<x@y>" })).body;
  assert.equal(Buffer.from(multi.trim(), "base64").toString("utf8"), "a\r\nb\r\nc", "text lines end in CRLF before encoding");
  assert.equal(rfc5322Date(new Date("2026-10-30T12:00:25Z")), "Fri, 30 Oct 2026 12:00:25 +0000");
});

// A fake Gmail API: `routes` answers by URL substring, `calls` records what was asked.
function fakeGmail({ profile = OWNER, parent = null, upload = { ok: true, body: { id: "g1", threadId: "t1" } }, found = [] } = {}) {
  const calls = [];
  let searches = 0;
  const reply = (ok, body, status = ok ? 200 : 500) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.endsWith("/profile")) return reply(true, { emailAddress: profile });
    if (url.includes("/upload/")) {
      if (upload === "throw") throw new Error("socket hang up");
      return reply(upload.ok, upload.body, upload.status);
    }
    if (url.includes("/messages?q=")) {
      const q = decodeURIComponent(url.split("q=")[1].split("&")[0]);
      if (parent && q.includes(bareMessageId(parent.id))) return reply(true, { messages: [{ id: "p", threadId: parent.threadId }] });
      searches++;
      return reply(true, { messages: found[searches - 1] || [] });
    }
    return reply(false, {}, 404);
  };
  return { calls, fetchImpl };
}

test("it never writes into a mailbox that is not the owner's", async () => {
  const g = fakeGmail({ profile: "someone-else@example.org" });
  await assert.rejects(importIntoOwnerMailbox({ raw: "x", messageId: "<m@x>", owner: OWNER }, { token: "t", fetchImpl: g.fetchImpl }), /not the owner/);
  assert.equal(g.calls.some((c) => c.url.includes("/upload/")), false);
});

test("it lands unread in the inbox, never names a thread (import refuses one), and returns the mailbox ids", async () => {
  const g = fakeGmail();
  const r = await importIntoOwnerMailbox({ raw: "RAW", messageId: "<m@x>", owner: OWNER }, { token: "t", fetchImpl: g.fetchImpl });
  assert.deepEqual(r, { gmailId: "g1", threadId: "t1" });
  const up = g.calls.find((c) => c.url.includes("/upload/"));
  assert.ok(up.url.endsWith("/messages/import?uploadType=multipart&neverMarkSpam=true"), "delivered like arriving mail, never into Spam");
  assert.ok(up.opts.signal, "every Gmail call has a timeout");
  assert.equal(up.opts.method, "POST");
  assert.ok(up.opts.body.includes('{"labelIds":["INBOX","UNREAD"]}'));
  assert.ok(up.opts.body.includes("Content-Type: message/rfc822\r\n\r\nRAW\r\n"));
  assert.equal(up.opts.headers.Authorization, "Bearer t");
});

test("a lost answer is looked up before giving up, so a sent message is never sent twice", async () => {
  const g = fakeGmail({ upload: "throw", found: [[], [{ id: "g7", threadId: "t7" }]] });
  const r = await importIntoOwnerMailbox({ raw: "x", messageId: "<m@x>", owner: OWNER }, { token: "t", fetchImpl: g.fetchImpl, lookupDelayMs: 0 });
  assert.deepEqual(r, { gmailId: "g7", threadId: "t7" });
});

test("an import that did not go in throws, so email-send falls back to the provider", async () => {
  const g = fakeGmail({ upload: { ok: false, status: 403, body: { error: "insufficient scope" } } });
  await assert.rejects(importIntoOwnerMailbox({ raw: "x", messageId: "<m@x>", owner: OWNER }, { token: "t", fetchImpl: g.fetchImpl, lookupDelayMs: 0 }), /import 403/);
});

test("deliverToOwnerMailbox builds the message from the agent's address and reports its ids", async () => {
  const g = fakeGmail();
  const r = await deliverToOwnerMailbox({ from: AGENT, fromName: "Agent", to: [OWNER], subject: "S", html: "<p>x</p>", text: "x" },
    { owner: OWNER, getToken: async () => "t", fetchImpl: g.fetchImpl, now: new Date(T0) });
  assert.equal(r.gmailId, "g1");
  assert.ok(r.messageId.includes(r.emailId));
  const up = g.calls.find((c) => c.url.includes("/upload/"));
  assert.ok(up.opts.body.includes(`Message-ID: ${r.messageId}`));
});

const DIRECT = { ...SENT, email_id: "m.1.ab12", message_id: "<m.1.ab12@example.com>", gmail_id: "g1", transport: "mailbox" };

test("a message put straight into the mailbox is checked in the mailbox alone", async () => {
  let eventsAsked = 0, seen = null;
  const deps = {
    events: async () => { eventsAsked++; return []; },
    mailbox: async (_id, sent) => { seen = sent; return { id: "g1", labels: ["INBOX", "UNREAD"] }; },
    now: () => T0 + 1000, sleep: async () => {},
  };
  const r = await checkDelivery(DIRECT, { owner: OWNER, waitMs: 0, deps });
  assert.equal(r.status, "landed");
  assert.equal(r.exit, 0);
  assert.equal(eventsAsked, 0, "the mail service has no record of it and is not asked");
  assert.equal(seen.message_id, DIRECT.message_id);
});

test("gone from the mailbox is 'not in the inbox', never 'never taken' (which would re-send)", () => {
  const args = { events: [], mailbox: null, ownerRecipient: true, sentAt: T0, provider: false };
  assert.equal(classifyDelivery({ ...args, now: T0 + 20000 }).status, "in-transit");
  const r = classifyDelivery({ ...args, now: T0 + 11 * 60000 });
  assert.equal(r.status, "not-in-inbox");
  assert.equal(classifyDelivery({ ...args, mailbox: undefined, now: T0 + 11 * 60000, final: true }).status, "unknown");
});

test("the mailbox lookup uses the logged Message-ID, then the mailbox id; a deleted message is not there", async () => {
  let q = null;
  const empty = { searchIds: async (query) => { q = query; return []; } };
  const found = await mailboxLookup("m.1.ab12", { gmail: { ...empty, getMessage: async (id) => ({ id, labelIds: ["INBOX"] }) }, messageId: "<m.1.ab12@example.com>", gmailId: "g1" });
  assert.equal(q, "in:anywhere rfc822msgid:m.1.ab12@example.com");
  assert.deepEqual(found, { id: "g1", labels: ["INBOX"], receivedAt: null });
  const gone = await mailboxLookup("m.1.ab12", { gmail: { ...empty, getMessage: async () => { throw new Error("Gmail 404: not found"); } }, messageId: "<m.1.ab12@example.com>", gmailId: "g1" });
  assert.equal(gone, null);
  await assert.rejects(mailboxLookup("m.1.ab12", { gmail: { ...empty, getMessage: async () => { throw new Error("Gmail 500: oops"); } }, messageId: "<m@x>", gmailId: "g1" }), /500/);
});
