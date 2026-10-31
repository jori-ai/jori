// hum-dedup-regression.test.mjs — regression fixtures for the two same-topic
// duplicate-ping bug shapes:
//
//   Shape 1 — "task sibling double-ping".
//     Two ideas derived from the SAME Google Task. The first was consumed;
//     nothing blocked generation/firing of the second nine hours later. Three
//     mechanisms now stop it:
//       (a) hum-ideation Rule 9 — task-ID block (consumed-sibling dedup)
//       (b) hum.md Step 4a    — sibling sweep (consume siblings on the same task_id)
//       (c) outbound-precheck — criterion (d), wiki delegation signal ("Person X
//                               does Action Y" → suppress a ping asking the user
//                               to coordinate about Y)
//
//   Shape 2 — "birthday double-ping".
//     "X's birthday is Tuesday" and "X's birthday is tomorrow" derived from the
//     same calendar event, had different IDs and no task_id, and fired 5h19m
//     apart — the first OUTSIDE the then-4h precheck transcript window. Three
//     mechanisms now stop it:
//       (a) hum-ideas-append Rule 1 — near-duplicate refusal against ALL
//           currently-unconsumed reservoir ideas (not just consumed-in-48h)
//       (b) outbound-precheck — 8h transcript lookback (was 4h) + a same-day ping
//           log (local midnight → now), independent of the transcript window
//       (c) outbound-precheck — criterion (e), same-topic same-day ping = suppress
//           even without a recorded reaction
//
// This file pins each mechanism so a future edit that shrinks the lookback back
// to 4h, drops a suppress criterion, removes the sibling sweep, or narrows a
// dedup rule re-opens a failing test instead of silently re-opening the bug.
//
// Run: node --test tests/hum-dedup-regression.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IDEATION = join(ROOT, "agent/ops-agent/jobs/hum-ideation.md");
const HUM = join(ROOT, "agent/ops-agent/jobs/hum.md");
const PRECHECK = join(ROOT, "bin/outbound-precheck.mjs");

// NOTE: these are mechanism fixtures — they pin the dedup CODE/PLAYBOOK rules, not
// live reservoir state. An earlier draft also hard-asserted "no two unconsumed
// reservoir ideas share a task_id", but that's wrong as a regression gate: hum-
// ideation Rule 1 explicitly PERMITS two unconsumed siblings on the same task_id
// when their why_now documents a different angle, and pre-fix stale ideas would
// fail it forever. Live-reservoir hygiene belongs to hum-review, not here.

// ───────────────────────────── Shape 1: task siblings ────────────────────────

test("Shape 1a — hum-ideation Rule 9 task-ID block survives", () => {
  const md = readFileSync(IDEATION, "utf8");
  assert.match(
    md,
    /Task-ID block.*consumed-sibling dedup/i,
    "Rule 9 (task-ID block) header is gone — the task-sibling double-ping fix",
  );
  assert.match(
    md,
    /task_ids_blocked/,
    "Rule 9 no longer references task_ids_blocked (built in Step 1.5)",
  );
  assert.match(
    md,
    /resolved_task_ids/,
    "Rule 9 no longer cross-checks resolved_task_ids (from hum-resolved-topics.jsonl)",
  );
});

test("Shape 1b — hum.md Step 4a sibling sweep survives", () => {
  const md = readFileSync(HUM, "utf8");
  assert.match(
    md,
    /Sibling sweep.*task-ID dedup/i,
    "Step 4a sibling sweep header is gone — consumed-sibling cascade for the same task_id",
  );
  // The consume marker must carry the sibling-sweep reason so the cascade is auditable.
  assert.match(
    md,
    /consume_reason"\s*:\s*"sibling-sweep:task_id:/,
    "sibling-sweep consume marker shape changed — siblings on the same task_id won't be cascaded-consumed",
  );
});

test("Shape 1c — outbound-precheck wiki-delegation suppress signal survives", () => {
  const js = readFileSync(PRECHECK, "utf8");
  // Criterion (d): a documented delegation ("Person X does Action Y") suppresses
  // a ping asking the user to coordinate about Y.
  assert.match(
    js,
    /delegation signal/i,
    "precheck dropped the 'delegation signal' suppress concept",
  );
});

// ───────────────────────────── Shape 2: birthday dup ─────────────────────────

test("Shape 2a — near-duplicates of UNCONSUMED reservoir ideas are refused in code", () => {
  // The fix moved from a prose "≥3 shared keywords vs unconsumed_keyword_sets"
  // rule into hum-ideas-append: the only writer embeds each new subject and
  // refuses it when it is too close to a live unconsumed idea (Rule 1) — word
  // overlap was arithmetic on language (Rule #0b) and missed exactly the
  // birthday paraphrase. Pin that the gate
  // still exists and still reads the unconsumed corpus.
  const append = readFileSync(new URL("../bin/hum-ideas-append", import.meta.url), "utf8");
  assert.match(append, /rule-1-near-duplicate/, "hum-ideas-append lost the Rule 1 near-duplicate refusal");
  assert.match(append, /digest\.unconsumed/, "Rule 1 no longer compares against the unconsumed reservoir");
  const md = readFileSync(IDEATION, "utf8");
  assert.match(md, /hum-ideas-append/, "hum-ideation no longer routes writes through hum-ideas-append");
});

test("Shape 2b — outbound-precheck transcript lookback is ≥8h (not back to 4h)", () => {
  const js = readFileSync(PRECHECK, "utf8");
  // The 4h window let the first birthday ping fall outside the lookback when the
  // second fired 5h19m later. The window was widened to 8h. Pin the constant.
  assert.match(
    js,
    /8\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    "precheck transcript lookback is no longer 8h — a regression to 4h re-opens the birthday gap",
  );
  assert.doesNotMatch(
    js,
    /const since = new Date\(Date\.now\(\) - 4 \* 60 \* 60 \* 1000\)/,
    "precheck transcript lookback reverted to 4h",
  );
});

test("Shape 2c — outbound-precheck same-day ping log + criterion (e) survive", () => {
  const js = readFileSync(PRECHECK, "utf8");
  // A same-day ping log keyed to the local (instance-zone) calendar day,
  // independent of the transcript lookback window.
  assert.match(
    js,
    /local midnight/i,
    "precheck dropped the local-midnight same-day boundary for the daily ping log",
  );
  assert.match(
    js,
    /already sent TODAY/i,
    "precheck dropped the 'pings already sent TODAY' same-day dedup context block",
  );
  // Criterion (e): same-topic same-day = suppress even without a reaction.
  assert.match(
    js,
    /same topic.*same day|same-topic same-day/i,
    "precheck dropped suppress criterion (e) — same-topic same-day duplicate",
  );
});
