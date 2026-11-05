// identity-propagate: a rename rebuilds the apps, redeploys the wiki and
// restarts; a new address is routed or explained; nothing changed = no steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, summary, changedKeys, ensureCloudflareRoute } from "../lib/identity-propagate.mjs";

const prev = { assistant_name: "Jori", agent_email: "jori@example.com" };
const env = {
  serviceLoaded: true,
  wikiConfigured: true,
  appTargets: { ios: { repo: "o/r" }, macos: { repo: "o/r" } },
  emailRouting: {},
  aliases: { assistant: ["Jori"], email: ["jori@example.com"] },
};

test("no change, no steps; first run (no state) is no change", () => {
  assert.deepEqual(plan(prev, { ...prev }, env), []);
  assert.deepEqual(changedKeys(null, prev), []);
});

test("a rename sets the repo variable once, rebuilds the apps, redeploys the wiki, restarts last", () => {
  const ids = plan(prev, { ...prev, assistant_name: "Claudette" }, env).map((s) => s.id);
  assert.deepEqual(ids, ["gh-var:o/r", "apps", "wiki", "restart"]);
});

test("no build target: the owner is told the apps keep the old name", () => {
  const steps = plan(prev, { ...prev, assistant_name: "Claudette" }, { ...env, appTargets: { ios: null, macos: null } });
  const apps = steps.find((s) => s.id === "apps");
  assert.equal(apps.kind, "manual");
  assert.match(apps.what, /still say "Jori"/);
});

test("old name missing from aliases is flagged", () => {
  const steps = plan(prev, { ...prev, assistant_name: "Claudette" }, { ...env, aliases: { assistant: [], email: [] } });
  assert.ok(steps.some((s) => s.id === "alias-name"));
});

test("new address: routed on Cloudflare, explained otherwise", () => {
  const cur = { ...prev, agent_email: "claudette@example.com" };
  assert.equal(plan(prev, cur, env).find((s) => s.id === "email-route").kind, "manual");
  assert.equal(plan(prev, cur, { ...env, emailRouting: { provider: "cloudflare" } }).find((s) => s.id === "email-route").kind, "run");
});

test("summary names the change and each outcome", () => {
  const text = summary(prev, { ...prev, assistant_name: "Claudette" }, [
    { kind: "run", what: "redeploy the wiki worker", ok: true },
    { kind: "run", what: "rebuild the apps", ok: false, error: "gh not signed in" },
    { kind: "manual", what: "Add it there." },
  ]);
  assert.match(text, /name Jori → Claudette/);
  assert.match(text, /- Done: redeploy/);
  assert.match(text, /- Failed: rebuild the apps \(gh not signed in\)/);
  assert.match(text, /- To do: Add it there\./);
});

test("cloudflare route: existing rule is left alone, a missing one is added", async () => {
  const calls = [];
  const mk = (rules) => async (url, opts = {}) => {
    calls.push(opts.method || "GET");
    return { json: async () => (opts.method === "POST" ? { success: true, result: {} } : { success: true, result: rules }) };
  };
  const cfg = { provider: "cloudflare", zone_id: "z", worker: "w" };
  const e = { CLOUDFLARE_EMAIL_ROUTING_TOKEN: "t" };
  assert.equal(await ensureCloudflareRoute(cfg, "a@x.co", { fetchFn: mk([{ matchers: [{ value: "a@x.co" }] }]), env: e }), "already routed");
  assert.equal(await ensureCloudflareRoute(cfg, "b@x.co", { fetchFn: mk([]), env: e }), "rule added");
  assert.deepEqual(calls, ["GET", "GET", "POST"]);
  await assert.rejects(ensureCloudflareRoute(cfg, "b@x.co", { fetchFn: mk([]), env: {} }), /not set/);
});
