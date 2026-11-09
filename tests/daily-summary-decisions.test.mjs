// daily-summary-decisions.test.mjs — the "Decisions" section: a deterministic
// list an installation's lib/_ext/day-decisions.mjs hook fills (resolved.decisions),
// printed like "Tasks closed today" so the narrator cannot drop it.
//
// Run: node --test tests/daily-summary-decisions.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildManifest, buildSkeleton, buildMarkdown } = require(path.join(ROOT, "lib/daily-summary-render.js"));
const { factPack } = require(path.join(ROOT, "lib/daily-summary-review.js"));

function dayWith(extra) {
  return {
    date: "2026-08-23", tz: "Etc/UTC",
    stops: [], travel_legs: [], unmatched_calendar_events: [],
    unknown_stops: [], corrections: [],
    ...extra,
  };
}
const DECISIONS = [
  { area: "Area one", line: "You chose option A over option B.", source: "you in chat" },
  { area: null, line: "A second decision without an area.", source: null },
];

test("each decision ships in the HTML skeleton and the wiki markdown", () => {
  const day = dayWith({ decisions: DECISIONS });
  const html = buildSkeleton(day);
  const md = buildMarkdown(day, {});
  assert.ok(html.includes(">Decisions</h2>"));
  assert.ok(md.includes("## Decisions"));
  for (const d of DECISIONS) {
    assert.ok(html.includes(d.line), `HTML missing "${d.line}"`);
    assert.ok(md.includes(d.line), `markdown missing "${d.line}"`);
  }
  assert.ok(html.includes("<b>Area one</b>"));
  assert.ok(md.includes("**Area one** · You chose option A over option B. · you in chat"));
});

test("no decisions and no error -> no section", () => {
  assert.ok(!buildSkeleton(dayWith({ decisions: [] })).includes(">Decisions</h2>"));
  assert.ok(!buildSkeleton(dayWith({})).includes(">Decisions</h2>"));
  assert.ok(!buildMarkdown(dayWith({}), {}).includes("## Decisions"));
});

test("a failed read says 'not captured' instead of showing nothing", () => {
  const day = dayWith({ decisions: [], decisions_error: "positions: timeout" });
  const html = buildSkeleton(day);
  assert.ok(html.includes(">Decisions</h2>"));
  assert.ok(html.includes("Decisions not captured"));
  assert.ok(buildMarkdown(day, {}).includes("Decisions not captured"));
});

test("the manifest and the review's fact pack carry the decisions", () => {
  const m = buildManifest(dayWith({ decisions: DECISIONS }), {});
  assert.equal(m.decisions.length, 2);
  assert.equal(m.decisions[0].line, DECISIONS[0].line);
  assert.equal(m.decisions_error, null);
  const pack = factPack({ date: "2026-08-23", manifest: m, day: dayWith({ decisions: DECISIONS }), statements: {}, corrections: [] });
  const text = Array.isArray(pack) ? pack.join("\n") : JSON.stringify(pack);
  assert.ok(text.includes("DECISIONS THAT DAY"));
  assert.ok(text.includes("You chose option A over option B."));
});
