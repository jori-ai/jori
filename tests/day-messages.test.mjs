// day-messages: the daily summary's message source over the
// synthetic chat.db from imessage-db.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fixture } from "./imessage-db.test.mjs";

const require = createRequire(import.meta.url);
const dm = require("../lib/day-messages.js");

test("day-messages: iMessage rows for the window, structural caps", () => {
  const db = fixture();
  const w = { startMs: Date.parse("2026-10-26T00:00:00Z"), endMs: Date.parse("2026-10-27T00:00:00Z") };
  const rows = dm.imessageRows(w, { chatDb: db });
  assert.deepEqual(rows.map((r) => r.text), ["Should I bring ice cream?", "Might as well", "Dinner at 8 tonight", "[image]"].filter((t) => dm.hasWords(t)));
  const many = Array.from({ length: 30 }, (_, i) => ({ channel: "whatsapp", ms: i, chat_id: "g", chat: "G", is_group: true, from_me: false, who: "x", text: `m${i}` }));
  const { kept, dropped } = dm.bound(many);
  assert.equal(kept.length, dm.GROUP_PASSIVE_MAX);
  assert.equal(dropped, 30 - dm.GROUP_PASSIVE_MAX);
  assert.equal(kept.at(-1).text, "m29");
  db.close();
});
