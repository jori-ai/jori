-- 0140 trips: published area reservoirs (the vetted inventory per travel area,
-- bin/trip-reservoir-*) and rendered day plans (bin/trip-day-render,
-- lib/hum-intent.mjs). Writes are service role; a trip site reads (and marks
-- entries done) as the signed-in allowed user.

create table if not exists public.trip_reservoirs (
  area       text primary key,
  label      text not null,
  date_range jsonb,                 -- {start,end} when the leg is dated
  area_html  text not null,
  structured jsonb,                 -- the full reservoir JSON
  updated_at timestamptz not null default now()
);

-- One rendered plan per (date, area). Derived from bin/trip-day-render: the
-- overlay holds no DDL for it.
create table if not exists public.trip_day_plans (
  date        date not null,
  area        text not null default '',
  tz          text,
  title       text,
  manifest    jsonb not null,       -- the whole plan plus every resolution and photo url
  rendered_at timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (date, area)
);

alter table public.trip_reservoirs enable row level security;
alter table public.trip_day_plans  enable row level security;

drop policy if exists trip_reservoirs_allowed_select on public.trip_reservoirs;
create policy trip_reservoirs_allowed_select on public.trip_reservoirs
  for select to authenticated using (public.jori_is_allowed_user());
drop policy if exists trip_reservoirs_allowed_update on public.trip_reservoirs;
create policy trip_reservoirs_allowed_update on public.trip_reservoirs
  for update to authenticated using (public.jori_is_allowed_user()) with check (public.jori_is_allowed_user());
-- trip_day_plans: service role only.
