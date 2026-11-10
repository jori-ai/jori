// org — the assistant's team: roles that own Jori's jobs, all reporting to the
// user (the CEO) and coordinated by a chief of staff (system/org.md).
//
// The roles are plugins (plugins/role-<id>: title, responsibility, the kernel jobs
// it owns, specialization.md). The installation names them and adds its own jobs
// in agent/local/config/org.json
//   { "ceo": "<name>",
//     "roles": [ { "id": "cfo", "title": "CFO", "name": "<first name>",
//                  "responsibility": "<one line>",
//                  "jobs": ["finance-review", "portfolio-*", …],   // job names; a trailing * is a prefix
//                  "intents": ["bank-alert", …],                    // jori-send-curl intents that are this role's
//                  "chief_of_staff": false,                         // true for the coordinator
//                  "sign_pings": true } ] }                         // default: true, except the chief of staff
// No file, or no roles: nothing is signed and every job is "unassigned".
//
// Signing (the user's choice of where the names show): an email a role's job
// sends gets "Name (Title): " in front of its subject, and a ping or push gets
// "Name: " in front of its text. The chief of staff is the assistant's own
// voice, so its pings stay unsigned unless sign_pings is set. Which job is
// sending comes from the caller (digest-deliver --intent, jori-send-curl
// --intent) or from JORI_SIGN_AS / JORI_JOB (cron-run and the ephemeral fork
// runner set JORI_JOB to the job's label).
//
// Job names are machine ids, so matching them is plain string work.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { localConfig } = require("./instance.cjs");

const ROOT = path.join(__dirname, "..");

// Role plugins (plugins/role-*/plugin.json `role`): each one a role with its
// title, responsibility, the kernel jobs it owns and a specialization brief.
function rolePlugins() {
  let P;
  try { P = require("./plugins.cjs"); } catch { return { enabled: [], all: new Set() }; }
  const enabled = [];
  const all = new Set();
  let list = [];
  try { list = P.plugins(); } catch { return { enabled, all }; }
  for (const p of list) {
    const r = p.manifest && p.manifest.role;
    if (!r || !r.id) continue;
    all.add(r.id);
    let on = false;
    try { on = P.isEnabled(p.name, list); } catch { on = false; }
    if (!on) continue;
    enabled.push({
      ...r, plugin: p.name,
      specialization_path: r.specialization ? path.join(p.dir, r.specialization) : null,
    });
  }
  return { enabled, all };
}

const uniq = (a) => [...new Set(a.filter(Boolean))];

// The team: every enabled role plugin, named and extended by the installation's
// org.json (its `roles` entries by id: name, extra jobs and intents,
// sign_pings, a title or responsibility of its own). A role in org.json with no
// plugin at all still counts (an installation's own role); one whose plugin is
// installed but turned off does not.
function org() {
  const c = localConfig("org", { roles: [] }) || {};
  const local = new Map((Array.isArray(c.roles) ? c.roles : []).filter((r) => r && r.id).map((r) => [r.id, r]));
  const { enabled, all } = rolePlugins();
  const roles = [];
  for (const r of enabled) {
    const l = local.get(r.id) || {};
    roles.push({
      ...r, ...l,
      title: l.title || r.title,
      responsibility: l.responsibility || r.responsibility,
      name: l.name || r.title,
      jobs: uniq([...(r.jobs || []), ...(l.jobs || [])]),
      intents: uniq([...(r.intents || []), ...(l.intents || [])]),
      chief_of_staff: !!(l.chief_of_staff ?? r.chief_of_staff),
      specialization_path: r.specialization_path,
    });
    local.delete(r.id);
  }
  for (const l of local.values()) if (!all.has(l.id) && l.name && l.title) roles.push({ ...l, specialization_path: null });
  return { ceo: c.ceo || null, roles };
}

// What a job's playbook gets appended at dispatch: the owning role's
// specialization, so the job runs as that role. Null when the job has no role
// or the role has no brief.
function roleBrief(job, o = org()) {
  const role = roleFor({ job }, o);
  if (!role || !role.specialization_path) return null;
  let text;
  try { text = fs.readFileSync(role.specialization_path, "utf8").trim(); } catch { return null; }
  const lines = text.split("\n");
  if ((lines[0] || "").startsWith("# ")) lines.shift();
  const ceo = o.ceo || "the user";
  return `## Your role on the team: ${role.name}, ${role.title}\n\nThis job belongs to ${role.name} (${role.title}), who reports to ${ceo} (the CEO)${role.chief_of_staff ? "" : " and is coordinated by the chief of staff"}. Do it with this role's specialty:\n\n${lines.join("\n").trim()}`;
}

// A launcher's label is often the job with a wrapper's prefix: trigger-hum,
// venue-watch-<lane>, ai.claude.<job>.
function normalizeJob(name) {
  let s = String(name || "").trim();
  for (const p of ["ai.claude.", "com.jori.", "trigger-", "venue-watch-"]) if (s.startsWith(p)) s = s.slice(p.length);
  return s;
}

function matches(pattern, name) {
  const p = String(pattern);
  return p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p;
}

// The most specific match wins (an exact name beats a prefix, a longer prefix a shorter one).
function roleFor({ job = null, intent = null } = {}, o = org()) {
  let best = null;
  let bestScore = -1;
  const consider = (role, list, name, bonus) => {
    if (!name) return;
    for (const p of list || []) {
      if (!matches(p, name)) continue;
      const score = (p.endsWith("*") ? p.length - 1 : 1000 + p.length) + bonus;
      if (score > bestScore) { best = role; bestScore = score; }
    }
  };
  const j = job ? normalizeJob(job) : null;
  const i = intent ? String(intent) : null;
  for (const r of o.roles) {
    consider(r, r.jobs, j, 0);
    consider(r, r.jobs, i, 0); // an intent is often the job's own name
    consider(r, r.intents, i, 0);
  }
  return best;
}

function signature(role) {
  return role ? `${role.name} (${role.title})` : null;
}

function alreadySigned(text, role) {
  const t = String(text || "").trimStart();
  return t.startsWith(`${role.name} (`) || t.startsWith(`${role.name}:`) || t.startsWith(`${role.name} ·`);
}

function signSubject(subject, ctx = {}, o = org()) {
  const role = roleFor(ctx, o);
  if (!role || !subject || alreadySigned(subject, role)) return subject;
  return `${signature(role)}: ${subject}`;
}

function signPing(text, ctx = {}, o = org()) {
  const role = roleFor(ctx, o);
  if (!role || !text || alreadySigned(text, role)) return text;
  const sign = role.sign_pings != null ? !!role.sign_pings : !role.chief_of_staff;
  return sign ? `${role.name}: ${text}` : text;
}

// Who the env says is sending (cron-run / the fork runner set JORI_SIGN_AS).
function envJob(env = process.env) {
  return env.JORI_SIGN_AS || env.JORI_JOB || null;
}

// Every job name the installation knows: the task registry, the playbooks,
// and the plugins' schedules, jobs and launchd agents.
function knownJobs(root = ROOT) {
  const names = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, "system", "tasks.json"), "utf8"));
    const rows = Array.isArray(j) ? j : (j.tasks || Object.entries(j).map(([k, v]) => ({ name: k, ...v })));
    for (const r of rows) if (r && (r.name || r.id)) names.add(r.name || r.id);
  } catch { /* no registry */ }
  try {
    for (const f of fs.readdirSync(path.join(root, "agent", "ops-agent", "jobs"))) if (f.endsWith(".md") && !f.endsWith("-format.md")) names.add(f.slice(0, -3));
  } catch { /* no playbooks */ }
  for (const d of [path.join(root, "plugins"), path.join(root, "agent", "local", "plugins")]) {
    let entries = [];
    try { entries = fs.readdirSync(d); } catch { continue; }
    for (const p of entries) {
      let m;
      try { m = JSON.parse(fs.readFileSync(path.join(d, p, "plugin.json"), "utf8")); } catch { continue; }
      for (const s of m.schedules || []) if (s.label) names.add(s.label);
      for (const k of Object.keys(m.jobs || {})) names.add(k);
      for (const l of m.launchd || []) if (l.label) names.add(l.label);
    }
  }
  return [...new Set([...names].map(normalizeJob))].filter(Boolean).sort();
}

// The chart: each role with the jobs it owns, plus the jobs nobody owns.
function chart(o = org(), jobs = knownJobs()) {
  const byRole = new Map(o.roles.map((r) => [r.id, []]));
  const unassigned = [];
  for (const j of jobs) {
    const r = roleFor({ job: j }, o);
    if (r) byRole.get(r.id).push(j); else unassigned.push(j);
  }
  return {
    ceo: o.ceo,
    roles: o.roles.map((r) => ({ id: r.id, title: r.title, name: r.name, responsibility: r.responsibility || null, chief_of_staff: !!r.chief_of_staff, jobs: byRole.get(r.id) })),
    unassigned,
  };
}

module.exports = { org, rolePlugins, roleBrief, roleFor, signature, signSubject, signPing, envJob, normalizeJob, knownJobs, chart };
