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
  assert.match(html, /Around 6:31 to 7:06pm you were near 12\.346, -65\.432, but I didn't capture a label\. Tell me\?/);
  assert.match(html, /Around 6:14 to 6:21pm, were you at <b>Mughlai Curry Cuisine<\/b>, or somewhere else\?/);
});

test("no override -> the deterministic default renders unchanged (markdown)", () => {
  const md = buildMarkdown(bareStopsDay(), {});
  assert.match(md, /Around 6:31 to 7:06pm you were near 12\.346, -65\.432, but I didn't capture a label\./);
});

test("a questions[] override replaces the default (HTML), other stops untouched", () => {
  const skeleton = buildSkeleton(bareStopsDay(), {});
  const html = assemble(skeleton, {
    questions: { "s-20260914-3": "did you visit Dominick again at Bellevue hospital before the show?" },
  });
  assert.match(html, /did you visit Dominick again at Bellevue hospital before the show\?/);
  assert.doesNotMatch(html, /didn't capture a label/);
  // the other unknown_stops entry had no override and keeps its own default
  assert.match(html, /Around 6:14 to 6:21pm, were you at <b>Mughlai Curry Cuisine<\/b>, or somewhere else\?/);
});

test("a questions[] override replaces the default (markdown)", () => {
  const md = buildMarkdown(bareStopsDay(), {
    questions: { "s-20260914-3": "did you visit Dominick again at Bellevue hospital before the show?" },
  });
  assert.match(md, /did you visit Dominick again at Bellevue hospital before the show\?/);
  assert.doesNotMatch(md, /didn't capture a label\./);
  assert.match(md, /Around 6:14 to 6:21pm, were you at Mughlai Curry Cuisine, or somewhere else\?/);
});

test("an override is HTML-escaped, not interpreted as markup", () => {
  const skeleton = buildSkeleton(bareStopsDay(), {});
  const html = assemble(skeleton, {
    questions: { "s-20260914-3": "were you at <b>Bellevue</b> & ok?" },
  });
  assert.match(html, /were you at &lt;b&gt;Bellevue&lt;\/b&gt; &amp; ok\?/);
});

// The default reads like the rest of the email: 12-hour times, names without
// metres, a short list joined the way a person would say it (it used to be
// "~17:21-17:31 — <a bar> (21m), <a café> (37m), ... or somewhere else?").
test("the default question uses 12-hour times and names only", () => {
  const d = bareStopsDay();
  d.unknown_stops = [{ id: "pending-enrich-x", start: "11:51", end: "12:31", lat: 12.3456, lon: -65.4321, hint: null,
    candidates: [{ name: "Cafe One", distance_m: 21 }, { name: "Bar Two", distance_m: 37 }, { name: "Shop Three", distance_m: 7 }] }];
  const html = assemble(buildSkeleton(d, {}), {});
  assert.match(html, /Around 11:51am to 12:31pm, were you at <b>Cafe One<\/b>, <b>Bar Two<\/b> or <b>Shop Three<\/b>, or somewhere else\?/);
  assert.doesNotMatch(html, /\(\d+m\)|~11:51/);
  const md = buildMarkdown(d, {});
  assert.match(md, /- Around 11:51am to 12:31pm, were you at Cafe One, Bar Two or Shop Three, or somewhere else\?/);
});
