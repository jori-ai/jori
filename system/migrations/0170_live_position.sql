-- 0170 live_position: the phone's newest position while the user is out of the
-- house, one row per device, overwritten every ~30 s / ~25 m
-- (apps/companion Jori/PhoneContextPublisher.swift LivePositionPublisher).
--
-- location_history is batched (a waypoint at most every 2 minutes, uploaded
-- every 5), so it reaches the server minutes after the fact — fine for the
-- day's record, too late for anything that has to land while the user is
-- still standing at a spot. bin/local-history-live listens to this table over
-- Realtime and turns a position into a local-history ping within seconds.
-- Nothing else depends on it; location_history stays the record.

create table if not exists public.live_position (
  device_id   text primary key,
  latitude    double precision not null,
  longitude   double precision not null,
  accuracy_m  real,
  motion      text,
  ts          timestamptz not null,
  updated_at  timestamptz not null default now()
);
drop trigger if exists live_position_set_updated_at on public.live_position;
create trigger live_position_set_updated_at before update on public.live_position
  for each row execute function public.jori_touch_updated_at();

alter table public.live_position enable row level security;
-- The app upserts its own row (select + insert + update); the server reads it
-- with the service role.
drop policy if exists live_position_app_select on public.live_position;
create policy live_position_app_select on public.live_position
  for select to authenticated using (public.jori_is_allowed_user());
drop policy if exists live_position_app_insert on public.live_position;
create policy live_position_app_insert on public.live_position
  for insert to authenticated with check (public.jori_is_allowed_user());
drop policy if exists live_position_app_update on public.live_position;
create policy live_position_app_update on public.live_position
  for update to authenticated using (public.jori_is_allowed_user()) with check (public.jori_is_allowed_user());

select public.jori_realtime_add('live_position');
