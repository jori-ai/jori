// ports: lib/ports.cjs defaults must match the ports the supervisors read from
// agent/config/agents.json, and JORI_PORT_<NAME> must override a default.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { PORTS, port, localUrl } = require("../lib/ports.cjs");
const agents = JSON.parse(fs.readFileSync(new URL("../agent/config/agents.json", import.meta.url), "utf8")).agents;

// agents.json agent name → ports.cjs name prefix
const PREFIX = { chat: "chat", ops: "ops", "ops-light": "ops_light", "ops-haiku": "ops_haiku" };
const FIELD = { controlPort: "control", webhookPort: "webhook", healthPort: "health" };

test("defaults equal the supervisor ports in agents.json", () => {
  let checked = 0;
  for (const [agent, cfg] of Object.entries(agents)) {
    const sup = cfg.supervisor || {};
    for (const [field, suffix] of Object.entries(FIELD)) {
      if (sup[field] == null) continue;
      const name = `${PREFIX[agent]}_${suffix}`;
      assert.ok(PORTS[name], `ports.cjs has no ${name} (agents.${agent}.supervisor.${field})`);
      assert.equal(PORTS[name][0], sup[field], `${name} default vs agents.${agent}.supervisor.${field}`);
      checked++;
    }
    if (sup.gmailPubsubPort != null) {
      assert.equal(PORTS.gmail_pubsub[0], sup.gmailPubsubPort, `gmail_pubsub vs agents.${agent}.supervisor.gmailPubsubPort`);
      checked++;
    }
  }
  assert.ok(checked >= 10, `only ${checked} ports checked`);
});

test("JORI_PORT_OPS_HEALTH overrides the default", () => {
  const prev = process.env.JORI_PORT_OPS_HEALTH;
  try {
    process.env.JORI_PORT_OPS_HEALTH = "19193";
    assert.equal(port("ops_health"), 19193);
    assert.equal(localUrl("ops_health", "/health"), "http://127.0.0.1:19193/health");
  } finally {
    if (prev === undefined) delete process.env.JORI_PORT_OPS_HEALTH;
    else process.env.JORI_PORT_OPS_HEALTH = prev;
  }
});

test("lib/ports.py reads the same defaults as lib/ports.cjs", () => {
  const out = execFileSync("python3", ["-I", "-c", "import json,sys; sys.path.insert(0, sys.argv[1]); import ports; print(json.dumps(ports.defaults()))", new URL("../lib", import.meta.url).pathname], { encoding: "utf8" });
  const want = Object.fromEntries(Object.entries(PORTS).map(([k, [n]]) => [k, n]));
  assert.deepEqual(JSON.parse(out), want);
});

test("unknown names throw", () => {
  assert.throws(() => port("no_such_port"), /unknown port name/);
});
