-- 0040 photos: the photo index (camera roll metadata, thumbnails, on-device
-- OCR), photo probes the host sends the phone, and the one-fetch store of
-- place photographs. Used by bin/photos, bin/photo-probe, lib/photo-probe.mjs,
-- lib/resolve-day.js, bin/place-photo-store, lib/place-photo-store.js,
-- bin/trip-place-photo, bin/brand-logo, bin/place-map, bin/stop-map,
-- bin/day-path, bin/shop-snap, apps/companion (feature "photo-probe").

create table if not exists public.photos (
  uuid              text primary key,
  taken_at          timestamptz not null,
  tz_offset_seconds integer,
  latitude          double precision,
  longitude         double precision,
  segment_id        uuid,
  place_name        text,
  media_type        text not null,
  favorite          boolean default false,
  hidden            boolean default false,
  in_trash          boolean default false,
  filename          text,
  original_filename text,
  width             integer,
  height            integer,
  duration_s        numeric,
  persons           text[] default '{}'::text[],
  keywords          text[] default '{}'::text[],
  albums            text[] default '{}'::text[],
  labels            text[] default '{}'::text[],
  title             text,
  description       text,
  match_confidence  text,
  match_reason      text,
  device_id         text,
  synced_at         timestamptz default now(),
  updated_at        timestamptz default now(),
  detected_text     text[] not null default '{}',   -- Photos' own OCR: a sorted bag of words, not a phrase
  ocr_lines         text[],                         -- the phone's OCR, as ordered lines
  device_venue      jsonb,                          -- the phone's on-device venue guess
  self_captured     boolean,                        -- taken by the user's own devices (derived from code usage)
  thumb_url         text                            -- public thumbnail URL (derived from code usage)
);
alter table public.photos add column if not exists detected_text text[] not null default '{}';
alter table public.photos add column if not exists ocr_lines text[];
alter table public.photos add column if not exists device_venue jsonb;
alter table public.photos add column if not exists self_captured boolean;
alter table public.photos add column if not exists thumb_url text;
create index if not exists photos_favorite_idx      on public.photos (favorite) where favorite = true;
create index if not exists photos_lat_lng_idx       on public.photos (latitude, longitude) where latitude is not null;
create index if not exists photos_media_type_idx    on public.photos (media_type);
create index if not exists photos_segment_id_idx    on public.photos (segment_id);
create index if not exists photos_taken_at_idx      on public.photos (taken_at desc);
create index if not exists photos_detected_text_idx on public.photos using gin (detected_text);

create table if not exists public.photo_probes (
  id           uuid primary key default gen_random_uuid(),
  visit_id     text,
  window_start timestamptz not null,
  window_end   timestamptz not null,
  status       text not null default 'pending' check (status in ('pending', 'done', 'error', 'expired')),
  requested_at timestamptz not null default now(),
  answered_at  timestamptz,
  photo_count  int,
  uuids        text[],
  error        text,
  device       text
);
create index if not exists photo_probes_status_requested_idx on public.photo_probes (status, requested_at);
create index if not exists photo_probes_visit_idx on public.photo_probes (visit_id);

-- Every place photograph fetched once, keyed on the place and slot (never the
-- provider's per-response photo reference). Bytes live in Storage (daily-photos).
create table if not exists public.place_photos (
  key          text primary key,          -- '<place_id>:<slot>'
  place_id     text not null,
  slot         integer not null default 0,
  google_ref   text,
  url          text not null,
  sha256       text,
  bytes        integer,
  content_type text,
  source       text not null default 'places',
  fetched_by   text,
  fetched_at   timestamptz not null default now()
);
create index if not exists place_photos_place_id_idx on public.place_photos (place_id);

alter table public.photos       enable row level security;
alter table public.photo_probes enable row level security;
alter table public.place_photos enable row level security;

drop policy if exists photos_app_select on public.photos;
create policy photos_app_select on public.photos
  for select to authenticated using (public.jori_is_allowed_user());
drop policy if exists photos_app_insert on public.photos;
create policy photos_app_insert on public.photos
  for insert to authenticated with check (public.jori_is_allowed_user());
drop policy if exists photos_app_update on public.photos;
create policy photos_app_update on public.photos
  for update to authenticated using (public.jori_is_allowed_user()) with check (public.jori_is_allowed_user());

drop policy if exists photo_probes_app_select on public.photo_probes;
create policy photo_probes_app_select on public.photo_probes
  for select to authenticated using (public.jori_is_allowed_user());
drop policy if exists photo_probes_app_update on public.photo_probes;
create policy photo_probes_app_update on public.photo_probes
  for update to authenticated using (public.jori_is_allowed_user()) with check (public.jori_is_allowed_user());
-- place_photos: service role only.

-- Public bucket for day maps, thumbnails, place photos, brand logos, shop snaps.
select public.jori_ensure_bucket('daily-photos', true);
do $$
begin
  if to_regclass('storage.objects') is null then return; end if;
  -- The app uploads thumbnails under thumbs/ (x-upsert needs insert + update).
  execute 'drop policy if exists daily_photos_thumbs_app_insert on storage.objects';
  execute $p$create policy daily_photos_thumbs_app_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'daily-photos' and name like 'thumbs/%' and public.jori_is_allowed_user())$p$;
  execute 'drop policy if exists daily_photos_thumbs_app_update on storage.objects';
  execute $p$create policy daily_photos_thumbs_app_update on storage.objects for update to authenticated
    using (bucket_id = 'daily-photos' and name like 'thumbs/%' and public.jori_is_allowed_user())
    with check (bucket_id = 'daily-photos' and name like 'thumbs/%' and public.jori_is_allowed_user())$p$;
end $$;
