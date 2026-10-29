// cdp.mjs — minimal Chrome DevTools Protocol driver in Node.
//
// WHY NOT bin/cdp.py: that one imports `websocket-client`, which is not
// installed on the host (it fails at import). Node 22+ ships a global WebSocket,
// so this needs no dependency at all — matching how every other client here
// avoids an SDK.
//
// Drives the Chrome already running with --remote-debugging-port=9222. That
// matters: it is a real browser profile on a residential connection, which is
// why pages that refuse datacenter scrapers load normally.

const CDP_HOST = process.env.CDP_HOST || "127.0.0.1:9222";

/** Open a CDP session against a page target, creating a tab if none exists. */
export async function connect({ timeoutMs = 10000 } = {}) {
  const list = await (await fetch(`http://${CDP_HOST}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  let tab = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!tab) {
    const res = await fetch(`http://${CDP_HOST}/json/new?about:blank`, { method: "PUT" });
    tab = await res.json();
  }
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP connect timed out")), timeoutMs);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`CDP socket error: ${e && e.message ? e.message : "unknown"}`)); };
  });

  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { resolve, reject } = pending.get(d.id);
      pending.delete(d.id);
      d.error ? reject(new Error(`${d.error.message}`)) : resolve(d.result);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => {
        if (pending.has(i)) { pending.delete(i); reject(new Error(`CDP ${method} timed out`)); }
      }, 30000);
    });

  return {
    send,
    close: () => { try { ws.close(); } catch { /* already gone */ } },

    /** Navigate and wait a fixed settle period — these pages hydrate client-side. */
    async goto(url, { settleMs = 9000 } = {}) {
      await send("Page.enable");
      await send("Page.navigate", { url });
      await new Promise((r) => setTimeout(r, settleMs));
    },

    /** Evaluate an expression in the page and return its value. */
    async evaluate(expression) {
      const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || "page evaluation threw");
      return out.result && out.result.value;
    },
  };
}
