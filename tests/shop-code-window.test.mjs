import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectCode, windowFor, fromDomain, siteHost, windowFile } from "../lib/shop-code-window.mjs";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "shop-code-window-"));

test("fromDomain reads the address's domain, not the display name", () => {
  assert.equal(fromDomain("Shop <noreply@mail.shop.example>"), "mail.shop.example");
  assert.equal(fromDomain("noreply@Shop.example"), "shop.example");
  assert.equal(fromDomain("\"shop.example\" <scam@evil.example>"), "evil.example");
  assert.equal(fromDomain(""), "");
});

test("siteHost normalizes a URL or www host", () => {
  assert.equal(siteHost("https://www.Shop.example/en/login"), "shop.example");
  assert.equal(siteHost("www.third.example"), "third.example");
});

test("a message from the merchant inside the window matches, a subdomain too", () => {
  const r = root();
  const now = 2_000_000_000;
  expectCode({ site: "shop.example", since: now - 20, waitSec: 120, nowSec: now, root: r });
  assert.equal(windowFor("Shop <noreply@mail.shop.example>", { nowSec: now + 10, root: r })?.site, "shop.example");
  assert.equal(windowFor("noreply@shop.example", { nowSec: now + 10, root: r })?.site, "shop.example");
});

test("another sender, or a lookalike domain, does not match", () => {
  const r = root();
  const now = 2_000_000_000;
  expectCode({ site: "shop.example", since: now - 20, nowSec: now, root: r });
  assert.equal(windowFor("a@other.example", { nowSec: now + 10, root: r }), null);
  assert.equal(windowFor("a@notshop.example", { nowSec: now + 10, root: r }), null);
  assert.equal(windowFor("a@shop.example.evil.example", { nowSec: now + 10, root: r }), null);
  assert.equal(windowFor("Shop <noreply@evil.example>", { nowSec: now + 10, root: r }), null);
});

test("the window closes: before the code was requested and after the wait", () => {
  const r = root();
  const now = 2_000_000_000;
  expectCode({ site: "shop.example", since: now, waitSec: 120, nowSec: now, root: r });
  assert.equal(windowFor("a@shop.example", { nowSec: now - 600, root: r }), null);
  assert.ok(windowFor("a@shop.example", { nowSec: now + 200, root: r }));
  assert.equal(windowFor("a@shop.example", { nowSec: now + 400, root: r }), null);
});

test("windows for several sites coexist and expired ones are dropped on write", () => {
  const r = root();
  const now = 2_000_000_000;
  expectCode({ site: "shop.example", since: now - 5000, waitSec: 10, nowSec: now - 4000, root: r });
  expectCode({ site: "third.example", since: now, nowSec: now, root: r });
  expectCode({ site: "other.example", since: now, nowSec: now, root: r });
  const sites = JSON.parse(fs.readFileSync(windowFile(r), "utf8")).windows.map((w) => w.site).sort();
  assert.deepEqual(sites, ["other.example", "third.example"]);
  assert.ok(windowFor("x@third.example", { nowSec: now + 5, root: r }));
});

test("no file, a broken file, or garbage in fails open to no window", () => {
  const r = root();
  assert.equal(windowFor("a@shop.example", { root: r }), null);
  fs.mkdirSync(path.dirname(windowFile(r)), { recursive: true });
  fs.writeFileSync(windowFile(r), "{not json");
  assert.equal(windowFor("a@shop.example", { root: r }), null);
  assert.equal(windowFor(null, { root: r }), null);
  assert.throws(() => expectCode({ site: "", since: 1, root: r }));
});
