// family-qa.mjs — the ENTIRE tool surface of the family Q&A responder.
//
// bin/family-qa runs a stateless `claude -p` with built-in tools
// disabled (--tools "") and --strict-mcp-config pointing at THIS server only,
// so these four read-only tools are all a family member's question can reach.
// No Gmail, no browser, no shell, no actions.
//
// Scope: every wiki result is filtered by the requester's wiki share scope
// (lib/wiki-scope.js over data/wiki-share-scopes.json) minus their
// `email_deny_ids` — an out-of-scope page is indistinguishable from a missing
// one. A family member usually inherits another identity's scope. No scopes
// file means nobody qualifies. `finance_snapshot` is `net-worth --json --no-snapshot`:
// totals and per-holding values only, never transactions or account numbers
// (CLAUDE.md § Financial Operations, family Q&A carve-out).

import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const require = createRequire(import.meta.url);
const ws = require("../../lib/wiki-store.js");
const { emailQaIdentityFromConfig } = require("../../lib/wiki-scope.js");
const exec = promisify(execFile);

const ROOT = new URL("../..", import.meta.url).pathname;
const REQUESTER = String(process.env.FAMILY_QA_EMAIL || "").toLowerCase();
let scopes = {};
try { scopes = JSON.parse(fs.readFileSync(`${ROOT}data/wiki-share-scopes.json`, "utf8")); }
catch (e) { if (e.code !== "ENOENT") throw e; }
// Fail closed: a sender without `email_qa` gets nothing from this server. The
// email scope is the site scope minus the identity's `email_deny_ids`
// (passwords/codes live in 1Password, never in an email).
const who = emailQaIdentityFromConfig(scopes, REQUESTER);
const canRead = (id) => !!who && who.canRead(id);

const TOOLS = [
  {
    name: "wiki_search",
    description: "Full-text search of the family wiki. Returns page ids, titles and a snippet.",
    schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    run: ({ query }) => {
      const hits = ws.searchPages(String(query || ""), { mode: "fts", limit: 60 })
        .filter((h) => canRead(h.id)).slice(0, 10)
        .map((h) => ({ id: h.id, title: h.title, description: h.description, snippet: String(h.body_md || "").slice(0, 300) }));
      return { query, results: hits };
    },
  },
  {
    name: "wiki_read",
    description: "Read one wiki page by id.",
    schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: ({ id }) => {
      const pid = String(id || "").replace(/\.md$/, "");
      const row = canRead(pid) ? ws.getPage(pid) : null;
      if (!row) return { error: `no page ${pid}` };
      return { id: row.id, title: row.title, description: row.description, updated_at: row.updated_at, body: row.body_md };
    },
  },
  {
    name: "wiki_list",
    description: "List every readable page id + title (optionally only ids starting with a prefix, e.g. travel_).",
    schema: { type: "object", properties: { prefix: { type: "string" } } },
    run: ({ prefix } = {}) => ({
      pages: ws.listPages({ status: "active" })
        .filter((p) => canRead(p.id) && (!prefix || p.id.startsWith(prefix)))
        .map((p) => ({ id: p.id, title: p.title })),
    }),
  },
  {
    name: "finance_snapshot",
    description: "Live family net worth: totals and per-holding values across bank, brokerage, crypto and property, computed in code. No transactions, no account numbers.",
    schema: { type: "object", properties: {} },
    run: async () => {
      if (!who) return { error: "not available" };
      const { stdout } = await exec(`${ROOT}bin/net-worth`, ["--json", "--no-snapshot"], { timeout: 120_000, maxBuffer: 8 << 20 });
      return JSON.parse(stdout);
    },
  },
];

const server = new Server({ name: "family-qa", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) return { content: [{ type: "text", text: `unknown tool ${req.params.name}` }], isError: true };
  try {
    const out = await tool.run(req.params.arguments || {});
    ws.logAccess?.({ tool: `family_qa.${tool.name}`, page_ids: [], caller: `family-qa:${REQUESTER}` });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `error: ${err.message}` }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
