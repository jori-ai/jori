// net-trust.test.mjs — the caller and Host checks that keep the login-free
// host services (wiki :9096, WhatsApp send-server :9100) off the home LAN and
// away from DNS-rebinding pages.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nt = require("../lib/net-trust.cjs");

test("loopback and tailnet addresses, not the LAN", () => {
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.53"]) assert.ok(nt.isLoopback(a), a);
  for (const a of ["100.64.0.1", "100.101.102.103", "100.127.255.255", "::ffff:100.100.1.1", "fd7a:115c:a1e0::1234"]) {
    assert.ok(nt.isTailnet(a), a);
    assert.ok(nt.isLocalOrTailnet(a), a);
  }
  for (const a of ["192.168.1.50", "10.0.0.5", "172.16.0.1", "100.63.0.1", "100.128.0.1", "8.8.8.8", "fe80::1", "", undefined]) {
    assert.equal(nt.isLocalOrTailnet(a), false, String(a));
  }
});

test("hostName strips port, brackets, case and a trailing dot", () => {
  assert.equal(nt.hostName("Localhost:9096"), "localhost");
  assert.equal(nt.hostName("[::1]:9100"), "::1");
  assert.equal(nt.hostName("host.tail1.ts.net."), "host.tail1.ts.net");
  assert.equal(nt.hostName("fd7a:115c:a1e0::1"), "fd7a:115c:a1e0::1");
  assert.equal(nt.hostName(""), "");
});

test("local-only Host check (WhatsApp send-server)", () => {
  for (const h of ["localhost:9100", "127.0.0.1:9100", "[::1]:9100", "localhost"]) assert.ok(nt.isTrustedHost(h), h);
  for (const h of ["attacker.example", "rebind.attacker.example:9100", "192.168.1.50:9100", "100.101.102.103:9100", "mini", "", undefined]) {
    assert.equal(nt.isTrustedHost(h), false, String(h));
  }
});

test("tailnet Host check (wiki)", () => {
  const own = os.hostname().toLowerCase().split(".")[0];
  for (const h of ["localhost:9096", "100.101.102.103:9096", "[fd7a:115c:a1e0::1]:9096", "my-mini:9096", "my-mini.tail1234.ts.net", `${own}.local`]) {
    assert.ok(nt.isTrustedHost(h, { tailnet: true }), h);
  }
  for (const h of ["attacker.example", "evil.example:9096", "my-mini.attacker.example", "ts.net.attacker.example", ""]) {
    assert.equal(nt.isTrustedHost(h, { tailnet: true }), false, h);
  }
});
