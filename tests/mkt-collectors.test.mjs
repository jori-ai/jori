// The marketing module's Node tools: bin/mkt-actions (the action ledger),
// bin/mkt-conversion-collect (the paid funnel) and bin/mkt-metrics-collect.
//
// Off: with no agent/local/config/marketing.json the collectors exit 0 and
// write nothing, and mkt-actions reads an absent ledger as empty. On: the
// ledger lists, retires and completes rows atomically, and its "manual" scope
// is the installation's owner id (so rows written before keep matching); the
// conversion collector builds per-creative rows and totals from the upstream
// collectors' state, parses each ad's af_ad out of its click URL, and — with no
// GA4 or AppsFlyer credentials — falls back to the App Store install total and
// says so. Synthetic ads, ids and numbers; nothing reaches a network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "bin");
const dirs = [];
function sandbox(cfg, instance = { owner_name: "Sam Example", owner_id: "sam" }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-home-"));
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-local-"));
  dirs.push(home, local);
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.mkdirSync(path.join(local, "config"), { recursive: true });
  if (instance) fs.writeFileSync(path.join(local, "instance.json"), JSON.stringify(instance));
  if (cfg) fs.writeFileSync(path.join(local, "config", "marketing.json"), JSON.stringify(cfg));
  return { home, local, data: (f) => path.join(home, "data", f) };
}
function run(sb, tool, args = []) {
  return spawnSync(process.execPath, [path.join(BIN, tool), ...args], {
    env: { ...process.env, JORI_HOME: sb.home, JORI_LOCAL_DIR: sb.local, HOME: sb.home },
    encoding: "utf8",
    timeout: 30000,
  });
}
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test("collectors are off without marketing.json and write nothing", () => {
  const sb = sandbox(null);
  for (const tool of ["mkt-conversion-collect", "mkt-metrics-collect"]) {
    const r = run(sb, tool);
    assert.equal(r.status, 0, `${tool}: ${r.stderr}`);
    assert.match(r.stdout, /not configured/);
  }
  assert.deepEqual(fs.readdirSync(path.join(sb.home, "data")), []);
  const r = run(sb, "mkt-actions", ["stats"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Ledger: 0 actions total/);
});

test("ledger: manual scope is the owner id; retire and complete are atomic and noted", () => {
  const sb = sandbox(null);
  const old = new Date(Date.now() - 20 * 86400000).toISOString();
  fs.writeFileSync(sb.data("mkt-actions-state.json"), JSON.stringify({ actions: [
    { id: "a1", status: "proposed", scope: "jori_autonomous", estimated_impact: "low", title: "Shorten a page title", created_at: old },
    { id: "a2", status: "in_progress", scope: "manual_sam", estimated_impact: "high", title: "Rewrite the hero", created_at: old },
    { id: "a3", status: "completed", scope: "jori_autonomous", estimated_impact: "medium", title: "Add FAQ schema" },
  ] }));
  const manual = JSON.parse(run(sb, "mkt-actions", ["list", "--manual", "--json"]).stdout);
  assert.deepEqual(manual.map((a) => a.id), ["a2"]);
  const open = JSON.parse(run(sb, "mkt-actions", ["list", "--json"]).stdout);
  assert.deepEqual(open.map((a) => a.id), ["a2", "a1"]); // high impact first
  const stale = JSON.parse(run(sb, "mkt-actions", ["stale", "--days", "14", "--json"]).stdout);
  assert.equal(stale.length, 2);

  assert.equal(run(sb, "mkt-actions", ["retire", "a1", "duplicate", "of", "a3"]).status, 0);
  assert.notEqual(run(sb, "mkt-actions", ["retire", "a3", "nope"]).status, 0); // not open: refused
  assert.equal(run(sb, "mkt-actions", ["complete", "a2", "live page checked"]).status, 0);
  const d = JSON.parse(fs.readFileSync(sb.data("mkt-actions-state.json"), "utf8"));
  const by = Object.fromEntries(d.actions.map((a) => [a.id, a]));
  assert.equal(by.a1.status, "abandoned");
  assert.match(by.a1.execution_notes, /RETIRED \d{4}-\d\d-\d\d: duplicate of a3/);
  assert.equal(by.a2.status, "completed");
  assert.ok(by.a2.completed_at);
  assert.equal(by.a3.status, "completed");
  assert.ok(!fs.existsSync(sb.data("mkt-actions-state.json.tmp")));
});

test("conversion funnel from upstream state, ASC fallback when GA4/AppsFlyer are absent", () => {
  const sb = sandbox({ ios_app_id: "1000000001", android_package: "com.example.demo", tz: "UTC" });
  fs.writeFileSync(sb.data("mkt-reddit-ads-state.json"), JSON.stringify({
    ads: [
      { id: "ad1", name: "Creative A", click_url: "https://example.onelink.me/x?pid=reddit&af_ad=creative_a" },
      { id: "ad2", name: "Creative B", click_url: "https://example.com/lp/b" },
    ],
    yesterday: { date: "2026-01-14", per_ad: [
      { ad_id: "ad1", impressions: 1000, clicks: 20, spend_cents: 1500 },
      { ad_id: "ad2", ad_name: "Creative B", impressions: 500, clicks: 0, spend_cents: 500, ctr_pct: 0 },
    ] },
  }));
  fs.writeFileSync(sb.data("mkt-metrics-state.json"), JSON.stringify({
    asc: { downloads_status: "ok" },
    daily: [{ date: "2026-01-14", asc_downloads: 4, asc_downloads_breakdown: { first_time: 4 } }],
    rolling: { "7d": { asc_downloads: 19 } },
  }));
  const r = run(sb, "mkt-conversion-collect");
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(fs.readFileSync(sb.data("mkt-conversion-state.json"), "utf8"));
  assert.equal(s.last_run_ok, true);
  assert.equal(s.window.date, "2026-01-14");
  const [a, b] = s.funnel.by_creative;
  assert.equal(a.af_ad, "creative_a");
  assert.equal(a.spend, 15);
  assert.equal(a.ctr_pct, 2);
  assert.equal(a.cpc, 0.75);
  assert.equal(b.af_ad, null);
  assert.equal(b.cpc, null);
  const t = s.funnel.totals;
  assert.equal(t.spend, 20);
  assert.equal(t.clicks, 20);
  assert.equal(t.installs_source, "asc_total_proxy");
  assert.equal(t.installs, 4);
  assert.equal(t.cpi, 5);
  assert.equal(s.sources.ga4.configured, false);
  assert.equal(s.sources.appsflyer.configured, false);
  assert.equal(s.sources.reddit.routes_to_onelink, true);
  assert.ok(s.notes.some((n) => /GA4 not wired/.test(n)));
  assert.ok(s.notes.some((n) => /AppsFlyer not wired/.test(n)));
});
