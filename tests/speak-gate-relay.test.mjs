// A sender with no Max login (cron): the judge answers "Not logged in", and
// lib/speak-gate-live.mjs hands the judgment to bin/speak-gate-relay (the
// launchd agent in the GUI session) and acts on its verdict, instead of
// sending the message unchecked. The judge and the launchd kick are stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(tmpdir(), "sgr-"));
const relay = path.join(dir, "relay");
process.env.SPEAK_GATE_LIVE = "1";
process.env.SPEAK_GATE_REVIEW_SINK = path.join(dir, "reviews.jsonl");
process.env.SPEAK_GATE_RELAY_DIR = relay;
process.env.SPEAK_GATE_RELAY_IDLE_MS = "300";
delete process.env.SPEAK_GATE_RELAYED;
delete process.env.SPEAK_GATE_NO_RELAY;

// Judge: "Not logged in" outside the relay, a real verdict inside it.
const judge = path.join(dir, "judge.mjs");
writeFileSync(judge, `process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify(
  process.env.SPEAK_GATE_RELAYED === "1"
    ? { verdict: "${"rewrite"}", message: "checked text", reason: "relayed" }
    : { verdict: "send", reason: "gate_error:judge_unavailable:not_logged_in" })));`);
process.env.SPEAK_GATE_BIN = judge;
// The kick runs the relay runner in the background, as launchd would.
process.env.SPEAK_GATE_RELAY_KICK = `"${process.execPath}" "${path.join(ROOT, "bin", "speak-gate-relay")}" >/dev/null 2>&1 &`;

const { gateOutbound } = await import("../lib/speak-gate-live.mjs");

test("not_logged_in is relayed and the relayed verdict is acted on", async () => {
  const r = await gateOutbound({ message: "rain at 3pm", channel: "chat", intent: "chat" });
  assert.equal(r.deliver, true);
  assert.equal(r.text, "checked text");
  assert.equal(r.verdict, "rewrite");
  assert.equal(r.review.reason, "relayed");
  await new Promise((res) => setTimeout(res, 800));
  assert.deepEqual(readdirSync(relay), [], "request and verdict files are cleaned up");
});

test("a relay that cannot start fails open with the original error", async () => {
  process.env.SPEAK_GATE_RELAY_KICK = "exit 1";
  const r = await gateOutbound({ message: "hello", channel: "chat" });
  assert.equal(r.deliver, true);
  assert.equal(r.text, "hello");
  assert.equal(r.verdict, "error");
  assert.match(r.reason, /not_logged_in/);
});

test("SPEAK_GATE_NO_RELAY skips the relay", async () => {
  process.env.SPEAK_GATE_NO_RELAY = "1";
  process.env.SPEAK_GATE_RELAY_KICK = "touch " + path.join(dir, "kicked");
  const r = await gateOutbound({ message: "hi", channel: "chat" });
  assert.equal(r.verdict, "error");
  assert.ok(!readdirSync(dir).includes("kicked"));
  delete process.env.SPEAK_GATE_NO_RELAY;
});
