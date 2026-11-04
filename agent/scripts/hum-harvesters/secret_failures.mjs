#!/usr/bin/env node
// Secret-failures — surface missing/unreachable secrets logged by cron-direct
// scripts (findme, location-segment, ...). Each (script, secret) pair is
// daily-deduped at the writer; this harvester surfaces unique pairs from the
// last 24h so the user knows when a feature has degraded silently.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { readStdinJson, emit, emitNull, emitNoop, stampRun } from "./_common.mjs";

const { situation: sit, context } = await readStdinJson(); void sit; void context;
const LOG = path.join(createRequire(import.meta.url)("../../../lib/root.cjs").installRoot(), "data/secret-failures.jsonl");

if (!fs.existsSync(LOG)) {
  stampRun("secret_failures", false);
  emitNoop("no log file — no failures recorded");
  process.exit(0);
}

let raw;
try { raw = fs.readFileSync(LOG, "utf8"); } catch { raw = ""; }

const cutoff = Date.now() - 24 * 60 * 60 * 1000;
const seen = new Map();
for (const line of raw.split("\n")) {
  if (!line) continue;
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  const ts = new Date(r.ts || 0).getTime();
  if (!Number.isFinite(ts) || ts < cutoff) continue;
  const key = `${r.script}:${r.secret}`;
  if (!seen.has(key)) seen.set(key, { script: r.script, secret: r.secret, reason: r.reason, last_ts: r.ts, count: 1 });
  else { const e = seen.get(key); e.count++; if (r.ts > e.last_ts) e.last_ts = r.ts; }
}

if (seen.size === 0) {
  stampRun("secret_failures", false);
  emitNoop("no failures in last 24h");
  process.exit(0);
}

const failures = [...seen.values()].sort((a, b) => b.last_ts.localeCompare(a.last_ts));
const top = failures[0];
const others = failures.length > 1 ? ` (+${failures.length - 1} more)` : "";

stampRun("secret_failures", true);
emit({
  topic: "secret_failures",
  signal: `Secret missing — ${top.script}: ${top.secret}. ${top.reason}. Add to .env to restore feature${others}.`,
  urgency: 0.65,
  freshness_min: 0,
  dedup_key: `secret-failure:${top.script}:${top.secret}`,
  supporting_data: { failures, total_unique: failures.length },
});
