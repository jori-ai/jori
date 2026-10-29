-- 0110 loyalty: miles and points balances (bin/awardwallet-sync,
-- bin/awardwallet-refresh). One row per program plus one per program per day.
-- Service role only.

create table if not exists public.loyalty_accounts (
  account_id           bigint primary key,   -- the provider's account id
  owner_kind           text not null,
  owner_id             bigint not null,
  owner_name           text,
  provider_code        text,
  display_name         text,
  kind                 text,                 -- Airlines | Hotels | Credit Cards | ...
  login                text,
  balance              text,                 -- formatted, as the provider shows it
  balance_raw          numeric,              -- null when unavailable (never 0 for unknown)
  elite_status         text,
  expiration_date      timestamptz,
  last_change_date     timestamptz,
  last_retrieve_date   timestamptz,
  last_detected_change text,
  error_code           integer,
  error_message        text,
  sub_accounts         jsonb,
  properties           jsonb,
  as_of                timestamptz not null,
  updated_at           timestamptz not null default now()
);
create index if not exists loyalty_accounts_kind_idx on public.loyalty_accounts (kind);

create table if not exists public.loyalty_balance_history (
  account_id  bigint not null,
  as_of_date  date not null,
  balance_raw numeric,
  as_of       timestamptz not null,
  primary key (account_id, as_of_date)
);

alter table public.loyalty_accounts        enable row level security;
alter table public.loyalty_balance_history enable row level security;
