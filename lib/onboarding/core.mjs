// onboarding/core.mjs — what `jori setup` detects and does on a fresh Mac.
//
// Every check is read-only and every action is idempotent and additive:
//   - an answer already written (.env key, instance.json field) is kept unless
//     the owner changes it on the setup page;
//   - a running ai.jori.session service is never re-rendered or restarted;
//   - a starter job whose `--label` is already in the crontab is not added.
// So running setup on a live installation only fills what is missing.
//
// Used by lib/onboarding/server.mjs (the setup page) and bin/cli.d/setup.mjs.
// Tests: tests/onboarding.test.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { nodeBin } = require("../root.cjs");
const { port } = require("../ports.cjs");

export const SERVICE_LABEL = "ai.jori.session";
// Installations from before the rename run the same process manager under
// ai.claude.session; every check accepts either.
export const SERVICE_LABELS = [SERVICE_LABEL, "ai.claude.session"];
export const STARTER_TAG = "# jori-starter";
export const EMBED_MODEL = "nomic-embed-text";
export const MIN_NODE = [22, 5];

export const RUNTIME_DIRS = [
  "data", "data/hum-cache", "data/logs", "data/watchdog-incidents", "logs",
  "agent/logs", "agent/logs/supervisor-ops", "agent/logs/supervisor-chat",
  "agent/logs/supervisor-ops-light", "agent/logs/supervisor-ops-haiku",
  "agent/supervisor/state/ops", "agent/supervisor/state/chat",
  "agent/local", "agent/local/config", "secrets", "credentials",
];

// examples/<src> → <dst>, copied only when <dst> does not exist yet.
export const SEEDS = [
  ["examples/hum-interests.example.json", "data/hum-interests.json"],
  ["examples/hum-intent.example.md", "data/hum-intent.md"],
];

// ── small helpers ──────────────────────────────────────────────────────────

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

/** Run a command, never throw: { ok, code, stdout, stderr }. */
export function run(cmd, args = [], { timeout = 15000, env, input } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(cmd, args, { timeout, env: env || process.env, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
        resolve({ ok: !err, code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || err?.message || "") });
      });
    } catch (e) {
      resolve({ ok: false, code: 127, stdout: "", stderr: e.message });
      return;
    }
    if (input != null) { child.stdin.end(input); }
  });
}

export function readDotEnv(file) {
  const out = {};
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/); // lang-regex-ok: .env syntax
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * Fill KEY=value where the dotenv file lacks the key or has it empty (the
 * copy of .env.example that bootstrap.sh makes carries `JORI_HOME=`). A key
 * with a value is never changed.
 */
export function addMissingEnv(file, values) {
  const cur = readDotEnv(file);
  const wanted = Object.entries(values).filter(([k, v]) => v !== "" && v != null && !cur[k]);
  const empty = wanted.filter(([k]) => k in cur);
  for (const [k, v] of empty) setEnv(file, k, v);
  const add = wanted.filter(([k]) => !(k in cur));
  if (!add.length && exists(file)) return empty.map(([k]) => k);
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch {
    text = `# Jori environment — started by \`jori setup\` ${new Date().toISOString()}. Every variable is documented in .env.example.\n`;
  }
  if (text && !text.endsWith("\n")) text += "\n";
  text += add.map(([k, v]) => `${k}=${v}`).join("\n") + (add.length ? "\n" : "");
  fs.writeFileSync(file, text, { mode: 0o600 });
  return [...empty, ...add].map(([k]) => k);
}

/** Set one KEY=value, replacing the line when present. */
export function setEnv(file, key, value) {
  let lines = [];
  try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { /* new file */ }
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const i = lines.findIndex((l) => re.test(l));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else { while (lines.length && lines[lines.length - 1] === "") lines.pop(); lines.push(`${key}=${value}`); }
  fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
}

// ── guesses for the "About you" step ───────────────────────────────────────

export function hostTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** "America/Los_Angeles" → "Los Angeles"; zones that are not a city ("UTC", "Etc/GMT+5") → "". */
export function cityFromTz(tz) {
  if (!tz || !tz.includes("/") || tz.startsWith("Etc/")) return "";
  return tz.split("/").pop().replace(/_/g, " ");
}

export async function fullName() {
  if (process.platform === "darwin") {
    const r = await run("id", ["-F"], { timeout: 3000 });
    if (r.ok && r.stdout.trim()) return r.stdout.trim();
  }
  try {
    const gecos = fs.readFileSync("/etc/passwd", "utf8").split("\n").find((l) => l.startsWith(os.userInfo().username + ":"));
    const g = gecos?.split(":")[4]?.split(",")[0];
    if (g) return g;
  } catch { /* none */ }
  return "";
}

export async function gitEmail() {
  const r = await run("git", ["config", "--global", "user.email"], { timeout: 3000 });
  return r.ok ? r.stdout.trim() : "";
}

// ── Claude Code ────────────────────────────────────────────────────────────

/** The claude binary: on PATH, else where its installers put it. */
export function findClaude(home = os.homedir()) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const candidates = [
    ...dirs.map((d) => path.join(d, "claude")),
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  return null;
}

/** Read `claude auth status --json` into what the page shows. */
export function parseClaudeStatus(json) {
  let s;
  try { s = typeof json === "string" ? JSON.parse(json) : json; } catch { return { loggedIn: false }; }
  if (!s || typeof s !== "object") return { loggedIn: false };
  const plan = s.subscriptionType || null;
  const viaSubscription = s.authMethod === "claude.ai";
  return {
    loggedIn: !!s.loggedIn,
    email: s.email || null,
    plan,
    viaSubscription,
    // Jori runs every agent on the subscription (docs/agent-auth-model.md).
    planOk: !!s.loggedIn && viaSubscription && plan === "max",
  };
}

let claudeCache = { at: 0, value: null };
export async function claudeStatus({ fresh = false } = {}) {
  // The page polls every few seconds; `claude auth status` starts a node
  // process, so a reading is reused for 5 s.
  if (!fresh && claudeCache.value && Date.now() - claudeCache.at < 5000) return claudeCache.value;
  claudeCache = { at: Date.now(), value: await readClaudeStatus() };
  return claudeCache.value;
}

async function readClaudeStatus() {
  const bin = findClaude();
  if (!bin) return { installed: false, loggedIn: false };
  const v = await run(bin, ["--version"], { timeout: 10000 });
  const s = await run(bin, ["auth", "status", "--json"], { timeout: 15000 });
  return { installed: true, bin, version: v.stdout.trim().split(" ")[0] || null, ...parseClaudeStatus(s.stdout) };
}

// ── Ollama (memory search) ─────────────────────────────────────────────────

export async function ollamaStatus(url = process.env.OLLAMA_URL || "http://127.0.0.1:11434") {
  const installed = !!(findOnPath("ollama") || exists("/Applications/Ollama.app"));
  try {
    const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    const models = (j.models || []).map((m) => m.name || m.model || "");
    return { installed: true, running: true, model: models.some((m) => m.startsWith(EMBED_MODEL)), url };
  } catch {
    return { installed, running: false, model: false, url };
  }
}

export function findOnPath(name) {
  const dirs = [...(process.env.PATH || "").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

// ── the service (process manager under launchd) ────────────────────────────

export function plistPath(home = os.homedir()) {
  return path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The ai.jori.session plist (docs/installer.md), for this checkout and this node. */
export function renderServicePlist({ base, node = nodeBin(), claudeBin = null, home = os.homedir() }) {
  const pathDirs = [...new Set([
    path.dirname(node), claudeBin && path.dirname(claudeBin), path.join(home, ".local", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ].filter(Boolean))].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xml(node)}</string>
        <string>${xml(path.join(base, "agent", "bin", "process-manager.mjs"))}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(base)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>JORI_HOME</key>
        <string>${xml(base)}</string>
        <key>PATH</key>
        <string>${xml(pathDirs)}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xml(path.join(base, "agent", "logs", "launchagent.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(path.join(base, "agent", "logs", "launchagent.err.log"))}</string>
</dict>
</plist>
`;
}

async function health(name) {
  try {
    const r = await fetch(`http://127.0.0.1:${port(name)}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

/** The loaded launchd label of the process manager, or null. */
export async function loadedServiceLabel() {
  if (process.platform !== "darwin") return null;
  const domain = `gui/${process.getuid?.() ?? 0}`;
  for (const label of SERVICE_LABELS) {
    const r = await run("launchctl", ["print", `${domain}/${label}`], { timeout: 5000 });
    if (r.ok) return { label, running: /state = running/.test(r.stdout) };
  }
  return null;
}

export async function serviceStatus() {
  const installed = SERVICE_LABELS.some((l) => exists(path.join(os.homedir(), "Library", "LaunchAgents", `${l}.plist`)));
  const svc = await loadedServiceLabel();
  const [chat, ops] = await Promise.all([health("chat_health"), health("ops_health")]);
  return { installed, loaded: !!svc, label: svc?.label || null, running: !!svc?.running || chat || ops, chat, ops };
}

export async function installService({ base }) {
  if (process.platform !== "darwin") return { ok: false, message: "The background service is set up with launchd, which is macOS only. On Linux, use the systemd unit in docs/installer.md." };
  const st = await serviceStatus();
  if (st.running) return { ok: true, message: "Already running", unchanged: true };
  const file = plistPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(base, "agent", "logs"), { recursive: true });
  fs.writeFileSync(file, renderServicePlist({ base, claudeBin: findClaude() }));
  const lint = await run("plutil", ["-lint", file]);
  if (!lint.ok) return { ok: false, message: `The service file did not check out: ${lint.stdout || lint.stderr}` };
  const domain = `gui/${process.getuid()}`;
  await run("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]);
  const b = await run("launchctl", ["bootstrap", domain, file]);
  if (!b.ok) return { ok: false, message: `launchd refused to start it: ${b.stderr.trim()}` };
  return { ok: true, message: "Started" };
}

// ── the starter schedule ───────────────────────────────────────────────────

/** The starter jobs with their schedule and script resolved from tasks.json. */
export function starterJobs(base) {
  const spec = readJson(path.join(base, "system", "starter-jobs.json"), { jobs: [] });
  const tasks = readJson(path.join(base, "system", "tasks.json"), { tasks: [] }).tasks || [];
  const out = [];
  for (const j of spec.jobs) {
    const t = tasks.find((x) => x.name === j.name) || {};
    const schedule = j.schedule || t.schedule;
    const script = j.script || t.trigger_script;
    if (!schedule || !script || !/^\S+ \S+ \S+ \S+ \S+$/.test(schedule)) continue;
    if (t.scheduler === "launchd") continue;
    out.push({ name: j.name, why: j.why || t.description || "", schedule, script, label: j.label || path.basename(script, ".sh") });
  }
  return out;
}

export function cronLine(job, { base, node = nodeBin() }) {
  const pathEnv = [...new Set([path.dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  return `${job.schedule} PATH=${pathEnv} JORI_HOME=${base} ${path.join(base, "bin", "cron-run")} --label ${job.label} -- ${path.join(base, job.script)} ${STARTER_TAG}`;
}

/** Which starter jobs are missing from this crontab text. */
export function missingStarterJobs(crontabText, jobs) {
  const have = new Set();
  for (const l of String(crontabText || "").split("\n")) {
    const m = l.match(/--label\s+(\S+)/); // lang-regex-ok: cron-run flag
    if (m) have.add(m[1]);
  }
  return jobs.filter((j) => !have.has(j.label));
}

export async function readCrontab() {
  const r = await run("crontab", ["-l"], { timeout: 20000 });
  if (r.ok) return { ok: true, text: r.stdout };
  if (/no crontab/i.test(r.stderr)) return { ok: true, text: "", empty: true };
  return { ok: false, error: r.stderr.trim() || `crontab -l exited ${r.code}` };
}

export async function scheduleStatus(base) {
  const jobs = starterJobs(base);
  const ct = await readCrontab();
  if (!ct.ok) return { ok: false, error: ct.error, total: jobs.length, missing: jobs.length, jobs };
  const missing = missingStarterJobs(ct.text, jobs);
  return { ok: true, total: jobs.length, missing: missing.length, jobs: jobs.map((j) => ({ ...j, installed: !missing.includes(j) })) };
}

export async function installStarterSchedule({ base }) {
  const jobs = starterJobs(base);
  const ct = await readCrontab();
  if (!ct.ok) return { ok: false, message: `Could not read the crontab, so nothing was changed: ${ct.error}` };
  const missing = missingStarterJobs(ct.text, jobs);
  if (!missing.length) return { ok: true, message: "Already scheduled", added: 0, unchanged: true };
  const lines = missing.map((j) => cronLine(j, { base }));
  if (ct.empty || !ct.text.trim()) {
    // A fresh account has no crontab; bin/crontab-safe refuses an empty read
    // by design, so the first one is written here.
    const text = `# Jori — starter jobs from \`jori setup\`. Manage them on the control room's Schedule page.\n${lines.join("\n")}\n`;
    const w = await run("crontab", ["-"], { input: text, timeout: 20000 });
    if (!w.ok) return { ok: false, message: `crontab refused the new lines: ${w.stderr.trim()}` };
  } else {
    // Keep every line already there; add ours through crontab-safe. `replace`
    // drops tagged lines first, so re-add the starter lines that already exist.
    const keep = ct.text.split("\n").filter((l) => l.includes(STARTER_TAG));
    const w = await run(path.join(base, "bin", "crontab-safe"), ["replace", STARTER_TAG, ...keep, ...lines], { timeout: 60000 });
    if (!w.ok) return { ok: false, message: `crontab-safe did not change the crontab: ${w.stderr.trim()}` };
  }
  return { ok: true, message: `${missing.length} jobs scheduled`, added: missing.length };
}

// ── files ──────────────────────────────────────────────────────────────────

/** The zero-question part: runtime dirs, webhook token, seeds, .env basics. */
export function prepareCheckout(base, { tz = hostTz() } = {}) {
  const done = [];
  for (const d of RUNTIME_DIRS) fs.mkdirSync(path.join(base, d), { recursive: true });
  const tokenPath = path.join(base, "secrets", "webhook-token");
  if (!exists(tokenPath)) {
    fs.writeFileSync(tokenPath, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    done.push("secrets/webhook-token");
  }
  for (const [src, dst] of SEEDS) {
    const from = path.join(base, src), to = path.join(base, dst);
    if (exists(to) || !exists(from)) continue;
    fs.copyFileSync(from, to);
    done.push(dst);
  }
  const tzFile = path.join(base, "data", "user-timezone.json");
  if (!exists(tzFile)) {
    fs.writeFileSync(tzFile, JSON.stringify({ timezone: tz, updated_at: new Date().toISOString() }, null, 2) + "\n");
    done.push("data/user-timezone.json");
  }
  const added = addMissingEnv(path.join(base, ".env"), {
    JORI_HOME: base,
    OLLAMA_URL: "http://127.0.0.1:11434",
    LOCAL_EMBED_MODEL: EMBED_MODEL,
  });
  if (added.length) done.push(`.env (${added.join(", ")})`);
  return done;
}

export function instancePath(base) {
  return path.join(base, "agent", "local", "instance.json");
}

export const IDENTITY_FIELDS = ["owner_name", "owner_email", "tz", "home_city", "assistant_name", "partner_name"];

/** Merge the "About you" answers into instance.json; blank optional fields are dropped. */
export function writeIdentity(base, answers) {
  const file = instancePath(base);
  const cur = readJson(file, {}) || {};
  const next = { ...cur };
  for (const k of IDENTITY_FIELDS) {
    if (!(k in answers)) continue;
    const v = String(answers[k] ?? "").trim().slice(0, 200);
    if (v) next[k] = v; else if (k === "home_city" || k === "partner_name") delete next[k];
  }
  if (next.tz) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: next.tz }); } catch { throw new Error(`"${next.tz}" is not a time zone this Mac knows`); }
  }
  if (next.owner_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.owner_email)) throw new Error("That email address does not look complete"); // lang-regex-ok: email shape check
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  if (next.tz) {
    fs.writeFileSync(path.join(base, "data", "user-timezone.json"), JSON.stringify({ timezone: next.tz, updated_at: new Date().toISOString() }, null, 2) + "\n");
  }
  return next;
}

export async function identityDraft(base, claude) {
  const cur = readJson(instancePath(base), {}) || {};
  const tz = cur.tz || hostTz();
  const name = (await fullName()) || os.userInfo().username;
  return {
    owner_name: cur.owner_name && cur.owner_name !== "the user" ? cur.owner_name : name.split(/\s+/)[0],
    owner_email: cur.owner_email || claude?.email || (await gitEmail()) || "",
    tz,
    home_city: cur.home_city ?? cityFromTz(tz),
    assistant_name: cur.assistant_name || "Jori",
    partner_name: cur.partner_name || "",
    saved: !!(cur.owner_email && cur.owner_name && cur.owner_name !== "the user"),
  };
}

// ── background work the page can start ─────────────────────────────────────

/** Start a long command; returns a handle whose .state the page polls. */
export function startJob(cmd, args, { env } = {}) {
  const job = { state: "running", out: "", startedAt: Date.now() };
  let child;
  try {
    child = spawn(cmd, args, { env: env || process.env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return { state: "error", out: e.message };
  }
  const take = (b) => { job.out = (job.out + b.toString()).slice(-4000); };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  child.on("error", (e) => { job.state = "error"; job.out += `\n${e.message}`; });
  child.on("exit", (code) => { job.state = code === 0 ? "done" : "error"; job.code = code; });
  job.child = child;
  return job;
}

/** The first https URL a login command printed (shown in case no browser opened). */
export function firstUrl(text) {
  const m = String(text || "").match(/https:\/\/\S+/); // lang-regex-ok: URL in CLI output
  return m ? m[0].replace(/[).,]+$/, "") : null;
}

/** Everything the setup page shows, in one read. */
export async function snapshot(base) {
  const [claude, ollama, service, schedule] = await Promise.all([claudeStatus(), ollamaStatus(), serviceStatus(), scheduleStatus(base)]);
  const [maj, min] = process.versions.node.split(".").map(Number);
  return {
    base,
    platform: process.platform,
    node: { version: process.versions.node, ok: maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]) },
    claude,
    ollama,
    service,
    schedule,
    identity: await identityDraft(base, claude),
    controlUrl: `http://127.0.0.1:${port("wiki")}/control#setup`,
    brew: !!findOnPath("brew"),
    npm: !!findOnPath("npm"),
  };
}
