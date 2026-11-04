// ticket-lottery-error-triage.test.mjs — the unknown-error-code classifier that
// bin/ticket-lottery-run consults (lib/ticket-lottery-error-triage.mjs).
// The model is injected, so these run offline.
//
// Run: node --test tests/ticket-lottery-error-triage.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KNOWN_CODES, isUnknown, validate, cached, createTriager, CACHE_TTL_MS, SCHEMA,
} from "../lib/ticket-lottery-error-triage.mjs";
import { doneKeys, entryKey } from "../lib/ticket-lottery.mjs";

const tmpCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bw-triage-")), "classes.json");

test("known codes never reach the model", async () => {
  let called = 0;
  const t = createTriager({ judge: async () => { called++; return { class: "retryable", explanation: "x" }; } });
  for (const code of KNOWN_CODES) assert.equal(await t.classify({ code }), null);
  assert.equal(await t.classify({ code: "" }), null);
  assert.equal(called, 0);
  assert.ok(isUnknown("seat_map_timeout"));
  assert.ok(!isUnknown("already_entered"));
});

test("validate rejects off-schema answers", () => {
  assert.equal(validate(null), null);
  assert.equal(validate({ class: "maybe", explanation: "x" }), null);
  assert.equal(validate({ class: "permanent", explanation: "   " }), null);
  assert.deepEqual(validate({ class: "permanent", explanation: " Sold out. " }), { class: "permanent", explanation: "Sold out." });
  assert.deepEqual(SCHEMA.properties.class.enum, ["retryable", "permanent", "needs_attention"]);
});

test("a classification is cached per code and reused within the TTL", async () => {
  const file = tmpCache();
  let called = 0;
  const judge = async ({ model, prompt, schema }) => {
    called++;
    assert.equal(model, "haiku");
    assert.ok(schema);
    assert.equal(JSON.parse(prompt).error_code, "performance_not_eligible");
    return { class: "permanent", explanation: "That performance isn't part of the lottery." };
  };
  const t1 = createTriager({ cacheFile: file, judge });
  const a = await t1.classify({ code: "performance_not_eligible", message: "perf 123 not eligible", platform: "alpha", show: "Chess" });
  assert.equal(a.class, "permanent");
  assert.equal(a.source, "model");
  // A fresh triager (next run) reads the cache — no second call.
  const t2 = createTriager({ cacheFile: file, judge });
  const b = await t2.classify({ code: "performance_not_eligible" });
  assert.equal(b.source, "cache");
  assert.equal(called, 1);
  // Past the TTL the code is re-classified.
  const later = Date.now() + CACHE_TTL_MS + 1000;
  const t3 = createTriager({ cacheFile: file, judge, now: () => later });
  assert.equal((await t3.classify({ code: "performance_not_eligible" })).source, "model");
  assert.equal(called, 2);
});

test("call budget, model failure and bad answers all fall back to null", async () => {
  let n = 0;
  const t = createTriager({ judge: async () => { n++; return { class: "retryable", explanation: "Try again." }; }, maxCalls: 2 });
  assert.ok(await t.classify({ code: "a_new" }));
  assert.ok(await t.classify({ code: "b_new" }));
  assert.equal(await t.classify({ code: "c_new" }), null, "third distinct code exceeds the budget");
  assert.equal(n, 2);

  const failing = createTriager({ judge: async () => { throw new Error("claude -p: timeout"); } });
  assert.equal(await failing.classify({ code: "x_new" }), null);

  const junk = createTriager({ judge: async () => ({ class: "whatever" }) });
  assert.equal(await junk.classify({ code: "y_new" }), null);
});

test("cached() ignores corrupt entries", () => {
  assert.equal(cached({ z: { class: "nope", classified_at: new Date().toISOString() } }, "z"), null);
  assert.equal(cached({}, "z"), null);
});

test("failed_permanent rows join the duplicate guard; error rows do not", () => {
  const perm = { show: "Chess", date: "2026-10-10", platform: "alpha", status: "failed_permanent" };
  const err = { show: "Chess", date: "2026-10-11", platform: "alpha", status: "error" };
  const keys = doneKeys({ entries: [perm, err] });
  assert.ok(keys.has(entryKey(perm)));
  assert.ok(!keys.has(entryKey(err)));
});
