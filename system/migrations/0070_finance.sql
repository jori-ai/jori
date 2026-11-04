-- 0070 finance: read-only bank data via Plaid (accounts, transactions,
-- liabilities, investment holdings), the net-worth series, and the facts and
-- reconciliations the weekly finance review must not guess.
-- Used by bin/plaid-sync, bin/plaid-holdings-sync, bin/net-worth,
-- bin/finance-*, agent/scripts/hum-harvesters/finance.mjs.
-- Private financial data: service role only, plus SELECT for the optional
-- plaid_readonly reporting role on accounts and transactions.

create table if not exists public.plaid_accounts (
  account_id        text primary key,
  item_id           text not null,
  institution_name  text,
  name              text,
  official_name     text,
  mask              text,
  type              text,           -- depository | credit | loan | investment
  subtype           text,
  balance_current   numeric,
  balance_available numeric,
  balance_limit     numeric,
  iso_currency_code text,
  last_synced_at    timestamptz,    -- when the balance was last true (a failed run leaves it alone)
  first_seen_at     timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  sync_status       text not null default 'ok',   -- ok | login_required | error
  sync_error        text,
  sync_failed_at    timestamptz
);
alter table public.plaid_accounts add column if not exists sync_status text not null default 'ok';
alter table public.plaid_accounts add column if not exists sync_error text;
alter table public.plaid_accounts add column if not exists sync_failed_at timestamptz;
create index if not exists plaid_accounts_item_idx on public.plaid_accounts (item_id);
create index if not exists plaid_accounts_sync_status_idx on public.plaid_accounts (sync_status) where sync_status <> 'ok';

create table if not exists public.plaid_transactions (
  transaction_id    text primary key,
  account_id        text not null references public.plaid_accounts (account_id),
  item_id           text not null,
  amount            numeric not null,  -- Plaid sign: > 0 money out, < 0 money in
  iso_currency_code text,
  date              date not null,
  authorized_date   date,
  name              text,
  merchant_name     text,
  category_primary  text,
  category_detailed text,
  payment_channel   text,
  pending           boolean not null default false,
  first_seen_at     timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  raw               jsonb              -- the complete Plaid transaction object
);
alter table public.plaid_transactions add column if not exists raw jsonb;
create index if not exists plaid_transactions_account_date_idx on public.plaid_transactions (account_id, date desc);
create index if not exists plaid_transactions_date_idx     on public.plaid_transactions (date desc);
create index if not exists plaid_transactions_merchant_idx on public.plaid_transactions (merchant_name);
create index if not exists plaid_transactions_pending_idx  on public.plaid_transactions (pending) where pending = true;
create index if not exists plaid_transactions_raw_gin      on public.plaid_transactions using gin (raw);

create table if not exists public.plaid_liabilities (
  account_id                text primary key references public.plaid_accounts (account_id) on delete cascade,
  item_id                   text not null,
  last_statement_balance    numeric,
  last_statement_issue_date date,
  minimum_payment_amount    numeric,
  next_payment_due_date     date,
  last_payment_amount       numeric,
  last_payment_date         date,
  is_overdue                boolean,
  purchase_apr              numeric,
  aprs                      jsonb,
  updated_at                timestamptz not null default now()
);

-- Investment holdings through Plaid (derived from bin/plaid-holdings-sync and
-- lib/plaid-api.js holdingsJoined; the overlay holds no DDL for it).
create table if not exists public.plaid_holdings (
  account_id        text not null,
  security_id       text not null,
  item_id           text,
  account_name      text,
  account_mask      text,
  ticker            text,
  name              text,
  asset_type        text,
  shares            numeric,
  current_price     numeric,
  market_value      numeric,
  cost_basis        numeric,
  iso_currency_code text,
  price_as_of       date,
  as_of             timestamptz not null,
  updated_at        timestamptz not null default now(),
  primary key (account_id, security_id)
);
create index if not exists plaid_holdings_as_of_idx on public.plaid_holdings (as_of desc);

-- One point per holdings sync (upsert on as_of). Derived from code.
create table if not exists public.plaid_holdings_value_history (
  as_of       timestamptz primary key,
  total_value numeric,
  cash_value  numeric,
  positions   integer,
  accounts    integer,
  updated_at  timestamptz not null default now()
);

-- One row per day (bin/net-worth). Derived from code: besides the columns
-- below, bin/net-worth writes one numeric column per key in
-- agent/local/config/investments.json net_worth.sources[].key and
-- net_worth.plaid_holdings.key; add those columns for your own keys, e.g.
--   alter table public.net_worth_snapshots add column if not exists <key> numeric;
create table if not exists public.net_worth_snapshots (
  as_of_date          date primary key,
  real_estate         numeric,           -- net_worth.property.key (default real_estate)
  bank_cash           numeric,
  private_holdings    numeric,
  card_debt           numeric,
  gross_assets        numeric,
  net_worth           numeric,
  pending_commitments numeric,
  detail              jsonb,             -- the full gathered breakdown
  as_of               timestamptz,
  updated_at          timestamptz not null default now()
);
alter table public.net_worth_snapshots add column if not exists private_holdings numeric;

-- ── Finance facts: written by a person (bin/finance-facts), never guessed ────
create table if not exists public.fin_txn_override (
  transaction_id text primary key,       -- plaid_transactions.transaction_id
  kind           text not null check (kind in (
                   'expense', 'capital', 'income', 'internal_transfer', 'card_payment',
                   'refund', 'deposit_in', 'deposit_refund', 'tax', 'transfer_external', 'ignore')),
  property_id    text,                   -- the rental registry id, when it belongs to one
  note           text not null,
  set_by         text,
  set_at         timestamptz not null default now()
);

create table if not exists public.fin_expected_income (
  id             text primary key,
  label          text not null,
  account_id     text not null,          -- plaid_accounts.account_id it lands in
  payer_contains text not null,          -- case-insensitive substring of the bank descriptor
  amount         numeric(12,2),          -- null = varies; never reported late
  tolerance      numeric(12,2) not null default 0,
  cadence        text not null check (cadence in ('monthly', 'semimonthly', 'biweekly', 'quarterly')),
  due_day        int check (due_day between 1 and 31),
  grace_days     int not null default 3,
  active_from    date not null,
  active_to      date,
  note           text not null,
  confirmed_at   timestamptz not null default now()
);

create table if not exists public.fin_scheduled_payments (
  id                  text primary key,
  label               text not null,
  kind                text not null check (kind in ('card_payment', 'loan', 'bill', 'tax', 'other')),
  funding_account_id  text not null,
  target_account_id   text,
  amount_rule         text not null check (amount_rule in ('fixed', 'statement_balance', 'current_balance', 'minimum')),
  fixed_amount        numeric(12,2),
  due_day             int not null check (due_day between 1 and 31),
  autopay             boolean not null,
  descriptor_contains text,
  active              boolean not null default true,
  note                text not null,
  confirmed_at        timestamptz not null default now(),
  check (amount_rule <> 'fixed' or fixed_amount is not null)
);

-- Security deposits, reconciled by code (bin/finance-deposits-reconcile).
create table if not exists public.fin_deposits (
  id                        text primary key,
  lease_number              text not null,
  property_id               text,
  property_name             text,
  state                     text,
  tenant                    text not null,
  amount                    numeric(12,2) not null,
  hub_status                text not null,
  paid_via                  text,
  stripe_payment_intent     text,
  hub_paid_at               timestamptz,
  lease_start               date,
  lease_end                 date,
  expected_location         text not null default 'deposit_account' check (expected_location in ('deposit_account', 'exception')),
  exception_reason          text,
  location                  text not null default 'unknown',
  location_account_mask     text,
  location_basis            text,
  amount_in_deposit_account numeric(12,2),
  candidates                jsonb,
  updated_at                timestamptz not null default now()
);
create table if not exists public.fin_deposit_movements (
  id                   bigserial primary key,
  deposit_id           text not null,
  kind                 text not null check (kind in ('received', 'closing_credit', 'swept', 'payout', 'refunded')),
  amount               numeric(12,2) not null,
  on_date              date,
  from_account_mask    text,
  to_account_mask      text,
  plaid_transaction_id text,
  basis                text not null,
  evidence             text,
  recorded             boolean not null default false,   -- true = a person's answer; never overwritten
  created_at           timestamptz not null default now()
);
create unique index if not exists fin_deposit_movements_uniq on public.fin_deposit_movements (deposit_id, kind, coalesce(plaid_transaction_id, ''));
create table if not exists public.fin_deposit_exceptions (
  deposit_id text primary key,
  reason     text not null,
  set_at     timestamptz not null default now()
);
create table if not exists public.fin_deposit_reconciliations (
  id                 bigserial primary key,
  run_at             timestamptz not null default now(),
  account_balance    numeric(12,2) not null,
  located_total      numeric(12,2) not null,
  unattributed_total numeric(12,2) not null,
  difference         numeric(12,2) not null,
  ok                 boolean not null,
  report             jsonb not null
);

-- Invoices billed by the user, reconciled against payments
-- (bin/finance-invoices-reconcile). Derived from code: the overlay holds no DDL.
create table if not exists public.fin_invoices (
  payer        text not null,          -- instance owner_id of the biller
  number       text not null,
  invoice_date date,
  amount       numeric(12,2),
  voided       boolean not null default false,
  in_scope     boolean not null default true,
  scope_note   text,
  sheet_notes  text,
  due_date     date,
  paid_amount  numeric(12,2),
  status       text,                   -- open | late | part_paid | paid | void
  updated_at   timestamptz not null default now(),
  primary key (payer, number)
);
create table if not exists public.fin_invoice_matches (
  id                   bigserial primary key,
  invoice_number       text not null,
  plaid_transaction_id text not null,
  amount               numeric(12,2),
  paid_on              date,
  basis                text not null,  -- recorded | rule:...
  evidence             text,
  recorded             boolean not null default false,
  created_at           timestamptz not null default now()
);
create index if not exists fin_invoice_matches_invoice_idx on public.fin_invoice_matches (invoice_number);
create table if not exists public.fin_invoice_reconciliations (
  id          bigserial primary key,
  run_at      timestamptz not null default now(),
  payer       text not null,
  invoiced    numeric(12,2),
  paid        numeric(12,2),
  outstanding numeric(12,2),
  ok          boolean not null,
  report      jsonb not null
);
create index if not exists fin_invoice_reconciliations_payer_run_idx on public.fin_invoice_reconciliations (payer, run_at desc);

-- Every weekly review sent, exactly as sent.
create table if not exists public.fin_review_runs (
  id       bigserial primary key,
  run_at   timestamptz not null default now(),
  week_end date not null,
  packet   jsonb not null,
  summary  jsonb,
  verify   jsonb,
  html     text not null,
  sent     boolean not null default false
);
create index if not exists fin_review_runs_week_end on public.fin_review_runs (week_end desc);

do $$
declare t text;
begin
  foreach t in array array['plaid_accounts','plaid_transactions','plaid_liabilities','plaid_holdings',
    'plaid_holdings_value_history','net_worth_snapshots','fin_txn_override','fin_expected_income',
    'fin_scheduled_payments','fin_deposits','fin_deposit_movements','fin_deposit_exceptions',
    'fin_deposit_reconciliations','fin_invoices','fin_invoice_matches','fin_invoice_reconciliations',
    'fin_review_runs'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

grant select on public.plaid_accounts, public.plaid_transactions to plaid_readonly;
drop policy if exists plaid_readonly_select on public.plaid_accounts;
create policy plaid_readonly_select on public.plaid_accounts for select to plaid_readonly using (true);
drop policy if exists plaid_readonly_select on public.plaid_transactions;
create policy plaid_readonly_select on public.plaid_transactions for select to plaid_readonly using (true);
