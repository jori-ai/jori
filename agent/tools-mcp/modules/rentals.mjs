// tools-mcp/modules/rentals.mjs — a rental portfolio's books (bin/rentals), read-only.
// Served by agent/tools-mcp/index.mjs (loadExtTools). `after` keeps the tool at its
// place in the served tool list. The tool's name and anchor are the installation's
// (agent/local/config/rentals.json `mcp_tool_name`, `tools_after`), so a name its
// skills and playbooks already use keeps working. With no books configured
// (`firebase_project` unset) the tool stays listed and every call answers that no
// rental books are configured: the capability is off, not broken.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { localConfig } = require("../../../lib/instance.cjs");
const cfg = localConfig("rentals", { mcp_tool_name: "rentals", tools_after: "email_mem_test" });

export const after = cfg.tools_after;

export function tools({ BIN, run }) {
  return [
    {
      name: cfg.mcp_tool_name || "rentals",
      description: "The rental portfolio's books, read-only: properties, tenants, leases, the categorised ledger, P&L, and what a charge actually bought (mail receipts + the Amazon order history). Commands: overview, properties, property <name>, tenants, tenant <name>, leases, accounts, categories, transactions, pnl, orders, order <id>, receipts, where. Pass flags in `args`, e.g. command=\"pnl\", args=[\"--year\",\"2025\",\"--property\",\"<id>\"]. A property can be named any way — its id, its public slug, a name or address fragment, or a configured alias. Run `where` when unsure which store holds an answer.",
      schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Subcommand, e.g. overview | tenants | transactions | pnl | orders" },
          args: { type: "array", items: { type: "string" }, description: "Positional arguments and flags, one array element each" },
        },
        required: ["command"],
      },
      // 60s rather than the default 30: a whole-year ledger read is two Firestore
      // queries and a Supabase round trip, and a timeout here reads as "jori
      // doesn't know" rather than as slowness.
      run: (a) => run("node", [`${BIN}/rentals`, a.command, ...(a.args || [])], { timeout: 60000 }),
    },
  ];
}
