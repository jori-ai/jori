// p1-task-one-per-thread.test.mjs — one P1 thread, one task (2026-10-17).
//
// Two "new mail" notices on one thread once became two identical Google
// Tasks, and the day's summary listed the same title twice. A later email on a thread with an open task reuses it, and the day's
// closed-task list shows one line per P1 thread and title.
//
// Run: node --test tests/p1-task-one-per-thread.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openTaskForThread, taskMarker } = require("../lib/p1-task.js");
const { selectCompletedTasks } = require("../lib/daily-summary-tasks.js");

const THREAD = "thread-one";
const task = (id, title, msg, extra = {}) => ({ id, title, notes: taskMarker(THREAD, msg), status: "needsAction", ...extra });

test("a thread with an open task gets that task back, not a second one", () => {
  const open = [task("A", "Check new mail at Northgate mailbox 7", "m1"), { id: "B", title: "Other", notes: "x" }];
  assert.equal(openTaskForThread(open, THREAD).id, "A");
  assert.equal(openTaskForThread(open, "another-thread"), null);
  assert.equal(openTaskForThread([task("A", "t", "m1", { status: "completed" })], THREAD), null, "a closed task is not reused");
  assert.equal(openTaskForThread(open, null), null);
});

test("the day's closed tasks list one line per P1 thread and title", () => {
  const done = (id, msg, at) => task(id, "Check new mail at Northgate mailbox 7", msg, { status: "completed", completed: at });
  const lists = [{ title: "My Tasks", tasks: [
    done("TVBM", "msg-two", "2026-10-16T20:39:09.474Z"),
    done("YzFx", "msg-three", "2026-10-16T20:39:11.113Z"),
    { id: "solo", title: "Check new mail at Northgate mailbox 7", status: "completed", completed: "2026-10-16T18:00:00Z" },
  ] }];
  const out = selectCompletedTasks(lists, "2026-10-16", "Asia/Jerusalem");
  assert.deepEqual(out.map(t => t.id), ["solo", "TVBM"], "a task without our marker is never merged");
  assert.deepEqual(out[1].also_ids, ["YzFx"]);
});

test("a later closing on the same thread keeps its own line", () => {
  const done = (id, at) => ({ id, title: "Check new mail at Northgate mailbox 7", status: "completed", completed: at,
                              notes: taskMarker(THREAD, id) });
  const out = selectCompletedTasks([{ title: "My Tasks", tasks: [
    done("morning", "2026-10-16T06:00:00Z"), done("evening", "2026-10-16T18:00:00Z")] }], "2026-10-16", "Asia/Jerusalem");
  assert.deepEqual(out.map(t => t.id), ["morning", "evening"]);
});
