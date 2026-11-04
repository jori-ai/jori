-- 0100 receipts & orders: receipts extracted from mail (fields only, never
-- message bodies), the merchant order history import, and vendor quotes found
-- in mail and texts. Used by bin/receipt-scan, bin/amazon-order-detail,
-- bin/amazon-import-orders, bin/amazon-mail-orders, bin/quote-scan.
-- Service role writes; the optional plaid_readonly reporting role may read.

create table if not exists public.receipts (
  id                text primary key,           -- '<source>:<message id>', deterministic
  source            text not null default 'gmail',
  account           text not null,              -- the mailbox it came from
  vendor            text not null,
  date              date not null,
  total             numeric not null,           -- positive purchase, negative refund
  currency          text not null default 'USD',
  card_last4        text,
  ship_to           text,
  order_id          text,
  confidence        numeric not null default 0,
  email_subject     text,
  email_from        text,
  email_date        timestamptz,
  from_attachment   boolean not null default false,
  extracted_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  detail_fetched_at timestamptz,                -- order page last read
  detail_status     text,                       -- ok | not_found | login_required | blocked
  ship_address      text,
  ship_recipient    text,
  source_detail     text                        -- e.g. 'amazon-export' for rows projected from the import
);
alter table public.receipts add column if not exists detail_fetched_at timestamptz;
alter table public.receipts add column if not exists detail_status text;
alter table public.receipts add column if not exists ship_address text;
alter table public.receipts add column if not exists ship_recipient text;
alter table public.receipts add column if not exists source_detail text;
create index if not exists receipts_date_idx   on public.receipts (date desc);
create index if not exists receipts_total_idx  on public.receipts (total);
create index if not exists receipts_vendor_idx on public.receipts (vendor);
create index if not exists receipts_detail_pending_idx on public.receipts (vendor, detail_fetched_at) where order_id is not null;

create table if not exists public.receipt_line_items (
  id          bigserial primary key,
  receipt_id  text not null references public.receipts (id) on delete cascade,
  line_number int not null,
  description text not null,
  quantity    numeric,
  amount      numeric,
  asin        text,
  seller      text,
  created_at  timestamptz not null default now(),
  unique (receipt_id, line_number)
);
alter table public.receipt_line_items add column if not exists asin text;
alter table public.receipt_line_items add column if not exists seller text;
create index if not exists receipt_line_items_receipt_idx on public.receipt_line_items (receipt_id);

create table if not exists public.amazon_orders (
  order_id        text primary key,
  order_date      timestamptz not null,
  status          text,
  website         text,
  currency        text not null default 'USD',
  order_total     numeric,                      -- sum of the line items' own totals
  payment_method  text,
  card_last4      text,
  ship_to         text,
  ship_recipient  text,
  billing_address text,
  item_count      int not null default 0,
  imported_at     timestamptz not null default now()
);
create index if not exists amazon_orders_date_idx  on public.amazon_orders (order_date desc);
create index if not exists amazon_orders_card_idx  on public.amazon_orders (card_last4);
create index if not exists amazon_orders_total_idx on public.amazon_orders (order_total);

create table if not exists public.amazon_order_items (
  id                bigserial primary key,
  order_id          text not null references public.amazon_orders (order_id) on delete cascade,
  line_number       int not null,
  asin              text,
  product_name      text not null,
  product_condition text,
  quantity          numeric,
  unit_price        numeric,
  unit_price_tax    numeric,
  item_total        numeric,
  shipment_subtotal numeric,
  shipment_tax      numeric,
  shipping_charge   numeric,
  discounts         numeric,
  ship_date         timestamptz,
  shipment_status   text,
  tracking          text,
  unique (order_id, line_number)
);
create index if not exists amazon_order_items_order_idx on public.amazon_order_items (order_id);
create index if not exists amazon_order_items_asin_idx  on public.amazon_order_items (asin);

create table if not exists public.vendor_quotes (
  id              text primary key,             -- '<channel>:<message id>', deterministic
  account         text not null,
  channel         text not null default 'email', -- email | text | whatsapp
  sender          text,
  sender_name     text,
  vendor          text not null,
  kind            text not null default 'quote', -- quote | estimate | invoice
  received_at     timestamptz not null,
  amount          numeric,
  currency        text not null default 'USD',
  property_hint   text,
  service_summary text,
  pdf_text        text,                          -- a recognised quote's own attachment text only
  subject         text,
  confidence      numeric not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists vendor_quotes_received_idx on public.vendor_quotes (received_at desc);
create index if not exists vendor_quotes_sender_idx   on public.vendor_quotes (sender);
create index if not exists vendor_quotes_vendor_idx   on public.vendor_quotes (vendor);

create table if not exists public.vendor_quote_files (
  id           bigserial primary key,
  quote_id     text not null references public.vendor_quotes (id) on delete cascade,
  filename     text not null,
  content_type text,
  size         bigint,
  storage_note text,
  created_at   timestamptz not null default now(),
  unique (quote_id, filename)
);
create index if not exists vendor_quote_files_quote_idx on public.vendor_quote_files (quote_id);

do $$
declare t text;
begin
  foreach t in array array['receipts','receipt_line_items','amazon_orders','amazon_order_items','vendor_quotes','vendor_quote_files'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select on public.%I to plaid_readonly', t);
    execute format('drop policy if exists plaid_readonly_select on public.%I', t);
    execute format('create policy plaid_readonly_select on public.%I for select to plaid_readonly using (true)', t);
  end loop;
end $$;
