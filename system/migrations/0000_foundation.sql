-- 0000 foundation: extensions, the allowlist every app-facing policy uses,
-- and the optional read-only reporting role.
--
-- Every file in system/migrations is idempotent (IF NOT EXISTS, CREATE OR
-- REPLACE, DROP ... IF EXISTS before CREATE POLICY / CREATE TRIGGER, guarded DO
-- blocks), so `bin/jori-migrate --apply` can run the whole directory again at
-- any time. Files run in name order; later files may depend on earlier ones.
--
-- ACCESS MODEL (all files):
--   * The host writes and reads with the service-role key, which bypasses RLS.
--   * RLS is enabled on every table. A table with no policy is service-role only.
--   * App- and site-facing tables admit the `authenticated` role ONLY when the
--     signed-in user's email is in jori_allowed_users (jori_is_allowed_user()).
--   * `anon` gets no policy anywhere.

create schema if not exists extensions;   -- present on Supabase; created elsewhere
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector;

-- The people allowed to use this installation's app and sites, by the email
-- on their Supabase Auth session (Google sign-in by default). Add rows after
-- the first apply (docs/schema.md "The allowlist"):
--   insert into public.jori_allowed_users (email) values (lower('<the user''s sign-in email>')) on conflict do nothing;
create table if not exists public.jori_allowed_users (
  email      text primary key check (email = lower(email)),
  note       text,
  created_at timestamptz not null default now()
);
-- No policies: nobody reads the list through the API. Policies consult it
-- through the security-definer function below, which bypasses this table's RLS.
alter table public.jori_allowed_users enable row level security;

create or replace function public.jori_is_allowed_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select true from public.jori_allowed_users u
      where u.email = lower(coalesce(auth.jwt() ->> 'email', ''))
      limit 1),
    false);
$$;
revoke all on function public.jori_is_allowed_user() from public;
grant execute on function public.jori_is_allowed_user() to anon, authenticated, service_role;

-- Optional NOLOGIN role for an outside reporting reader (for example a
-- property-management hub reading receipts and bank data). It holds SELECT
-- grants on a few finance tables (0070, 0100) and can do nothing else. Give
-- a login role membership in it only if you run such a reader.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'plaid_readonly') then
    create role plaid_readonly nologin;
  end if;
end $$;
grant usage on schema public to plaid_readonly;

-- Shared trigger body: stamp updated_at on UPDATE.
create or replace function public.jori_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Helper used by later files: add a table to the Realtime publication once.
create or replace function public.jori_realtime_add(p_table text)
returns void language plpgsql as $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return; -- not a Supabase database (or Realtime disabled): nothing to do
  end if;
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = p_table
  ) then
    execute format('alter publication supabase_realtime add table public.%I', p_table);
  end if;
end;
$$;

-- Helper used by later files: create a Storage bucket once (no-op without Storage).
create or replace function public.jori_ensure_bucket(p_id text, p_public boolean)
returns void language plpgsql as $$
begin
  if to_regclass('storage.buckets') is null then
    return;
  end if;
  insert into storage.buckets (id, name, public) values (p_id, p_id, p_public)
  on conflict (id) do nothing;
end;
$$;
