# Location Enrichment Replies

On-demand procedure for the chat agent, moved verbatim out of `agent/chat-agent/CLAUDE.md` (which keeps the trigger and hard rules inline). When this file and CLAUDE.md seem to disagree, CLAUDE.md's inline rule wins.

## Location Enrichment Replies

The `location-enrich` job sends Jori two kinds of questions:
- **Stage `confirm`**: "You appeared stationary ~Xm near [area] around HH:MM — real stop or just a pause?" — expects `yes`/`no`/place name.
- **Stage `identify`**: "Which place did you stop at? 1. X 2. Y …" — expects a number, candidate name, or "none of the above".

**Rule:** If `data/location-pending-enrich.json` has any entry with `asked == true` AND no resolution recorded AND `asked_at` within the last 12 hours, AND the user's reply matches one of the patterns below, treat it as an enrichment answer. Read the pending file to know the target's `stage`, `visit_id`, and `food_heavy` flag.

**Content-match FIRST, FIFO only as a last resort (2026-08-02).** Before touching the CLI, check whether the specific pending entry is actually identifiable — the Jori question immediately before the user's reply names a duration, an area/candidate name, and a time ("12m near La Petite Place around 09:54"); match those against each pending entry's `duration_min`, `candidates[].name`, and `arrived_at` (converted to the user's local time). If exactly one entry matches, that is the target — call the **direct form** `findme resolve <visit_id> "<answer>"`, not `findme resolve pending "<answer>"`. **The `pending` shorthand always resolves the OLDEST asked-pending, full stop — it has no awareness of which one you actually mean**, so using it after you've already identified a specific, different visit_id will silently file the answer against the wrong stop. Reserve the `pending` FIFO shorthand for the genuine case this rule was written for: a free-standing reply where you have NOT been able to pin down which visit it answers (no recognizable duration/time/candidate match) — do NOT require the most-recent Jori message in the thread to be the enrichment question in that case either; the matcher must still work even when other Jori messages (hum pings, daily-summary pointer, departure nudges, etc.) landed between the enrichment ask and the user's eventual reply.

**Why this matters — 2026-08-02 incident.** Two visits were both sitting `asked`, both within the 12h window: a 79-min bakery stop from the prior evening, and a fresh 12-min café stop from that morning. The user replied "Mostly walked around" directly under the visible café question. The specific visit_id had already been identified by matching the question text against the pending file — but the reply was still filed via `findme resolve pending "Mostly walked around"`, which ignored that match and resolved the OLDER bakery visit instead, overwriting it with an answer that had nothing to do with it. Caught only because the wrong visit's new label ("Mostly walked around") was obviously unrelated to a bakery stop; a less distinctive answer could have gone unnoticed. Recovery required restoring the mis-resolved visit's `location_history` row to unresolved, re-queuing it in `location-pending-enrich.json`, and re-running the direct form against the correct visit_id. With 15+ pending entries routinely queued, FIFO-by-default is no longer a safe assumption — it was written for a single-outstanding-question world.

A reply counts as "place identification" when it contains a recognizable venue name even if wrapped in longer prose ("the bbq place, surprisingly good" / "the grocery on the corner" / "the jazz club for the late set" / "we ate at the noodle bar"). Extract the place name. If content-matching (above) identified the specific visit_id, call `findme resolve <visit_id> "<identifier>"` (direct form); otherwise `findme resolve pending "<identifier>"` is the fallback. Pass any remaining prose as notes via `findme note <visit_id>`. When ambiguous against multiple pending visits and no content match resolves it, prefer FIFO oldest; if still ambiguous, ask ONE short disambiguating question ("Was that the 16:32 or the 19:45 stop?") rather than guessing or skipping.

Failure mode this rule prevents (2026-05-01): location-enrich asked about three stops; the user replied later in chat with three venue names — but other Jori messages had landed between, so the matcher missed the answers and `findme resolve pending` never ran. The result: `place.source` stayed at `osm_overpass` for those stops and the daily summary's H3 used resolver guesses instead of the confirmed names.

**The CLI now refuses a confirmation it can prove is wrong (2026-08-10).** `findme resolve` blocks the promotion to `user-confirmed` when the row is missing, is not a visit, lasted under the 8-minute floor `findme enrich` uses to decide a window is even askable, or overlaps an already-confirmed visit — printing the reason and **exiting 2**. If you see that refusal, you have the wrong `visit_id`: re-derive it from the pending file rather than reaching for `--force`. (Since 2026-10-06 an overlap with a confirmed visit **150m+ away** is not refused. That is a late CLVisit departure, and resolve trims it to the new stop's arrival and says so on stderr. Only a same-place overlap, i.e. a twin, still refuses.) Marking a row `non-stop` is never blocked. Details and the incident behind it: `jobs/location-enrich.md` § Confirmations are guarded.

1. **Negative reply** — `no`, `not a stop`, `pause`, `blip`, `walk`, `nothing`, or a negative that DESCRIBES the window (`"we were walking along the coastline in the park"`, `"just driving through"`).
   - Call `bin/findme resolve pending "<the user's reply verbatim>"` — **pass the user's words, not a collapsed `"no"`.** `findme` classifies: a bare negative sets `place_type="non-stop"` with no name; a described one sets `place_type="non-stop"` AND keeps the description as `place_name`.
   - **Why verbatim (2026-07-27).** Collapsing a described answer to `"no"` threw away the only label that window will ever have, and the daily summary then re-guessed a venue for it. The user once answered a beach ask with *"We were walking along the coastline in the park"*; it was filed as a bare `"no"`, and next morning's summary titled the window `~<a nearby bar>? · unconfirmed (also: <two more>)` above prose that described the walk correctly. `resolve-day` now reads non-stop rows (see `jobs/daily-summary.md`), so the user's words land in the title — but only if you pass them through.
   - Acknowledge briefly: `"got it — marked as a non-stop."`
   - No follow-ups.

2. **Affirmative reply with no place name** — `yes`, `real stop`, `confirmed`, etc. (only valid at stage `confirm`).
   - Call `bin/findme resolve pending "yes"` — advances pending to stage `identify`. The next scheduled enrich run will ask for the place.
   - Acknowledge: `"ok — I'll ask which place in a bit."`

3. **Place identification** — a number, candidate name, or free-text place name (possibly with notes).
   - Separate into identifier (number/name at start) and notes (rest). Example: `"1 — white curry laksa, fantastic"` → identifier=`1`, notes=`white curry laksa, fantastic`. A short place name with no number is also valid (skips straight through both stages).
   - Call `bin/findme resolve pending "<identifier>"` — sets `place_type="user-confirmed"`, clears from pending.
   - If notes were included, also call `bin/findme note <visit_id> "<notes>"`.
   - **Food follow-up**: if `food_heavy: true` AND no notes were included, reply `"got it — <place>. What did you order? Any good?"` and save the next response via `findme note`.
   - **Non-food follow-up**: if not food and the place type is ambiguous (generic office building, etc.), ask `"what were you up to there?"` and save the response via `findme note`.
   - **Trusted-restaurants save**: if food AND the user's notes are positive, offer `"add <place> to your trusted restaurants?"` — add only on explicit yes. Update `reference_trusted_restaurants.md`.

If the user says "skip" or "none of those" at stage `identify`, run `findme resolve pending "unknown"` and acknowledge briefly.

**Protocol tokens are never stored as places (2026-10-06).** `findme resolve` treats three strings as OUR vocabulary, by exact match, before anything else: `"skip"` withdraws the stop (`non-stop`, no name — use it for "not a stop" when you have no description), `"unknown"` leaves a real stop unnamed and marks the pending entry declined so it is never asked again, and `"__other__"` (the stored value of a "Somewhere else" / "No, somewhere else" / "Type it in" button) is refused with exit 2 — it means *ask the user where*, so ask, then resolve with the user's answer. Before this, all three were written as user-confirmed place names (one row was literally named "skip").

**Pass the venue, not the sentence.** The identifier is the place's name; everything else goes to `findme note`. A whole sentence ("Ate breakfast at <café> (or its twin)") was once filed as the name, so the row is named *"Breakfast at <café> in the flea market, not <the café you guessed>"*. That matters more now: every `user-confirmed` resolve is also promoted to `confirmed-stops.json` (which names every later stop within 30 m) and, when the user's answer differs from the question's lead candidate, written to the drift ledger — both via `location-confirm save-visit`, automatically. An answer longer than 60 characters is kept on the row and in the drift ledger but is NOT promoted, because it would become the label for every future visit there.

**An activity is not a place (2026-10-27).** If the reply names only what the user did there ("Lunch", "coffee", "a meeting") and no venue, there is no place name to file. Never build one from the stop's street address plus the activity: the one-word answer "Lunch" was once saved with `location-confirm save-current "<street address> lunch"`, which made the row `user-confirmed` (absolute) under a name that was only the street address, and every later rung (saved place, a saved-restaurants mark, a prior lunch there, the sign in the user's photos) was skipped for a stop that was really the user's own saved restaurant 22 m away. File the activity as a note, leave the stop unnamed so the ladder can name it, and answer the hum question with the user's words:

```
bin/hum-answer <question_id> "<the user's words>"
bin/findme note <visit_id> "<the activity, in the user's words>"
```

Ask where it was only if nothing on the row names a candidate (a `saved_place_candidates` entry, a calendar event, a photo); otherwise let the naming ladder do it and the daily summary will say "probably X".

Never resolve an enrichment pending silently — always acknowledge with a short confirmation.

