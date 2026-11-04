-- 0030 location & presence: GPS visits/transits, phone context, phone usage
-- signals for wake/sleep, saved nights, and the travel timeline.
-- Used by bin/findme, bin/location-*, bin/day-segments, bin/live-day,
-- lib/resolve-day.js, lib/sleep-night.js, lib/sleep-wake.js, bin/travel,
-- agent/phone-channel (Realtime on location_history), apps/companion.

create table if not exists public.location_history (
  id           uuid primary key default gen_random_uuid(),
  segment_type text not null,              -- visit | transit
  latitude     double precision not null,
  longitude    double precision not null,
  accuracy_m   double precision,
  arrived_at   timestamptz not null,
  departed_at  timestamptz,
  activity     text,
  confidence   text,
  place_name   text,
  place_type   text,
  address      text,
  neighborhood text,
  city         text,
  device_id    text,                       -- the app's location device id (SupabaseConfig.locationDeviceId)
  created_at   timestamptz default now(),
  companions   text[],
  notes        text,
  source       text
);
create index if not exists idx_lh_open  on public.location_history (arrived_at desc) where departed_at is null;
create index if not exists idx_lh_place on public.location_history (place_name, arrived_at desc) where place_name is not null;
create index if not exists idx_lh_time  on public.location_history (arrived_at desc);

-- Visits only (bin/location-stops reads companions per visit). Derived from
-- code usage: the overlay holds no DDL for this name. A view keeps one store.
do $$
begin
  -- An installation that already keeps a location_visits TABLE keeps it.
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname = 'location_visits' and c.relkind <> 'v') then
    raise notice 'location_visits exists as a table; leaving it alone';
    return;
  end if;
  execute $v$
    create or replace view public.location_visits with (security_invoker = true) as
      select id, latitude, longitude, accuracy_m, arrived_at, departed_at, place_name, place_type,
             address, neighborhood, city, companions, notes, device_id, source, created_at
        from public.location_history
       where segment_type = 'visit'
  $v$;
end $$;

create table if not exists public.phone_context (
  device_id         text primary key,
  audio_class       text,
  audio_confidence  real,
  ambient_db_bucket text,
  motion_class      text,
  latitude          double precision,
  longitude         double precision,
  trigger           text,
  wifi_ssid         text,
  wifi_bssid        text,
  ts                timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
alter table public.phone_context add column if not exists wifi_ssid text;
alter table public.phone_context add column if not exists wifi_bssid text;
create index if not exists phone_context_ts_idx on public.phone_context (ts desc);
create index if not exists phone_context_wifi_ssid_idx on public.phone_context (wifi_ssid) where wifi_ssid is not null;
drop trigger if exists phone_context_set_updated_at on public.phone_context;
create trigger phone_context_set_updated_at before update on public.phone_context
  for each row execute function public.jori_touch_updated_at();

-- First app open per local date (wake-time signal).
create table if not exists public.phone_unlocks (
  device_id       text not null,
  date            date not null,
  first_unlock_at timestamptz not null default now(),
  tz              text,
  primary key (device_id, date)
);
create index if not exists phone_unlocks_date_idx on public.phone_unlocks (date);

-- Lock/unlock transitions and samples (companion feature "phone-lock").
-- Derived from the app's upsert (onConflict device_id,ts,state) and readers.
create table if not exists public.phone_lock_events (
  device_id  text not null,
  ts         timestamptz not null,
  state      text not null,                -- unlocked | locked | sample_unlocked | sample_locked
  source     text,
  tz         text,
  created_at timestamptz not null default now(),
  primary key (device_id, ts, state)
);
create index if not exists phone_lock_events_ts_idx on public.phone_lock_events (ts);

-- Hourly Screen Time usage windows (companion feature "screen-time").
-- Derived from the app's upsert (onConflict device_id,window_start).
create table if not exists public.phone_usage_windows (
  device_id         text not null,
  window_start      timestamptz not null,
  window_end        timestamptz not null,
  used              boolean not null default false,
  reached_at        timestamptz,
  last_reached_at   timestamptz,
  max_threshold_min integer,
  tz                text,
  updated_at        timestamptz not null default now(),
  primary key (device_id, window_start)
);
create index if not exists phone_usage_windows_start_idx on public.phone_usage_windows (window_start);

-- One resolved night per evening (lib/sleep-night.js SAVE_COLS). Derived from code.
create table if not exists public.sleep_nights (
  night_of          date primary key,      -- the evening's local date
  tz                text,
  phone_down_at     timestamptz,
  phone_down_exact  boolean,
  phone_up_at       timestamptz,
  phone_up_exact    boolean,
  night_wakes       jsonb,
  watch_onset_at    timestamptz,
  watch_wake_at     timestamptz,
  watch_asleep_min  numeric,
  latency_min       numeric,
  sleep_at          timestamptz,
  sleep_source      text,
  wake_at           timestamptz,
  wake_source       text,
  max_silence_min   numeric,
  updated_at        timestamptz not null default now()
);

-- The presence timeline: where the user is (or will be) at instant T.
create table if not exists public.travel_segments (
  id          uuid primary key default gen_random_uuid(),
  metro       text not null,               -- canonical metro key, lowercased with underscores
  place_label text,
  arrive_at   timestamptz not null,
  depart_at   timestamptz,                 -- null = open-ended
  source      text not null default 'manual',   -- manual (authoritative) | flights (synced)
  ref         text,                        -- stable key for synced rows
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists travel_segments_arrive_idx on public.travel_segments (arrive_at);
create index if not exists travel_segments_metro_idx  on public.travel_segments (metro);
create unique index if not exists travel_segments_ref_uidx on public.travel_segments (ref) where ref is not null;

-- RLS
alter table public.location_history    enable row level security;
alter table public.phone_context       enable row level security;
alter table public.phone_unlocks       enable row level security;
alter table public.phone_lock_events   enable row level security;
alter table public.phone_usage_windows enable row level security;
alter table public.sleep_nights        enable row level security;
alter table public.travel_segments     enable row level security;

-- The app writes its own location, context and usage rows (upserts need
-- select + insert + update).
do $$
declare t text;
begin
  foreach t in array array['location_history','phone_context','phone_unlocks','phone_lock_events','phone_usage_windows'] loop
    execute format('drop policy if exists %I on public.%I', t || '_app_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.jori_is_allowed_user())', t || '_app_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_app_insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.jori_is_allowed_user())', t || '_app_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_app_update', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.jori_is_allowed_user()) with check (public.jori_is_allowed_user())', t || '_app_update', t);
  end loop;
end $$;
-- sleep_nights, travel_segments: service role only.

select public.jori_realtime_add('location_history');
