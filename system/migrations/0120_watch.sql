-- 0120 watch: shows & movies (lib/watch-db.mjs, lib/watch-model.mjs,
-- bin/watchlist*, bin/movie-db-refresh, bin/movielens-embed,
-- bin/tmdb-watch-providers, bin/context-sync) and the ratings site.
--
-- Who-watches values are the installation's: audience is 'solo', 'together'
-- or the configured partner id (lib/watch-config.mjs PARTNER); ratings carry
-- the person's id (instance owner_id or PARTNER). The code validates both, so
-- the schema does not pin them.

-- v1 list, still read by bin/context-sync.
create sequence if not exists public.watchlist_id_seq;
create table if not exists public.watchlist (
  id                integer primary key default nextval('public.watchlist_id_seq'::regclass),
  title             text not null,
  type              text not null,
  category          text not null,
  description       text,
  rating            numeric,
  year_start        integer,
  year_end          integer,
  genre             text,
  platform          text,
  watched           boolean not null default false,
  notify_new_season boolean not null default false,
  imdb_id           text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  suggested_by      text,
  suggested_at      timestamptz,
  suggestion_reason text
);
alter sequence public.watchlist_id_seq owned by public.watchlist.id;
create index if not exists idx_watchlist_category on public.watchlist (category);
create index if not exists idx_watchlist_type     on public.watchlist (type);
create index if not exists idx_watchlist_watched  on public.watchlist (watched);
drop trigger if exists watchlist_set_updated_at on public.watchlist;
create trigger watchlist_set_updated_at before update on public.watchlist
  for each row execute function public.jori_touch_updated_at();

create table if not exists public.watch_titles (
  id                    bigserial primary key,
  kind                  text not null check (kind in ('show', 'movie', 'documentary')),
  name                  text not null,
  imdb_id               text unique,
  tmdb_id               integer,
  audience              text not null default 'together',
  status                text not null default 'queued'
                        check (status in ('queued', 'watching', 'watched', 'dropped', 'rejected')),
  year_start            integer,
  year_end              integer,
  genres                text,
  platform              text,
  imdb_rating           numeric(3,1),
  description           text,
  track_seasons         boolean not null default false,
  source                text,      -- manual | screen | monthly-discover | season-sync | web | ...
  source_reason         text,
  added_at              timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  feedback_requested_at timestamptz,
  vetoed_listed_at      timestamptz,
  legacy_ids            integer[],
  original_language     text,
  keywords              text,
  intro_emailed_at      timestamptz
);
alter table public.watch_titles add column if not exists original_language text;
alter table public.watch_titles add column if not exists keywords text;
alter table public.watch_titles add column if not exists intro_emailed_at timestamptz;
create unique index if not exists watch_titles_kind_tmdb on public.watch_titles (kind, tmdb_id) where tmdb_id is not null;
create index if not exists watch_titles_status     on public.watch_titles (status);
create index if not exists watch_titles_audience   on public.watch_titles (audience);
create index if not exists watch_titles_lower_name on public.watch_titles (lower(name));

create table if not exists public.watch_seasons (
  id                    bigserial primary key,
  title_id              bigint not null references public.watch_titles(id) on delete cascade,
  n                     integer not null check (n >= 0),
  status                text not null default 'unwatched' check (status in ('unwatched', 'watching', 'watched', 'skipped')),
  episodes_total        integer,
  episodes_watched      integer not null default 0,
  premiere_date         date,
  finale_date           date,
  fully_dropped         boolean not null default false,
  started_at            date,
  last_watched_date     date,
  finished_at           date,
  feedback_requested_at timestamptz,
  feedback_asks         integer not null default 0,
  added_at              timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (title_id, n)
);
create index if not exists watch_seasons_status on public.watch_seasons (status);

create table if not exists public.watch_feedback (
  id         bigserial primary key,
  title_id   bigint not null references public.watch_titles(id) on delete cascade,
  season_n   integer,
  verdict    text not null check (verdict in ('loved', 'liked', 'meh', 'disliked', 'dropped', 'not_interested')),
  note       text,
  source     text not null default 'chat',
  created_at timestamptz not null default now()
);
create index if not exists watch_feedback_title on public.watch_feedback (title_id);

drop trigger if exists watch_titles_touch on public.watch_titles;
create trigger watch_titles_touch before update on public.watch_titles
  for each row execute function public.jori_touch_updated_at();
drop trigger if exists watch_seasons_touch on public.watch_seasons;
create trigger watch_seasons_touch before update on public.watch_seasons
  for each row execute function public.jori_touch_updated_at();

create table if not exists public.watch_taste_prefs (
  id         bigserial primary key,
  audience   text not null,           -- solo | together | <partner id> | all
  tag        text not null,
  weight     numeric(3,1) not null check (weight between -3 and 3),
  note       text,
  created_at timestamptz not null default now(),
  unique (audience, tag)
);

create table if not exists public.watch_ratings (
  title_id   bigint not null references public.watch_titles(id) on delete cascade,
  person     text not null,           -- owner_id or the partner id
  verdict    text not null check (verdict in ('loved', 'liked', 'meh', 'disliked', 'not_watched')),
  source     text not null default 'web',
  updated_at timestamptz not null default now(),
  primary key (title_id, person)
);

create table if not exists public.watch_catalog (
  id                bigserial primary key,
  kind              text not null default 'movie' check (kind in ('movie', 'show')),
  tmdb_id           integer not null,
  imdb_id           text,
  title             text not null,
  year              integer,
  poster_path       text,
  overview          text,
  genres            text,
  original_language text,
  vote_count        integer,
  vote_average      numeric(3,1),
  rank              integer,
  seen              boolean,             -- null = unmarked
  marked_at         timestamptz,
  title_id          bigint references public.watch_titles(id) on delete set null,
  not_for_us        boolean not null default false,
  affinity          real not null default 0,
  skip_count        integer not null default 0,
  last_shown_at     timestamptz,
  keywords          text,
  directors         text,
  cast_names        text,
  popularity        real,
  features_at       timestamptz,
  collection        text,
  imdb_rating       real,
  rt_score          smallint,
  metacritic        smallint,
  omdb_at           timestamptz,
  providers         jsonb,
  providers_at      timestamptz,
  in_theaters       boolean not null default false,
  theatrical_date   date,
  digital_date      date,
  model_p           real,
  model_at          timestamptz,
  created_at        timestamptz not null default now(),
  unique (kind, tmdb_id)
);
do $$
declare c text;
begin
  foreach c in array array[
    'not_for_us boolean not null default false', 'affinity real not null default 0',
    'skip_count integer not null default 0', 'last_shown_at timestamptz', 'keywords text',
    'directors text', 'cast_names text', 'popularity real', 'features_at timestamptz',
    'collection text', 'imdb_rating real', 'rt_score smallint', 'metacritic smallint',
    'omdb_at timestamptz', 'providers jsonb', 'providers_at timestamptz',
    'in_theaters boolean not null default false', 'theatrical_date date', 'digital_date date',
    'model_p real', 'model_at timestamptz', 'created_at timestamptz not null default now()'] loop
    execute 'alter table public.watch_catalog add column if not exists ' || c;
  end loop;
end $$;
create index if not exists watch_catalog_rank on public.watch_catalog (seen, rank);
create index if not exists watch_catalog_next on public.watch_catalog (seen, affinity desc, rank);
create index if not exists watch_catalog_features_pending on public.watch_catalog (features_at) where features_at is null;
create index if not exists watch_catalog_model_p on public.watch_catalog (model_p desc) where kind = 'movie';

create table if not exists public.watch_film_edges (
  src_tmdb integer not null,
  dst_tmdb integer not null,
  weight   real not null,
  primary key (src_tmdb, dst_tmdb)
);

create table if not exists public.watch_batches (
  id           bigserial primary key,
  shown        jsonb not null,
  marks        jsonb not null,
  model_labels integer,
  created_at   timestamptz not null default now()
);

-- Collaborative-filtering film vectors (bin/movielens-embed). Derived from code.
create table if not exists public.watch_embeddings (
  tmdb_id    integer primary key,
  ml_count   integer,
  ml_mean    real,
  v          real[] not null,
  model      text,
  updated_at timestamptz not null default now()
);

create or replace function public.bump_catalog_affinity(p_tmdb_ids integer[], p_delta real)
returns void language sql security invoker set search_path = public as $$
  update public.watch_catalog set affinity = affinity + p_delta where kind = 'movie' and tmdb_id = any(p_tmdb_ids);
$$;
revoke all on function public.bump_catalog_affinity(integer[], real) from public, anon;
grant execute on function public.bump_catalog_affinity(integer[], real) to authenticated;

do $$
declare t text;
begin
  foreach t in array array['watchlist','watch_titles','watch_seasons','watch_feedback','watch_taste_prefs',
    'watch_ratings','watch_catalog','watch_film_edges','watch_batches','watch_embeddings'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  -- The ratings site (signed-in allowed users) reads and marks.
  foreach t in array array['watch_ratings','watch_catalog','watch_titles'] loop
    execute format('drop policy if exists %I on public.%I', t || '_allowed_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.jori_is_allowed_user())', t || '_allowed_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_allowed_insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.jori_is_allowed_user())', t || '_allowed_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_allowed_update', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.jori_is_allowed_user()) with check (public.jori_is_allowed_user())', t || '_allowed_update', t);
  end loop;
  foreach t in array array['watch_feedback','watch_taste_prefs','watch_film_edges','watch_batches'] loop
    execute format('drop policy if exists %I on public.%I', t || '_allowed_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.jori_is_allowed_user())', t || '_allowed_select', t);
  end loop;
end $$;
drop policy if exists watch_batches_allowed_insert on public.watch_batches;
create policy watch_batches_allowed_insert on public.watch_batches
  for insert to authenticated with check (public.jori_is_allowed_user());
-- Undoing a site mark deletes only the title row the site created.
drop policy if exists watch_titles_delete_web_rows on public.watch_titles;
create policy watch_titles_delete_web_rows on public.watch_titles
  for delete to authenticated using (source = 'web' and public.jori_is_allowed_user());
