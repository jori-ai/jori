// The daily summary records the photos it could not show (2026-10-17).
//
// Friday Oct 16 shipped twice without its Milk Bakery and August photos:
// `photos embed-uuids` dropped them with a stderr line and nothing else said
// so; the user asked "There are available photos that are missing from this.
// Why?" `daily-summary-build render` now stamps each manifest stop with
// photos_not_shown, read by photosNotShown from embed-uuids' own output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { photosNotShown } = require("../lib/daily-summary-render.js");

const stop = { id: "s-c1", photos: [
  { uuid: "2CC96CED-D0DE-45B1-B83B-4A67D580A526", ts: "2026-10-16T11:28:17.145Z" },
  { uuid: "AAAA0000-0000-0000-0000-000000000000", ts: "2026-10-16T11:30:00Z" },
] };

test("the photos embed-uuids reports dropping are recorded with their time and reason", () => {
  const stderr = "[embed-uuids] thumb failed 2CC96CED-D0DE-45B1-B83B-4A67D580A526: export produced no image file\n"
    + "[embed-uuids] thumb failed FFFF0000-0000-0000-0000-000000000000: not this stop's\n";
  assert.deepEqual(photosNotShown(stop, { status: 0, stderr }), [
    { uuid: "2CC96CED-D0DE-45B1-B83B-4A67D580A526", taken_at: "2026-10-16T11:28:17.145Z", reason: "export produced no image file" },
  ]);
});

test("a clean embed records nothing, a failed or timed-out one records every photo", () => {
  assert.deepEqual(photosNotShown(stop, { status: 0, stderr: "" }), []);
  assert.equal(photosNotShown(stop, { status: 1, stderr: "boom" }).length, 2);
  assert.equal(photosNotShown(stop, { status: null, stderr: "" }).length, 2);
  assert.deepEqual(photosNotShown({ id: "x", photos: [] }, { status: 0, stderr: "x" }), []);
});
