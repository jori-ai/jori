// daily-summary-walk-streets.test.mjs — the streets that name a walk come from
// path segments inside that walk.
//
// The shape: a 41-minute walk from a café home along the waterfront printed
// "Walked 1.3 miles around <A> and <B>". The two streets were the first of a
// path segment that began at the flat an hour before this walk, so they named
// the walk TO the café. A segment mostly before the walk no longer names it;
// one inside it still does; JORI_WALK_STREETS_INSIDE=0 restores the old names.
// Street names are invented.
//
// Run: node --test tests/daily-summary-walk-streets.test.mjs

import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { movementHtml } = require("../lib/daily-summary-render.js")._internal;

const TZ = "Etc/GMT-2"; // UTC+2
const U = (hms) => Date.parse(`2099-03-08T${hms}Z`);
const text = (html) => html.replace(/<[^>]+>/g, ""); // lang-regex-ok: strips our own HTML tags
const cafe = { id: "s-a1", end: "17:02", end_ts_ms: U("15:02:00"), tz: TZ };
const flat = { id: "s-p2", start: "17:43", start_ts_ms: U("15:43:00"), tz: TZ };
const segment = (start, end, streets) => ({ start_ms: U(start), end_ms: U(end), streets,
  legs: [{ t0: U(start), t1: U(end), m: 2400 }] });
const day = (segments) => ({ date: "2099-03-08", tz: TZ, path: { spine: [], segments } });

const OUT_AND_ALONG = ["Rua Primeira", "Rua Segunda", "Travessa Terceira", "Largo Quarto", "Rua Quinta", "Cais Sexto"];

test("a segment mostly before the walk does not name it", () => {
  const line = text(movementHtml(day([segment("14:01:00", "15:28:00", OUT_AND_ALONG)]), cafe, flat));
  assert.match(line, /Walked \d\.\d miles, about 41 min\./);
  assert.doesNotMatch(line, /around/);
});

test("a segment inside the walk still names it", () => {
  const line = text(movementHtml(day([segment("15:03:00", "15:40:00", ["Cais Sexto", "Rua Quinta"])]), cafe, flat));
  assert.match(line, /around Cais Sexto and Rua Quinta/);
});

test("kill switch: JORI_WALK_STREETS_INSIDE=0 restores the old names", () => {
  process.env.JORI_WALK_STREETS_INSIDE = "0";
  try {
    const line = text(movementHtml(day([segment("14:01:00", "15:28:00", OUT_AND_ALONG)]), cafe, flat));
    assert.match(line, /around Rua Primeira and Rua Segunda/);
  } finally { delete process.env.JORI_WALK_STREETS_INSIDE; }
});
