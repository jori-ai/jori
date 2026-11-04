// domain-allocation: primary weights sum to 100, adjacency is reported beside
// the concentration domain and never summed into it, and drift is flagged on
// whichever of the absolute / relative thresholds trips first.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const BIN = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../bin/domain-allocation");
const { allocate } = require(BIN);

const MAP = {
  domains: {
    alpha: { display: "Alpha", primary: ["AAA", "AAB"] },
    beta: { display: "Beta", primary: ["BBB"] },
    small: { display: "Small", primary: ["SSS"] },
  },
  adjacent: { BBB: ["alpha"] },
  reference_allocation: { as_of: "2026-01-02T21:00:00Z", weights: { alpha: 50, beta: 40, small: 2 } },
};
const at = (ticker, mv, as_of = "2026-01-30T21:00:00Z") => ({ ticker, name: ticker, market_value: mv, as_of });

test("only the newest snapshot counts, and one ticker across accounts is one exposure", () => {
  const rows = [at("AAA", 300), at("AAA", 200), at("AAB", 100), at("BBB", 300), at("SSS", 50), at("ZZZ", 50),
    at("AAA", 99999, "2026-01-29T21:00:00Z")];
  const r = allocate(MAP, rows, { concentrationDomain: "alpha" });
  assert.equal(r.total, 1000);
  const alpha = r.out.find((o) => o.domain === "alpha");
  assert.equal(alpha.actual, 60);
  assert.equal(alpha.status, "OVER (flag)");          // +10pp
  assert.equal(r.inclusive, 90);                       // 60 + BBB's 30 adjacent
  assert.deepEqual(r.unclassified.map((u) => u.ticker), ["ZZZ"]);
  assert.equal(r.weeksSince, 4);
});

test("a small domain trips on relative change before absolute points", () => {
  const rows = [at("AAA", 500), at("BBB", 485), at("SSS", 15)];
  const small = allocate(MAP, rows).out.find((o) => o.domain === "small");
  assert.ok(Math.abs(small.delta_pp) < 1);             // -0.5pp
  assert.equal(small.status, "UNDER (flag)");          // -25% relative
});

test("no concentration domain configured, no inclusive line", () => {
  assert.equal(allocate(MAP, [at("AAA", 1)]).inclusive, null);
});

test("unconfigured install is OFF, not broken", () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "domalloc-"));
  const r = spawnSync(process.execPath, [BIN], { encoding: "utf8", env: { ...process.env, JORI_LOCAL_DIR: local } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /not configured/);
});
