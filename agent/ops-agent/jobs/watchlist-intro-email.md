# WATCHLIST INTRO EMAIL (daily, only when something new was added)

**Since 2026-10-11 films are not in this email** — they go in the weekly
`watchlist-movies-email.md` (one email a week about the new films on the list); this daily email covers shows and documentaries.

One email introducing every show/movie newly added to the shows & movies list — photos, what
it's about, the main cast, the reviews, why the user would like it, IMDb + Rotten Tomatoes links
and a trailer. Tapping a card's picture or name opens the title on IMDb.
Several titles share one email. Dispatched by `agent/scripts/trigger-watchlist-intro-email.sh`
(cron, daily 02:27 local) to the ops-light tier (job-routing.json: sonnet) — **only when the
trigger's code gate found something pending**, so most days there is no dispatch at all.

Since 2026-10-10: one email, with a writeup and photos, per batch of new titles — what each is about, the main actors, the reviews, a short "why you would like it", IMDb and Rotten Tomatoes links; recently added titles included.

## Step 1 — launch it detached, then end your turn

**Run this Bash call with the sandbox disabled (`dangerouslyDisableSandbox: true`)** — inside
the sandbox, DNS for Supabase / TMDB / OMDb fails in the detached job (same as watchlist-discover).

```bash
bin/job-run --name watchlist-intro-email --tier ops -- \
  bash agent/scripts/watchlist-intro-email-run.sh
```

That is the whole job. Do not wait, no `--notify-task`; a one-line ack is enough. The bin owns
selection, writing, delivery and its own failure pointer.

## What the run does — `bin/watchlist-intro-email`

1. **Select** (`selectPending` in `lib/watch-intro.mjs`): `watch_titles` rows with
   `intro_emailed_at IS NULL`, `added_at` within the last **30 days**, status not
   `rejected` / `dropped` / `watched`. Any audience (solo, together, partner). Newest first, at
   most **12 per email**; the rest go in the next day's email. New *seasons* are not titles and
   are not introduced here (`watchlist-season-check` owns those).
2. **Facts, in code** — TMDB details + `aggregate_credits` (tv) / `credits` (movie) + `videos` +
   `external_ids`: backdrop image, top cast with headshots, creators/directors, seasons, runtime,
   the trailer. OMDb: IMDb / Rotten Tomatoes / Metacritic scores, awards and plot. Rotten
   Tomatoes page from Wikidata (IMDb id P345 → RT id P1258); an RT search link when Wikidata has
   none. **Every card is a way in** (2026-10-11):
   - **IMDb:** `imdb_id`, else the one TMDB holds, else an IMDb title search. The backdrop and
     the name link there, plus the IMDb button.
   - **Trailer** (`pickTrailer` / `trailerLink` in `watch-intro.mjs`): TMDB's best YouTube/Vimeo
     video (Trailer before Teaser, English, official, sharpest, earliest) → "▶ Trailer". None on
     TMDB → "▶ Find the trailer" (a YouTube search) for a release from this year or last, or a
     title TMDB couldn't match; an older title with no video gets no button.
   - **Description:** the model's *about*, else the TMDB synopsis, else the list's own
     `description`, else OMDb's plot (the section is left out only if all four are empty).
   - **No `tmdb_id` on the row:** a TMDB name search, accepted only on an exact match (same
     normalized name and year within one; with no year on the row, only a name no other result
     shares; `searchHit`). A near miss is refused: it would put another title's photos and cast
     on the card. Unmatched → the card still has its description, an IMDb
     search, an RT search and a trailer search. Nothing found is written back to the list.
3. **Prose, by a model** — one `claude -p` call (`MODELS.sonnet`, effort low, WebSearch only)
   for the whole batch writes per title: *about* (premise/tone), *reviews* (critical
   reception, searched), *why* (tied to titles they loved and the taste profile). It always
   names people — the owner, the partner, or both, by name (`whoFor` in `lib/watch-config.mjs`), matching the title's list — never pronouns
   (2026-10-10), and never hedges ("stretch", "gamble"): quality is gated in
   `watch-discover`, not here, so the email doesn't judge titles. It is given the verified facts and told never to contradict them; cast and
   scores are rendered by code, never by the model. If the call fails, cards fall back to the
   TMDB synopsis and omit the reviews prose / why box — the email still goes.
4. **Deliver** per the long-form rule via `lib/digest-deliver.mjs`: one HTML email to
   the owner's address (instance `owner_email`) (subject `New on your watchlist: A, B and N more`), then a one-line
   pointer naming the titles (intent `watchlist-intro`) and an APNs push.
5. **Stamp** `intro_emailed_at` on every title in the email, only after the send succeeded.

Manual runs: `watchlist-intro-email --dry-run [--no-prose]` writes the HTML to `$TMPDIR` and
sends/stamps nothing; `--check` exits 0 when something is pending, 3 when not.

## State

The DB: `watch_titles.intro_emailed_at` (migration `20261010_watch_titles_intro_emailed.sql`).
Re-introduce a title by setting it back to null. Log: `agent/logs/watchlist-intro-email.log`.

## Guardrails

- Writes only `watch_titles.intro_emailed_at`. Never adds, removes or re-rates titles.
- Email to the user only. Silent when nothing is pending (the trigger doesn't even dispatch).
- Idempotent: a title is stamped once it's been emailed, so a second run the same day sends nothing.

## Failure modes

- Send fails → nothing stamped, one pointer "built but UNDELIVERED"; the next day retries.
- TMDB/OMDb/Wikidata miss for one title → that card renders with what it has (always an IMDb
  link, and the list's own description when TMDB has none, see Step 2). A failed TMDB call is
  treated as a miss, never as a failed email.
- A title TMDB can't match by name either → card without photos/cast, but with its own
  description, IMDb / Rotten Tomatoes / trailer search links; still introduced.
