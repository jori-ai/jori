Monthly re-fit of the spa heating formula from accumulated session data.

The spa is configured in `agent/local/config/spa.json` (`server_url`, `lat` / `lon`, `tz`, `fallback_f_per_min`); without a spa the trigger never dispatches.

## Purpose

Jori and the companion app both quote "time until the spa is ready". SpaServer
(`estimate_minutes_to`) answers from, in order: a live rate measured in the
current session; the **fitted line** (`HEATING_FIT_A` / `HEATING_FIT_B`, recorded
as `served_formula` in the packet), driven by the air temperature; and a flat
**minutes per °F** fallback (`HEATING_DEGREES_PER_MINUTE`, reported as
`current_fallback`) only when there is no usable air reading. The flat figure
began as a placeholder: two constants in SpaServer once disagreed by more than 3×,
and nothing had recorded enough data to say which was closer.

A flat constant cannot be right, because heating rate is not constant. The heater
delivers roughly fixed power, so the rate is governed by how fast the water sheds
heat, which scales with the water/air gap:

```
dT/dt  =  a  -  b * (T_water - T_air)
```

That is why the two constants could both seem defensible — they were each right
for different weather. This job fits `a` and `b` from real sessions and reports
where the estimate stands, so the line SpaServer serves can be kept honest.
Target horizon is about a year, reassessed every 30 days.

Output goes to the user. Since 2026-11-08 the job also **installs each better
re-fit on SpaServer itself**, on the user's standing word, until the line is
trusted — see Step 1b and Guardrails.

## Pipeline

```
spa
  └─ SpaServer logs each polling tick + a per-session summary
       └─ spa-heating-sync  (daily cron)  →  Supabase
            ├─ spa-weather-backfill  (called inline, best-effort)  →  weather_* columns
            └─ spa-heating-model  (monthly)  →  fit + tune + email
                 └─ bin/spa-heating-tune  →  PUT {server}/heating-formula  (when better)
```

**Ambient temp has two sources.** The on-site sensor (`air_temp_mean`, from
SpaServer) logs on few sessions — that was the actual blocker to a fit, not
session count. A weather service supplies ambient temperature, and rain and
wind with it. `lib/spa-weather.js` pulls historical hourly
temp/precipitation/wind from Open-Meteo's free archive API (no key), keyed to
the spa's fixed coordinates (`lat` / `lon` in the spa config) and each
session's local date/hour.
`lib/spa-weather-backfill.js` fills `weather_air_temp_f` /
`weather_precip_in` / `weather_wind_mph` on any session missing them — called
automatically at the end of every `spa-heating-sync` run (best-effort; a
weather-API failure never fails the sync), and separately runnable as
`bin/spa-weather-backfill` for a manual catch-up. A date too recent for
the archive API's ~5-day reanalysis lag is left `weather_fetched_at: null` and
retried on the next sync — never guessed.
`spa-heating-model-data` uses `weather_air_temp_f` for every session and
falls back to the sensor only when the weather API has no value
(`sessions[].air_source` says which). **The sensor is not the primary
source.** It can read warm against the weather API on sessions that have
both — worst at night, which suggests it picks up heat from the equipment
pad — and it may only exist for the newest sessions, so preferring it would
shift the gap for exactly those sessions and mix two scales in one
regression. `sensor_vs_weather` in the
packet keeps tracking that offset, and `sessions[].sensor_air` carries the
sensor's heating-phase reading for comparison.

## Step 1 — Build the packet

```bash
node bin/spa-heating-model-data > /tmp/spa-heating-$(date +%F).json
node bin/spa-heating-model-data --text
```

**All arithmetic is in that CLI. Do not re-derive any number in the playbook.**
It computes each session's rate by regressing temperature against time across the
session's ticks, rather than `(end - start) / duration` — the probe reports
integer °F, so at ~0.2 °F/min most consecutive readings are identical, and
endpoint differencing discards every intermediate sample while inheriting the
full ±0.5 °F rounding error at both ends.

The slope covers the **heating phase only**: the settled baseline up to the
first tick at the heater setpoint (`max_temp`, not `target_temp`, which
is only the readiness threshold). Sessions often hold at setpoint for hours
afterwards, and a whole-session slope over that flat stretch produces absurd
100+ min/°F rows. Rain was a red herring. A phase shorter than 10 minutes or climbing less than 3°F is dropped
rather than replaced by the session summary, because that summary's rate spans
the same hold time.

**The fit uses tick-measured sessions only.** Session-summary rates (older
recovered history) are endpoint differences that scatter widely on the same
heater. Ambient can't explain that much spread, and those rows held R² at ≈0
even after the ambient and heating-phase fixes. They still count in
`observed` and the per-session table. Every session with ticks feeds
`sessions_fit`, so it grows each month. Report it next to `sessions_usable` so a small `n` is read as a small
`n`.

**Sessions that don't make sense stay out.** Three ways a session leaves every
count, median and fit (and the per-session table), each listed in the packet:

- `exclude_sessions` in `agent/local/config/spa.json` (`{ session_id, reason, decided }`)
  — sessions the user ruled out by name; the packet lists them as `excluded_sessions`.
- `stall_f_per_min` in the same file — a heating-phase rate under it is a stalled
  heater, dropped automatically and listed as `stalled_sessions` (possible heater
  faults).
- The user's standing word to disregard any session that doesn't make sense: when
  the table holds one that cannot be a real warm-up (a rate or temperature the
  heater and water could not produce, a clock or sensor glitch), add it to
  `exclude_sessions` yourself, quoting that standing word in `reason` and naming
  the physical impossibility. Judge by the physics, never by how much a session
  moves the fit. A merely slow, noisy or off-season session is data, not an error.

Never put an excluded or stalled session back into any figure. Name each one in one
line of the email (id or date, rate, why), and on the run it first appears say it was
dropped under the standing word so the user can overrule it.

Key fields:

| Field | Meaning |
|---|---|
| `excluded_sessions` | Sessions the user ruled out (kept out of everything below) |
| `stalled_sessions` | Sessions under `stall_f_per_min`: possible heater faults, kept out of everything below |
| `sessions_usable` | Sessions with a settled baseline and >10 min of heating |
| `sessions_fit` | Tick-measured sessions with ambient data — the only ones `model` is fitted on |
| `ambient_range` | Air-temp span of the fit set — the honesty check on the fit |
| `observed.median_min_per_degree` | What all usable sessions actually did, tick-measured or not |
| `model` | Fitted `a`, `b`, `R²` over `sessions_fit` (null until 5+) |
| `model_ready` | True when 5+ sessions AND R² ≥ 0.5 |
| `ambient_coverage` | `{sensor, weather_api, none}` — where each session's ambient reading came from; `sensor` counts only sessions the weather API missed |
| `sensor_vs_weather` | On-site sensor minus weather API on sessions that have both (`n`, `mean_f`, `min_f`, `max_f`) — informational |
| `model_wind` | Informational second fit adding wind speed (`f_per_min = a + b*gap + c*wind_mph`); null until 15+ sessions AND real spread in wind speed (≥3 mph) — see Step 2 |
| `settle_delta` | How far the pre-circulation reading sat from the settled one |

## Step 1b — Tune (installs the new line when it is better)

```bash
node bin/spa-heating-tune > /tmp/spa-heating-tune-$(date +%F).json
```

The user's standing word, recorded verbatim in `spa.json` `tuning_decided`, is to
keep re-tuning monthly without being asked until the line is trusted. So this
step **does** change what SpaServer quotes, with no confirmation (without
`tuning_decided` the CLI reports the re-fit and installs nothing). Run it every month; do not second-guess
or re-derive its decision — every rule is in `lib/spa-heating-tune.cjs`:

- **Judged on warm-up time, not R².** error = predicted ÷ actual minutes − 1
  (+ = quoted long). R² stays low because the rate barely varies over the air
  temperatures seen so far; that is not a defect.
- **Installs** when the re-fit (fitted with b ≤ 0) is physically sane, its
  leave-one-out error beats the served line's error on the same sessions, and it
  moves a typical 82→101 °F warm-up by 1–25%. Then it `PUT`s the line
  (`X-Tuning-Key` = `SPA_SERVER_TUNING_KEY`), reads it back, and updates
  `served_formula` in `spa.json`. No redeploy, no restart.
- **Holds for the user** (`held_for_user: true`) a re-fit that would move the
  warm-up by more than 25% — likely a data fault. Say so in the email and ask.
- **Converges** (`convergence.converged`) when: ≥ 40 fit sessions, ≥ 20 °F of air
  span, ≥ 8 sessions since the served line was installed with median error
  ≤ 10% and |bias| ≤ 5%, and the last 2 runs each moved the typical warm-up
  < 3%. After that it installs nothing and only monitors; it **reopens** by
  itself if the served line drifts past 20% median error or 10% bias on 8+ new
  sessions.

Exit 1 = nothing was installed (the error says why, e.g. server unreachable or the
server's 422 refusing an out-of-bounds line). Report it in the email; never retry
by hand-editing SpaServer, `spa.json` or the server's data file.
The rollback, if the user asks for one: `DELETE {server}/heating-formula` with the
tuning key puts SpaServer's `config.py` defaults back.

## Step 2 — Interpret

Write a short analysis covering:

1. **Where the estimate stands.** Observed median min/°F versus what SpaServer
   quotes: the `served_formula` (compare it to the new `model`: if `a` and `b`
   have moved, say by how much and what that does to a typical 82→101 °F
   warm-up) and the `current_fallback` (skip either comparison when it is null).
   If they differ materially, say so plainly and quantify what it means for a
   typical warm-up.
2. **Whether the model is usable yet.** `model_ready` false means report progress
   and stop — do not present a fitted line as actionable.
3. **Coverage, not just fit.** A high R² over a narrow `ambient_range` is
   overfitting to one season. Summer-only data will look excellent and
   generalise badly to winter. State the span explicitly and say what is missing.
4. **The settle delta.** If the pre-circulation reading is consistently off by
   several degrees, that is worth reporting on its own — it means any ETA quoted
   in the first few minutes after "spa on" is built on a stale number.
5. **Jets.** If jets-heavy sessions read slower, note it; aeration drives
   evaporative loss and it is a real term, not noise.
6. **Ambient source.** Report `ambient_coverage`. Ambient comes from the
   weather API for every session it covers, which is an hourly reading for the
   area rather than a probe at the spa. If `sensor_vs_weather` drifts well
   away from its usual offset (compare last month's state), say so; that
   means the sensor or its siting changed.
7. **Tuning (lead with this).** From the Step 1b output: installed or not and
   why (`reasons`), old → new `a`/`b`, `typical_warmup` served vs new minutes,
   `errors` (served in-sample, candidate leave-one-out, served out-of-sample),
   and the convergence checklist (`convergence.checks`, each `have` vs `need`).
   The checklist is the honest answer to "how close is this to trusted". On the
   run that converges, say plainly that tuning is done and the job now only
   watches.
8. **Wind, if `model_wind` is populated.** It's informational, reported
   *alongside* `model`, never in place of it — treat `c` (the wind
   coefficient) the same way you'd treat any single-digit-n regression
   coefficient: interesting if `R²` clearly beats the no-wind model, otherwise
   just "not enough sessions with enough wind spread yet."

Be honest about sample size. With under ~20 sessions this is a progress report,
not a conclusion.

## Step 3 — Deliver

Per the long-form delivery rule in `ops-agent/CLAUDE.md`:

One command. `bin/digest-deliver` sends the HTML email to the user, finds it
in Gmail by exact subject (bounded wait), labels `personal` + star + mark
read — **no `p1`** (a Jori-initiated digest is not P1) — verifies it is
still in the INBOX, then sends the one-line phone pointer (`--no-push`, so
the push below is the only buzz) and the APNs push with the subject line. Do not
hand-run `email-send`, `gmail-action`, `jori-send-curl` or `jori-notify`.
Include the per-session table and the fit in the email.

```bash
SUBJECT="Spa heating model — <N> sessions, <X> min/°F"
bin/digest-deliver \
  --subject "$SUBJECT" \
  --body-file /tmp/spa-heating-model.html \
  --intent spa-heating-model \
  --pointer "<one line>" \
  --push "$SUBJECT"
```

Exit 1 = the email did not send and nothing else ran — report it. Exit 2 = sent
but unlabeled — note it.

Times in the user's zone.

## Step 4 — Update state

Write `data/spa-heating-model-state.json`:

```json
{
  "last_run": "2026-09-01T09:20:00Z",
  "sessions_usable": 7,
  "median_min_per_degree": 4.6,
  "model": { "a": 0.31, "b": -0.004, "r2": 0.71 },
  "model_ready": false,
  "ambient_span_f": 12.4,
  "recommended_fallback_min_per_degree": null,
  "served_formula": { "a": 0.29, "b": -0.0022, "since": "2026-11-08" }
}
```

`recommended_fallback_min_per_degree` stays null until `model_ready` is true AND
the ambient span exceeds ~25°F. It is a recommendation for the user, never applied
automatically (the flat fallback only answers with no air reading).

`served_formula` here mirrors what Step 1b leaves live. The tuning history and
convergence flag live in their own file, `data/spa-heating-tune-state.json`,
written only by `bin/spa-heating-tune` — never edit it by hand.

## State file

`data/spa-heating-model-state.json` — written once per run, read by the
next run to report drift ("last month said 4.6, now 4.9"). Not gitignored; it
contains no personal data.

## Guardrails

- **Rain stays out of the model.** Precipitation is not a third variable:
  the spa is rarely used in rain, so ambient temp and wind are enough.
  `weather_precip_in` keeps syncing
  (it's free alongside temp/wind from the same Open-Meteo call) but is not fit
  into `model` or `model_wind`. Don't re-raise this without a fresh ask.
- **Read-only on the spa.** This job never starts, stops or otherwise touches the
  spa. It reads Postgres and sends one email.
- **The fitted line changes only through `bin/spa-heating-tune`.** The user's
  standing word (`spa.json` `tuning_decided`, Step 1b) authorises it to install each
  better re-fit with no confirmation until it converges. Nothing else is covered:
  the flat fallback (`HEATING_DEGREES_PER_MINUTE`), the `config.py` defaults
  (`HEATING_FIT_A` / `HEATING_FIT_B`), the bounds, and the tuning rules in
  `lib/spa-heating-tune.cjs` change only on the user's word. A `held_for_user`
  re-fit is installed only when the user says so (then `PUT` it with the tuning
  key and record the decision).
- **Never presents a fit as settled science before the data supports it.** Report
  `model_ready: false` plainly rather than dressing up a thin fit.
- **Silent on empty.** The trigger script exits before dispatch below 3 usable
  sessions, so the first months produce nothing. That is intended — no monthly
  "still collecting" email.

## Failure modes

| Failure | Behaviour |
|---|---|
| Supabase unreachable | CLI exits non-zero; job reports the failure once, no email |
| `--count` throws in the trigger | Prints 0, gate skips, no dispatch (never crashes cron) |
| 0 usable sessions but rows exist | Means no session reached a settled baseline — worth flagging, likely a collection bug rather than a quiet month |
| Sync stalled | If `sessions_total` has not moved since last run, say so — the fault is in `spa-heating-sync`, not here |
| SpaServer unreachable at Step 1b | `spa-heating-tune` exits 1 before installing anything; report it, next month retries |
| Server refuses the line (422) | A bounds failure the CLI's own check should have caught: report the `detail` verbatim, install nothing |
| Weather API down/rate-limited | `spa-weather-backfill` fails silently (logged, non-fatal) inside `spa-heating-sync`; `weather_fetched_at` stays null and the next daily sync retries. `ambient_coverage.none` rising is the symptom to watch for |
