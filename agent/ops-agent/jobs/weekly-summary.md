WEEKLY SUMMARY — Write the narrative of the week that just ended (Mon–Sun). Runs Monday just after midnight (local). **Your only job is the prose.** The window, stats, home/away nights, persistence and email are code (`bin/period-summary`).

## Purpose

Daily summaries are dense and chronological. Over a week, patterns emerge that a single day can't show: projects advancing, places returned to, people seen, trips taken, time allocation shifts. The result lands in `weekly_summaries` so the monthly job has something pre-digested to roll up.

## Step 1 — Read the packet

The trigger already ran `period-summary prep weekly` and wrote the packet:

```bash
PACKET=$(ls -t ~/Dev/jori/data/period-summary/weekly-*.json | head -1)
```

It holds `window` (local calendar), `stats` (exact: days with data, missing dates, median wake/sleep, commits, photos, distinct named places), `nights` (home/away/unknown from the travel timeline, plus `away_metros`), `dailies[]` (each day's narrative + key_events), and `previous` (last week's row, for momentum). **Use these numbers as given — do not recompute them.** If the packet's `window.end` is not yesterday-ish, stop and report; don't write about the wrong week.

## Step 2 — Write the narrative

A cohesive weekly story covering:

- **Rhythm** — typical wake/sleep (from `stats`), longest and shortest days, weekend vs weekday shape.
- **Places** — where the week was anchored (`nights`), repeated destinations, any trips.
- **People** — who the user saw, whether family was around (a partner who lives with the user is implicit at home residences), social cadence.
- **Work output** — project arcs across commits and conversations. Name the threads that moved. Quote commit subjects sparingly.
- **Meals & outings** — restaurants visited, shows/entertainment (from key_events).
- **Anomalies** — `stats.missing_dates`, unusually short/long sleep, unexpected travel.
- **Momentum** — what's trending up or new vs `previous`.

Narrative, not bulleted. 400–700 words (publish rejects outside 250–900). Paragraphs separated by a blank line. No emojis. Muted tone. **Second person throughout** ("You spent the morning at…"); never the user's name or "he/she/they" in the prose.

`themes`: 3–6 short strings naming the week's top threads (e.g. `"daily-summary build"`, `"rental contractor push"`).

## Step 3 — Publish

Write `{"narrative": "...", "themes": [...]}` to a temp file and run:

```bash
~/Dev/jori/bin/period-summary publish "$PACKET" /tmp/weekly-reply.json
```

It validates the shape (exit 2 + `problems[]` → fix and re-run), upserts `weekly_summaries`, stamps `daily_summaries.weekly_compacted_at`, renders the HTML and emails the user (instance `owner_email`, "Week of …"). No phone-channel ping. Delete the temp file.

## Guardrails

- Never send email yourself, never write SQL — `publish` does both.
- Idempotent: re-running `publish` overwrites the row and resends the email.
- Never modify the source daily narratives.
