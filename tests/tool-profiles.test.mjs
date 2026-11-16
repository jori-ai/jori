// agent/tools-mcp/profiles.mjs + agent/config/tool-profiles.json — which
// tools a session gets (docs/agent-secrets.md § Tool profiles).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProfiles, resolveProfile, allowsTool, callRefusal } from "../agent/tools-mcp/profiles.mjs";

const noLocal = fs.mkdtempSync(path.join(os.tmpdir(), "tp-"));
const P = loadProfiles({ localDir: noLocal });

test("kernel profiles exist and unset/unknown fall back to full with a warning", () => {
  for (const n of ["full", "ops", "triage", "watcher"]) assert.ok(P[n], n);
  assert.equal(resolveProfile("", P).name, "full");
  assert.match(resolveProfile("", P).warning, /not set/);
  assert.match(resolveProfile("nope", P).warning, /unknown/);
  assert.equal(resolveProfile("ops", P).warning, undefined);
});

test("full serves everything; ops and triage drop home actuation", () => {
  assert.equal(allowsTool(P.full, "lock_unlock"), true);
  for (const p of [P.ops, P.triage, P.watcher]) {
    for (const t of ["lock_unlock", "lock_lock", "lights_on", "shades_open", "resy_snipe", "imsg_callerid_set"]) {
      assert.equal(allowsTool(p, t), false, t);
    }
  }
  // What the tiers actually used in the 30 days the profiles were drawn from.
  for (const t of ["wiki_search", "recall", "gmail_label_read", "email_mem_add", "places_nearby", "homectl", "lights_status", "check_later", "notify_user"]) {
    assert.equal(allowsTool(P.ops, t), true, `ops ${t}`);
  }
  for (const t of ["gmail_label_read", "gmail_label", "spam_block", "email_mem_add", "location_commute", "imsg_send", "notify_user", "repl_run"]) {
    assert.equal(allowsTool(P.triage, t), true, `triage ${t}`);
  }
  assert.equal(allowsTool(P.triage, "whatsapp_send"), false);
  assert.equal(allowsTool(P.triage, "homectl"), false);
});

test("watcher is an allowlist", () => {
  assert.equal(allowsTool(P.watcher, "whereami"), true);
  assert.equal(allowsTool(P.watcher, "wiki_read"), true);
  assert.equal(allowsTool(P.watcher, "imsg_send"), false);
  assert.equal(allowsTool(P.watcher, "gmail_label"), false);
  assert.equal(allowsTool(P.watcher, "location_annotate"), false);
  assert.equal(allowsTool(P.watcher, "some_new_tool"), false);
});

test("homectl read-only refuses commands that change the home", () => {
  assert.equal(callRefusal("ops", P.ops, "homectl", { command: "ring status \"VB Pool\"" }), null);
  assert.equal(callRefusal("ops", P.ops, "homectl", { command: "network status" }), null);
  assert.match(callRefusal("ops", P.ops, "homectl", { command: "lock unlock front" }), /read-only/);
  assert.match(callRefusal("ops", P.ops, "homectl", { command: "door enter lobby" }), /read-only/);
  assert.match(callRefusal("triage", P.triage, "homectl", { command: "ring status" }), /not available/);
  assert.equal(callRefusal("full", P.full, "homectl", { command: "lock unlock front" }), null);
});

test("an installation profile replaces the kernel one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-"));
  fs.mkdirSync(path.join(dir, "config"));
  fs.writeFileSync(path.join(dir, "config", "tool-profiles.json"), JSON.stringify({ profiles: { ops: { deny: ["x"] } } }));
  const L = loadProfiles({ localDir: dir });
  assert.equal(allowsTool(L.ops, "lock_unlock"), true);
  assert.equal(allowsTool(L.ops, "x"), false);
});
