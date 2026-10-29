-- 0020 approvals: Face-ID-signed approval cards (self-improvement changes) and
-- Face-ID-signed purchases. Used by agent/core/self-improve*.mjs,
-- agent/core/app-approval.mjs, bin/self-improve-*, bin/purchase,
-- bin/purchase-approval-poll, apps/companion.

-- ── Self-improvement approvals ───────────────────────────────────────────────
create table if not exists public.self_improve_approvals (
  id              text primary key,
  item_type       text not null,
  summary         text,
  rationale       text,
  item_json       jsonb,
  item_hash       text not null,
  nonce           text not null,
  risk            text,
  status          text not null,   -- free text: pending|signed|applied|failed|apply_failed|retry_requested|expired|...
  signature       text,
  signed_by       text,
  created_at      timestamptz default now(),
  expires_at      timestamptz,
  expires_at_ms   bigint,          -- the exact integer bound into the signed message
  decided_at      timestamptz,
  applied_at      timestamptz,
  result          jsonb,
  skipped         boolean not null default false,   -- orthogonal to status; unskip restores it
  skipped_at      timestamptz,
  chat_message_id uuid references public.jori_messages(id) on delete set null
);
alter table public.self_improve_approvals add column if not exists expires_at_ms bigint;
alter table public.self_improve_approvals add column if not exists skipped boolean not null default false;
alter table public.self_improve_approvals add column if not exists skipped_at timestamptz;
alter table public.self_improve_approvals add column if not exists chat_message_id uuid references public.jori_messages(id) on delete set null;
create index if not exists idx_si_approvals_status on public.self_improve_approvals (status, expires_at);

create table if not exists public.approval_device_keys (
  device_id      text primary key,
  public_key_raw text not null,
  device_name    text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- A filed card is frozen: what it says and what its signature binds cannot
-- change (an edit is a new card). A trigger, because the service role bypasses
-- RLS but not triggers.
create or replace function public.self_improve_approvals_freeze()
returns trigger language plpgsql as $$
begin
  if new.item_type  is distinct from old.item_type
  or new.item_json  is distinct from old.item_json
  or new.item_hash  is distinct from old.item_hash
  or new.nonce      is distinct from old.nonce
  or new.summary    is distinct from old.summary
  or new.rationale  is distinct from old.rationale
  or new.risk       is distinct from old.risk
  or new.created_at is distinct from old.created_at
  then
    raise exception 'self_improve_approvals % is frozen after filing: an edited card is a new card (file it again)', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists self_improve_approvals_freeze on public.self_improve_approvals;
create trigger self_improve_approvals_freeze
  before update on public.self_improve_approvals
  for each row execute function public.self_improve_approvals_freeze();

alter table public.approval_device_keys   enable row level security;
alter table public.self_improve_approvals enable row level security;

-- The app registers its signing key and reads / decides cards. anon gets
-- nothing: that is what stops a rogue key registration.
drop policy if exists adk_allowed_all on public.approval_device_keys;
create policy adk_allowed_all on public.approval_device_keys
  for all to authenticated using (public.jori_is_allowed_user()) with check (public.jori_is_allowed_user());
drop policy if exists sia_allowed_select on public.self_improve_approvals;
create policy sia_allowed_select on public.self_improve_approvals
  for select to authenticated using (public.jori_is_allowed_user());
drop policy if exists sia_allowed_update on public.self_improve_approvals;
create policy sia_allowed_update on public.self_improve_approvals
  for update to authenticated using (public.jori_is_allowed_user()) with check (public.jori_is_allowed_user());

-- ── Purchase approvals ───────────────────────────────────────────────────────
create table if not exists public.purchase_approvals (
  id             text primary key,
  status         text not null,     -- pending|signed|executing|placed|clicked|failed|stale|denied|expired|cancelled
  item_json      jsonb not null,    -- every field is shown on the phone and hashed
  item_hash      text not null,
  nonce          text not null,
  expires_at     timestamptz,
  expires_at_ms  bigint not null,
  screenshot_b64 text,
  place_selector text not null,
  tab_id         text,
  page_url       text,
  request_text   text,
  signature      text,
  signed_by      text,
  decided_at     timestamptz,
  executed_at    timestamptz,
  result         jsonb,
  created_at     timestamptz default now(),
  context_json   jsonb              -- advisory note/image shown beside the item; not signed
);
alter table public.purchase_approvals add column if not exists context_json jsonb;
create index if not exists idx_purchase_approvals_status on public.purchase_approvals (status, expires_at_ms);

create table if not exists public.purchase_device_keys (
  device_id      text primary key,
  public_key_raw text not null,
  device_name    text,
  paired_at      timestamptz default now()
);

create table if not exists public.purchase_pairing_codes (
  code_hash  text primary key,
  expires_at timestamptz not null,
  used_at    timestamptz,
  used_by    text
);

alter table public.purchase_approvals     enable row level security;
alter table public.purchase_device_keys   enable row level security;
alter table public.purchase_pairing_codes enable row level security;

drop policy if exists pa_allowed_select on public.purchase_approvals;
create policy pa_allowed_select on public.purchase_approvals
  for select to authenticated using (public.jori_is_allowed_user());
-- The app may only move a PENDING row to signed/denied, touching only the
-- decision columns (column grants below).
drop policy if exists pa_allowed_decide on public.purchase_approvals;
create policy pa_allowed_decide on public.purchase_approvals
  for update to authenticated
  using (public.jori_is_allowed_user() and status = 'pending')
  with check (public.jori_is_allowed_user() and status in ('signed', 'denied'));
revoke update on public.purchase_approvals from authenticated;
grant update (status, signature, signed_by, decided_at) on public.purchase_approvals to authenticated;
-- purchase_device_keys / purchase_pairing_codes: no policies. Only the
-- service role and the security-definer RPC below touch them.

-- A purchase signing key can only be registered by burning a one-time code
-- minted on the host (`purchase pair`); an app session alone cannot add one.
create or replace function public.pair_purchase_device(p_code text, p_device_id text, p_public_key_raw text, p_device_name text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  h text := encode(digest(upper(replace(trim(p_code), '-', '')), 'sha256'), 'hex');
begin
  if auth.role() <> 'authenticated' or not public.jori_is_allowed_user() then
    raise exception 'not authenticated';
  end if;
  if length(coalesce(p_public_key_raw, '')) < 80 or length(coalesce(p_device_id, '')) < 8 then
    raise exception 'bad key';
  end if;
  update public.purchase_pairing_codes
     set used_at = now(), used_by = p_device_id
   where code_hash = h and used_at is null and expires_at > now();
  if not found then
    raise exception 'invalid or expired pairing code';
  end if;
  insert into public.purchase_device_keys (device_id, public_key_raw, device_name)
  values (p_device_id, p_public_key_raw, p_device_name)
  on conflict (device_id) do update
    set public_key_raw = excluded.public_key_raw, device_name = excluded.device_name, paired_at = now();
  return true;
end;
$$;
revoke all on function public.pair_purchase_device(text, text, text, text) from public, anon;
grant execute on function public.pair_purchase_device(text, text, text, text) to authenticated;
