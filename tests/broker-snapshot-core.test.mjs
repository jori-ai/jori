// lib/broker-snapshot-core.js — the rows bin/broker-snapshot writes and the
// wording of its two guard alerts, plus the OFF behaviour of the adapter
// CLIs on an installation with no broker bridge configured.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { buildRows, emptyMessage, partialMessage, EMPTY_STREAK_ESCALATE } = require("../lib/broker-snapshot-core.js");
const KERNEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CFG = {
  label: "brokerage",
  app_label: "the broker bridge app",
  reauth_base: "https://bridge.example.test/tokens?reauth=",
  snapshot_command: "broker-snapshot",
  downstream_note: "",
  tz: "UTC",
};

test("rows: accounts, positions and the day's totals", () => {
  const nowIso = "2026-01-13T21:45:00.000Z";
  const r = buildRows([
    { accountHash: "a1", accountName: "Joint", cashBalance: "100", totalValue: "1100",
      positions: [{ ticker: "AAA", shares: "2", marketValue: "1000", assetType: "EQUITY" }] },
    { accountHash: "a2", accountName: null, cashBalance: null, totalValue: 500, positions: [] },
  ], nowIso);
  assert.equal(r.accountRows.length, 2);
  assert.equal(r.positionRows.length, 1);
  assert.equal(r.totalValue, 1600);
  assert.equal(r.cashTotal, 100);
  assert.equal(r.positionsValue, 1500);
  assert.equal(r.positionRows[0].shares, 2);
  assert.equal(r.accountRows[1].account_name, null);
  assert.ok(r.accountRows.every((a) => a.as_of === nowIso));
});

test("empty, run 1, no lapse on disk: reports, reassures, blames nothing", () => {
  const msg = emptyMessage({ streak: { count: 1, since: "2026-01-13T21:45:00Z" }, lapsed: [], cfg: CFG });
  assert.match(msg, /^⚠️ Brokerage positions didn't refresh today/);
  assert.match(msg, /nothing to do yet/);
  assert.doesNotMatch(msg, /reauth=/);
});

test("empty, run 1, with a lapse on disk: never reassures past a known fact", () => {
  const msg = emptyMessage({
    streak: { count: 1, since: "2026-01-13T21:45:00Z" },
    lapsed: [{ tokenId: "primary", since: "2026-01-13T15:03:00Z" }],
    cfg: CFG,
  });
  assert.doesNotMatch(msg, /nothing to do yet/);
  assert.match(msg, /ran out on 2026-01-13/);
  assert.ok(msg.includes(`${CFG.reauth_base}primary`));
});

test("empty escalates on persistence with a different text (so dedup pages it)", () => {
  const s = { count: EMPTY_STREAK_ESCALATE, since: "2026-01-12T21:45:00Z" };
  const first = emptyMessage({ streak: { count: 1, since: s.since }, lapsed: [], cfg: CFG });
  const esc = emptyMessage({ streak: s, lapsed: [], cfg: { ...CFG, downstream_note: "The weekly memo will skip." } });
  assert.notEqual(first, esc);
  assert.match(esc, /2 runs in a row now, since 2026-01-12/);
  assert.match(esc, /The weekly memo will skip\.$/);
});

test("partial names the missing accounts and only blames a connection on evidence", () => {
  const baseline = { num_accounts: 8, total_value: 1_000_000, as_of_date: "2026-01-12" };
  const base = { cfg: CFG, incomingCount: 5, baseline, pct: 52, missingNames: ["Spouse Roth", "Spouse Trad 401k"] };
  const noEvidence = partialMessage({ ...base, streak: { count: 1, since: "2026-01-13T21:45:00Z" }, lapsed: [] });
  assert.match(noEvidence, /only sent back 5 of the 8 accounts I saw on 2026-01-12/);
  assert.match(noEvidence, /The ones missing are Spouse Roth and Spouse Trad 401k\./);
  assert.match(noEvidence, /more likely a hiccup at their end/);
  const evidence = partialMessage({ ...base, streak: { count: 1, since: "2026-01-13T21:45:00Z" }, lapsed: [{ tokenId: "secondary", since: null }] });
  assert.ok(evidence.includes(`${CFG.reauth_base}secondary`));
  assert.doesNotMatch(evidence, /hiccup/);
  const esc = partialMessage({ ...base, streak: { count: 2, since: "2026-01-12T21:45:00Z" }, lapsed: [] });
  assert.match(esc, /broker-snapshot --accept-account-drop/);
  assert.match(esc, /those accounts/);
});

test("no bridge configured: both adapter CLIs are OFF and exit 0", () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "broker-off-"));
  const env = { ...process.env, JORI_LOCAL_DIR: local, BROKER_API_URL: "", JORI_SEND_BIN: "/bin/false" };
  for (const bin of ["broker-snapshot", "broker-token-watch"]) {
    const r = spawnSync(process.execPath, [path.join(KERNEL, "bin", bin), "--json"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, `${bin}: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout.trim().split("\n").pop()).configured, false);
  }
  fs.rmSync(local, { recursive: true, force: true });
});
