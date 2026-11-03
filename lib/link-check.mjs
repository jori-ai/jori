// link-check.mjs: refuse to send a message to someone else when a link in it
// is dead or points at a repo that has moved on.
//
// Why: a model asked to send "the repo link" copied a project's old URL from
// memory. The old repo had been archived when the project was renamed, and it was
// deleted later. Nothing between the model and the send path looked at the URL.
//
// What it checks (URL structure and HTTP status only, never what the words mean):
//   - github.com/<owner>/<repo>[/...]: asks the GitHub API through `gh`, so
//     private repos the owner can see work too. These are refused:
//       missing (404)        "does not exist"
//       renamed/transferred  the API answers under another full_name; suggests that one
//       archived             a read-only leftover; the live project lives elsewhere
//   - any other http(s) URL: one GET that follows redirects. Only 404 and 410 are
//     refused. A timeout, a network error, a 401/403 or a 5xx passes: a site
//     that is down for a minute, or behind a login, is not proof the link is wrong.
//
// A check that cannot run (no `gh`, no network) passes the link and says so.
// The gate must never turn a flaky dependency into a message that does not go out.
// Override for a deliberate send: OUTBOUND_ALLOW_DEAD_LINKS=1.

import { spawnSync } from "node:child_process";

const TIMEOUT_MS = 8000;

// http(s) URLs in a message. Trailing sentence punctuation and a closing
// bracket that the URL did not open are trimmed: "see https://x.y/z)." → https://x.y/z
export function extractUrls(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let u = m[0];
    for (;;) {
      const last = u.at(-1);
      if (/[.,;:!?*_]/.test(last)) { u = u.slice(0, -1); continue; }
      const pairs = { ")": "(", "]": "[", "}": "{" };
      if (pairs[last] && count(u, last) > count(u, pairs[last])) { u = u.slice(0, -1); continue; }
      break;
    }
    if (!out.includes(u)) out.push(u);
  }
  // Bare "github.com/owner/repo" (no scheme) is how people often paste a repo.
  for (const m of String(text || "").matchAll(/(?<![\w./:-])github\.com\/[\w.-]+\/[\w.-]+/gi)) {
    const u = `https://${m[0].replace(/[.,;:!?]+$/, "")}`;
    if (!out.some((x) => x.toLowerCase().startsWith(u.toLowerCase()))) out.push(u);
  }
  return out;
}
function count(s, ch) { return s.split(ch).length - 1; }

// "owner/repo" for a github.com repo URL, else null. Paths that are not repos
// (github.com/settings, /orgs/..., /features...) are left to the plain HTTP check.
const GH_NON_REPO = new Set(["orgs", "settings", "features", "marketplace", "topics", "collections", "sponsors", "login", "join", "about", "pricing", "enterprise", "apps", "notifications", "explore", "search", "new"]);
export function githubRepoOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
  const [owner, repoRaw] = u.pathname.split("/").filter(Boolean);
  if (!owner || !repoRaw || GH_NON_REPO.has(owner.toLowerCase())) return null;
  return `${owner}/${repoRaw.replace(/\.git$/i, "")}`;
}

// Default GitHub lookup: `gh api repos/<o>/<r>`. Returns {status, full_name, archived}
// or {status: "unknown"} when gh is missing or failed for a reason other than 404.
function ghLookup(repo) {
  const r = spawnSync("gh", ["api", `repos/${repo}`], { encoding: "utf8", timeout: TIMEOUT_MS });
  if (r.error) return { status: "unknown", detail: r.error.message };
  if (r.status === 0) {
    try { const j = JSON.parse(r.stdout); return { status: 200, full_name: j.full_name, archived: !!j.archived }; }
    catch { return { status: "unknown", detail: "unparseable gh reply" }; }
  }
  if (/HTTP 404|Not Found/i.test(`${r.stderr}${r.stdout}`)) return { status: 404 };
  return { status: "unknown", detail: (r.stderr || "").trim().split("\n")[0] };
}

async function httpStatus(url, fetchImpl) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: "GET", redirect: "follow", signal: ctl.signal, headers: { "user-agent": "jori-link-check" } });
    try { await res.body?.cancel?.(); } catch {}
    return res.status;
  } catch { return "unknown"; }
  finally { clearTimeout(t); }
}

// → [{url, problem, suggest?}] for every link that should stop the send.
export async function findBadLinks(text, { gh = ghLookup, fetchImpl = globalThis.fetch } = {}) {
  const urls = extractUrls(text);
  const results = await Promise.all(urls.map(async (url) => {
    const repo = githubRepoOf(url);
    if (repo) {
      const r = gh(repo);
      if (r.status === 404) return { url, problem: `GitHub repo ${repo} does not exist` };
      if (r.status === 200 && r.full_name && r.full_name.toLowerCase() !== repo.toLowerCase())
        return { url, problem: `GitHub repo ${repo} has moved to ${r.full_name}`, suggest: `https://github.com/${r.full_name}` };
      if (r.status === 200 && r.archived)
        return { url, problem: `GitHub repo ${repo} is archived (a read-only leftover; the live project is elsewhere)` };
      return null;
    }
    const s = await httpStatus(url, fetchImpl);
    if (s === 404 || s === 410) return { url, problem: `returns HTTP ${s}` };
    return null;
  }));
  return results.filter(Boolean);
}

// For the send CLIs: print why and exit 1 when a link is bad. `tool` names the caller.
export async function linkGate(text, tool, opts = {}) {
  if (process.env.OUTBOUND_ALLOW_DEAD_LINKS) return;
  const bad = await findBadLinks(text, opts);
  if (!bad.length) return;
  console.error(`${tool}: not sent. ${bad.length === 1 ? "A link in the message is" : "Links in the message are"} wrong:`);
  for (const b of bad) console.error(`  ${b.url}: ${b.problem}${b.suggest ? `. Use ${b.suggest}` : ""}`);
  console.error(`Fix the link (look up the current one: \`git remote -v\` for a repo, never memory) and send again, or set OUTBOUND_ALLOW_DEAD_LINKS=1 if this link is deliberate.`);
  process.exit(1);
}
