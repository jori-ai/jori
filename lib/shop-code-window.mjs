// shop-code-window.mjs — the sign-in codes the shop browser asked for file themselves.
//
// jobs/purchase-signin.md and jobs/purchase.md trigger a merchant's 2FA email and
// read it back with `purchase otp`. That email is something Jori itself requested,
// so it is not mail for the user to review: no label, no star, no ping, not left
// unread. `purchase otp` opens a short window here (expectCode); Gmail intake asks
// (windowFor) whether an arriving message is from the merchant inside an open one
// and, if so, marks it read and strips the labels Gmail added on delivery instead
// of dispatching a triage turn.
//
// Structure only: the window is a site, a start and an end; the match is the
// From address's domain. Nothing here reads what the email says (Rule #0b), so a
// merchant mailing something else inside the window is filed the same way — a
// few minutes of one merchant's mail, left unread-free, still in the inbox.
// Every function fails open: no file, a bad file or a throw means "no window".

import fs from "node:fs";
import path from "node:path";
import { installRoot } from "./root.cjs";

const GRACE_BEFORE_SEC = 60;   // gmailSince() in bin/purchase looks 60 s before --since too
const GRACE_AFTER_SEC = 120;   // a code mail can land after `purchase otp` stopped polling

export const windowFile = (root = installRoot()) => path.join(root, "data/purchases/otp-expected.json");

// "https://www.Shop.example/x" | "www.shop.example" -> "shop.example"
export function siteHost(site) {
  let h = String(site || "").trim().toLowerCase();
  try { if (h.includes("://")) h = new URL(h).hostname; } catch {}
  return h.replace(/^www\./, "").replace(/[/:].*$/, "");
}

// "Shop <noreply@mail.shop.example>" -> "mail.shop.example"
export function fromDomain(fromHeader) {
  const s = String(fromHeader || "");
  const angle = s.lastIndexOf("<");
  const addr = (angle >= 0 ? s.slice(angle + 1).split(">")[0] : s).trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  return at >= 0 ? addr.slice(at + 1) : "";
}

function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(raw.windows) ? raw.windows : [];
  } catch { return []; }
}

// Open (or extend) the window for <site>: from `since` (unix seconds, when the
// code was requested) to the end of the wait plus a grace. Expired windows of
// any site are dropped on the way. Returns the stored window.
export function expectCode({ site, since, waitSec = 120, nowSec = Date.now() / 1000, root } = {}) {
  const host = siteHost(site);
  if (!host || !Number.isFinite(Number(since))) throw new Error("expectCode needs a site and a unix-seconds since");
  const file = windowFile(root);
  const until = Math.ceil(nowSec + Number(waitSec) + GRACE_AFTER_SEC);
  const win = { site: host, since: Math.floor(Number(since)), until };
  const kept = load(file).filter((w) => w.site !== host && Number(w.until) > nowSec);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ windows: [...kept, win] }, null, 2));
  fs.renameSync(tmp, file);
  return win;
}

// The open window an arriving message belongs to, or null. The sender's domain
// must be the site or a subdomain of it (mail.shop.example for shop.example).
export function windowFor(fromHeader, { nowSec = Date.now() / 1000, root } = {}) {
  try {
    const dom = fromDomain(fromHeader);
    if (!dom) return null;
    return load(windowFile(root)).find((w) =>
      (dom === w.site || dom.endsWith(`.${w.site}`)) &&
      nowSec >= Number(w.since) - GRACE_BEFORE_SEC && nowSec <= Number(w.until)) || null;
  } catch { return null; }
}
