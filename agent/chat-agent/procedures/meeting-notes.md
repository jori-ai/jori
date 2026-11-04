# Recurring Meeting Notes

On-demand procedure for the chat agent: the notes of the user's recurring meetings (`agent/local/config/meetings.json`; `bin/meeting-*`, playbook `ops-agent/jobs/meetings.md`). Each meeting has its own notes file (the meeting's `notes_file`). When this file and the chat agent's CLAUDE.md seem to disagree, CLAUDE.md's inline rule wins.

## When the user replies after a post-call message

The message that says "Anything to remember from the call?" names the meeting's counterpart ("📝 <name> call …"). Find that meeting's notes file, then:

1. Read the current notes file.
2. Move any checked-off or discussed items from "To Discuss" to "Discussed" under today's date (`### YYYY-MM-DD`).
3. Add the user's new notes to "Discussed" under today's date.
4. **Carry forward follow-ups:** for any discussed item with a pending outcome ("will check tomorrow", "decision pending", "will follow up"), add it back to "To Discuss" with a brief context note (`- [ ] <topic> — follow up on <outcome>`).
5. If the user names topics for next time, add them as `- [ ] Topic` under "To Discuss".
6. **Update "Running Context (Full History)":** a permanent log of everything discussed — people, deals, decisions, org changes, themes. Never delete entries; only add and update. Every fact gets a date. New topics get their own subsection. It is the long-term memory: any past detail should be retrievable years from now.
7. Write the updated file.
8. Reply: "Got it, notes saved."

Topics can also be added any time the user says "remind me to discuss X with <name>" or "add X to the <name> agenda".

## Zoom's record is folded in automatically

After each call, `bin/meeting-notes-from-zoom` reads Zoom's record of it (the cloud transcript when there is one, else AI Companion's summary) and applies steps 2–6 itself: a model answers with a structured edit, code checks it and applies it by heading after a backup. So when the user replies to the post-call message, **the call's own content is already in the file**: read it first, add only what the user says beyond it (or correct what they say Zoom got wrong), and don't re-add the same topics. Calls already folded in are recorded in the meeting's `applied_file` (by Zoom meeting UUID). When Zoom had nothing by T+240 min, the message is the plain ask and says why, and steps 1–8 apply as written.

## The reminder is a checklist

The T-15 reminder carries `metadata.checklist`; in the app each agenda item is a box. A tap is a reply `✓ <label>` (tick) or `↩ <label>` (untick) that the phone channel files in code: `bin/meeting-agenda-check` flips the To Discuss line to `- [x]` (or back) in place. If one of those replies reaches you anyway (the fast path refused, e.g. the item was already moved by a post-call edit), read the label against the open To Discuss items and run `meeting-agenda-check --meeting <id> --item "<exact line text>" --done` (or `--open`) yourself; reply in one short line only if it could not be done.
