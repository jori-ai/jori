// control/setup.mjs — the Setup page: what each part of the installation
// needs, and whether this host has it. Read-only; every item names the page
// (or the command) that fixes it.
//
// Status: "ok", "missing" (required and absent), "optional" (an integration
// not set up: fine if unused), "warn" (set up but not answering).

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TOOLS_DIR, installTools } = require("../root.cjs");
const inst = require("../instance.cjs");

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

function envKeys() {
  try {
    return new Set(fs.readFileSync(installTools(".env"), "utf8").split("\n")
      .map((l) => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)) // lang-regex-ok: .env syntax
      .filter((m) => m && m[2].replace(/^["']|["']$/g, "").length > 0).map((m) => m[1]));
  } catch {
    return new Set();
  }
}

async function reachable(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
}

/**
 * snap: the control room snapshot already gathered (agents, jobs, services),
 * so the page costs no second round of probes.
 */
export async function setupChecks(snap = {}) {
  const I = inst.instance();
  const keys = envKeys();
  const items = [];
  const add = (group, name, status, detail, fix) => items.push({ group, name, status, detail, fix });

  // ── Identity ──
  const idMissing = ["owner_name", "owner_email", "tz", "assistant_name"].filter((k) => !I[k] || (k === "owner_name" && I[k] === "the user"));
  add("Who and where", "Owner, email, time zone, assistant name", idMissing.length ? "missing" : "ok",
    idMissing.length ? `Not set: ${idMissing.join(", ").replace(/_/g, " ")}` : `${I.owner_name}, ${I.owner_email}, ${I.tz}; the assistant is ${I.assistant_name}`, "#identity");
  add("Who and where", "The address the assistant sends mail from", I.agent_email ? "ok" : "optional",
    I.agent_email || "Not set: mail goes out from the owner's address", "#identity");

  // ── The core ──
  const agents = snap.agents?.agents || [];
  const down = agents.filter((a) => !a.health?.ok);
  add("Core", "Claude sessions (Max sign-in)", !agents.length ? "missing" : down.length ? "warn" : "ok",
    !agents.length ? "No agents configured" : down.length ? `Not answering: ${down.map((a) => a.name).join(", ")}. Run \`claude\` on the host and sign in, then \`jori up\`.` : `${agents.length} sessions running`, "#agents");
  add("Core", "Webhook token", exists(installTools("secrets", "webhook-token")) ? "ok" : "missing",
    exists(installTools("secrets", "webhook-token")) ? "secrets/webhook-token" : "Run `jori init` to generate it", null);
  const sb = !!I.supabase_project && keys.has("SUPABASE_SERVICE_ROLE_KEY");
  add("Core", "Supabase (messages, memory mirror, the app)", sb ? "ok" : "missing",
    sb ? `Project ${I.supabase_project}` : `${I.supabase_project ? "" : "No project set. "}${keys.has("SUPABASE_SERVICE_ROLE_KEY") ? "" : "SUPABASE_SERVICE_ROLE_KEY not in .env."}`, "#services");
  const ollama = await reachable(`${process.env.OLLAMA_URL || "http://127.0.0.1:11434"}/api/tags`);
  add("Core", "Ollama (local embeddings for memory search)", ollama ? "ok" : "warn", ollama ? "Answering" : "Not answering: install Ollama and pull nomic-embed-text", null);
  const jobs = snap.schedule?.jobs || [];
  add("Core", "Schedule installed", jobs.length ? "ok" : "missing", jobs.length ? `${jobs.length} recurring jobs` : "No crontab or launchd jobs found: `jori doctor --repair` installs them", "#schedule");
  const failing = (snap.jobFailures && Object.keys(snap.jobFailures).length) || 0;
  add("Core", "Recurring jobs succeeding", failing ? "warn" : "ok", failing ? `${failing} job(s) failing; a repair is queued for each` : "No job has failed 3 runs in a row", "#schedule");

  // ── Reaching you ──
  for (const c of snap.channels?.channels || []) {
    if (c.up == null) continue;
    add("Reaching you", c.name, c.up ? "ok" : "warn", c.up ? "Up" : `Not answering${c.error ? `: ${c.error}` : ""}`, "#channels");
  }
  const cf = keys.has("CF_ACCESS_TEAM_DOMAIN") && keys.has("CF_ACCESS_AUD");
  add("Reaching you", "Memory site sign-in (Cloudflare Access)", cf ? "ok" : "optional", cf ? "Configured" : "Without it the memory site and this control room are reachable on the tailnet only", "#services");
  add("Reaching you", "Phone app notifications (APNs)", exists(path.join(inst.localDir(), "config", "apns.json")) ? "ok" : "optional", "Settings file apns", "#features");

  // ── Models ──
  const J = snap.jev || {};
  add("Models", "Jev decision model", J.keySet && J.on ? (J.breakerUntil ? "warn" : "ok") : J.keySet ? "warn" : "optional",
    !J.keySet ? "TYPESAFE_API_KEY not set: every decision uses its fallback (a rule or Claude)" : !J.on ? "Turned off" : J.breakerUntil ? "Paused after errors" : J.budgetLine || "On", "#agents");

  // ── Outside services ──
  for (const s of snap.services?.services || []) {
    if (!(s.env || []).length) continue;
    const has = (s.keys || []).length;
    const cfgs = (s.config || []).filter((n) => !exists(path.join(inst.localDir(), "config", `${n}.json`)));
    add(`Services: ${s.group}`, s.name, has ? (cfgs.length ? "warn" : "ok") : "optional",
      has ? (cfgs.length ? `Key set, but no settings file: ${cfgs.join(", ")}` : `${has} key(s) set`) : `${s.does}. Not set up (needs ${s.env.map((p) => `${p}…`).join(", ")} in .env)`, "#services");
  }

  // ── Keeping it configurable ──
  const hard = (snap.hardcoded?.findings || []).filter((f) => f.count);
  add("Keeping it right", "Values still written into code", hard.length ? "warn" : "ok", hard.length ? `${hard.reduce((a, f) => a + f.count, 0)} places in ${hard.length} groups` : "None found", "#hardcoded");

  const counts = items.reduce((a, i) => ((a[i.status] = (a[i.status] || 0) + 1), a), {});
  return { items, counts };
}

export function jobFailureIncidents() {
  return readJson(installTools("data", "job-failure-state.json"), { incidents: {} })?.incidents || {};
}

export const _internal = { envKeys, TOOLS_DIR };
