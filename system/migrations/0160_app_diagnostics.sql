-- 0160 app_diagnostics: reports the companion app uploads about itself
-- (apps/companion Jori/AnnounceDiagnostics.swift: what the notification and
-- Intents extensions did with recent messages, and the notification / Siri
-- settings that decide whether Siri reads them aloud). Read with the service
-- role; the app may only insert.

create table if not exists public.app_diagnostics (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id    uuid default auth.uid(),
  kind       text not null,
  payload    jsonb not null default '{}'::jsonb
);
create index if not exists app_diagnostics_created_idx on public.app_diagnostics (created_at desc);

alter table public.app_diagnostics enable row level security;
drop policy if exists app_diagnostics_app_insert on public.app_diagnostics;
create policy app_diagnostics_app_insert on public.app_diagnostics
  for insert to authenticated with check (public.jori_is_allowed_user());
