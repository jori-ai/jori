// email-worker-sender-auth.test.mjs — senderAuth, the DKIM/DMARC alignment
// the email Worker attaches to every inbound payload. A path that releases
// private figures by email refuses anything not aligned, so these are the
// cases that decide whether a forged From gets through. Addresses are made up.
//
// Run: node --test tests/email-worker-sender-auth.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { senderAuth } from "../cf-email-worker/src/sender-auth.js";

const H = (key, value) => ({ key, value });
const AR = "authentication-results";
const FROM = "relative.one@example.com";

test("DMARC pass for the From domain is aligned", () => {
  const r = senderAuth([H(AR, "mx.cloudflare.net; dkim=pass header.d=example.com header.s=x; dmarc=pass header.from=example.com policy.dmarc=none; spf=pass")], FROM);
  assert.equal(r.aligned, true);
  assert.equal(r.from_domain, "example.com");
});

test("forged From (DKIM none, DMARC fail) is not aligned", () => {
  assert.equal(senderAuth([H(AR, "mx.cloudflare.net; dkim=none; dmarc=fail header.from=example.com; spf=fail")], FROM).aligned, false);
});

test("an injected pass BELOW the receiver's real result is ignored", () => {
  const r = senderAuth([
    H(AR, "mx.cloudflare.net; dkim=none; dmarc=fail header.from=example.com"),
    H(AR, "mx.cloudflare.net; dkim=pass header.d=example.com; dmarc=pass header.from=example.com"),
  ], FROM);
  assert.equal(r.aligned, false);
});

test("a topmost result from another server is not trusted", () => {
  assert.equal(senderAuth([H(AR, "mx.attacker.example; dkim=pass header.d=example.com; dmarc=pass header.from=example.com")], FROM).aligned, false);
});

test("DKIM pass for a different domain is not alignment; DKIM pass for the From domain is", () => {
  assert.equal(senderAuth([H(AR, "mx.cloudflare.net; dkim=pass header.d=attacker.example; dmarc=fail header.from=example.com")], FROM).aligned, false);
  assert.equal(senderAuth([H(AR, "mx.cloudflare.net; dkim=pass header.d=example.com; dmarc=none")], FROM).aligned, true);
});

test("no results header → not aligned", () => {
  assert.equal(senderAuth([], "relative.two@example.org").aligned, false);
});

test("ARC form (i=N; prefix) is read", () => {
  assert.equal(senderAuth([H("ARC-Authentication-Results", "i=1; mx.cloudflare.net; dkim=pass header.d=example.org; dmarc=pass header.from=example.org")], "relative.two@example.org").aligned, true);
});
