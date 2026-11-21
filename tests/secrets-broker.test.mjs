// lib/secrets-broker — the broker answers only what its policy allows, never
// returns a token, and gives op nothing but the one token it needs
// (docs/secrets-broker.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { makeHandler, paths, storeSet, loadPolicy } = require("../lib/secrets-broker/broker.cjs");

const ID = (c) => c.repeat(26);
const ITEMS = [
  { id: ID("a"), title: "Shop", category: "LOGIN", vault: { id: "vl", name: "Logins" }, urls: [{ href: "https://shop.example.com/login" }], tags: [], fields: [{ id: "username", label: "username", value: "me@x" }, { id: "password", label: "password", value: "pw-shop" }] },
  { id: ID("b"), title: "Bank", category: "LOGIN", vault: { id: "vl", name: "Logins" }, urls: [{ href: "https://www.bank.example" }], tags: [], fields: [{ id: "password", label: "password", value: "pw-bank" }] },
  { id: ID("c"), title: "Visa", category: "CREDIT_CARD", vault: { id: "vl", name: "Logins" }, tags: ["jori-purchase"], additional_information: "•••• 4242", fields: [{ id: "ccnum", value: "4242424242424242" }] },
  { id: ID("d"), title: "Other card", category: "CREDIT_CARD", vault: { id: "vl", name: "Logins" }, tags: [], fields: [{ id: "ccnum", value: "3700" }] },
  { id: ID("e"), title: "site:example.org", category: "LOGIN", vault: { id: "vd", name: "Dev" }, tags: ["site-credential"], fields: [{ id: "password", label: "password", value: "pw-dev" }, { id: "totp", label: "totp", value: "123" }] },
  { id: ID("f"), title: "Twilio", category: "API_CREDENTIAL", vault: { id: "vd", name: "Dev" }, fields: [{ id: "sid", label: "account sid", value: "AC1" }, { id: "tok", label: "auth token", value: "t0k" }, { id: "x", label: "other", value: "nope" }] },
  { id: ID("g"), title: "Cloud root", category: "API_CREDENTIAL", vault: { id: "vd", name: "Dev" }, fields: [{ id: "k", label: "key", value: "AKIA" }] },
];

function setup({ perHour = 120, withTokens = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-"));
  for (const d of ["bin", "etc", "store", "home", "run", "log"]) fs.mkdirSync(path.join(dir, d));
  const fixture = path.join(dir, "items.json");
  fs.writeFileSync(fixture, JSON.stringify(ITEMS));
  const calls = path.join(dir, "op-calls.jsonl");
  const fake = path.join(dir, "fake-op.cjs");
  fs.writeFileSync(fake, `
    const fs = require("fs");
    const a = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: a, env: process.env }) + "\\n");
    const items = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, "utf8"));
    const opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
    const vault = opt("--vault");
    const inVault = (i) => i.vault.name === vault || i.vault.id === vault;
    if (a[0] === "item" && a[1] === "list") {
      const cat = { Login: "LOGIN", "Credit Card": "CREDIT_CARD" }[opt("--categories")];
      const tag = opt("--tags");
      const out = items.filter((i) => inVault(i) && i.category === cat && (!tag || (i.tags || []).includes(tag))).map(({ fields, ...o }) => o);
      process.stdout.write(JSON.stringify(out)); process.exit(0);
    }
    if (a[0] === "item" && a[1] === "get") {
      const it = items.find((i) => inVault(i) && (i.id === a[2] || i.title === a[2]));
      if (!it) { process.stderr.write('[ERROR] "' + a[2] + '" isn\\'t an item in the vault'); process.exit(1); }
      process.stdout.write(JSON.stringify(it)); process.exit(0);
    }
    process.exit(2);
  `);
  fs.writeFileSync(path.join(dir, "bin", "op"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "etc", "policy.json"), JSON.stringify({
    vaults: { logins: "Logins", dev: "Dev" }, card_tag: "jori-purchase", deny_domains: ["bank.example", "broker.example"],
    dev_items: { "sms-send": { vault: "vd", item: ID("f"), fields: ["account sid", "auth token"] } }, rate: { per_hour: perHour },
    dev_envs: {
      job: { token: "dev", vars: { SID: "op://Dev/Twilio/account sid", TOK: "op://Dev/Twilio/auth token", SITE_PW: "op://Dev/site:example.org/password" } }, // kernel-guard-ok: the 1Password reference scheme, not a reference
      odd: { vars: { X: "op://Dev/Twilio/account sid?attribute=otp" } }, // kernel-guard-ok: the 1Password reference scheme, not a reference
      gone: { vars: { X: "op://Dev/Twilio/no such field" } }, // kernel-guard-ok: the 1Password reference scheme, not a reference
    },
  }));
  const P = paths(dir);
  if (withTokens) { storeSet(P, "OP_LOGINS_SERVICE_ACCOUNT_TOKEN", "ops_LOGINS\n"); storeSet(P, "OP_SERVICE_ACCOUNT_TOKEN", "ops_DEV"); }
  const opCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const auditText = () => (fs.existsSync(P.audit) ? fs.readFileSync(P.audit, "utf8") : "");
  return { dir, P, handle: makeHandler(P), opCalls, auditText, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("health names the tokens it holds and never their values", async () => {
  const s = setup();
  const r = await s.handle({ op: "health" });
  assert.deepEqual(r.value.tokens, { logins: true, dev: true });
  assert.ok(!JSON.stringify(r).includes("ops_"));
  s.done();
});

test("a login field is read with the Logins token alone, in a bare environment", async () => {
  const s = setup();
  const r = await s.handle({ op: "logins.login_field", id: ID("a"), field: "password" });
  assert.deepEqual(r, { ok: true, value: "pw-shop" });
  const [call] = s.opCalls();
  // What the broker passes, plus what the test's sh wrapper and macOS add.
  const allowed = new Set(["HOME", "OP_SERVICE_ACCOUNT_TOKEN", "PATH", "XDG_CONFIG_HOME", "PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"]);
  assert.deepEqual(Object.keys(call.env).filter((k) => !allowed.has(k)), [], "nothing else reaches op");
  assert.equal(call.env.OP_SERVICE_ACCOUNT_TOKEN, "ops_LOGINS", "the stored value, trailing newline gone");
  assert.ok(!s.auditText().includes("pw-shop"), "the audit log holds no value");
  s.done();
});

test("a money-movement site's login, a non-login item and a bad id are refused", async () => {
  const s = setup();
  assert.equal((await s.handle({ op: "logins.login_field", id: ID("b"), field: "password" })).code, "denied");
  assert.equal((await s.handle({ op: "logins.login_field", id: ID("c"), field: "password" })).code, "denied");
  assert.equal((await s.handle({ op: "logins.login_field", id: "--vault=Dev", field: "password" })).code, "bad_request");
  assert.equal((await s.handle({ op: "logins.login_field", id: ID("a"), field: "notes" })).code, "bad_request");
  assert.equal((await s.handle({ op: "logins.login_field", id: ID("z"), field: "password" })).code, "not_found");
  s.done();
});

test("cards: the list and the item are held to the purchase tag", async () => {
  const s = setup();
  const list = await s.handle({ op: "logins.list", category: "Credit Card" });
  assert.deepEqual(list.value.map((i) => i.title), ["Visa"]);
  assert.ok(!JSON.stringify(list).includes("4242424242424242"), "the overview carries no card number");
  assert.equal((await s.handle({ op: "logins.card", id: ID("c") })).value.fields[0].value, "4242424242424242");
  assert.equal((await s.handle({ op: "logins.card", id: ID("d") })).code, "denied");
  assert.equal((await s.handle({ op: "logins.list", category: "Password" })).code, "bad_request");
  s.done();
});

test("Dev: only site:<domain> items and the items the policy names, with the Dev token", async () => {
  const s = setup();
  assert.deepEqual(await s.handle({ op: "dev.site", domain: "example.org", field: "totp" }), { ok: true, value: "123" });
  assert.equal(s.opCalls()[0].env.OP_SERVICE_ACCOUNT_TOKEN, "ops_DEV");
  assert.equal((await s.handle({ op: "dev.site", domain: "bank.example" })).code, "denied");
  assert.equal((await s.handle({ op: "dev.site", domain: "../Cloud root" })).code, "bad_request");
  assert.deepEqual((await s.handle({ op: "dev.item", name: "sms-send" })).value, { "account sid": "AC1", "auth token": "t0k" }, "only the listed fields");
  assert.equal((await s.handle({ op: "dev.item", name: "aws" })).code, "denied");
  assert.equal((await s.handle({ op: "dev.item", name: "__proto__" })).code, "denied");
  assert.equal((await s.handle({ op: "op.read", ref: "op://SomeVault/SomeItem/key" })).code, "bad_request", "no generic read"); // kernel-guard-ok: a placeholder 1Password reference, no real vault
  s.done();
});

test("a bundle: the listed references, one op call per item, nothing else", async () => {
  const s = setup();
  assert.deepEqual((await s.handle({ op: "dev.env", name: "job" })).value, { SID: "AC1", TOK: "t0k", SITE_PW: "pw-dev" });
  assert.equal(s.opCalls().length, 2, "Twilio and site:example.org, once each");
  assert.equal(s.opCalls()[0].env.OP_SERVICE_ACCOUNT_TOKEN, "ops_DEV");
  assert.equal((await s.handle({ op: "dev.env", name: "odd" })).code, "denied", "only plain references");
  assert.equal((await s.handle({ op: "dev.env", name: "gone" })).code, "not_found");
  assert.equal((await s.handle({ op: "dev.env", name: "constructor" })).code, "denied");
  assert.ok(!s.auditText().includes("t0k"));
  s.done();
});

test("the hourly cap stops a dump", async () => {
  const s = setup({ perHour: 2 });
  for (let i = 0; i < 2; i++) assert.equal((await s.handle({ op: "logins.login_field", id: ID("a"), field: "username" })).ok, true);
  assert.equal((await s.handle({ op: "logins.login_field", id: ID("a"), field: "username" })).code, "rate_limited");
  s.done();
});

test("no token stored: unavailable, and op never runs", async () => {
  const s = setup({ withTokens: false });
  assert.equal((await s.handle({ op: "logins.login_field", id: ID("a"), field: "password" })).code, "unavailable");
  assert.equal(s.opCalls().length, 0);
  s.done();
});

test("policy: bad deny entries are dropped, defaults filled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pol-"));
  const f = path.join(dir, "p.json");
  fs.writeFileSync(f, JSON.stringify({ deny_domains: ["Bank.example", "not a domain", "x"] }));
  const p = loadPolicy(f);
  assert.deepEqual(p.deny_domains, ["bank.example"]);
  assert.equal(p.card_tag, "jori-purchase");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("over the socket: the CLI's answers and exit codes", { skip: process.platform === "win32" }, async () => {
  const s = setup();
  const server = spawn(process.execPath, [path.join(ROOT, "lib/secrets-broker/broker.cjs"), "--root", s.dir], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    for (let i = 0; i < 50 && !fs.existsSync(s.P.sock); i++) await new Promise((r) => setTimeout(r, 100));
    const cli = (...a) => spawnSync(path.join(ROOT, "bin/secrets-broker"), a, { encoding: "utf8", env: { ...process.env, JORI_SECRETS_BROKER_SOCK: s.P.sock } });
    if (!fs.existsSync(s.P.sock)) return; // a sandbox that refuses unix sockets
    assert.equal(cli("available").status, 0);
    assert.equal(cli("available", "dev").status, 0);
    assert.equal(cli("available", "other-job").status, 78, "a token the broker does not hold: the helper keeps its own path");
    assert.equal(cli("login-field", ID("a"), "username").stdout, "me@x");
    assert.equal(cli("login-field", ID("b"), "password").status, 77);
    assert.equal(cli("dev-site", "nope.example", "--field", "password").status, 5);
    assert.equal(cli("login-field", "x", "password").status, 64);
    assert.equal(spawnSync(path.join(ROOT, "bin/secrets-broker"), ["available"], { env: { ...process.env, JORI_SECRETS_BROKER_SOCK: path.join(s.dir, "none.sock") } }).status, 78);

    // The helpers go through the broker and never need a token of their own.
    const env = { ...process.env, JORI_SECRETS_BROKER_SOCK: s.P.sock };
    delete env.OP_SERVICE_ACCOUNT_TOKEN; delete env.OP_LOGINS_SERVICE_ACCOUNT_TOKEN;
    const helper = (bin, ...a) => spawnSync(path.join(ROOT, "bin", bin), a, { encoding: "utf8", env });
    assert.equal(helper("site-pass", "shop.example.com", "--stdout").stdout, "pw-shop\n", "a newline after the value, as op prints it");
    assert.equal(helper("site-pass", "shop.example.com", "--id").stdout.trim(), ID("a"));
    assert.equal(helper("site-pass", "nothing.example.com", "--stdout").status, 5);
    assert.equal(helper("card-pass", "4242", "--field", "number").stdout, "4242424242424242");
    assert.match(helper("card-pass", "--list").stdout, /Visa \| 4242/);
    assert.equal(helper("dev-pass", "example.org", "--stdout").stdout, "pw-dev");
    assert.equal(helper("dev-pass", "missing.example", "--stdout").status, 1);
    assert.ok(!/OP_SERVICE_ACCOUNT_TOKEN is not set/.test(helper("dev-pass", "missing.example", "--stdout").stderr), "no fallback to .env when the broker answered");

    // run: op run without the token.
    const tpl = path.join(s.dir, "job.env.tpl");
    fs.writeFileSync(tpl, '# a comment with op://x/y/z\nPLAIN="hello"\nSID="op://Dev/Twilio/account sid"\nSITE_PW=op://Dev/site:example.org/password\n'); // kernel-guard-ok: the 1Password reference scheme, not a reference
    const show = "process.stdout.write([process.env.PLAIN, process.env.SID, process.env.SITE_PW, process.env.OP_SERVICE_ACCOUNT_TOKEN || 'none'].join(','))";
    const r = spawnSync(path.join(ROOT, "bin/secrets-broker"), ["run", "job", "--env-file", tpl, "--", process.execPath, "-e", show], { encoding: "utf8", env });
    assert.equal(r.stdout, "hello,AC1,pw-dev,none");
    assert.equal(spawnSync(path.join(ROOT, "bin/secrets-broker"), ["run", "job", "--", process.execPath, "-e", "process.exit(7)"], { env }).status, 7, "the command's exit code");
    fs.writeFileSync(tpl, "EXTRA=op://Dev/Cloud root/key\n"); // kernel-guard-ok: a placeholder 1Password reference, no real vault
    assert.equal(spawnSync(path.join(ROOT, "bin/secrets-broker"), ["run", "job", "--env-file", tpl, "--", "true"], { env }).status, 77, "a reference the bundle does not supply");
  } finally {
    server.kill("SIGTERM");
    s.done();
  }
});

test("the installer reads .env as data and checks signatures (static)", () => {
  const src = fs.readFileSync(path.join(ROOT, "bin/secrets-broker-install"), "utf8");
  assert.ok(!/^\s*(source|\.)\s+"?\$ENV_FILE/m.test(src), "never sources the env file");
  assert.match(src, /codesign --verify --strict "\$dst\.new"/, "verifies the copy, not the source");
  assert.match(src, /NODE_TEAM=HX7739G8FX/);
  assert.match(src, /OP_TEAM=2BUA8C4S2C/);
  assert.match(src, /run this from \$ROOT\/staging/);
  assert.equal(spawnSync("bash", ["-n", path.join(ROOT, "bin/secrets-broker-install")]).status, 0, "bash syntax");
});
