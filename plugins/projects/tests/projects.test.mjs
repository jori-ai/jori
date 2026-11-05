// projects: the managed block, a new page, and the calendar/tasks readers.
// Run: node --test plugins/projects/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pr = require(path.join(DIR, "lib", "projects.js"));

const SECTION = "## Goal\nShip it.\n\n## What you might need\n- A date.\n";
const DAY = Date.parse("2026-11-05T15:00:00Z");

test("renderBlock appends once, then replaces in place; text outside the block is kept", () => {
  const page = "---\nname: X\n---\n# X\n\nWhat the page already said.\n";
  const once = pr.renderBlock(page, { section: SECTION, status: "active", today: DAY });
  assert.ok(once.startsWith(page.trimEnd()));
  assert.equal(once.split(pr.SECTION_START).length, 2);
  const twice = pr.renderBlock(once, { section: SECTION.replace("Ship it.", "Ship it soon."), status: "paused", today: DAY });
  assert.equal(twice.split(pr.SECTION_START).length, 2);
  assert.ok(twice.includes("Ship it soon.") && !twice.includes("Ship it.\n"));
  assert.ok(twice.includes("· paused ·"));
  assert.ok(twice.includes("What the page already said."));
  assert.ok(pr.currentBlock(twice).startsWith("## Goal\nShip it soon."), "show prints the sections, not the facts line");
  assert.equal(pr.renderBlock(twice, { section: pr.currentBlock(twice), status: "paused", today: DAY }), twice, "show → write-section round-trips");
});

test("a section without the two required headings, or with the markers, is refused", () => {
  assert.throws(() => pr.renderBlock("", { section: "## Goal\nx", status: "active" }), /What you might need/);
  assert.throws(() => pr.renderBlock("", { section: `${SECTION}${pr.SECTION_END}`, status: "active" }), /markers/);
  assert.throws(() => pr.renderBlock("", { section: SECTION, status: "someday" }), /status/);
});

test("newPage writes project frontmatter and the block; ids are project_<ascii>", () => {
  const raw = pr.newPage({ id: "project_kitchen", name: "Kitchen redo", description: "Redoing the kitchen", scope: "home", intro: "Intro.", section: SECTION, status: "upcoming", today: DAY });
  assert.ok(raw.includes("entity: project\n") && raw.includes("project_status: upcoming\n") && raw.includes("scope: [projects, home]"));
  assert.ok(raw.includes("# Kitchen redo\n\nIntro.\n"));
  assert.ok(raw.includes(pr.SECTION_START));
  assert.throws(() => pr.newPage({ id: "Kitchen", name: "a", description: "b", section: SECTION, status: "active" }), /id must be/);
});

test("readCalendar skips holiday and excluded calendars, cancelled events, and collapses a series", () => {
  const calls = [];
  const fake = (args) => {
    calls.push(args.slice(0, 3).join(" "));
    if (args[1] === "calendars") return [
      { id: "me", summary: "Personal" },
      { id: "en.example#holiday", summary: "Holidays" },
      { id: "wx", summary: "Weather" },
    ];
    return [
      { summary: "Standup", recurringEventId: "s", start: { dateTime: "2026-11-02T09:00:00-05:00" } },
      { summary: "Standup", recurringEventId: "s", start: { dateTime: "2026-11-09T09:00:00-05:00" } },
      { summary: "Flight", start: { dateTime: "2026-11-20T10:00:00-05:00" }, attendees: [{ self: true, email: "me" }, { displayName: "Sam" }] },
      { summary: "Dropped", status: "cancelled", start: { date: "2026-11-21" } },
    ];
  };
  const cfg = { ...pr.DEFAULTS, exclude_calendars: ["Weather"] };
  const r = pr.readCalendar(cfg, DAY, fake);
  assert.deepEqual(r.calendars, ["Personal"]);
  assert.equal(calls.filter((c) => c.startsWith("calendar events")).length, 1);
  assert.equal(r.events.length, 2);
  const standup = r.events.find((e) => e.title === "Standup");
  assert.equal(standup.occurrences, 2);
  assert.equal(standup.last_start, "2026-11-09T09:00:00-05:00");
  assert.deepEqual(r.events.find((e) => e.title === "Flight").attendees, ["Sam"]);
});

test("readTasks keeps open tasks and recently completed ones only", () => {
  const fake = (args) => {
    if (args[1] === "lists") return [{ id: "L1", title: "My Tasks" }];
    return [
      { title: "Book hotel", status: "needsAction", due: "2026-11-20T00:00:00.000Z" },
      { title: "Old thing", status: "completed", completed: "2025-01-01T00:00:00.000Z" },
      { title: "Sent deposit", status: "completed", completed: "2026-10-30T00:00:00.000Z" },
      { title: "Gone", deleted: true },
    ];
  };
  const r = pr.readTasks(pr.DEFAULTS, DAY, fake);
  assert.deepEqual(r.tasks.map((t) => `${t.title}:${t.status}`), ["Book hotel:open", "Sent deposit:completed"]);
  assert.equal(r.tasks[0].due, "2026-11-20");
});

test("gather records a failing source under errors and keeps the rest", () => {
  const fake = (args) => { if (args[0] === "tasks") throw new Error("no auth"); return []; };
  const ws = { listPages: () => [], getPage: () => null, recentlyUpdated: () => [] };
  const b = pr.gather({ now: DAY, cfg: pr.DEFAULTS, gog: fake, ws });
  assert.equal(b.tasks, null);
  assert.match(b.errors.tasks, /no auth/);
  assert.deepEqual(b.calendar.events, []);
  assert.deepEqual(b.wiki.projects, []);
});
