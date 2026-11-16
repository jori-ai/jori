// cyber-checks.mjs — the deterministic checks behind a cyber-watch verdict.
//
// Requirement: an item the user hears about has been CHECKED by code where a
// check is possible, and its verdict says what was checked and what was found.
// The model writes prose over these results; it never decides a fact a check
// can settle (Rule #0b: code owns facts, a model owns language).
//
// Every check returns { check, status, result, data? } where status is one of:
//   "found"   — the check found the problem (an affected version, an IOC, an
//               off-host unauthenticated service, a reachable vulnerable dep)
//   "clean"   — the check ran and found nothing
//   "n/a"     — the check ran and the thing it looks for is absent
//   "error"   — the check could not run (API failure, rate limit, timeout).
//               Never read as clean: an errored check makes the item "needs you".
//
// I/O is injected (gh, probe, ssh) so tests drive every branch, including the
// failure branches, without a network.
//
// Playbook: agent/ops-agent/jobs/cyber-watch.md § Checks

import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isTailnet, isLoopback } = require("./net-trust.cjs");

const DAY = 86400000;

// ------------------------------------------------------------- versions

/** First dotted version number in a string ("git version 2.50.1 (Apple Git-155)" → [2,50,1]). */
export function parseVersion(s) {
  const m = String(s || "").match(/(\d+(?:\.\d+)+|\d+)/); // lang-regex-ok: version-number syntax in tool output
  return m ? m[1].split(".").map(Number) : null;
}

export function cmpVer(a, b) {
  const x = Array.isArray(a) ? a : parseVersion(a), y = Array.isArray(b) ? b : parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Is version `have` affected, given NVD-style ranges and/or a list of fixed
 * versions? Fixed lists are per release branch (git: 2.50.2, 2.51.3, …): a
 * fix on have's own major.minor decides; otherwise have ≥ the newest fix is
 * fixed and anything older is affected.
 *   ranges: [{ start, startIncl, end, endIncl }] (any field optional)
 * → { status: "affected"|"fixed"|"unknown", reason }
 */
export function versionStatus(have, { ranges = [], fixed = [] } = {}) {
  const h = parseVersion(have);
  if (!h) return { status: "unknown", reason: `no version number in "${have}"` };
  const hs = h.join(".");
  const usable = ranges.filter((r) => r.end || r.start);
  if (usable.length) {
    for (const r of usable) {
      const lo = r.start ? cmpVer(h, r.start) : 1;
      const hi = r.end ? cmpVer(h, r.end) : -1;
      const inLo = r.start ? (r.startIncl === false ? lo > 0 : lo >= 0) : true;
      const inHi = r.end ? (r.endIncl ? hi <= 0 : hi < 0) : true;
      if (inLo && inHi) return { status: "affected", reason: `${hs} is inside the affected range ${fmtRange(r)}` };
    }
    return { status: "fixed", reason: `${hs} is outside every affected range (${usable.map(fmtRange).join("; ")})` };
  }
  const fx = fixed.map(parseVersion).filter(Boolean).sort(cmpVer);
  if (!fx.length) return { status: "unknown", reason: "the advisory gives no affected range or fixed version" };
  const sameBranch = fx.find((f) => f[0] === h[0] && (f.length < 2 || f[1] === h[1]));
  if (sameBranch) {
    return cmpVer(h, sameBranch) < 0
      ? { status: "affected", reason: `${hs} is below ${sameBranch.join(".")}, the fix on its branch` }
      : { status: "fixed", reason: `${hs} is at or above ${sameBranch.join(".")}, the fix on its branch` };
  }
  const newest = fx[fx.length - 1];
  return cmpVer(h, newest) >= 0
    ? { status: "fixed", reason: `${hs} is at or above the newest fixed version ${newest.join(".")}` }
    : { status: "affected", reason: `${hs} is below the fixed versions (${fx.map((f) => f.join(".")).join(", ")}) and its branch has no fix` };
}

function fmtRange(r) {
  return [r.start && `${r.startIncl === false ? ">" : ">="}${r.start}`, r.end && `${r.endIncl ? "<=" : "<"}${r.end}`].filter(Boolean).join(" ") || "all versions";
}

// Runtime keys in the inventory → the CPE product names NVD uses for them.
export const CPE_PRODUCTS = {
  git: ["git"], chrome: ["chrome"], macos: ["macos", "mac_os", "mac_os_x"], openssh: ["openssh"], sshd: ["openssh"],
  node: ["node.js", "nodejs"], python: ["python"], docker: ["docker", "docker_desktop"], tailscale: ["tailscale"],
  ollama: ["ollama"], php: ["php"], gh: ["cli"], "claude-code": ["claude_code"], op: ["1password_cli"],
};

/** Every install of a runtime key on the host: "v1 (path); v2 (path)" → [{version, where}]. */
export function hostInstalls(runtimes, key) {
  const v = runtimes?.[key];
  if (!v || /^not installed$/i.test(v) || v === "unknown") return []; // lang-regex-ok: the inventory's own sentinel strings
  return String(v).split("; ").map((part) => {
    const m = part.match(/\(([^)]*\/[^)]*)\)\s*$/); // lang-regex-ok: "(path)" suffix the inventory writes
    return { version: part, where: m ? m[1] : null };
  });
}

/**
 * Compare every host install of each named runtime against the advisory.
 * nvd: [{ id, ranges: [{product, start, startIncl, end, endIncl}] }]
 * fixedFromArticle: { key: ["2.50.2", …] } — model-extracted, labelled as such.
 */
export function hostVersionCheck(inv, keys, { nvd = [], fixedFromArticle = {}, host = "the host" } = {}) {
  const out = [];
  for (const key of [...new Set(keys)]) {
    const installs = hostInstalls(inv?.host?.runtimes, key);
    if (!installs.length) {
      if (inv?.host?.runtimes && key in inv.host.runtimes) out.push({ check: `${key} version on ${host}`, status: "n/a", result: `${key} is not installed on ${host}` });
      continue;
    }
    const prods = CPE_PRODUCTS[key] || [key];
    const ranges = nvd.flatMap((n) => (n.ranges || []).filter((r) => prods.includes(String(r.product || "").toLowerCase())).map((r) => ({ ...r, cve: n.id })));
    const fixed = fixedFromArticle[key] || [];
    const source = ranges.length ? `NVD ${[...new Set(ranges.map((r) => r.cve))].join(", ")}` : fixed.length ? "fixed versions named in the article (not NVD)" : null;
    for (const ins of installs) {
      const st = versionStatus(ins.version, { ranges, fixed });
      out.push({
        kind: "version",
        check: `${key} version on ${host}${ins.where ? ` (${ins.where})` : ""}`,
        status: st.status === "affected" ? "found" : st.status === "fixed" ? "clean" : "error",
        result: `${ins.version.replace(/\s*\([^)]*\/[^)]*\)\s*$/, "")}: ${st.reason}${source ? ` [source: ${source}]` : ""}`, // lang-regex-ok: strip the inventory's "(path)" suffix
      });
    }
  }
  return out;
}

// ------------------------------------------------------------ listeners

/** The host's own LAN IPv4 (not loopback, not tailnet) — the address a LAN neighbour would use. */
export function lanAddress(ifaces = os.networkInterfaces()) {
  for (const list of Object.values(ifaces)) for (const a of list || []) {
    if ((a.family === "IPv4" || a.family === 4) && !a.internal && !isTailnet(a.address) && !isLoopback(a.address) && !a.address.startsWith("169.254.")) return a.address;
  }
  return null;
}

/** One unauthenticated GET; resolves { status } or { error }. Never throws. */
export function probeHttp(host, port, pathName = "/", { timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: pathName, method: "GET", timeout: timeoutMs, headers: { "User-Agent": "cyber-watch-probe" } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on("timeout", () => { req.destroy(); resolve({ error: "timeout" }); });
    req.on("error", (e) => resolve({ error: e.code || e.message }));
    req.end();
  });
}

function portOf(address) {
  const i = String(address).lastIndexOf(":");
  return i < 0 ? null : Number(String(address).slice(i + 1));
}

/**
 * Every exposed listener on the host, probed from its own LAN address the way
 * a LAN neighbour would reach it. A 2xx with no credentials is a finding; one
 * owned by this installation (its command line runs from the repo) ranks
 * higher. Tailnet reach is by design and is not probed.
 */
export async function listenerCheck(inv, { lanIp = lanAddress(), probe = probeHttp, repo = "", host = "the host" } = {}) {
  const exposed = (inv?.host?.listening || []).filter((l) => l.exposure !== "localhost only" && !String(l.address).startsWith("100.") && portOf(l.address));
  if (!exposed.length) return [{ check: `listeners on ${host}`, status: "clean", result: "no TCP listener beyond localhost" }];
  if (!lanIp) return [{ check: `listeners on ${host}`, status: "error", result: "could not find the host's LAN address to probe from" }];
  const out = [];
  const seenPorts = new Set();
  for (const l of exposed) {
    const port = portOf(l.address);
    if (seenPorts.has(port)) continue;
    seenPorts.add(port);
    const own = !!(repo && l.command && l.command.includes(repo));
    const who = `${l.process}${l.command ? ` (${l.command.slice(0, 120)})` : ""}`;
    let best = null;
    for (const p of ["/", "/health", "/healthz"]) {
      const r = await probe(lanIp, port, p);
      if (r.error) { best ||= r; break; }
      if (!best || best.error || (r.status >= 200 && r.status < 300)) best = { ...r, path: p };
      if (r.status >= 200 && r.status < 300) break;
    }
    const label = `:${port} ${own ? "(this assistant's own service) " : ""}${who}`;
    if (best?.error) {
      out.push({ check: `LAN probe ${label}`, status: "clean", result: best.error === "ECONNREFUSED" || best.error === "timeout" ? `not reachable from the LAN (${best.error})` : `not an HTTP service (${best.error})`, data: { port, own } });
    } else if (best.status >= 200 && best.status < 300) {
      out.push({ check: `LAN probe ${label}`, status: "found", result: `answers GET ${best.path} with HTTP ${best.status} from the LAN address ${lanIp}, with no credentials`, data: { port, own, process: l.process, command: l.command || null } });
    } else if ([401, 403, 407, 421].includes(best.status)) {
      out.push({ check: `LAN probe ${label}`, status: "clean", result: `refuses a LAN caller (HTTP ${best.status})`, data: { port, own } });
    } else {
      out.push({ check: `LAN probe ${label}`, status: "clean", result: `answers HTTP ${best.status} with no open page found at /, /health or /healthz`, data: { port, own } });
    }
  }
  return out;
}

/** Which SSH auth methods the host's sshd offers a keyless client, read from ssh's own error line. */
export function sshAuthCheck(lanIp = lanAddress(), { run = defaultSsh, host = "the host" } = {}) {
  if (!lanIp) return { check: `sshd auth methods on ${host}`, status: "error", result: "no LAN address" };
  const stderr = run(lanIp);
  const m = String(stderr || "").match(/Permission denied \(([^)]+)\)/); // lang-regex-ok: OpenSSH client's fixed error format
  if (!m) {
    if (/Connection refused|timed out|No route/i.test(stderr || "")) return { check: `sshd on ${host}`, status: "clean", result: "port 22 not reachable from the LAN" }; // lang-regex-ok: OpenSSH client error strings
    return { check: `sshd auth methods on ${host}`, status: "error", result: `could not read the offered methods (${String(stderr || "no output").trim().slice(0, 120)})` };
  }
  const methods = m[1].split(",");
  const weak = methods.filter((x) => x === "password" || x === "keyboard-interactive");
  return weak.length
    ? { check: `sshd auth methods on ${host}`, status: "found", result: `sshd is reachable from the LAN and offers ${methods.join(", ")}: password login is on`, data: { methods } }
    : { check: `sshd auth methods on ${host}`, status: "clean", result: `sshd offers ${methods.join(", ")} only`, data: { methods } };
}

function defaultSsh(ip) {
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "PreferredAuthentications=none", "-o", "PubkeyAuthentication=no", "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=5", "-o", "LogLevel=ERROR", `cyber-watch-probe@${ip}`, "true"], { encoding: "utf8", timeout: 15000 });
  return `${r.stderr || ""}${r.error ? ` ${r.error.message}` : ""}`;
}

// --------------------------------------------------------------- GitHub

// cron-run's PATH has no Homebrew: the first weekly dry run (2026-11-16) got
// "spawnSync gh ENOENT" on all 230 audit calls. Resolve the binary by path.
import fs from "node:fs";
export const GH_BIN = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || "gh";

/** gh api wrapper: → { ok, data } | { ok:false, error }. Errors are values, never an empty list. */
export function ghJson(args, { timeout = 60000 } = {}) {
  const r = spawnSync(GH_BIN, ["api", ...args], { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 200) };
  try { return { ok: true, data: JSON.parse(r.stdout || "null") }; } catch (e) { return { ok: false, error: `bad JSON: ${e.message}` }; }
}

const BOT = (login) => /\[bot\]$/.test(String(login || "")); // lang-regex-ok: GitHub app account suffix

/**
 * Account-wide GitHub audit: campaign IOCs (PR titles, branch names), outside
 * collaborators, deploy keys, PRs from other accounts, and recent workflow /
 * package.json commits by authors outside `trusted`. Forks are skipped (their
 * history is upstream's). One run per process; the caller caches it.
 */
export function githubAudit({ owner, repos, iocs = {}, trusted = [], sinceDays = 45, gh = ghJson, now = Date.now() }) {
  if (!owner) return [{ check: "GitHub account audit", status: "error", result: "no GitHub owner configured" }];
  if (!repos?.length) return [{ check: "GitHub account audit", status: "error", result: "repo list unavailable" }];
  const own = new Set([owner, ...trusted].map((s) => s.toLowerCase()));
  const since = new Date(now - sinceDays * DAY).toISOString();
  const titles = (iocs.pr_titles || []).map((s) => s.toLowerCase()).filter(Boolean);
  const branches = (iocs.branch_names || []).map((s) => s.toLowerCase()).filter(Boolean);
  const hit = { titles: [], branches: [], collaborators: [], keys: [], foreignPrs: [], foreignCommits: [] };
  const errors = [];
  for (const r of repos.filter((x) => !x.fork)) {
    const full = `repos/${owner}/${r.name}`;
    const prs = gh([`${full}/pulls?state=all&per_page=100`]);
    if (!prs.ok) errors.push(`${r.name} pulls: ${prs.error}`);
    else for (const p of prs.data || []) {
      const t = String(p.title || "").toLowerCase(), ref = String(p.head?.ref || "").toLowerCase(), who = p.user?.login || "";
      if (titles.some((x) => t.includes(x))) hit.titles.push(`${r.name}#${p.number} "${p.title}"`);
      if (branches.some((x) => ref.includes(x))) hit.branches.push(`${r.name}:${p.head.ref} (PR #${p.number})`);
      if (!own.has(who.toLowerCase()) && !BOT(who) && Date.parse(p.created_at) >= now - sinceDays * DAY) hit.foreignPrs.push(`${r.name}#${p.number} by ${who}`);
    }
    if (branches.length) {
      const br = gh([`${full}/branches?per_page=100`]);
      if (!br.ok) errors.push(`${r.name} branches: ${br.error}`);
      else for (const b of br.data || []) if (branches.some((x) => String(b.name).toLowerCase().includes(x))) hit.branches.push(`${r.name}:${b.name}`);
    }
    const col = gh([`${full}/collaborators?affiliation=outside&per_page=100`]);
    if (!col.ok) errors.push(`${r.name} collaborators: ${col.error}`);
    else for (const c of col.data || []) hit.collaborators.push(`${r.name}: ${c.login}`);
    const keys = gh([`${full}/keys`]);
    if (!keys.ok) errors.push(`${r.name} deploy keys: ${keys.error}`);
    else for (const k of keys.data || []) hit.keys.push(`${r.name}: "${k.title}"${k.read_only ? " (read-only)" : " (write)"}`);
    for (const p of [".github/workflows", "package.json"]) {
      const cm = gh([`${full}/commits?path=${encodeURIComponent(p)}&since=${since}&per_page=100`]);
      if (!cm.ok) { if (!/409|empty/i.test(cm.error)) errors.push(`${r.name} ${p} commits: ${cm.error}`); continue; } // lang-regex-ok: GitHub's empty-repo status
      for (const c of cm.data || []) {
        // A commit whose author email maps to no account (an agent committing as "claude") counts as
        // its committer's: the first dry run flagged the owner's own agent commits as foreign.
        const who = c.author?.login || c.committer?.login || c.commit?.author?.name || "unknown";
        if (!own.has(String(who).toLowerCase()) && !BOT(who)) hit.foreignCommits.push(`${r.name} ${p} ${String(c.sha).slice(0, 7)} by ${c.author?.login || c.commit?.author?.name || who}`);
      }
    }
  }
  const n = repos.filter((x) => !x.fork).length;
  const out = [];
  const row = (check, list, none, foundWord = "found") => out.push(list.length
    ? { check, status: "found", result: `${foundWord}: ${list.slice(0, 8).join("; ")}${list.length > 8 ? ` (+${list.length - 8} more)` : ""}` }
    : { check, status: "clean", result: none });
  if (titles.length) row(`PR titles matching ${titles.map((t) => `"${t}"`).join(", ")} across ${n} repos`, hit.titles, "none");
  if (branches.length) row(`branches matching ${branches.map((t) => `"${t}"`).join(", ")} across ${n} repos`, hit.branches, "none");
  row(`outside collaborators across ${n} repos`, hit.collaborators, "none");
  row(`deploy keys across ${n} repos`, hit.keys, "none");
  row(`PRs from other accounts, last ${sinceDays} days`, hit.foreignPrs, "none");
  row(`workflow and package.json commits by other authors, last ${sinceDays} days`, hit.foreignCommits, "none");
  if (errors.length) out.push({ check: "GitHub API coverage", status: "error", result: `${errors.length} call(s) failed, so those repos are unchecked: ${errors.slice(0, 4).join("; ")}` });
  return out;
}

// ---------------------------------------------------------- reachability

const DEPLOY_MARKERS = [
  ["firebase.json", "Firebase"], ["vercel.json", "Vercel"], ["fly.toml", "Fly.io"], ["netlify.toml", "Netlify"],
  ["app.yaml", "App Engine"], ["Procfile", "Procfile host"], ["render.yaml", "Render"], ["Dockerfile", "container image"],
  ["wrangler.toml", "Cloudflare Workers"], ["serverless.yml", "Serverless"],
];
const CLIENT_MARKERS = ["vite.config.js", "vite.config.ts", "vite.config.mjs"];

/**
 * Where a manifest's code runs, from the repo tree (structure only):
 * "server" (Cloud Functions dir, a container, a worker…), "static" (a client
 * bundle on static hosting), or "none" (no deploy config at all).
 */
export function deployKind(treePaths, manifestFile, firebaseJson = null) {
  const dir = path.posix.dirname(manifestFile) === "." ? "" : path.posix.dirname(manifestFile);
  const has = (p) => treePaths.includes(p);
  const markers = DEPLOY_MARKERS.filter(([f]) => has(f) || (dir && has(`${dir}/${f}`))).map(([f, label]) => `${label} (${has(`${dir}/${f}`) && dir ? `${dir}/${f}` : f})`);
  const workflows = treePaths.filter((p) => p.startsWith(".github/workflows/") && /deploy|release|publish/i.test(p)); // lang-regex-ok: workflow file names
  const client = CLIENT_MARKERS.some((f) => has(f) || (dir && has(`${dir}/${f}`)));
  let functionsDir = null;
  if (firebaseJson) {
    const f = firebaseJson.functions;
    functionsDir = (Array.isArray(f) ? f[0]?.source : f?.source) || (f ? "functions" : null);
  }
  const inFunctions = functionsDir && (dir === functionsDir || dir.startsWith(`${functionsDir}/`));
  const serverish = inFunctions || markers.some((m) => /container|Fly|App Engine|Procfile|Render|Workers|Serverless/.test(m)); // lang-regex-ok: our own marker labels
  const kind = serverish ? "server" : (markers.length || workflows.length) ? (client || firebaseJson?.hosting ? "static" : "server") : "none";
  return { kind, markers: [...markers, ...workflows.map((w) => `workflow ${w}`)], client_bundle: client, functions_dir: functionsDir };
}

/** From a package-lock (v2/v3): is `name` direct, dev, and which packages pull it in. */
export function lockParents(lockText, name) {
  let j;
  try { j = JSON.parse(lockText); } catch { return null; }
  const pk = j.packages || {};
  const root = pk[""] || {};
  const direct = !!(root.dependencies?.[name] || root.devDependencies?.[name] || root.optionalDependencies?.[name]);
  const directDev = !!root.devDependencies?.[name] && !root.dependencies?.[name];
  const entry = pk[`node_modules/${name}`] || Object.entries(pk).find(([k]) => k.endsWith(`node_modules/${name}`))?.[1];
  const parents = [];
  for (const [k, v] of Object.entries(pk)) {
    if (!k) continue;
    if (v.dependencies?.[name] || v.optionalDependencies?.[name] || v.peerDependencies?.[name]) parents.push(k.slice(k.lastIndexOf("node_modules/") + 13));
  }
  return { found: !!entry, version: entry?.version || null, direct, dev: directDev || !!entry?.dev, parents: [...new Set(parents)].slice(0, 6) };
}

/**
 * Reachability of one vulnerable npm dependency use: lockfile position (direct
 * or via which parent, dev-only), whether code imports it, and whether that
 * part of the repo is deployed and as what. `ref` pins the lockfile and tree
 * to a commit (replay), else the default branch.
 * → a check row with status found (runtime + imported + server-deployed),
 *   clean (dev-only, not imported, or not deployed), or error.
 */
export function reachabilityCheck({ owner, repo, file, name, version, ref, gh = ghJson, search = gh }) {
  const check = `reachability of ${name} ${version} in ${repo}/${file}`;
  const at = ref ? `?ref=${ref}` : "";
  const lock = gh(["-H", "Accept: application/vnd.github.raw", `repos/${owner}/${repo}/contents/${encodeURI(file)}${at}`]);
  // gh api with the raw media type still hands back the text; ghJson parses it as JSON, which a lockfile is.
  if (!lock.ok) return { check, status: "error", result: `lockfile unreadable: ${lock.error}` };
  const lp = lockParents(typeof lock.data === "string" ? lock.data : JSON.stringify(lock.data), name);
  const facts = {};
  if (lp) Object.assign(facts, { direct: lp.direct, dev: lp.dev, parents: lp.parents, locked_version: lp.version });
  const tree = gh([`repos/${owner}/${repo}/git/trees/${ref || "HEAD"}?recursive=1`]);
  let dep = { kind: "unknown", markers: [] };
  if (tree.ok) {
    const paths = (tree.data?.tree || []).map((e) => e.path);
    let fb = null;
    if (paths.includes("firebase.json")) { const f = gh(["-H", "Accept: application/vnd.github.raw", `repos/${owner}/${repo}/contents/firebase.json${at}`]); if (f.ok) fb = f.data; }
    dep = deployKind(paths, file, fb);
  }
  facts.deploy = dep.kind;
  facts.deploy_markers = dep.markers;
  const dir = path.posix.dirname(file);
  const q = `"${name}" repo:${owner}/${repo} -filename:package.json -filename:package-lock.json -filename:yarn.lock -filename:pnpm-lock.yaml${dir !== "." ? ` path:${dir}` : ""}`;
  const s = searchPaced(search, ["-X", "GET", "search/code", "-f", `q=${q}`, "-f", "per_page=10"]);
  if (s.ok) {
    const files = (s.data?.items || []).map((i) => i.path).filter((p) => !p.includes("node_modules/"));
    facts.imported_in = files.slice(0, 5);
  } else facts.imported_in = null;

  const parts = [];
  parts.push(lp ? (lp.found ? `${lp.direct ? "direct" : `transitive via ${lp.parents.join(", ") || "unknown parent"}`}${lp.dev ? ", dev-only" : ", runtime"} (locked ${lp.version})` : `not in the lockfile at this ref`) : "lockfile not parseable as package-lock");
  parts.push(facts.imported_in === null ? "import search failed" : facts.imported_in.length ? `referenced in ${facts.imported_in.join(", ")}` : "no source file references it");
  parts.push(dep.kind === "server" ? `deployed as server code (${dep.markers.join(", ") || "functions dir"})` : dep.kind === "static" ? `ships only as a static client bundle (${dep.markers.join(", ")})` : dep.kind === "none" ? "no deploy configuration in the repo" : "deploy target unknown (tree unreadable)");
  const result = parts.join("; ");
  if (lp && !lp.found) return { check, status: "clean", result, data: facts };
  if (lp?.dev) return { check, status: "clean", result, data: facts };
  if (dep.kind === "none") return { check, status: "clean", result, data: facts };
  if (facts.imported_in === null || dep.kind === "unknown" || !lp) return { check, status: "error", result, data: facts };
  if (dep.kind === "server" && facts.imported_in.length) return { check, status: "found", result, data: facts };
  if (dep.kind === "static") return { check, status: "n/a", result: `${result} — reachable only if the flaw is client-side`, data: facts };
  return { check, status: lp.direct ? "error" : "clean", result, data: facts };
}

// GitHub code search allows about 10 requests a minute: pace them, and retry once after a rate-limit refusal.
let lastSearch = 0;
const sleepMs = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
export function searchPaced(search, args, { gapMs = 6500, retryMs = 61000 } = {}) {
  if (search === ghJson) { sleepMs(lastSearch + gapMs - Date.now()); lastSearch = Date.now(); }
  const r = search(args);
  if (!r.ok && search === ghJson && /rate limit|403|429/i.test(r.error)) { sleepMs(retryMs); lastSearch = Date.now(); return search(args); } // lang-regex-ok: GitHub API status text
  return r;
}

/** Default-branch commit as of a moment (for replay). */
export function commitAsOf(owner, repo, iso, { gh = ghJson } = {}) {
  const r = gh([`repos/${owner}/${repo}/commits?until=${encodeURIComponent(iso)}&per_page=1`]);
  return r.ok && r.data?.[0]?.sha ? r.data[0].sha : null;
}

// ---------------------------------------------------------- verdict glue

/**
 * The code-owned status of an item from its checks and the model's reading:
 *   exposed    — a check found the problem (the model cannot overrule it)
 *   needs_you  — nothing a check could reach settles it, or a check errored,
 *                or the model says it applies with no check to back it
 *   clean      — checks ran clean and the model agrees it does not apply
 * Provider stories with no possible check may be "clean" on the model's
 * reading of the provider's role (a dormant account).
 */
export function itemStatus(checks, modelApplies, { unmetPrecondition = "" } = {}) {
  const found = checks.filter((c) => c.status === "found");
  // A version inside NVD's range is not exposure when the advisory names a
  // precondition the host lacks (SSHole: Linux/musl builds without PAM; the
  // host runs macOS). Only version findings can be set aside this way, and
  // only with the precondition stated; any other finding stands.
  if (found.length && unmetPrecondition && found.every((c) => c.kind === "version")) return "clean";
  if (found.length) return "exposed";
  const errored = checks.some((c) => c.status === "error");
  if (modelApplies === "no" && !errored) return "clean";
  if (modelApplies === "yes" && !checks.length) return "needs_you";
  if (modelApplies === "yes") return "needs_you";
  return errored || modelApplies === "unclear" ? "needs_you" : "clean";
}

/** A thin story: only Google News items, a single one (no article body can be fetched). */
export function isThin(items) {
  return items.length > 0 && items.length < 2 && items.every((i) => i.src === "google-news" || String(i.link || "").includes("news.google.com/"));
}

/**
 * One entry per event: drop provider hits that are the same event as a top
 * event (same event_key or shared items), folding their provider/role into
 * it; collapse provider hits sharing an event_key.
 */
export function dedupeCandidates(top, prov) {
  const outTop = top.map((t) => ({ ...t, providers: [...(t.providers || [])] }));
  const keyOf = new Map(outTop.map((t) => [t.event_key, t]));
  const outProv = [];
  for (const p of prov) {
    const ids = new Set((p.items || []).map((i) => i.id ?? i));
    const same = (p.event_key && keyOf.get(p.event_key)) || outTop.find((t) => (t.items || []).some((i) => ids.has(i.id ?? i)))
      || outProv.find((o) => o.event_key && o.event_key === p.event_key);
    if (same) {
      if (p.provider && !same.providers.some((x) => x.name === p.provider)) same.providers.push({ name: p.provider, role: p.providerRole || null });
      for (const i of p.items || []) if (!(same.items || []).some((j) => (j.id ?? j) === (i.id ?? i))) (same.items ||= []).push(i);
      continue;
    }
    outProv.push({ ...p, providers: p.provider ? [{ name: p.provider, role: p.providerRole || null }] : [] });
  }
  return { top: outTop, prov: outProv };
}
