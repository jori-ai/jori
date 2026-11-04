// jori-model-only-data.test.mjs — bank, brokerage and health rows must not
// reach an external reasoner, and money must remain unmovable by construction.
//
// Two rules, one file, because they protect the same data with two different
// techniques and the weaker one is easy to erode:
//
//   1. ABSENCE. `lib/plaid-api.js` implements no transfer endpoint, so
//      the Plaid path "cannot move money, by construction" (CLAUDE.md
//      § Financial Operations rule 5). This is the strongest enforcement in the
//      repo — not a check that can fail, a capability that does not exist.
//      Absences rot silently, though: nothing draws attention to a function
//      being added. This test is what makes the absence load-bearing.
//
//   2. IMPLICATION. Financial and health sends must skip outbound-precheck,
//      because the precheck feeds its input to a Sonnet reasoner and writes it
//      verbatim to outbound-precheck-log.jsonl. That used to depend on each
//      caller remembering `--skip-precheck` next to its `--intent`; since
//      2026-08-04 the intent implies the exemption, so it cannot be forgotten.
//
// An installation's own read-only clients (a brokerage, an exchange) and the
// tables they write are pinned in its *-local.test.mjs beside this file.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// ── 1. The absence stays absent ───────────────────────────────────────────

test("plaid-api.js implements no transfer endpoint", () => {
  const src = read("lib/plaid-api.js");
  // Strip comments first — the file TALKS about /transfer/ at length to explain
  // why it does not implement it, and that prose must not trip the check.
  // lang-regex-ok: stripping JS comment syntax from our own source file.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["/transfer/", "transfer_create", "transfer_authorization", "payment_initiation"]) {
    assert.ok(
      !code.includes(forbidden),
      `plaid-api.js gained "${forbidden}". The Plaid path is read-only BY CONSTRUCTION — ` +
      `see agent/CLAUDE.md § Financial Operations rules 1 and 5. If a transfer capability ` +
      `is genuinely wanted, that is a decision for the user, not a new function.`,
    );
  }
});

test("the read-only intent is stated in the file, so the next reader knows it is deliberate", () => {
  const src = read("lib/plaid-api.js");
  assert.match(src, /transfer/i, "the file should explain the absence, not merely have it");
});

// ── 2. The precheck exemption cannot be forgotten ─────────────────────────

const SEND = read("bin/jori-send-curl");

test("financial and health intents imply --skip-precheck", () => {
  // Keyed on intent, never on message content: inspecting the text to decide
  // whether it looks financial would mean reading the very data we are trying
  // not to expose.
  const block = SEND.slice(SEND.indexOf("Jori-model-only content never reaches the precheck"));
  assert.ok(block.length > 0, "the implication block is missing from jori-send-curl");
  // The patterns are the kernel's generic list plus this installation's
  // accounts (agent/local/config/send-intents.json); the block matches
  // the effective lists, so check those as the script itself loads them.
  assert.match(block, /_intent_in "\$INTENT" "\$PRIVATE_DATA_INTENTS \$PRIVATE_HUM_INTENTS"/);
  const r = spawnSync("bash", ["-c", `${SEND.match(/^DEFAULT_PRIVATE_DATA_INTENTS=[\s\S]*?\n}\n/m)[0]}
_GSC_TOOLS="$1"; _load_send_intents; printf '%s\\n' "$PRIVATE_DATA_INTENTS $PRIVATE_HUM_INTENTS"`, "x", path.join(ROOT)], { encoding: "utf8" });
  const effective = r.stdout.trim().split(/\s+/);
  // Expected: this installation's lists when it has them (full lists, they
  // replace the kernel's), else the kernel defaults.
  const { localConfig } = createRequire(import.meta.url)(path.join(ROOT, "lib", "instance.cjs"));
  const cfg = localConfig("send-intents", {});
  const defaults = (name) => SEND.match(new RegExp(`^${name}="([^"]*)"`, "m"))[1].split(/\s+/);
  const expected = [
    ...(cfg.private_data_intents || defaults("DEFAULT_PRIVATE_DATA_INTENTS")),
    ...(cfg.private_hum_intents || defaults("DEFAULT_PRIVATE_HUM_INTENTS")),
  ];
  assert.ok(expected.some((i) => i.startsWith("health")) && expected.some((i) => i.startsWith("hum:finance")), "the list must cover health and finance");
  for (const intent of expected) {
    assert.ok(effective.includes(intent), `intent pattern "${intent}" is no longer exempted`);
  }
  assert.match(block, /SKIP_PRECHECK=true/);
});

test("the implication is applied BEFORE the precheck runs", () => {
  const implied = SEND.indexOf("Jori-model-only content never reaches the precheck");
  const precheck = SEND.indexOf('if [ "$SKIP_PRECHECK" = false ] && [ -x "$PRECHECK" ]');
  assert.ok(implied > -1 && precheck > -1);
  assert.ok(
    implied < precheck,
    "the intent-implies-exemption block must precede the precheck invocation, or it exempts nothing",
  );
});

test("outbound-precheck does not read the financial or health tables itself", () => {
  // The exemption above stops bank rows being PASSED IN. This asserts the
  // precheck never goes and fetches them on its own — a second route to the
  // same leak, and one no caller could prevent.
  const src = read("bin/outbound-precheck.mjs");
  for (const table of ["plaid_transactions", "plaid_accounts", "plaid_holdings", "health_samples", "health_clinical_records"]) {
    assert.ok(
      !src.includes(table),
      `outbound-precheck.mjs reads ${table}. Jori-model-only data must never enter the precheck's ` +
      `reasoning or its log — see agent/CLAUDE.md § Financial Operations rule 5.`,
    );
  }
});
