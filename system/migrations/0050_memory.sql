-- 0050 memory: daily / weekly / monthly summaries (episodic memory) with
-- semantic recall, and the off-host copy of the wiki.
-- Used by bin/daily-summary-*, bin/episode, bin/embed-daily-summaries,
-- bin/period-summary, bin/wiki-day-write, agent/tools-mcp, bin/wiki-cloud-sync.

create table if not exists public.daily_summaries (
  date                 date primary key,
  narrative            text,               -- rendered email HTML
  wake_at              timestamptz,
  sleep_at             timestamptz,
  places_count         integer default 0,
  photos_count         integer default 0,
  commits_count        integer default 0,
  messages_count       integer default 0,
  key_events           jsonb default '[]'::jsonb,
  weekly_compacted_at  timestamptz,
  monthly_compacted_at timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  emails_sent_count    integer default 0,
  imessages_sent_count integer default 0,
  documents_count      integer default 0,
  resolved_day_json    jsonb,              -- the pre-settle resolve-day output (derived from code usage)
  day_json             jsonb,              -- the settled day: the source of truth for re-rendering
  prose_json           jsonb,              -- the agent's prose slots, joined with day_json to render
  embedding            vector(768),
  embedding_model      text,
  embedded_at          timestamptz
);
alter table public.daily_summaries add column if not exists resolved_day_json jsonb;
alter table public.daily_summaries add column if not exists day_json jsonb;
alter table public.daily_summaries add column if not exists prose_json jsonb;
alter table public.daily_summaries add column if not exists embedding vector(768);
alter table public.daily_summaries add column if not exists embedding_model text;
alter table public.daily_summaries add column if not exists embedded_at timestamptz;
create index if not exists daily_summaries_embedding_hnsw on public.daily_summaries
  using hnsw (embedding vector_cosine_ops) where embedding is not null;

create table if not exists public.weekly_summaries (
  week_start date primary key,
  narrative  text,
  themes     jsonb default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.monthly_summaries (
  month_start date primary key,
  narrative   text,
  themes      jsonb default '[]'::jsonb,
  created_at  timestamptz not null default now()
);

create or replace function public.daily_summaries_semantic_search(
  query_embedding vector,
  match_count int default 10,
  since date default null
)
returns table (date date, narrative text, similarity real)
language sql stable
as $$
  select d.date, d.narrative, (1 - (d.embedding <=> query_embedding))::real as similarity
    from public.daily_summaries d
   where d.embedding is not null
     and (since is null or d.date >= since)
   order by d.embedding <=> query_embedding asc, d.date desc
   limit greatest(1, match_count);
$$;
revoke all on function public.daily_summaries_semantic_search(vector, int, date) from public, anon;
grant execute on function public.daily_summaries_semantic_search(vector, int, date) to authenticated, service_role;

-- ── Wiki mirror (the SQLite wiki tables, column for column) ──────────────────
create table if not exists public.wiki_pages (
  id               text primary key,
  basename         text not null unique,
  type             text,
  title            text,
  description      text,
  status           text not null default 'active',
  pinned           integer not null default 0,
  pinned_at        text,
  pin_locked       integer not null default 0,
  scope_json       text,
  confidence       text,
  last_verified_at text,
  expires_at       text,
  raw_md           text not null,
  body_md          text not null,
  frontmatter_json text not null,
  body_hash        text not null,
  source_mtime     bigint,
  created_at       text,
  updated_at       text,
  row_hash         text not null,          -- sha256 over every mirrored column: the sync diff key
  synced_at        timestamptz not null default now(),
  search           tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body_md, '')), 'C')
  ) stored
);
create index if not exists wiki_pages_search_idx on public.wiki_pages using gin (search);
create index if not exists wiki_pages_type_idx on public.wiki_pages (type);

create table if not exists public.wiki_page_links (
  src_id    text not null,
  dst_id    text not null,
  link_type text not null,
  display   text,
  section   text not null default '',
  primary key (src_id, dst_id, link_type, section)
);
create index if not exists wiki_page_links_dst_idx on public.wiki_page_links (dst_id);

create table if not exists public.wiki_page_revisions (
  page_id   text not null,
  rev       integer not null,
  raw_md    text not null,
  edited_by text,
  edited_at text,
  primary key (page_id, rev)
);

create table if not exists public.wiki_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function public.wiki_search(q text, lim int default 30)
returns table (id text, title text, type text, description text, snippet text, rank real)
language sql stable
set search_path = public
as $$
  select p.id, p.title, p.type, p.description,
         ts_headline('english', p.body_md, websearch_to_tsquery('english', q),
                     'StartSel=<mark>,StopSel=</mark>,MaxWords=30,MinWords=12,MaxFragments=2'),
         ts_rank(p.search, websearch_to_tsquery('english', q))
    from public.wiki_pages p
   where p.search @@ websearch_to_tsquery('english', q)
   order by 6 desc
   limit lim;
$$;
revoke execute on function public.wiki_search(text, int) from public, anon, authenticated;

-- All service role only (a wiki web reader uses server routes with the service key).
alter table public.daily_summaries     enable row level security;
alter table public.weekly_summaries    enable row level security;
alter table public.monthly_summaries   enable row level security;
alter table public.wiki_pages          enable row level security;
alter table public.wiki_page_links     enable row level security;
alter table public.wiki_page_revisions enable row level security;
alter table public.wiki_config         enable row level security;
