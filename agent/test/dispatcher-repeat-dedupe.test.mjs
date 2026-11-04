// dispatcher-repeat-dedupe.test.mjs — a playbook already sent to this session
// in full is sent again as a short pointer (dispatcher.mjs repeatMinChars); a
// different text, a short one, a compaction or a new dispatcher (= new session)
// always gets the full text. Off by default.
// Run: node --test agent/test/dispatcher-repeat-dedupe.test.mjs

import { it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Dispatcher } from "../supervisor/dispatcher.mjs";

class MockSession extends EventEmitter {
  constructor() { super(); this.sent = []; }
  send(content) { this.sent.push(content); }
  complete() { this.emit("result", { num_turns: 3, total_cost_usd: 0 }); }
}

const BOOK = "HUM — proactive check-in.\n" + "rules ".repeat(3000); // ~18k chars
const run = (d, s, content, source) => { d.dispatch(content, source); s.complete(); };

it("sends a repeated playbook as a pointer to the earlier copy, once it is in this session", () => {
  const s = new MockSession();
  const d = new Dispatcher(s, { repeatMinChars: 8000, postCompactDrainDelayMs: 0 });
  const seen = [];
  d.on("repeat_pointer", (e) => seen.push(e));
  run(d, s, BOOK, "hum");
  run(d, s, BOOK, "hum:moment");
  assert.equal(s.sent[0], BOOK);
  assert.match(s.sent[1], /^Run the `hum:moment` job again now\. Its instructions are the exact text dispatched earlier in this session/); // lang-regex-ok: asserts the dispatcher's own pointer text
  assert.ok(s.sent[1].length < 600);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].savedChars > 17000);
});

it("sends different, short, or post-compaction content in full", () => {
  const s = new MockSession();
  const d = new Dispatcher(s, { repeatMinChars: 8000, postCompactDrainDelayMs: 0 });
  run(d, s, BOOK, "hum");
  run(d, s, BOOK + " changed", "hum");          // not byte-identical
  run(d, s, "short task", "webhook");
  run(d, s, "short task", "webhook");            // under the size floor
  assert.equal(s.sent[1], BOOK + " changed");
  assert.equal(s.sent[3], "short task");
  d.forgetSent();
  run(d, s, BOOK, "hum");
  assert.equal(s.sent[4], BOOK, "after a compaction the full text goes again");
});

it("is off by default and per dispatcher (a new session starts empty)", () => {
  const s = new MockSession();
  const off = new Dispatcher(s, { postCompactDrainDelayMs: 0 });
  run(off, s, BOOK, "hum");
  run(off, s, BOOK, "hum");
  assert.deepEqual(s.sent, [BOOK, BOOK]);
  const s2 = new MockSession();
  const fresh = new Dispatcher(s2, { repeatMinChars: 8000, postCompactDrainDelayMs: 0 });
  run(fresh, s2, BOOK, "hum");
  assert.equal(s2.sent[0], BOOK);
});
