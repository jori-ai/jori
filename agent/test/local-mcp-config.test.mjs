// localMcpConfigs: the installation's agent/local/mcp/<name>.json files that
// ride beside the kernel's MCP set, matched by base config name or agent dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localMcpConfigs } from "../supervisor/claude-session.mjs";

test("no local mcp dir: the kernel set alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lmcp-"));
  assert.deepEqual(localMcpConfigs({ mcpConfig: "/x/agent/supervisor/chat-mcp-config.json", cwd: "/x/agent/chat-agent" }, dir), []);
});

test("matches the base config name and the agent directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lmcp-"));
  fs.mkdirSync(path.join(dir, "mcp"));
  for (const n of ["chat-mcp-config", "ops-light-agent", "unrelated"]) fs.writeFileSync(path.join(dir, "mcp", `${n}.json`), "{}");
  assert.deepEqual(localMcpConfigs({ mcpConfig: "/x/agent/supervisor/chat-mcp-config.json", cwd: "/x/agent/chat-agent" }, dir), [path.join(dir, "mcp", "chat-mcp-config.json")]);
  assert.deepEqual(localMcpConfigs({ cwd: "/x/agent/ops-light-agent" }, dir), [path.join(dir, "mcp", "ops-light-agent.json")]);
});

test("an inline JSON config names no file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lmcp-"));
  fs.mkdirSync(path.join(dir, "mcp"));
  assert.deepEqual(localMcpConfigs({ mcpConfig: '{"mcpServers":{}}' }, dir), []);
});
