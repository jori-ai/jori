MONTHLY SUMMARY — Write the narrative of the calendar month that just ended. Runs on the 1st just after midnight (local). **Your only job is the prose.** The window, aggregate stats, home/away nights, persistence and email are code (`bin/period-summary`).

## Purpose

Weekly summaries show momentum. The monthly pulls back further: what shape did the month take overall? Which projects landed vs lingered? Where did the user spend their time? What was the social and health cadence? This is the long-arc memory that lets future Jori reason about "how has this year been going".

## Step 1 — Read the packet

The trigger already ran `period-summary prep monthly`:

```bash
PACKET=$(ls -t ~/Dev/jori/data/period-summary/monthly-*.json | head -1)
```

It holds `window` (local calendar), `stats` (exact: days with data, missing dates, median wake/sleep, total commits/messages/photos, distinct named places), `nights` (home/away/unknown **from the travel timeline** — not estimated), `weeklies[]` (the month's weekly narratives + themes), `dailies[]` (only for weeks with no weekly row), and `previous` (last month's row). **Use the numbers as given — never recompute or estimate them.** Trust the weekly compactions; use dailies only where a week is missing.

## Step 2 — Write the narrative

700–1000 words (publish rejects outside 400–1300), flowing prose with clear shifts, paragraphs separated by a blank line:

- **The shape of the month** — rhythm, mood, what dominated.
- **Projects & work output** — what shipped, moved, stalled (from weekly themes).
- **Geography** — `nights` and `away_metros`: trips, extended stays away from base.
- **Relationships** — family visits (children, extended family), outings with a partner, milestones.
- **Entertainment & culture** — shows, restaurants returned to, notable outings.
- **Health/life signals** — sleep consistency (`stats`), anomalies worth flagging.
- **What's carrying forward** — open threads; compare to `previous.themes`.

Close with one short paragraph: a candid observation the data suggests. Not advice. The stats block is rendered by code at the top of the email — refer to numbers, don't re-list them. Second person throughout.

`themes`: 5–8 strings — the month's dominant threads, synthesized from the weekly themes (not concatenated).

## Step 3 — Publish

Write `{"narrative": "...", "themes": [...]}` to a temp file and run:

```bash
~/Dev/jori/bin/period-summary publish "$PACKET" /tmp/monthly-reply.json
```

It validates (exit 2 + `problems[]` → fix and re-run), upserts `monthly_summaries`, stamps `daily_summaries.monthly_compacted_at`, renders the email with the stats block and sends "Month of …" to the user (instance `owner_email`). No phone ping. Delete the temp file.

## Guardrails

- Never send email yourself, never write SQL — `publish` does both.
- Idempotent: re-running `publish` overwrites the row and resends the email.
