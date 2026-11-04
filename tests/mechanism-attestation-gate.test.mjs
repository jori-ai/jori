// mechanism-attestation-gate.test.mjs — the mechanism-attestation gate in
// bin/jori-send-curl (2026-08-13, si-20260813-haiku-fabricated-mechanism).
//
// alert-provenance-audit measured that of 116 system-channel alerts over 14
// days, 12 asserted a specific technical failure mechanism (an error code, a
// named subsystem declared unavailable) and ZERO were emitted by the
// deterministic composer built to prevent exactly that. Two prior fixes
// (p1-alert-gate, unstar-scan-run) solved this correctly for their own job by
// composing the alert from a captured error string with no free-text
// parameter — then told every other caller in prose to do the same.
// Compliance measured 0%. This gate makes it mechanical: any --channel system
// message asserting a mechanism must carry --observed-error "<verbatim
// captured output>", mirroring --attendee-authorized in jori-calendar.
//
// This test extracts the live regex out of the script (so it cannot drift
// from the implementation), exercises the actual refusal end-to-end against a
// throwaway HOME (the gate fires before any network call, so a fake key is
// enough — same harness as precheck-bypass-gate.test.mjs), and checks that
// every caller known to compose a mechanism-shaped message now attests it.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "bin/jori-send-curl");

function livePattern() {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const m = src.match(/^MECHANISM_CLAIM_RE='(.+)'$/m);
  assert.ok(m, "MECHANISM_CLAIM_RE not found in jori-send-curl — did the gate get renamed or removed?");
  return new RegExp(m[1], "i");
}

// Verbatim shipped alerts that alert-provenance-audit flagged as unverified
// mechanism claims — exactly the population this gate exists to stop.
const MUST_MATCH = [
  "⚠️ unstar-scan failed: Gmail API unreachable (ENOTFOUND gmail.googleapis.com) — will retry next cycle",
  "🔴 Gmail API persistently unreachable (2h+, 3 p1-downgrade attempts failed) — DNS/network issue requires manual intervention",
  "⚠️ Brokerage snapshot got 0 accounts — brokerage.example.com connection is down (brokerage OAuth token expired).",
  "⚠️ Travel data corrupted: flights.json all nulls, travel CLI unavailable. Event watchers and other geo-gated jobs cannot execute.",
  "⚠️ MCP Gmail write tools unauthorized — reclassify blocked.",
];

// Legitimate system-channel alerts that name a real problem WITHOUT claiming a
// specific technical mechanism. These must never require --observed-error.
const MUST_NOT_MATCH = [
  "⚠️ 3 emails this week arrived pre-labeled Personal before triage (all no-reply@easypark.net) — check for a stray Gmail filter or intake-side auto-label",
  "⚠️ reclassify loop: Rina/SMH thread — phantom-skipped after 4 dispatches in 30min",
  "⚠️ weekly-memo did NOT run — auth/empty output. Weekly Opus memo was NOT generated.",
  "🔴 Episode-archive missing for 2026-07-19 — the 02:00 cron didn't produce a day page.",
  "✅ Recovered: Max auth is back to normal — auto-healed, stable for 3 checks.",
  "⚠️ Unstar-scan has been blocked for 5 runs in a row, about 62 minutes now — long enough that it is not the usual blip.",
];

test("gate pattern matches the shipped fabricated-mechanism alerts", () => {
  const re = livePattern();
  for (const msg of MUST_MATCH) {
    assert.ok(re.test(msg), `should require --observed-error but does not match:\n  ${msg}`); // lang-regex-ok: asserts the gate's OWN regex against a fixture alert string
  }
});

test("gate pattern does not fire on mechanism-free alerts", () => {
  const re = livePattern();
  for (const msg of MUST_NOT_MATCH) {
    assert.ok(!re.test(msg), `legitimate alert would wrongly require --observed-error:\n  ${msg}`); // lang-regex-ok: same fixture check, negative case
  }
});

// ── End-to-end refusal, against a throwaway HOME ───────────────────────────
// The gate runs before any network call, so a fake service-role key is enough
// — nothing here can reach the real Supabase project or page the user.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mechanism-gate-"));
fs.mkdirSync(path.join(HOME, "Dev/jori"), { recursive: true });
fs.writeFileSync(path.join(HOME, "Dev/jori/.env"), "SUPABASE_SERVICE_ROLE_KEY=fake\n");

function send(args, env = {}) {
  try {
    const out = execFileSync(SCRIPT, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20000,
      env: { ...process.env, HOME, ...env },
    });
    return { code: 0, out, err: "" };
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout || ""), err: String(e.stderr || "") };
  }
}

const BLOCKED = /BLOCKED: this message asserts a specific technical failure mechanism/;

// The end-to-end fixture. It must (a) trip MECHANISM_CLAIM_RE and (b) trip
// NOTHING that runs before the attestation gate, or this whole suite goes
// vacuously green while testing nothing.
//
// It used to be the verbatim unstar-scan alert above, and that is exactly what
// went wrong (sic-20260915-attestation-tests-shadowed): the P1-sweep provenance
// gate (jori-send-curl, exit 7) was added AHEAD of the attestation gate
// (exit 6) and started catching these fixtures first, so four tests here went
// red and the two positive ones passed only because their assertion — "the
// BLOCKED-for-mechanism text is absent" — is satisfied by being blocked for a
// different reason entirely. Same error class, different job subject, so the
// message reaches the gate under test.
const MECHANISM_FIXTURE =
  "⚠️ newsletter-digest failed: Gmail API unreachable (ENOTFOUND gmail.googleapis.com) — will retry next cycle";

test("a mechanism claim with no --observed-error is refused (exit 6)", () => {
  const { code, err } = send([
    "--channel", "system", "--skip-precheck", "--no-push",
    MECHANISM_FIXTURE,
  ]);
  assert.equal(code, 6);
  assert.match(err, BLOCKED);
});

test("a mechanism claim with a real --observed-error passes the gate", () => {
  const { code, err } = send([
    "--channel", "system", "--skip-precheck", "--no-push",
    "--observed-error", "getaddrinfo ENOTFOUND gmail.googleapis.com",
    MECHANISM_FIXTURE,
  ]);
  assert.doesNotMatch(err, BLOCKED);
  // Not just "absent" — absent for the right reason. `doesNotMatch` alone is
  // satisfied by being refused at some OTHER gate, which is how this test sat
  // green for weeks while the message never reached the gate under test.
  assert.notEqual(code, 6, "attested mechanism claim was still refused by the attestation gate");
  assert.notEqual(code, 7, `blocked by an earlier gate (exit 7), not evaluated here: ${err.split("\n")[0]}`);
});

// Shadowing canary. Every end-to-end test below depends on MECHANISM_FIXTURE
// surviving as far as the attestation gate; if a newly-added --channel system
// gate catches it first, they all go quiet in confusing ways. This one says so
// in one line instead.
test("no earlier --channel system gate shadows the fixture", () => {
  const { code, err } = send([
    "--channel", "system", "--skip-precheck", "--no-push",
    MECHANISM_FIXTURE,
  ]);
  assert.equal(
    code,
    6,
    `MECHANISM_FIXTURE no longer reaches the mechanism-attestation gate (got exit ${code}). ` +
      `A gate added ahead of it in jori-send-curl is catching this fixture, so this suite is ` +
      `testing nothing. Reword MECHANISM_FIXTURE so it trips MECHANISM_CLAIM_RE and nothing else. ` +
      `stderr: ${err.split("\n")[0]}`
  );
});

test("a trivially short --observed-error is treated as a shrug, not a quote", () => {
  const { code, err } = send([
    "--channel", "system", "--skip-precheck", "--no-push",
    "--observed-error", "n/a",
    MECHANISM_FIXTURE,
  ]);
  assert.equal(code, 6);
  assert.match(err, BLOCKED);
});

test("a mechanism-free alert never needs --observed-error", () => {
  const { err } = send([
    "--channel", "system", "--skip-precheck", "--no-push",
    "⚠️ weekly-memo did NOT run — auth/empty output. Weekly Opus memo was NOT generated.",
  ]);
  assert.doesNotMatch(err, BLOCKED);
});

test("authorized infra probers (JORI_INFRA_PROBE=1) bypass the gate entirely", () => {
  const { err } = send(
    [
      "--channel", "system", "--skip-precheck", "--no-push",
      "🔴 Gmail API persistently unreachable (2h+, 3 p1-downgrade attempts failed) — DNS/network issue requires manual intervention",
    ],
    { JORI_INFRA_PROBE: "1" }
  );
  assert.doesNotMatch(err, BLOCKED);
});

test("the chat channel is untouched — the gate only fires on --channel system", () => {
  const { err } = send(["--no-push", "found ENOTFOUND in the logs today"]);
  assert.doesNotMatch(err, BLOCKED);
});

test("blocked attempts are logged, so drift is visible instead of silent", () => {
  send([
    "--channel", "system", "--skip-precheck", "--no-push", "--intent", "test-mechanism-claim",
    MECHANISM_FIXTURE,
  ]);
  const log = path.join(HOME, "Dev/jori/data/logs/unattested-mechanism-blocked.log");
  assert.ok(fs.existsSync(log), "expected an unattested-mechanism-blocked log");
  assert.match(fs.readFileSync(log, "utf8"), /test-mechanism-claim/);
});

test("attested passes are logged with the observed-error text, for future audit", () => {
  send([
    "--channel", "system", "--skip-precheck", "--no-push", "--intent", "test-mechanism-claim-ok",
    "--observed-error", "getaddrinfo ENOTFOUND gmail.googleapis.com",
    MECHANISM_FIXTURE,
  ]);
  const log = path.join(HOME, "Dev/jori/data/logs/mechanism-attestation-log.jsonl");
  assert.ok(fs.existsSync(log), "expected a mechanism-attestation-log");
  const lines = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  const row = JSON.parse(lines[lines.length - 1]);
  assert.equal(row.intent, "test-mechanism-claim-ok");
  assert.match(row.observed_error, /ENOTFOUND/);
});

// ── Known callers actually attest ───────────────────────────────────────────
test("p1-alert-gate passes --observed-error using its own captured last_error", () => {
  const src = fs.readFileSync(path.join(ROOT, "bin/p1-alert-gate"), "utf8");
  assert.match(src, /"--observed-error",\s*lastError/, "the page-the-user path must attest with the same captured error it quotes in the message"); // lang-regex-ok: matches source code structure, not language
  assert.match(
    src,
    /"--observed-error",\s*\n?\s*err\.message/,
    "the fail-open catch block must attest too, or its own passthrough alert would now be blocked by the gate it's failing open around"
  );
});

test("the auth-guard callers that embed real captured CLI output attest it", () => {
  // An installation's own auth-guard copies (agent/local/config/auth-guard-emitters.json).
  let local = [];
  try {
    const c = createRequire(import.meta.url)("../lib/instance.cjs").localConfig("auth-guard-emitters", { emitters: [] });
    local = (Array.isArray(c.emitters) ? c.emitters : []).filter((rel) => fs.existsSync(path.join(ROOT, rel)));
  } catch { /* none */ }
  const callers = [
    "agent/scripts/lib/run-ephemeral-opus.sh",
    ...local,
  ];
  for (const rel of callers) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(
      src,
      /--observed-error "\$FIRST"/,
      `${rel} composes a message that can contain a real failure phrase (e.g. "OAuth session expired") — it must attest with the same captured text`
    );
  }
});

test("every authorized infra prober from the fabricated-outage gate still exists and is unaffected", () => {
  // Sanity check that this new gate didn't accidentally require the infra
  // probers to change anything — JORI_INFRA_PROBE=1 must still be their
  // only requirement, verified by the fabricated-outage-gate test suite.
  const probers = [
    ["agent/scripts/watchdog.sh", /JORI_INFRA_PROBE=1 "\$SEND"/],
    ["agent/scripts/chrome-cdp-watch.sh", /JORI_INFRA_PROBE=1 "\$HOME\/Dev\/jori\/bin\/jori-send-curl"/],
  ];
  for (const [rel, re] of probers) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(src, re, `${rel} no longer authorizes itself`);
  }
});
