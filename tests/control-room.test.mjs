// Control room (lib/control/): cron parsing, who may use it, and the file
// actions with their undo — against a temp local dir, never the real install.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "control-"));
fs.mkdirSync(path.join(tmp, "local", "config"), { recursive: true });
fs.writeFileSync(path.join(tmp, "local", "instance.json"), JSON.stringify({ owner_name: "Sam", owner_email: "sam@example.com", tz: "Europe/Paris" }));
fs.writeFileSync(path.join(tmp, "local", "config", "demo.json"), JSON.stringify({ _comment: "demo", cap: 3, on: true }, null, 2) + "\n");
process.env.JORI_LOCAL_DIR = path.join(tmp, "local");
process.env.JORI_CONTROL_AUDIT = path.join(tmp, "audit.jsonl");
process.env.JORI_CONTROL_BACKUPS = path.join(tmp, "backups");

const S = await import("../lib/control/schedule.mjs");
const { perform } = await import("../lib/control/actions.mjs");
const { canControl } = await import("../lib/control/http.mjs");
const { history } = await import("../lib/control/audit.mjs");

test("cron lines parse into jobs, with pause markers", () => {
  const j = S.parseCronLine("*/15 * * * * /x/bin/cron-run --label trigger-hum -- /x/agent/scripts/trigger-hum.sh");
  assert.equal(j.name, "hum");
  assert.equal(j.schedule, "*/15 * * * *");
  assert.equal(j.tag, "--label trigger-hum --");
  assert.equal(S.parseCronLine("#PAUSED# 0 8 * * * /x/cron-run --label a -- b").paused, "PAUSED");
  assert.equal(S.parseCronLine("#MKTPAUSE# 0 8 * * * /x/cron-run --label a -- b").paused, "MKTPAUSE");
  assert.equal(S.parseCronLine("# a plain comment"), null);
  assert.equal(S.parseCronLine("PATH=/usr/bin"), null);
});

test("validCron accepts real schedules and refuses junk", () => {
  for (const ok of ["0 8 * * *", "*/10 * * * *", "15,45 * * * *", "55 1 * * 1,5", "30 0 1 * *"]) assert.ok(S.validCron(ok), ok);
  for (const bad of ["", "0 8 * *", "61 * * * *", "0 25 * * *", "0 8 * * * rm", "a b c d e", "0 8 * * 8"]) assert.ok(!S.validCron(bad), bad);
});

test("only the owner may use it through Access; tailnet and loopback without", () => {
  assert.ok(canControl({ email: "sam@example.com", viaAccess: true }));
  assert.ok(canControl({ email: "SAM@example.com", viaAccess: true }));
  assert.ok(!canControl({ email: "pat@example.com", viaAccess: true }));
  assert.ok(canControl({ remote: "127.0.0.1" }));
  assert.ok(canControl({ remote: "::ffff:100.108.95.34" }));
  assert.ok(!canControl({ remote: "192.168.1.20" }));
  assert.ok(!canControl({ remote: "100.200.1.1" }));
});

test("config.save refuses bad JSON and bad names, writes with backup, and undoes", async () => {
  await assert.rejects(perform("config.save", { name: "demo", text: "{nope" }, "t"), /does not parse/);
  await assert.rejects(perform("config.save", { name: "../instance", text: "{}" }, "t"), /bad settings name/);
  await assert.rejects(perform("config.save", { name: "demo", text: "[1,2]" }, "t"), /JSON object/);
  const e = await perform("config.save", { name: "demo", text: JSON.stringify({ _comment: "demo", cap: 5, on: true }) }, "t");
  const file = path.join(tmp, "local", "config", "demo.json");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).cap, 5);
  assert.equal(history()[0].id, e.id);
  await perform("history.revert", { id: e.id }, "t");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).cap, 3);
});

test("instance.save takes known keys only and checks the time zone", async () => {
  await assert.rejects(perform("instance.save", { values: { favourite_colour: "blue" } }, "t"), /unknown identity setting/);
  await assert.rejects(perform("instance.save", { values: { tz: "Mars/Olympus" } }, "t"), /not a time zone/);
  await perform("instance.save", { values: { assistant_name: "Ava", assistant_aliases: "Old, Older" } }, "t");
  const doc = JSON.parse(fs.readFileSync(path.join(tmp, "local", "instance.json"), "utf8"));
  assert.equal(doc.assistant_name, "Ava");
  assert.deepEqual(doc.assistant_aliases, ["Old", "Older"]);
  const inst = await import("../lib/instance.cjs");
  assert.equal(inst.default.assistantName(), "Ava");
});

test("ports.save and quiet.save validate", async () => {
  await assert.rejects(perform("ports.save", { name: "nope", port: 9999 }, "t"), /unknown port/);
  await assert.rejects(perform("ports.save", { name: "dashboard", port: 80 }, "t"), /1024/);
  await perform("ports.save", { name: "dashboard", port: 9198 }, "t");
  const ports = await import("../lib/ports.cjs");
  assert.equal(ports.default.port("dashboard"), 9198);
  await assert.rejects(perform("quiet.save", { awake_from: 22, awake_to: 8 }, "t"), /start before end/);
  await perform("quiet.save", { awake_from: 7, awake_to: 23 }, "t");
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, "local", "config", "quiet-hours.json"), "utf8")).awake_from, 7);
});

test("unknown actions are refused", async () => {
  await assert.rejects(perform("shell.exec", {}, "t"), /unknown action/);
});

test("Jev settings: thresholds validated, a site override set and cleared, blanks left alone", async () => {
  const { applyJevChange } = await import("../lib/control/jev.mjs");
  const base = { default_threshold: 0.85, budget: { usd: 10, since: "2026-10-05" }, sites: {} };
  assert.throws(() => applyJevChange(base, { default_threshold: 1.5 }), /at most 1/);
  assert.throws(() => applyJevChange(base, { site: "../x", enabled: false }), /bad site/);
  const off = applyJevChange(base, { site: "email-triage", enabled: "false", threshold: "0.9" });
  assert.deepEqual(off.sites["email-triage"], { enabled: false, threshold: 0.9 });
  const back = applyJevChange(off, { site: "email-triage", enabled: "true", threshold: "" });
  assert.equal(back.sites["email-triage"], undefined);
  const form = applyJevChange(base, { default_threshold: "0.8", privacy_exclusions: "true", budget_usd: "25", budget_since: "" });
  assert.equal(form.default_threshold, 0.8);
  assert.equal(form.privacy_exclusions, true);
  assert.deepEqual(form.budget, { usd: 25, since: "2026-10-05" });
  assert.equal(base.default_threshold, 0.85, "input not mutated");
});
