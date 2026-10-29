// daily-summary-question-override.test.mjs — an unlabeled stop's follow-up
// question can be overridden with a context-aware hypothesis instead of the
// deterministic coordinate/candidates default.
//
// The incident: the 2026-09-14 summary's unlabeled 6:31-7:06pm stop sat
// exactly at Bellevue Hospital's coordinates, on a day whose Tasks-closed
// list was wall-to-wall Dominic-mugging/hospital emails, right before that
// night's show — and still shipped "but I didn't capture a label. Tell me?"
// the user: "the question should have been 'did you visit Dominick again at
// Bellevue hospital before the show?' — an LLM based phrasing instead of our
// automatic multiple choice."
//
// The fix keeps the "which stops appear, what data they carry" decision
// code-owned (Rule 0b: code owns geometry) while letting the daily-summary
// agent's Step 4.2 prose pass supply the SENTENCE (a model owns language) via
// a new `questions[<unknown_stop.id>]` prose slot. No override -> unchanged
// deterministic default, in both the HTML and wiki-markdown renderers.
//
// Run: node --test tests/daily-summary-question-override.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildSkeleton, buildMarkdown, assemble } = require(path.join(ROOT, "lib/daily-summary-render.js"));

function bareStopsDay() {
  return {
    date: "2026-09-14", tz: "America/New_York",
    wake: null, sleep: null,
    stops: [],
    travel_legs: [],
    unmatched_calendar_events: [],
    corrections: [],
    unknown_stops: [
      {
        id: "s-20260914-3", start: "18:31", end: "19:06",
        lat: 12.345600, lon: -65.432100, hint: null, candidates: [],
      },
      {
        id: "s-20260914-2", start: "18:14", end: "18:21",
        lat: 12.345977, lon: -65.437370, hint: null, // kernel-guard-ok: synthetic fixture coordinates offset from 12.3456, -65.4321
        candidates: [{ name: "Mughlai Curry Cuisine", distance_m: 57 }],
      },
    ],
  };
}

test("no override -> the deterministic default renders unchanged (HTML)", () => {
  const skeleton = buildSkeleton(bareStopsDay(), {});
  assert.match(skeleton, /\{\{QUESTION:s-20260914-3:/);
  const html = assemble(skeleton, {});
  assert.match(html, /~18:31-19:06 near 12\.346, -65\.432, but I didn't capture a label\. Tell me\?/);
  assert.match(html, /Mughlai Curry Cuisine<\/b> \(57m\), or somewhere else\?/);
});

test("no override -> the deterministic default renders unchanged (markdown)", () => {
  const md = buildMarkdown(bareStopsDay(), {});
  assert.match(md, /~18:31-19:06 near 12\.346, -65\.432, but I didn't capture a label\./);
});

test("a questions[] override replaces the default (HTML), other stops untouched", () => {
  const skeleton = buildSkeleton(bareStopsDay(), {});
  const html = assemble(skeleton, {
    questions: { "s-20260914-3": "did you visit Dominick again at Bellevue hospital before the show?" },
  });
  assert.match(html, /did you visit Dominick again at Bellevue hospital before the show\?/);
  assert.doesNotMatch(html, /didn't capture a label/);
  // the other unknown_stops entry had no override and keeps its own default
  assert.match(html, /Mughlai Curry Cuisine<\/b> \(57m\), or somewhere else\?/);
});

test("a questions[] override replaces the default (markdown)", () => {
  const md = buildMarkdown(bareStopsDay(), {
    questions: { "s-20260914-3": "did you visit Dominick again at Bellevue hospital before the show?" },
  });
  assert.match(md, /did you visit Dominick again at Bellevue hospital before the show\?/);
  assert.doesNotMatch(md, /didn't capture a label\./);
  assert.match(md, /Mughlai Curry Cuisine \(57m\), or somewhere else\?/);
});

test("an override is HTML-escaped, not interpreted as markup", () => {
  const skeleton = buildSkeleton(bareStopsDay(), {});
  const html = assemble(skeleton, {
    questions: { "s-20260914-3": "were you at <b>Bellevue</b> & ok?" },
  });
  assert.match(html, /were you at &lt;b&gt;Bellevue&lt;\/b&gt; &amp; ok\?/);
});
