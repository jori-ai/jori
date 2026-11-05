// control-scan: comments are not code, an exempted line is not a finding, and a
// value really written into code still is.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCAN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "control-scan");

test("comments, docstrings and exempted lines are skipped; real values are found", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "control-scan-"));
  fs.mkdirSync(path.join(home, "agent/local"), { recursive: true });
  fs.writeFileSync(path.join(home, "agent/local/instance.json"), JSON.stringify({ assistant_name: "Ada", owner_name: "Sam" }));
  fs.mkdirSync(path.join(home, "bin"));
  fs.writeFileSync(path.join(home, "bin/tool.mjs"), [
    "// Sam asked for this",
    "/* a block comment",
    "   that names Sam twice: Sam */",
    'const x = 1; // trailing note for Sam',
    'console.log("Ada is here"); // control-scan-ok: the software\'s name',
    'console.log("Ada sent it");',
    'const who = "Sam";',
  ].join("\n"));
  fs.writeFileSync(path.join(home, "bin/tool.py"), [
    '"""Docstring about Sam',
    'and more about Sam."""',
    'print("hi")  # Sam said so',
  ].join("\n"));
  const out = JSON.parse(execFileSync(process.execPath, [SCAN, "--json"], { env: { ...process.env, JORI_HOME: home }, encoding: "utf8" }));
  const by = Object.fromEntries(out.findings.map((f) => [f.key, f]));
  assert.deepEqual(by.assistant_name.files, ["bin/tool.mjs:6"]);
  assert.deepEqual(by.owner_name.files, ["bin/tool.mjs:7"]);
  fs.rmSync(home, { recursive: true, force: true });
});
