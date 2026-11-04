// shop-view.test.mjs — the phone sign-in page for the shop Chrome
// (lib/shop-view.mjs, agent/shop-view/server.mjs).
//
// It is a live browser holding the user's merchant sessions, reachable from the
// internet through the tunnel. These tests pin the parts that keep it the user's:
// the origin re-verifies Cloudflare Access (THIS app's audience, the user's email),
// fails closed when unconfigured, refuses cross-site writes, opens only web
// URLs, and turns taps/keys into the right CDP input.
//
// Run: node --test tests/shop-view.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as V from "../lib/shop-view.mjs";

const require = createRequire(import.meta.url);
const REPO = path.resolve(import.meta.dirname, "..");

const ENV = { SHOP_VIEW_CF_AUD: "shop-aud", SHOP_VIEW_EMAILS: "owner@example.com", CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" };
const req = (headers = {}) => ({ headers });
const okVerify = (email) => async (_t, { aud }) => { assert.equal(aud, "shop-aud"); return { email }; };

// ── authorize ──────────────────────────────────────────────────────────────
test("authorize: the allowed user with a verified token gets in", async () => {
  const r = await V.authorize(req({ "cf-access-jwt-assertion": "x.y.z" }), { env: ENV, verify: okVerify("OWNER@example.com") });
  assert.deepEqual(r, { ok: true, email: "owner@example.com" });
});

test("authorize: a verified email that is not on the list is refused", async () => {
  const r = await V.authorize(req({ "cf-access-jwt-assertion": "x.y.z" }), { env: ENV, verify: okVerify("someone.else@example.com") });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("authorize: no token, or a token that fails verification, is refused", async () => {
  assert.equal((await V.authorize(req(), { env: ENV, verify: okVerify("owner@example.com") })).status, 403);
  const bad = async () => { throw new Error("bad signature"); };
  const r = await V.authorize(req({ "cf-access-jwt-assertion": "x.y.z" }), { env: ENV, verify: bad });
  assert.equal(r.ok, false);
  assert.match(r.reason, /bad signature/);
});

test("authorize: fails closed when the audience or the allow-list is not configured", async () => {
  const h = req({ "cf-access-jwt-assertion": "x.y.z" });
  const v = okVerify("owner@example.com");
  assert.equal((await V.authorize(h, { env: { ...ENV, SHOP_VIEW_CF_AUD: "" }, verify: v })).ok, false);
  assert.equal((await V.authorize(h, { env: { ...ENV, SHOP_VIEW_EMAILS: " , " }, verify: v })).ok, false);
});

// The real verifier, end to end, with a key we control standing in for
// Cloudflare's: the shop app's audience opens the page, the wiki's does not.
test("verifyAccessJwt honours the per-app audience (a wiki token can't open the shop page)", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
  const team = `t${Date.now()}.cloudflareaccess.com`; // fresh domain → the module's JWKS cache can't interfere
  const realFetch = globalThis.fetch;
  const saved = { team: process.env.CF_ACCESS_TEAM_DOMAIN, aud: process.env.CF_ACCESS_AUD };
  globalThis.fetch = async (url) => {
    assert.equal(String(url), `https://${team}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  };
  process.env.CF_ACCESS_TEAM_DOMAIN = team;
  process.env.CF_ACCESS_AUD = "wiki-aud";
  const sign = (aud) => {
    const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const hp = `${b({ alg: "RS256", kid: "k1" })}.${b({ aud: [aud], iss: `https://${team}`, email: "owner@example.com", exp: now + 600, iat: now })}`;
    return `${hp}.${crypto.sign("RSA-SHA256", Buffer.from(hp), privateKey).toString("base64url")}`;
  };
  try {
    const { verifyAccessJwt } = require("../lib/wiki-access.js");
    const env = { ...ENV, CF_ACCESS_TEAM_DOMAIN: team };
    const ok = await V.authorize(req({ "cf-access-jwt-assertion": sign("shop-aud") }), { env, verify: verifyAccessJwt });
    assert.deepEqual(ok, { ok: true, email: "owner@example.com" });
    const wiki = await V.authorize(req({ "cf-access-jwt-assertion": sign("wiki-aud") }), { env, verify: verifyAccessJwt });
    assert.equal(wiki.ok, false);
    assert.match(wiki.reason, /audience/);
    // …and the wiki's own default (no aud option) is unchanged.
    assert.equal((await verifyAccessJwt(sign("wiki-aud"))).email, "owner@example.com");
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [["CF_ACCESS_TEAM_DOMAIN", saved.team], ["CF_ACCESS_AUD", saved.aud]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// ── cross-site writes ──────────────────────────────────────────────────────
test("sameOriginWrite: JSON from this host passes; forms and other origins don't", () => {
  const json = { "content-type": "application/json", host: "shop.example.com" };
  assert.equal(V.sameOriginWrite(req(json)), true);
  assert.equal(V.sameOriginWrite(req({ ...json, origin: "https://shop.example.com" })), true);
  assert.equal(V.sameOriginWrite(req({ ...json, origin: "https://evil.example" })), false);
  assert.equal(V.sameOriginWrite(req({ ...json, origin: "null" })), false);
  assert.equal(V.sameOriginWrite(req({ "content-type": "application/x-www-form-urlencoded", host: "shop.example.com" })), false);
  assert.equal(V.sameOriginWrite(req({ "content-type": "text/plain", host: "shop.example.com" })), false);
});

// ── navigation ─────────────────────────────────────────────────────────────
test("safeUrl: web pages only; a bare host gets https", () => {
  assert.equal(V.safeUrl("tickets.example.com"), "https://tickets.example.com/");
  assert.equal(V.safeUrl("http://example.com/a?b=1"), "http://example.com/a?b=1");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "data:text/html,hi", "", "   ", "x".repeat(3000)]) {
    assert.equal(V.safeUrl(bad), null, bad.slice(0, 30));
  }
});

// ── input mapping ──────────────────────────────────────────────────────────
test("toViewport maps a tap's image fractions onto the CSS viewport, clamped", () => {
  const meta = { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0 };
  assert.deepEqual(V.toViewport(0.5, 0.25, meta), { x: 640, y: 200 });
  assert.deepEqual(V.toViewport(-1, 2, meta), { x: 0, y: 800 });
  assert.deepEqual(V.toViewport(0.5, 0.5, { ...meta, offsetTop: 10 }), { x: 640, y: 410 });
  assert.equal(V.toViewport(0.5, 0.5, null), null, "no frame yet → no click at a guessed spot");
  assert.equal(V.toViewport("a", 0.5, meta), null);
});

test("keyEvents: Enter carries \\r (forms submit on it); unknown keys are refused", () => {
  const [down, up] = V.keyEvents("Enter");
  assert.equal(down.type, "keyDown");
  assert.equal(down.text, "\r");
  assert.equal(down.windowsVirtualKeyCode, 13);
  assert.equal(up.type, "keyUp");
  assert.equal(V.keyEvents("Backspace")[0].windowsVirtualKeyCode, 8);
  assert.equal(V.keyEvents("Meta"), null);
});

test("parseAction validates every message the page can send", () => {
  assert.deepEqual(V.parseAction({ type: "tap", x: "0.2", y: 0.3 }), { type: "tap", x: 0.2, y: 0.3 });
  assert.deepEqual(V.parseAction({ type: "scroll", x: 0.5, y: 0.5, dy: 99999 }), { type: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 3000 });
  assert.deepEqual(V.parseAction({ type: "scroll", x: 0.5, y: 0.5, fdy: -0.25, fdx: 9 }), { type: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 0, fdx: 5, fdy: -0.25 });
  assert.deepEqual(V.parseAction({ type: "text", text: "hunter2" }), { type: "text", text: "hunter2" });
  assert.deepEqual(V.parseAction({ type: "key", key: "Tab" }), { type: "key", key: "Tab" });
  assert.deepEqual(V.parseAction({ type: "navigate", url: "seats.example.com" }), { type: "navigate", url: "https://seats.example.com/" });
  assert.deepEqual(V.parseAction({ type: "tab", id: "ABCDEF0123456789" }), { type: "tab", id: "ABCDEF0123456789" });
  assert.deepEqual(V.parseAction({ type: "done" }), { type: "done" });
  assert.deepEqual(V.parseAction({ type: "phone", on: 1 }), { type: "phone", on: true });
  assert.deepEqual(V.parseAction({ type: "phone", on: true, width: 390.4, height: "407", zoom: 0.1 }), { type: "phone", on: true, width: 390, height: 407, zoom: V.ZOOM_MIN });
  assert.deepEqual(V.parseAction({ type: "phone", on: true, width: 50, height: 400 }), { type: "phone", on: true }, "a size out of range is dropped, not guessed");
  for (const bad of [
    null, {}, { type: "eval", js: "1" }, { type: "tap", x: 1 }, { type: "text", text: "" },
    { type: "text", text: "a".repeat(V.MAX_TEXT + 1) }, { type: "key", key: "F12" },
    { type: "navigate", url: "javascript:alert(1)" }, { type: "tab", id: "../x" }, { type: "scroll", x: 0.5, y: 0.5 },
  ]) {
    assert.throws(() => V.parseAction(bad), undefined, JSON.stringify(bad)?.slice(0, 40));
  }
});

test("scrollDelta: a swipe of a share of the picture scrolls the same share of the page", () => {
  const meta = { deviceWidth: 390, deviceHeight: 800 };
  assert.deepEqual(V.scrollDelta({ fdx: 0, fdy: 0.5, dy: 123 }, meta), { deltaX: 0, deltaY: 400 });
  assert.deepEqual(V.scrollDelta({ fdx: -0.1, fdy: 0 }, meta), { deltaX: -39, deltaY: 0 });
  assert.deepEqual(V.scrollDelta({ dx: 0, dy: 500 }, meta), { deltaX: 0, deltaY: 500 }, "pixels from an older page pass through");
  assert.deepEqual(V.scrollDelta({ fdy: 0.5, dy: 250 }, null), { deltaX: 0, deltaY: 250 }, "no frame yet → the pixel guess");
  assert.deepEqual(V.scrollDelta({ fdy: 5 }, { deviceWidth: 390, deviceHeight: 2000 }), { deltaX: 0, deltaY: 3000 });
});

test("phoneMetrics: phone view is laid out at the picture's size, bigger when zoomed out", () => {
  assert.deepEqual(V.phoneMetrics({ width: 390, height: 407 }), { width: 390, height: 407, deviceScaleFactor: 2, mobile: true });
  assert.deepEqual(V.phoneMetrics({ width: 390, height: 407, zoom: 0.5 }), { width: 780, height: 814, deviceScaleFactor: 2, mobile: true });
  assert.deepEqual(V.phoneMetrics({}), { width: 412, height: 860, deviceScaleFactor: 2, mobile: true }, "an older page sends no size");
  assert.equal(V.phoneMetrics({ width: 200, height: 200 }).width, 320);
  assert.equal(V.phoneMetrics({ width: 1900, height: 1900, zoom: 0.4 }).height, 2400);
});

// ── the link in Jori's message ──────────────────────────────────────────
test("signinLink carries the login page as an offer, not an instruction", () => {
  const BASE = { SHOP_VIEW_URL: "https://shop.example.com" };
  const u = new URL(V.signinLink({ site: "tickets.example.com", url: "https://www.tickets.example.com/member/signin" }, BASE));
  assert.equal(u.origin, "https://shop.example.com");
  assert.equal(u.searchParams.get("open"), "https://www.tickets.example.com/member/signin");
  assert.equal(u.searchParams.get("site"), "tickets.example.com");
  assert.equal(new URL(V.signinLink({}, { SHOP_VIEW_URL: "https://x.example.com/" })).href, "https://x.example.com/");
  assert.equal(new URL(V.signinLink({ url: "javascript:alert(1)" }, BASE)).searchParams.get("open"), null);
  // No URL anywhere (a fresh install): no link, rather than a link to nowhere.
  if (!V.DEFAULT_PUBLIC_URL) assert.throws(() => V.signinLink({ site: "tickets.example.com" }, {}), /no shop-view URL/);
});

// ── shop-browser Session event routing (the screencast relies on it) ───────
test("shop-browser Session routes subscribed CDP events to their handler", async () => {
  const listeners = {};
  globalThis.WebSocket = class {
    constructor() { setTimeout(() => listeners.open?.(), 0); }
    addEventListener(ev, fn) { listeners[ev] = fn; }
    send() {}
    close() {}
  };
  const B = await import("../lib/shop-browser.mjs");
  const s = await B.connect({ webSocketDebuggerUrl: "ws://fake" });
  const got = [];
  s.on("Page.screencastFrame", (p) => got.push(p.sessionId));
  listeners.message({ data: JSON.stringify({ method: "Page.screencastFrame", params: { sessionId: 7 } }) });
  listeners.message({ data: JSON.stringify({ method: "Page.loadEventFired", params: {} }) });
  assert.deepEqual(got, [7]);
  assert.equal(s.events.length, 1, "unsubscribed events still buffer as before");
});

// ── the server's front door, without a browser ─────────────────────────────
test("server: /healthz answers; every other path refuses a request with no Access token", async (t) => {
  const port = 19000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [path.join(REPO, "agent/shop-view/server.mjs")], {
    env: { ...process.env, ...ENV, SHOP_VIEW_PORT: String(port), SHOP_CDP_PORT: "1" },
    stdio: "ignore",
  });
  t.after(() => child.kill());
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise((r) => setTimeout(r, 100));
    up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
  }
  if (!up) return t.skip("could not bind a local port here (sandbox?)");
  for (const [method, p] of [["GET", "/"], ["GET", "/api/state"], ["GET", "/api/frame"], ["POST", "/api/input"]]) {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? '{"type":"done"}' : undefined });
    assert.equal(r.status, 403, `${method} ${p}`);
  }
  const forged = await fetch(`http://127.0.0.1:${port}/`, { headers: { "Cf-Access-Jwt-Assertion": "a.b.c" } });
  assert.equal(forged.status, 403, "a token that does not verify is no token");
});
