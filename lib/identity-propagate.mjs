// identity-propagate — carry a change of the assistant's name or email address
// to everything that copied it at build or deploy time.
//
// The owner (2026-11-04): "changing the assistant name should retrigger new
// apps (or at least a message to the user that this will be needed if they
// want it changed). Deploy everything automatically after an assistant name
// change." Most code reads agent/local/instance.json at run time
// (lib/instance.cjs) and only needs a restart. These do not:
//   - the companion apps: their display name is compiled in, so a rebuild is
//     the only way to change it (bin/app-build); the shipped workflows read
//     the GitHub variable JORI_ASSISTANT_NAME, which is set first;
//   - the wiki worker: it gets the name as a wrangler var at deploy
//     (bin/wiki-worker-deploy);
//   - mail to the new address: the domain has to route it to the email worker.
//     With agent/local/config/email-routing.json (Cloudflare) the rule is added
//     here; without it the owner is told what to set up.
//
// What was last carried over is kept in data/.identity-propagated.json. It is
// written once a run finishes, whatever the outcome of each step, so a step
// that failed is reported once rather than retried every 15 minutes; run
// `identity-propagate --force` to redo every step for the current values.
// The first run on a host only records the current values.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The identity values whose change needs more than a restart. */
export function identityOf(inst) {
  return { assistant_name: inst.assistant_name || "", agent_email: (inst.agent_email || "").toLowerCase() };
}

/** Which values changed between `prev` and `cur` (keys of identityOf). */
export function changedKeys(prev, cur) {
  if (!prev) return [];
  return Object.keys(cur).filter((k) => (prev[k] || "") !== (cur[k] || ""));
}

/**
 * The steps a change needs, in order. Pure: everything it depends on is passed
 * in, so tests can check the plan without running anything.
 *   env.serviceLoaded   the assistant runs as a service on this host
 *   env.wikiConfigured  agent/local/wiki-worker/wrangler.toml exists
 *   env.appTargets      {platform: {repo, workflow, ref} | null} (lib/app-builds.cjs)
 *   env.emailRouting    agent/local/config/email-routing.json or null
 *   env.aliases         {assistant: [...], email: [...]} from instance.json
 * Each step: {id, kind: "run" | "manual", what}.
 */
export function plan(prev, cur, env) {
  const changed = changedKeys(prev, cur);
  const steps = [];
  if (!changed.length) return steps;
  const name = changed.includes("assistant_name");
  const email = changed.includes("agent_email");

  if (name) {
    const repos = [...new Set(Object.values(env.appTargets || {}).filter(Boolean).map((t) => t.repo))];
    for (const repo of repos) steps.push({ id: `gh-var:${repo}`, kind: "run", what: `set JORI_ASSISTANT_NAME on ${repo}`, repo });
    if (repos.length) steps.push({ id: "apps", kind: "run", what: "rebuild the apps so they show the new name" });
    else steps.push({ id: "apps", kind: "manual", what: `The apps still say "${prev.assistant_name}" until they are rebuilt: no app build target is configured (agent/local/config/app-builds.json).` });
    if (env.wikiConfigured) steps.push({ id: "wiki", kind: "run", what: "redeploy the wiki worker" });
    if (prev.assistant_name && !(env.aliases?.assistant || []).some((a) => a.toLowerCase() === prev.assistant_name.toLowerCase())) {
      steps.push({ id: "alias-name", kind: "manual", what: `"${prev.assistant_name}" is not in assistant_aliases, so messages addressed to it are no longer picked up. Add it there to keep the old name working.` });
    }
  }

  if (email && cur.agent_email) {
    if (env.emailRouting?.provider === "cloudflare") steps.push({ id: "email-route", kind: "run", what: `route ${cur.agent_email} to the email worker` });
    else steps.push({ id: "email-route", kind: "manual", what: `Mail to ${cur.agent_email} only arrives once its domain sends it to the email worker (cf-email-worker). On Cloudflare, add an Email Routing rule, or describe the zone in agent/local/config/email-routing.json and this is done for you next time. Sending from it needs the domain verified at your mail relay.` });
    if (prev.agent_email && !(env.aliases?.email || []).map((a) => a.toLowerCase()).includes(prev.agent_email)) {
      steps.push({ id: "alias-email", kind: "manual", what: `${prev.agent_email} is not in agent_email_aliases, so mail to it is no longer treated as the assistant's own. Add it there to keep the old address working.` });
    }
  }

  if (env.serviceLoaded) steps.push({ id: "restart", kind: "run", what: "restart the assistant so every process uses the new values" });
  return steps;
}

/** The one-message summary sent to the owner after a run. */
export function summary(prev, cur, results) {
  const changes = changedKeys(prev, cur).map((k) => (k === "assistant_name" ? `name ${prev[k]} → ${cur[k]}` : `email ${prev[k] || "none"} → ${cur[k]}`));
  const lines = [`Identity changed: ${changes.join(", ")}`];
  for (const r of results) {
    if (r.kind === "manual") lines.push(`- To do: ${r.what}`);
    else lines.push(`- ${r.ok ? "Done" : "Failed"}: ${r.what}${r.ok ? "" : ` (${r.error})`}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Running it

export function stateFile(toolsDir) {
  return path.join(toolsDir, "data", ".identity-propagated.json");
}

export function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

export function writeState(file, cur) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...cur, at: new Date().toISOString() }, null, 2) + "\n");
}

/** Cloudflare Email Routing: add a rule for `address` unless one exists. */
export async function ensureCloudflareRoute(cfg, address, { fetchFn = fetch, env = process.env } = {}) {
  const token = env[cfg.token_env || "CLOUDFLARE_EMAIL_ROUTING_TOKEN"];
  if (!token) throw new Error(`${cfg.token_env || "CLOUDFLARE_EMAIL_ROUTING_TOKEN"} is not set in .env`);
  if (!cfg.zone_id || !cfg.worker) throw new Error("email-routing.json needs zone_id and worker");
  const base = `https://api.cloudflare.com/client/v4/zones/${cfg.zone_id}/email/routing/rules`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const list = await (await fetchFn(`${base}?per_page=50`, { headers })).json();
  if (!list.success) throw new Error(`listing rules: ${JSON.stringify(list.errors)}`);
  const has = (list.result || []).some((r) => r.matchers?.some((m) => (m.value || "").toLowerCase() === address));
  if (has) return "already routed";
  const body = { name: `${address} -> ${cfg.worker}`, enabled: true, matchers: [{ type: "literal", field: "to", value: address }], actions: [{ type: "worker", value: [cfg.worker] }] };
  const res = await (await fetchFn(base, { method: "POST", headers, body: JSON.stringify(body) })).json();
  if (!res.success) throw new Error(`adding rule: ${JSON.stringify(res.errors)}`);
  return "rule added";
}

export function environment(toolsDir, { serviceLoaded }) {
  const inst = require("./instance.cjs");
  const { buildTargets } = require("./app-builds.cjs");
  let appTargets = {};
  try { appTargets = buildTargets(); } catch { appTargets = {}; }
  const file = inst.instance();
  return {
    serviceLoaded,
    wikiConfigured: fs.existsSync(path.join(inst.localDir(), "wiki-worker", "wrangler.toml")),
    appTargets,
    emailRouting: inst.localConfig("email-routing", null),
    aliases: { assistant: inst.assistantAliases(), email: inst.agentAddresses().slice(1) },
    raw: file,
  };
}
