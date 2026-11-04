# Daily summary fix — replies to the summary's questions

The daily summary asks its questions before the email goes out (the user, 2026-10-20:
*"these questions should come before the summary is sent, not after"*). Either the
daily-summary run (a stop it couldn't name, who was there, a photo that contradicts a
stop) or the fix loop (`ops-agent/jobs/daily-summary-fix.md`, when the reviewer did not
confirm the day) asks in chat with a message that starts
`📝 Fixing your <Weekday> summary:`, and the day goes `awaiting_<owner_id>`. The email is
held until the user has answered or the answer window closes: 11am the user's time the next morning
(3 hours when asked later in the day). The first question says so to the user. A question
that only came up after the email went out says that instead, and holds only the
correction.

## When the user's reply is the answer

1. Identify the date: `ls ~/Dev/jori/data/daily-summary-fix/` and
   `~/Dev/jori/bin/daily-summary-fix status <date>` (the one `awaiting_<owner_id>`
   whose question matches what the user is answering).
2. `~/Dev/jori/bin/daily-summary-fix request <date> --answer "<the user's reply verbatim>"`.
   That queues the fixer (launchd `ai.claude.daily-summary-fix`); it applies the user's words,
   marks the questions they settle, and sends the summary once nothing is left open (or
   the window has closed). Several replies in a row are fine: pass each one.
3. Ack in one short line, in the user's terms ("Got it, I'll finish Monday's summary and send
   it over"). Do not say "queued", "dispatched" or similar.

## When the user wants it now

"Just send it", "send it as is", "skip the questions": end the wait.

```bash
~/Dev/jori/bin/daily-summary-fix release <date> [--reason "<the user's words>"]
```

The fixer sends the best version; whatever is still open is listed at the end of the
email, and a later answer still gets one correction. Ack in one line.

## When the user asks where the summary is

`~/Dev/jori/bin/daily-summary-fix gate <date> --peek` says whether it is held
(exit 3), which questions are open and until when (`hold_until_local`). Always pass
`--peek`: without it the check parks the day, which is the fixer's call. Tell the user in the user's
terms ("It's waiting on the Teddy Stadium question; it goes out at 11am either way"),
and offer to send it now.

## What not to do

- Don't run `findme resolve`, `location-confirm` or edit the summary yourself for that
  day: the fixer does it, so the fix, the rebuild and the email's closing section stay
  consistent.
- Don't decide the answer for the user from the question's suggested option; pass the user's words.
- Don't run `daily-summary-fix answered`: which questions the user's words settle is the
  fixer's reading.
- A safety net exists: the hourly `daily-summary-fix sweep` starts the fixer when the
  answer window closes, and the fixer reads the user's messages itself, so an answer you miss
  is applied by then at the latest; after the email has gone, the sweep wakes a day still
  waiting on the user once the user has written since the question (at most every 6 hours). A
  missed routing delays the fix; it doesn't lose it, and nothing holds the email past
  the window.
