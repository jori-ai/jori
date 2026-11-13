// The nightly audit's lessons reach the gate (system/speak-gate.md § Nightly audit):
// bin/speak-gate.mjs puts data/speak-gate-lessons.json into the judge's prompt,
// and still runs end to end on the shared research lib (lib/speak-gate-agent.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "sg-lessons-"));

function fakeClaude() {
  const bin = path.join(dir, "claude");
  const seen = path.join(dir, "prompt.txt");
  writeFileSync(bin, `#!/bin/sh\ncat > ${JSON.stringify(seen)}\necho 'researched.'\necho '{"verdict":"send","checks":{},"sources":["x"],"reason":"fine"}'\n`);
  chmodSync(bin, 0o755);
  return { bin, seen };
}

function gate(env) {
  return spawnSync(process.execPath, [path.join(ROOT, "bin", "speak-gate.mjs")], {
    input: JSON.stringify({ message: "Your package arrives today.", kind: "reply", reply_to_text: "when?", as_of: "2026-11-01T12:00:00Z" }),
    encoding: "utf8", timeout: 120000,
    env: { ...process.env, SPEAK_GATE_NO_LOG: "1", ...env },
  });
}

test("lessons from the audit are in the judge's prompt", () => {
  const { bin, seen } = fakeClaude();
  const lessons = path.join(dir, "lessons.json");
  writeFileSync(lessons, JSON.stringify({ lessons: [{ text: "Check the carrier's tracking before saying a package arrives today.", since: "2026-11-14" }] }));
  const r = gate({ SPEAK_GATE_CLAUDE_BIN: bin, SPEAK_GATE_LESSONS: lessons });
  assert.equal(JSON.parse(r.stdout.trim().split("\n").pop()).verdict, "send");
  const p = readFileSync(seen, "utf8");
  assert.match(p, /LESSONS FROM THE NIGHTLY AUDIT/);
  assert.match(p, /carrier's tracking/);
  assert.match(p, /READ-ONLY TOOLS/);
});

test("no lessons file: no lessons section", () => {
  const { bin, seen } = fakeClaude();
  const r = gate({ SPEAK_GATE_CLAUDE_BIN: bin, SPEAK_GATE_LESSONS: path.join(dir, "missing.json") });
  assert.equal(JSON.parse(r.stdout.trim().split("\n").pop()).verdict, "send");
  assert.doesNotMatch(readFileSync(seen, "utf8"), /LESSONS FROM THE NIGHTLY AUDIT/);
});
