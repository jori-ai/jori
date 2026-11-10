// jori setup (lib/onboarding/): detection parsing, the additive file writes,
// the starter schedule and service plist, and the setup server's guards —
// against a temp checkout, never the real install.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onboarding-"));
for (const f of ["system/tasks.json", "system/starter-jobs.json", "examples/hum-interests.example.json", "examples/hum-intent.example.md"]) {
  fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
  fs.copyFileSync(path.join(REPO, f), path.join(tmp, f));
}

const core = await import("../lib/onboarding/core.mjs");
const { createSetupServer } = await import("../lib/onboarding/server.mjs");

test("claude auth status: Max on the subscription is the only plan that passes", () => {
  const max = core.parseClaudeStatus({ loggedIn: true, authMethod: "claude.ai", email: "sam@example.com", subscriptionType: "max" });
  assert.deepEqual([max.loggedIn, max.planOk, max.email], [true, true, "sam@example.com"]);
  assert.equal(core.parseClaudeStatus({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }).planOk, false);
  const api = core.parseClaudeStatus({ loggedIn: true, authMethod: "console", subscriptionType: null });
  assert.equal(api.viaSubscription, false);
  assert.equal(api.planOk, false);
  assert.equal(core.parseClaudeStatus("not json").loggedIn, false);
  assert.equal(core.parseClaudeStatus({ loggedIn: false }).planOk, false);
});

test("a city is guessed from the time zone, never from a zone that is not a place", () => {
  assert.equal(core.cityFromTz("America/Los_Angeles"), "Los Angeles");
  assert.equal(core.cityFromTz("America/Argentina/Buenos_Aires"), "Buenos Aires");
  assert.equal(core.cityFromTz("UTC"), "");
  assert.equal(core.cityFromTz("Etc/GMT+5"), "");
});

test("prepareCheckout fills what is missing and keeps what is there", () => {
  fs.writeFileSync(path.join(tmp, ".env"), "# copied from .env.example\nJORI_HOME=\nOLLAMA_URL=http://10.0.0.2:11434\nSECRET=keep\n");
  const done = core.prepareCheckout(tmp, { tz: "Europe/Paris" });
  const env = core.readDotEnv(path.join(tmp, ".env"));
  assert.equal(env.OLLAMA_URL, "http://10.0.0.2:11434", "an existing value is never replaced");
  assert.equal(env.SECRET, "keep");
  assert.equal(env.JORI_HOME, tmp, "an empty line from .env.example is filled in");
  assert.equal(fs.readFileSync(path.join(tmp, ".env"), "utf8").match(/^JORI_HOME=/gm).length, 1, "filled in place, not duplicated");
  assert.equal(env.LOCAL_EMBED_MODEL, "nomic-embed-text");
  assert.ok(fs.existsSync(path.join(tmp, "secrets", "webhook-token")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, "data", "user-timezone.json"), "utf8")).timezone, "Europe/Paris");
  assert.ok(done.includes("data/hum-interests.json"));
  const token = fs.readFileSync(path.join(tmp, "secrets", "webhook-token"), "utf8");
  assert.deepEqual(core.prepareCheckout(tmp), [], "a second run changes nothing");
  assert.equal(fs.readFileSync(path.join(tmp, "secrets", "webhook-token"), "utf8"), token);
});

test("writeIdentity merges, drops blank optional fields and refuses a bad zone or email", () => {
  const f = core.instancePath(tmp);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ github_owner: "sam", partner_name: "Alex" }));
  const out = core.writeIdentity(tmp, { owner_name: "Sam", owner_email: "sam@example.com", tz: "Asia/Tokyo", home_city: "Tokyo", assistant_name: "Jori", partner_name: "" });
  assert.equal(out.github_owner, "sam", "fields the page does not show are kept");
  assert.equal(out.partner_name, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, "data", "user-timezone.json"), "utf8")).timezone, "Asia/Tokyo");
  assert.throws(() => core.writeIdentity(tmp, { tz: "Mars/Olympus" }), /time zone/);
  assert.throws(() => core.writeIdentity(tmp, { owner_email: "sam@" }), /email/);
});

test("the starter jobs resolve from tasks.json and are added only when missing", () => {
  const jobs = core.starterJobs(tmp);
  assert.ok(jobs.length >= 8);
  const md = jobs.find((j) => j.name === "morning-digest");
  assert.equal(md.label, "trigger-morning-digest");
  assert.match(md.schedule, /^\S+ \S+ \S+ \S+ \S+$/);
  assert.ok(jobs.find((j) => j.name === "watchdog"), "the watchdog has no task of its own but is scheduled");
  for (const j of jobs) assert.ok(fs.existsSync(path.join(REPO, j.script)), `${j.script} exists`);

  const line = core.cronLine(md, { base: "/x/jori", node: "/opt/homebrew/bin/node", home: "/home/sam" });
  assert.ok(line.includes(":/home/sam/.local/bin:"), "claude's install dir is on cron's PATH");
  assert.match(line, /^0 8 \* \* \* PATH=\S+ JORI_HOME=\/x\/jori \/x\/jori\/bin\/cron-run --label trigger-morning-digest -- \/x\/jori\/agent\/scripts\/trigger-morning-digest\.sh # jori-starter$/);

  const existing = "*/20 * * * * /y/bin/cron-run --label trigger-hum -- /y/agent/scripts/trigger-hum.sh\n";
  const missing = core.missingStarterJobs(existing, jobs);
  assert.equal(missing.length, jobs.length - 1);
  assert.ok(!missing.find((j) => j.name === "hum"), "a job already scheduled under any tag is not added again");
});

test("the service plist runs the process manager from this checkout and lints", () => {
  const xml = core.renderServicePlist({ base: "/x/my jori", node: "/opt/homebrew/bin/node", claudeBin: "/Users/sam/.local/bin/claude", home: "/Users/sam" });
  assert.match(xml, /<string>ai\.jori\.session<\/string>/);
  assert.match(xml, /<string>\/x\/my jori\/agent\/bin\/process-manager\.mjs<\/string>/);
  assert.match(xml, /\/Users\/sam\/\.local\/bin/);
  assert.ok(!xml.includes("YOUR_JORI_HOME"));
  if (process.platform === "darwin") {
    const f = path.join(tmp, "svc.plist");
    fs.writeFileSync(f, xml);
    execFileSync("plutil", ["-lint", f]);
  }
});

test("a login command's URL is found for the page's fallback link", () => {
  assert.equal(core.firstUrl("Opening browser…\nIf it did not open, visit: https://claude.ai/oauth/authorize?code=1&x=2.\n"), "https://claude.ai/oauth/authorize?code=1&x=2");
  assert.equal(core.firstUrl("nothing here"), null);
});

function req(port, { method = "GET", p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    r.on("error", reject);
    if (body) r.end(body); else r.end();
  });
}

test("the setup server: loopback Host, the page token, JSON writes", async () => {
  const { server, token } = createSetupServer({ base: tmp, token: "t0k" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    assert.equal((await req(port, { p: "/?t=t0k", headers: { host: "evil.example" } })).status, 403, "DNS rebinding is refused");
    assert.equal((await req(port, { p: "/?t=wrong" })).status, 403);
    const page = await req(port, { p: "/?t=t0k" });
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(`const SETUP_AUTH = "t0k"`));
    assert.equal((await req(port, { p: "/api/state" })).status, 403, "the API needs the token header");
    const form = await req(port, { method: "POST", p: "/api/identity", headers: { "x-setup-token": token, "content-type": "application/x-www-form-urlencoded" }, body: "a=1" });
    assert.equal(form.status, 415, "a cross-site form post is refused");
    const ok = await req(port, {
      method: "POST", p: "/api/identity", headers: { "x-setup-token": token, "content-type": "application/json" },
      body: JSON.stringify({ owner_name: "Robin", owner_email: "robin@example.com", tz: "Europe/Paris", assistant_name: "Jori", telemetry: false }),
    });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(core.instancePath(tmp), "utf8")).owner_name, "Robin");
    assert.equal(core.readDotEnv(path.join(tmp, ".env")).JORI_TELEMETRY, "off");
    const bad = await req(port, { method: "POST", p: "/api/identity", headers: { "x-setup-token": token, "content-type": "application/json" }, body: JSON.stringify({ tz: "Nowhere/Here" }) });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

// ── always-on Macs and VMs (lib/onboarding/host.mjs) ──────────────────────
const host = await import("../lib/onboarding/host.mjs");
const { isTailnetAddress, isLoopback } = await import("../lib/onboarding/server.mjs");

test("host facts parse from the commands that report them", () => {
  assert.equal(host.parseModelName("Hardware Overview:\n\n      Model Name: Mac mini\n      Model Identifier: Mac16,10\n"), "Mac mini");
  assert.equal(host.parseModelName("nothing"), null);
  const pm = host.parsePmset("System-wide power settings:\nCurrently in use:\n standby              0\n sleep                0 (sleep prevented by powerd)\n autorestart          1\n disksleep            10\n");
  assert.deepEqual([pm.sleep, pm.autorestart, pm.disksleep], [0, 1, 10]);
  assert.equal(host.parseLinger("Linger=yes\n"), true);
  assert.equal(host.parseLinger("Linger=no\n"), false);
  assert.equal(host.overSsh({ SSH_CONNECTION: "100.94.0.1 50000 100.108.0.1 22" }), true);
  assert.equal(host.overSsh({}), false);
});

test("the systemd unit runs the process manager from the checkout", () => {
  const unit = host.renderSystemdUnit({ base: "/home/sam/Dev/jori", node: "/home/sam/.local/node/bin/node", claudeBin: "/home/sam/.local/bin/claude", home: "/home/sam" });
  assert.match(unit, /^ExecStart=\/home\/sam\/\.local\/node\/bin\/node \/home\/sam\/Dev\/jori\/agent\/bin\/process-manager\.mjs$/m);
  assert.match(unit, /^Environment=JORI_HOME=\/home\/sam\/Dev\/jori$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test("tailnet addresses are 100.64.0.0/10 only", () => {
  for (const a of ["100.64.0.1", "100.108.95.34", "::ffff:100.127.255.254"]) assert.ok(isTailnetAddress(a), a);
  for (const a of ["100.63.255.255", "100.128.0.1", "10.0.0.5", "192.168.1.2", "", undefined]) assert.ok(!isTailnetAddress(a), String(a));
  assert.ok(isLoopback("127.0.0.1") && isLoopback("::1") && !isLoopback("10.0.0.1"));
});

test("over Tailscale the page answers to the tailnet name; otherwise loopback only", async () => {
  const ts = createSetupServer({ base: tmp, token: "t1", tailnetHosts: ["mini.example.ts.net", "100.108.95.34"] });
  const plain = createSetupServer({ base: tmp, token: "t2" });
  await new Promise((r) => ts.server.listen(0, "127.0.0.1", r));
  await new Promise((r) => plain.server.listen(0, "127.0.0.1", r));
  try {
    // From loopback (an SSH tunnel), the tailnet Host is accepted on the tailnet server only.
    assert.equal((await req(ts.server.address().port, { p: "/?t=t1", headers: { host: "mini.example.ts.net:9087" } })).status, 200);
    assert.equal((await req(plain.server.address().port, { p: "/?t=t2", headers: { host: "mini.example.ts.net:9087" } })).status, 403);
    assert.equal((await req(ts.server.address().port, { p: "/?t=t1", headers: { host: "evil.example" } })).status, 403);
  } finally {
    ts.server.close();
    plain.server.close();
  }
});
