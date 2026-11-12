-- 0184_gate_reviews_live — the speak gate goes live (system/speak-gate.md
-- § Live). The gate now judges a message BEFORE it is delivered and acts on
-- the verdict, so a review is no longer always about a delivered row:
--   * a rewrite is delivered as the gate's text; `original` keeps what the
--     role wrote, shown folded under the message in the app;
--   * a held message (drop / digest / resolve) is never written to
--     jori_messages: its review row has no message_id, `held` = true, and the
--     app shows it as a folded "held" line in its conversation.
-- So the key moves from message_id to its own id, and message_id becomes an
-- optional, still-unique link (the shadow pass upserts on it).

alter table public.jori_gate_reviews add column if not exists id uuid not null default gen_random_uuid();
alter table public.jori_gate_reviews add column if not exists original text;
alter table public.jori_gate_reviews add column if not exists live boolean not null default false;
alter table public.jori_gate_reviews add column if not exists held boolean not null default false;

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.jori_gate_reviews'::regclass
       and conname = 'jori_gate_reviews_pkey'
       and pg_get_constraintdef(oid) like '%message_id%'
  ) then
    alter table public.jori_gate_reviews drop constraint jori_gate_reviews_pkey;
    alter table public.jori_gate_reviews add constraint jori_gate_reviews_pkey primary key (id);
  end if;
end $$;

alter table public.jori_gate_reviews alter column message_id drop not null;
create unique index if not exists jori_gate_reviews_message_uniq on public.jori_gate_reviews (message_id);

-- The app reloads a conversation's reviews when one lands (a live review is
-- written seconds after its message), instead of waiting for its poll.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'jori_gate_reviews') then
    alter publication supabase_realtime add table public.jori_gate_reviews;
  end if;
end $$;
