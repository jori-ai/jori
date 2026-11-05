"use strict";
// instance.cjs — who and where this installation is, and per-instance config.
//
// Kernel code never hard-codes the operator's identity, accounts, hosts, time
// zone or personal lists. It asks this module, which layers (later wins):
//   1. the generic default passed by the caller,
//   2. agent/local/instance.json / agent/local/config/<name>.json
//      (the operator's own values; tracked in a private install, absent in a
//      fresh one),
//   3. environment variables (JORI_OWNER_EMAIL, JORI_TZ, …), so a host
//      or a test can override without editing files.
// JORI_LOCAL_DIR points the local dir elsewhere (tests).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { REPO_ROOT: ROOT, TOOLS_DIR } = require("./root.cjs");

function localDir() {
  return process.env.JORI_LOCAL_DIR || path.join(TOOLS_DIR, "agent", "local");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`${file}: ${e.message}`);
  }
}

// Instance identity. Keys and the env var that overrides each one.
const INSTANCE_KEYS = {
  owner_name: "JORI_OWNER_NAME",
  owner_id: "JORI_OWNER_ID",
  owner_email: "JORI_OWNER_EMAIL",
  agent_email: "JORI_AGENT_FROM_EMAIL",
  domain: "JORI_DOMAIN",
  tz: "JORI_TZ",
  host: "JORI_HOST",
  host_label: "JORI_HOST_LABEL",
  host_title: "JORI_HOST_TITLE",
  supabase_project: "JORI_SUPABASE_PROJECT",
  gcp_project: "JORI_GCP_PROJECT",
  github_owner: "JORI_OWNER",
  approval_domain: "JORI_APPROVAL_DOMAIN",
  attachments_bucket: "JORI_ATTACHMENTS_BUCKET",
  // What the assistant is called in everything it writes: notification titles,
  // email sender names, prompts, page titles. sender_name defaults to it.
  assistant_name: "JORI_ASSISTANT_NAME",
  // How the assistant is referred to in the third person: "she/her",
  // "he/him", "they/them", "it/its" (default) or any "subject/object[/possessive]".
  assistant_pronouns: "JORI_ASSISTANT_PRONOUNS",
  sender_name: "JORI_SENDER_NAME",
  // The person the assistant also acts for (a partner), by first name; "" = none.
  partner_name: "JORI_PARTNER_NAME",
  // The owner's home city in words, for prompts and fallbacks.
  home_city: "JORI_HOME_CITY",
};

const INSTANCE_DEFAULTS = {
  attachments_bucket: "jori-attachments", // the Storage bucket the app uploads chat attachments to (system/migrations/0010_chat.sql)
  owner_name: "the user",
  owner_id: "",
  owner_email: "",
  agent_email: "",
  domain: "",
  tz: "",
  host: "",
  // How alerts and replies name the machine the agents run on: in a sentence
  // ("… is not loaded on the host") and at the start of one ("Host disk space low").
  host_label: "the host",
  host_title: "Host",
  supabase_project: "",
  gcp_project: "",
  github_owner: "",
  // The context the app's Face ID signature covers for self-improvement
  // approvals (core/app-approval.mjs). An installation whose app already signs
  // another context pins it here, so a rename never breaks verification.
  assistant_name: "Jori", // kernel-guard-ok: the kernel's own product name is the default assistant name
  assistant_pronouns: "it/its",
  sender_name: "",
  partner_name: "",
  home_city: "",
  approval_domain: "jori-approve.v1", // kernel-guard-ok: the kernel's own default signing context, branded by the sync like every kernel name
};

function hostTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// The identifier form of an owner name: lowercase, a leading "the" dropped,
// every other run of non-alphanumerics an underscore ("the user" → "user").
function ownerIdOf(name) {
  return String(name || "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "user";
}

// instance() → the merged identity object. `tz` always resolves to a zone
// (local value, else the host's zone, else UTC). `owner_id` is the owner as an
// identifier, used where a stored or external name embeds the owner (a Jev
// question key `needs_<owner_id>`, an idea scope `manual_<owner_id>`, a Jev
// state key `<owner_id>_said`), so an installation keeps the names its data
// already uses; when not set it is derived from owner_name.
function instance() {
  const file = readJson(path.join(localDir(), "instance.json")) || {};
  const out = { ...INSTANCE_DEFAULTS };
  for (const k of Object.keys(INSTANCE_KEYS)) {
    if (file[k] != null && file[k] !== "") out[k] = file[k];
    const envName = INSTANCE_KEYS[k];
    if (process.env[envName]) out[k] = process.env[envName];
  }
  if (!out.tz) out.tz = hostTz();
  if (!out.owner_id) out.owner_id = ownerIdOf(out.owner_name);
  if (!out.sender_name) out.sender_name = out.assistant_name;
  return out;
}

// assistantName() → what the assistant calls itself (instance.json
// `assistant_name`, JORI_ASSISTANT_NAME; default the kernel's product name).
function assistantName() {
  return instance().assistant_name;
}

// assistantPronouns() → the assistant's pronouns in every form a sentence
// needs, from instance.json `assistant_pronouns` ("she/her", "he/him",
// "they/them", "it/its", or a custom "xe/xem/xyr"). The owner (2026-11-04):
// "jori is an "it" but "Claudette" is a "She/her"".
const PRONOUN_SETS = {
  she: { subject: "she", object: "her", possessive: "her", possessivePronoun: "hers", reflexive: "herself" },
  he: { subject: "he", object: "him", possessive: "his", possessivePronoun: "his", reflexive: "himself" },
  they: { subject: "they", object: "them", possessive: "their", possessivePronoun: "theirs", reflexive: "themselves" },
  it: { subject: "it", object: "it", possessive: "its", possessivePronoun: "its", reflexive: "itself" },
};
function parsePronouns(text) {
  const parts = String(text || "").toLowerCase().split("/").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return { label: "it/its", ...PRONOUN_SETS.it };
  const known = PRONOUN_SETS[parts[0]];
  if (known) return { label: parts.join("/"), ...known };
  const [subject, object = subject, possessive = object] = parts;
  return { label: parts.join("/"), subject, object, possessive, possessivePronoun: possessive, reflexive: `${object}self` };
}
function assistantPronouns() {
  return parsePronouns(instance().assistant_pronouns);
}

// identityBlock() → the lines every agent session starts with (prepended to
// its local rules, agent/supervisor/claude-session.mjs readLocalRules and
// agent/scripts/lib/local-rules.sh): its name, its pronouns, earlier names.
function identityBlock() {
  const inst = instance();
  const name = inst.assistant_name;
  const p = assistantPronouns();
  const owner = inst.owner_name && inst.owner_name !== "the user" ? `${inst.owner_name}'s assistant` : "the user's assistant";
  const lines = [`## Who you are`, ``, `You are ${name}, ${owner}. Your pronouns are ${p.label}: whenever you, or anything you write, refers to ${name} in the third person, use ${[...new Set([p.subject, p.object, p.possessive])].join("/")} (for example "${name} said ${p.subject}'ll check")${p.subject === "it" ? "" : `, never "it"`}.`];
  const aliases = assistantAliases();
  if (aliases.length) lines.push(`You were earlier called ${aliases.join(", ")}; messages addressed to those names are for you.`);
  return lines.join("\n") + "\n";
}

// assistantAliases() → earlier names the assistant still answers to
// (instance.json `assistant_aliases`, or JORI_ASSISTANT_ALIASES comma-separated).
function assistantAliases() {
  const file = readJson(path.join(localDir(), "instance.json")) || {};
  const env = process.env.JORI_ASSISTANT_ALIASES;
  const list = env ? env.split(",") : Array.isArray(file.assistant_aliases) ? file.assistant_aliases : [];
  return list.map((x) => String(x).trim()).filter(Boolean);
}

// agentAddresses() → every address that is the agent's own, lowercased: the
// sending address (agent_email) first, then `agent_email_aliases` from
// instance.json (or JORI_AGENT_EMAIL_ALIASES, comma-separated): addresses the
// agent answered to before a rename, which still reach it and still count as
// its own mail and its instruction channel.
function agentAddresses() {
  const file = readJson(path.join(localDir(), "instance.json")) || {};
  const env = process.env.JORI_AGENT_EMAIL_ALIASES;
  const aliases = env ? env.split(",") : Array.isArray(file.agent_email_aliases) ? file.agent_email_aliases : [];
  const out = [];
  for (const a of [instance().agent_email, ...aliases]) {
    const v = String(a || "").trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

function instanceValue(key) {
  if (!(key in INSTANCE_KEYS)) throw new Error(`unknown instance key: ${key}`);
  return instance()[key];
}

// localConfig(name, defaults) → defaults shallow-merged with
// agent/local/config/<name>.json. Arrays in the local file replace the
// default arrays; use `extend_<key>` in the local file to append instead.
function localConfig(name, defaults = {}) {
  const file = readJson(path.join(localDir(), "config", `${name}.json`));
  const out = { ...defaults };
  if (!file) return out;
  for (const [k, v] of Object.entries(file)) {
    if (k.startsWith("_")) continue;
    if (k.startsWith("extend_")) {
      const base = k.slice("extend_".length);
      out[base] = [...(Array.isArray(out[base]) ? out[base] : []), ...(Array.isArray(v) ? v : [v])];
    } else {
      out[k] = v;
    }
  }
  return out;
}

// The REST base of this installation's Supabase project
// (https://<supabase_project>.supabase.co), or "" when none is configured.
// Callers let SUPABASE_URL win over it, as before.
function supabaseUrl() {
  const project = instanceValue("supabase_project");
  return project ? `https://${project}.supabase.co` : "";
}

// This installation's Supabase public anon key (row-level-security protected),
// from agent/local/config/supabase.json `anon_key`; "" when none. One
// home for every reader (context-sync, jori-notify).
function supabaseAnonKey() {
  return localConfig("supabase", { anon_key: "" }).anon_key || "";
}

// Claude Code keeps each project's sessions and auto-memory under
// ~/.claude/projects/<slug>, where the slug is the absolute path the sessions
// are started from with every non-alphanumeric character replaced by "-".
// Jori's sessions start from ~/Dev/jori (JORI_PROJECT_DIR overrides).
function claudeProjectSlug(dir) {
  return String(dir).replace(/[^A-Za-z0-9]/g, "-");
}

function claudeProjectDir(sub = "") {
  const home = os.homedir();
  const project = process.env.JORI_PROJECT_DIR || path.join(home, "Dev", "jori");
  return path.join(home, ".claude", "projects", claudeProjectSlug(sub ? path.join(project, sub) : project));
}

// The auto-memory dir (memory pages): ~/.claude/projects/<slug>/memory.
function claudeMemoryDir() {
  return path.join(claudeProjectDir(), "memory");
}

module.exports = {
  ROOT, localDir, instance, instanceValue, agentAddresses, assistantName, assistantAliases, assistantPronouns, parsePronouns, identityBlock, localConfig, INSTANCE_KEYS, hostTz, supabaseUrl, supabaseAnonKey, ownerIdOf,
  claudeProjectSlug, claudeProjectDir, claudeMemoryDir,
};

// CLI for shell scripts:  node lib/instance.cjs <key>   (prints value)
//                         node lib/instance.cjs --env   (KEY=value lines)
//                         node lib/instance.cjs --memory-dir
//                         node lib/instance.cjs --identity  (the agents' "Who you are" block)
if (require.main === module) {
  const arg = process.argv[2];
  if (arg === "--identity") {
    process.stdout.write(identityBlock());
  } else if (arg === "--memory-dir") {
    process.stdout.write(claudeMemoryDir() + "\n");
  } else if (arg === "--env") {
    const inst = instance();
    for (const [k, envName] of Object.entries(INSTANCE_KEYS)) {
      process.stdout.write(`${envName}=${JSON.stringify(String(inst[k] ?? ""))}\n`);
    }
  } else if (arg) {
    process.stdout.write(String(instanceValue(arg)) + "\n");
  } else {
    process.stdout.write(JSON.stringify(instance(), null, 2) + "\n");
  }
}
