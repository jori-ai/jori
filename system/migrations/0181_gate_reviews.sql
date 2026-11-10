-- 0181_gate_reviews — the speak gate's shadow verdicts and the user's grades
-- (system/speak-gate.md § Shadow week). One row per judged message: what the
-- gate would have done and why, written by plugins/speak-gate (service role);
-- the app shows it under the message and writes the user's grade back.

create table if not exists public.jori_gate_reviews (
  message_id uuid primary key references public.jori_messages(id) on delete cascade,
  conversation_id text,
  sender text,
  channel text,
  kind text,                      -- proactive | reply
  verdict text not null,          -- send | rewrite | resolve | digest | drop
  reason text,
  suggestion text,                -- the rewrite, or what it found (resolve)
  checks jsonb,
  sources jsonb,
  ms integer,
  judged_at timestamptz not null default now(),
  grade text check (grade in ('right', 'wrong')),
  note text,
  graded_at timestamptz
);

create index if not exists jori_gate_reviews_conv on public.jori_gate_reviews (conversation_id, judged_at desc);

alter table public.jori_gate_reviews enable row level security;
drop policy if exists jori_gate_reviews_select on public.jori_gate_reviews;
create policy jori_gate_reviews_select on public.jori_gate_reviews for select to authenticated using (public.jori_is_allowed_user());
drop policy if exists jori_gate_reviews_update on public.jori_gate_reviews;
create policy jori_gate_reviews_update on public.jori_gate_reviews for update to authenticated
  using (public.jori_is_allowed_user()) with check (public.jori_is_allowed_user());
