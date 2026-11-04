Monthly re-fit of the spa heating formula from accumulated session data.

The spa is configured in `agent/local/config/spa.json` (`server_url`, `lat` / `lon`, `tz`, `fallback_f_per_min`); without a spa the trigger never dispatches.

## Purpose

Jori and the companion app both quote "time until the spa is ready". That
number comes from a flat **minutes per °F** fallback in SpaServer
(`HEATING_DEGREES_PER_MINUTE`, reported as `current_fallback` in the packet),
which is a placeholder, not a measurement: two constants in SpaServer once
disagreed by more than 3×, and nothing had recorded enough data to say which
was closer.

A flat constant cannot be right, because heating rate is not constant. The heater
delivers roughly fixed power, so the rate is governed by how fast the water sheds
heat, which scales with the water/air gap:

```
dT/dt  =  a  -  b * (T_water - T_air)
```

That is why the two constants could both seem defensible — they were each right
for different weather. This job fits `a` and `b` from real sessions and reports
where the estimate stands, so the fallback can eventually be replaced by a
formula. Target horizon is about a year, reassessed every 30 days.

Output goes to the user. Nothing is changed automatically — see Guardrails.

## Pipeline

```
spa
  └─ SpaServer logs each polling tick + a per-session summary
       └─ spa-heating-sync  (daily cron)  →  Supabase
            ├─ spa-weather-backfill  (called inline, best-effort)  →  weather_* columns
            └─ spa-heating-model  (monthly)  →  fit + email
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

Key fields:

| Field | Meaning |
|---|---|
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

## Step 2 — Interpret

Write a short analysis covering:

1. **Where the estimate stands.** Observed median min/°F versus the
   `current_fallback` in use (skip the comparison when it is null). If they differ materially, say so plainly and quantify what
   it means for a typical warm-up.
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
7. **Wind, if `model_wind` is populated.** It's informational, reported
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
  "recommended_fallback_min_per_degree": null
}
```

`recommended_fallback_min_per_degree` stays null until `model_ready` is true AND
the ambient span exceeds ~25°F. It is a recommendation for the user, never applied
automatically.

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
- **Never edits `HEATING_DEGREES_PER_MINUTE`.** Changing the constant that quotes
  ETAs is the user's call. Recommend, with the evidence; never apply.
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
| Weather API down/rate-limited | `spa-weather-backfill` fails silently (logged, non-fatal) inside `spa-heating-sync`; `weather_fetched_at` stays null and the next daily sync retries. `ambient_coverage.none` rising is the symptom to watch for |
