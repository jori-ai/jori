// shop-card.mjs — type a payment card into the merchant's card form in the shop
// Chrome (CDP :9224), including a payment processor's cross-origin frame
// (Cybersource, Stripe, Braintree, Adyen, ...), and take screenshots with every
// card field hidden. Used by `purchase card`, `purchase shot` and `purchase
// request` (bin/purchase); playbook agent/ops-agent/jobs/purchase.md.
//
// No LLM anywhere. Values come from the caller (card-pass, the billing file) and
// leave only as key events and select changes. Nothing here returns, prints or
// logs a value: only which fields were filled, and whether each took the right
// number of characters.
//
// Which frames a card may go into: the tab is on <site>, and every frame from
// the top down to the field is either <site>'s own or, below those, a frame of
// ONE known payment processor (PAYMENT_FRAME_DOMAINS). That is the merchant's
// own form, or the processor frame the merchant itself embedded; never an ad, a
// chat widget or any other third-party frame. Adding a processor is a code change.
//
// How it types: real mouse and key events dispatched on the page (CDP Input) at
// the field's position in the top viewport. Chrome routes them into an
// out-of-process frame as it would a person's. Before any key is sent it checks
// that the click point lands on the field through every frame, and that focus
// sits on the field all the way down (each frame's activeElement), so an
// overlay or a focus change cannot catch the keys.

import { hostMatchesSite } from "./purchase-approval.mjs";
import { sleep } from "./shop-browser.mjs";

// Hosted card-field providers. A frame qualifies when its host is one of these
// or a subdomain (up.cybersource.com, js.stripe.com); look-alikes do not.
export const PAYMENT_FRAME_DOMAINS = [
  "cybersource.com",       // Visa Cybersource: Unified Checkout (up.), Flex Microform (flex.)
  "stripe.com",            // Stripe Elements (js.stripe.com)
  "braintreegateway.com",  // Braintree Hosted Fields
  "adyen.com",             // Adyen secured fields (checkoutshopper-live.adyen.com)
  "checkout.com",          // Checkout.com Frames
  "squarecdn.com",         // Square Web Payments SDK
  "squareup.com",
  "spreedly.com",          // Spreedly iFrame
  "authorize.net",         // Authorize.net Accept Hosted
  "paypal.com",            // PayPal / Braintree card fields
  "shopifyinc.com",        // Shopify checkout card fields (checkout.pci.shopifyinc.com)
  "shopifycs.com",
  "tokenex.com",           // TokenEx
  "recurly.com",           // Recurly Elements
  "bluesnap.com",          // BlueSnap Hosted Payment Fields
  "worldpay.com",
  "clover.com",
  "moneris.com",
  "chasepaymentech.com",
];

// The card form's own submit, which `--add` may click: it saves or hands the
// card back to the merchant page. Exact labels only, so Pay / Place order / Buy
// / Complete purchase never match.
export const CONFIRM_LABELS = ["add card", "add this card", "save card", "save this card", "use card", "use this card", "continue"];

// A processor's own "show the card form" control (Cybersource Unified Checkout's
// "Card payment", a "Card" tab). Clicked only inside a processor frame, and only
// while no card-number field is showing. Nothing here starts with "pay".
export const OPEN_LABELS = ["card payment", "card", "credit card", "debit card", "credit/debit card", "credit / debit card"];

// Field kinds: [kind, autocomplete field names, normalized name/id].
// Autocomplete first (the standard; its last token, e.g. "billing given-name"),
// then the names forms use (Ticketmaster's payments-cc frame, Cybersource UC).
export const CARD_FIELDS = [
  ["name",     ["cc-name"],                        ["nameoncard", "cardholder", "ccname", "cardname", "cardholdername"]],
  ["given",    ["cc-given-name", "given-name"],    ["billingfirstname"]],
  ["family",   ["cc-family-name", "family-name"],  ["billinglastname"]],
  ["number",   ["cc-number"],                      ["cardnumber", "ccnumber"]],
  ["expiry",   ["cc-exp"],                         ["expirationdate", "expiry", "ccexp", "expdate"]],
  ["expMonth", ["cc-exp-month"],                   ["expirationmonth", "expmonth", "expirymonth", "cardexpirymonth", "ccexpmonth"]],
  ["expYear",  ["cc-exp-year"],                    ["expirationyear", "expyear", "expiryyear", "cardexpiryyear", "ccexpyear"]],
  ["cvv",      ["cc-csc"],                         ["securitycode", "cvv", "cvc", "csc", "cardsecuritycode"]],
  ["address",  ["address-line1"],                  ["address", "address1", "street"]],
  ["city",     ["address-level2"],                 ["city"]],
  ["postal",   ["postal-code"],                    ["postalcode", "zip", "zipcode"]],
  ["state",    ["address-level1"],                 ["statecode", "state", "region"]],
  ["phone",    ["tel", "tel-national"],            ["phone", "phonenumber"]],
];
// The card itself. A frame holding one of these is part of the card form, and
// these are what a screenshot hides.
export const SECRET = new Set(["number", "expiry", "expMonth", "expYear", "cvv"]);

export class Refusal extends Error {}

/** The processor a frame URL belongs to, or null. */
export function processorOf(url, list = PAYMENT_FRAME_DOMAINS) {
  let h;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    h = u.hostname.toLowerCase().replace(/\.$/, "");
  } catch { return null; }
  return list.find((d) => h === d || h.endsWith("." + d)) || null;
}

/**
 * May a card go into the last frame of this chain (frame URLs, top first)?
 * The top is <site>; below it <site>'s own frames, then at most one processor.
 * about:blank / about:srcdoc frames share the origin of the frame that made them.
 */
export function chainVerdict(urls, site, processors = PAYMENT_FRAME_DOMAINS) {
  if (!urls.length || !hostMatchesSite(urls[0], site)) return { ok: false, reason: `the tab is not on ${site}` };
  let processor = null;
  for (const url of urls.slice(1)) {
    if (url === "about:blank" || url === "about:srcdoc") continue;
    if (!processor && hostMatchesSite(url, site)) continue;
    const p = processorOf(url, processors);
    let host = String(url).slice(0, 60);
    try { host = new URL(url).hostname; } catch {}
    if (!p) return { ok: false, reason: `the card form is in a frame from ${host}, which is neither ${site} nor a known payment processor` };
    if (processor && p !== processor) return { ok: false, reason: `a frame from ${host} sits inside ${processor}'s frame` };
    processor = p;
  }
  return { ok: true, processor };
}

/** 1Password keeps expiry as YYYYMM; forms want MM + YY, or a month and a year. */
export function parseExpiry(v) {
  const d = String(v || "").replace(/[^0-9]/g, "");
  let m, y;
  if (d.length === 6 && d.startsWith("20")) { y = Number(d.slice(0, 4)); m = Number(d.slice(4)); } // YYYYMM
  else if (d.length === 6) { m = Number(d.slice(0, 2)); y = Number(d.slice(2)); }                   // MMYYYY
  else if (d.length === 4) { m = Number(d.slice(0, 2)); y = 2000 + Number(d.slice(2)); }            // MMYY
  else return null;
  if (!(m >= 1 && m <= 12) || y < 2000) return null;
  return { month: m, year: y, mmyy: String(m).padStart(2, "0") + String(y % 100).padStart(2, "0") };
}

/** First/last name for a form that splits them: billing.first_name/last_name, else billing.name. */
export function nameParts(billing) {
  if (billing?.first_name || billing?.last_name) return { given: billing.first_name || "", family: billing.last_name || "" };
  const parts = String(billing?.name || "").trim().split(" ").filter(Boolean);
  if (parts.length < 2) return { given: parts[0] || "", family: "" };
  return { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1] };
}

/**
 * Which option of a <select> to choose. Months and years compare as numbers
 * ("03", "3", "03 - Mar"; "2029", "29"); anything else (a state) by exact value
 * or text. Self-contained: it is also sent into the page as source.
 */
export function pickOption(options, kind, want) {
  const real = options.map((o, i) => ({ value: String(o.value ?? ""), text: String(o.text ?? ""), i }))
    .filter((o) => o.value.trim() !== "");
  const num = (s) => { const d = String(s).replace(/[^0-9]/g, ""); return d ? Number(d) : NaN; };
  if (kind === "expMonth" || kind === "expYear") {
    const n = Number(want);
    const eq = (v) => (kind === "expYear" ? v === n || v === n % 100 : v === n);
    let hit = real.find((o) => eq(num(o.value))) || real.find((o) => eq(num(o.text)));
    if (!hit && kind === "expMonth" && real.length === 12) hit = real[n - 1];
    return hit ? hit.i : -1;
  }
  const w = String(want).trim().toLowerCase();
  const hit = real.find((o) => o.value.trim().toLowerCase() === w) || real.find((o) => o.text.trim().toLowerCase() === w);
  return hit ? hit.i : -1;
}

// ── frames ────────────────────────────────────────────────────────────────

/**
 * Every frame in the tab, across processes. Out-of-process frames come through
 * flat auto-attach (never paused: waitForDebuggerOnStart false). Returns
 * { frames: Map(id → {id, url, parentId, sess}), topId }.
 */
export async function frameMap(s) {
  // Auto-attach reports the frames already there only the first time it is
  // switched on, so a second map on one connection would miss them.
  if (s.__joriFrames) throw new Error("frameMap needs a fresh connection to the tab");
  s.__joriFrames = true;
  const kids = [];
  s.on("Target.attachedToTarget", (p) => { if (p.targetInfo?.type === "iframe") kids.push(p); });
  const auto = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };
  await s.send("Target.setAutoAttach", auto);
  // Existing frames attach right after the call; frames inside them once each
  // child is asked too. Stop once a round brings nothing new.
  const asked = new Set();
  for (let quiet = 0, round = 0; quiet < 2 && round < 20; round++) {
    const fresh = kids.filter((k) => !asked.has(k.sessionId));
    for (const k of fresh) { asked.add(k.sessionId); s.child(k.sessionId).send("Target.setAutoAttach", auto).catch(() => {}); }
    quiet = fresh.length ? 0 : quiet + 1;
    await sleep(150);
  }
  const frames = new Map();
  const add = (tree, sess) => {
    (function walk(t) {
      frames.set(t.frame.id, { id: t.frame.id, url: t.frame.url + (t.frame.urlFragment || ""), parentId: t.frame.parentId || null, sess });
      (t.childFrames || []).forEach(walk);
    })(tree);
  };
  const { frameTree } = await s.send("Page.getFrameTree");
  add(frameTree, s);
  for (const k of kids) {
    const c = s.child(k.sessionId);
    try { add((await c.send("Page.getFrameTree", {}, 5000)).frameTree, c); } catch {} // gone since
  }
  return { frames, topId: frameTree.frame.id };
}

/** The frames from the top down to `id`. */
export function chainOf(frames, id) {
  const out = [];
  for (let f = frames.get(id), n = 0; f && n < 50; f = f.parentId ? frames.get(f.parentId) : null, n++) out.unshift(f);
  return out;
}

async function world(f) {
  if (!f.ctx) f.ctx = (await f.sess.send("Page.createIsolatedWorld", { frameId: f.id, worldName: "jori-card" }, 5000)).executionContextId;
  return f.ctx;
}

// Expressions sent here carry no card value (values go through callOn's
// arguments or key events), so an error message cannot echo one.
async function evalIn(f, expression, { awaitPromise = false } = {}) {
  const r = await f.sess.send("Runtime.evaluate", { expression, contextId: await world(f), returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(`frame script failed: ${String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split("\n")[0]}`);
  return r.result?.value;
}

async function objectIn(f, expression) {
  const r = await f.sess.send("Runtime.evaluate", { expression, contextId: await world(f), returnByValue: false });
  return r.result?.objectId || null;
}

async function callOn(sess, objectId, fn, args = []) {
  const r = await sess.send("Runtime.callFunctionOn", { objectId, functionDeclaration: String(fn), arguments: args.map((value) => ({ value })), returnByValue: true });
  if (r.exceptionDetails) throw new Error(`frame script failed: ${String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split("\n")[0]}`);
  return r.result?.value;
}

// The <iframe> element holding `f`, in its parent frame's isolated world.
async function ownerOf(frames, f) {
  const parent = frames.get(f.parentId);
  const { backendNodeId } = await parent.sess.send("DOM.getFrameOwner", { frameId: f.id });
  const { object } = await parent.sess.send("DOM.resolveNode", { backendNodeId, executionContextId: await world(parent) });
  return { parent, backendNodeId, objectId: object.objectId };
}

// Where the frame's content starts inside its <iframe> (border + padding), and its size.
function ownerBox() {
  const r = this.getBoundingClientRect(), cs = getComputedStyle(this);
  const bx = this.clientLeft + (parseFloat(cs.paddingLeft) || 0), by = this.clientTop + (parseFloat(cs.paddingTop) || 0);
  return { x: r.left + bx, y: r.top + by, bx, by, w: this.clientWidth, h: this.clientHeight };
}

/**
 * The content origin of every frame in the chain, in top-viewport pixels, and
 * the <iframe> elements between them. null when a frame on the way is hidden.
 */
async function geometry(frames, chain) {
  const origins = [{ x: 0, y: 0 }], owners = [];
  let x = 0, y = 0;
  for (const f of chain.slice(1)) {
    const own = await ownerOf(frames, f);
    const b = await callOn(own.parent.sess, own.objectId, ownerBox);
    if (!b || b.w <= 0 || b.h <= 0) return null;
    x += b.x; y += b.y;
    origins.push({ x, y, w: b.w, h: b.h });
    owners.push({ ...own, bx: b.bx, by: b.by });
  }
  return { origins, owners };
}

// ── fields ────────────────────────────────────────────────────────────────

// Runs in a frame's isolated world: finds each field kind, keeps the elements
// in that world's own global (invisible to the page) and returns their tags.
const FIND = `(() => {
  const spec = ${JSON.stringify(CARD_FIELDS)};
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const tokens = (e) => String(e.getAttribute("autocomplete") || "").toLowerCase().split(" ").filter(Boolean);
  const shown = (e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden"; };
  const els = [...document.querySelectorAll("input, select")].filter((e) =>
    !["hidden", "checkbox", "radio", "submit", "button", "image", "file", "reset"].includes(e.type)
    && !e.disabled && !e.readOnly && shown(e) && !tokens(e).includes("shipping"));
  const found = {}, out = {};
  for (const [kind, acs, names] of spec) {
    const pool = els.filter((e) => !Object.values(found).includes(e));
    const el = pool.find((e) => acs.includes(tokens(e).slice(-1)[0]))
      || pool.find((e) => names.includes(norm(e.name)) || names.includes(norm(e.id).replace(/input$/, "")));
    if (!el) continue;
    found[kind] = el;
    out[kind] = { tag: el.tagName.toLowerCase() };
  }
  globalThis.__joriCard = found;
  return out;
})()`;

const ref = (kind) => `globalThis.__joriCard[${JSON.stringify(kind)}]`;

const RECT = (kind) => `(() => { const r = ${ref(kind)}.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`;

// After typing: how much the field holds (lengths only, never the value).
const CHECK = (kind) => `(() => {
  const el = ${ref(kind)}, v = String(el.value || "");
  return { len: v.length, digits: v.replace(/[^0-9]/g, "").length, invalid: el.getAttribute("aria-invalid") === "true" };
})()`;

const SET_SELECT = `function (kind, want) {
  const pick = ${pickOption.toString()};
  const i = pick([...this.options].map((o) => ({ value: o.value, text: o.text })), kind, want);
  if (i < 0) return false;
  this.focus();
  this.selectedIndex = i;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  this.blur();
  return this.selectedIndex === i;
}`;

// ── input ─────────────────────────────────────────────────────────────────

const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));

function keyOf(ch) {
  if (ch >= "0" && ch <= "9") return { code: "Digit" + ch, vk: 48 + Number(ch) };
  const up = ch.toUpperCase();
  if (up >= "A" && up <= "Z" && up !== ch.toLowerCase()) return { code: "Key" + up, vk: up.charCodeAt(0) };
  if (ch === " ") return { code: "Space", vk: 32 };
  return { code: "", vk: 0 };
}

/**
 * One keyDown/keyUp per character, with the key and virtual key codes pages
 * filter on. `guard()` runs before every key; false stops the typing.
 */
async function typeText(s, text, guard = null) {
  for (const ch of String(text)) {
    if (guard && !(await guard())) return false;
    const k = keyOf(ch);
    await s.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code: k.code, windowsVirtualKeyCode: k.vk, text: ch, unmodifiedText: ch });
    await s.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: k.code, windowsVirtualKeyCode: k.vk });
    await sleep(jitter(45, 140));
  }
  return true;
}

async function pressKey(s, key, code, vk) {
  await s.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk });
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
}

async function clickAt(s, x, y) {
  await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x - jitter(15, 40), y: y - jitter(4, 12) });
  await sleep(jitter(40, 90));
  await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(jitter(60, 140));
  await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(jitter(50, 110));
  await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

/**
 * Bring the element at `refExpr` (in the chain's last frame) into view, and
 * return the top-viewport point to click, or null when the click would not
 * land on it (off screen, covered, or a zoomed view).
 */
async function aim(s, frames, chain, refExpr, top) {
  const last = chain[chain.length - 1];
  await evalIn(last, `${refExpr}.scrollIntoView({ block: "center", inline: "nearest" })`);
  // Scroll each frame above so the element is in view there too, innermost first.
  for (let i = chain.length - 2; i >= 0; i--) {
    const g = await geometry(frames, chain);
    if (!g) return null;
    const r = await evalIn(last, `(() => { const r = ${refExpr}.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const own = g.owners[i], below = g.origins[i + 1], end = g.origins[g.origins.length - 1];
    const rect = { x: own.bx + end.x - below.x + r.x, y: own.by + end.y - below.y + r.y, width: Math.max(1, r.w), height: Math.max(1, r.h) };
    try { await own.parent.sess.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: own.backendNodeId, rect }); }
    catch { await callOn(own.parent.sess, own.objectId, function () { this.scrollIntoView({ block: "center" }); }); }
  }
  await sleep(250);
  const g = await geometry(frames, chain);
  if (!g) return null;
  const r = await evalIn(last, `(() => { const r = ${refExpr}.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const end = g.origins[g.origins.length - 1];
  const pt = { x: end.x + r.x + r.w * 0.4, y: end.y + r.y + r.h * 0.5 };
  const vp = await evalIn(top, `({ w: innerWidth, h: innerHeight, scale: window.visualViewport ? visualViewport.scale : 1 })`);
  if (vp.scale !== 1 || pt.x < 1 || pt.y < 1 || pt.x > vp.w - 1 || pt.y > vp.h - 1) return null;
  // Hit test through every frame: each level's point must land on the next <iframe>, then on the element.
  for (let i = 0; i < g.owners.length; i++) {
    const o = g.owners[i];
    const hit = await callOn(o.parent.sess, o.objectId, function (x, y) { return document.elementFromPoint(x, y) === this; }, [pt.x - g.origins[i].x, pt.y - g.origins[i].y]);
    if (!hit) return null;
  }
  const ok = await evalIn(last, `(() => {
    const el = ${refExpr}, h = document.elementFromPoint(${pt.x - end.x}, ${pt.y - end.y});
    if (!h) return false;
    const label = h.closest && h.closest("label");
    return h === el || el.contains(h) || (!!label && label.control === el);
  })()`);
  return ok ? { ...pt, g } : null;
}

/** Is focus on this element all the way down from the top document? */
async function focusedOn(frames, chain, refExpr, g = null) {
  g = g || (await geometry(frames, chain));
  if (!g) return false;
  for (const o of g.owners) {
    if (!(await callOn(o.parent.sess, o.objectId, function () { return document.activeElement === this; }))) return false;
  }
  return evalIn(chain[chain.length - 1], `document.activeElement === ${refExpr}`);
}

/** Click into the field (or focus it), and confirm focus is really there. */
async function focusField(s, frames, chain, refExpr, top) {
  const pt = await aim(s, frames, chain, refExpr, top);
  if (pt) {
    await clickAt(s, pt.x, pt.y);
    await sleep(jitter(150, 300));
    if (await focusedOn(frames, chain, refExpr)) return true;
  }
  await evalIn(chain[chain.length - 1], `${refExpr}.focus()`);
  await sleep(100);
  return focusedOn(frames, chain, refExpr);
}

// ── fill ──────────────────────────────────────────────────────────────────

/**
 * Fill the card form in the tab `s` is connected to.
 *   value(kind) → the string/number to put in that field, or null (missing).
 *   add         → then click the form's own Add Card / Continue (CONFIRM_LABELS).
 * Throws Refusal when the tab is not on `site` or no card form may be filled.
 */
export async function fillCard(s, { site, value, add = false, processors = PAYMENT_FRAME_DOMAINS }) {
  const { frames, topId } = await frameMap(s);
  const top = frames.get(topId);
  if (!hostMatchesSite(top.url, site)) throw new Refusal(`refusing: shop tab is on ${top.url}, not ${site}`);

  const forms = [], refused = [];
  for (const f of frames.values()) {
    const chain = chainOf(frames, f.id);
    if (chain[0]?.id !== topId) continue;
    let fields;
    try { fields = await evalIn(f, FIND); } catch { continue; }
    if (!fields || !Object.keys(fields).some((k) => SECRET.has(k))) continue;
    const v = chainVerdict(chain.map((c) => c.url), site, processors);
    if (!v.ok) { refused.push(v.reason); continue; }
    if (!(await geometry(frames, chain))) continue; // a hidden frame
    forms.push({ f, chain, fields, processor: v.processor });
  }
  const homes = forms.filter((t) => t.fields.number);
  if (homes.length > 1) {
    const hosts = homes.map((t) => { try { return new URL(t.f.url).hostname; } catch { return "?"; } });
    throw new Refusal(`refusing: more than one card-number field is showing (${hosts.join(", ")}); close the other form first`);
  }
  const home = homes[0];
  if (!home) {
    throw new Refusal(refused.length ? `refusing: ${[...new Set(refused)].join("; ")}` : "no card-number field in the shop tab or its card frames; open the card form first");
  }
  // The number's frame first, then the rest of the card form (a Microform-style
  // form keeps the number and the code in separate frames, the expiry outside).
  const order = [home, ...forms.filter((t) => t !== home)];
  const filled = [], missing = [], skipped = [], unconfirmed = [], invalid = [];
  const done = [];
  for (const [kind] of CARD_FIELDS) {
    const t = order.find((x) => x.fields[kind]);
    if (!t) continue;
    let v = value(kind);
    if (v == null || v === "") { missing.push(kind); continue; }
    v = String(v);
    const expect = kind === "number" ? v.replace(/[^0-9]/g, "").length : kind === "cvv" ? v.length : kind === "expiry" ? 4 : 0;
    if (!hostMatchesSite(await evalIn(top, "location.href"), site)) throw new Refusal(`refusing: the shop tab left ${site}`);
    if (t.fields[kind].tag === "select") {
      const obj = await objectIn(t.f, ref(kind));
      const ok = obj && (await callOn(t.f.sess, obj, SET_SELECT, [kind, kind === "expMonth" || kind === "expYear" ? Number(v) : v]));
      v = null;
      (ok ? filled : skipped).push(kind);
      if (ok) done.push([t, kind]);
      continue;
    }
    if (!(await focusField(s, frames, t.chain, ref(kind), top))) { v = null; skipped.push(kind); continue; }
    await evalIn(t.f, `(() => { const el = ${ref(kind)}; if ("select" in el) el.select(); })()`);
    await pressKey(s, "Backspace", "Backspace", 8);
    // Before every key: focus is still on this field, all the way down.
    const g = await geometry(frames, t.chain);
    const typed = !!g && (await typeText(s, v, () => focusedOn(frames, t.chain, ref(kind), g)));
    v = null;
    if (!typed) { skipped.push(kind); continue; }
    if (kind === "state") await pickTypeahead(s, frames, t, top, value("state"), kind);
    const c = await evalIn(t.f, CHECK(kind));
    if (expect ? c.digits !== expect : c.len === 0) unconfirmed.push(kind);
    else filled.push(kind);
    done.push([t, kind]);
  }
  // Forms validate on blur: read aria-invalid once everything is in.
  await sleep(300);
  for (const [t, kind] of done) {
    try { if ((await evalIn(t.f, CHECK(kind))).invalid) invalid.push(kind); } catch {}
  }

  let added, button;
  if (add) {
    added = false;
    if (missing.length || skipped.length || unconfirmed.length || invalid.length) {
      button = null;
    } else {
      // "Continue" only inside a processor's frame or the number's own <form>:
      // on a merchant page it could be any step's button.
      button = await evalIn(home.f, `(() => {
        const ok = new Set(${JSON.stringify(CONFIRM_LABELS)});
        const inProcessor = ${JSON.stringify(!!home.processor)};
        const form = globalThis.__joriCard.number && globalThis.__joriCard.number.form;
        const norm = (t) => String(t || "").replace(/\\s+/g, " ").trim().toLowerCase();
        const label = (e) => norm(e.innerText || e.value || e.getAttribute("aria-label"));
        const b = [...document.querySelectorAll("button, input[type=submit], input[type=button], [role=button]")]
          .find((e) => ok.has(label(e)) && !e.disabled && e.getBoundingClientRect().width > 0
            && (label(e) !== "continue" || inProcessor || (!!form && form.contains(e))));
        globalThis.__joriCard.__button = b || null;
        return b ? label(b) : null;
      })()`);
      if (button) {
        const pt = await aim(s, frames, home.chain, ref("__button"), top);
        if (pt) { await clickAt(s, pt.x, pt.y); added = true; }
      }
    }
  }
  const frameHost = (() => { try { return new URL(home.f.url).hostname; } catch { return null; } })();
  return { frame: frameHost, processor: home.processor, filled, missing, skipped, unconfirmed, invalid, added, button };
}

/**
 * When the card form sits behind a processor's own button inside its frame
 * (which `purchase click` cannot reach), click that button. A no-op when a
 * card-number field is already showing. { opened, button, already }.
 */
export async function openCardForm(s, { site, processors = PAYMENT_FRAME_DOMAINS }) {
  const { frames, topId } = await frameMap(s);
  const top = frames.get(topId);
  if (!hostMatchesSite(top.url, site)) throw new Refusal(`refusing: shop tab is on ${top.url}, not ${site}`);
  const candidates = [];
  for (const f of frames.values()) {
    const chain = chainOf(frames, f.id);
    if (chain[0]?.id !== topId) continue;
    const v = chainVerdict(chain.map((c) => c.url), site, processors);
    if (!v.ok || !(await geometry(frames, chain).catch(() => null))) continue;
    let fields;
    try { fields = await evalIn(f, FIND); } catch { continue; }
    if (fields?.number) return { opened: false, button: null, already: true };
    if (v.processor) candidates.push({ f, chain });
  }
  for (const { f, chain } of candidates) {
    const label = await evalIn(f, `(() => {
      const ok = new Set(${JSON.stringify(OPEN_LABELS)});
      const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
      const label = (e) => norm(e.innerText || e.value || e.getAttribute("aria-label"));
      const b = [...document.querySelectorAll("button, [role=button], [role=tab], [role=radio]")]
        .find((e) => ok.has(label(e)) && !e.disabled && e.getBoundingClientRect().width > 0);
      globalThis.__joriCard = { __open: b || null };
      return b ? label(b) : null;
    })()`).catch(() => null);
    if (!label) continue;
    const pt = await aim(s, frames, chain, ref("__open"), top);
    if (!pt) continue;
    await clickAt(s, pt.x, pt.y);
    return { opened: true, button: label, already: false };
  }
  return { opened: false, button: null, already: false };
}

// A state type-ahead leaves the field "Required" until an option is picked:
// click the matching option for real, or fall back to ArrowDown + Enter.
async function pickTypeahead(s, frames, t, top, want, kind) {
  await sleep(600);
  const found = await evalIn(t.f, `(() => {
    const want = ${JSON.stringify(String(want || "").toLowerCase())};
    const opts = [...document.querySelectorAll('[role="option"], li, [class*="option" i]')]
      .filter((e) => e.offsetParent !== null && (e.innerText || "").trim());
    const el = opts.find((e) => e.innerText.trim().toLowerCase() === want)
      || opts.find((e) => e.innerText.trim().toLowerCase().startsWith(want));
    globalThis.__joriCard.__option = el || null;
    if (el) el.scrollIntoView({ block: "nearest" });
    return !!el;
  })()`);
  const pt = found ? await aim(s, frames, t.chain, ref("__option"), top) : null;
  if (pt) await clickAt(s, pt.x, pt.y);
  else if (await focusedOn(frames, t.chain, ref(kind))) { await pressKey(s, "ArrowDown", "ArrowDown", 40); await pressKey(s, "Enter", "Enter", 13); }
  await sleep(300);
}

// ── masked screenshot ─────────────────────────────────────────────────────

// Runs in the top document's isolated world. Covers every cross-origin frame
// whole (its content is unknowable from here, so all of it), and every card
// field in the page and its same-origin frames, through open shadow roots.
// The covers go into the top layer (above dialogs and popovers), and each one
// is hit-tested to be the topmost thing at its visible points.
const MASK = (processors) => `(() => {
  const spec = ${JSON.stringify(CARD_FIELDS.filter(([k]) => SECRET.has(k)))};
  const doms = ${JSON.stringify(processors)};
  const acs = new Set(spec.flatMap((s) => s[1])), names = new Set(spec.flatMap((s) => s[2]));
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const last = (e) => String(e.getAttribute("autocomplete") || "").toLowerCase().split(" ").filter(Boolean).slice(-1)[0] || "";
  const isCard = (e) => acs.has(last(e)) || last(e).startsWith("cc-") || names.has(norm(e.name)) || names.has(norm(e.id).replace(/input$/, ""));
  const ofProcessor = (src) => { try { const h = new URL(src, location.href).hostname.toLowerCase(); return doms.some((d) => h === d || h.endsWith("." + d)); } catch { return false; } };
  const deep = (root, sel) => {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) out.push(...deep(el.shadowRoot, sel));
    return out;
  };
  const walk = (doc, ox, oy, depth) => {
    for (const e of deep(doc, "input, select, textarea")) {
      if (!isCard(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) boxes.push({ x: ox + r.left, y: oy + r.top, w: r.width, h: r.height, label: "card hidden" });
    }
    for (const f of deep(doc, "iframe, frame, object, embed")) {
      const r = f.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      let inner = null;
      try { inner = f.contentDocument; } catch {}
      if (inner && inner.documentElement && depth < 10) {
        const cs = getComputedStyle(f);
        walk(inner, ox + r.left + f.clientLeft + (parseFloat(cs.paddingLeft) || 0), oy + r.top + f.clientTop + (parseFloat(cs.paddingTop) || 0), depth + 1);
      } else boxes.push({ x: ox + r.left, y: oy + r.top, w: r.width, h: r.height, label: ofProcessor(f.src || f.data || "") ? "card hidden" : "hidden" });
    }
  };
  const measure = () => { boxes = []; walk(document, 0, 0, 0); return boxes; };
  let boxes = [];
  measure();
  // Re-measured after the capture: anything that moved means a cover may have missed.
  globalThis.__joriMaskMeasure = () => measure().map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)]);
  globalThis.__joriMaskAt = boxes.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)]);
  const css = (b) => [["position", "fixed"], ["left", (b.x - 4) + "px"], ["top", (b.y - 4) + "px"], ["width", (b.w + 8) + "px"],
    ["height", (b.h + 8) + "px"], ["right", "auto"], ["bottom", "auto"], ["margin", "0"], ["border", "0"], ["padding", "0"],
    ["box-sizing", "border-box"], ["background", "#1c1c1e"], ["color", "#fff"], ["z-index", "2147483647"], ["pointer-events", "none"],
    ["display", "flex"], ["align-items", "center"], ["justify-content", "center"], ["overflow", "hidden"],
    ["font", "600 13px -apple-system, sans-serif"], ["border-radius", "4px"], ["opacity", "1"], ["visibility", "visible"],
    ["transform", "none"], ["filter", "none"], ["clip-path", "none"]].map(([k, v]) => k + ":" + v + " !important").join(";");
  // While a modal dialog is open everything outside it is inert, so the covers
  // live inside the topmost one (still drawn in the top layer, above it).
  const host = [...document.querySelectorAll("dialog")].filter((d) => d.matches(":modal")).pop() || document.documentElement;
  const made = boxes.map((b) => {
    const d = document.createElement("div");
    d.setAttribute("data-jori-mask", "");
    d.textContent = b.label;
    d.style.cssText = css(b);
    if (typeof d.showPopover === "function") d.popover = "manual";
    host.appendChild(d);
    if (typeof d.showPopover === "function") { try { d.showPopover(); } catch {} }
    return d;
  });
  globalThis.__joriMasks = made;
  return made.length;
})()`;

// Each cover must be what a click at its visible points would hit, i.e. on top.
const MASKS_ON_TOP = `(() => {
  const made = globalThis.__joriMasks || [];
  if (!made.every((d) => d.isConnected)) return false;
  made.forEach((d) => d.style.setProperty("pointer-events", "auto", "important"));
  const W = innerWidth, H = innerHeight;
  const ok = made.every((d) => {
    const b = d.getBoundingClientRect();
    // The part of the cover that is on screen: its centre, corners and edge midpoints.
    const l = Math.max(0, b.left), t = Math.max(0, b.top), r = Math.min(W, b.right), btm = Math.min(H, b.bottom);
    if (r - l < 1 || btm - t < 1) return true;
    const i = Math.min(4, (r - l) / 3, (btm - t) / 3), mx = (l + r) / 2, my = (t + btm) / 2;
    return [[mx, my], [l + i, t + i], [r - i, t + i], [l + i, btm - i], [r - i, btm - i], [mx, t + i], [mx, btm - i], [l + i, my], [r - i, my]]
      .every(([x, y]) => made.includes(document.elementFromPoint(x, y)));
  });
  made.forEach((d) => d.style.setProperty("pointer-events", "none", "important"));
  return ok;
})()`;

/**
 * Screenshot of the tab with every card field and every cross-origin frame
 * covered. Throws rather than return a picture it could not cover.
 *   onMasked(count) → called while the covers are up (tests).
 */
export async function maskedScreenshot(s, { format = "jpeg", quality = 60, processors = PAYMENT_FRAME_DOMAINS, onMasked } = {}) {
  const { frameTree } = await s.send("Page.getFrameTree");
  const top = { id: frameTree.frame.id, sess: s };
  const count = await evalIn(top, MASK(processors));
  try {
    await evalIn(top, `Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), new Promise((r) => setTimeout(r, 300))])`, { awaitPromise: true });
    if (!(await evalIn(top, MASKS_ON_TOP))) throw new Error("something on the page sits above the card covers; no screenshot taken");
    if (onMasked) await onMasked(count);
    const r = await s.send("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality } : {}), captureBeyondViewport: false });
    const still = await evalIn(top, `JSON.stringify(globalThis.__joriMaskMeasure()) === JSON.stringify(globalThis.__joriMaskAt)`);
    if (!still) throw new Error("the page moved while the picture was taken; no screenshot kept (try again)");
    return { data: Buffer.from(r.data, "base64"), masked: count };
  } finally {
    await evalIn(top, `(globalThis.__joriMasks || []).forEach((d) => { try { d.hidePopover && d.matches(":popover-open") && d.hidePopover(); } catch {} d.remove(); }); globalThis.__joriMasks = []; globalThis.__joriMaskMeasure = null; true`).catch(() => {});
  }
}
