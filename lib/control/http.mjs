// control/http.mjs — the /control routes of the memory site (lib/wiki-serve.js).
//
//   GET  /control            the control room (a page in the site shell; the
//                             app renders from /control/api/state)
//   GET  /control/app.js     the page's script     GET /control/app.css  its styles
//   GET  /control/api/state  everything the pages show (state.mjs)
//   GET  /control/api/config?name=<n>   one feature's settings file
//   POST /control/api/action {action, args}  one change (actions.mjs)
//
// Who may use it (canControl): the owner only. Through Cloudflare Access the
// verified email must be owner_email or listed in control.json `admins`.
// Without Access (the tailnet instance) the caller must be on this machine or
// on the tailnet (100.64.0.0/10); a LAN caller gets nothing.
// A write also needs the X-Control-Token header the page carries: a value
// bound to the viewer by HMAC with a per-process secret, which a cross-site
// form cannot send.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { snapshot, configFile } from "./state.mjs";
import { perform } from "./actions.mjs";

const require = createRequire(import.meta.url);
const inst = require("../instance.cjs");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRET = crypto.randomBytes(32);

function tailnetOrLocal(addr) {
  const a = String(addr || "").replace(/^::ffff:/, "");
  if (a === "127.0.0.1" || a === "::1") return true;
  const m = a.match(/^100\.(\d+)\./); // lang-regex-ok: IPv4 syntax
  if (m) { const b = Number(m[1]); return b >= 64 && b <= 127; }
  return a.toLowerCase().startsWith("fd7a:115c:a1e0:"); // Tailscale IPv6 range
}

// viewer: { email|null } from the wiki's identity step; remote: socket address.
export function canControl({ email, remote, viaAccess }) {
  if (viaAccess) {
    const admins = inst.localConfig("control", { admins: [] }).admins.map((x) => String(x).toLowerCase());
    const owner = String(inst.instanceValue("owner_email") || "").toLowerCase();
    const e = String(email || "").toLowerCase();
    return !!e && (e === owner || admins.includes(e));
  }
  return tailnetOrLocal(remote);
}

export function tokenFor(who) {
  return crypto.createHmac("sha256", SECRET).update(String(who)).digest("hex").slice(0, 32);
}

function pageBody(token) {
  return `<div id="control" data-token="${token}" class="ctl-loading">
  <p class="dim">Reading the live state of ${escape(inst.instanceValue("host_label"))}…</p>
  <noscript>The control room needs JavaScript.</noscript>
</div>
<link rel="stylesheet" href="/control/app.css">
<script src="/control/app.js" defer></script>`;
}

function escape(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function readBody(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("request too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Returns true when it handled the request.
export async function handle({ req, res, u, viewer, page, send, json }) {
  if (u.pathname !== "/control" && !u.pathname.startsWith("/control/")) return false;
  const who = viewer.email || `local ${String(req.socket.remoteAddress || "").replace(/^::ffff:/, "")}`;
  if (!canControl({ email: viewer.email, remote: req.socket.remoteAddress, viaAccess: viewer.viaAccess })) {
    if (u.pathname.startsWith("/control/api/")) json(403, { error: "Only the owner can use the control room." });
    else send(403, page("Not authorised", `<div class="page-head"><h1>Not authorised</h1><p class="dek">Only the owner can use the control room.</p></div>`));
    return true;
  }
  if (u.pathname === "/control" || u.pathname === "/control/") {
    send(200, page("Control", pageBody(tokenFor(who)), { active: "control" }));
    return true;
  }
  if (u.pathname === "/control/app.js" || u.pathname === "/control/app.css") {
    const file = path.join(HERE, u.pathname.endsWith(".js") ? "app.js" : "app.css");
    res.writeHead(200, { "content-type": u.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "cache-control": "private, no-cache" });
    res.end(fs.readFileSync(file));
    return true;
  }
  try {
    if (u.pathname === "/control/api/state" && req.method === "GET") {
      json(200, await snapshot());
      return true;
    }
    if (u.pathname === "/control/api/config" && req.method === "GET") {
      json(200, configFile(String(u.searchParams.get("name") || "")));
      return true;
    }
    if (u.pathname === "/control/api/action" && req.method === "POST") {
      const token = req.headers["x-control-token"];
      if (!token || token.length !== 32 || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(tokenFor(who)))) {
        json(403, { error: "This page is out of date. Reload it and try again." });
        return true;
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      const out = await perform(String(body.action || ""), body.args || {}, who);
      json(200, { ok: true, entry: out });
      return true;
    }
    json(404, { error: "No such control route." });
  } catch (err) {
    json(400, { error: err.message || "That change failed." });
  }
  return true;
}
