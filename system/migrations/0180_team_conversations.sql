-- 0180 team conversations: the app talks to a team of roles, like a messaging
-- app talks to people (system/conversations.md, system/org.md).
--
--   jori_team            one row per team role: its id (the role plugin's id),
--                        the name and title the user sees (both renamable in the
--                        app), its responsibility, whether it coordinates.
--                        Written by `bin/org sync` from the roster, and by the
--                        app when the user renames a role; the user's edit wins.
--   jori_conversations   a conversation: 'role:<id>' with one role, or
--                        'group:<uuid>' with several. A role's conversation
--                        exists once the role has something to say or the user
--                        adds it, so a new install shows only the coordinator.
--   jori_channel_roles   which role answers for each legacy channel (chat,
--                        system, improvements, questions), so writers and the
--                        app that still speak in channels land in a role.
--   jori_messages        + conversation_id, + sender (the role id that wrote an
--                        assistant message). A trigger fills both for writers
--                        that only set a channel, keeps `channel` meaningful for
--                        the app that still filters by it, and keeps the
--                        conversation's last_message_at current.

create table if not exists public.jori_team (
  id              text primary key,                -- role id: chief-of-staff, cfo, …
  name            text not null,                   -- the name the user sees
  title           text not null,                   -- the role title (CFO)
  responsibility  text,
  chief_of_staff  boolean not null default false,
  enabled         boolean not null default true,
  sort            integer not null default 100,
  renamed_by_user boolean not null default false,  -- the app set name/title; sync never overwrites them
  updated_at      timestamptz not null default now()
);

create table if not exists public.jori_conversations (
  id              text primary key,                -- role:<id> | group:<uuid>
  kind            text not null check (kind in ('role', 'group')),
  title           text,                            -- a group's name (role conversations use the role's)
  members         text[] not null default '{}',    -- role ids
  created_at      timestamptz not null default now(),
  created_by      text not null default 'system',  -- system | user
  last_message_at timestamptz,
  archived        boolean not null default false
);
create index if not exists jori_conversations_last_idx on public.jori_conversations (last_message_at desc nulls last);

create table if not exists public.jori_channel_roles (
  channel text primary key,
  role_id text not null
);
insert into public.jori_channel_roles (channel, role_id) values
  ('chat', 'chief-of-staff'), ('questions', 'chief-of-staff'),
  ('system', 'it-security'), ('improvements', 'software-engineer')
on conflict (channel) do nothing;

alter table public.jori_messages add column if not exists conversation_id text;
alter table public.jori_messages add column if not exists sender text;
create index if not exists jori_messages_conversation_created_idx on public.jori_messages (conversation_id, created_at desc);

-- Fill conversation_id / sender for writers that only know a channel, and keep
-- `channel` meaningful for the app that still filters by it.
create or replace function public.jori_messages_route() returns trigger
language plpgsql as $$
declare
  r text;
begin
  if new.conversation_id is null then
    r := coalesce(new.sender,
                  (select role_id from public.jori_channel_roles where channel = coalesce(new.channel, 'chat')),
                  'chief-of-staff');
    new.conversation_id := 'role:' || r;
  end if;
  if new.role = 'assistant' and new.sender is null and new.conversation_id like 'role:%' then
    new.sender := substr(new.conversation_id, 6);
  end if;
  -- A message written into a role's conversation by a newer writer still
  -- shows in the matching tab of the older app.
  if new.conversation_id like 'role:%' and (new.channel is null or new.channel = 'chat') then
    select c.channel into new.channel from public.jori_channel_roles c
     where c.role_id = substr(new.conversation_id, 6) and c.channel in ('system', 'improvements') limit 1;
    new.channel := coalesce(new.channel, 'chat');
  end if;
  return new;
end $$;

create or replace function public.jori_messages_touch_conversation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.conversation_id like 'role:%' then
    insert into public.jori_conversations (id, kind, members, last_message_at)
    values (new.conversation_id, 'role', array[substr(new.conversation_id, 6)], new.created_at)
    on conflict (id) do update set last_message_at = greatest(coalesce(public.jori_conversations.last_message_at, excluded.last_message_at), excluded.last_message_at),
                                   archived = false;
  elsif new.conversation_id is not null then
    update public.jori_conversations set last_message_at = greatest(coalesce(last_message_at, new.created_at), new.created_at)
     where id = new.conversation_id;
  end if;
  return new;
end $$;

drop trigger if exists jori_messages_route_trg on public.jori_messages;
create trigger jori_messages_route_trg before insert on public.jori_messages
  for each row execute function public.jori_messages_route();
drop trigger if exists jori_messages_touch_conversation_trg on public.jori_messages;
create trigger jori_messages_touch_conversation_trg after insert on public.jori_messages
  for each row execute function public.jori_messages_touch_conversation();

-- RLS: the signed-in owner reads all three; the app may rename a role, create
-- or edit a group, and add a role's conversation; deletes are service-only.
alter table public.jori_team enable row level security;
alter table public.jori_conversations enable row level security;
alter table public.jori_channel_roles enable row level security;

drop policy if exists jori_team_select on public.jori_team;
create policy jori_team_select on public.jori_team for select to authenticated using (public.jori_is_allowed_user());
drop policy if exists jori_team_update on public.jori_team;
create policy jori_team_update on public.jori_team for update to authenticated
  using (public.jori_is_allowed_user()) with check (public.jori_is_allowed_user());

drop policy if exists jori_conversations_select on public.jori_conversations;
create policy jori_conversations_select on public.jori_conversations for select to authenticated using (public.jori_is_allowed_user());
drop policy if exists jori_conversations_insert on public.jori_conversations;
create policy jori_conversations_insert on public.jori_conversations for insert to authenticated with check (public.jori_is_allowed_user());
drop policy if exists jori_conversations_update on public.jori_conversations;
create policy jori_conversations_update on public.jori_conversations for update to authenticated
  using (public.jori_is_allowed_user()) with check (public.jori_is_allowed_user());

drop policy if exists jori_channel_roles_select on public.jori_channel_roles;
create policy jori_channel_roles_select on public.jori_channel_roles for select to authenticated using (public.jori_is_allowed_user());

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['jori_team', 'jori_conversations'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- Backfill: every existing message into the conversation of the role that owns
-- its channel; past questions go to the role their metadata names (a finance
-- review question → the CFO, a people card → relationships), else the coordinator.
update public.jori_messages m set
  conversation_id = 'role:' || coalesce(
    case when m.channel = 'questions' and m.metadata ? 'finance_question' then 'cfo'
         when m.channel = 'questions' and (m.metadata->>'decision_ref') like 'ppl:%' then 'relationships'
    end,
    (select role_id from public.jori_channel_roles c where c.channel = coalesce(m.channel, 'chat')),
    'chief-of-staff')
where m.conversation_id is null;
update public.jori_messages set sender = substr(conversation_id, 6)
 where role = 'assistant' and sender is null and conversation_id like 'role:%';
insert into public.jori_conversations (id, kind, members, last_message_at)
select conversation_id, 'role', array[substr(conversation_id, 6)], max(created_at)
  from public.jori_messages where conversation_id like 'role:%' group by conversation_id
on conflict (id) do update set last_message_at = excluded.last_message_at;
