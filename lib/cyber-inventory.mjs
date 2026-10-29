// cyber-inventory.mjs — what the user actually runs, so cyber-watch can check
// whether a security story APPLIES before it reaches them. Requirement: a story
// is sent only after checking whether it applies to the user's systems and
// code, with what to do about it and how urgently.
//
// Two halves, both pure structure (versions, lockfiles), no language:
//   collectHost()  — the Jori host: macOS, runtimes, Homebrew formulae/casks,
//                    global npm, pip, Docker images, Chrome, listening ports.
//   collectRepos() — every non-archived GitHub repo of instance().github_owner: lockfiles and
//                    manifests on the default branch, parsed to
//                    {ecosystem, name, version, repo, file, dev}.
//   osvScan()      — OSV.dev batch lookup of every (ecosystem, name, version):
//                    known vulnerabilities AND malicious-package (MAL-) records.
//
// Other devices (a laptop, phones) are NOT inventoried (only the host runs
// Jori); verdicts say so when it matters (a browser or macOS flaw).
//
// Playbook: agent/ops-agent/jobs/cyber-watch.md § Exposure check

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { instance } = createRequire(import.meta.url)("./instance.cjs");
const GITHUB_OWNER = () => instance().github_owner || "";
const HOST_TITLE = () => instance().host_title || "the server";

const HOME = os.homedir();
const sh = (cmd, args, { timeout = 30000, maxBuffer = 64 * 1024 * 1024 } = {}) => {
  try { return execFileSync(cmd, args, { encoding: "utf8", timeout, maxBuffer, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch (e) { return (e.stdout || "").toString().trim() || null; }
};
const exists = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };
const firstExisting = (...ps) => ps.find(exists) || null;
const DOCKER = () => firstExisting("/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker");

// ------------------------------------------------------------------ host

export function collectHost() {
  const BREW = firstExisting("/opt/homebrew/bin/brew", "/usr/local/bin/brew");
  const runtimes = {};
  runtimes.macos = sh("sw_vers", ["-productVersion"]);
  // kernel-closure-ok: an inventory probe of the node builds installed here, not a way to run kernel code
  const nodes = [...new Set([`${HOME}/.local/node/bin/node`, "/opt/homebrew/bin/node", "/usr/local/bin/node"].filter(exists))];
  runtimes.node = nodes.map((b) => `${sh(b, ["--version"])} (${b})`).join("; ") || null;
  runtimes.python = [...new Set(["/opt/homebrew/bin/python3", "/usr/bin/python3"].filter(exists))].map((b) => `${sh(b, ["--version"])} (${b})`).join("; ") || null;
  runtimes.php = firstExisting("/opt/homebrew/bin/php", "/usr/local/bin/php", "/usr/bin/php") ? sh(firstExisting("/opt/homebrew/bin/php", "/usr/local/bin/php", "/usr/bin/php"), ["-v"])?.split("\n")[0] : "not installed";
  runtimes.openssh = sh("ssh", ["-V"]) || (() => { try { execFileSync("ssh", ["-V"], { stdio: ["ignore", "ignore", "pipe"] }); } catch (e) { return String(e.stderr || "").trim(); } })();
  runtimes.chrome = sh("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--version"]) || "not installed";
  for (const [k, cmd, args] of [
    ["docker", DOCKER() || "/usr/local/bin/docker", ["--version"]], ["tailscale", "/opt/homebrew/bin/tailscale", ["version"]],
    ["ollama", "/opt/homebrew/bin/ollama", ["--version"]], ["git", "git", ["--version"]], ["gh", "/opt/homebrew/bin/gh", ["--version"]],
    ["claude-code", `${HOME}/.local/bin/claude`, ["--version"]], ["op", "/opt/homebrew/bin/op", ["--version"]],
  ]) runtimes[k] = (cmd.startsWith("/") && !exists(cmd)) ? "not installed" : (sh(cmd, args)?.split("\n")[0] || "unknown");

  const brew = {};
  if (BREW) {
    for (const flag of ["--formula", "--cask"]) {
      for (const line of (sh(BREW, ["list", flag, "--versions"], { timeout: 60000 }) || "").split("\n")) {
        const [name, ...vers] = line.trim().split(/\s+/); // lang-regex-ok: whitespace split of `brew list --versions` output
        if (name) brew[name] = vers.join(" ");
      }
    }
  }

  const npmGlobal = {};
  try {
    const npm = firstExisting(`${HOME}/.local/node/bin/npm`, "/opt/homebrew/bin/npm");
    const j = JSON.parse(sh(npm, ["ls", "-g", "--depth=0", "--json"]) || "{}");
    for (const [n, d] of Object.entries(j.dependencies || {})) npmGlobal[n] = d.version;
  } catch {}

  const pip = {};
  try {
    for (const p of JSON.parse(sh("/opt/homebrew/bin/python3", ["-m", "pip", "list", "--format=json"]) || "[]")) pip[p.name.toLowerCase()] = p.version;
  } catch {}

  const docker = [];
  if (DOCKER()) {
    for (const line of (sh(DOCKER(), ["images", "--format", "{{.Repository}}:{{.Tag}}"], { timeout: 20000 }) || "").split("\n")) if (line && !line.startsWith("<none>")) docker.push(line);
  }

  // Listening sockets: a flaw that needs network reach matters only if something listens beyond localhost.
  const listening = [];
  const seen = new Set();
  for (const line of (sh("/usr/sbin/lsof", ["-iTCP", "-sTCP:LISTEN", "-nP"], { timeout: 20000 }) || "").split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/); // lang-regex-ok: column split of lsof output
    const addr = cols[8];
    if (!addr) continue;
    const local = addr.startsWith("127.") || addr.startsWith("[::1]") || addr.startsWith("localhost");
    const key = `${cols[0]} ${addr}`;
    if (seen.has(key)) continue;
    seen.add(key);
    listening.push({ process: cols[0], address: addr, exposure: local ? "localhost only" : "all interfaces (LAN/Tailscale)" });
  }

  return { machine: `${HOST_TITLE()} (Jori server)`, runtimes, brew, npm_global: npmGlobal, pip, docker_images: docker, listening };
}

// ----------------------------------------------------------------- repos

const SKIP_DIR = ["node_modules/", "/vendor/", "/build/", ".dart_tool/", "/Pods/", "/dist/", ".claude/worktrees/", "/.next/", "/.venv/", "/venv/"];
const MANIFESTS = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "package.json", "pubspec.lock",
  "requirements.txt", "requirements-dev.txt", "poetry.lock", "uv.lock", "Pipfile.lock", "Cargo.lock",
  "Package.resolved", "Podfile.lock", "Dockerfile", ".nvmrc", ".node-version", "go.sum",
]);

function gh(args, opts) { return sh("gh", args, { timeout: 60000, ...opts }); }

export function listRepos(owner = GITHUB_OWNER()) {
  if (!owner) return [];
  const out = gh(["repo", "list", owner, "--limit", "300", "--json", "name,isArchived,pushedAt,defaultBranchRef,isPrivate"]);
  return JSON.parse(out || "[]").filter((r) => !r.isArchived && r.defaultBranchRef?.name)
    .map((r) => ({ name: r.name, branch: r.defaultBranchRef.name, pushed_at: r.pushedAt, private: r.isPrivate }));
}

function repoFiles(owner, repo) {
  const t = JSON.parse(gh(["api", `repos/${owner}/${repo.name}/git/trees/${repo.branch}?recursive=1`]) || "{}");
  return (t.tree || []).filter((e) => e.type === "blob" && MANIFESTS.has(path.basename(e.path)) && !SKIP_DIR.some((d) => `/${e.path}`.includes(d)) && (e.size || 0) < 40 * 1024 * 1024)
    .slice(0, 60).map((e) => e.path);
}

function rawFile(owner, repo, p) {
  return gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${owner}/${repo.name}/contents/${encodeURI(p)}?ref=${repo.branch}`], { maxBuffer: 128 * 1024 * 1024 });
}

// Parsers — each returns [{eco, name, version, dev?}]. Lockfile formats are machine-generated.
export function parseManifest(file, text) {
  const base = path.basename(file);
  const out = [];
  const add = (eco, name, version, dev) => { if (name && version) out.push({ eco, name, version: String(version), ...(dev ? { dev: true } : {}) }); };
  try {
    if (base === "package-lock.json" || base === "npm-shrinkwrap.json") {
      const j = JSON.parse(text);
      if (j.packages) {
        for (const [k, v] of Object.entries(j.packages)) {
          if (!k) continue;
          // The install path is the name code imports; `name`, when present, is the real package
          // (an npm alias or a git fork, e.g. @whiskeysockets/baileys installed from a fork named "baileys").
          const installed = k.slice(k.lastIndexOf("node_modules/") + "node_modules/".length);
          add("npm", installed, v.version, v.dev);
          if (v.name && v.name !== installed) add("npm", v.name, v.version, v.dev);
        }
      } else {
        const walk = (deps) => { for (const [n, v] of Object.entries(deps || {})) { add("npm", n, v.version, v.dev); walk(v.dependencies); } };
        walk(j.dependencies);
      }
    } else if (base === "pnpm-lock.yaml") {
      let inPk = false;
      for (const line of text.split("\n")) {
        if (/^(packages|snapshots):\s*$/.test(line)) { inPk = true; continue; } // lang-regex-ok: YAML section header in pnpm lockfile
        if (/^\S/.test(line)) inPk = false; // lang-regex-ok: YAML top-level key
        if (!inPk) continue;
        // lang-regex-ok: pnpm lockfile package keys ("  /name@1.2.3:", "  '@scope/name@1.2.3(peer)':", v5 "  /name/1.2.3:")
        const m = line.match(/^ {2}'?\/?((?:@[^/@\s']+\/)?[^/@\s'(]+)[@/](\d[^('\s:]*)/);
        if (m) add("npm", m[1], m[2]);
      }
    } else if (base === "yarn.lock") {
      let names = null;
      for (const line of text.split("\n")) {
        if (line && !line.startsWith(" ") && !line.startsWith("#") && line.trimEnd().endsWith(":")) {
          const spec = line.replace(/:$/, "").split(",")[0].trim().replace(/^"|"$/g, ""); // lang-regex-ok: yarn.lock header syntax
          const at = spec.lastIndexOf("@");
          names = at > 0 ? spec.slice(0, at) : spec;
        } else if (names) {
          const m = line.match(/^ {2}version:? "?([^"\s]+)"?/); // lang-regex-ok: yarn.lock version field
          if (m) { add("npm", names.replace(/@npm$/, ""), m[1]); names = null; }
        }
      }
    } else if (base === "package.json") {
      const j = JSON.parse(text);
      if (j.engines?.node) add("engine", "node", j.engines.node);
    } else if (base === "pubspec.lock") {
      let cur = null;
      for (const line of text.split("\n")) {
        const n = line.match(/^ {2}([A-Za-z0-9_]+):\s*$/); // lang-regex-ok: pubspec.lock package key
        if (n) { cur = n[1]; continue; }
        const v = line.match(/^ {4}version: "?([^"\s]+)"?/); // lang-regex-ok: pubspec.lock version field
        if (v && cur) { add("Pub", cur, v[1]); cur = null; }
      }
    } else if (base.startsWith("requirements")) {
      for (const line of text.split("\n")) {
        const m = line.trim().match(/^([A-Za-z0-9_.\-[\]]+)\s*==\s*([^\s;#]+)/); // lang-regex-ok: pip requirement pin syntax
        if (m) add("PyPI", m[1].replace(/\[.*\]/, "").toLowerCase(), m[2]);
      }
    } else if (base === "poetry.lock" || base === "uv.lock" || base === "Cargo.lock") {
      const eco = base === "Cargo.lock" ? "crates.io" : "PyPI";
      for (const block of text.split("[[package]]").slice(1)) {
        const n = block.match(/^name = "([^"]+)"/m), v = block.match(/^version = "([^"]+)"/m); // lang-regex-ok: TOML lockfile fields
        if (n && v) add(eco, eco === "PyPI" ? n[1].toLowerCase() : n[1], v[1]);
      }
    } else if (base === "Pipfile.lock") {
      const j = JSON.parse(text);
      for (const sect of ["default", "develop"]) for (const [n, v] of Object.entries(j[sect] || {})) add("PyPI", n.toLowerCase(), String(v.version || "").replace(/^==/, ""), sect === "develop");
    } else if (base === "Package.resolved") {
      const j = JSON.parse(text);
      for (const p of j.pins || j.object?.pins || []) {
        const url = String(p.location || p.repositoryURL || "").replace(/^https?:\/\//, "").replace(/\.git$/, ""); // lang-regex-ok: URL normalisation
        add("SwiftURL", url, p.state?.version);
      }
    } else if (base === "Podfile.lock") {
      for (const line of text.split("\n")) {
        const m = line.match(/^ {2}- ([^\s(]+) \(([^)]+)\)/); // lang-regex-ok: Podfile.lock pod entry
        if (m) add("CocoaPods", m[1], m[2]);
      }
    } else if (base === "Dockerfile") {
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i); // lang-regex-ok: Dockerfile FROM instruction
        if (m) { const [img, tag] = m[1].split(":"); add("docker-image", img, tag || "latest"); }
      }
    } else if (base === ".nvmrc" || base === ".node-version") {
      add("engine", "node", text.trim());
    } else if (base === "go.sum") {
      for (const line of text.split("\n")) { const [mod, ver] = line.split(" "); if (mod && ver && !ver.endsWith("/go.mod")) add("Go", mod, ver); }
    }
  } catch { /* an unparseable manifest is skipped, not fatal */ }
  return out;
}

export function collectRepos({ owner = GITHUB_OWNER(), log = () => {} } = {}) {
  const repos = [];
  const packages = [];
  for (const r of listRepos(owner)) {
    let files = [];
    try { files = repoFiles(owner, r); } catch (e) { log(`repo ${r.name}: tree failed ${e.message}`); }
    let n = 0;
    for (const f of files) {
      const text = rawFile(owner, r, f);
      if (!text) continue;
      for (const p of parseManifest(f, text)) { packages.push({ ...p, repo: r.name, file: f }); n++; }
    }
    repos.push({ name: r.name, pushed_at: r.pushed_at, manifests: files, packages: n });
  }
  log(`repos: ${repos.length}, package rows: ${packages.length}`);
  return { repos, packages };
}

// --------------------------------------------------------------- lookups

/** Group package rows by ecosystem:name (lowercased) → [{version, repo, file, dev}], deduped. */
export function indexPackages(packages) {
  const idx = {};
  for (const p of packages) {
    const k = `${p.eco}:${p.name.toLowerCase()}`;
    const list = (idx[k] ||= []);
    if (!list.some((x) => x.version === p.version && x.repo === p.repo)) list.push({ version: p.version, repo: p.repo, file: p.file, ...(p.dev ? { dev: true } : {}) });
  }
  return idx;
}

/** Exact-name lookup of the software a story names, across repos and the host. Identity, not reading. */
export function lookupSoftware(inv, names) {
  const hits = [];
  for (const raw of names || []) {
    const name = String(raw.name || "").toLowerCase().trim();
    if (!name) continue;
    // "runtime"/"homebrew" name host software; also match repo rows (engines, Docker base images) of the same name.
    const eco = raw.ecosystem && !["any", "runtime", "homebrew"].includes(raw.ecosystem) ? raw.ecosystem : null;
    for (const [k, rows] of Object.entries(inv.index || {})) {
      const [e, n] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
      if (n === name && (!eco || e.toLowerCase() === eco.toLowerCase())) hits.push({ query: raw.name, where: "repos", ecosystem: e, name: n, installs: rows.slice(0, 25), total_installs: rows.length });
    }
    const h = inv.host || {};
    if (h.runtimes && name in h.runtimes) hits.push({ query: raw.name, where: "mac-mini runtime", name, version: h.runtimes[name] });
    for (const [label, map] of [["mac-mini homebrew", h.brew], ["mac-mini global npm", h.npm_global], ["mac-mini pip", h.pip]]) {
      if (map && map[name] !== undefined) hits.push({ query: raw.name, where: label, name, version: map[name] });
    }
    for (const img of h.docker_images || []) if (img.toLowerCase().split(":")[0].endsWith(name)) hits.push({ query: raw.name, where: "mac-mini docker image", name: img });
  }
  return hits;
}

/** A short description of what the inventory covers, for the verdict prompt. */
export function inventorySummary(inv, { uninventoried = "" } = {}) {
  const h = inv.host || {};
  const owner = GITHUB_OWNER();
  const ecoCount = {};
  for (const k of Object.keys(inv.index || {})) { const e = k.slice(0, k.indexOf(":")); ecoCount[e] = (ecoCount[e] || 0) + 1; }
  return {
    built_at: inv.built_at,
    coverage: `${HOST_TITLE()} (the Jori server)${owner ? ` + the default branch of every non-archived GitHub repo of ${owner}` : ""}. ${uninventoried || "Other devices"} ${uninventoried ? "is" : "are"} not inventoried.`,
    host_runtimes: h.runtimes,
    host_listening: (h.listening || []).filter((l) => l.exposure !== "localhost only"),
    homebrew_count: Object.keys(h.brew || {}).length,
    repos: (inv.repos || []).map((r) => ({ name: r.name, last_push: String(r.pushed_at || "").slice(0, 10), packages: r.packages })),
    distinct_packages_by_ecosystem: ecoCount,
  };
}

// ------------------------------------------------------------------- OSV

const OSV_ECO = { npm: "npm", PyPI: "PyPI", Pub: "Pub", "crates.io": "crates.io", SwiftURL: "SwiftURL", Go: "Go" };

/** OSV batch query over every distinct (eco, name, version) in the repos. Returns [{eco, name, version, ids}]. */
export async function osvScan(inv, { log = () => {} } = {}) {
  const queries = [];
  for (const [k, rows] of Object.entries(inv.index || {})) {
    const e = k.slice(0, k.indexOf(":"));
    if (!OSV_ECO[e]) continue;
    const n = k.slice(k.indexOf(":") + 1);
    const realName = inv.names?.[k] || n;
    for (const v of new Set(rows.map((r) => r.version))) queries.push({ package: { ecosystem: OSV_ECO[e], name: realName }, version: v });
  }
  const hits = [];
  for (let i = 0; i < queries.length; i += 1000) {
    const chunk = queries.slice(i, i + 1000);
    const res = await fetch("https://api.osv.dev/v1/querybatch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queries: chunk }), signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`OSV HTTP ${res.status}`);
    const j = await res.json();
    (j.results || []).forEach((r, k) => { if (r.vulns?.length) hits.push({ eco: chunk[k].package.ecosystem, name: chunk[k].package.name, version: chunk[k].version, ids: r.vulns.map((v) => v.id) }); });
  }
  log(`OSV: ${queries.length} package versions checked, ${hits.length} with known issues`);
  return hits;
}

/** Fetch one OSV record (summary, severity, fixed versions), compacted. */
export async function osvVuln(id) {
  const res = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) return { id };
  const v = await res.json();
  const fixed = [];
  for (const a of v.affected || []) for (const r of a.ranges || []) for (const ev of r.events || []) if (ev.fixed) fixed.push(ev.fixed);
  const sev = v.database_specific?.severity || (v.severity || []).map((s) => s.score).join(" ") || null;
  return { id: v.id, aliases: v.aliases || [], summary: v.summary || String(v.details || "").slice(0, 300), severity: sev, fixed: [...new Set(fixed)].slice(0, 6), malicious: String(v.id).startsWith("MAL-"), published: v.published };
}

// ---------------------------------------------------------- persistence

export function buildInventory({ log = () => {} } = {}) {
  const host = collectHost();
  const { repos, packages } = collectRepos({ log });
  const index = indexPackages(packages);
  const names = {};
  for (const p of packages) names[`${p.eco}:${p.name.toLowerCase()}`] ||= p.name;
  return { built_at: new Date().toISOString(), host, repos, index, names };
}
