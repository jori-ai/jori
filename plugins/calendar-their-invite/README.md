# Use their invite, not ours

The user's rule (2026-11-27): when the other side already sent an invitation
for a meeting, Jori does not send its own; it uses theirs.

Two halves, both code (`lib/their-invite.mjs`):

- **Before an invite goes out.** `bin/jori-calendar` (create with
  `--attendees`, or update adding guests) reads the slot, give or take three
  hours, and refuses with exit 10 when an invitation from one of the invitees,
  or a colleague at their company's domain, is already on the calendar.
  `--overlap-ok` does not pass it; only `--their-invite-ok "<why this is a
  separate meeting>"` does.
- **When theirs arrives after ours.** `bin/calendar-their-invite sweep` finds
  each Jori-made event with guests that overlaps an invitation organized by one
  of those guests (or a colleague), deletes Jori's with a cancellation to its
  guests (so their calendars drop the copy too), tells the user in one line, and
  logs to `data/logs/calendar-their-invite.jsonl`. Only events stamped
  `jori_created` are ever deleted.

Runs when an invitation reaches email intake (`agent/supervisor/gmail-source.mjs`,
detached) and every 10 minutes from cron as a backstop.

- **Turn off:** `jori plugin disable calendar-their-invite` (the guard in
  `jori-calendar` stays on).
- **Try it:** `bin/calendar-their-invite sweep --dry-run`.
- **Tests:** `node --test tests/their-invite.test.mjs tests/jori-calendar-their-invite-guard.test.mjs`.
