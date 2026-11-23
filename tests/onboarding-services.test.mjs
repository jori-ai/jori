// lib/onboarding/services.mjs + pairing.mjs: each service is tested before
// anything is saved, only what worked is saved, and the pairing code the app
// scans round-trips.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SERVICES, connectService, servicesStatus, supabaseSaved, refFromUrl, configureSupabaseSignIn, configureSupabaseEmailCode, APP_REDIRECT } from "../lib/onboarding/services.mjs";
import { encodePairing, decodePairing, buildPairing, ensureRelay, appDistribution, PAIR_PREFIX } from "../lib/onboarding/pairing.mjs";
import { starterJobs, waitingJobs } from "../lib/onboarding/core.mjs";

function checkout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "svc-"));
  fs.mkdirSync(path.join(base, "agent", "local", "config"), { recursive: true });
  fs.writeFileSync(path.join(base, "agent", "local", "instance.json"), JSON.stringify({ owner_email: "sam@example.com", assistant_name: "Jori" })); // control-scan-ok: test fixture
  fs.writeFileSync(path.join(base, ".env"), "");
  return base;
}
const env = (base) => fs.readFileSync(path.join(base, ".env"), "utf8");
const res = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("every service says what it switches on and what it costs", () => {
  for (const s of SERVICES) {
    assert.ok(s.switchesOn && s.cost && s.steps.length, s.id);
    for (const f of s.fields) assert.ok(f.key && f.label, `${s.id}.${f.key}`);
  }
  assert.equal(SERVICES.filter((s) => s.group === "app").map((s) => s.id).join(), "supabase");
});

test("refFromUrl reads the project ref", () => {
  assert.equal(refFromUrl("https://abcd1234.supabase.co"), "abcd1234");
  assert.equal(refFromUrl("https://db.example.com"), null);
});

test("Supabase: a bad key saves nothing", async () => {
  const base = checkout();
  const fetchFn = async (url) => res(String(url).includes("/admin/") ? 401 : 200);
  const r = await connectService(base, "supabase", { url: "https://abcd1234.supabase.co", anon_key: "anon", service_role_key: "bad" }, { fetchFn });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === "Secret key works").ok, false);
  assert.equal(env(base), "");
  assert.equal(supabaseSaved(base).ref, "");
});

test("Supabase: good keys are saved; without a token the tables step says what to do", async () => {
  const base = checkout();
  const r = await connectService(base, "supabase", { url: "https://abcd1234.supabase.co", anon_key: "anon", service_role_key: "svc" }, { fetchFn: async () => res(200) });
  assert.equal(r.ok, true);
  const s = supabaseSaved(base);
  assert.deepEqual([s.ref, s.anonKey, s.serviceKey], ["abcd1234", "anon", "svc"]);
  assert.match(r.checks.find((c) => c.name === "My tables").detail, /jori-migrate --print/);
  assert.ok(!JSON.stringify(r).includes("svc\""), "the secret is never echoed");
  const st = await servicesStatus(base, { fetchFn: async () => { throw new Error("no runner"); } });
  assert.equal(st.supabase.connected, true);
  assert.equal(st.slack.connected, false);
});

test("sign-in: Google is turned on and the app's redirect added, keeping what was allowed", async () => {
  const calls = [];
  const fetchFn = async (url, opt = {}) => {
    calls.push({ url, method: opt.method || "GET", body: opt.body });
    return res(200, { uri_allow_list: "https://example.com/cb" });
  };
  const c = await configureSupabaseSignIn({ ref: "abcd1234", token: "t", clientId: "x.apps.googleusercontent.com", clientSecret: "s", fetchFn });
  assert.equal(c.ok, true);
  const patch = JSON.parse(calls.find((x) => x.method === "PATCH").body);
  assert.equal(patch.external_google_enabled, true);
  assert.equal(patch.uri_allow_list, `https://example.com/cb,${APP_REDIRECT}`);
});

test("Google: a malformed client is refused; a good one is saved and asks for sign-in next", async () => {
  const base = checkout();
  assert.equal((await connectService(base, "google", { client_id: "nope", client_secret: "s" })).ok, false);
  const r = await connectService(base, "google", { client_id: "123-abc.apps.googleusercontent.com", client_secret: "s" });
  assert.equal(r.ok, true);
  assert.equal(r.next, "authorize");
  assert.match(env(base), /GMAIL_OAUTH_CLIENT_ID=123-abc\.apps\.googleusercontent\.com/);
});

test("tunnel: only a real tunnel token is saved", async () => {
  const base = checkout();
  assert.equal((await connectService(base, "tunnel", { token: "hello" })).ok, false);
  const token = Buffer.from(JSON.stringify({ a: "acct", t: "tun", s: "sec" })).toString("base64");
  assert.equal((await connectService(base, "tunnel", { token })).ok, true);
  assert.match(env(base), /JORI_TUNNEL_TOKEN=/);
});

test("Slack: both tokens must work", async () => {
  const base = checkout();
  const fetchFn = async (url) => res(200, String(url).endsWith("auth.test") ? { ok: true, team: "Acme", user: "sam" } : { ok: false, error: "invalid_auth" });
  const r = await connectService(base, "slack", { user_token: "xoxp-1", app_token: "xapp-bad" }, { fetchFn });
  assert.equal(r.ok, false);
  assert.equal(env(base), "");
});

test("Jev: a rejected key is not saved", async () => {
  const base = checkout();
  assert.equal((await connectService(base, "jev", { api_key: "k" }, { fetchFn: async () => res(401) })).ok, false);
  assert.equal((await connectService(base, "jev", { api_key: "k" }, { fetchFn: async () => res(422) })).ok, true);
  assert.match(env(base), /TYPESAFE_API_KEY=k/);
});

test("the pairing code round-trips and carries no secret", async () => {
  const obj = { u: "https://abcd1234.supabase.co", k: "anon", n: "Jori", sp: "jori-purchase.v1", sa: "jori-approve.v1" }; // control-scan-ok: test fixture
  const code = encodePairing(obj);
  assert.ok(code.startsWith(PAIR_PREFIX));
  assert.deepEqual(decodePairing(code), obj);
  assert.throws(() => decodePairing("hello"), /not a Jori pairing code/);
  const base = checkout();
  assert.equal((await buildPairing(base, { relay: { relayConfig: () => null } })).ok, false);
  await connectService(base, "supabase", { url: "https://abcd1234.supabase.co", anon_key: "anon", service_role_key: "svc" }, { fetchFn: async () => res(200) });
  const relay = { relayConfig: () => ({ relay_url: "https://push.example", instance_id: "inst1" }), createPairing: async () => ({ token: "tok", expiresAt: 1 }) };
  const p = await buildPairing(base, { relay });
  assert.equal(p.ok, true);
  const d = decodePairing(p.code);
  assert.equal(d.k, "anon");
  assert.equal(d.r, "https://push.example");
  assert.equal(d.t, "tok");
  assert.ok(!p.code.includes("svc") && !JSON.stringify(d).includes("svc"), "the service key never goes in the code");
  assert.match(p.svg, /^<svg/);
});

test("a new host on the shared app registers with the shared relay once", async () => {
  const base = checkout();
  fs.mkdirSync(path.join(base, "system"), { recursive: true });
  const calls = [];
  let cfg = null;
  const relay = { relayConfig: () => cfg, registerInstance: async ({ relayUrl }) => { calls.push(relayUrl); cfg = { relay_url: relayUrl, instance_id: "in_x" }; return { relayUrl, instanceId: "in_x" }; } };
  // no relay configured anywhere: nothing happens
  assert.deepEqual(await ensureRelay(base, { relay, env: {} }), { registered: false });
  fs.writeFileSync(path.join(base, "system", "app-distribution.json"), JSON.stringify({ push_relay_url: "https://push.example", testflight_url: "https://testflight.apple.com/join/abc" }));
  assert.equal(appDistribution(base, {}).testflightUrl, "https://testflight.apple.com/join/abc");
  assert.equal(appDistribution(base, { JORI_TESTFLIGHT_URL: "https://t.example" }).testflightUrl, "https://t.example");
  assert.equal((await ensureRelay(base, { relay, env: {} })).registered, true);
  assert.equal((await ensureRelay(base, { relay, env: {} })).already, true);
  assert.deepEqual(calls, ["https://push.example"]);
  // a host with its own Apple key keeps pushing directly
  const own = checkout();
  fs.mkdirSync(path.join(own, "system"), { recursive: true });
  fs.writeFileSync(path.join(own, "system", "app-distribution.json"), JSON.stringify({ push_relay_url: "https://push.example" }));
  fs.writeFileSync(path.join(own, "agent", "local", "config", "apns.json"), JSON.stringify({ key_id: "K", team_id: "T" }));
  cfg = null;
  assert.equal((await ensureRelay(own, { relay, env: {} })).direct, true);
  assert.equal(calls.length, 1);
});

test("a starter job that needs a service waits for it", () => {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  assert.ok(!starterJobs(repo, []).some((j) => j.name === "message-digest"));
  assert.ok(starterJobs(repo, ["whatsapp"]).some((j) => j.name === "message-digest"));
  assert.ok(waitingJobs(repo, []).some((j) => j.name === "message-digest"));
  assert.ok(starterJobs(repo, []).every((j) => j.when));
});

test("emailed sign-in code: both templates carry the code", async () => {
  let sent;
  const c = await configureSupabaseEmailCode({ ref: "abcd1234", token: "t", name: "Jori", fetchFn: async (_u, opt) => { sent = JSON.parse(opt.body); return res(200); } }); // control-scan-ok: test fixture
  assert.equal(c.ok, true);
  assert.equal(sent.external_email_enabled, true);
  assert.match(sent.mailer_templates_magic_link_content, /\{\{ \.Token \}\}/);
  assert.match(sent.mailer_templates_confirmation_content, /\{\{ \.Token \}\}/);
});
