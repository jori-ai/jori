LOCATION-CONFIRM-ASK — system reference (NOT dispatched).

> **Hybrid flow as of 2026-05-11.** The cron used to be a pure direct-send path (local Gemma → `jori-send`, no LLM reasoning involved). It now runs a three-step resolution per ask so we don't ping the user when the answer is already in calendar / recent conversation / wiki memory. The phrasing path itself is unchanged — Gemma still does the wording, jori-send still does the delivery. What changed is whether we get there at all.

## Three paths per ask (in order)

1. **Programmatic auto-confirm.** `bin/location-confirm-precheck.mjs` runs synchronously in the trigger script. It checks active Google Calendar events for one whose title, location, OR description names a candidate (description added 2026-09-08 — see below). A hit → call `location-confirm save` directly. No phrase, no push. Zero LLM cost.
2. **Local resolve (2026-06-07; tier 3 since 2026-10-20).** If the precheck escalates (no decisive calendar match), the trigger runs `bin/location-confirm-resolve.mjs`, which fetches calendar events ±2h, the user's chat messages since local midnight (Supabase `jori_messages.content`, chat channel; until 2026-10-20 it selected a `body` column that does not exist and never saw a message), and `wiki search` results for each candidate, then decides in `localResolve()`, in tiers: (1) a previously-confirmed favorite/frequent stop within 120m, (2) a calendar event whose title, location, OR description contains a candidate name, (2b) a calendar event that overlaps the dwell in time AND shares an address token with a candidate (location AND description, 2026-09-08), using the event's own title as the venue, (3) **did the user already say where, today?** — `lib/stated-place.mjs` gives a model the whole day's chat (each of the user's messages with the Jori line it answered) and the calendar around the dwell, on the day-statements ladder (on-device gemma3:1b → Sonnet → Opus; see § Stated place below), (3b/4) the Jev tail (`lib/location-confirm-jev.mjs`: Jev picks a candidate, `named_other` or ask from the calendar, the user's dwell-window `messages`, the user's `earlier_today` messages — a plan there may pick a candidate, never `named_other` — and wiki; legacy = Gemma extraction then ask). Only when local resolution is switched off (`data/.location-local-off`) or throws does it fall back to the on-device Gemma classifier at the bottom of the file. On auto-confirm we call `location-confirm save`. On ask we fall through to step 3.

   **Stated place.** At 12:42 the user wrote of meeting friends "for lunch at <restaurant>"; the 13:31 dwell's first candidate was that restaurant, and the user was asked anyway ("If you know this, why did you ask?"). Tier 3 reads the day, not a window around the dwell. Code owns what the model may not: the quote it cites must be found in one of the user's messages (or in a calendar event's own text), and a plan (said before the dwell began) or a calendar entry must name one of the GPS candidates — plans change, the map is the witness. Something the user said during or after the dwell stands on the user's word. Here the step runs Sonnet → Opus only (an on-device answer is never trusted with the durable write `location-confirm save` makes); this trigger runs from cron, where the Claude rungs cannot log in, so after the first `not_logged_in` the rest are skipped and the cron-safe Jev tail (which now also reads `earlier_today`) is what usually settles it here. A settled answer returns `auto_confirm` with source `stated:chat` or `stated:calendar`, and the trigger saves it with `location-confirm save` — the confirm path, the same write as the user's answer. Log + 36 h cache of identical bundles: `data/stated-place-log.jsonl`. The same step runs before every segment-ask card and location-enrich question, through `stop-passage` (`jobs/location-enrich.md`).

   **Why description, not "always set a location field" (2026-09-08).** A ticket-confirmation calendar event routinely has no `location` field at all — the venue address lives only in the order-info text of the `description`. An earlier proposed fix would have mandated every auto-created event carry a location field; the user rejected it ("not all calendar meetings will carry a location") because plenty of legitimate events — calls, internal blocks — genuinely have none, and mandating one everywhere is the wrong lever. The right fix reads more of what the event already has before giving up: tiers 2 and 2b, and the precheck's own candidate match, now scan title + location + description together, and only fall through to asking when none of the three name a candidate.
3. **Direct ask.** If precheck says "ask", Sonnet says "ask", or any step fails, the cron falls through to the original zero-token path — phrase via Gemma, send via `jori-send`. The cron never silently drops an ask.

## Why Sonnet and not the Opus ops-agent

Phrasing the "are you at X?" question is a Gemma-class task; we don't want Opus tokens on the wording. The *decision of whether to ask at all* benefits from real reasoning over the user's actual day ("the user said they were heading to Pho Grand 20 minutes ago, the GPS now says Pho Grand area — confirm, don't ask"), but it's a structured classify-from-bundle, not an open-ended agentic task. The canonical pattern for that (`agent/CLAUDE.md` § Effort Policy: "high-volume `claude -p` subagents that fork per-invocation pass `--effort low` inline") is a one-shot Sonnet subprocess, modeled on `agent/scripts/hum-harvesters/{art,dining,music}.mjs`. No webhook, no state file, no playbook — just a subprocess that takes the ask on stdin and emits a decision on stdout. The Opus ops-agent supervisor is deliberately NOT in this path.

The chat-agent (Sonnet, on Max) is still in the loop on the **inbound** side: when the user does reply, the chat-agent's `Location Confirm Reply` rule (in `agent/chat-agent/CLAUDE.md`) recognizes the reply and calls `bin/location-confirm save <id> <name>`.

## Direct save — no card required (2026-09-25)

Every path above is triggered by the DETECTOR (`location-current-stop`, run by the cron), and every write requires an `ask_id` that only exists once a card has actually been dispatched — so a location the user states in an ordinary message, before any card exists for that dwell, had no write path at all. It could be overwritten later by whatever the cron eventually guessed.

`bin/location-confirm save-current "<venue>"` is the second write path this closed. It is NOT part of the cron's three-step resolution above — it is invoked directly by the chat-agent (see `agent/chat-agent/CLAUDE.md` § "Location Statement Direct-Save") when the user's ordinary message names a specific place as the user's current or immediate-next location. It synthesizes an ask-shaped record itself instead of looking one up:

- If `location-current-stop` reports a dwell in progress right now (`is_stop: true`), that becomes the ask (same `centroid` / `first_sample_ts` / `last_sample_ts` / `duration_min` the cron would have used).
- Otherwise (the user has already left), it queries `location_history` directly for the most recently DEPARTED visit row within the last 20 minutes (configurable via `--lookback-min`) and builds the ask from that row.
- If neither exists, it writes nothing and exits non-zero — there's no dwell for the confirmation to attach to.

From there it calls the exact same write function `save` uses (`_write_confirmation` in `bin/location-confirm`) — same patch to `location_history`, same append to `confirmed-stops.json`, same silent re-render dispatch for an already-shipped day. A save-current entry is tagged `ask_id: lc-direct-<timestamp>` and `source: user_stated_direct` so it's distinguishable in `confirmed-stops.json` from a card answer (`lc-<...>`) or the resolver's own safety-net promotion (`lc-resolve-<...>`, `promoteConfirmedStop` in `location-confirm-resolve.mjs` — see below). It carries its own light dedup (same name within 50m inside the last 2h is treated as a duplicate and silently skipped) since, unlike `save`, it has no ask_id to key idempotency off.

**Still doesn't touch:** the separate concern about an automated guess being able to mark itself "confirmed" without that authority. Direct-save narrows the window that could be exploited in (a stated location beats a later guess to the punch more often now), but it is not a fix for it — see the section immediately below, which is.

## Automated guesses cannot self-confirm (2026-09-25)

Until now, `promoteSafely()` (in `location-confirm-resolve.mjs`) promoted ANY `{decision: "auto_confirm"}` into the durable `confirmed-stops.json` store — including one produced by a model reading ambiguous evidence, not just one produced by a deterministic match against something the user actually wrote. Once written, tier 1 of `localResolve()` trusts any entry there at full strength ("frequent stop") for every future dwell within 120m, forever — so a single wrong guess from the Jev/Gemma judgment tail (tier 3b/4, `resolveTail()` in `location-confirm-jev.mjs`) or the kill-switch fallback classifier (bottom of `location-confirm-resolve.mjs`, reached when local resolution is off or throws) became a permanent, self-reinforcing "confirmation" that the user never actually gave. This is the race Jori had separately flagged: an automated guess marking itself confirmed on its own authority.

The fix narrows WHO gets to write to that store, not WHETHER today's ask gets skipped:

- `promoteSafely(ask, decision, venue, cands, source)` now takes the resolution `source` and refuses to promote unless it's in `GROUNDED_PROMOTION_SOURCES` — `local:memory`, `local:calendar`, `local:calendar_title`, `stated:chat` (2026-10-20: the user's own words, the quote verified in code to be in the user's message, a plan only when it names a GPS candidate; the user asked for exactly this to go through the confirm path), and `local:message` (the retired substring tier, kept so old log rows still read as grounded). These are the tiers whose evidence is something the user themself produced: a past confirmation, the user's own calendar text, or the user's own words.
- Everything downstream of that — the Jev/Gemma judgment tail (`jev:candidate`, `jev:named_other`, `local:message_explicit`), a calendar-only stated answer (`stated:calendar`) and the kill-switch fallback classifier (tagged `local_llm_fallback`) — can still return `auto_confirm` and skip asking about TODAY's dwell (a one-day, reversible convenience: worst case is one mislabeled stop in one day's narrative, the same risk that already existed). It just never gets written into `confirmed-stops.json`, so it can never compound into tomorrow's ground truth.
- `promoteConfirmedStop()` itself, and the `--promote-only` repair hatch that calls it directly, are unchanged — they remain the escape hatch for hand-repairing a mapping that was demonstrably lost (see their own header comments). The gate lives one layer up, in `promoteSafely()`, which is the only path the live pipeline calls automatically.
- A new `--promote-safely-only` test hatch exercises the gate deterministically (`tests/location-confirm-resolve-grounded-promotion.test.mjs`), the same pattern as `--resolve-only` and `--promote-only`.

**Scope, deliberately narrow.** This does not touch tiers 2/2b's own string-matching correctness (a separate, ongoing hardening — the 2026-09-14 "Backroom Comedy" address-token incident) — a wrong deterministic match still promotes, same as before. It only stops a NON-deterministic guess from being able to grant itself the same authority a deterministic match or a real confirmation carries. If the user wants the deterministic tiers held to a similar standard (e.g. requiring corroboration before a first-time promotion, mirroring `place_naming.py`'s majority-vote `recurring` rung), that's a further, separate change — not assumed here.

## Files in the flow

| File | Role |
|---|---|
| `bin/location-current-stop` | Detector. Pulls last 60 min of GPS (180 when the phone is silent), walks the current cluster back from the latest fix, and counts the silence since that fix as still being there (dwell = first fix → now; asks at ≥15 min; 2026-10-20). Resolves candidates via `resolve_place` with the user's Google saved places as an extra tier (`saved_places=True`), resolves candidates via `resolve_place`, decides if `needs_confirm: true`. Also reused directly by `location-confirm save-current` to check for a live dwell. |
| `agent/scripts/trigger-location-confirm.sh` | Cron orchestrator (every 10 min). Runs detector, applies quiet-window logic, then resolves each ask through the hybrid path (precheck → Sonnet resolve → direct). |
| `bin/location-confirm-precheck.mjs` | Programmatic precheck. Stdin: ask JSON. Stdout: `{decision: auto_confirm\|escalate\|ask, venue?, reasoning}`. Calendar-overlap match → auto-confirm. |
| `bin/location-confirm-resolve.mjs` | Resolve subprocess. Stdin: ask JSON. Pre-fetches calendar (±2h) + the user's chat messages since local midnight + wiki search results, then runs `localResolve()`'s tiers (§ Three paths, step 2). Stdout: `{decision: auto_confirm\|ask, venue?, reasoning, source, evidence?}`. Its `promoteConfirmedStop` is a separate, narrower safety-net writer — see the note below. |
| `lib/stated-place.mjs` | Tier 3, shared with `stop-passage`: has the user already named this window's place today, in chat or on the calendar? Model ladder + code provenance/map checks (§ Stated place). Log/cache `data/stated-place-log.jsonl`. |
| `bin/location-confirm-phrase.mjs` | Reads ask JSON on stdin, asks Gemma for ONE yes/no guess naming the place and the likely activity ("Are you at X for your morning coffee?"; a reverse-geocoded street is never offered as a venue; ask_id appended in code, 2026-10-20), prints message on stdout. Falls back to a templated string if Ollama is down. |
| `bin/jori-send.mjs` | Direct Supabase `jori_messages` insert + APNs push. Bypasses the chat-agent entirely. |
| `bin/location-confirm` | `save <ask_id> <name>` writes to `confirmed-stops.json`, **and patches the matching `location_history` visit row(s) to `place_type='user-confirmed'`** (see § Write-back below); `save-current <name>` does the same without needing an ask_id (see § Direct save above); `save-visit <visit_id> <name> [--guess <lead candidate>]` (2026-10-06) is what `findme resolve` calls after every user-confirmed answer — hum asks, chat corrections, segment-ask taps — so those answers reach `confirmed-stops.json` too (`ask_id: lc-visit-<visit_id>`; since 2026-10-13 an answer over 60 chars is promoted under the confident place name `lib/location-answer-name.mjs` reads out of it, given the stop's local window and the lead guess (Sonnet, Opus on a malformed reply; the user's sentence kept as `answer` and in the visit rows' `notes` as `[the user's answer] …`), and stays row-only when the user hedged, asked, named only another stop or two places without saying which, or the model failed; a promoted read flags its drift row `promoted_from_sentence_at` + `promoted_name`, and the same correction arriving again closes the drift row it left `open`) and, when the user named something other than the lead guess, the drift ledger (`nightly-review-state.json` `daily_log_drift[]`); `list` shows recent + pending. |
| `data/location-confirm-pending.json` | Asks queued during quiet windows, drained on the next non-quiet tick. |
| `data/location-confirm-recent.json` | Anti-spam — keys by `(date, round-3-decimals(centroid))` so the same dwell can only fire once per day. Also where the chat-agent reply rule looks up `ask_id`s. |
| `data/confirmed-stops.json` | Append-only confirmation store. `resolve_place` reads it as tier #2 (above `known_recurring`) at conf 0.95 — every future or past stop within 30 m of a confirmed centroid auto-resolves. |
| `agent/chat-agent/CLAUDE.md` § "Location Confirm Reply" / "Location Statement Direct-Save" | The inbound side. Matches card replies (number / name / free-text) against recent asks and calls `save`; separately, recognizes an unprompted location statement in an ordinary message and calls `save-current`. |

**A third writer exists, and it is deliberately narrower than either of the above.** `location-confirm-resolve.mjs`'s `promoteConfirmedStop` (invoked via `promoteSafely`) is a safety net for the live trigger path only: when `localResolve()` auto-confirms a venue that the canonical writer (`location-confirm save`, called by the cron right after) will not itself be able to match back to a `location_history` row, this promotes the centroid→name mapping into `confirmed-stops.json` anyway, so future dwells near that spot still resolve. It explicitly stands down (`canonicalSaverWillHandle`) wherever `save` already covers the case, and it is not a general-purpose write path — `save` and `save-current` are.

## Write-back — this is also how location-enrich learns the stop is settled

`location-confirm save` (and, as of 2026-09-25, `save-current`) does not only append to `confirmed-stops.json`. It PATCHes the matching `location_history` visit row(s) with `place_name` + `place_type='user-confirmed'`. That patch is load-bearing twice over:

1. `resolve-day`'s `classifyStops` reads the row, so the day narrative uses the user's words rather than the original candidate.
2. **It is the ONLY signal `location-enrich` has that this stop is answered.** `findme enrich`'s `_clean_resolved_from_pending` drops any pending row whose DB `place_type` is `named` / `user-confirmed` / `non-stop`. If the patch doesn't land, the pending entry survives and location-enrich asks the user about the same stop again, in its own wording, hours later.

**The two systems are therefore NOT independent** — they are coupled through `location_history.place_type`, and nothing else. A row matches the ask when EITHER:

- **proximity** — centroid within 300m and `arrived_at` inside the ±30min ask window; or
- **time overlap** (added 2026-08-04) — the ask's sample window and the row's `[arrived_at, departed_at]` overlap ≥5 min, within a 500m bound.

The overlap clause exists because `location-current-stop` anchor-walks raw GPS to build its centroid, so a sparse sample set that straddles the walk TO a venue smears the centroid toward the origin. On 2026-08-04 that put the ask centroid 319.5m from the café the user was sitting in — 19.5m past the proximity gate — the write-back silently no-op'd, and location-enrich asked about the same 49-minute stop 2h50m after the user'd already answered it ("Already answered that…"). Replayed over the 28 confirmations then in the retention window, proximity alone landed 15; adding overlap lands 19, with no regressions.

**When the write-back finds nothing it now says so on stderr and records `patched_location_history: false` on the stored confirmation.** Do not remove either — a silent no-op here is indistinguishable from success, which is why this class went unnoticed for months (0 of 47 stored confirmations carried the flag, because it used to be assigned to an already-serialised dict *after* the file write).

## Skip-ask rules (in `location-current-stop`)

The detector returns `needs_confirm: false` and the cron silently exits when:
1. Primary source is in `{named_location, confirmed_stop, known_recurring, wifi_ssid}` — already known.
2. `primary.confidence >= 0.90` — high confidence is its own answer.
3. `primary.confidence >= 0.80` AND `photo_count >= 1` — a photo in the stop window bumps confidence by `+0.04` per photo; if it crosses 0.90, skip.

## Quiet windows (in the trigger script)

Defined as: local hour < 9 (sleep) OR an active non-transparent Google Calendar event right now.

In a quiet window: the ask is appended to `location-confirm-pending.json` (deduped by `ask_key`) and the script exits. The next 10-min tick that's outside quiet window drains all pending asks alongside any new one — each gets its own Gemma-phrased message and its own `jori-send` push.

**Quiet windows are specific to the CRON's own asks.** `location-confirm save-current` is invoked directly by the chat-agent in response to something the user just said — it is not scheduled and does not check or respect a quiet window; there is no ask to defer.

## Anti-spam

`ask_key = "{YYYYMMDD}-{lat3dp}-{lon3dp}"`. Once an ask with that key lands in `recent-asks.json`, no further asks fire today for that ~110m square. Same dwell on day 2 is fair game.

## Phrasing examples

Gemma 4 e2b output for a typical lunch-area ask:

> "Hey, are you at Fruit Vanity, Pho Grand, or Lucky King Bakery right now? (lc-20260425-1640-40.717-(-73.993))"

Output for a night-life cluster:

> "Hey, are you at The Bitter End, Terra Blues, or The Red Lion right now? (lc-20260425-0245-40.728-(-73.999))"

The `ask_id` in parens at the end is what the chat-agent's reply rule grabs to route the answer back to the saver.

## Failure modes

- **Ollama down** → `location-confirm-phrase.mjs` falls back to a templated string ("Looks like you've been here a while — X, Y, Z? Reply with the name. (ask_id)"). Never blocks delivery.
- **`jori-send` fails** (Supabase down) → log + re-queue the batch into `pending-asks.json`. Next tick retries.
- **Detector returns `is_stop:false`** → silent exit. No log noise.
- **Currently in a quiet window AND nothing pending AND nothing new to add** → silent exit.

## Don't

- Don't call this file from the ops-agent dispatcher. It's documentation, not a runnable job. There is no dispatched playbook for this flow — the Sonnet path is an inline subprocess in the trigger script.
- Don't route this through the Opus ops-agent webhook. Classify-from-bundle is the canonical Sonnet `--effort low` use case (CLAUDE.md § Effort Policy), and Opus turns are expensive enough that running them on every uncertain dwell would dwarf the value.
- Don't include centroid coords in the user-facing message — they're noise to the human reader.
- Don't write to `confirmed-stops.json` from anywhere except `bin/location-confirm` (`save`, `save-current` or `save-visit`) — and, only as the narrow safety-net described above, `promoteConfirmedStop` in `location-confirm-resolve.mjs`.
- Don't ask twice for the same dwell window (anti-spam handles this).
- Don't have Sonnet phrase the user-facing question itself — both the auto-confirm-skipped path and the Sonnet-asks path go through the same Gemma phraser. Diverging phrasings makes the inbound reply rule's job harder, not easier.
- Don't fire `save-current` on anything but a real, specific, current/immediate-next place statement — see the guardrails in `agent/chat-agent/CLAUDE.md` § "Location Statement Direct-Save". This writes to the same durable, auto-resolving store as a card answer; a wrongly-fired one is not cheaply reversible.
