// control/jev.mjs — Jev (the decision model, docs/jev.md) in the control room.
//
// Reads: data/jev-config.json (thresholds, per-site overrides, privacy,
// budget), the question files (agent/config/jev-questions/ and this
// installation's data/jev-questions/), the kill switch data/.jev-off, the
// breaker in data/jev-shadow/health-state.json, the last 7 days of decision
// rows data/jev-shadow/<date>.jsonl, and whether TYPESAFE_API_KEY is set.
// Writes: data/jev-config.json (save) and data/.jev-off (on/off), each through
// the control room's audit log.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TOOLS_DIR, installTools } = require("../root.cjs");

export const CONFIG = () => process.env.JORI_JEV_CONFIG || installTools("data", "jev-config.json");
export const OFF_FILE = () => installTools("data", ".jev-off");
const SHADOW = () => installTools("data", "jev-shadow");

const readJson = (f, d = null) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; }
};

function questionFiles() {
  const out = {};
  for (const dir of [path.join(TOOLS_DIR, "agent", "config", "jev-questions"), installTools("data", "jev-questions")]) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch {}
    for (const f of names) {
      const j = readJson(path.join(dir, f), {});
      const site = f.slice(0, -5);
      out[site] = { ...(out[site] || {}), threshold: j.threshold ?? out[site]?.threshold ?? null, about: String(j._doc || out[site]?.about || "").slice(0, 300), local: dir.startsWith(installTools("data")) || out[site]?.local || false };
    }
  }
  return out;
}

function recentRows(days = 7) {
  const rows = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const day = new Date(now - i * 86400e3).toISOString().slice(0, 10);
    let text = "";
    try { text = fs.readFileSync(path.join(SHADOW(), `${day}.jsonl`), "utf8"); } catch { continue; }
    for (const l of text.split("\n")) {
      if (!l) continue;
      try {
        const r = JSON.parse(l);
        rows.push({ site: r.site, used: r.used, ts: r.ts, conf: r.jev?.confidence ?? null, cost: r.jev?.cost || 0, error: r.jev?.error || null });
      } catch {}
    }
  }
  return rows;
}

function envHas(key) {
  try {
    return fs.readFileSync(installTools(".env"), "utf8").split("\n").some((l) => {
      const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/); // lang-regex-ok: .env syntax
      return m && m[1] === key && m[2].replace(/^["']|["']$/g, "").length > 0;
    });
  } catch {
    return false;
  }
}

function budgetLine() {
  try {
    return execFileSync(process.execPath, [path.join(TOOLS_DIR, "bin", "jev-budget-check"), "--dry-run"], { encoding: "utf8", timeout: 30_000 }).trim().split("\n").pop();
  } catch (e) {
    return String(e.stdout || "").trim().split("\n").pop() || null;
  }
}

export function jevState() {
  const cfg = readJson(CONFIG(), {}) || {};
  const health = readJson(path.join(SHADOW(), "health-state.json"), {}) || {};
  const rows = recentRows(7);
  const qs = questionFiles();
  const overrides = cfg.sites || {};
  const sites = Object.keys(qs).sort().map((site) => {
    const mine = rows.filter((r) => r.site === site);
    const viaJev = mine.filter((r) => r.used === "jev").length;
    const confs = mine.map((r) => r.conf).filter((c) => typeof c === "number");
    const o = overrides[site] || {};
    return {
      site, about: qs[site].about, local: qs[site].local,
      enabled: o.enabled !== false,
      threshold: o.threshold ?? qs[site].threshold ?? cfg.default_threshold ?? null,
      overridden: o.threshold != null || o.enabled === false,
      calls7d: mine.length, viaJev7d: viaJev, errors7d: mine.filter((r) => r.error).length,
      avgConfidence: confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 100) / 100 : null,
      lastAt: mine.map((r) => r.ts).sort().at(-1) || null,
    };
  });
  const breakerUntil = health.breaker_until && Date.parse(health.breaker_until) > Date.now() ? health.breaker_until : null;
  return {
    on: !fs.existsSync(OFF_FILE()),
    breakerUntil,
    lastOkAt: health.ok_at || null,
    keySet: envHas("TYPESAFE_API_KEY"),
    endpoint: process.env.JEV_ENDPOINT || "https://api.typesafe.ai/v1/systemone",
    model: process.env.JEV_MODEL || "jev-latest",
    defaultThreshold: cfg.default_threshold ?? null,
    privacyExclusions: !!cfg.privacy_exclusions,
    budget: cfg.budget ? { usd: cfg.budget.usd, since: cfg.budget.since, alertPcts: cfg.budget.alert_pcts } : null,
    budgetLine: budgetLine(),
    cost7d: Math.round(rows.reduce((a, r) => a + (r.cost || 0), 0) * 10000) / 10000,
    calls7d: rows.length,
    sites,
  };
}

/** Apply a change to data/jev-config.json; returns the new object. */
export function applyJevChange(cfg, args) {
  // An empty form field means "leave it", except a site's threshold ("" = use the default).
  const blank = (v) => (v === "" ? undefined : v);
  const default_threshold = blank(args.default_threshold), budget_usd = blank(args.budget_usd), budget_since = blank(args.budget_since);
  const { privacy_exclusions, site, enabled, threshold } = args;
  const out = JSON.parse(JSON.stringify(cfg || {}));
  const prob = (x, what) => {
    const n = Number(x);
    if (!(n > 0 && n <= 1)) throw new Error(`${what} must be a number above 0 and at most 1`);
    return Math.round(n * 1000) / 1000;
  };
  if (default_threshold !== undefined) out.default_threshold = prob(default_threshold, "the default threshold");
  if (privacy_exclusions !== undefined) out.privacy_exclusions = privacy_exclusions === true || privacy_exclusions === "true";
  if (budget_usd !== undefined || budget_since !== undefined) {
    out.budget = { ...(out.budget || {}) };
    if (budget_usd !== undefined) {
      const n = Number(budget_usd);
      if (!(n >= 0)) throw new Error("the budget is a dollar amount");
      out.budget.usd = n;
    }
    if (budget_since !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(budget_since))) throw new Error("since is a date like 2026-10-05"); // lang-regex-ok: ISO date syntax
      out.budget.since = budget_since;
    }
  }
  if (site) {
    if (!/^[a-z0-9-]+$/.test(site)) throw new Error("bad site name"); // lang-regex-ok: site id syntax
    out.sites = { ...(out.sites || {}) };
    const cur = { ...(out.sites[site] || {}) };
    if (enabled !== undefined) { if (enabled === false || enabled === "false") cur.enabled = false; else delete cur.enabled; }
    if (threshold !== undefined) { if (threshold === null || threshold === "") delete cur.threshold; else cur.threshold = prob(threshold, "a site's threshold"); }
    if (Object.keys(cur).length) out.sites[site] = cur; else delete out.sites[site];
  }
  return out;
}
