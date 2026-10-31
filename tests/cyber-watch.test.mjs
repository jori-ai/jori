// cyber-watch.test.mjs — the structural half of bin/cyber-watch-run:
// feed parsing (RSS + Atom), dedup/seen bookkeeping, domain matching, quiet
// hours, and the config's shape. The model half is not tested here.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
import {
  parseFeed, itemId, vendorForDomain, unseen, markSeen, pruneState, emptyState, inQuiet, loadConfig, allVendors,
} from "../lib/cyber-watch.mjs";

const RSS = `<?xml version="1.0"?><rss><channel><title>X</title>
<item><title><![CDATA[Railway warns devs to rotate secrets]]></title><link>https://ex.com/a</link>
<pubDate>Thu, 22 Oct 2026 17:25:31 -0400</pubDate><description>&lt;p&gt;Cloud platform &amp;amp; more&lt;/p&gt;</description><guid>https://ex.com/a</guid></item>
<item><title>Second &#8217;story&#x2019;</title><link>https://ex.com/b</link></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom one</title>
<link rel="alternate" href="https://ex.com/atom1"/><id>tag:1</id><updated>2026-10-22T10:00:00Z</updated><summary>Sum</summary></entry></feed>`;

test("parses RSS items, CDATA and entities", () => {
  const items = parseFeed(RSS);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Railway warns devs to rotate secrets");
  assert.equal(items[0].link, "https://ex.com/a");
  assert.equal(items[0].summary, "Cloud platform & more");
  assert.equal(items[1].title, "Second ’story’");
  assert.equal(items[1].guid, "https://ex.com/b");
});

test("parses Atom entries", () => {
  const [e] = parseFeed(ATOM);
  assert.equal(e.title, "Atom one");
  assert.equal(e.link, "https://ex.com/atom1");
  assert.equal(e.guid, "tag:1");
});

test("item ids are stable per source", () => {
  assert.equal(itemId("bc", "x"), itemId("bc", "x"));
  assert.notEqual(itemId("bc", "x"), itemId("thn", "x"));
});

test("domain matching: exact, subdomain, parent", () => {
  const vendors = [{ name: "Railway", domains: ["railway.app"] }, { name: "Google", domains: ["google.com"] }];
  assert.equal(vendorForDomain("railway.app", vendors)?.name, "Railway");
  assert.equal(vendorForDomain("status.railway.app", vendors)?.name, "Railway");
  assert.equal(vendorForDomain("notrailway.app", vendors), null);
  assert.equal(vendorForDomain("", vendors), null);
});

test("unseen drops seen and in-batch duplicates; markSeen logs and prunes", () => {
  const s = emptyState();
  const a = { id: "x:1", src: "x", title: "A" }, b = { id: "x:2", src: "x", title: "B" };
  assert.deepEqual(unseen([a, b, a], s).map((i) => i.id), ["x:1", "x:2"]);
  markSeen([a], s, 1000);
  assert.deepEqual(unseen([a, b], s).map((i) => i.id), ["x:2"]);
  assert.equal(s.log.length, 1);
  pruneState(s, 1000 + 31 * 86400000);
  assert.equal(Object.keys(s.seen).length, 0);
  assert.equal(s.log.length, 0);
});

test("quiet window wraps midnight", () => {
  const q = { start: 23, end: 8 };
  assert.equal(inQuiet(23, q), true);
  assert.equal(inQuiet(3, q), true);
  assert.equal(inQuiet(8, q), false);
  assert.equal(inQuiet(14, q), false);
});

test("config: every vendor has a name, tier 1-3 and a role; names unique", () => {
  const cfg = loadConfig();
  const names = new Set();
  for (const v of cfg.vendors) {
    assert.ok(v.name && v.role, JSON.stringify(v));
    assert.ok([1, 2, 3].includes(v.tier), v.name);
    assert.ok(!names.has(v.name.toLowerCase()), `duplicate ${v.name}`);
    names.add(v.name.toLowerCase());
  }
  assert.ok(cfg.feeds.length >= 3);
  assert.ok(cfg.gnews_vendor_template.includes("{NAME}"));
});

test("learned vendors never shadow a configured one", () => {
  const cfg = { vendors: [{ name: "Plaid", tier: 1, role: "r" }] };
  const st = { learned_vendors: [{ name: "plaid", tier: 3, role: "x" }, { name: "Hasdata", tier: 3, role: "y" }] };
  assert.deepEqual(allVendors(cfg, st).map((v) => v.name), ["Plaid", "Hasdata"]);
});

test("config: off without a local config; a local config and provider file turn it on and merge", () => {
  const fs = require_("node:fs"), os = require_("node:os"), path = require_("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-local-"));
  const none = (_n, d) => ({ ...d });
  const off = loadConfig(undefined, { local: none, providers: path.join(dir, "absent.json") });
  assert.equal(off.enabled, false);
  assert.deepEqual(off.vendors, []);
  assert.deepEqual(off.stack, []);
  const prov = path.join(dir, "providers.json");
  fs.writeFileSync(prov, JSON.stringify({ stack: ["Node.js"], vendors: [{ name: "Example Bank", domains: ["bank.example"], tier: 1, role: "checking" }] }));
  const on = loadConfig(undefined, { local: (_n, d) => ({ ...d, enabled: true, profile: "The user rents out a flat." }), providers: prov });
  assert.equal(on.enabled, true);
  assert.equal(on.profile, "The user rents out a flat.");
  assert.deepEqual(on.stack, ["Node.js"]);
  assert.equal(on.vendors[0].name, "Example Bank");
  assert.ok(on.feeds.length >= 3);
});
