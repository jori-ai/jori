// A chat push carries the conversation its message lives in, so a tap opens
// that conversation (apps/companion NotificationTap).
import test from "node:test";
import assert from "node:assert/strict";
import { conversationOfMessage } from "../lib/apns-push.mjs";

function fakeSupabase(row, { fail = false } = {}) {
  const q = {
    select() { return q; },
    eq(_col, value) { q.id = value; return q; },
    async maybeSingle() {
      if (fail) throw new Error("offline");
      return { data: row && row.id === q.id ? row : null };
    },
  };
  return { from: () => q };
}

test("returns the message's conversation", async () => {
  const sb = fakeSupabase({ id: "m1", conversation_id: "role:cfo" });
  assert.equal(await conversationOfMessage(sb, "m1"), "role:cfo");
});

test("unknown message or failed lookup gives null", async () => {
  assert.equal(await conversationOfMessage(fakeSupabase(null), "m1"), null);
  assert.equal(await conversationOfMessage(fakeSupabase(null, { fail: true }), "m1"), null);
});
