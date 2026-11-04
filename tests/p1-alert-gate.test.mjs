// Regression guard: unstar-scan paging the user on a transient that
// self-corrects on the next cycle. Paging on every scan error once produced
// about one system-channel alert a day for weeks while the sweep itself was
// working — the unstarred-P1 backlog drained over the same window.
//
// The rule these tests pin: a page requires BOTH enough consecutive blocked
// runs AND enough elapsed wall-clock time, and one streak pages exactly once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GATE = process.env.P1_ALERT_GATE_BIN || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "p1-alert-gate");

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p1-alert-gate-"));
  const statePath = path.join(dir, "streak.json");
  const sentPath = path.join(dir, "sent.log");
  const sendPath = path.join(dir, "fake-send");
  fs.writeFileSync(sendPath, `#!/bin/bash\nprintf '%s\\n' "$*" >> ${sentPath}\n`);
  fs.chmodSync(sendPath, 0o755);
  const env = { ...process.env, P1_ALERT_GATE_STATE: statePath, P1_ALERT_GATE_SEND: sendPath };
  return {
    run: (...args) => execFileSync(GATE, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    pages: () => (fs.existsSync(sentPath) ? fs.readFileSync(sentPath, "utf8").trim().split("\n").filter(Boolean) : []),
    state: () => JSON.parse(fs.readFileSync(statePath, "utf8")),
    backdateMinutes: (m) => {
      const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
      s.first_failure_at = new Date(Date.now() - m * 60000).toISOString();
      fs.writeFileSync(statePath, JSON.stringify(s));
    },
  };
}

test("a burst of failures inside the elapsed window never pages", () => {
  const h = harness();
  for (let i = 0; i < 5; i++) h.run("--failed", "getaddrinfo ENOTFOUND gmail.googleapis.com");
  assert.equal(h.pages().length, 0, "a self-correcting transient must not page");
  assert.equal(h.state().streak, 5);
});

test("a genuinely stuck sweep pages once, and only once", () => {
  const h = harness();
  h.run("--failed", "getaddrinfo ENOTFOUND gmail.googleapis.com");
  h.run("--failed", "getaddrinfo ENOTFOUND gmail.googleapis.com");
  h.backdateMinutes(60);
  h.run("--failed", "getaddrinfo ENOTFOUND gmail.googleapis.com");
  assert.equal(h.pages().length, 1, "stuck sweep must page");
  h.run("--failed", "getaddrinfo ENOTFOUND gmail.googleapis.com");
  h.run("--failed", "getaddrinfo ENOTFOUND gmail.googleapis.com");
  assert.equal(h.pages().length, 1, "one page per streak, not one per run");
});

test("elapsed time alone is not enough without a streak", () => {
  const h = harness();
  h.run("--failed", "boom");
  h.backdateMinutes(600);
  assert.equal(h.pages().length, 0, "a single 10h-old failure is still one failure");
});

test("the page quotes the captured error and never invents a mechanism", () => {
  const h = harness();
  h.run("--failed", "getaddrinfo ENOTFOUND gmail.googleapis.com");
  h.run("--failed", "getaddrinfo ENOTFOUND gmail.googleapis.com");
  h.backdateMinutes(60);
  h.run("--failed", "getaddrinfo ENOTFOUND gmail.googleapis.com");
  const page = h.pages()[0];
  assert.match(page, /getaddrinfo ENOTFOUND gmail\.googleapis\.com/);
  assert.match(page, /--channel system/);
  for (const invented of ["SMTP2Go", "sandboxed", "OAuth", "quota"]) {
    assert.ok(!page.includes(invented), `page must not assert an unobserved mechanism (${invented})`);
  }
});

test("recovery resets the streak so the next outage can page again", () => {
  const h = harness();
  h.run("--failed", "boom");
  h.run("--failed", "boom");
  h.backdateMinutes(60);
  h.run("--failed", "boom");
  assert.equal(h.pages().length, 1);
  h.run("--ok");
  assert.equal(h.state().streak, 0);
  assert.equal(h.state().alerted_for_streak, false);
  h.run("--failed", "boom");
  h.run("--failed", "boom");
  h.backdateMinutes(60);
  h.run("--failed", "boom");
  assert.equal(h.pages().length, 2, "a fresh outage after recovery must page again");
});

// --- sic-20260903-host-dns-intermittent (reopened 2026-09-07) -------------
//
// Defends against the shape that made this cluster survive nine fix attempts:
// the resolver question was always argued from scraped log lines because
// nothing measured it at the moment of failure. The 2026-09-03 attempt shipped
// bin/dns-health-check and left it with zero callers, so four days of
// verification produced one sample -- written before the binary was installed.
//
// These pin the three properties that make the probe safe to leave in a
// failure path: it is SCOPED (only resolver-shaped errors), it is INERT toward
// what gets paged, and it CANNOT fail the gate.

function dnsHarness({ probe } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p1-alert-gate-dns-"));
  const statePath = path.join(dir, "streak.json");
  const sentPath = path.join(dir, "sent.log");
  const sendPath = path.join(dir, "fake-send");
  fs.writeFileSync(sendPath, `#!/bin/bash\nprintf '%s\\n' "$*" >> ${sentPath}\n`);
  fs.chmodSync(sendPath, 0o755);

  let probePath = path.join(dir, "absent-probe");
  if (probe) {
    probePath = path.join(dir, "fake-dns-probe");
    fs.writeFileSync(probePath, probe);
    fs.chmodSync(probePath, 0o755);
  }
  const env = {
    ...process.env,
    P1_ALERT_GATE_STATE: statePath,
    P1_ALERT_GATE_SEND: sendPath,
    P1_ALERT_GATE_DNS_PROBE: probePath,
  };
  return {
    run: (...args) => execFileSync(GATE, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    pages: () => (fs.existsSync(sentPath) ? fs.readFileSync(sentPath, "utf8").trim().split("\n").filter(Boolean) : []),
    state: () => JSON.parse(fs.readFileSync(statePath, "utf8")),
    backdateMinutes: (m) => {
      const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
      s.first_failure_at = new Date(Date.now() - m * 60000).toISOString();
      fs.writeFileSync(statePath, JSON.stringify(s));
    },
  };
}

// exit 2 == resolver-down. execFileSync throws on it, so this also pins that
// the finding is read off err.stdout rather than lost.
const PROBE_RESOLVER_DOWN =
  '#!/bin/bash\n' +
  'echo \'{"ts":"2026-09-07T00:00:00.000Z","verdict":"resolver-down",' +
  '"failed":["gmail.googleapis.com:ENOTFOUND","api.anthropic.com:ENOTFOUND"]}\'\n' +
  'exit 2\n';

test("a resolver-shaped failure records the probe verdict, incl. a non-zero exit", () => {
  const h = dnsHarness({ probe: PROBE_RESOLVER_DOWN });
  h.run("--failed", "gmail-action error: getaddrinfo ENOTFOUND gmail.googleapis.com [ENOTFOUND]");
  const s = h.state();
  assert.equal(s.last_dns_verdict, "resolver-down", "exit 2 is a RESULT, not an error to swallow");
  assert.deepEqual(s.last_dns_failed, ["gmail.googleapis.com:ENOTFOUND", "api.anthropic.com:ENOTFOUND"]);
  assert.equal(s.last_dns_checked_at, "2026-09-07T00:00:00.000Z");
});

test("a failure that is not resolver-shaped never runs the probe", () => {
  const h = dnsHarness({ probe: '#!/bin/bash\necho SHOULD_NOT_RUN >&2\nexit 9\n' });
  h.run("--failed", "gmail-action error: HTTP 403 insufficient permission");
  assert.equal(h.state().last_dns_verdict, null, "probe must be scoped to resolver errors");
});

test("the probe never changes what gets paged", () => {
  const withProbe = dnsHarness({ probe: PROBE_RESOLVER_DOWN });
  const without = dnsHarness();
  for (const h of [withProbe, without]) {
    h.run("--failed", "getaddrinfo ENOTFOUND gmail.googleapis.com");
    h.run("--failed", "getaddrinfo ENOTFOUND gmail.googleapis.com");
    h.backdateMinutes(60);
    h.run("--failed", "getaddrinfo ENOTFOUND gmail.googleapis.com");
  }
  assert.equal(withProbe.pages().length, 1);
  assert.equal(without.pages().length, 1);
  // The alert text is the mechanism-attestation contract with jori-send-curl
  // (tests/mechanism-attestation-gate.test.mjs). A measurement the data
  // has not yet earned must not leak into it.
  const strip = (s) => s.replace(/about \d+ minutes/, "about N minutes");
  assert.equal(strip(withProbe.pages()[0]), strip(without.pages()[0]));
  assert.ok(!withProbe.pages()[0].includes("resolver-down"));
});

test("a missing or broken probe cannot break the gate", () => {
  for (const probe of [undefined, '#!/bin/bash\nexit 1\n', '#!/bin/bash\necho "not json"\nexit 0\n']) {
    const h = dnsHarness({ probe });
    h.run("--failed", "getaddrinfo ENOTFOUND gmail.googleapis.com");
    h.run("--failed", "getaddrinfo ENOTFOUND gmail.googleapis.com");
    h.backdateMinutes(60);
    h.run("--failed", "getaddrinfo ENOTFOUND gmail.googleapis.com");
    assert.equal(h.pages().length, 1, "a broken diagnostic must not suppress a real page");
    assert.equal(h.state().streak, 3);
    assert.equal(h.state().last_dns_verdict, null);
  }
});

test("--ok resets the streak but keeps the last failure's measurement", () => {
  const h = dnsHarness({ probe: PROBE_RESOLVER_DOWN });
  h.run("--failed", "getaddrinfo ENOTFOUND gmail.googleapis.com");
  assert.equal(h.state().last_dns_verdict, "resolver-down");
  h.run("--ok");
  const s = h.state();
  assert.equal(s.streak, 0, "recovery resets the streak");
  assert.equal(s.last_dns_verdict, "resolver-down", "a recovery does not unmake the measurement");
});
