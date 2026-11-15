-- 0191 places and photo links: the photo repository's usage index and the
-- registry of places the user has been. Used by lib/photo-repo.js,
-- bin/photo-repo, bin/choice (option thumbnails), lib/decision-queue.mjs
-- (a card's cover photo) and the place-pages plugin (plugins/place-pages).
--
-- THE PHOTO REPOSITORY. A photograph is stored once: one `photos` row (0040)
-- keyed by the photo library's own id, one thumbnail in the `daily-photos`
-- bucket at thumbs/<uuid>.jpg (photos.thumb_url). Anything that shows a photo
-- points at that row; nothing copies the bytes. `photo_links` records WHERE
-- each photo is used (a place page, a person page, a trip email…), so the same
-- photo can sit on several pages and "the photos of X" is one query.

create table if not exists public.photo_links (
  photo_uuid text not null,                 -- photos.uuid
  target     text not null,                 -- usually a wiki page id; any '<kind>:<id>' a tool chooses otherwise
  role       text not null default 'gallery' check (role in ('gallery', 'cover')),
                                            -- 'cover' = chosen as the target's cover by the user (sticky)
  context    text,                          -- where the link came from, e.g. 'visit:2026-11-08:<stop start ms>'
  added_by   text not null,                 -- the tool (or 'user') that made the link
  added_at   timestamptz not null default now(),
  primary key (photo_uuid, target)
);
create index if not exists photo_links_target_idx  on public.photo_links (target);
create index if not exists photo_links_context_idx on public.photo_links (added_by, context);

-- THE PLACE REGISTRY. One row per real-world place the user stopped at long
-- enough to count, written by the place-pages plugin. A place the plugin judged
-- private (a home, an office, a doctor) or not a venue stays here with
-- page_id null, so it is never classified twice and never gets a page.
create table if not exists public.places (
  id           text primary key,            -- 'pl_<hash>' from its first sighting; stable across renames
  name         text not null,               -- the name the page carries
  names        text[] not null default '{}',-- every name it was stopped under (aliases)
  norm_names   text[] not null default '{}',-- the same, folded (case, accents, punctuation) for exact matching
  kind         text not null,               -- cafe | restaurant | bar | lounge | hotel | … | own_home | private_home | workplace | medical | transit | not_a_venue
  page_id      text,                        -- its wiki page; null for a place that gets none
  lat          double precision,
  lon          double precision,
  address      text,
  cover_uuid   text,                        -- photos.uuid of the cover (a user-pinned cover wins, see photo_links.role)
  cover_url    text,                        -- that photo's thumb_url, kept here so a card can show it in one read
  photo_count  integer not null default 0,
  visit_count  integer not null default 0,
  first_visit  date,
  last_visit   date,
  kind_source  text,                        -- 'model:<rung>' | 'user'
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists places_page_id_idx    on public.places (page_id) where page_id is not null;
create index if not exists places_norm_names_idx on public.places using gin (norm_names);

-- One row per stop at a place, rebuilt per day from the resolved day.
create table if not exists public.place_visits (
  stop_key      text primary key,           -- '<date>:<stop start ms>'
  place_id      text not null references public.places (id) on delete cascade,
  date          date not null,
  start_at      timestamptz not null,
  end_at        timestamptz,
  tz            text,
  duration_min  integer,
  name_source   text,                       -- how the day named the stop (user_confirmed, saved_place, …)
  stop_name     text,                       -- the name the day gave it
  companions    text[] not null default '{}',
  photo_count   integer not null default 0
);
create index if not exists place_visits_place_idx on public.place_visits (place_id, start_at desc);
create index if not exists place_visits_date_idx  on public.place_visits (date);

alter table public.photo_links  enable row level security;
alter table public.places       enable row level security;
alter table public.place_visits enable row level security;

-- The app reads places (a card shows a place's cover); writes are service role.
drop policy if exists places_app_select on public.places;
create policy places_app_select on public.places
  for select to authenticated using (public.jori_is_allowed_user());
drop policy if exists photo_links_app_select on public.photo_links;
create policy photo_links_app_select on public.photo_links
  for select to authenticated using (public.jori_is_allowed_user());
drop policy if exists place_visits_app_select on public.place_visits;
create policy place_visits_app_select on public.place_visits
  for select to authenticated using (public.jori_is_allowed_user());
