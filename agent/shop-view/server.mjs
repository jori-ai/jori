// shop-view/server.mjs — phone sign-in page for the SHOP Chrome (CDP :9224).
//
// When a merchant signs the shop Chrome out, the user opens the link Jori
// sends (SHOP_VIEW_URL/…), sees the shop Chrome's tab on the phone,
// and taps and types into it to sign in. No VNC, no desktop: one Chrome
// profile, through the CDP connection Jori already uses.
//
//   frames  Page.startScreencast on the selected tab while someone is watching
//           (stops 20s after the last frame request); the page long-polls
//           GET /api/frame?after=<seq> for the newest JPEG.
//   input   POST /api/input {type: tap|scroll|drag|text|key|navigate|back|forward|
//           reload|tab|phone|done}. Taps are real mouse events
//           (Input.dispatchMouseEvent), a swipe on the picture is mouse-wheel
//           scrolling at the finger's spot (Drag mode on the page sends the traced path
//           as one real mouse drag: press, moves with the left button held,
//           release), text is one keyDown/keyUp per
//           character — the same trusted input shop-browser.mjs uses, because
//           merchant bot sensors refuse synthetic JS clicks.
//   hold    the tab, and the phone layout with it, is kept for HOLD_MS after
//           the last request, so switching apps to fetch a card number does
//           not re-lay the page out under a half-filled form.
//   done    stops the stream, drops the phone-layout override, and writes
//           data/purchases/shop-view-done.json so the job that asked can
//           see the user finished.
//
// Two listeners, the same page and the same CDP session behind both:
//   web  127.0.0.1:<shop_view> — reachable from outside solely through the
//        Cloudflare tunnel hostname behind a Cloudflare Access application;
//        every request is re-authorized here (lib/shop-view.mjs → authorize).
//   app  [::]:<shop_view_app> — the Jori app's shop browser screen, straight
//        over Tailscale. Answers Tailscale addresses only; a session starts
//        with a Face ID signature from the app's paired purchase key over a
//        one-time challenge (GET /app/challenge, GET /app/session), checked
//        against `purchase_device_keys`, then rides an HttpOnly cookie
//        (lib/shop-view.mjs → AppSessions). On only when the app address is
//        configured (purchase.json `shop_view_app_url` / SHOP_VIEW_APP_URL).
// Typed text is never logged — it is often a password.
//
// launchd: agent/shop-view/com.jori.shop-view.plist (KeepAlive).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { REPO_ROOT } from "../../lib/root.cjs";
import { assistantName } from "../../lib/instance.cjs";
import { port as registryPort } from "../../lib/ports.cjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = REPO_ROOT;
for (const l of (() => { try { return fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n"); } catch { return []; } })()) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const V = await import(path.join(ROOT, "lib/shop-view.mjs"));
const B = await import(path.join(ROOT, "lib/shop-browser.mjs"));
const { verifySignature } = await import(path.join(ROOT, "agent/core/app-approval.mjs"));
const { PURCHASE_DOMAIN } = await import(path.join(ROOT, "lib/purchase-approval.mjs"));
const { supabaseUrl } = createRequire(import.meta.url)("../../lib/instance.cjs");

const PORT = Number(process.env.SHOP_VIEW_PORT) || registryPort("shop_view");
const HOST = "127.0.0.1";
const APP_PORT = Number(process.env.SHOP_VIEW_APP_PORT) || registryPort("shop_view_app");
const APP_ON = Boolean(process.env.SHOP_VIEW_APP_URL || V.DEFAULT_APP_URL);
const APP = new V.AppSessions({ domain: PURCHASE_DOMAIN });
const IDLE_MS = 20_000;
const HOLD_MS = 5 * 60_000;
const LONGPOLL_MS = 12_000;
const DONE_FILE = path.join(ROOT, "data/purchases/shop-view-done.json");
const LOG = path.join(ROOT, "agent/logs/shop-view.log");
const PAGE = path.join(HERE, "page.html");
// Phone layout: a mobile viewport the size of the picture on the user's phone
// (V.phoneMetrics), so a desktop form is readable there. Emulation overrides
// belong to OUR CDP session and vanish when it closes, so the shop tab can
// never be left stuck in it.

if (B.SHOP_PORT === String(registryPort("chrome_cdp"))) throw new Error(`shop-view must never drive the ${registryPort("chrome_cdp")} automation Chrome`);

function log(line) {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch {}
}

// ── the CDP side ───────────────────────────────────────────────────────────
const S = {
  tabId: null, session: null, connecting: null, streaming: false, phone: false, zoom: 1,
  frame: null, seq: 0, meta: null, lastWant: 0, waiters: new Set(), idleTimer: null, holdTimer: null,
};

async function defaultTabId() {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(ROOT, "data", `.cdp-driver-state-${B.SHOP_PORT}.json`), "utf8"));
    if (st.tab_id) return st.tab_id;
  } catch {}
  const pages = await B.listPages();
  return pages.find((p) => p.url.startsWith("http"))?.id || pages[0]?.id || null;
}

function dropSession() {
  const s = S.session;
  S.session = null; S.streaming = false; S.phone = false; S.zoom = 1; S.meta = null; S.frame = null;
  if (s) s.close();
}

async function ensureSession() {
  if (S.session) return S.session;
  if (S.connecting) return S.connecting;
  S.connecting = (async () => {
    const pages = await B.listPages();
    if (!S.tabId || !pages.some((p) => p.id === S.tabId)) S.tabId = await defaultTabId();
    const tab = pages.find((p) => p.id === S.tabId) || (await B.listPages()).find((p) => p.id === S.tabId);
    if (!tab) throw new Error("the shop Chrome has no tab open");
    const s = await B.connect(tab);
    s.ws.addEventListener("close", () => { if (S.session === s) { S.session = null; S.streaming = false; S.phone = false; S.zoom = 1; } });
    s.on("Page.screencastFrame", (p) => {
      s.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
      S.frame = Buffer.from(p.data, "base64");
      S.meta = p.metadata;
      S.seq += 1;
      for (const w of S.waiters) w();
      S.waiters.clear();
    });
    await s.send("Page.enable");
    S.session = s;
    return s;
  })();
  try { return await S.connecting; } finally { S.connecting = null; }
}

async function startStream() {
  const s = await ensureSession();
  if (S.streaming) return;
  await s.send("Page.bringToFront").catch(() => {});
  await s.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 1600, everyNthFrame: 1 });
  S.streaming = true;
}

async function stopStream() {
  if (S.session && S.streaming) await S.session.send("Page.stopScreencast").catch(() => {});
  S.streaming = false;
}

function touchViewer() {
  S.lastWant = Date.now();
  clearTimeout(S.idleTimer);
  clearTimeout(S.holdTimer);
  // Nobody watching: stop the stream. The tab, and any phone layout, is
  // released only after HOLD_MS, or at once on Done.
  // Dropping the old frame makes the next picture, and the next tap, wait for a fresh one.
  S.idleTimer = setTimeout(() => { if (Date.now() - S.lastWant >= IDLE_MS) { S.frame = null; S.meta = null; stopStream(); } }, IDLE_MS + 500);
  S.holdTimer = setTimeout(() => { if (Date.now() - S.lastWant >= HOLD_MS) dropSession(); }, HOLD_MS + 500);
}

async function switchTab(id) {
  const pages = await B.listPages();
  if (!pages.some((p) => p.id === id)) throw new Error("no such tab in the shop Chrome");
  dropSession();
  S.tabId = id;
  S.frame = null;
  await startStream();
}

async function setPhone(a) {
  const s = await ensureSession();
  if (a.on) await s.send("Emulation.setDeviceMetricsOverride", V.phoneMetrics(a));
  else await s.send("Emulation.clearDeviceMetricsOverride");
  S.phone = a.on;
  S.zoom = a.on ? (a.zoom ?? 1) : 1;
}

async function act(a, email) {
  if (a.type === "tab") return switchTab(a.id);
  if (a.type === "done") return done(email);
  const s = await ensureSession();
  switch (a.type) {
    case "tap": {
      const p = V.toViewport(a.x, a.y, S.meta);
      if (!p) throw new Error("no frame yet — wait for the picture");
      await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
      await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
      await B.sleep(60);
      await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
      return;
    }
    case "scroll": {
      const p = V.toViewport(a.x, a.y, S.meta);
      if (!p) throw new Error("no frame yet — wait for the picture");
      await s.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, ...V.scrollDelta(a, S.meta) });
      return;
    }
    case "drag": {
      // A real drag (a "slide to verify" handle): press, moves with the left
      // button held, release. Not a wheel scroll.
      const path = V.dragPath(a.points, S.meta);
      if (!path) throw new Error("no frame yet — wait for the picture");
      const first = path[0], end = path[path.length - 1];
      await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: first.x, y: first.y });
      await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: first.x, y: first.y, button: "left", buttons: 1, clickCount: 1 });
      try {
        await B.sleep(80);
        for (const p of path.slice(1)) {
          await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "left", buttons: 1 });
          await B.sleep(12);
        }
        await B.sleep(80);
      } finally {
        // Always let go, so a failed move never leaves the shop Chrome's button held down.
        await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", buttons: 0, clickCount: 1 }).catch(() => {});
      }
      return;
    }
    case "text":
      return B.typeKeys(s, a.text);
    case "key": {
      for (const ev of V.keyEvents(a.key)) await s.send("Input.dispatchKeyEvent", ev);
      return;
    }
    case "navigate":
      await s.send("Page.navigate", { url: a.url });
      log(`navigate ${new URL(a.url).host} by ${email}`);
      return;
    case "back":
    case "forward": {
      const h = await s.send("Page.getNavigationHistory");
      const entry = h.entries?.[h.currentIndex + (a.type === "back" ? -1 : 1)];
      if (entry) await s.send("Page.navigateToHistoryEntry", { entryId: entry.id });
      return;
    }
    case "reload":
      return s.send("Page.reload");
    case "phone":
      return setPhone(a);
  }
}

async function done(email) {
  let page = {};
  try { if (S.session) page = await B.evaluate(S.session, "({url: location.href, title: document.title})"); } catch {}
  await stopStream();
  dropSession();
  const rec = { at: new Date().toISOString(), by: email, url: page.url || null, title: page.title || null };
  try {
    fs.mkdirSync(path.dirname(DONE_FILE), { recursive: true });
    fs.writeFileSync(`${DONE_FILE}.tmp`, JSON.stringify(rec, null, 2));
    fs.renameSync(`${DONE_FILE}.tmp`, DONE_FILE);
  } catch {}
  log(`done by ${email} on ${page.url ? new URL(page.url).host : "?"}`);
}

async function state() {
  const pages = await B.listPages();
  if (!S.tabId || !pages.some((p) => p.id === S.tabId)) S.tabId = await defaultTabId();
  return {
    current: S.tabId,
    phone: S.phone,
    zoom: S.zoom,
    tabs: pages.map((p) => ({ id: p.id, url: p.url, title: p.title })),
    keys: V.KEY_NAMES,
  };
}

// ── the app's sign-in ──────────────────────────────────────────────────────
/** The paired purchase key of one device, from Supabase (service role). */
async function devicePublicKey(deviceId) {
  const base = process.env.SUPABASE_URL || supabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error("Supabase is not configured");
  const r = await fetch(`${base}/rest/v1/purchase_device_keys?device_id=eq.${encodeURIComponent(deviceId)}&select=public_key_raw&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`purchase_device_keys: HTTP ${r.status}`);
  return (await r.json())[0]?.public_key_raw || null;
}

const NOTICE = (title, text) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px -apple-system,system-ui,sans-serif;margin:2rem;color:#222;background:#fff"><h2>${title}</h2><p>${text}</p></body>`;

/** The app listener's own routes and its gate. Returns {ok, email} to go on, or null when it answered. */
async function appGate(req, res, url) {
  if (!V.isTailnetAddress(req.socket.remoteAddress)) {
    log(`refused app ${req.method} ${url.pathname}: not a Tailscale address`);
    send(res, 403, NOTICE("Turn on Tailscale", "The shop browser opens only over Tailscale. Turn Tailscale on and try again."), { "Content-Type": "text/html; charset=utf-8" });
    return null;
  }
  if (url.pathname === "/healthz") { send(res, 200, { ok: true }); return null; }
  if (req.method === "GET" && url.pathname === "/app/challenge") {
    const c = APP.challenge();
    send(res, 200, { nonce: c.nonce, expires_at_ms: c.expiresAt });
    return null;
  }
  if (req.method === "GET" && url.pathname === "/app/session") {
    const deviceId = url.searchParams.get("d") || "";
    const nonce = url.searchParams.get("n") || "";
    let publicKeyRawB64 = null;
    try {
      if (/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) publicKeyRawB64 = await devicePublicKey(deviceId);
    } catch (e) {
      log(`app sign-in: key lookup failed: ${e.message}`);
      send(res, 502, NOTICE("Can't check this device", "The device list could not be read. Try again in a minute."), { "Content-Type": "text/html; charset=utf-8" });
      return null;
    }
    const r = APP.redeem({ deviceId, nonce, signatureB64: url.searchParams.get("s") || "", publicKeyRawB64, verify: verifySignature });
    if (!r.ok) {
      log(`app sign-in refused for ${deviceId.slice(0, 12)}: ${r.reason}`);
      send(res, 403, NOTICE("Sign-in refused", r.reason === "this device is not paired for purchases"
        ? "This device isn't paired for purchase approval yet. Pair it from the app's menu, then try again."
        : "Close this screen and open the shop browser again."), { "Content-Type": "text/html; charset=utf-8" });
      return null;
    }
    log(`app sign-in by device ${deviceId.slice(0, 12)}`);
    send(res, 302, "", {
      Location: V.safeNext(url.searchParams.get("next")),
      "Set-Cookie": `${V.APP_COOKIE}=${r.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.round(V.APP_SESSION_MAX_MS / 1000)}`,
    });
    return null;
  }
  const s = APP.check(V.cookieValue(req.headers.cookie, V.APP_COOKIE));
  if (!s.ok) {
    if (url.pathname === "/") send(res, 401, NOTICE("Open it from the app", "This page opens inside the Jori app: tap the link there."), { "Content-Type": "text/html; charset=utf-8" });
    else send(res, 401, { error: "not signed in" });
    return null;
  }
  return { ok: true, email: `app:${s.deviceId.slice(0, 12)}` };
}

// ── the HTTP side ──────────────────────────────────────────────────────────
function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    ...(typeof body === "object" && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}),
    ...headers,
  });
  res.end(buf);
}

async function readJson(req) {
  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > 16_384) throw new Error("body too large"); }
  return JSON.parse(raw || "{}");
}

async function waitFrame(after) {
  if (S.seq > after && S.frame) return;
  await new Promise((resolve) => {
    const t = setTimeout(() => { S.waiters.delete(done_); resolve(); }, LONGPOLL_MS);
    const done_ = () => { clearTimeout(t); resolve(); };
    S.waiters.add(done_);
  });
}

async function handle(req, res, listener) {
  const url = new URL(req.url, "http://localhost");
  let who;
  if (listener === "app") {
    who = await appGate(req, res, url);
    if (!who) return;
  } else {
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    who = await V.authorize(req);
    if (!who.ok) {
      if (who.status !== 403 || url.pathname === "/") log(`refused ${req.method} ${url.pathname}: ${who.reason}`);
      return send(res, who.status, { error: "not allowed" });
    }
  }

  if (req.method === "GET" && url.pathname === "/") {
    // The page names the assistant by its configured name (lib/instance.cjs).
    const name = assistantName().replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
    const page = fs.readFileSync(PAGE, "utf8").replace('<html lang="en">', `<html lang="en" data-assistant="${name}">`);
    return send(res, 200, page, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    });
  }
  if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, await state());
  if (req.method === "GET" && url.pathname === "/api/frame") {
    touchViewer();
    await startStream();
    await waitFrame(Number(url.searchParams.get("after")) || 0);
    if (!S.frame) return send(res, 204, "");
    return send(res, 200, S.frame, {
      "Content-Type": "image/jpeg",
      "X-Frame-Seq": String(S.seq),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/input") {
    if (!V.sameOriginWrite(req)) return send(res, 403, { error: "not from this page" });
    let a;
    try { a = V.parseAction(await readJson(req)); } catch (e) { return send(res, 400, { error: e.message }); }
    touchViewer();
    await act(a, who.email);
    return send(res, 200, { ok: true, ...(a.type === "tab" || a.type === "phone" ? await state() : {}) });
  }
  return send(res, 404, { error: "not found" });
}

const serve = (listener) => (req, res) => {
  handle(req, res, listener).catch((e) => {
    log(`error ${listener} ${req.method} ${req.url.split("?")[0]}: ${e.message}`);
    if (/websocket|not reachable|gone|no tab/i.test(e.message)) dropSession(); // lang-regex-ok: our own and CDP's error strings, not anyone's words
    if (!res.headersSent) send(res, 502, { error: e.message });
  });
};
http.createServer(serve("web")).listen(PORT, HOST, () => log(`listening on ${HOST}:${PORT} (shop Chrome :${B.SHOP_PORT})`));
// The app listener binds every interface (Tailscale's included) and answers
// only Tailscale source addresses (appGate).
if (APP_ON) http.createServer(serve("app")).listen(APP_PORT, "::", () => log(`app listener on [::]:${APP_PORT}, Tailscale addresses only`));
