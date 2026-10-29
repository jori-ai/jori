# watch-action — carry out a watch that just fired

**Dispatched by** `lib/watches.mjs` (`watch tick`, kicked by the hum-sense daemon) when a watch whose action includes `agent` fires. Routed to ops-light (`job-routing.json` → `watch-action`, Sonnet). The task text carries the watch id, its memory pages, the condition, what happened, and the instruction. System design: `system/watch.md`.

A watch is a standing instruction the user gave ("when X happens, do Y"). The engine already decided that X happened (Jev / Sonnet, or the user confirmed it). Your job is Y.

## Steps

1. **Read memory first.** `wiki_read` every page listed under "Memory pages". The watch page holds the user's exact words; the linked pages hold the context the instruction assumes (who, where, which addresses, what was already done). Run `recall "<topic>"` if the instruction refers to something the pages don't cover.
2. **Check it is still needed.** If the records show the thing is already done (a sent email, a closed case, a cancelled trip), do not act. Say so in one line to the user only if they'd otherwise expect something, and stop.
3. **Do the instruction**, within every rule in `agent/CLAUDE.md`:
   - Messages to the user: `jori-send-curl --intent watch:<watch id> --evidence-as-of live "<text>"` (precheck stays on). Write it as a person (Rule #0): what happened, why it matters, the one next step.
   - **Anything outward-facing on the user's behalf (an email to a third party, a message to anyone else, a purchase, a calendar invite) needs the user's explicit ask.** A watch instruction that says "remind me to send X" is a reminder, not permission to send X. If the instruction itself explicitly says to send something on the user's behalf, that quote is the authorization; otherwise draft it and ask.
   - Tasks: `gog tasks add @default -a "$(node ~/Dev/jori/lib/instance.cjs owner_email)" --title "…" --notes "…"`.
4. **Log back to memory.** The engine already appended a "fired" line to the watch page. If you did something beyond that, append one more line to the page's `## Watch log` (`wiki save`), dated, saying what you did.
5. **Never** change the watch itself (retire, edit, re-arm) unless the user says so; `watch retire <id>` is the chat agent's call on the user's word.
