-- 0180 action approvals: Face-ID approval for actions a plugin declares in its
-- manifest (`approvals`). Used by lib/action-approval.mjs, bin/approval,
-- bin/action-approval-poll and apps/companion (ActionApproval.swift).
-- Signing keys are the paired purchase keys (purchase_device_keys, 0020).

create table if not exists public.action_approvals (
  id            text primary key,
  plugin        text not null,
  action        text not null,
  status        text not null,     -- pending|signed|executing|done|failed|denied|expired|cancelled
  item_json     jsonb not null,    -- every key is shown on the phone and hashed
  item_hash     text not null,
  nonce         text not null,
  expires_at    timestamptz,
  expires_at_ms bigint not null,   -- the exact integer bound into the signed message
  request_text  text,              -- the user's words that led here; shown, not signed
  signature     text,
  signed_by     text,
  decided_at    timestamptz,
  executed_at   timestamptz,
  result        jsonb,
  created_at    timestamptz default now()
);
create index if not exists idx_action_approvals_status on public.action_approvals (status, expires_at_ms);

-- A filed request is frozen: what it says and what its signature binds cannot
-- change. A trigger, because the service role bypasses RLS but not triggers.
create or replace function public.action_approvals_freeze()
returns trigger language plpgsql as $$
begin
  if new.plugin        is distinct from old.plugin
  or new.action        is distinct from old.action
  or new.item_json     is distinct from old.item_json
  or new.item_hash     is distinct from old.item_hash
  or new.nonce         is distinct from old.nonce
  or new.expires_at_ms is distinct from old.expires_at_ms
  or new.created_at    is distinct from old.created_at
  then
    raise exception 'action_approvals % is frozen after filing: file a new request instead', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists action_approvals_freeze on public.action_approvals;
create trigger action_approvals_freeze
  before update on public.action_approvals
  for each row execute function public.action_approvals_freeze();

alter table public.action_approvals enable row level security;

drop policy if exists aa_allowed_select on public.action_approvals;
create policy aa_allowed_select on public.action_approvals
  for select to authenticated using (public.jori_is_allowed_user());
-- The app may only move a PENDING row to signed/denied, touching only the
-- decision columns (column grants below).
drop policy if exists aa_allowed_decide on public.action_approvals;
create policy aa_allowed_decide on public.action_approvals
  for update to authenticated
  using (public.jori_is_allowed_user() and status = 'pending')
  with check (public.jori_is_allowed_user() and status in ('signed', 'denied'));
revoke update on public.action_approvals from authenticated;
grant update (status, signature, signed_by, decided_at) on public.action_approvals to authenticated;
