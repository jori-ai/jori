// tools-mcp-location.test.mjs — the kernel's optional location tools
// (agent/tools-mcp/modules/location.mjs): stable names, the installation's
// anchor, the owner's name in the descriptions, and "not installed" (never a
// spawn error) when a bin is absent.
// Run: node --test tests/tools-mcp-location.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-location-"));
fs.mkdirSync(path.join(LOCAL, "config"));
fs.writeFileSync(path.join(LOCAL, "instance.json"), JSON.stringify({ owner_name: "Alex" }));
fs.writeFileSync(path.join(LOCAL, "config", "location-tools.json"), JSON.stringify({ tools_after: "some_tool" }));
process.env.JORI_LOCAL_DIR = LOCAL;
const m = await import("../agent/tools-mcp/modules/location.mjs");

const NAMES = ["whereami", "location_wake", "location_track", "location_stops", "location_segment", "geofence_check",
  "location_pattern", "location_commute", "location_annotate", "findme_locate", "findme_history", "findme_activity", "findme_list"];

test("the tool list, its anchor and the owner's name", () => {
  const tools = m.tools({ BIN: "/nonexistent", run: () => "ran" });
  assert.deepEqual(tools.map((t) => t.name), NAMES);
  assert.equal(m.after, "some_tool");
  assert.ok(tools.find((t) => t.name === "whereami").description.includes("for Alex"));
});

test("a bin that is not installed answers so; an installed one runs with its args", async () => {
  const off = m.tools({ BIN: "/nonexistent", run: () => "ran" });
  assert.match(await off.find((t) => t.name === "findme_list").run({}), /not installed/);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-location-bin-"));
  fs.writeFileSync(path.join(bin, "geofence-check"), "");
  const calls = [];
  const on = m.tools({ BIN: bin, run: (b, a) => { calls.push([path.basename(b), a]); return "ran"; } });
  assert.equal(await on.find((t) => t.name === "geofence_check").run({ target: "home", radius_km: 0.3 }), "ran");
  assert.deepEqual(calls, [["geofence-check", ["home", "--radius", "0.3"]]]);
});
