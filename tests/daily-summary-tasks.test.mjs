// daily-summary-tasks.test.mjs — a task the user closed on a day must appear in
// that day's summary, at the local time the user closed it (the user, 2026-08-23: "I
// work extensively with google tasks and when I complete a task I mark it as
// complete. Remembering when a task was done is extremely important for me").
//
// Before this, completions were harvested by the AGENT (playbook Step 2.5) and
// had nowhere deterministic to land — no skeleton section, nothing in the stored
// day JSON — so they survived only if the narrator chose to mention them.
//
// Run: node --test tests/daily-summary-tasks.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { selectCompletedTasks } = require(path.join(ROOT, "lib/daily-summary-tasks.js"));
const { buildManifest, buildSkeleton, buildMarkdown } = require(path.join(ROOT, "lib/daily-summary-render.js"));

// Real shapes from `gog tasks list --show-completed --json` (2026-08-23).
const LISTS = [{
  title: "My Tasks",
  tasks: [
    { id: "a", title: "Check new shopapp onboarding", status: "completed",
      completed: "2026-08-23T12:37:03.170Z", due: "2026-08-22T00:00:00.000Z" },
    { id: "b", title: "Fix Alexa good morning", status: "completed",
      completed: "2026-08-23T12:51:11.339Z", due: "2026-08-23T00:00:00.000Z" },
    // Closed at 00:40 UTC on the 24th — which is still the 23rd in home.
    { id: "c", title: "Set up pool robot", status: "completed",
      completed: "2026-08-24T00:40:00.000Z", due: null },
    // Closed the NEXT local day: must not leak into this day's list.
    { id: "d", title: "Tomorrow's task", status: "completed",
      completed: "2026-08-24T16:00:00.000Z", due: null },
    // Still open: never listed.
    { id: "e", title: "Still open", status: "needsAction", due: "2026-08-23T00:00:00.000Z" },
  ],
}];

test("selects only tasks closed on the day, in the day's own timezone", () => {
  const picked = selectCompletedTasks(LISTS, "2026-08-23", "America/New_York");
  assert.deepEqual(picked.map(t => t.id), ["a", "b", "c"]);
  assert.deepEqual(picked.map(t => t.completed_at), ["08:37", "08:51", "20:40"]);
});

test("timezone is the DAY's, not ET — a Paris day splits differently", () => {
  // 12:37Z is 14:37 in Paris; 00:40Z on the 24th is 02:40 on the 24th in Paris,
  // so it belongs to the NEXT day there. Travel must not silently reassign
  // completions to the wrong day.
  const picked = selectCompletedTasks(LISTS, "2026-08-23", "Europe/Paris");
  assert.deepEqual(picked.map(t => t.id), ["a", "b"]);
  assert.equal(picked[0].completed_at, "14:37");
});

test("due date is carried so a late close is visible", () => {
  const picked = selectCompletedTasks(LISTS, "2026-08-23", "America/New_York");
  assert.equal(picked.find(t => t.id === "a").due, "2026-08-22");
});

function dayWith(extra) {
  return {
    date: "2026-08-23", tz: "America/New_York",
    stops: [], travel_legs: [], unmatched_calendar_events: [],
    unknown_stops: [], corrections: [],
    ...extra,
  };
}

// The email shows 12-hour times like every other line in it (2026-10-08).
const render12 = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`; };

test("every closed task ships in the HTML skeleton and the wiki markdown", () => {
  const tasks = selectCompletedTasks(LISTS, "2026-08-23", "America/New_York");
  const day = dayWith({ tasks_completed: tasks });
  const html = buildSkeleton(day);
  const md = buildMarkdown(day, {});
  for (const t of tasks) {
    assert.ok(html.includes(t.title), `HTML missing "${t.title}"`);
    assert.ok(md.includes(t.title), `markdown missing "${t.title}"`);
    assert.ok(html.includes(render12(t.completed_at)), `HTML missing time for "${t.title}"`);
  }
  assert.ok(html.includes("Tasks closed today"));
  assert.ok(md.includes("## Tasks closed today"));
  // Due-date gap is surfaced only when it differs from the closing day.
  assert.ok(html.includes("due 2026-08-22"));
  assert.ok(!html.includes("due 2026-08-23"));
});

test("no closed tasks -> no empty section", () => {
  const html = buildSkeleton(dayWith({ tasks_completed: [] }));
  assert.ok(!html.includes("Tasks closed today"));
});

test("a failed Google Tasks read says so instead of showing nothing", () => {
  const day = dayWith({ tasks_completed: [], tasks_completed_error: "token expired" });
  const html = buildSkeleton(day);
  assert.ok(html.includes("Tasks closed today"));
  assert.ok(html.includes("Couldn't read Google Tasks"));
  assert.ok(buildMarkdown(day, {}).includes("Couldn't read Google Tasks"));
});

test("the manifest exposes the closed tasks to the narrator", () => {
  const tasks = selectCompletedTasks(LISTS, "2026-08-23", "America/New_York");
  const m = buildManifest(dayWith({ tasks_completed: tasks }), {});
  assert.equal(m.tasks_completed.length, 3);
  assert.equal(m.tasks_completed_error, null);
});
