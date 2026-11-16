// cyber-checks.test.mjs — the deterministic checks behind cyber-watch verdicts
// (lib/cyber-checks.mjs). Fixtures replay the 2026-11-16 hand review: the
// git CVE on both git builds, the :9096/:9100 class before the fix, the
// GitHub campaign IOCs (clean), adm-zip reachable, react-router client-only,
// and API failures that must read as "couldn't check", never as clean.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  parseVersion, cmpVer, versionStatus, hostInstalls, hostVersionCheck, listenerCheck, sshAuthCheck, githubAudit,
  lockParents, deployKind, reachabilityCheck, itemStatus, isThin, dedupeCandidates, lanAddress,
} from "../lib/cyber-checks.mjs";

const GIT_FIXED = ["2.50.2", "2.51.3", "2.52.1", "2.53.1", "2.54.1", "2.55.1", "2.56.1"];

test("version parsing and comparison", () => {
  assert.deepEqual(parseVersion("git version 2.50.1 (Apple Git-155)"), [2, 50, 1]);
  assert.deepEqual(parseVersion("Google Chrome 157.0.8103.51"), [157, 0, 8103, 51]);
  assert.equal(cmpVer("157.0.8103.51", "157.0.8103.50"), 1);
  assert.equal(cmpVer("2.50", "2.50.0"), 0);
});

test("per-branch fixed versions: git CVE affects 2.50.1 and 2.53.0, not 2.56.1", () => {
  assert.equal(versionStatus("git version 2.50.1 (Apple Git-155)", { fixed: GIT_FIXED }).status, "affected");
  assert.equal(versionStatus("git version 2.53.0", { fixed: GIT_FIXED }).status, "affected");
  assert.equal(versionStatus("git version 2.54.1", { fixed: GIT_FIXED }).status, "fixed");
  assert.equal(versionStatus("git version 2.57.0", { fixed: GIT_FIXED }).status, "fixed");
  assert.equal(versionStatus("git version 2.49.0", { fixed: GIT_FIXED }).status, "affected");
  assert.equal(versionStatus("x", { fixed: GIT_FIXED }).status, "unknown");
  assert.equal(versionStatus("2.50.1", {}).status, "unknown");
});

test("NVD ranges: Chrome < 157.0.8103.50 — the host's .51 is fixed", () => {
  const ranges = [{ product: "chrome", end: "157.0.8103.50", endIncl: false }];
  assert.equal(versionStatus("Google Chrome 157.0.8103.51", { ranges }).status, "fixed");
  assert.equal(versionStatus("Google Chrome 157.0.8103.49", { ranges }).status, "affected");
  assert.equal(versionStatus("1.5", { ranges: [{ start: "1.0", end: "1.5", endIncl: true }] }).status, "affected");
});

test("hostVersionCheck checks every git binary and labels the source", () => {
  const inv = { host: { runtimes: { git: "git version 2.50.1 (Apple Git-155) (/usr/bin/git); git version 2.56.1 (/opt/homebrew/bin/git)", php: "not installed" } } };
  assert.equal(hostInstalls(inv.host.runtimes, "git").length, 2);
  const rows = hostVersionCheck(inv, ["git", "php"], { fixedFromArticle: { git: GIT_FIXED }, host: "server" });
  const [apple, brew, php] = rows;
  assert.equal(apple.status, "found");
  assert.match(apple.check, /\/usr\/bin\/git/);
  assert.match(apple.result, /article \(not NVD\)/);
  assert.equal(brew.status, "clean");
  assert.equal(php.status, "n/a");
  // NVD ranges win over article versions and are cited
  const [n] = hostVersionCheck({ host: { runtimes: { chrome: "Google Chrome 157.0.8103.51" } } }, ["chrome"], { nvd: [{ id: "CVE-2026-1", ranges: [{ product: "chrome", end: "157.0.8103.50" }] }] });
  assert.equal(n.status, "clean");
  assert.match(n.result, /NVD CVE-2026-1/);
  // no version info at all → error (needs you), never clean
  assert.equal(hostVersionCheck({ host: { runtimes: { git: "git version 2.50.1" } } }, ["git"])[0].status, "error");
});

// The :9096 / :9100 class before the 2026-11-16 fix: a Jori-owned service on
// all interfaces answering a LAN caller with no credentials.
test("listenerCheck flags an unauthenticated off-host service and its owner; refusals are clean", async () => {
  const inv = { host: { listening: [
    { process: "node", address: "*:9100", exposure: "all interfaces (LAN/Tailscale)", command: "/opt/x/node /repo/agent/whatsapp-channel/index.mjs" },
    { process: "node", address: "*:9096", exposure: "all interfaces (LAN/Tailscale)", command: "/opt/x/node /repo/bin/wiki serve" },
    { process: "resolutio", address: "*:9876", exposure: "all interfaces (LAN/Tailscale)" },
    { process: "ARDAgent", address: "*:3283", exposure: "all interfaces (LAN/Tailscale)" },
    { process: "node", address: "127.0.0.1:9094", exposure: "localhost only" },
  ] } };
  const replies = { 9100: { "/": 404, "/health": 200 }, 9096: { "/": 200 }, 9876: { "/": 404, "/health": 404, "/healthz": 404 } };
  const probe = async (_ip, port, p) => (port === 3283 ? { error: "ECONNRESET" } : { status: replies[port][p] ?? 404 });
  const rows = await listenerCheck(inv, { lanIp: "192.168.1.5", probe, repo: "/repo" });
  const by = Object.fromEntries(rows.map((r) => [r.data.port, r]));
  assert.equal(by[9100].status, "found");
  assert.equal(by[9100].data.own, true);
  assert.match(by[9100].result, /GET \/health with HTTP 200/);
  assert.equal(by[9096].status, "found");
  assert.equal(by[9876].status, "clean");
  assert.equal(by[3283].status, "clean");
  assert.ok(!(9094 in by), "localhost-only listeners are not probed");
  // after the fix: 403 to a LAN caller is clean
  const fixed = await listenerCheck(inv, { lanIp: "192.168.1.5", probe: async () => ({ status: 403 }), repo: "/repo" });
  assert.ok(fixed.every((r) => r.status === "clean"));
  assert.equal((await listenerCheck(inv, { lanIp: null, probe }))[0].status, "error");
});

test("listenerCheck against a real socket on all interfaces", async (t) => {
  const ip = lanAddress();
  if (!ip) return t.skip("no LAN address on this machine");
  const srv = http.createServer((_q, r) => { r.end("ok"); });
  try { await new Promise((res, rej) => { srv.once("error", rej); srv.listen(0, "0.0.0.0", res); }); } catch (e) { return t.skip(`cannot bind (${e.code})`); }
  try {
    const port = srv.address().port;
    const rows = await listenerCheck({ host: { listening: [{ process: "node", address: `*:${port}`, exposure: "all interfaces" }] } }, { lanIp: ip });
    if (rows[0].status === "clean" && /not reachable/.test(rows[0].result)) return t.skip("sandbox blocks the LAN probe");
    assert.equal(rows[0].status, "found");
  } finally { srv.close(); }
});

test("sshAuthCheck reads the methods sshd offers", () => {
  const weak = sshAuthCheck("10.0.0.2", { run: () => "cyber-watch-probe@10.0.0.2: Permission denied (publickey,password,keyboard-interactive)." });
  assert.equal(weak.status, "found");
  assert.deepEqual(weak.data.methods, ["publickey", "password", "keyboard-interactive"]);
  assert.equal(sshAuthCheck("10.0.0.2", { run: () => "Permission denied (publickey)." }).status, "clean");
  assert.equal(sshAuthCheck("10.0.0.2", { run: () => "ssh: connect to host 10.0.0.2 port 22: Connection refused" }).status, "clean");
  assert.equal(sshAuthCheck("10.0.0.2", { run: () => "weird" }).status, "error");
});

// A fake gh: routes → data, or an error for a route.
function fakeGh(routes, fail = []) {
  return (args) => {
    const route = args.find((a) => a.startsWith("repos/") || a.startsWith("search/"));
    if (fail.some((f) => route.includes(f))) return { ok: false, error: "HTTP 403: rate limit" };
    for (const [k, v] of Object.entries(routes)) if (route.includes(k)) return { ok: true, data: v };
    return { ok: true, data: [] };
  };
}

test("githubAudit: the wfx campaign IOCs come back clean on a clean account", () => {
  const repos = [{ name: "a" }, { name: "b" }, { name: "fork1", fork: true }];
  const gh = fakeGh({
    "a/pulls": [{ number: 3, title: "Bump deps", head: { ref: "main-bump" }, user: { login: "Owner" }, created_at: new Date().toISOString() },
      { number: 4, title: "chore", head: { ref: "x" }, user: { login: "dependabot[bot]" }, created_at: new Date().toISOString() }],
    "a/commits": [{ sha: "abc1234", author: { login: "owner" } }, { sha: "def5678", author: { login: "jori-bot" } },
      { sha: "aaa1111", author: null, committer: { login: "owner" }, commit: { author: { name: "claude" } } }],
  });
  const rows = githubAudit({ owner: "owner", repos, trusted: ["jori-bot"], gh, iocs: { pr_titles: ["docs: dependency audit notes"], branch_names: ["wfx", "audit"] } });
  assert.ok(rows.every((r) => r.status === "clean"), JSON.stringify(rows));
  assert.match(rows[0].check, /across 2 repos/, "forks are skipped");
});

test("githubAudit: an IOC PR, a deploy key and a foreign commit are found", () => {
  const gh = fakeGh({
    "a/pulls": [{ number: 9, title: "docs: Dependency Audit Notes", head: { ref: "wfx-123" }, user: { login: "evil" }, created_at: new Date().toISOString() }],
    "a/keys": [{ title: "ci", read_only: false }],
    "a/commits": [{ sha: "badbad1", author: { login: "evil" } }],
  });
  const rows = githubAudit({ owner: "owner", repos: [{ name: "a" }], gh, iocs: { pr_titles: ["docs: dependency audit notes"], branch_names: ["wfx"] } });
  const found = rows.filter((r) => r.status === "found").map((r) => r.check);
  assert.equal(found.length, 5, JSON.stringify(rows));
});

test("githubAudit: API failures are 'error', never clean", () => {
  const rows = githubAudit({ owner: "owner", repos: [{ name: "a" }], gh: fakeGh({}, ["a/collaborators"]) });
  const cov = rows.find((r) => r.check === "GitHub API coverage");
  assert.equal(cov.status, "error");
  assert.match(cov.result, /collaborators/);
  assert.equal(githubAudit({ owner: "owner", repos: [] })[0].status, "error");
});

const LOCK = JSON.stringify({ lockfileVersion: 3, packages: {
  "": { dependencies: { "adm-zip": "^0.5.10", "react-router-dom": "^7.5.0" }, devDependencies: { vitest: "1" } },
  "node_modules/adm-zip": { version: "0.5.18" },
  "node_modules/react-router-dom": { version: "7.5.3", dependencies: { "react-router": "7.5.3" } },
  "node_modules/react-router": { version: "7.5.3", dependencies: { "turbo-stream": "2.4.0" } },
  "node_modules/turbo-stream": { version: "2.4.0" },
  "node_modules/vitest": { version: "1.0.0", dev: true, dependencies: { rollup: "4" } },
  "node_modules/rollup": { version: "4.0.0", dev: true },
} });

test("lockParents: direct, transitive parent, dev-only", () => {
  assert.deepEqual(lockParents(LOCK, "adm-zip"), { found: true, version: "0.5.18", direct: true, dev: false, parents: [] });
  const rr = lockParents(LOCK, "react-router");
  assert.equal(rr.direct, false);
  assert.deepEqual(rr.parents, ["react-router-dom"]);
  assert.equal(lockParents(LOCK, "rollup").dev, true);
  assert.equal(lockParents("not json", "x"), null);
});

test("deployKind: functions dir is server, a Vite app on hosting is static, nothing is none", () => {
  const fb = { functions: { source: "functions" }, hosting: { public: "dist" } };
  assert.equal(deployKind(["firebase.json", "functions/package-lock.json"], "functions/package-lock.json", fb).kind, "server");
  assert.equal(deployKind(["firebase.json", "vite.config.ts", "package-lock.json"], "package-lock.json", { hosting: { public: "dist" } }).kind, "static");
  assert.equal(deployKind(["package-lock.json", "scripts/x.js"], "package-lock.json").kind, "none");
  assert.equal(deployKind(["Dockerfile", "package-lock.json"], "package-lock.json").kind, "server");
});

test("reachabilityCheck: adm-zip in deployed Cloud Functions is found; react-router in a static SPA is n/a", () => {
  const fbFn = { functions: { source: "functions" }, hosting: {} };
  const gh = (args) => {
    const r = args.find((a) => a.startsWith("repos/") || a.startsWith("search/"));
    if (r.includes("contents/functions/package-lock.json")) return { ok: true, data: JSON.parse(LOCK) };
    if (r.includes("contents/package-lock.json")) return { ok: true, data: JSON.parse(LOCK) };
    if (r.includes("foodierank/contents/firebase.json")) return { ok: true, data: fbFn };
    if (r.includes("contents/firebase.json")) return { ok: true, data: { hosting: { public: "dist" } } };
    if (r.includes("foodierank/git/trees")) return { ok: true, data: { tree: [{ path: "firebase.json" }, { path: "functions/package-lock.json" }, { path: "functions/src/takeout.ts" }] } };
    if (r.includes("git/trees")) return { ok: true, data: { tree: [{ path: "firebase.json" }, { path: "vite.config.ts" }, { path: "package-lock.json" }] } };
    if (r.startsWith("search/")) return { ok: true, data: { items: [{ path: args.join(" ").includes("adm-zip") ? "functions/src/takeout.ts" : "src/main.tsx" }] } };
    return { ok: false, error: "unexpected" };
  };
  const adm = reachabilityCheck({ owner: "o", repo: "foodierank", file: "functions/package-lock.json", name: "adm-zip", version: "0.5.18", gh });
  assert.equal(adm.status, "found", adm.result);
  assert.match(adm.result, /direct, runtime/);
  assert.match(adm.result, /takeout\.ts/);
  const rr = reachabilityCheck({ owner: "o", repo: "myway-guest-ux", file: "package-lock.json", name: "react-router", version: "7.5.3", gh });
  assert.equal(rr.status, "n/a", rr.result);
  assert.match(rr.result, /transitive via react-router-dom/);
  assert.match(rr.result, /static client bundle/);
  // a failed import search is "error", not "not imported"
  const ghNoSearch = (args) => (args.some((a) => a.startsWith("search/")) ? { ok: false, error: "HTTP 403 rate limit" } : gh(args));
  assert.equal(reachabilityCheck({ owner: "o", repo: "foodierank", file: "functions/package-lock.json", name: "adm-zip", version: "0.5.18", gh: ghNoSearch }).status, "error");
});

test("itemStatus: a found check is exposed whatever the model says; yes without a check is needs-you", () => {
  const found = [{ status: "found" }], clean = [{ status: "clean" }], err = [{ status: "clean" }, { status: "error" }];
  assert.equal(itemStatus(found, "no"), "exposed");
  assert.equal(itemStatus(clean, "no"), "clean");
  assert.equal(itemStatus(clean, "yes"), "needs_you");
  assert.equal(itemStatus([], "yes"), "needs_you");
  assert.equal(itemStatus([], "no"), "clean");
  assert.equal(itemStatus(err, "no"), "needs_you");
  assert.equal(itemStatus([], "unclear"), "needs_you");
  // SSHole: OpenSSH 10.5 is inside NVD's range, but the advisory needs Linux without PAM
  const ver = [{ status: "found", kind: "version" }];
  assert.equal(itemStatus(ver, "no", { unmetPrecondition: "Linux/musl builds without PAM only; the host runs macOS" }), "clean");
  assert.equal(itemStatus(ver, "no"), "exposed");
  assert.equal(itemStatus([{ status: "found" }], "no", { unmetPrecondition: "x" }), "exposed", "only version findings can be set aside");
});

test("isThin: one Google News hit is thin; a real article or two sources is not", () => {
  assert.equal(isThin([{ src: "google-news", link: "https://news.google.com/rss/articles/x" }]), true);
  assert.equal(isThin([{ src: "thehackernews", link: "https://thehackernews.com/a" }]), false);
  assert.equal(isThin([{ src: "google-news" }, { src: "google-news" }]), false);
  assert.equal(isThin([]), false);
});

test("dedupeCandidates: a provider hit on a top event folds in with its role; same-key provider hits collapse", () => {
  const top = [{ event_key: "wfx-github-ci-stealer", items: [{ id: "i1" }], providers: [] }];
  const prov = [
    { event_key: "github-wfx", provider: "GitHub", providerRole: "code host", items: [{ id: "i1" }] },
    { event_key: "railway-breach", provider: "Railway", providerRole: "dormant trial, no secrets", items: [{ id: "i7" }] },
    { event_key: "railway-breach", provider: "Railway", providerRole: "dormant trial, no secrets", items: [{ id: "i8" }] },
  ];
  const d = dedupeCandidates(top, prov);
  assert.equal(d.top.length, 1);
  assert.deepEqual(d.top[0].providers, [{ name: "GitHub", role: "code host" }]);
  assert.equal(d.prov.length, 1);
  assert.equal(d.prov[0].providers[0].role, "dormant trial, no secrets");
  assert.equal(d.prov[0].items.length, 2);
});
