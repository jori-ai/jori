-- 0010 chat: the companion app <-> agent channel, push tokens, semantic recall
-- over messages, chat attachments, and app responsiveness telemetry.
-- Used by agent/phone-channel, bin/jori-send*, bin/client-cmd, lib/chat-recall.mjs,
-- lib/apns-push.mjs, bin/apns-token-cleanup, bin/app-perf, apps/companion.

create table if not exists public.jori_messages (
  id            uuid primary key default gen_random_uuid(),
  role          text not null,                 -- user | assistant | system
  content       text not null,
  read          boolean not null default false,
  created_at    timestamptz not null default now(),
  metadata      jsonb default '{}'::jsonb,
  reaction      text,
  user_id       uuid,
  channel       text default 'chat',           -- chat | system | ... (one app tab each)
  reply_to      uuid references public.jori_messages(id) on delete set null,
  embedding     vector(768),                   -- nomic-embed-text sized; bin/embed-messages
  embedding_model text,
  embedded_at   timestamptz
);
alter table public.jori_messages add column if not exists channel text default 'chat';
alter table public.jori_messages add column if not exists reply_to uuid references public.jori_messages(id) on delete set null;
alter table public.jori_messages add column if not exists embedding vector(768);
alter table public.jori_messages add column if not exists embedding_model text;
alter table public.jori_messages add column if not exists embedded_at timestamptz;
create index if not exists jori_messages_channel_created_at_idx on public.jori_messages (channel, created_at desc);
create index if not exists jori_messages_reply_to_idx on public.jori_messages (reply_to) where reply_to is not null;
create index if not exists jori_messages_embedding_hnsw on public.jori_messages
  using hnsw (embedding vector_cosine_ops) where embedding is not null;

create table if not exists public.jori_commands (
  id           uuid primary key default gen_random_uuid(),
  command      text not null,
  payload      jsonb default '{}'::jsonb,
  response     jsonb,
  status       text not null default 'pending',
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.device_tokens (
  id           uuid primary key default gen_random_uuid(),
  token        text not null unique,
  platform     text not null default 'ios',    -- ios | macos
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  active_until timestamptz                     -- lease renewed while the app is in active use
);
alter table public.device_tokens add column if not exists active_until timestamptz;

create table if not exists public.app_perf_events (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  occurred_at timestamptz not null,
  kind        text not null check (kind in ('hang', 'metrics', 'diagnostic')),
  platform    text not null,
  device      text,
  os_version  text,
  app_version text,
  build       text,
  duration_ms integer,
  context     text,
  payload     jsonb
);
create index if not exists app_perf_events_kind_time on public.app_perf_events (kind, occurred_at desc);

-- Semantic recall over messages (lib/chat-recall.mjs).
create or replace function public.jori_messages_semantic_search(
  query_embedding vector,
  match_count int default 10,
  role_filter text default null,
  since timestamptz default null
)
returns table (id uuid, role text, content text, created_at timestamptz, similarity real)
language sql stable
as $$
  select m.id, m.role, m.content, m.created_at,
         (1 - (m.embedding <=> query_embedding))::real as similarity
    from public.jori_messages m
   where m.embedding is not null
     and (role_filter is null or m.role = role_filter)
     and (since is null or m.created_at >= since)
   order by m.embedding <=> query_embedding asc, m.created_at desc
   limit greatest(1, match_count);
$$;
revoke all on function public.jori_messages_semantic_search(vector, int, text, timestamptz) from public, anon;
grant execute on function public.jori_messages_semantic_search(vector, int, text, timestamptz) to authenticated, service_role;

-- RLS
alter table public.jori_messages   enable row level security;
alter table public.jori_commands   enable row level security;
alter table public.device_tokens   enable row level security;
alter table public.app_perf_events enable row level security;

drop policy if exists jori_messages_select on public.jori_messages;
create policy jori_messages_select on public.jori_messages
  for select to authenticated using (public.jori_is_allowed_user());
drop policy if exists jori_messages_insert on public.jori_messages;
create policy jori_messages_insert on public.jori_messages
  for insert to authenticated with check (public.jori_is_allowed_user() and role = 'user');
drop policy if exists jori_messages_update on public.jori_messages;
create policy jori_messages_update on public.jori_messages
  for update to authenticated using (public.jori_is_allowed_user()) with check (public.jori_is_allowed_user());
-- delete: service role only (no policy).

drop policy if exists jori_commands_all on public.jori_commands;
create policy jori_commands_all on public.jori_commands
  for all to authenticated using (public.jori_is_allowed_user()) with check (public.jori_is_allowed_user());

drop policy if exists device_tokens_all on public.device_tokens;
create policy device_tokens_all on public.device_tokens
  for all to authenticated using (public.jori_is_allowed_user()) with check (public.jori_is_allowed_user());

drop policy if exists app_perf_events_insert on public.app_perf_events;
create policy app_perf_events_insert on public.app_perf_events
  for insert to authenticated with check (public.jori_is_allowed_user());
drop policy if exists app_perf_events_select on public.app_perf_events;
create policy app_perf_events_select on public.app_perf_events
  for select to authenticated using (public.jori_is_allowed_user());

-- Realtime: the phone-channel and the app subscribe to row changes.
select public.jori_realtime_add('jori_messages');
select public.jori_realtime_add('jori_commands');

-- Chat attachments the app uploads (public read by URL; writes by allowed users).
select public.jori_ensure_bucket('jori-attachments', true);
do $$
begin
  if to_regclass('storage.objects') is null then return; end if;
  execute 'drop policy if exists jori_attachments_insert on storage.objects';
  execute $p$create policy jori_attachments_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'jori-attachments' and public.jori_is_allowed_user())$p$;
  execute 'drop policy if exists jori_attachments_update on storage.objects';
  execute $p$create policy jori_attachments_update on storage.objects for update to authenticated
    using (bucket_id = 'jori-attachments' and public.jori_is_allowed_user())
    with check (bucket_id = 'jori-attachments' and public.jori_is_allowed_user())$p$;
  execute 'drop policy if exists jori_attachments_select on storage.objects';
  execute $p$create policy jori_attachments_select on storage.objects for select to authenticated
    using (bucket_id = 'jori-attachments' and public.jori_is_allowed_user())$p$;
end $$;
