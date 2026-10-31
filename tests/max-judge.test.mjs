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
  else if (mode === "text") process.stdout.write(JSON.stringify({ is_error: false, result: '{"emit":false}', session_id: "sess-text-1", num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 600, cache_creation_input_tokens: 2100 } }));
  else if (mode === "rawtext") { process.stdout.write("Not logged in"); process.exit(1); }
  else { process.stderr.write("boom"); process.exit(1); }
});
`);
fs.chmodSync(STUB, 0o755);
process.env.CLAUDE_BIN = STUB;
process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
process.env.ANTHROPIC_AUTH_TOKEN = "tok-test-not-real";
const require = createRequire(import.meta.url);
const { judge, textSync, maxOnlyEnv, CLAUDE_BIN } = require("../lib/max-judge.js");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
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

// textSync: the synchronous tool-less TEXT call for one-shot readings (hum
// harvesters, ladder rungs), which also writes the run's cost row.
test("textSync is tool-less, MCP-less, prompt on stdin, from tmp, no API key, and records its run", () => {
  process.env.STUB_MODE = "text";
  const ledger = path.join(dir, "fork-ledger.ndjson");
  process.env.JORI_FORK_COST_LEDGER = ledger;
  try {
    const out = textSync({ model: "sonnet", prompt: "Anything worth saying?", job: "test:textsync" });
    assert.equal(out.status, 0);
    assert.equal(out.isError, false);
    assert.equal(out.text, '{"emit":false}');
    const r = rec();
    const a = r.argv;
    const val = (f) => a[a.indexOf(f) + 1];
    assert.equal(r.input, "Anything worth saying?");
    assert.ok(!a.includes("Anything worth saying?"), "the prompt is not a positional argument");
    assert.equal(val("--tools"), "");
    assert.equal(val("--mcp-config"), '{"mcpServers":{}}');
    assert.ok(a.includes("--strict-mcp-config") && a.includes("--no-session-persistence"));
    assert.equal(val("--setting-sources"), "project");
    assert.equal(val("--output-format"), "json");
    assert.ok(!a.includes("--json-schema"));
    assert.equal(r.apiKey, null);
    assert.equal(r.authTok, null);
    assert.equal(fs.realpathSync(r.cwd), fs.realpathSync(os.tmpdir()));
    const rows = fs.readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "test:textsync");
    assert.equal(rows[0].cache_creation_tokens, 2100);
    assert.equal(rows[0].runner, "ephemeral-fork");
  } finally { delete process.env.JORI_FORK_COST_LEDGER; }
});

test("textSync never throws: a failed or non-JSON run comes back as a status with the raw text", () => {
  process.env.STUB_MODE = "rawtext";
  const out = textSync({ model: "sonnet", prompt: "p" });
  assert.equal(out.status, 1);
  assert.equal(out.text, "Not logged in");
  process.env.STUB_MODE = "nologin";
  assert.equal(textSync({ model: "sonnet", prompt: "p" }).isError, true);
});

test("the one-shot text callers go through textSync, not their own claude -p", () => {
  for (const rel of ["agent/scripts/hum-harvesters/situation.mjs", "agent/scripts/hum-harvesters/nearby.mjs", "bin/day-statements"]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(src.includes("textSync("), `${rel} does not call textSync`);
    assert.ok(!/\[\s*"-p",/.test(src), `${rel} still builds its own claude -p argv`);
  }
});
