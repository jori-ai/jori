// email-triage.mjs — MCP server for the strict email-triage one-shot
// (bin/email-triage-run). The tools and their bounds live in
// lib/email-triage-tools.mjs; this file only serves them for ONE bound email.
//
// Env (set by the runner in the one-shot's --mcp-config, nothing else):
//   TRIAGE_MESSAGE_ID, TRIAGE_FROM, TRIAGE_SUBJECT, TRIAGE_DATE  the email
//   TRIAGE_STAMPS  intake's stamp codes, comma-separated (a standing P1 cannot be undone)
//   TRIAGE_STATE   a JSON-lines file each changing tool appends to
//   TRIAGE_DRY=1   record what would change, change nothing
// Design: docs/email-triage-strict.md.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { makeTools } from "../../lib/email-triage-tools.mjs";

const require = createRequire(import.meta.url);
const { TOOLS_DIR } = require("../../lib/root.cjs");
const exec = promisify(execFile);
const GOG = process.env.GOG_BIN || "/opt/homebrew/bin/gog";

const STATE = process.env.TRIAGE_STATE || "";
const record = (entry) => { if (STATE) try { fs.appendFileSync(STATE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"); } catch {} };

async function run(bin, args) {
  const file = bin === "gog" ? GOG : path.join(TOOLS_DIR, "bin", bin);
  const { stdout } = await exec(file, args, { timeout: 90_000, maxBuffer: 8 << 20, env: { ...process.env, JORI_TRIAGE_ACTOR: "agent" } });
  return stdout;
}

const tools = makeTools({
  bound: {
    messageId: process.env.TRIAGE_MESSAGE_ID || "",
    from: process.env.TRIAGE_FROM || "",
    subject: process.env.TRIAGE_SUBJECT || "",
    dateIso: process.env.TRIAGE_DATE || "",
    stamps: String(process.env.TRIAGE_STAMPS || "").split(",").filter(Boolean),
  },
  run, record, dry: process.env.TRIAGE_DRY === "1",
});

const server = new Server({ name: "email-triage", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) return { content: [{ type: "text", text: `unknown tool ${req.params.name}` }], isError: true };
  record({ call: tool.name });
  try {
    const out = await tool.run(req.params.arguments || {});
    if (tool.name === "triage_rules" && out?.pages) record({ rules: req.params.arguments?.part, page: out.page, pages: out.pages });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `error: ${String(err.stderr || err.message).slice(0, 600)}` }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
