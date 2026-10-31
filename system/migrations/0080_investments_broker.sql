-- 0080 investments: the read-only brokerage snapshot (bin/broker-snapshot,
-- lib/broker-config.cjs, lib/portfolio-position-freshness.mjs,
-- bin/finance-review-data, bin/domain-allocation, bin/rate-sensitivity).
-- Point-in-time mirror; every value carries as_of. Nothing here can trade.
--
-- Table names are the kernel defaults (lib/broker-config.cjs BROKER_DEFAULTS
-- .tables). An installation that maps investments.json broker.tables to other
-- names keeps its own tables and can skip this file.

create table if not exists public.broker_accounts (
  account_hash text primary key,
  account_name text,
  cash_balance numeric,
  total_value  numeric,
  as_of        timestamptz not null,
  updated_at   timestamptz not null default now()
);

create table if not exists public.broker_positions (
  account_hash       text not null references public.broker_accounts (account_hash) on delete cascade,
  ticker             text not null,
  name               text,
  shares             numeric,
  market_value       numeric,
  cost_basis         numeric,
  current_price      numeric,
  day_change         numeric,
  day_change_percent numeric,
  asset_type         text,
  as_of              timestamptz not null,
  updated_at         timestamptz not null default now(),
  primary key (account_hash, ticker)
);
create index if not exists broker_positions_ticker_idx on public.broker_positions (ticker);

create table if not exists public.broker_value_history (
  as_of_date      date primary key,     -- local capture date
  total_value     numeric,
  cash_total      numeric,
  positions_value numeric,
  num_accounts    int,
  num_positions   int,
  as_of           timestamptz not null,
  updated_at      timestamptz not null default now()
);

create table if not exists public.broker_position_history (
  as_of_date         date not null,
  account_hash       text not null,
  account_name       text,
  ticker             text not null,
  shares             numeric,
  market_value       numeric,
  cost_basis         numeric,
  current_price      numeric,
  day_change         numeric,
  day_change_percent numeric,
  asset_type         text,
  as_of              timestamptz not null,
  primary key (as_of_date, account_hash, ticker)
);
create index if not exists broker_position_history_ticker_date on public.broker_position_history (ticker, as_of_date);

create table if not exists public.broker_account_history (
  as_of_date   date not null,
  account_hash text not null,
  account_name text,
  cash_balance numeric,
  total_value  numeric,
  as_of        timestamptz not null,
  primary key (as_of_date, account_hash)
);

alter table public.broker_accounts         enable row level security;
alter table public.broker_positions        enable row level security;
alter table public.broker_value_history    enable row level security;
alter table public.broker_position_history enable row level security;
alter table public.broker_account_history  enable row level security;
