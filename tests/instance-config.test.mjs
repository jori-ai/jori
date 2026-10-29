// instance-config.test.mjs — lib/instance.cjs layering and
// lib/ext-hooks.mjs loading, on a synthetic local dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { loadHook, runHook, clearHookCache } from "../lib/ext-hooks.mjs";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "instance-"));
process.env.JORI_LOCAL_DIR = tmp;
for (const k of ["JORI_TZ", "JORI_OWNER_EMAIL", "JORI_OWNER_NAME", "JORI_OWNER_ID", "JORI_AGENT_FROM_EMAIL", "JORI_AGENT_EMAIL_ALIASES"]) delete process.env[k];
const { instance, instanceValue, agentAddresses, localConfig, ownerIdOf, supabaseAnonKey } = require("../lib/instance.cjs");

test("defaults without a local dir: generic owner, host time zone", () => {
  const inst = instance();
  assert.equal(inst.owner_name, "the user");
  assert.equal(inst.owner_email, "");
  assert.equal(inst.owner_id, "user");
  assert.ok(inst.tz.length > 0);
});

// owner_id names the stored and external identifiers that embed the owner
// (needs_<id>, manual_<id>, <id>_said, closed_by_<id>): derived from
// owner_name unless instance.json sets it, so an installation whose data
// predates the generic names keeps them.
test("owner_id: derived from owner_name, or set explicitly", () => {
  assert.equal(ownerIdOf("the user"), "user");
  assert.equal(ownerIdOf("Alex"), "alex");
  assert.equal(ownerIdOf("Sam Lee-Park"), "sam_lee_park");
  assert.equal(ownerIdOf(""), "user");
  fs.writeFileSync(path.join(tmp, "instance.json"), JSON.stringify({ owner_name: "Alex" }));
  assert.equal(instanceValue("owner_id"), "alex");
  fs.writeFileSync(path.join(tmp, "instance.json"), JSON.stringify({ owner_name: "Alex Doe", owner_id: "alex" }));
  assert.equal(instanceValue("owner_id"), "alex");
  process.env.JORI_OWNER_ID = "sam";
  assert.equal(instanceValue("owner_id"), "sam");
  delete process.env.JORI_OWNER_ID;
  fs.rmSync(path.join(tmp, "instance.json"));
});

test("local instance.json, then env, override defaults", () => {
  fs.writeFileSync(path.join(tmp, "instance.json"), JSON.stringify({ owner_email: "alex@example.com", tz: "Asia/Tokyo" }));
  assert.equal(instanceValue("owner_email"), "alex@example.com");
  assert.equal(instanceValue("tz"), "Asia/Tokyo");
  process.env.JORI_TZ = "Europe/Rome";
  assert.equal(instanceValue("tz"), "Europe/Rome");
  delete process.env.JORI_TZ;
  assert.throws(() => instanceValue("nope"), /unknown instance key/);
});

test("localConfig merges, replaces arrays, appends extend_ keys, skips _comment", () => {
  fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "config", "lanes.json"), JSON.stringify({ _comment: "x", live: ["a"], extend_extra: ["c"], n: 2 }));
  const cfg = localConfig("lanes", { live: ["z"], extra: ["b"], n: 1, keep: true });
  assert.deepEqual(cfg, { live: ["a"], extra: ["b", "c"], n: 2, keep: true });
  assert.deepEqual(localConfig("missing", { a: 1 }), { a: 1 });
});

test("supabaseAnonKey: one home, local config supabase.json anon_key", () => {
  assert.equal(supabaseAnonKey(), "");
  fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "config", "supabase.json"), JSON.stringify({ anon_key: "anon-123" }));
  assert.equal(supabaseAnonKey(), "anon-123");
  fs.rmSync(path.join(tmp, "config", "supabase.json"));
});

// After a rename the old address still reaches the agent and is still its own.
test("agentAddresses: the sending address first, then its aliases, lowercased and deduped", () => {
  assert.deepEqual(agentAddresses(), []);
  fs.writeFileSync(path.join(tmp, "instance.json"), JSON.stringify({ agent_email: "New@example.com", agent_email_aliases: ["old@example.com", "new@example.com"] }));
  assert.deepEqual(agentAddresses(), ["new@example.com", "old@example.com"]);
  process.env.JORI_AGENT_EMAIL_ALIASES = "a@example.com, b@example.com";
  assert.deepEqual(agentAddresses(), ["new@example.com", "a@example.com", "b@example.com"]);
  delete process.env.JORI_AGENT_EMAIL_ALIASES;
  fs.rmSync(path.join(tmp, "instance.json"));
});

test("a malformed local file is an error, not a silent default", () => {
  fs.writeFileSync(path.join(tmp, "config", "bad.json"), "{nope");
  assert.throws(() => localConfig("bad", {}), /bad\.json/);
});

test("ext hooks: absent → fallback; present → called", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-"));
  assert.equal(await loadHook(dir, "greet"), null);
  assert.equal(await runHook(dir, "greet", "hello", ["Sam"], "fallback"), "fallback");
  fs.mkdirSync(path.join(dir, "_ext"));
  fs.writeFileSync(path.join(dir, "_ext", "greet.mjs"), "export function hello(n) { return `hi ${n}`; }\n");
  clearHookCache();
  assert.equal(await runHook(dir, "greet", "hello", ["Sam"], "fallback"), "hi Sam");
  assert.equal(await runHook(dir, "greet", "absent", [], 7), 7);
});
