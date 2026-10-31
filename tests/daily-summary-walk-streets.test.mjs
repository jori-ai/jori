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

// ── a routed detour the stops' minutes cannot hold ──────────────────────────
//
// A short walk between two stops 245 m apart, with no fix on the way, was
// routed at 408 m. The line prints the minutes between the stops (3), so it read
// "Walked 0.3 miles" in 3 minutes, 8 km/h. With no fix on the way the route is
// a guess; over those minutes the straight line is a walk and the route is not,
// so the straight line is the distance. A walk the fixes traced keeps its own.

{
const bakery = { id: "s-2", end: "11:31", start_ts_ms: U("09:07:00"), end_ts_ms: U("09:31:00"), tz: TZ };
const home = { id: "s-3", start: "11:34", start_ts_ms: U("09:34:00"), end_ts_ms: U("10:44:00"), tz: TZ };
const spineDay = (leg) => ({ date: "2099-03-08", tz: TZ, path: { segments: [], spine: [
  { type: "dwell", id: "d1", start_ms: U("09:09:00"), end_ms: U("09:36:00") },
  { type: "leg", id: "l1", mode: "walking", geometry: "map_matched", start_ms: U("09:36:00"), end_ms: U("09:40:00"),
    routed_m: 408, straight_m: 245, walked_m: 408, fixes: 0, streets: ["Rua Primeira", "Rua Segunda"], ...leg },
  { type: "dwell", id: "d2", start_ms: U("09:40:00"), end_ms: U("10:46:00") },
] } });

test("a routed walk too long for the minutes between the stops prints the straight line", () => {
  const line = text(movementHtml(spineDay({}), bakery, home));
  assert.match(line, /Walked 0\.2 miles along Rua Primeira and Rua Segunda, about 3 min\./);
  const acc = { m: 0 };
  movementHtml(spineDay({}), bakery, home, acc);
  assert.equal(acc.m, 245, "the header sums what the line prints");
});

test("a straight line that is no walk either keeps the route and drops the minutes", () => {
  const line = text(movementHtml(spineDay({ straight_m: 400 }), bakery, home));
  assert.match(line, /Walked 0\.3 miles along Rua Primeira and Rua Segunda\./);
  assert.doesNotMatch(line, /about/);
});

test("a walk the fixes traced keeps its routed distance", () => {
  const line = text(movementHtml(spineDay({ fixes: 6 }), bakery, home));
  assert.match(line, /Walked 0\.3 miles along Rua Primeira and Rua Segunda\./);
  assert.doesNotMatch(line, /about/);
  const legacy = text(movementHtml(spineDay({ fixes: undefined }), bakery, home));
  assert.match(legacy, /Walked 0\.3 miles/, "a leg with no fix count is not assumed unwitnessed");
});

test("kill switch: JORI_WALK_GAP_STRAIGHT=0 keeps the route", () => {
  process.env.JORI_WALK_GAP_STRAIGHT = "0";
  try {
    const line = text(movementHtml(spineDay({}), bakery, home));
    assert.match(line, /Walked 0\.3 miles along Rua Primeira and Rua Segunda\./);
  } finally { delete process.env.JORI_WALK_GAP_STRAIGHT; }
});
}
