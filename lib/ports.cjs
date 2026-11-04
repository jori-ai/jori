"use strict";
// ports.cjs — the one registry of the local ports Jori's processes listen on.
//
// Before this, each port number was written into every file that talks to it
// (9092 in ~40 places). A move to a machine where a port is taken meant a
// search through code. Now callers ask:
//
//   const { port, localUrl } = require("../lib/ports.cjs");
//   port("ops_health")            → 9093
//   localUrl("ops_health", "/health") → "http://127.0.0.1:9093/health"
//
// The supervisors read theirs from agent/config/agents.json; these defaults
// match it, and tests/ports.test.mjs keeps the two equal.
//
// Layers (later wins): the defaults below, agent/local/config/ports.json
// (`{ "ops_health": 9193 }`), then JORI_PORT_<NAME> (JORI_PORT_OPS_HEALTH).
// Shell scripts: `node lib/ports.cjs ops_health` prints the number;
// `node lib/ports.cjs --env` prints JORI_PORT_<NAME>=<n> lines to eval.
// The control room's Machine page lists and edits these.

const { localConfig } = require("./instance.cjs");

// name → [default port, what listens there]
const PORTS = {
  ops_haiku_control: [9071, "Ops Haiku supervisor control"],
  ops_haiku_webhook: [9072, "Ops Haiku supervisor webhook"],
  ops_haiku_health: [9073, "Ops Haiku supervisor health"],
  ops_light_control: [9081, "Ops light supervisor control"],
  ops_light_webhook: [9082, "Ops light supervisor webhook"],
  ops_light_health: [9083, "Ops light supervisor health"],
  shop_view: [9086, "Shop view"],
  gmail_pubsub: [9090, "Gmail push receiver"],
  ops_control: [9091, "Ops supervisor control"],
  ops_webhook: [9092, "Ops supervisor webhook (job dispatch)"],
  ops_health: [9093, "Ops supervisor health"],
  chat_health: [9094, "Chat supervisor health, dispatch and restart"],
  process_manager: [9095, "Process manager"],
  wiki: [9096, "Memory site and control room (tailnet)"],
  wiki_public: [9097, "Memory site origin behind Cloudflare Access"],
  dashboard: [9098, "Live dashboard"],
  setup: [9087, "First-run setup page (jori setup, only while it runs)"],
  whatsapp: [9100, "WhatsApp gateway"],
  imessage: [9107, "iMessage channel"],
  slack: [9108, "Slack channel"],
  chrome_cdp: [9222, "Chrome remote debugging (main profile)"],
  chrome_cdp_shop: [9224, "Chrome remote debugging (shop profile, purchases)"],
  chrome_cdp_alt: [9333, "Chrome remote debugging (second profile; headless cruise reader)"],
};

function table() {
  const local = localConfig("ports", {});
  const out = {};
  for (const [name, [def, label]] of Object.entries(PORTS)) {
    let n = def;
    if (Number.isInteger(local[name])) n = local[name];
    const env = process.env[`JORI_PORT_${name.toUpperCase()}`];
    if (env && /^\d+$/.test(env)) n = Number(env);
    out[name] = { port: n, default: def, label };
  }
  return out;
}

function port(name) {
  const row = table()[name];
  if (!row) throw new Error(`unknown port name: ${name}`);
  return row.port;
}

function localUrl(name, pathname = "") {
  return `http://127.0.0.1:${port(name)}${pathname}`;
}

module.exports = { PORTS, table, port, localUrl };

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === "--env") {
    for (const [name, row] of Object.entries(table())) process.stdout.write(`JORI_PORT_${name.toUpperCase()}=${row.port}\n`);
  } else if (arg) {
    process.stdout.write(String(port(arg)) + "\n");
  } else {
    for (const [name, row] of Object.entries(table())) process.stdout.write(`${String(row.port).padEnd(6)} ${name.padEnd(20)} ${row.label}\n`);
  }
}
