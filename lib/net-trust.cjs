"use strict";
// net-trust.cjs — who may talk to a host-only HTTP service.
//
// Jori runs small unauthenticated HTTP servers on the host (the memory wiki,
// the WhatsApp send-server). Their safety rests on two checks, both here:
//
//   1. The caller's socket address. Loopback always; the tailnet
//      (100.64.0.0/10, fd7a:115c:a1e0::/48) only where a service is meant to be
//      reached from the owner's other devices. A home-LAN caller (any IoT
//      gadget on the same Wi-Fi) is refused.
//
//   2. The Host header. A browser on a trusted machine can be pointed at the
//      service by a hostile web page through DNS rebinding: the page's own
//      domain re-resolves to 127.0.0.1 or the host's address, and the browser
//      then treats the response as same-origin. The Host header still carries
//      the attacker's domain, so only names the owner's own network can
//      produce are accepted: IP literals (no DNS involved), localhost, and
//      for tailnet services a single-label name (MagicDNS short name), a
//      *.ts.net name or this machine's own name.

const os = require("node:os");

function normAddr(addr) {
  return String(addr || "").trim().toLowerCase().replace(/^::ffff:/, "");
}

function isLoopback(addr) {
  const a = normAddr(addr);
  return a === "::1" || /^127\.\d+\.\d+\.\d+$/.test(a); // lang-regex-ok: IPv4 syntax
}

function isTailnet(addr) {
  const a = normAddr(addr);
  const m = a.match(/^100\.(\d+)\.\d+\.\d+$/); // lang-regex-ok: IPv4 syntax
  if (m) {
    const b = Number(m[1]);
    return b >= 64 && b <= 127;
  }
  return a.startsWith("fd7a:115c:a1e0:");
}

function isLocalOrTailnet(addr) {
  return isLoopback(addr) || isTailnet(addr);
}

// "Host: [::1]:9096" → "::1"; "Host: Mini.local.:9096" → "mini.local"
function hostName(hostHeader) {
  let h = String(hostHeader || "").trim().toLowerCase();
  if (!h) return "";
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : "";
  }
  const colon = h.lastIndexOf(":");
  if (colon > -1 && h.indexOf(":") === colon) h = h.slice(0, colon); // name:port (a bare IPv6 has several colons)
  return h.replace(/\.$/, "");
}

function isIpLiteral(h) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || (h.includes(":") && /^[0-9a-f:.]+$/.test(h)); // lang-regex-ok: IP syntax
}

function ownNames() {
  const full = String(os.hostname() || "").toLowerCase().replace(/\.$/, "");
  const short = full.split(".")[0];
  return new Set([full, short, `${short}.local`].filter(Boolean));
}

// tailnet: also accept the names a tailnet device would use for this host.
function isTrustedHost(hostHeader, { tailnet = false } = {}) {
  const h = hostName(hostHeader);
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIpLiteral(h)) return tailnet ? true : isLoopback(h);
  if (!tailnet) return false;
  if (!h.includes(".")) return true; // MagicDNS short name, e.g. "my-mini"
  if (h.endsWith(".ts.net")) return true;
  return ownNames().has(h);
}

module.exports = { isLoopback, isTailnet, isLocalOrTailnet, hostName, isTrustedHost };
