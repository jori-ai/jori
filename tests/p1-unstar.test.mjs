// Guards Signal A of the P1 resolution system (lib/p1-unstar.js): a P1 is
// a user-unstar only when Gmail history shows STARRED removed, Jori did not
// remove it itself, and the message is still p1 and still unstarred.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { unstarredIds, decide, recentSelfUnstars } = require("../lib/p1-unstar.js");

const P1 = "Label_28";
const rm = (id, labelIds) => ({ labelsRemoved: [{ message: { id }, labelIds }] });

test("only STARRED removals are unstar events, deduped in order", () => {
  const ids = unstarredIds([
    rm("a", ["STARRED"]),
    rm("b", ["UNREAD"]),          // mark-read is not an unstar
    rm("a", ["STARRED", "INBOX"]),
    rm("c", ["INBOX", "STARRED"]),
    {},                            // record with no labelsRemoved
  ]);
  assert.deepEqual(ids, ["a", "c"]);
});

test("a still-p1, still-unstarred message is downgraded", () => {
  const d = decide({ ids: ["a"], current: { a: ["INBOX", P1] }, p1LabelId: P1 });
  assert.deepEqual(d.downgrade, ["a"]);
  assert.deepEqual(d.skipped, []);
});

test("non-p1, restarred, deleted and self-unstarred messages are left alone", () => {
  const d = decide({
    ids: ["np", "rs", "gone", "self"],
    current: { np: ["INBOX"], rs: [P1, "STARRED"], gone: null, self: [P1] },
    p1LabelId: P1,
    selfUnstarred: new Set(["self"]),
  });
  assert.deepEqual(d.downgrade, []);
  assert.deepEqual(d.skipped.map((s) => s.reason), ["not-p1", "restarred", "gone", "self-unstar"]);
});

test("self-unstar ledger only counts recent rows", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const set = recentSelfUnstars([
    { messageId: "recent", at: "2026-10-04T11:00:00Z" },
    { messageId: "old", at: "2026-10-04T08:00:00Z" },
    { messageId: "junk", at: "not-a-date" },
  ], now, 2 * 3600 * 1000);
  assert.deepEqual([...set], ["recent"]);
});
