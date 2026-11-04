# Supabase schema

Jori's code reads and writes a set of Supabase (Postgres) tables. Their
definitions live in the kernel at `system/migrations/*.sql`, one file per
capability, applied in name order by `bin/jori-migrate`. Every file can be run
again safely: tables, columns and indexes use `IF NOT EXISTS`, functions and
views use `OR REPLACE`, and policies and triggers are dropped (`IF EXISTS`) and
created again. Nothing in these files names a person, an email address or a
project.

`tests/schema-migrations.test.mjs` checks that every table, view and RPC the
kernel's code reaches through PostgREST has a `CREATE` here, that no file holds
an email address or a project ref, that every statement can be re-run, and that
RLS is on for every table.

## A fresh install

1. Create the project and record it (see
   [integrations/supabase.md](integrations/supabase.md)): `supabase_project` in
   `agent/local/instance.json`, the service-role key in `.env`, and a
   Management API token (`SUPABASE_ACCESS_TOKEN` in `.env`, or the
   self-renewing OAuth token from `bin/supabase-token`).
2. Look at the plan. This is a dry run; it changes nothing:

   ```
   bin/jori-migrate               # files in order and what each creates
   bin/jori-migrate --print       # the same, plus the full SQL
   ```

3. Apply it, naming the project a second time so a wrong install can't be
   hit by accident:

   ```
   bin/jori-migrate --apply --project <ref> --allow-user <your sign-in email>
   ```

   Each file goes to the Management API's SQL endpoint in order, and the run
   stops at the first error. If you'd rather not use a token, paste the
   `--print` output into the dashboard's SQL editor.

`--only 0010,0030` limits a run to files whose names start with those
prefixes. `0000_foundation.sql` must run first on a new database, because
the other files use its helpers.

## The allowlist

The service-role key the host uses skips row-level security, so the host can
read and write every table. Everything else is denied by default:

- RLS is on for every table. A table with no policy can only be reached with
  the service role.
- App- and site-facing tables let the `authenticated` role in only when
  `public.jori_is_allowed_user()` is true, meaning the email on the caller's
  Supabase Auth session (Google sign-in by default) is in
  `public.jori_allowed_users`.
- `anon` has no row policy anywhere.

To add someone, such as the user or a partner who shares the app and sites:

```
bin/jori-migrate --only 9999 --allow-user <email> --apply --project <ref>
```

You can also run this in the SQL editor:

```sql
insert into public.jori_allowed_users (email) values (lower('<email>')) on conflict do nothing;
```

To remove someone, `delete from public.jori_allowed_users where email = lower('<email>');`.
Emails are stored in lower case.

`jori_allowed_users` has RLS on and no policies, so nobody can list it through
the API. Policies read it through the `security definer` function. A plain
subquery would be filtered by that table's own RLS, and nobody would get in.

Optional role: `plaid_readonly` (NOLOGIN) has SELECT on the bank, receipt and
quote tables, for an outside reporting reader. It has no other rights.

## Which capability needs which tables

A capability you don't use can skip its file. Its code treats a missing table
like an unconfigured feature and turns itself off.

| File | Capability | Tables / views / functions | App or site access |
|---|---|---|---|
| `0000_foundation` | required | `jori_allowed_users`, `jori_is_allowed_user()`, helper functions, `plaid_readonly` role | none |
| `0010_chat` | companion-app chat, push, recall | `jori_messages` (+ `jori_messages_semantic_search`), `jori_commands`, `device_tokens`, `app_perf_events`, bucket `jori-attachments`; Realtime on messages and commands | read/write for allowed users; insert only `role = 'user'` messages |
| `0020_approvals` | Face-ID approvals: self-improvement cards, purchases | `self_improve_approvals` (+ freeze trigger), `approval_device_keys`, `purchase_approvals`, `purchase_device_keys`, `purchase_pairing_codes`, `pair_purchase_device()` | read and decide; purchase rows only `pending → signed/denied` on the decision columns |
| `0030_location` | location, presence, wake/sleep, travel timeline | `location_history` (Realtime), view `location_visits`, `phone_context`, `phone_unlocks`, `phone_lock_events`, `phone_usage_windows`, `sleep_nights`, `travel_segments` | the app writes its own location / context / usage rows |
| `0040_photos` | photo index, photo probes, place photos | `photos`, `photo_probes`, `place_photos`, bucket `daily-photos` | the app writes photo rows and `thumbs/` thumbnails |
| `0050_memory` | daily/weekly/monthly summaries, wiki mirror | `daily_summaries` (+ `daily_summaries_semantic_search`), `weekly_summaries`, `monthly_summaries`, `wiki_pages`, `wiki_page_links`, `wiki_page_revisions`, `wiki_config`, `wiki_search()` | none (service role) |
| `0060_health` | Apple Health | `health_samples`, `health_workouts`, `health_aggregates`, `health_clinical_records`, `health_bucketed()`, `health_types_summary()`, `health_clinical_summary()` | the app uploads |
| `0070_finance` | Plaid bank data, net worth, finance review | `plaid_accounts`, `plaid_transactions`, `plaid_liabilities`, `plaid_holdings`, `plaid_holdings_value_history`, `net_worth_snapshots`, `fin_txn_override`, `fin_expected_income`, `fin_scheduled_payments`, `fin_deposits`, `fin_deposit_movements`, `fin_deposit_exceptions`, `fin_deposit_reconciliations`, `fin_invoices`, `fin_invoice_matches`, `fin_invoice_reconciliations`, `fin_review_runs` | none; `plaid_readonly` may read accounts and transactions |
| `0080_investments_broker` | read-only brokerage snapshot | `broker_accounts`, `broker_positions`, `broker_value_history`, `broker_position_history`, `broker_account_history` | none |
| `0090_property_values` | real-estate valuations | `property_values`, `property_value_history`, `property_value_totals`, `property_value_sources`, `property_value_reconciled` | none |
| `0100_receipts` | receipts from mail, merchant order history, vendor quotes | `receipts`, `receipt_line_items`, `amazon_orders`, `amazon_order_items`, `vendor_quotes`, `vendor_quote_files` | none; `plaid_readonly` may read |
| `0110_loyalty` | miles and points | `loyalty_accounts`, `loyalty_balance_history` | none |
| `0120_watch` | shows & movies, ratings site | `watchlist` (v1), `watch_titles`, `watch_seasons`, `watch_feedback`, `watch_taste_prefs`, `watch_ratings`, `watch_catalog`, `watch_film_edges`, `watch_batches`, `watch_embeddings`, `bump_catalog_affinity()` | the site reads and marks titles, ratings and the catalog |
| `0130_cruise` | cruise watch and its site | `cruise_sailings`, `cruise_price_history`, `cruise_ship_photos`, `cruise_ship_ratings`, `cruise_favorites`, bucket `cruise-ships` | the site reads; favourites are per user (own rows only) |
| `0140_trip` | trip reservoirs, rendered day plans | `trip_reservoirs`, `trip_day_plans` | the site reads reservoirs and marks entries done |
| `0150_spa` | spa heating telemetry | `spa_heating_sessions`, `spa_heating_ticks` | none |
| `9999_reload_schema` | always | `notify pgrst, 'reload schema'` | none |

Config-dependent names:

- The brokerage tables are the defaults in `lib/broker-config.cjs`. An
  install that maps `investments.json` → `broker.tables` to other names keeps
  its own tables.
- `bin/net-worth` writes one numeric column per configured source key
  (`net_worth.sources[].key`, `net_worth.plaid_holdings.key`). Add a column
  for each of your keys:
  `alter table public.net_worth_snapshots add column if not exists <key> numeric;`.
- The asset histories that `net_worth.sources[]` and
  `finance.net_worth.value_histories[]` point at belong to the installation,
  apart from the brokerage defaults above.

## An existing database

The files can run against a database that already holds these tables. They
add only what's missing. They don't drop or rename anything, and they don't
delete older policies, which may be more permissive. Before running `--apply`
on an existing project:

- Read the `--print` output.
- List the current policies (`select * from pg_policies where schemaname = 'public'`).
- Drop any older policy that admits more than the allowlist does. RLS ORs
  permissive policies together, so one `using (true)` left behind keeps its
  table open.
- Fill `jori_allowed_users` before the app's next sign-in, or the new
  policies will lock the app out.

## Adding a table

Put the DDL in the capability's file, or in a new `NNNN_<capability>.sql`,
in the same change as the code that uses it. Follow the same idempotent
style. Turn RLS on, and give it allowlist policies only if the app or a site
reads it. Then run `node --test tests/schema-migrations.test.mjs`.
