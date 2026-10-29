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
