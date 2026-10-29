NEWSLETTER DIGEST — the last 24h of newsletters in ONE email, a pointer only when something stands out, and a push. Daily, evening (schedule in the installation's task registry). Zero newsletters → nothing at all.

## This job is a script, not an agent turn (since 2026-10-04)

`bin/newsletter-digest-run` — on-demand launchd agent `ai.claude.newsletter-digest`, kicked by `trigger-newsletter-digest.sh`. **If this job is dispatched to you as an agent turn, run that trigger script and end the turn.**

## Pipeline

1. **Fetch (code).** Gmail REST (`lib/gmail-read.mjs`) with the query built from the local config `agent/local/config/newsletter-digest.json`: `from` (Gmail from: terms — a newsletter platform's domain, a sender address), `delivered_to` (e.g. a +newsletters alias), `window` (default `1d`), minus spam and minus the agent's own mail (`agentAddresses()`). A sender `intake-skip-rules.json` files as spam (e.g. a blocked author) never reaches the digest. Adding a newsletter = one entry in that config. **No `from` and no `delivered_to` → the job is off** (exits 0, logs it).
2. **Prepare (code).** Plain-text body (HTML stripped), capped per letter; story links extracted with mail plumbing removed (unsubscribe, preferences, share intents, app deep-links, images).
3. **ONE model call** (Sonnet per `agent/config/models.env`, tool-less, schema, `lib/max-judge.js`) for all newsletters together: per letter its name, a 1-2 paragraph key-takeaway summary, up to 3 story links cited **by index** (grounding is structural — an index the code didn't hand out is ignored); plus one optional `standout` line across the whole batch.
4. **Render + deliver (code).** One section per newsletter: name, summary, an og-card for the Gmail original (`gmailLink(id)`, renders as a plain link — Gmail is behind auth) and for each cited story. Subject `Newsletter Digest — <Day, Mon D>`; label `personal` + star + mark read, never `p1`, with a **bounded** wait for Gmail to index (the old version tried once after `sleep 30` and silently skipped the label when Gmail was slow — now it retries for up to 2 minutes and logs a miss).
5. **Ping.** The push always goes. The chat pointer goes **only when the model returned a standout** ("Newsletter digest emailed — N today; the standout is …") — a pointer that only announces delivery tells the user nothing the push didn't (ops-agent CLAUDE.md § Long-form delivery rule). Never say the digest was labelled p1.

Run by hand: `bin/newsletter-digest-run --dry-run`. Log: `logs/newsletter-digest.log`.
