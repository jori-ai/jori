// shop-view.mjs — the decisions behind the phone sign-in page for the shop
// Chrome (agent/shop-view/server.mjs). Pure functions, so the parts that
// matter for safety are tested without a browser: who may use the page, which
// requests count as coming from the page itself, and how a tap, a swipe or a
// key on the phone becomes a CDP input event.
//
// WHY IT EXISTS. When a merchant signs the shop Chrome out (a ticket site once
// did, and held tickets got stuck), the only fix was "run a command on the
// host". This page shows the user the shop Chrome's tab on the user's phone and
// lets the user tap and type into it, behind the user's Cloudflare Access login.
//
// THE PERIMETER. The server binds 127.0.0.1; the only way in is the Cloudflare
// tunnel hostname, which a Cloudflare Access application gates (Google sign-in,
// the user only). The origin re-verifies the Access JWT itself — signature,
// issuer, expiry, and THIS application's audience — and then checks the email
// against SHOP_VIEW_EMAILS. Unset audience or empty list = nobody gets in. It
// is a live browser holding the user's merchant sessions, so Access is a second
// lock, never the only one (same reasoning as lib/wiki-access.js).
//
// Env (.env):
//   CF_ACCESS_TEAM_DOMAIN  shared with the wiki (<team>.cloudflareaccess.com)
//   SHOP_VIEW_CF_AUD       the shop browser Access application's Audience tag
//   SHOP_VIEW_EMAILS       comma-separated emails allowed in (the user's)
//   SHOP_VIEW_URL          public base URL (default: agent/local/config/purchase.json
//                          `shop_view_url`; none = no sign-in link can be made)

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { localConfig } = require("./instance.cjs");

export const DEFAULT_PUBLIC_URL = String(localConfig("purchase", { shop_view_url: "" }).shop_view_url || "");
export const MAX_TEXT = 256;

export function allowedEmails(env = process.env) {
  return String(env.SHOP_VIEW_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function header(req, name) {
  const h = req?.headers || {};
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Who is asking, or why not. Fails closed on every doubt: no audience
 * configured, nobody allowed, no token, a token that does not verify, or a
 * verified email that is not on the list.
 *
 * `verify` is wiki-access.js's verifyAccessJwt (injectable for tests).
 */
export async function authorize(req, { env = process.env, verify } = {}) {
  const aud = env.SHOP_VIEW_CF_AUD;
  if (!aud) return { ok: false, status: 503, reason: "SHOP_VIEW_CF_AUD is not set" };
  const emails = allowedEmails(env);
  if (!emails.length) return { ok: false, status: 503, reason: "SHOP_VIEW_EMAILS is empty" };
  const token = header(req, "cf-access-jwt-assertion");
  if (!token) return { ok: false, status: 403, reason: "no Access token" };
  const check = verify || require("./wiki-access.js").verifyAccessJwt;
  let email;
  try {
    ({ email } = await check(token, { aud }));
  } catch (e) {
    return { ok: false, status: 403, reason: `Access token rejected: ${e.message}` };
  }
  email = String(email || "").toLowerCase();
  if (!emails.includes(email)) return { ok: false, status: 403, reason: `${email} is not allowed` };
  return { ok: true, email };
}

/**
 * A state-changing request must come from the page itself. The Access cookie
 * rides along on a cross-site request too, so a JWT alone does not prove the
 * page sent it: require a JSON body (a cross-origin JSON POST needs a CORS
 * preflight, which this server never grants) and, when the browser names an
 * Origin, that it is this host.
 */
export function sameOriginWrite(req) {
  const type = String(header(req, "content-type") || "");
  if (!type.toLowerCase().startsWith("application/json")) return false;
  const origin = header(req, "origin");
  if (!origin) return true;
  const host = header(req, "x-forwarded-host") || header(req, "host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Only web pages: no javascript:, file:, chrome:, data:. A bare host gets https://. */
export function safeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s || s.length > 2048) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!u.hostname) return null;
  return u.href;
}

/**
 * A tap on the phone arrives as fractions of the frame image (0..1), so the
 * phone never needs to know the window size. The screencast frame's metadata
 * says what CSS-pixel viewport the image shows.
 */
export function toViewport(fx, fy, meta) {
  const w = Number(meta?.deviceWidth);
  const h = Number(meta?.deviceHeight);
  if (!(w > 0) || !(h > 0)) return null;
  const nx = Number(fx);
  const ny = Number(fy);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return {
    x: Math.round(clamp(nx) * w * 10) / 10,
    y: Math.round((clamp(ny) * h + (Number(meta.offsetTop) || 0)) * 10) / 10,
  };
}

/**
 * A swipe or wheel on the phone, as CDP mouse-wheel deltas in CSS pixels.
 * The page sends the drag as fractions of the picture (fdx/fdy), so the
 * content follows the finger whatever the window size; dx/dy in pixels is the
 * fallback when there is no frame metadata (and what older pages send).
 */
export function scrollDelta(a, meta) {
  const w = Number(meta?.deviceWidth);
  const h = Number(meta?.deviceHeight);
  const px = (frac, fallback, size) => {
    const v = Number.isFinite(frac) && size > 0 ? frac * size : fallback;
    return Math.round(Math.max(-3000, Math.min(3000, Number(v) || 0)));
  };
  return { deltaX: px(a.fdx, a.dx, w), deltaY: px(a.fdy, a.dy, h) };
}

export const DRAG_MAX_POINTS = 200;
const DRAG_STEP_PX = 10;
const DRAG_MAX_STEPS = 120;

/**
 * A finger drag on the picture, as the CSS-pixel points of one mouse drag: the
 * page sends the path it traced (fractions of the picture); this clamps each
 * onto the viewport and fills in any gap wider than a few pixels, so a fast
 * flick still reaches the page as a run of mouse moves (a "slide to verify"
 * handle follows moves, it does not jump). Null when there is no frame yet or
 * the path is not at least two points.
 */
export function dragPath(points, meta) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const mapped = [];
  for (const p of points.slice(0, DRAG_MAX_POINTS)) {
    const v = toViewport(p?.x, p?.y, meta);
    if (!v) return null;
    mapped.push(v);
  }
  let length = 0;
  for (let i = 1; i < mapped.length; i++) length += Math.hypot(mapped[i].x - mapped[i - 1].x, mapped[i].y - mapped[i - 1].y);
  // Spread the extra points over the whole path, never more than DRAG_MAX_STEPS in all.
  const extra = Math.max(0, Math.min(DRAG_MAX_STEPS, Math.ceil(length / DRAG_STEP_PX)) - (mapped.length - 1));
  const out = [mapped[0]];
  for (let i = 1; i < mapped.length; i++) {
    const a = mapped[i - 1], b = mapped[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    const n = length > 0 ? Math.round((extra * seg) / length) : 0;
    for (let k = 1; k <= n; k++) out.push({ x: Math.round((a.x + ((b.x - a.x) * k) / (n + 1)) * 10) / 10, y: Math.round((a.y + ((b.y - a.y) * k) / (n + 1)) * 10) / 10 });
    out.push(b);
  }
  return out;
}

// Phone view: the page lays out at the size of the picture's box on the phone,
// so the picture shows it 1:1. Zooming out lays it out bigger (size / zoom) in
// the same box, so more of a tall form fits on the screen at once.
export const PHONE_DEFAULT = { width: 412, height: 860 };
export const ZOOM_MIN = 0.4;

/** Emulation.setDeviceMetricsOverride params for phone view. */
export function phoneMetrics({ width, height, zoom } = {}) {
  const z = Number.isFinite(zoom) ? Math.min(1, Math.max(ZOOM_MIN, zoom)) : 1;
  const clamp = (v, lo, hi) => Math.round(Math.min(hi, Math.max(lo, v)));
  return {
    width: clamp((width || PHONE_DEFAULT.width) / z, 320, 1600),
    height: clamp((height || PHONE_DEFAULT.height) / z, 320, 2400),
    deviceScaleFactor: 2,
    mobile: true,
  };
}

// The keys the phone's key row can send. Each needs code + virtual key code,
// or pages that listen for keydown (most login forms submit on Enter) ignore it.
const KEYS = {
  Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
  ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};
export const KEY_NAMES = Object.keys(KEYS);

/** [keyDown, keyUp] CDP params for a named key, or null if it is not one we send. */
export function keyEvents(name) {
  const k = KEYS[name];
  if (!k) return null;
  const key = k.key || name;
  const down = { type: "keyDown", key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode };
  if (k.text) Object.assign(down, { text: k.text, unmodifiedText: k.text });
  return [down, { type: "keyUp", key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode }];
}

/**
 * Validate one input message from the page into a normalized action, or throw.
 * The server acts only on what comes back from here.
 */
export function parseAction(msg) {
  const m = msg && typeof msg === "object" ? msg : {};
  switch (m.type) {
    case "tap":
    case "scroll": {
      const x = Number(m.x);
      const y = Number(m.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${m.type} needs x and y`);
      if (m.type === "tap") return { type: "tap", x, y };
      const num = (v, lim) => (v == null || v === "" || !Number.isFinite(Number(v)) ? undefined : Math.max(-lim, Math.min(lim, Number(v))));
      const a = { type: "scroll", x, y, dx: num(m.dx, 3000) ?? 0, dy: num(m.dy, 3000), fdx: num(m.fdx, 5), fdy: num(m.fdy, 5) };
      if (a.dy === undefined && a.fdy === undefined) throw new Error("scroll needs dy");
      if (a.dy === undefined) a.dy = 0;
      for (const k of ["fdx", "fdy"]) if (a[k] === undefined) delete a[k];
      return a;
    }
    case "drag": {
      if (!Array.isArray(m.points) || m.points.length < 2) throw new Error("drag needs at least two points");
      const points = m.points.slice(0, DRAG_MAX_POINTS).map((p) => ({ x: Number(p?.x), y: Number(p?.y) }));
      if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error("drag points need x and y");
      return { type: "drag", points };
    }
    case "text": {
      const text = String(m.text ?? "");
      if (!text) throw new Error("text is empty");
      if ([...text].length > MAX_TEXT) throw new Error(`text longer than ${MAX_TEXT} characters`);
      return { type: "text", text };
    }
    case "key":
      if (!KEYS[m.key]) throw new Error(`unsupported key ${String(m.key).slice(0, 20)}`);
      return { type: "key", key: m.key };
    case "navigate": {
      const url = safeUrl(m.url);
      if (!url) throw new Error("only http(s) addresses");
      return { type: "navigate", url };
    }
    case "back":
    case "forward":
    case "reload":
      return { type: m.type };
    case "tab":
      if (typeof m.id !== "string" || !/^[A-Za-z0-9]{8,64}$/.test(m.id)) throw new Error("bad tab id");
      return { type: "tab", id: m.id };
    case "phone": {
      const a = { type: "phone", on: Boolean(m.on) };
      const size = (v) => (Number.isFinite(Number(v)) && Number(v) >= 100 && Number(v) <= 2000 ? Math.round(Number(v)) : undefined);
      if (size(m.width) && size(m.height)) Object.assign(a, { width: size(m.width), height: size(m.height) });
      if (m.zoom != null && Number.isFinite(Number(m.zoom))) a.zoom = Math.min(1, Math.max(ZOOM_MIN, Number(m.zoom)));
      return a;
    }
    case "done":
      return { type: "done" };
    default:
      throw new Error(`unknown action ${String(m.type).slice(0, 20)}`);
  }
}

/**
 * The link Jori puts in a "please sign in" message. `url` (a login page)
 * is offered on the page as a button — never opened just because the link was
 * followed, so a link alone can't drive the browser anywhere.
 */
export function signinLink({ base, site, url } = {}, env = process.env) {
  const root = String(base || env.SHOP_VIEW_URL || DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
  if (!root) throw new Error("no shop-view URL: set SHOP_VIEW_URL or shop_view_url in agent/local/config/purchase.json");
  const u = new URL(`${root}/`);
  const target = safeUrl(url || (site ? `https://${site}` : ""));
  if (target) u.searchParams.set("open", target);
  if (site) u.searchParams.set("site", String(site).slice(0, 100));
  return u.href;
}

// ── the app's way in (tailnet, Face ID) ────────────────────────────────────
//
// The Jori app opens the same page in its own web view, straight over
// Tailscale like the Memory tab, with no Cloudflare in between. Two locks
// again, neither of them a third party:
//   1. the network: the app listener answers only Tailscale addresses
//      (isTailnetAddress), so a plain-HTTP page full of passwords and card
//      codes never crosses the home Wi-Fi unencrypted;
//   2. the person: the app signs a one-time challenge with its paired PURCHASE
//      key (Secure Enclave, Face ID on every signature); the server checks it
//      against that device's public key in `purchase_device_keys`, then hands
//      the web view a short-lived HttpOnly session cookie.
// The signed message starts with `<purchase domain>/shop-view`, never the bare
// purchase domain, so a sign-in can never be replayed as a purchase approval
// (whose first line is exactly the domain) or the other way round.

export const APP_CHALLENGE_TTL_MS = 2 * 60_000;
export const APP_SESSION_IDLE_MS = 30 * 60_000;
export const APP_SESSION_MAX_MS = 4 * 60 * 60_000;
export const APP_COOKIE = "jori_shop";

/** Tailscale's ranges: 100.64.0.0/10 (IPv4, also IPv4-mapped IPv6) and fd7a:115c:a1e0::/48. */
export function isTailnetAddress(addr) {
  let a = String(addr || "").trim().toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice(7);
  const v4 = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [o1, o2] = [Number(v4[1]), Number(v4[2])];
    return o1 === 100 && o2 >= 64 && o2 <= 127 && v4.slice(1).every((o) => Number(o) <= 255);
  }
  return /^fd7a:115c:a1e0:/.test(a);
}

/** What the app signs to open a session. One line per field, no free text. */
export function appSessionMessage({ domain, deviceId, nonce, expiresAt }) {
  return `${domain}/shop-view\n${deviceId}\n${nonce}\n${expiresAt}`;
}

/** The value of one cookie, or null. */
export function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

/** A path + query on this page to land on after sign-in; anything else is "/". */
export function safeNext(raw) {
  const s = String(raw || "");
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\") || s.length > 2048) return "/";
  try {
    const u = new URL(s, "http://x");
    return u.pathname === "/" ? `/${u.search}` : "/";
  } catch {
    return "/";
  }
}

/**
 * Challenges and sessions for the app listener. In memory on purpose: a
 * restart signs everyone out, which costs one Face ID.
 *   challenge()                         → { nonce, expiresAt }
 *   redeem({deviceId, nonce, signatureB64, publicKeyRawB64, verify}) → { ok, token } | { ok:false, reason }
 *   check(token)                        → { ok, deviceId } | { ok:false }
 * `verify` is app-approval.mjs's verifySignature (injected, so this file stays pure).
 */
export class AppSessions {
  constructor({ domain, now = () => Date.now(), random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)) } = {}) {
    if (!domain) throw new Error("AppSessions needs the purchase signing domain");
    this.domain = domain;
    this.now = now;
    this.random = random;
    this.challenges = new Map();
    this.sessions = new Map();
  }

  #hex(n) {
    return [...this.random(n)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  #sweep() {
    const t = this.now();
    for (const [k, v] of this.challenges) if (v <= t) this.challenges.delete(k);
    for (const [k, v] of this.sessions) if (v.idleUntil <= t || v.hardUntil <= t) this.sessions.delete(k);
    while (this.challenges.size > 50) this.challenges.delete(this.challenges.keys().next().value);
  }

  challenge() {
    this.#sweep();
    const nonce = this.#hex(24);
    const expiresAt = this.now() + APP_CHALLENGE_TTL_MS;
    this.challenges.set(nonce, expiresAt);
    return { nonce, expiresAt };
  }

  /** The challenge's expiry, while it is still open (the app signs over it). */
  challengeExpiry(nonce) {
    this.#sweep();
    return this.challenges.get(String(nonce || "")) ?? null;
  }

  redeem({ deviceId, nonce, signatureB64, publicKeyRawB64, verify }) {
    this.#sweep();
    const n = String(nonce || "");
    const expiresAt = this.challenges.get(n);
    if (!expiresAt) return { ok: false, reason: "unknown or expired challenge" };
    this.challenges.delete(n); // one try per challenge, right or wrong
    if (!/^[A-Za-z0-9-]{8,64}$/.test(String(deviceId || ""))) return { ok: false, reason: "bad device id" };
    if (!publicKeyRawB64) return { ok: false, reason: "this device is not paired for purchases" };
    const message = appSessionMessage({ domain: this.domain, deviceId, nonce: n, expiresAt });
    if (!verify({ message, signatureB64, publicKeyRawB64 })) return { ok: false, reason: "signature did not verify" };
    const token = this.#hex(32);
    const t = this.now();
    this.sessions.set(token, { deviceId, idleUntil: t + APP_SESSION_IDLE_MS, hardUntil: t + APP_SESSION_MAX_MS });
    return { ok: true, token };
  }

  check(token) {
    this.#sweep();
    const s = token ? this.sessions.get(token) : null;
    if (!s) return { ok: false };
    s.idleUntil = Math.min(s.hardUntil, this.now() + APP_SESSION_IDLE_MS);
    return { ok: true, deviceId: s.deviceId };
  }

  end(token) {
    if (token) this.sessions.delete(token);
  }
}

export const DEFAULT_APP_URL = String(localConfig("purchase", { shop_view_app_url: "" }).shop_view_app_url || "");
// Which link `shop-view link` hands out by default: "web" (the Cloudflare page)
// until an app build that can open the in-app link is on the user's devices,
// then "app". Separate from shop_view_app_url, which only turns the listener on.
export const DEFAULT_LINK_KIND = String(localConfig("purchase", { shop_view_link: "web" }).shop_view_link || "web");

/**
 * The in-app link: the app listener's address (as the app is built with,
 * JORI_SHOP_VIEW_URL), which the Jori app opens in its own shop browser
 * screen. Same `open`/`site` hints as signinLink. Null when not configured.
 */
export function appSigninLink({ base, site, url } = {}, env = process.env) {
  const root = String(base || env.SHOP_VIEW_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "");
  if (!root) return null;
  return signinLink({ base: root, site, url }, env);
}
