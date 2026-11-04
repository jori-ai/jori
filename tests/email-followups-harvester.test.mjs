// A made-up installation: its agent address is the "own mail" to skip.
import { SYNTHETIC } from "./synthetic-instance.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { pickOldestOpenP1, pickTopOpenP1, followupUrgency } from "../lib/p1-followups.mjs";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const d = (days) => String(NOW - days * 86400000);
const msg = (id, days, labels, subject = "S") => ({
  id, internalDate: d(days), labelIds: labels,
  payload: { headers: [{ name: "Subject", value: subject }, { name: "From", value: "a@b.c" }] },
});
const P = ["Label_1", "STARRED", "INBOX"];

test("picks oldest open P1, skips replied threads and fresh ones", () => {
  const threads = [
    { id: "t1", messages: [msg("m1", 5, P, "old")] },
    { id: "t2", messages: [msg("m2", 9, P), msg("m3", 8, ["SENT"])] },
    { id: "t3", messages: [msg("m4", 0.2, P)] },
    { id: "t4", messages: [msg("m5", 3, P, "newer")] },
  ];
  const { oldest, open } = pickOldestOpenP1(threads, "Label_1", NOW);
  assert.equal(oldest.messageId, "m1");
  assert.equal(oldest.subject, "old");
  assert.equal(open.length, 2);
});

test("newer inbound after reply keeps thread open; none -> null", () => {
  const t = { id: "t", messages: [msg("a", 6, P), msg("b", 5, ["SENT"]), msg("c", 4, ["INBOX"])] };
  assert.equal(pickOldestOpenP1([t], "Label_1", NOW).oldest.messageId, "a");
  assert.equal(pickOldestOpenP1([], "Label_1", NOW).oldest, null);
});

test("urgency decays", () => {
  assert.ok(followupUrgency(17) < followupUrgency(3));
  assert.ok(followupUrgency(2) <= 0.8);
});

test("picks highest-urgency P1, not the oldest, and skips the agent's own mail", () => {
  const own = msg("g", 5, P, "own");
  own.payload.headers[1].value = `Agent <${SYNTHETIC.agent_email}>`;
  const threads = [
    { id: "t1", messages: [msg("a1", 1, P)] },
    { id: "t2", messages: [msg("a5", 5, P)] },
    { id: "t3", messages: [msg("a25", 25, P)] },
    { id: "t4", messages: [own] },
  ];
  const { top, open } = pickTopOpenP1(threads, "Label_1", NOW);
  assert.equal(top.messageId, "a5");
  assert.equal(open.length, 3);
});

test("own-mail addresses can be passed explicitly; none configured skips nothing", () => {
  const own = msg("g", 5, P, "own");
  own.payload.headers[1].value = "Bot <bot@example.org>";
  assert.equal(pickTopOpenP1([{ id: "t", messages: [own] }], "Label_1", NOW, 1, { ownAddresses: ["bot@example.org"] }).top, null);
  assert.equal(pickTopOpenP1([{ id: "t", messages: [own] }], "Label_1", NOW, 1, { ownAddresses: [] }).top.messageId, "g");
});
