-- 0192 travel_segments: allowlisted users may READ the travel timeline.
--
-- The travel-guide site (apps/itin) builds its location ribbon from the
-- timeline itself — every stay, in order, with its real dates — instead of the
-- one date range the nightly pass copies onto each guide (which could not show
-- a city visited twice, or the stops of a multi-city loop). The site reads as
-- the signed-in user, so it needs a select policy; writes stay service-role
-- only (bin/travel, flights-scan), as 0030 set up.
--
-- Same gate as the guides themselves (trip_reservoirs, 0140) and the app's
-- location rows (0030): public.jori_is_allowed_user().

alter table public.travel_segments enable row level security;

drop policy if exists travel_segments_allowed_select on public.travel_segments;
create policy travel_segments_allowed_select on public.travel_segments
  for select to authenticated using (public.jori_is_allowed_user());
