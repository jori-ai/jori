# Location Confirm Reply

On-demand procedure for the chat agent, moved verbatim out of `agent/chat-agent/CLAUDE.md` (which keeps the trigger and hard rules inline). When this file and CLAUDE.md seem to disagree, CLAUDE.md's inline rule wins.

## Location Confirm Reply

The `location-confirm` job (every 10 min) sends Jori a message when the user has been dwelling ≥15 min at an unconfirmed venue (silence after the last GPS fix counts as still being there). The message leads with one guess — place plus likely activity — may add up to 2 alternatives, and carries the exact `ask_id`.

**Detection:** Read BOTH `data/location-confirm-recent.json` AND `data/location-confirm-pending.json`. The trigger script writes every ask to recent.json at creation time, but if delivery failed or the ask was queued during a quiet window the entry may still be in pending only — both files have the same shape and either can carry the live `ask_id`. If the most recent Jori-originated message in the thread came from this job (i.e. an entry in EITHER file has `ask_id` matching the message body) AND the user's reply is short (≤80 chars) AND looks like a venue selection, treat it as a confirmation.

Reply patterns:
- A yes to the question (since 2026-10-20 the question leads with ONE guess — "Are you at Boutique Coffee for your morning coffee?") → pass the name the question led with, verbatim. Whether a reply is a yes is your language judgment (Rule #0b), not a keyword list. A yes that adds a correction ("yes, but it's the bakery next door") is the correction, not the guess.
- A 1–3 digit number (`1` / `2` / `3`) → 1-based index into `[primary, ...alternatives]`. Example: `2` selects the first alternative.
- A name fragment that case-insensitively matches a candidate's name (`pho grand`, `bitter end`) → exact match wins, otherwise substring.
- A free-form name not in the candidate list (`Cipriani`) → recorded as `source: user_freeform`. Use this when the user corrects a wrong candidate list.

**Action:** Call
```
bin/location-confirm save <ask_id> "<selection>"
```
The CLI dedupes against pending + recent and writes to `confirmed-stops.json`. Future stops within 30 m of that centroid auto-resolve as the confirmed venue at conf 0.95 (no future ask).

Acknowledge briefly: `"saved — Pho Grand"`. Don't restate the centroid or duration.

**When NOT to treat as a confirm reply:**
- The reply is a longer command ("show me my schedule"), even if it contains a venue name → process normally as a fresh command.
- No matching `ask_id` in EITHER `location-confirm-recent.json` OR `location-confirm-pending.json` within the last 6 hours → not a confirm reply.
- The user replied "no" or "skip" → run `location-confirm save <ask_id> "skip"` so the ask is cleared without recording a confirmation. (The saver withdraws the stop — `place_type='non-stop'`, no name — and does not add it to `confirmed-stops.json`; since 2026-10-06. Before that "skip" was stored as a place name.)

This uses a different pending file from the older `Location Enrichment Replies` flow below (`location-confirm-recent.json` vs `location-pending-enrich.json`) and a different question shape. **That does NOT make them independent, and separate files are not what keeps them from colliding** — the two systems are coupled through `location_history.place_type`. `location-confirm save` patches the matching visit row to `user-confirmed`, and that patch is the only signal `findme enrich` has to drop its own pending entry for the same stop. When it lands, location-enrich stays quiet; when it silently no-ops, location-enrich asks the user about a stop the user has already answered (2026-08-04: the user answered a coffee stop at 07:18 and was asked about the same 49-minute visit again at 10:07 — "Already answered that…"). Details and the match rule: `agent/ops-agent/jobs/location-confirm-ask.md` § Write-back.

So: if a stop looks like it may be pending in BOTH systems, answer it once through location-confirm — do not also file it through `findme resolve`. If both are pending, the location-confirm one wins because it's more recent.

