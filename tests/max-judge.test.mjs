// lib/max-judge.js — the tool-less structured judgment. CLAUDE_BIN points at a
// stub script that records its argv, stdin and env and prints a canned
// result, so no model is ever called.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "max-judge-"));
const STUB = path.join(dir, "claude");
const REC = path.join(dir, "rec.json");
fs.writeFileSync(STUB, `#!/usr/bin/env node
const fs = require("fs");
let input = ""; process.stdin.on("data", (d) => input += d).on("end", () => {
  fs.writeFileSync(${JSON.stringify(REC)}, JSON.stringify({ argv: process.argv.slice(2), input, apiKey: process.env.ANTHROPIC_API_KEY || null, authTok: process.env.ANTHROPIC_AUTH_TOKEN || null, cwd: process.cwd() }));
  const mode = process.env.STUB_MODE || "ok";
  if (mode === "ok") process.stdout.write(JSON.stringify({ is_error: false, structured_output: { verdict: "yes" }, total_cost_usd: 0 }));
  else if (mode === "nologin") process.stdout.write(JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" }));
  else if (mode === "plain") process.stdout.write(JSON.stringify({ is_error: false, result: "no schema" }));
  else { process.stderr.write("boom"); process.exit(1); }
});
`);
fs.chmodSync(STUB, 0o755);
process.env.CLAUDE_BIN = STUB;
process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
process.env.ANTHROPIC_AUTH_TOKEN = "tok-test-not-real";
const require = createRequire(import.meta.url);
const { judge, maxOnlyEnv, CLAUDE_BIN } = require("../lib/max-judge.js");
const rec = () => JSON.parse(fs.readFileSync(REC, "utf8"));
const SCHEMA = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };

test("CLAUDE_BIN honours the environment", () => assert.equal(CLAUDE_BIN, STUB));

test("maxOnlyEnv strips API credentials and keeps the rest", () => {
  const e = maxOnlyEnv({ ANTHROPIC_API_KEY: "a", ANTHROPIC_AUTH_TOKEN: "b", HOME: "/h" });
  assert.deepEqual(e, { HOME: "/h" });
});

test("a judgment is tool-less, MCP-less, session-less, prompt on stdin, no API key", async () => {
  process.env.STUB_MODE = "ok";
  let raw = null;
  const out = await judge({ model: "haiku", prompt: "Is it a flight?", schema: SCHEMA, appendSystem: "Be brief.", onResult: (r) => { raw = r; } });
  assert.deepEqual(out, { verdict: "yes" });
  assert.equal(raw.total_cost_usd, 0);
  const r = rec();
  const a = r.argv;
  const val = (f) => a[a.indexOf(f) + 1];
  assert.equal(r.input, "Is it a flight?");
  assert.equal(val("--model"), "haiku");
  assert.equal(val("--tools"), "");
  assert.ok(!a.includes("--allowedTools"));
  assert.equal(val("--mcp-config"), '{"mcpServers":{}}');
  assert.ok(a.includes("--strict-mcp-config") && a.includes("--no-session-persistence"));
  assert.equal(val("--setting-sources"), "project");
  assert.deepEqual(JSON.parse(val("--json-schema")), SCHEMA);
  assert.equal(val("--append-system-prompt"), "Be brief.");
  assert.ok(!a.includes("--system-prompt"));
  assert.equal(r.apiKey, null);
  assert.equal(r.authTok, null);
  assert.equal(fs.realpathSync(r.cwd), fs.realpathSync(os.tmpdir()));
});

test("webSearch grants WebSearch and nothing else", async () => {
  process.env.STUB_MODE = "ok";
  await judge({ model: "sonnet", prompt: "p", schema: SCHEMA, webSearch: true, system: "S" });
  const a = rec().argv;
  assert.equal(a[a.indexOf("--tools") + 1], "WebSearch");
  assert.equal(a[a.indexOf("--allowedTools") + 1], "WebSearch");
  assert.equal(a[a.indexOf("--system-prompt") + 1], "S");
});

test("not logged in is fatal; a missing structured output is not", async () => {
  process.env.STUB_MODE = "nologin";
  await assert.rejects(judge({ model: "haiku", prompt: "p", schema: SCHEMA }), (e) => e.fatal === true && /Not logged in/.test(e.message));
  process.env.STUB_MODE = "plain";
  await assert.rejects(judge({ model: "haiku", prompt: "p", schema: SCHEMA }), (e) => e.fatal === false);
  process.env.STUB_MODE = "crash";
  await assert.rejects(judge({ model: "haiku", prompt: "p", schema: SCHEMA }), (e) => e.fatal === false && /boom/.test(e.message));
});

test("an onResult that throws never fails the judgment", async () => {
  process.env.STUB_MODE = "ok";
  assert.deepEqual(await judge({ model: "haiku", prompt: "p", schema: SCHEMA, onResult: () => { throw new Error("ledger down"); } }), { verdict: "yes" });
});
