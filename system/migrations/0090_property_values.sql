-- 0090 property values: per-parcel valuations from automated models and
-- hand-recorded estimates, reconciled into one figure per parcel and a daily
-- portfolio total (bin/property-values, bin/zestimate, bin/net-worth,
-- bin/finance-property-review-data). Service role only.

create table if not exists public.property_values (
  parcel_id         text primary key,
  holding           text not null,
  address           text not null,
  property_type     text,
  owned             boolean not null default true,
  estimate          numeric,
  estimate_low      numeric,
  estimate_high     numeric,
  rent_estimate     numeric,
  acquisition_price numeric,
  acquisition_date  date,
  bedrooms          numeric,
  bathrooms         numeric,
  square_footage    numeric,
  comparable_count  integer,
  low_confidence    boolean not null default false,
  as_of             timestamptz not null,
  updated_at        timestamptz not null default now()
);
alter table public.property_values add column if not exists low_confidence boolean not null default false;
create index if not exists property_values_holding_idx on public.property_values (holding);

create table if not exists public.property_value_history (
  as_of_date    date not null,
  parcel_id     text not null,
  estimate      numeric,
  rent_estimate numeric,
  as_of         timestamptz not null,
  updated_at    timestamptz not null default now(),
  primary key (as_of_date, parcel_id)
);
create index if not exists property_value_history_parcel_idx on public.property_value_history (parcel_id, as_of_date desc);

create table if not exists public.property_value_totals (
  as_of_date        date primary key,
  total_estimate    numeric,
  total_rent        numeric,
  num_parcels       integer,
  total_acquisition numeric,
  total_avm_only    numeric,
  basis_note        text,
  as_of             timestamptz not null,
  updated_at        timestamptz not null default now()
);
alter table public.property_value_totals add column if not exists total_avm_only numeric;
alter table public.property_value_totals add column if not exists basis_note text;

-- Every opinion of value as its own row (upsert on as_of_date,parcel_id,source).
-- Derived from bin/property-values and bin/zestimate: the overlay holds no DDL.
create table if not exists public.property_value_sources (
  as_of_date     date not null,
  parcel_id      text not null,
  source         text not null,        -- rentcast | zillow | manual | ...
  estimate       numeric,
  estimate_low   numeric,
  estimate_high  numeric,
  low_confidence boolean not null default false,
  note           text,
  as_of          timestamptz not null,
  updated_at     timestamptz not null default now(),
  primary key (as_of_date, parcel_id, source)
);

create table if not exists public.property_value_reconciled (
  as_of_date   date not null,
  parcel_id    text not null,
  holding      text not null,
  value        numeric(14,2) not null,
  basis        text not null,
  contributors text[] not null default '{}',
  note         text,
  primary key (as_of_date, parcel_id)
);

alter table public.property_values           enable row level security;
alter table public.property_value_history    enable row level security;
alter table public.property_value_totals     enable row level security;
alter table public.property_value_sources    enable row level security;
alter table public.property_value_reconciled enable row level security;
