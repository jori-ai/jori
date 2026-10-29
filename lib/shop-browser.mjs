// shop-browser.mjs — CDP access to the SHOP Chrome (port 9224) for the purchase
// flow's deterministic steps: read the review page, screenshot it, type a
// credential into a field, click the approved Place Order button.
//
// The shop Chrome is its own LaunchAgent (com.jori.chrome-cdp-shop, profile
// ~/.cache/chrome-devtools-mcp/chrome-profile-shop). It is NOT the 9222
// automation profile: chrome-cdp-watch.sh reaps 9222 tabs older than a tick,
// and a cart tab must survive the minutes the user takes to approve. The agent
// navigates it with `CDP_PORT=9224 cdp.py ...`; this module finds the same
// working tab through cdp.py's per-port state file, so a request and its later
// execution act on the tab the agent left on the review page.
//
// Node 22+ (global fetch + WebSocket); no npm deps.

import fs from "node:fs";
import path from "node:path";
import { installRoot } from "./root.cjs";

export const SHOP_PORT = process.env.SHOP_CDP_PORT || "9224";
const HOST = `http://localhost:${SHOP_PORT}`;
const STATE = path.join(installRoot(), "data", `.cdp-driver-state-${SHOP_PORT}.json`);

export async function listPages() {
  const r = await fetch(`${HOST}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`shop Chrome not reachable on :${SHOP_PORT} (HTTP ${r.status})`);
  return (await r.json()).filter((t) => t.type === "page");
}

/** The tab cdp.py is driving (CDP_PORT=9224), or a specific tab id. */
export async function workingTab(tabId = null) {
  let id = tabId;
  if (!id) {
    try { id = JSON.parse(fs.readFileSync(STATE, "utf8")).tab_id; } catch {}
  }
  if (!id) throw new Error("no working shop tab — open the checkout with `CDP_PORT=9224 cdp.py open <url>` first");
  const tab = (await listPages()).find((t) => t.id === id);
  if (!tab) throw new Error(`shop tab ${id} is gone (closed or Chrome restarted)`);
  return tab;
}

class Session {
  constructor(ws) { this.ws = ws; this.n = 0; this.pending = new Map(); this.events = []; this.handlers = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result || {});
      } else if (msg.method && this.handlers.has(msg.method)) {
        try { this.handlers.get(msg.method)(msg.params || {}, msg.sessionId || null); } catch {}
      } else if (msg.method) this.events.push(msg);
    });
  }
  /** Route one CDP event (e.g. "Page.screencastFrame") to `fn(params, sessionId)` instead of buffering it. */
  on(method, fn) { this.handlers.set(method, fn); return this; }
  /** `sessionId`: a flat child session (an out-of-process frame attached with Target.setAutoAttach). */
  send(method, params = {}, timeoutMs = 20000, sessionId = null) {
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  /** A sender for one attached child session, over this same websocket. */
  child(sessionId) { return { sessionId, send: (method, params = {}, timeoutMs = 20000) => this.send(method, params, timeoutMs, sessionId) }; }
  close() { try { this.ws.close(); } catch {} }
}

export async function connect(tab) {
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("CDP websocket failed")), { once: true });
  });
  return new Session(ws);
}

export async function evaluate(s, expression) {
  const r = await s.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`page eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result?.value;
}

export async function pageState(s) {
  return evaluate(s, `({url: location.href, title: document.title, text: document.body ? document.body.innerText : ""})`);
}

/** JPEG of the current viewport (what the approval screen shows the user). */
export async function screenshotJpeg(s, { quality = 60 } = {}) {
  const r = await s.send("Page.captureScreenshot", { format: "jpeg", quality, captureBeyondViewport: false });
  return Buffer.from(r.data, "base64");
}

/** Does `selector` resolve to exactly one visible, enabled element? */
export async function describeSelector(s, selector) {
  return evaluate(s, `(() => {
    const els = document.querySelectorAll(${JSON.stringify(selector)});
    if (els.length !== 1) return {ok: false, count: els.length};
    const el = els[0], r = el.getBoundingClientRect();
    return {ok: r.width > 0 && r.height > 0 && !el.disabled, count: 1,
            tag: el.tagName, label: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 80)};
  })()`);
}

// Real input. Merchant bot sensors (Akamai, PerimeterX, reCAPTCHA v3) score a
// login by its event telemetry: a JS el.click() is isTrusted=false and
// Input.insertText fires no keydown/keyup, and Lowe's, Home Depot, Target,
// Best Buy, United, Marriott and Budget refused exactly those logins
// (2026-10-20/21). So clicks are mouse events at the element's centre and
// typing is one keyDown/keyUp per character with human-ish gaps.
const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));

async function centerOf(s, selector) {
  return evaluate(s, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({block: "center", inline: "center"});
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {x: r.left + r.width * (0.35 + Math.random() * 0.3), y: r.top + r.height * (0.35 + Math.random() * 0.3)};
  })()`);
}

export async function click(s, selector) {
  const c = await centerOf(s, selector);
  if (!c) return false;
  await sleep(jitter(120, 260));
  await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x - jitter(20, 60), y: c.y - jitter(5, 20) });
  await sleep(jitter(40, 90));
  await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
  await sleep(jitter(60, 140));
  await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await sleep(jitter(50, 110));
  await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
  return true;
}

/** One keyDown/keyUp per character, into whatever has focus. */
export async function typeKeys(s, text) {
  for (const ch of text) {
    await s.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
    await s.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    await sleep(jitter(45, 140));
  }
}

/**
 * Put `value` into the field at `selector` the way a person would: click it,
 * clear it, type it key by key. The value is never returned or logged.
 */
export async function typeInto(s, selector, value) {
  if (!(await click(s, selector))) throw new Error(`field not found or not visible: ${selector}`);
  await sleep(jitter(150, 300));
  const ok = await evaluate(s, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    if (document.activeElement !== el) el.focus();
    if ("select" in el) el.select();
    return document.activeElement === el;
  })()`);
  if (!ok) throw new Error(`field not focusable: ${selector}`);
  await s.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await typeKeys(s, value);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
