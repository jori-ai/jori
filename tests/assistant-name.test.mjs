// assistant-name.test.mjs — the assistant's name comes from lib/instance.cjs
// (`assistant_name`, JORI_ASSISTANT_NAME), not from literals in code: a push
// title, the SMS identity opener and a model prompt all follow it.

import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// synthetic-instance clears JORI_* on import; set the name before the modules
// under test load (dynamic imports below).
process.env.JORI_ASSISTANT_NAME = "Ava";

const { holdPing, readQueue } = await import("../lib/ping-hold.mjs");
const { hasIdentityOpener } = await import("../lib/sms-core.mjs");
const { mobilePush } = await import("../agent/core/telemetry.mjs");
const { TIMELINE_RULE } = await import("../lib/claim-freshness.mjs");

test("a held push with no title is titled with the configured name", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "assistant-name-")), "held.json");
  const stored = holdPing({ body: "hello" }, { file });
  assert.equal(stored.title, "Ava");
  assert.equal(readQueue(file)[0].title, "Ava");
});

test("the SMS identity opener names the configured assistant", () => {
  assert.equal(hasIdentityOpener("Hi Bob, this is Ava, Sam's AI assistant. Sam asked me to say hi.", "Sam"), true);
  assert.equal(hasIdentityOpener("This is Ava on behalf of Sam: the package arrived.", "Sam"), true);
  assert.equal(hasIdentityOpener("Hi Bob, this is Jori, Sam's AI assistant. Sam asked me to say hi.", "Sam"), false);
});

test("a telemetry push without a title uses the configured name", () => {
  let title = null;
  mobilePush(null, "done", { dedupeKey: "assistant-name-test", pusher: (t) => { title = t; return true; } });
  assert.equal(title, "Ava");
});

test("model prompts name the configured assistant", () => {
  assert.match(TIMELINE_RULE, /\bAva's live source of record\b/);
  assert.doesNotMatch(TIMELINE_RULE, /\bJori\b/);
});
