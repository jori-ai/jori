// bin/newsletter-digest-run — which mail it reads. The query is built from the
// local config; with nothing configured the job is off (no query, no Gmail).
import { SYNTHETIC, writeLocalConfig } from "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildQuery, loadConfig, DEFAULTS } from "../bin/newsletter-digest-run";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "newsletter-digest-run");

test("no senders configured → no query (the job is off)", () => {
  assert.deepEqual(loadConfig(), { ...DEFAULTS });
  assert.equal(buildQuery(DEFAULTS), null);
});

test("the query ORs senders and aliases, drops spam and the agent's own mail", () => {
  const q = buildQuery({ from: ["letters.example", "news@paper.example"], delivered_to: ["owner+news@example.com"], window: "2d" });
  assert.equal(q, `newer_than:2d -in:spam -label:spam -from:${SYNTHETIC.agent_email} (from:letters.example OR from:news@paper.example OR deliveredto:owner+news@example.com)`);
  assert.equal(buildQuery({ from: ["a.example"] }, { own: [] }), "newer_than:1d -in:spam -label:spam (from:a.example)");
});

test("the local config overrides the defaults", () => {
  writeLocalConfig("newsletter-digest", { from: ["letters.example"], max_messages: 5 });
  const c = loadConfig();
  assert.deepEqual(c.from, ["letters.example"]);
  assert.equal(c.max_messages, 5);
  assert.equal(c.window, "1d");
});

test("run with nothing configured: exits 0 without touching Gmail", () => {
  const r = spawnSync(process.execPath, [BIN, "--dry-run"], { encoding: "utf8", env: { ...process.env, JORI_LOCAL_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "nl-digest-")) } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no newsletter senders configured/);
});
