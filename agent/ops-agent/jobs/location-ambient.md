# Location Ambient — Proactive location-aware pulses

> **This instance's additions** to this playbook (its own taste references, home areas and decisions) are in `agent/local/jobs/location-ambient.md`; the supervisor appends them to the dispatched playbook. If they are not at the end of what you were given (an ephemeral or by-hand run), `Read` that file before you start.

Proactively share thought-partner insights when the user is actively wandering around a neighborhood — a restaurant recommendation, an event happening nearby, or a useful neighborhood fact. Turns exploration time into a value-added moment rather than silence.

Haiku-tier scan job. The cron tick runs every 30 minutes, but **the tick is a check-in, not a trigger to speak** — see Step 2.5. Most runs produce nothing; high bar for quality means the job is silent by design.

## Purpose

When the user is walking or scooting in a non-home area for 20–40 minutes with multiple waypoints (not commuting, not a point-to-point transit), detect the wandering state and share one insight: a trusted restaurant within 500m, an enabling fact about an opportunity nearby, or a thought-partner observation about the neighborhood. Silent runs are fine — no "I see you're in <neighborhood> today!" filler.

This job is the ambient awareness layer — sibling to `location-enrich` (asks clarifying questions about stops) and `hum` (periodic check-ins). Ambient is always observing, rarely speaking, and only when there's genuine value to share **and the user is actually next to it right now**.

**Fire when the user STOPS, not while walking.** Only urgent pings go out while the user is moving; non-urgent ones wait until the user is stationary, because a ping that lands in a pocket is not a quieter ping, it is a lost one — the banner is gone by the time the phone comes out. This does **not** weaken the timeliness rule below; it satisfies both, because someone standing still in a neighborhood is still next to what's near them. **Proximity is measured from where the user stopped, and the tick that speaks is the one where the user has just stopped moving.**

This job is the reason the system-wide motion gate (`lib/motion-state.mjs`, applied at the `sendApnsPush` chokepoint) has an explicit design partner rather than an exemption: ambient pings are non-urgent by nature, so under the gate they would be parked and flushed later at a place where the rec no longer applies. Re-anchoring the trigger is what keeps them timely instead of merely delayed.

**Timeliness: a location-based rec goes out when the user is actually there** — as close to the reference point as possible, triggered by the current GPS reading. The failure this closes: at 10:00 local, walking through a neighborhood, the job sent a time-of-day-flavored roundup of three venues spread across the neighborhood ("<neighborhood> morning — <street> has great falafel and bakeries, and <shop> if you want real jam"), not anchored to where the user actually stood at that moment. The cron tick had fired, the user was wandering (both true), and the job filled the slot with the best neighborhood-level content it could find instead of asking the one question that matters: **is the user standing next to any specific one of these right now?** Step 2.5 below makes that question the gate, not an afterthought — and Step 3's one-place rule stops "morning roundup" content from recurring under a different tier.

## Preflight gates

Apply in order, exit silently on match:

1. **Lock check:** if `data/pulse.lock` exists and is <5 min old, exit (another pulse job is running)
2. **Sleep window:** if hour is 01:00–08:00 in the user's local tz (phone-reported, home-zone fallback — handled by trigger script), exit
3. **Cool-down:** if a Jori message was sent <20 min ago (read `last-jori-message-at.json`), exit
4. **Daily ping budget:** if `bin/ping-budget check` exits 1 (6 pings today across hum + ambient, or the last one < 45 min ago — the live counter in `hum-state.json` plus the `hum-feedback.jsonl` ledger, see `lib/ping-budget.mjs`), exit
5. **Session cool-down:** if this walking session already emitted an ambient ping <90 min ago (read `location-ambient-last.json`), exit

**Gates 3, 4, 5 and Step 1a/1b ALSO run in the trigger, before you are ever
woken.** `trigger-location-ambient.sh` carries a dispatch gate that
mirrors them exactly and skips the dispatch when any of them would have made you
exit. **Keep running them here anyway** — the trigger's copy is an optimisation,
not a replacement, it fails open on every error, and a tick can age between the
gate and your turn. They should simply never fire for you now; if one does, the
two readings have drifted and that is worth a line in the run log.

Why the split exists: over 46 days this lane took **1,534 dispatches and
produced 6 pings** — 0.4%. The other 1,528 woke a Haiku session to compute "is
the user stopped, and did the stop begin in the last 20 minutes", which is
arithmetic over two timestamps, and exited. That is Rule #0b's line: code owns
the geometry, the model owns the language. Step 1c (wandering vs transit, the
routine walk) and Step 2.5's distances are code too; which place, and whether
it is worth saying, stay here, where they belong.

The trigger writes one line per tick to `data/logs/location-ambient.log`
with the reason it skipped or dispatched. **That log is now this lane's liveness
signal**; the dispatch count no longer is, because the healthy state is ~1-3
dispatches a day. Kill switch for the gate: `touch
data/.location-ambient-gate-off`.

## Step 1 — Detect a fresh STOP inside a wandering session

Two conditions, and both are required. A wandering session establishes that a rec is *wanted*; a fresh stop establishes that it can be *read*.

**1a — The user must be stopped right now.**

```bash
ACTIVITY=$(bin/findme activity --json)
```

The newest `location_history` row must be an **open visit** (`segment_type == "visit"` AND `departed_at` IS NULL), or carry `activity == "stationary"` on a fix less than 10 min old. If the user reads as `walking`/`cycling`/`scooting`/`driving`, **SKIP silently** — this is the case the "fire when the user STOPS" rule removed. Do not compose anything "ready for when the user stops"; the next tick will catch the stop, and a pre-composed message goes stale.

**1b — The stop must be FRESH.** `arrived_at` within the last **20 minutes**. Past that the user has settled into wherever they are (lunch, a shop, a friend's place) and an unsolicited "there's a place nearby" is an interruption, not an observation. A long-settled stop is `location-enrich`'s territory, not this job's.

No collision with `location-enrich`: that job asks about a stop **after** it ends (`ready_at = departed_at + 15 min`), this one speaks at the **start** of one. Different edges of the same visit.

Record the stop's coordinates as `CURRENT_LAT`/`CURRENT_LON` — every distance check in Step 2.5 measures from where the user is standing, not from a session-start position or a neighborhood centroid.

**1c — A wandering session must have preceded the stop. Computed in code.**

The trigger already ran `bin/location-ambient-geom wander` and only dispatched you if it passed; its verdict is in `data/location-ambient-geom.json` (`kind`: `wandering` or `ambiguous`, plus `radius_m`, `arc_m`, `ratio`). Do not recompute it. What it checks (`lib/ambient-geometry.mjs`):
- **Routine walk** — within 300m of a home (`agent/local/config/routine-walk.json` `homes`, else the `home` entries of `data/named-locations.json`) during one of its `ambient_windows` (home-zone hours) → skipped before you were dispatched. With no windows configured nothing is skipped as one.
- **Wandering vs transit** over the 40 min of fixes before the stop: all within 800m of their centroid AND straight-line/path-length < 0.6 → `wandering`; ratio > 0.75, a < 50m cluster, or spread beyond 800m → transit (skipped); fewer than 3 fixes → skipped.
- **`ambiguous`** (ratio 0.6–0.75) is the only case you judge: if the stop reads like the end of a point-to-point trip rather than a stroll, exit silently.

If the file is missing, the gate failed open — proceed on the other signals.

## Step 2 — Research something worth sharing

**Step 2.0 — Exclude anywhere already on today's timeline (do this first, before any tier).**

Before evaluating Tier A/B/C candidates, pull two things:
- Today's calendar events with a physical location (`gog calendar list`, today's date range, skip transparent/all-day).
- Today's already-resolved stops (`location-day` / `location_stops` for today).

Build an exclusion set of names/addresses from both. Drop any Tier A/B/C candidate place that matches a name or address already in that set — regardless of whether the matching event/stop is in the past or still upcoming. A place the user already visited today (or is already headed to per the calendar) is not a fresh recommendation, even if it would otherwise be a great one. This closes a real gap: the ambient pulse once recommended a café as a coffee spot to walk to ~90 min *after* the user had already had coffee there — the calendar event was sitting right there and nobody checked it.

**Step 2.1 — Session candidate cache (avoid re-researching the same walk every 30 min).**

Read `data/location-ambient-candidates.json` if present and its `session_start_ts` matches the current `location-ambient-last.json` session (same walk). If it does, skip straight to Step 2.2 using its `candidates[]` list instead of re-running web searches — just refresh each candidate's live distance from `CURRENT_LAT`/`CURRENT_LON`. If it's a new session (or the file is stale/missing), run the tier search below fresh and write the result to this file (candidates found, each with `name`, `lat`, `lon`, `tier`, `why`) before proceeding. This keeps repeat ticks within budget: research happens once per walking session, proximity is re-checked every tick.

Based on current location, gather candidates in priority order (do not filter by distance yet — that's Step 2.5):

**Tier A — Strategic recommendation (highest value):**

Search for authentic restaurants near current position using `places` tool. For each candidate:
- Check if within 100m of a restaurant the user already trusts (the trusted-restaurants reference named in this instance's additions) → surface immediately (free win)
- Cross-check against the user's food taste (memory) for authenticity + price preference
- Avoid re-recommending from visited-restaurants memory
- Pick the highest-rated authentic match within the user's price range; prefer smaller/cheaper over famous/expensive

**Tier B — Enabling information (moderate value):**

If no restaurant surfaces, check for timely context:
- Event happening nearby today? (food market, pop-up, exhibit)
- Recent Eater/Infatuation piece about this neighborhood? (max 2 web searches)
- Format: "You're two blocks from [Place] — [specific timely news]"

**Tier C — Useful context (lower value):**

Neighborhood insight only if it passes the "thought partner" test — would the user find this worth thinking about? (Not a sightseeing guide fact.) **A Tier C candidate must still resolve to ONE specific place with coordinates** (the bakery, the courtyard, the market stall) — never a multi-venue "here's what this neighborhood has" roundup. If the insight can't be pinned to a single point on the map, it isn't a Tier C candidate, it's a guidebook fact — drop it.

**Quality bar:** if none of the tiers produce something specific and actionable, **stay silent**.

**Budget:** 3 web searches, 3 min wall-clock, 10 tool calls total — per walking session (Step 2.1's cache), not per tick.

## Step 2.5 — Proximity gate (the actual trigger)

This is the step the timeliness rule added. Everything above finds candidates; this step decides whether **now** is the moment to speak.

`TRIGGER_RADIUS_M = 150`

For every candidate surfaced across Tiers A/B/C (fresh or from the Step 2.1 cache), get the live distances in code — write the candidates (`[{name, lat, lon, tier, why}]`, the same shape as the Step 2.1 cache) to a file and run:

```bash
bin/location-ambient-geom proximity --lat "$CURRENT_LAT" --lon "$CURRENT_LON" --candidates <file>
```

It returns `ranked[]` (each with `distance_m`, closest first) and `fire` (the closest candidate if within 150m, else null). Never estimate a distance yourself.

- **If the closest candidate is within `TRIGGER_RADIUS_M`:** proceed to Step 3 with that ONE candidate. Tier still matters as a quality/tie-break signal (prefer a close Tier A over an equally-close Tier C), but proximity is the gate, not tier alone — a Tier A pick 400m away does not fire just because it's the best-quality candidate; a closer Tier B/C pick that clears the radius wins the tick.
- **If nothing is within `TRIGGER_RADIUS_M`:** do not compose anything. Do not fall back to a "you're in the neighborhood" summary of the candidates that didn't clear the gate — that fallback is exactly what produced the neighborhood-morning roundup. Update the Step 2.1 cache with current distances (so the next tick doesn't re-search) and exit silently for this tick.
- **One stop, one chance.** The closest-approach rule this replaced existed to avoid speaking after the user had already walked past the nearest point — a problem that only arises mid-walk. Now the trigger IS the stop, so the distance is not moving: measure once from `CURRENT_LAT`/`CURRENT_LON`, decide, and don't re-evaluate the same candidate against the same stop on a later tick. A candidate already sent this session is never re-sent (session cool-down in the Preflight gates still applies at the message level, not just the walk level).

## Step 3 — Compose and send

Content rules:
- **Exactly one place per message.** Never bundle multiple named venues ("X has good falafel, and Y has good jam") — that reads as a guidebook, not a live observation, and was the direct cause of the roundup miss. If Step 2.5 surfaced more than one candidate within radius, send the closest and hold the rest for a later tick (subject to the Preflight/session cool-downs).
- Lead with the insight, not the announcement ("<restaurant> expanded their dumpling line" not "FYI you're in <neighborhood>")
- The proximity itself is part of the insight, not filler — "You're right by [Place]" or "steps from [Place]" is the honest reason the message exists now and not 20 minutes ago or later; this is different from a robotic distance readout ("142m away") which Rule #0 still forbids.
- Specific named place or fact, never generic
- One paragraph OR bullet + action nudge, max 4 lines
- Tone: thought partner, not tour guide

If quality bar not met, **exit silently — no empty pings**.

Send:

```bash
# geo-gate-ok: proximity IS the gate, and it is strictly stronger than the travel one.
# `travel in-city` answers "will the user be in that metro on the event date"; this job only
# ever speaks about a candidate within 150m of the GPS fix the user is standing on right now
# (Step 2.5), so presence is measured rather than predicted. Adding --event-city/--event-date
# would re-derive a weaker answer from the timeline for a place the user is demonstrably at.
bin/jori-send-curl --suppress-hook --intent location-ambient "<message>"
```

## Step 4 — Record

**Append to `data/pulse-runs.jsonl`:**

```json
{"ts":"<ISO>","mode":"ambient","lat":<num>,"lon":<num>,"neighborhood":"<name>","insight":"<message>","candidate_distance_m":<num>,"outcome":"sent|skipped"}
```

This append happens on every outcome, sent or skipped — an investigation found a sent ambient message with no corresponding `pulse-runs.jsonl` row at all, which made the incident harder to reconstruct. Do not treat "the send succeeded" as license to skip the record step.

**Update `data/location-ambient-last.json`:**

```json
{"session_start_lat":<num>,"session_start_lon":<num>,"session_start_ts":"<ISO>","last_ambient_ping_ts":"<ISO>"}
```

**Update `data/location-ambient-candidates.json`** (Step 2.1's session cache):

```json
{"session_start_ts":"<ISO, matches location-ambient-last.json>","candidates":[{"name":"<place>","lat":<num>,"lon":<num>,"tier":"A|B|C","why":"<one line>","last_distance_m":<num>,"sent":false}]}
```

Mark a candidate `sent:true` once its message goes out, so it's never re-sent later in the same walking session even if the user doubles back through the same spot. Delete this file (or let it go stale — checked by `session_start_ts` mismatch) once the walking session ends.

**Count the ping against the shared daily budget** (only when a message was actually sent):

```bash
bin/ping-budget record
```

This bumps `today.pings` / `last_ping_at` in `data/hum-state.json` — the same live counter hum's sends go into and the trigger's P4 gate reads.

## State files

**`data/location-ambient-last.json`** — session tracking + 90-min cool-down per-session.

**`data/location-ambient-candidates.json`** — per-session candidate cache with live coordinates + last-known distance, so proximity is re-checked every tick without re-running Tier A/B/C research every 30 minutes.

**`data/hum-state.json`** (`today.pings`, `last_ping_at`) — the shared daily ping budget's live counter (6/day, 45 min apart; `lib/ping-budget.mjs`). Written via `ping-budget record`, never edited by hand. `pulse-state.json` is retired — nothing writes or reads it.

**`data/pulse-runs.jsonl`** — shared append-only log of all pulse runs.

## Guardrails

- **Never recommend a place already on today's calendar or already visited today** — check Step 2.0's exclusion set before surfacing anything, in every tier.
- **Never speak while the user is moving** — walking, cycling, scooting or driving. It cannot be read, and the system-wide motion gate would park it anyway (see `lib/motion-state.mjs`). Speak on the tick where the user has just stopped.
- **Never speak unless a specific candidate is within `TRIGGER_RADIUS_M` (150m) of the stop's GPS fix** — a cron tick landing during a wandering session is not, by itself, a reason to say something. Proximity is the trigger; the tick is only when we check.
- **Never bundle multiple venues in one message** — one candidate, the closest one, per ping.
- **Max 1 ambient ping per walking session, 90-min cool-down**
- **Share something new** — near home, the bar is higher
- **Trusted-restaurant proximity is a gift** — no research overhead
- **Silent runs are fine** — most ticks produce nothing
- **No email, no tasks, no calendar events** — phone notification only
- **Idempotent** — running twice in same 30-min window must not double-ping
- **Respect daily ping cap** — if combined pulse + ambient ≥4 today, exit silently

## Failure modes

- **No recent location data:** exit silently
- **The user is still moving:** exit silently — do not pre-compose for the next tick
- **Stop is older than 20 min:** exit silently — the user has settled, this is `location-enrich`'s edge of the visit
- **Quality bar unmet:** stay silent, no empty pings
- **No candidate within trigger radius:** stay silent this tick, cache candidates for the next one
- **Candidate has no resolvable coordinates:** drop it from consideration rather than guessing a distance
- **Tool failure:** exit gracefully, don't cascade errors
- **Concurrency:** lock file + webhook timing prevent >1 dispatch per 30 min
