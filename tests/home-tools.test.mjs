// home-tools: agent/tools-mcp/modules/home.mjs — the homectl contract's MCP tools.
// A synthetic config (fake rooms and vendor subcommands) and a stub `run` that
// records the argv: nothing is executed, no device is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "home-tools-"));
// An empty installation (no bin/homectl) unless a case binds one.
process.env.JORI_HOME = path.join(tmp, "install");
fs.mkdirSync(path.join(process.env.JORI_HOME, "bin"), { recursive: true });
delete process.env.HOMECTL_BIN;

const mod = await import("../agent/tools-mcp/modules/home.mjs");

function setup({ config, bind } = {}) {
  const local = fs.mkdtempSync(path.join(tmp, "local-"));
  fs.mkdirSync(path.join(local, "config"));
  if (config) fs.writeFileSync(path.join(local, "config", "home-devices.json"), JSON.stringify(config));
  process.env.JORI_LOCAL_DIR = local;
  delete process.env.HOMECTL_BIN;
  if (bind) {
    const bin = path.join(tmp, `homectl-${path.basename(local)}`);
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    process.env.HOMECTL_BIN = bin;
    return bin;
  }
  return null;
}

function served() {
  const calls = [];
  const run = async (cmd, args) => { calls.push([cmd, ...args]); return "ok"; };
  const tools = Object.fromEntries(mod.tools({ run }).map((t) => [t.name, t]));
  return { tools, calls };
}

test("fresh install: every tool is listed and answers 'not configured' without running anything", async () => {
  setup();
  const { tools, calls } = served();
  assert.deepEqual(Object.keys(tools).sort(), [
    "homectl", "lights_brightness", "lights_off", "lights_on", "lights_status",
    "lock_lock", "lock_status", "lock_unlock", "shades_close", "shades_open", "tv_off", "tv_on",
  ]);
  for (const t of Object.values(tools)) assert.equal(await t.run({ level: 10, command: "x y" }), mod.NOT_CONFIGURED);
  assert.deepEqual(calls, []);
  assert.equal(mod.homectlBin({}), null);
  // No rooms configured: room is a free string.
  assert.equal(tools.lights_on.schema.properties.room.enum, undefined);
});

test("configured: each kind calls its configured homectl subcommand", async () => {
  const bin = setup({
    bind: true,
    config: { rooms: ["den", "loft"], commands: { lights: ["acmelight"], shades: ["acmeshade", "blind"] } },
  });
  const { tools, calls } = served();
  assert.deepEqual(tools.lights_on.schema.properties.room.enum, ["den", "loft"]);
  await tools.lights_on.run({ room: "den" });
  await tools.lights_off.run({});
  await tools.lights_brightness.run({ level: 40, room: "loft" });
  await tools.lights_status.run({});
  await tools.shades_open.run({});
  await tools.shades_close.run({});
  await tools.lock_status.run({});
  await tools.lock_lock.run({});
  await tools.lock_unlock.run({});
  await tools.tv_on.run({});
  await tools.tv_off.run({});
  await tools.homectl.run({ command: "fan  on" });
  assert.deepEqual(calls, [
    [bin, "acmelight", "on", "den"],
    [bin, "acmelight", "off"],
    [bin, "acmelight", "brightness", "40", "loft"],
    [bin, "acmelight", "status"],
    [bin, "acmeshade", "blind", "open"],
    [bin, "acmeshade", "blind", "close"],
    [bin, "lock", "status"],
    [bin, "lock", "lock"],
    [bin, "lock", "unlock"],
    [bin, "tv", "on"],
    [bin, "tv", "off"],
    [bin, "fan", "on"],
  ]);
});

test("default subcommands are the kind names", async () => {
  setup({ bind: true, config: {} });
  const { tools, calls } = served();
  await tools.lights_on.run({});
  await tools.shades_open.run({});
  assert.deepEqual(calls.map((c) => c.slice(1)), [["lights", "on"], ["shades", "open"]]);
});

test("homectl is found at the installation's bin/homectl, then config, with HOMECTL_BIN first", () => {
  setup();
  const installed = path.join(process.env.JORI_HOME, "bin", "homectl");
  const target = path.join(tmp, "venv-homectl");
  fs.writeFileSync(target, "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync(target, installed);
  try {
    assert.equal(mod.homectlBin({}), installed);
    const cfgBin = path.join(tmp, "cfg-homectl");
    fs.writeFileSync(cfgBin, "");
    assert.equal(mod.homectlBin({ homectl_bin: ["/nonexistent/homectl", cfgBin] }), cfgBin);
    process.env.HOMECTL_BIN = target;
    assert.equal(mod.homectlBin({ homectl_bin: cfgBin }), target);
  } finally {
    fs.unlinkSync(installed);
    delete process.env.HOMECTL_BIN;
  }
  // A dangling bind is no bind.
  fs.symlinkSync(path.join(tmp, "gone"), installed);
  try { assert.equal(mod.homectlBin({}), null); } finally { fs.unlinkSync(installed); }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
