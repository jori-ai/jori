// Minimal Chrome DevTools Protocol driver: launch headless Chrome, open a URL,
// evaluate JS in the page, return the result. No dependencies — Node 22+ ships
// a global WebSocket.
//
// WHY. Some lines put their inventory in a client-side store rather than in the
// HTML, so neither a plain fetch nor `--dump-dom` can reach it. Princess is the
// case that forced this: its results page hydrates a Redux store with the whole
// catalogue (1,003 priced itineraries) while the DOM shows one page of cards.
// Its own JSON gateway needs a header we could not identify from the bundle, so
// reading the store the page already built is both simpler and less brittle
// than reverse-engineering the API auth.
//
// Chrome is shut down in a finally, and each call uses its own --user-data-dir so
// concurrent callers cannot collide on a profile lock.
//
// Shut down = CDP `Browser.close`, SIGKILL only as a fallback. On macOS every
// Chrome launch makes a ~2 GB APFS clone of its app bundle under
// $TMPDIR/../X/com.google.Chrome.code_sign_clone and removes it only on a
// graceful close; a signal (TERM or KILL) leaks it. The plain SIGKILL this used
// to do left one clone per call (bin/chrome-clone-sweep removes stragglers).
import { spawn } from "node:child_process";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function closeChrome(chrome, port) {
  if (chrome.exitCode !== null || chrome.signalCode !== null) return;
  const exited = new Promise((r) => chrome.once("exit", r));
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  } catch {}
  const done = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);
  if (!done) chrome.kill("SIGKILL");
}

export async function evaluateOnPage(url, expression, { port = 9333, settleMs = 9000, timeoutMs = 90000, preload = null } = {}) {
  const chrome = spawn(CHROME, [
    "--headless=new", "--use-mock-keychain", `--remote-debugging-port=${port}`, "--disable-gpu", "--no-sandbox",
    "--no-first-run", "--user-data-dir=/tmp/cdp-" + port, "about:blank",
  ], { stdio: "ignore" });
  try {
    // wait for the debugger
    let wsUrl = null;
    for (let i = 0; i < 60 && !wsUrl; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        wsUrl = v.webSocketDebuggerUrl;
      } catch {}
    }
    if (!wsUrl) throw new Error("chrome debugger never came up");

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params = {}, sessionId) => new Promise((res) => {
      const myId = ++id;
      pending.set(myId, res);
      ws.send(JSON.stringify({ id: myId, method, params, sessionId }));
    });

    const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
    const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    // `preload` runs before any of the page's own scripts, which is the only
    // way to wrap fetch/XHR in time to observe the app's first requests.
    if (preload) await send("Page.addScriptToEvaluateOnNewDocument", { source: preload }, sessionId);
    await send("Page.navigate", { url }, sessionId);
    await new Promise((r) => setTimeout(r, settleMs));
    const out = await send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs,
    }, sessionId);
    ws.close();
    if (out.result?.exceptionDetails) throw new Error(JSON.stringify(out.result.exceptionDetails).slice(0, 300));
    return out.result?.result?.value;
  } finally {
    await closeChrome(chrome, port);
  }
}
