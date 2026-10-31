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
