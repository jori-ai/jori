// cdp-tab.mjs — a CDP session on a tab of OUR OWN in the 9222 automation
// Chrome, closed when the job is done.
//
// Why not cdp.mjs `connect()`: that grabs the first page target, which on the
// host is often a tab something else is using (a mail or shopping session) — a
// navigate there yanks it. A job that holds a page for minutes needs its own.
//
// Keep a tab's life under ~12 min: chrome-cdp-watch.sh reaps 9222 page tabs
// seen on two consecutive 15-minute ticks.
//
// The returned session has `send(method, params)`, which is all
// lib/shop-browser.mjs's real-input helpers (typeKeys, …) need.

const CDP = process.env.CDP_HOST || "127.0.0.1:9222";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));

export async function openTab() {
  const t = await (await fetch(`http://${CDP}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(5000) })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("CDP socket error")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { resolve, reject } = pending.get(d.id);
      pending.delete(d.id);
      d.error ? reject(new Error(d.error.message)) : resolve(d.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error(`CDP ${method} timed out`)); } }, 30000);
  });
  const evaluate = async (expression) => {
    const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || "page evaluation threw");
    return out.result && out.result.value;
  };
  const close = async () => {
    try { ws.close(); } catch { /* gone */ }
    try { await fetch(`http://${CDP}/json/close/${t.id}`, { method: "PUT" }); } catch { /* gone */ }
  };
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 900, deviceScaleFactor: 1, mobile: false });
  return { send, evaluate, close };
}

/** Navigate and wait a fixed settle period — these pages hydrate client-side. */
export async function goto(tab, url, settleMs = 9000) {
  await tab.send("Page.navigate", { url });
  await sleep(settleMs);
}

/**
 * A real mouse click (move, press, release — isTrusted events) at the centre of
 * whatever `finder` returns. `finder` is page-side JS evaluating to an element
 * or null, so callers can reach into shadow roots. Synthetic `.click()` is
 * ignored by Angular pages and scored as a bot by login sensors.
 */
export async function clickElement(tab, finder) {
  const pos = await tab.evaluate(`(() => { const el = (${finder}); if (!el) return null;
    el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.x + r.width * (0.35 + Math.random() * 0.3), y: r.y + r.height * (0.35 + Math.random() * 0.3) }; })()`);
  if (!pos) return false;
  await sleep(jitter(150, 300));
  await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x - jitter(20, 60), y: pos.y - jitter(5, 20) });
  await sleep(jitter(40, 90));
  await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
  await sleep(jitter(60, 140));
  await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await sleep(jitter(50, 110));
  await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  return true;
}

/** Page-side JS: first element matching `selector` anywhere, shadow roots included. */
export function deepFind(selector) {
  return `(() => { const sel = ${JSON.stringify(selector)};
    const walk = (root) => { const hit = root.querySelector(sel); if (hit) return hit;
      for (const e of root.querySelectorAll("*")) if (e.shadowRoot) { const h = walk(e.shadowRoot); if (h) return h; }
      return null; };
    return walk(document); })()`;
}
