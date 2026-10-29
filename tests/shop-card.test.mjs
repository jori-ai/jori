// shop-card.test.mjs — `purchase card` typing a card into a payment processor's
// cross-origin frame (lib/shop-card.mjs).
//
// Pins what keeps the card safe: it goes only into the merchant's own frames or
// a known processor frame the merchant embedded (never an ad or look-alike),
// `--add` clicks only the card form's own Add Card / Continue, and a screenshot
// covers every card field. The end-to-end part drives a throwaway headless
// Chrome (skipped when none is installed) with a fake merchant, a fake
// processor frame on another site, and a third-party decoy frame.
//
// Run: node --test tests/shop-card.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import * as C from "../lib/shop-card.mjs";
import * as B from "../lib/shop-browser.mjs";

// ── which frames qualify ───────────────────────────────────────────────────
test("processorOf: real processor hosts and their subdomains, never look-alikes", () => {
  assert.equal(C.processorOf("https://up.cybersource.com/uc/v1/assets/x"), "cybersource.com");
  assert.equal(C.processorOf("https://js.stripe.com/v3/elements-inner-card.html"), "stripe.com");
  assert.equal(C.processorOf("https://cybersource.com.evil.io/x"), null);
  assert.equal(C.processorOf("https://notstripe.com/x"), null);
  assert.equal(C.processorOf("javascript:alert(1)"), null);
  assert.equal(C.processorOf("about:blank"), null);
});

test("chainVerdict: the merchant's own frames, then one processor", () => {
  const site = "ticketweb.com";
  assert.deepEqual(C.chainVerdict(["https://www.ticketweb.com/checkout/payment"], site), { ok: true, processor: null });
  assert.deepEqual(C.chainVerdict(["https://www.ticketweb.com/checkout/payment", "https://up.cybersource.com/uc/v1/assets/a"], site),
    { ok: true, processor: "cybersource.com" });
  assert.deepEqual(C.chainVerdict(["https://www.ticketweb.com/p", "https://pay.ticketweb.com/f", "https://flex.cybersource.com/m"], site),
    { ok: true, processor: "cybersource.com" });
  // about:blank shares its maker's origin.
  assert.equal(C.chainVerdict(["https://www.ticketweb.com/p", "about:blank", "https://js.stripe.com/x"], site).ok, true);
});

test("chainVerdict: refuses an ad, a look-alike, a processor nested in an ad, and a wrong tab", () => {
  const site = "ticketweb.com";
  const ad = C.chainVerdict(["https://www.ticketweb.com/p", "https://ads.doubleclick.net/frame"], site);
  assert.equal(ad.ok, false);
  assert.match(ad.reason, /ads\.doubleclick\.net/);
  assert.equal(C.chainVerdict(["https://www.ticketweb.com/p", "https://ads.example/f", "https://js.stripe.com/x"], site).ok, false);
  assert.equal(C.chainVerdict(["https://www.ticketweb.com/p", "https://cybersource.com.evil.io/x"], site).ok, false);
  assert.equal(C.chainVerdict(["https://www.ticketweb.com.evil.io/p", "https://up.cybersource.com/x"], site).ok, false);
  // Inside a processor frame, only that processor.
  assert.equal(C.chainVerdict(["https://www.ticketweb.com/p", "https://up.cybersource.com/x", "https://js.stripe.com/y"], site).ok, false);
  assert.equal(C.chainVerdict(["https://www.ticketweb.com/p", "https://up.cybersource.com/x", "https://www.ticketweb.com/z"], site).ok, false);
});

test("CONFIRM_LABELS / OPEN_LABELS: the card form's own buttons, never a payment button", () => {
  for (const l of ["add card", "continue", "use this card"]) assert.ok(C.CONFIRM_LABELS.includes(l));
  for (const l of ["pay", "place order", "buy now", "complete purchase", "submit order", "pay $131.40", "confirm", "checkout"]) {
    assert.ok(!C.CONFIRM_LABELS.includes(l), l);
    assert.ok(!C.OPEN_LABELS.includes(l), l);
  }
  assert.ok(C.OPEN_LABELS.includes("card payment"));
  assert.ok(C.OPEN_LABELS.every((l) => !l.startsWith("pay")));
});

// ── values ─────────────────────────────────────────────────────────────────
test("parseExpiry: 1Password's YYYYMM and the other shapes", () => {
  assert.deepEqual(C.parseExpiry("202903"), { month: 3, year: 2029, mmyy: "0329" });
  assert.deepEqual(C.parseExpiry("03/2029"), { month: 3, year: 2029, mmyy: "0329" });
  assert.deepEqual(C.parseExpiry("11/28"), { month: 11, year: 2028, mmyy: "1128" });
  assert.equal(C.parseExpiry("202913"), null);
  assert.equal(C.parseExpiry(""), null);
});

test("pickOption: months and years by number, states by value or text", () => {
  const months = [{ value: "", text: "Month" }, ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1).padStart(2, "0"), text: String(i + 1).padStart(2, "0") }))];
  assert.equal(C.pickOption(months, "expMonth", 3), 3);
  const named = [{ value: "", text: "Month" }, ...["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((m) => ({ value: m, text: m }))];
  assert.equal(C.pickOption(named, "expMonth", 3), 3);
  const years = [{ value: "", text: "Year" }, { value: "2028", text: "2028" }, { value: "2029", text: "2029" }];
  assert.equal(C.pickOption(years, "expYear", 2029), 2);
  assert.equal(C.pickOption([{ value: "28", text: "28" }, { value: "29", text: "29" }], "expYear", 2029), 1);
  assert.equal(C.pickOption(years, "expYear", 2031), -1);
  assert.equal(C.pickOption([{ value: "TX", text: "Texas" }, { value: "WA", text: "Washington" }], "state", "WA"), 1);
  assert.equal(C.pickOption([{ value: "x1", text: "Texas" }, { value: "x2", text: "Washington" }], "state", "washington"), 1);
});

test("nameParts: explicit first/last, else the last word is the family name", () => {
  assert.deepEqual(C.nameParts({ name: "Ada Lovelace" }), { given: "Ada", family: "Lovelace" });
  assert.deepEqual(C.nameParts({ name: "Mary Ann Evans" }), { given: "Mary Ann", family: "Evans" });
  assert.deepEqual(C.nameParts({ name: "X", first_name: "A", last_name: "B" }), { given: "A", family: "B" });
  assert.deepEqual(C.nameParts(null), { given: "", family: "" });
});

// ── end to end, in a throwaway Chrome ──────────────────────────────────────
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MERCHANT = (procPort) => `<!doctype html><html><body style="margin:0;font:14px sans-serif">
<div style="height:1400px;padding:20px">Checkout
  <button id="place" onclick="window.placed=true">Place order</button>
  <iframe id="ad" src="http://ads.thirdparty.test:${procPort}/ad" style="width:300px;height:120px;border:0"></iframe>
</div>
<iframe id="card" src="http://pay.processor.test:${procPort}/card" style="width:640px;height:420px;border:2px solid #999;padding:5px"></iframe>
<div style="height:1200px"></div>
</body></html>`;

const PROCESSOR = `<!doctype html><html><body style="margin:0;font:14px sans-serif">
<button type="button" id="open" onclick="document.getElementById('f').style.display='block';this.remove()">Card payment</button>
<form id="f" onsubmit="return false" style="display:none">
  <label>Card number <input id="card-number" name="paymentInformation.card.number" autocomplete="cc-number"></label><br>
  <select id="card-expiry-month" autocomplete="cc-exp-month" aria-label="Expiry month"><option value="">Month</option>
    ${Array.from({ length: 12 }, (_, i) => `<option value="${String(i + 1).padStart(2, "0")}">${String(i + 1).padStart(2, "0")}</option>`).join("")}</select>
  <select id="card-expiry-year" autocomplete="cc-exp-year"><option value="">Year</option>
    ${Array.from({ length: 12 }, (_, i) => `<option value="${2026 + i}">${2026 + i}</option>`).join("")}</select>
  <input id="card-security-code" autocomplete="cc-csc"><br>
  <input id="billing-first-name" autocomplete="billing given-name">
  <input id="billing-last-name" autocomplete="billing family-name"><br>
  <button type="button" onclick="window.paid=true">Pay</button>
  <button type="button" id="cont" onclick="window.continued=true">Continue</button>
</form>
<script>
  window.trusted = 0; window.clicks = 0;
  document.addEventListener("keydown", (e) => { if (e.isTrusted && e.keyCode) window.trusted++; }, true);
  document.addEventListener("mousedown", (e) => { if (e.isTrusted) window.clicks++; }, true);
  // A field that drops anything but digits by keyCode, like real card forms.
  document.getElementById("card-number").addEventListener("keydown", (e) => {
    if (e.key.length === 1 && (e.keyCode < 48 || e.keyCode > 57)) e.preventDefault();
  });
</script>
</body></html>`;

const DECOY = `<!doctype html><html><body><input id="steal" autocomplete="cc-number" style="width:250px"></body></html>`;

async function startChrome() {
  if (!fs.existsSync(CHROME)) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shop-card-test-"));
  const proc = spawn(CHROME, ["--headless=new", "--use-mock-keychain", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--site-per-process", "--window-size=1200,900",
    "--host-resolver-rules=MAP merchant.test 127.0.0.1, MAP pay.processor.test 127.0.0.1, MAP ads.thirdparty.test 127.0.0.1",
    "about:blank"], { stdio: "ignore" });
  const portFile = path.join(dir, "DevToolsActivePort");
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await B.sleep(100);
  if (!fs.existsSync(portFile)) { proc.kill("SIGKILL"); return null; }
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
  return { port, proc, dir, stop: () => { proc.kill("SIGKILL"); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function serve(handler) {
  return new Promise((res) => { const srv = http.createServer(handler); srv.listen(0, "127.0.0.1", () => res(srv)); });
}

async function openTab(port, url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  for (let i = 0; i < 50; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    if (list.filter((x) => x.type === "iframe").length >= 2) break;
    await B.sleep(100);
  }
  await B.sleep(300);
  return t;
}

// Read what a frame now holds (the test's own dummy values, so reading them is fine).
async function frameEval(port, hostPart, expression) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const f = list.find((x) => x.type === "iframe" && x.url.includes(hostPart));
  const s = await B.connect(f);
  try { return (await s.send("Runtime.evaluate", { expression, returnByValue: true })).result.value; } finally { s.close(); }
}

test("end to end: fills a processor's cross-origin frame with real keys, clicks its Continue, never the decoy or Pay", async (t) => {
  const chrome = await startChrome();
  if (!chrome) return t.skip("no Chrome to drive");
  const proc = await serve((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(req.url.startsWith("/ad") ? DECOY : PROCESSOR);
  });
  const procPort = proc.address().port;
  const merchant = await serve((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(req.url.startsWith("/inner") ? `<input id="innercard" autocomplete="cc-number" style="width:200px">` : MERCHANT(procPort));
  });
  t.after(() => { chrome.stop(); proc.close(); merchant.close(); });

  const tab = await openTab(chrome.port, `http://merchant.test:${merchant.address().port}/checkout`);
  const values = { number: "4111111111111111", expMonth: 3, expYear: 2029, cvv: "737", given: "Ada", family: "Lovelace" };
  const asked = [];
  const value = (kind) => { asked.push(kind); return values[kind] ?? null; };

  // The form opens from the processor's own button inside its frame, and only
  // from a processor on the list.
  let s = await B.connect(tab);
  assert.deepEqual(await C.openCardForm(s, { site: "merchant.test", processors: ["stripe.com"] }), { opened: false, button: null, already: false });
  s.close();
  s = await B.connect(tab);
  assert.deepEqual(await C.openCardForm(s, { site: "merchant.test", processors: ["processor.test"] }), { opened: true, button: "card payment", already: false });
  s.close();
  await B.sleep(500);
  s = await B.connect(tab);
  assert.equal((await C.openCardForm(s, { site: "merchant.test", processors: ["processor.test"] })).already, true);
  s.close();

  // A processor not on the list is refused, and nothing is typed.
  s = await B.connect(tab);
  await assert.rejects(C.fillCard(s, { site: "merchant.test", value, processors: ["stripe.com"] }), (e) => e instanceof C.Refusal && e.message.includes("pay.processor.test"));
  s.close();
  assert.deepEqual(asked, []);
  // The wrong site is refused.
  s = await B.connect(tab);
  await assert.rejects(C.fillCard(s, { site: "other.test", value, processors: ["processor.test"] }), C.Refusal);
  s.close();

  s = await B.connect(tab);
  const r = await C.fillCard(s, { site: "merchant.test", value, add: true, processors: ["processor.test"] });
  s.close();
  assert.deepEqual(r.filled.sort(), ["cvv", "expMonth", "expYear", "family", "given", "number"]);
  assert.deepEqual([r.missing, r.skipped, r.unconfirmed, r.invalid], [[], [], [], []]);
  assert.equal(r.processor, "processor.test");
  assert.equal(r.frame, "pay.processor.test");
  assert.equal(r.added, true);
  assert.equal(r.button, "continue");
  assert.equal(JSON.stringify(r).includes("4111"), false, "the result never carries a value");

  await B.sleep(300);
  const inFrame = await frameEval(chrome.port, "pay.processor.test", `({
    number: document.getElementById("card-number").value, month: document.getElementById("card-expiry-month").value,
    year: document.getElementById("card-expiry-year").value, cvv: document.getElementById("card-security-code").value,
    first: document.getElementById("billing-first-name").value, last: document.getElementById("billing-last-name").value,
    continued: !!window.continued, paid: !!window.paid, trusted: window.trusted, clicks: window.clicks })`);
  // Real clicks into the fields (number, code, two names) and on Continue, not the focus() fallback.
  assert.deepEqual({ ...inFrame, trusted: inFrame.trusted > 20, clicks: inFrame.clicks >= 5 },
    { number: "4111111111111111", month: "03", year: "2029", cvv: "737", first: "Ada", last: "Lovelace", continued: true, paid: false, trusted: true, clicks: true });
  assert.equal(await frameEval(chrome.port, "ads.thirdparty.test", `document.getElementById("steal").value`), "");
  const topS = await B.connect(tab);
  assert.equal(await B.evaluate(topS, "!!window.placed"), false);
  topS.close();

  // The screenshot covers every cross-origin frame whole, and card fields in the
  // page, in a same-origin frame and in a modal dialog (the top layer) one by one.
  const prep = await B.connect(tab);
  await B.evaluate(prep, `(() => {
    document.body.insertAdjacentHTML("afterbegin", '<iframe id="same" src="/inner" style="width:320px;height:60px;border:0"></iframe>'
      + '<dialog id="dlg"><input id="dlgcard" autocomplete="cc-number" style="width:220px"></dialog>');
    return true;
  })()`);
  await B.sleep(600);
  await B.evaluate(prep, `document.getElementById("dlg").showModal(), window.scrollTo(0, 1300), true`);
  prep.close();
  await B.sleep(300);
  s = await B.connect(tab);
  let seen = null;
  const shot = await C.maskedScreenshot(s, { format: "png", processors: ["processor.test"], onMasked: async () => {
    const t2 = await B.connect(tab);
    seen = await B.evaluate(t2, `(() => {
      const m = [...document.querySelectorAll("[data-jori-mask]")].map((d) => ({ r: d.getBoundingClientRect(), t: d.textContent }));
      const over = (el, off = { left: 0, top: 0 }) => { const f = el.getBoundingClientRect();
        return m.some(({ r }) => r.left <= off.left + f.left && r.top <= off.top + f.top && r.right >= off.left + f.right && r.bottom >= off.top + f.bottom); };
      const same = document.getElementById("same");
      return {
        processorFrame: over(document.getElementById("card")), adFrame: over(document.getElementById("ad")),
        dialogField: over(document.getElementById("dlgcard")),
        sameOriginField: over(same.contentDocument.getElementById("innercard"), same.getBoundingClientRect()),
        // A same-origin frame is searched, not covered whole (covers are 8px larger than what they hide).
        sameOriginFrameWhole: m.some(({ r }) => { const f = same.getBoundingClientRect(); return Math.abs(r.width - f.width - 8) < 2 && Math.abs(r.height - f.height - 8) < 2; }),
        labels: [...new Set(m.map((x) => x.t))].sort(),
      };
    })()`);
    t2.close();
  } });
  s.close();
  assert.ok(shot.data.length > 1000 && shot.masked >= 3);
  assert.deepEqual(seen, { processorFrame: true, adFrame: true, dialogField: true, sameOriginField: true, sameOriginFrameWhole: false, labels: ["card hidden", "hidden"] });
  const after = await B.connect(tab);
  assert.equal(await B.evaluate(after, `document.querySelectorAll("[data-jori-mask]").length`), 0);
  after.close();

  // A connection is mapped once: a second map would miss the frames.
  s = await B.connect(tab);
  await C.frameMap(s);
  await assert.rejects(C.frameMap(s), (e) => e.message.includes("fresh connection"));
  s.close();
});
