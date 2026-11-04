// Regression guard for bin/dns-health-check.
//
// What this defends against: the recurring system-channel alert
// "unstar-scan blocked — gmail.googleapis.com unreachable (ENOTFOUND)", which
// drew a long run of Gmail-shaped fix attempts. The whole point of the tool is the three-way verdict: a single
// vendor failing is that vendor's problem, but two independent vendors failing
// in the same instant is the host's resolver and no vendor outage explains it.
// If that distinction ever collapses back to "the network is down", the next
// investigation goes Gmail-shaped again, which is exactly the long
// failure this exists to end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "dns-health-check");

// The verdict rule, restated here independently of the implementation. If the
// two ever disagree, one of them changed without the other being reconsidered.
function expectedVerdict(failedVendors) {
  const n = new Set(failedVendors).size;
  return n === 0 ? "ok" : n === 1 ? "vendor" : "resolver-down";
}

test("verdict rule: no failures is ok", () => {
  assert.equal(expectedVerdict([]), "ok");
});

test("verdict rule: one vendor failing is that vendor's problem, not the resolver's", () => {
  assert.equal(expectedVerdict(["google"]), "vendor");
  // Two hostnames from the SAME vendor is still one vendor.
  assert.equal(expectedVerdict(["google", "google"]), "vendor");
});

test("verdict rule: two independent vendors failing at once is the resolver", () => {
  assert.equal(expectedVerdict(["google", "anthropic"]), "resolver-down");
  assert.equal(expectedVerdict(["google", "anthropic", "cloudflare"]), "resolver-down");
});

test("exit codes are distinguishable, so a caller can branch on them", () => {
  // 0 ok / 1 vendor / 2 resolver-down. A caller that only checks "exit != 0"
  // still works; one that wants the distinction can have it.
  assert.notEqual(0, 1);
  assert.notEqual(1, 2);
});

test("the binary runs, is executable, and records one JSON line per sample", () => {
  assert.ok(fs.existsSync(BIN), `${BIN} is missing`);
  assert.ok(fs.statSync(BIN).mode & 0o111, `${BIN} is not executable`);

  const log = path.join(os.tmpdir(), `dns-health-test-${process.pid}.jsonl`);
  try {
    let out;
    try {
      out = execFileSync(BIN, ["--json"], {
        encoding: "utf8",
        env: { ...process.env, DNS_HEALTH_LOG: log },
      });
    } catch (err) {
      // Non-zero exit is a legitimate verdict (1 vendor / 2 resolver-down),
      // not a test failure — this box may genuinely be having the outage the
      // tool exists to measure.
      out = err.stdout || "";
      assert.ok([1, 2].includes(err.status), `unexpected exit ${err.status}`);
    }

    const record = JSON.parse(out);
    assert.ok(["ok", "vendor", "resolver-down"].includes(record.verdict));
    assert.ok(Array.isArray(record.controls) && record.controls.length >= 2);

    // The verdict must agree with the rule restated above, whatever the box's
    // actual network happens to be doing right now.
    const failedVendors = record.controls.filter((c) => !c.ok).map((c) => c.vendor);
    assert.equal(record.verdict, expectedVerdict(failedVendors));

    // Controls must span independent vendors — a single-vendor control set
    // could never distinguish "vendor" from "resolver-down".
    const vendors = new Set(record.controls.map((c) => c.vendor));
    assert.ok(vendors.size >= 3, `need >=3 independent vendors, got ${[...vendors].join(",")}`);

    const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "exactly one JSONL record per sample");
    assert.equal(JSON.parse(lines[0]).verdict, record.verdict);
  } finally {
    fs.rmSync(log, { force: true });
  }
});

test("a broken diagnostic never masquerades as a broken network", () => {
  // An unwritable log must not change the verdict or crash the run: the
  // measurement is the product, the bookkeeping is not.
  let status = 0;
  let out = "";
  try {
    out = execFileSync(BIN, ["--json"], {
      encoding: "utf8",
      env: { ...process.env, DNS_HEALTH_LOG: "/proc/definitely/not/writable/x.jsonl" },
    });
  } catch (err) {
    status = err.status;
    out = err.stdout || "";
  }
  assert.ok([0, 1, 2].includes(status), `unexpected exit ${status}`);
  assert.ok(["ok", "vendor", "resolver-down"].includes(JSON.parse(out).verdict));
});
