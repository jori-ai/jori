-- 0130 cruise: every sailing the cruise-watch extractors return, its price
-- history, per-ship photos and ratings, and per-user favourites
-- (lib/cruise/*.mjs, bin/cruise-*, jobs/cruise-watch). Writes are service
-- role; a browsing site reads as the signed-in allowed user.

create table if not exists public.cruise_sailings (
  sailing_id                    text primary key,
  source                        text not null,        -- extractor key (the line)
  data_source                   text default 'direct', -- feed | direct (derived from code usage)
  cruise_id                     text,
  ship_name                     text,
  ship_built_year               int,
  departure_port                text,
  departure_port_code           text,
  departure_port_region         text,
  depart_date                   date,
  return_date                   date,
  nights                        int,
  lowest_balcony_per_person_usd numeric,
  per_person_per_night_usd      numeric,
  taxes_fees_included           boolean,
  currency                      text,
  booking_url                   text,
  product_url                   text,
  matched_port                  text,
  matched_city                  text,
  matched_window                text,
  matched_window_assumed        boolean not null default false,
  hero_image_url                text,
  is_match                      boolean not null default false,  -- reachable AND under the price/age gates
  is_reachable                  boolean not null default false,  -- right port, right dates
  prev_balcony_per_person_usd   numeric,
  prev_price_at                 timestamptz,
  price_change_usd              numeric,
  price_change_pct              numeric,   -- sticky between changes; check price_changed_at
  price_changed_at              timestamptz,
  lowest_ever_per_person_usd    numeric,
  lowest_ever_at                timestamptz,
  is_all_time_low               boolean not null default false,
  promos                        jsonb,     -- null = not published; [] = none active
  promos_changed_at             timestamptz,
  ports_of_call                 jsonb,     -- [{code,name}], embark/disembark excluded
  ports_ordered                 boolean,
  disembark_port                text,
  disembark_port_code           text,
  last_run_at                   timestamptz,
  first_seen_at                 timestamptz not null default now(),
  last_seen_at                  timestamptz not null default now()
);
do $$
declare c text;
begin
  foreach c in array array[
    'data_source text default ''direct''', 'matched_window_assumed boolean not null default false',
    'is_reachable boolean not null default false', 'prev_balcony_per_person_usd numeric',
    'prev_price_at timestamptz', 'price_change_usd numeric', 'price_change_pct numeric',
    'price_changed_at timestamptz', 'lowest_ever_per_person_usd numeric', 'lowest_ever_at timestamptz',
    'is_all_time_low boolean not null default false', 'promos jsonb', 'promos_changed_at timestamptz',
    'ports_of_call jsonb', 'ports_ordered boolean', 'disembark_port text', 'disembark_port_code text'] loop
    execute 'alter table public.cruise_sailings add column if not exists ' || c;
  end loop;
end $$;
create index if not exists cruise_sailings_source_depart_idx on public.cruise_sailings (source, depart_date);
create index if not exists cruise_sailings_depart_date_idx   on public.cruise_sailings (depart_date);
create index if not exists cruise_sailings_port_idx          on public.cruise_sailings (departure_port_code);
create index if not exists cruise_sailings_match_idx         on public.cruise_sailings (is_match) where is_match = true;
create index if not exists cruise_sailings_reachable_idx     on public.cruise_sailings (is_reachable) where is_reachable = true;
create index if not exists cruise_sailings_price_idx         on public.cruise_sailings (per_person_per_night_usd) where per_person_per_night_usd is not null;
create index if not exists cruise_sailings_price_changed_idx on public.cruise_sailings (price_changed_at desc) where price_changed_at is not null;
create index if not exists cruise_sailings_atl_idx           on public.cruise_sailings (is_all_time_low) where is_all_time_low = true;

-- Append-only, written only when a price actually changes.
create table if not exists public.cruise_price_history (
  sailing_id               text not null,
  observed_at              timestamptz not null default now(),
  balcony_per_person_usd   numeric,
  per_person_per_night_usd numeric,
  primary key (sailing_id, observed_at)
);
create index if not exists cruise_price_history_sailing_idx on public.cruise_price_history (sailing_id, observed_at desc);

create table if not exists public.cruise_ship_photos (
  line        text not null,
  ship_name   text not null,
  photo_url   text,                 -- null = a recorded miss, not missing data
  width       int,
  height      int,
  source      text,
  source_page text,
  credit      text,
  checked_at  timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (line, ship_name)
);
create index if not exists cruise_ship_photos_have_idx on public.cruise_ship_photos (line) where photo_url is not null;

create table if not exists public.cruise_ship_ratings (
  line          text not null,
  ship_name     text not null,
  rating        numeric,
  review_count  int,
  editor_rating numeric,
  source_url    text,
  checked_at    timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (line, ship_name)
);

-- Per-user stars, written from the site with the user's own JWT.
create table if not exists public.cruise_favorites (
  sailing_id text not null,
  user_email text not null,
  created_at timestamptz not null default now(),
  primary key (sailing_id, user_email)
);
create index if not exists cruise_favorites_user_idx on public.cruise_favorites (user_email);

do $$
declare t text;
begin
  foreach t in array array['cruise_sailings','cruise_price_history','cruise_ship_photos','cruise_ship_ratings','cruise_favorites'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  foreach t in array array['cruise_sailings','cruise_price_history','cruise_ship_photos','cruise_ship_ratings'] loop
    execute format('drop policy if exists %I on public.%I', t || '_allowed_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.jori_is_allowed_user())', t || '_allowed_select', t);
  end loop;
end $$;

drop policy if exists cruise_favorites_read_own on public.cruise_favorites;
create policy cruise_favorites_read_own on public.cruise_favorites
  for select to authenticated
  using (user_email = lower(auth.jwt() ->> 'email') and public.jori_is_allowed_user());
drop policy if exists cruise_favorites_insert_own on public.cruise_favorites;
create policy cruise_favorites_insert_own on public.cruise_favorites
  for insert to authenticated
  with check (user_email = lower(auth.jwt() ->> 'email') and public.jori_is_allowed_user());
drop policy if exists cruise_favorites_delete_own on public.cruise_favorites;
create policy cruise_favorites_delete_own on public.cruise_favorites
  for delete to authenticated
  using (user_email = lower(auth.jwt() ->> 'email') and public.jori_is_allowed_user());

-- Re-hosted ship photos (bin/cruise-ship-photos).
select public.jori_ensure_bucket('cruise-ships', true);
