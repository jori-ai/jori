"use strict";
// broker.cjs — the Jori secrets broker (docs/secrets-broker.md).
//
// Runs as its own macOS user (_jorisecrets) from a root-owned install
// (/Library/JoriSecrets), so no process of the agents' user can read the keys
// it holds. Stage 1 holds the 1Password service-account tokens and answers a
// fixed set of reads over a unix socket; it never returns a token, and it
// refuses anything its root-owned policy does not allow. Every caller is
// treated as an agent: the socket is open to every local process, and nothing
// here trusts who is asking.
//
// This file is self-contained on purpose (node's standard library only): the
// installer copies exactly this file, after the user has checked its hash, and
// root never runs anything from the agents' checkout.
//
//   node broker.cjs --root DIR                 serve on DIR/run/broker.sock
//   node broker.cjs --root DIR --store-set N   read a value on stdin, store it as N
//   node broker.cjs --root DIR --store-rm N    forget N
//
// Layout under --root: bin/op, etc/policy.json, store/secrets.json, home/,
// run/broker.sock, log/audit.jsonl.

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { execFile } = require("node:child_process");

const VERSION = 1;
const ID_RE = /^[a-z0-9]{26}$/; // a 1Password item id
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/;
const FIELD_RE = /^[A-Za-z0-9_][A-Za-z0-9 _.-]{0,39}$/;
const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

function arg(name, argv = process.argv) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function paths(root) {
  return {
    root,
    op: path.join(root, "bin", "op"),
    policy: path.join(root, "etc", "policy.json"),
    store: path.join(root, "store", "secrets.json"),
    home: path.join(root, "home"),
    sock: path.join(root, "run", "broker.sock"),
    audit: path.join(root, "log", "audit.jsonl"),
  };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

/** The policy, with defaults; read on every request so a re-install needs no restart. */
function loadPolicy(file) {
  const p = readJson(file, null);
  if (!p || typeof p !== "object") return null;
  const lower = (a) => (Array.isArray(a) ? a.map((s) => String(s).toLowerCase()).filter((s) => DOMAIN_RE.test(s)) : []);
  return {
    vaults: { logins: String(p.vaults?.logins || "Logins"), dev: String(p.vaults?.dev || "Dev") },
    tokens: {
      logins: String(p.tokens?.logins || "OP_LOGINS_SERVICE_ACCOUNT_TOKEN"),
      dev: String(p.tokens?.dev || "OP_SERVICE_ACCOUNT_TOKEN"),
    },
    card_tag: String(p.card_tag || "jori-purchase"),
    deny_domains: lower(p.deny_domains),
    dev_site_prefix: String(p.dev_site_prefix || "site:"),
    dev_items: p.dev_items && typeof p.dev_items === "object" ? p.dev_items : {},
    per_hour: Number(p.rate?.per_hour) > 0 ? Number(p.rate.per_hour) : 120,
  };
}

function denied(host, policy) {
  const h = String(host || "").toLowerCase();
  return policy.deny_domains.some((d) => h === d || h.endsWith(`.${d}`));
}

function hostOf(href) {
  const u = String(href || "");
  try { return new URL(u.includes("://") ? u : `https://${u}`).hostname.toLowerCase(); } catch { return ""; }
}

class Refusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const refuse = (code, msg) => { throw new Refusal(code, msg); };

/** Run the broker's own op with one token and nothing else in its environment. */
function runOp(P, policy, which, args) {
  const store = readJson(P.store, {});
  const token = store[policy.tokens[which]];
  if (!token) refuse("unavailable", `the broker holds no ${which} token`);
  for (const a of args) if (typeof a !== "string") refuse("bad_request", "bad argument");
  return new Promise((resolve, reject) => {
    execFile(P.op, args, {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: P.home, XDG_CONFIG_HOME: path.join(P.home, ".config"), OP_SERVICE_ACCOUNT_TOKEN: token },
      timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8",
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const why = String(stderr || err.message || "").trim().split("\n").pop().slice(0, 200);
      if (/isn't an item|not found|no item|could not find|isn't a vault/i.test(why)) return reject(new Refusal("not_found", why)); // lang-regex-ok: op's error text, not language
      reject(new Refusal("op_error", why || `op exit ${err.code}`));
    });
  });
}

const json = (s) => { try { return JSON.parse(s); } catch { refuse("op_error", "op returned no JSON"); } };

function fieldByLabel(item, label) {
  const want = String(label).toLowerCase();
  const f = (item.fields || []).find((x) => String(x.label || "").toLowerCase() === want || String(x.id || "").toLowerCase() === want);
  return f && f.value != null ? String(f.value) : null;
}

function checkVault(item, name) {
  const v = item && item.vault;
  if (v && v.name && v.name !== name && v.id !== name) refuse("denied", "item is not in the expected vault");
}

/** The operations. Each returns { value, audit }; audit never holds a value. */
const OPS = {
  async health(P, policy) {
    const store = readJson(P.store, {});
    return { value: { version: VERSION, tokens: { logins: !!store[policy.tokens.logins], dev: !!store[policy.tokens.dev] } }, audit: {} };
  },

  // The Logins vault's overview (titles, URLs, ids, no secret field). Cards: the purchase tag only.
  async "logins.list"(P, policy, req) {
    const cat = req.category === "Credit Card" ? "Credit Card" : req.category === "Login" ? "Login" : refuse("bad_request", "category must be Login or Credit Card");
    const args = ["item", "list", "--vault", policy.vaults.logins, "--categories", cat, "--format=json"];
    if (cat === "Credit Card") args.push("--tags", policy.card_tag);
    return { value: json(await runOp(P, policy, "logins", args)), audit: { category: cat } };
  },

  // One field of a website login, never one whose URLs include a money-movement site.
  async "logins.login_field"(P, policy, req) {
    if (!ID_RE.test(String(req.id || ""))) refuse("bad_request", "bad item id");
    if (!["username", "password"].includes(req.field)) refuse("bad_request", "field must be username or password");
    const item = json(await runOp(P, policy, "logins", ["item", "get", req.id, "--vault", policy.vaults.logins, "--format=json", "--reveal"]));
    checkVault(item, policy.vaults.logins);
    if (item.category !== "LOGIN") refuse("denied", "not a login item");
    const hosts = (item.urls || []).map((u) => hostOf(u.href));
    if (hosts.some((h) => denied(h, policy))) refuse("denied", "a money-movement site's login stays manual");
    const v = fieldByLabel(item, req.field);
    if (v == null || v === "") refuse("not_found", `the login has no ${req.field}`);
    return { value: v, audit: { id: req.id, field: req.field, hosts } };
  },

  // A card the user tagged for purchases; the whole item (card-pass picks the field).
  async "logins.card"(P, policy, req) {
    if (!ID_RE.test(String(req.id || ""))) refuse("bad_request", "bad item id");
    const item = json(await runOp(P, policy, "logins", ["item", "get", req.id, "--vault", policy.vaults.logins, "--format=json", "--reveal"]));
    checkVault(item, policy.vaults.logins);
    if (item.category !== "CREDIT_CARD") refuse("denied", "not a card item");
    if (!(item.tags || []).includes(policy.card_tag)) refuse("denied", `card is not tagged ${policy.card_tag}`);
    return { value: item, audit: { id: req.id } };
  },

  // Jori's own site credential (Dev item "site:<domain>"), one field or the item.
  async "dev.site"(P, policy, req) {
    const domain = String(req.domain || "").toLowerCase();
    if (!DOMAIN_RE.test(domain)) refuse("bad_request", "bad domain");
    if (denied(domain, policy)) refuse("denied", "a money-movement site's login stays manual");
    const title = `${policy.dev_site_prefix}${domain}`;
    if (req.field != null && !FIELD_RE.test(String(req.field))) refuse("bad_request", "bad field name");
    const item = json(await runOp(P, policy, "dev", ["item", "get", title, "--vault", policy.vaults.dev, "--format=json", "--reveal"]));
    checkVault(item, policy.vaults.dev);
    if (item.title !== title) refuse("denied", "item title does not match");
    if (req.field == null) return { value: item, audit: { item: title } };
    const v = fieldByLabel(item, req.field);
    if (v == null || v === "") refuse("not_found", `no ${req.field} on ${title}`);
    return { value: v, audit: { item: title, field: req.field } };
  },

  // A named item the policy lists, with only the fields it lists ({ label: value }).
  async "dev.item"(P, policy, req) {
    const name = String(req.name || "");
    const spec = Object.prototype.hasOwnProperty.call(policy.dev_items, name) ? policy.dev_items[name] : null;
    if (!spec || !spec.item || !Array.isArray(spec.fields)) refuse("denied", `no item named ${name} in the broker's policy`);
    const vault = String(spec.vault || policy.vaults.dev);
    const item = json(await runOp(P, policy, "dev", ["item", "get", String(spec.item), "--vault", vault, "--format=json", "--reveal"]));
    checkVault(item, vault);
    const out = {};
    for (const label of spec.fields) {
      const f = (item.fields || []).find((x) => x.label === label || x.title === label || x.id === label);
      if (f && f.value != null) out[label] = String(f.value);
    }
    return { value: out, audit: { name, fields: Object.keys(out) } };
  },
};

// Reads that return a value count against the hourly cap.
const COUNTED = new Set(["logins.login_field", "logins.card", "dev.site", "dev.item"]);

function makeHandler(P, { now = () => Date.now() } = {}) {
  const recent = [];
  const audit = (row) => {
    try { fs.appendFileSync(P.audit, JSON.stringify({ ts: new Date(now()).toISOString(), ...row }) + "\n"); } catch { /* the log is best-effort */ }
  };
  return async function handle(req) {
    const op = String((req && req.op) || "");
    const fn = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null;
    if (!fn) { audit({ op, result: "bad_request" }); return { ok: false, code: "bad_request", error: `unknown op ${op.slice(0, 40)}` }; }
    const policy = loadPolicy(P.policy);
    if (!policy) { audit({ op, result: "unavailable" }); return { ok: false, code: "unavailable", error: "the broker has no policy" }; }
    if (COUNTED.has(op)) {
      const t = now();
      while (recent.length && t - recent[0] > 3600e3) recent.shift();
      if (recent.length >= policy.per_hour) { audit({ op, result: "rate_limited" }); return { ok: false, code: "rate_limited", error: `more than ${policy.per_hour} reads this hour` }; }
      recent.push(t);
    }
    try {
      const { value, audit: a } = await fn(P, policy, req || {});
      if (op !== "health") audit({ op, ...a, result: "ok" });
      return { ok: true, value };
    } catch (e) {
      const code = e instanceof Refusal ? e.code : "error";
      audit({ op, result: code, why: String(e.message || "").slice(0, 200) });
      return { ok: false, code, error: String(e.message || "error").slice(0, 300) };
    }
  };
}

function serve(P) {
  const handle = makeHandler(P);
  const server = http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method !== "POST" || req.url !== "/v1") return send(404, { ok: false, code: "bad_request", error: "POST /v1" });
    let body = "";
    let size = 0;
    req.setEncoding("utf8");
    req.on("data", (c) => { size += c.length; if (size > 64 * 1024) { req.destroy(); } else body += c; });
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body || "{}"); } catch { return send(400, { ok: false, code: "bad_request", error: "body is not JSON" }); }
      const out = await handle(parsed);
      send(out.ok ? 200 : 403, out);
    });
  });
  try { fs.unlinkSync(P.sock); } catch { /* none */ }
  server.listen(P.sock, () => {
    fs.chmodSync(P.sock, 0o666);
    process.stderr.write(`[secrets-broker] v${VERSION} listening on ${P.sock}\n`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return server;
}

/** Store a value read from stdin (the installer's --import/--set, run as root). */
function storeSet(P, name, value) {
  if (!NAME_RE.test(name)) throw new Error(`bad secret name ${name}`);
  const v = String(value).replace(/\r?\n$/, "");
  if (!v) throw new Error("empty value");
  const store = readJson(P.store, {});
  store[name] = v;
  const tmp = `${P.store}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(tmp, P.store);
}

function storeRm(P, name) {
  const store = readJson(P.store, {});
  delete store[name];
  const tmp = `${P.store}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(tmp, P.store);
}

if (require.main === module) {
  const root = arg("--root");
  if (!root || !path.isAbsolute(root)) { process.stderr.write("usage: broker.cjs --root /abs/dir [--store-set NAME | --store-rm NAME]\n"); process.exit(64); }
  const P = paths(root);
  if (arg("--store-set")) {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { input += c; });
    process.stdin.on("end", () => {
      try { storeSet(P, arg("--store-set"), input); process.stderr.write(`stored ${arg("--store-set")}\n`); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
    });
  } else if (arg("--store-rm")) {
    storeRm(P, arg("--store-rm"));
  } else {
    serve(P);
  }
}

module.exports = { makeHandler, loadPolicy, paths, storeSet, denied, hostOf, VERSION };
