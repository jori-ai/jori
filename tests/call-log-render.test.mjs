// call-log-render.test.mjs — this installation's daily-summary renderer prints the
// call log's lines (lib/daily-summary-render.js; the log itself is tests/call-log.test.mjs).
// Run: node --test tests/call-log-render.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CL = await import(path.join(ROOT, "lib/call-log.mjs"));
const R = createRequire(import.meta.url)(path.join(ROOT, "lib/daily-summary-render.js"))._internal;

const entry = { uuid: "u1", start: "2026-10-23T14:31:30Z", end: "2026-10-23T15:16:12Z", minutes: 45, tz: "Europe/Berlin",
  local_date: "2026-10-23", status: "logged", guests: [{ name: "Sam Rivers", email: null, minutes: 43 }],
  log: { title: "The user demos their AI assistant", summary: "The user showed Sam the assistant, and its wiki.", points: ["Local assistant versus cloud"],
    next_steps_others: [], people: [{ participant: "Sam Rivers", wiki_id: "user_samuel_rivers", name: "Samuel Rivers" }] } };

test("the renderer prints the AI note and links the person in the day page", () => {
  const [call] = CL.callsForSummary({ calls: { [entry.uuid]: entry } }, { date: "2026-10-23", tz: "Europe/Berlin" });
  const day = { tz: "Europe/Berlin", stops: [], calls: [call] };
  const p = R.callParts(day, call);
  assert.equal(p.title, "Call with Samuel Rivers");
  assert.equal(p.meta, "from Zoom's AI summary");
  assert.ok(R.callItemHtml(day, call).includes("Local assistant versus cloud"));
  const md = R.callLineMd(day, call);
  assert.ok(md.includes("Call with [[user_samuel_rivers|Samuel Rivers]]"));
  assert.ok(md.includes("from Zoom's AI summary"));
  // a recurring-meeting call (a `who`, no AI note) is printed as before
  const o = { who: "Alex", source: "zoom", start: "2026-10-23T20:00:00Z", end: "2026-10-23T20:30:00Z", minutes: 30, status: "held" };
  assert.equal(R.callParts(day, o).meta, "");
  assert.ok(R.callLineMd(day, o).includes("Call with Alex"));
});

