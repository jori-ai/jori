-- 0150 spa: heating telemetry mirrored from the spa controller service
-- (bin/spa-heating-sync, lib/spa-weather-backfill.js, bin/spa-heating-model-data).
-- Derived from code usage: the overlay holds no DDL for these tables.
-- Service role only.

create table if not exists public.spa_heating_sessions (
  session_id          text primary key,
  started_at          timestamptz,
  ended_at            timestamptz,
  temp_at_command     numeric,
  temp_settled        numeric,
  settled_after_s     numeric,
  settle_delta        numeric,
  target_temp         numeric,
  max_temp            numeric,
  temp_final          numeric,
  max_temp_reached    numeric,
  air_temp_start      numeric,
  air_temp_end        numeric,
  air_temp_mean       numeric,
  pool_temp_start     numeric,
  jets_on_seconds     numeric,
  heating_seconds     numeric,
  observed_f_per_min  numeric,
  extensions_used     numeric,
  shutdown_reason     text,
  system_status       text,
  raw                 jsonb,
  weather_air_temp_f  numeric,
  weather_precip_in   numeric,
  weather_wind_mph    numeric,
  weather_source      text,
  weather_fetched_at  timestamptz
);
create index if not exists spa_heating_sessions_started_idx on public.spa_heating_sessions (started_at);
create index if not exists spa_heating_sessions_ended_idx   on public.spa_heating_sessions (ended_at);

create table if not exists public.spa_heating_ticks (
  session_id             text not null,
  observed_at            timestamptz not null,
  spa_temp               numeric,
  air_temp               numeric,
  pool_temp              numeric,
  heater_mode            text,
  cycle_state            text,
  spa_mode               text,
  jets_mode              text,
  minutes_since_spa_on   numeric,
  circulation_settled    boolean,
  heating_rate_f_per_min numeric,
  primary key (session_id, observed_at)
);
create index if not exists spa_heating_ticks_observed_idx on public.spa_heating_ticks (observed_at);

alter table public.spa_heating_sessions enable row level security;
alter table public.spa_heating_ticks    enable row level security;
