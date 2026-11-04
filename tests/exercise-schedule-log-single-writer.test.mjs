// Regression guard — exercise-log-double-write.
//
// Defends against: every line in data/logs/exercise-schedule.log being
// written TWICE, which silently doubles any occurrence count read off that
// log — including the counts the system-issue-review pass uses as evidence.
//
// HOW IT BROKE. Two correct changes collided. First log() was given an
// fs.appendFileSync(LOG_FILE) sink in ADDITION to stderr, because the script
// then ran inside an ops-agent turn where stderr vanished into a transcript.
// Later the script was moved OUT of the agent turn:
// trigger-exercise-schedule.sh now runs it as `exercise-schedule "$@" >>
// "$LOGFILE" 2>&1`, redirecting stderr into the very same file. Two writers,
// one file. The tell in the log is that the trigger's own shell log() (file
// only) appears once per run while every ISO-stamped script line appears twice.
//
// THE CONTRACT. The caller that is already capturing our stderr into LOG_FILE
// declares it by exporting EXERCISE_SCHEDULE_STDERR_TO_LOG=1; log() then skips
// its own append. stderr is deliberately the surviving writer, because the
// redirect also captures uncaught-exception stack traces that never reach
// log(). The append MUST stay for the agent-invoked entry points
// (--reschedule from the hum harvester and chat-agent, --record-response),
// which still run inside a turn and have no other durable sink.
//
// WHY SOURCE INSPECTION. Same reason as
// exercise-schedule-calendar-fallback.test.mjs: bin/exercise-schedule is
// a standalone CLI, not a module — log() is not exported, and running it for
// real reaches the calendar. These assertions pin the guard's presence and its
// position relative to the append, which is the part that regressed.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "bin/exercise-schedule");
const TRIGGER = path.join(ROOT, "agent/scripts/trigger-exercise-schedule.sh");

const script = fs.readFileSync(SCRIPT, "utf8");
const trigger = fs.readFileSync(TRIGGER, "utf8");

const MARKER = "EXERCISE_SCHEDULE_STDERR_TO_LOG";

test("the trigger declares that it is already capturing stderr into the log", () => {
  assert.ok(
    new RegExp(`export\\s+${MARKER}=1`).test(trigger),
    `trigger-exercise-schedule.sh stopped exporting ${MARKER}=1. It still redirects the ` +
      "script's stderr into the log file, so without the marker every line is written twice."
  );
  assert.ok(
    trigger.includes('>> "$LOGFILE" 2>&1'),
    "the trigger no longer redirects the script's stderr into $LOGFILE. If that is " +
      `deliberate, the ${MARKER} export must go too — otherwise the run leaves no on-disk trace at all.`
  );
  const exportAt = trigger.search(new RegExp(`export\\s+${MARKER}=1`));
  const runAt = trigger.indexOf('"$JORI_INSTALL_TOOLS/bin/exercise-schedule"');
  assert.ok(exportAt > -1 && runAt > -1 && exportAt < runAt,
    "the marker must be exported BEFORE the script is invoked, or the child never sees it");
});

test("log() honours the marker by skipping its own append", () => {
  assert.ok(script.includes(MARKER), `bin/exercise-schedule no longer reads ${MARKER}`);
  const guardAt = script.indexOf(`if (STDERR_ALREADY_LOGGED) return;`);
  const appendAt = script.indexOf("fs.appendFileSync(LOG_FILE, line)");
  assert.notEqual(guardAt, -1, "the STDERR_ALREADY_LOGGED early-return is gone from log()");
  assert.notEqual(appendAt, -1, "log() stopped appending to LOG_FILE entirely — see the sibling " +
    "calendar-fallback guard: the agent-invoked entry points have no other durable sink");
  assert.ok(guardAt < appendAt,
    "the marker guard must sit BEFORE the append, otherwise it suppresses nothing");
});

test("stderr stays the surviving writer", () => {
  const stderrAt = script.indexOf("process.stderr.write(line)");
  const guardAt = script.indexOf(`if (STDERR_ALREADY_LOGGED) return;`);
  assert.notEqual(stderrAt, -1, "log() stopped writing to stderr");
  assert.ok(stderrAt < guardAt,
    "the guard must not skip the stderr write. stderr is the writer we keep on the cron path " +
      "because the caller's redirect also captures uncaught-exception stack traces, which log() never sees."
  );
});

test("the dry-run trace-free rule still comes first", () => {
  const dryAt = script.indexOf("if (DRY_RUN) return;");
  const guardAt = script.indexOf(`if (STDERR_ALREADY_LOGGED) return;`);
  assert.ok(dryAt > -1 && dryAt < guardAt,
    "the DRY_RUN early-return must stay ahead of the marker guard so a dry run still leaves no trace on disk");
});
