// email-setup: each missing piece is reported in words the owner can act on,
// and a complete setup adds the routing rule and accepts a verified domain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { domainOf, cloudflareSetup, smtp2goSetup } from "../lib/email-setup.mjs";

// A fake fetch answering by URL; `routes` maps a substring to a JSON body (or {status}).
function fake(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push(`${opts.method || "GET"} ${url}`);
    const hit = Object.entries(routes).find(([k]) => url.includes(k) && (!k.startsWith("POST ") || opts.method === "POST"))
      || Object.entries(routes).find(([k]) => k.startsWith(`${opts.method || "GET"} `) && url.includes(k.split(" ")[1]));
    const v = hit ? (typeof hit[1] === "function" ? hit[1](url, opts) : hit[1]) : { success: false, errors: [{ message: `no route for ${url}` }] };
    return { status: v.status || 200, json: async () => v };
  };
  fn.calls = calls;
  return fn;
}

const zone = { id: "z1", name: "example.com", account: { id: "a1" } };

test("domainOf", () => {
  assert.equal(domainOf("Claudette@Example.com"), "example.com");
  assert.equal(domainOf("nope"), null);
  assert.equal(domainOf("a@b"), null);
});

test("cloudflare: no token, unknown domain, routing off are each explained", async () => {
  let r = await cloudflareSetup({ token: "", address: "c@example.com" });
  assert.match(r.checks[0].detail, /Paste a Cloudflare API token/);
  r = await cloudflareSetup({ token: "t", address: "c@example.org" }, { fetchFn: fake({ "/zones?": { success: true, result: [zone] } }) });
  assert.equal(r.ok, false);
  assert.match(r.checks.at(-1).detail, /can't see example\.org/);
  r = await cloudflareSetup({ token: "t", address: "c@mail.example.com" }, { fetchFn: fake({
    "/zones?": { success: true, result: [zone] },
    "/email/routing/enable": { success: false },
    "/email/routing": { success: true, result: { enabled: false } },
  }) });
  assert.equal(r.checks[0].detail, "example.com", "a subdomain finds its parent zone");
  assert.match(r.checks.at(-1).detail, /Turn on Email Routing/);
});

test("cloudflare: missing worker says how to deploy it", async () => {
  const r = await cloudflareSetup({ token: "t", address: "c@example.com", worker: "w" }, { fetchFn: fake({
    "/zones?": { success: true, result: [zone] },
    "/email/routing": { success: true, result: { enabled: true } },
    "/workers/scripts/": { status: 404 },
  }) });
  assert.equal(r.ok, false);
  assert.match(r.checks.at(-1).detail, /wrangler deploy --name w/);
});

test("cloudflare: complete setup adds the rule", async () => {
  const f = fake({
    "/zones?": { success: true, result: [zone] },
    "/workers/scripts/": { success: true },
    "/email/routing/rules": (url, o) => (o.method === "POST" ? { success: true, result: {} } : { success: true, result: [] }),
    "/email/routing": { success: true, result: { enabled: true } },
  });
  const r = await cloudflareSetup({ token: "t", address: "c@example.com", worker: "w" }, { fetchFn: f });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.equal(r.zone_id, "z1");
  assert.ok(f.calls.some((c) => c.startsWith("POST") && c.includes("/email/routing/rules")));
});

test("smtp2go: verified domain passes; unverified lists the records", async () => {
  const dom = (v) => ({ fulldomain: "example.com", dkim_verified: v, rpath_verified: v, dkim_selector: "s1", dkim_expected: "dkim.smtp2go.net", rpath_selector: "em1", rpath_expected: "return.smtp2go.net" });
  let r = await smtp2goSetup({ key: "k", address: "c@example.com" }, { fetchFn: fake({ "/domain/view": { data: { domains: [{ domain: dom(true) }] } } }) });
  assert.equal(r.ok, true);
  r = await smtp2goSetup({ key: "k", address: "c@example.com" }, { fetchFn: fake({
    "/domain/view": { data: { domains: [{ domain: dom(false) }] } },
    "/domain/verify": { data: { domains: [{ domain: dom(false) }] } },
  }) });
  assert.equal(r.ok, false);
  assert.match(r.checks.at(-1).detail, /s1\._domainkey\.example\.com → dkim\.smtp2go\.net/);
  r = await smtp2goSetup({ key: "", address: "c@example.com" });
  assert.match(r.checks[0].detail, /Paste an smtp2go API key/);
});
