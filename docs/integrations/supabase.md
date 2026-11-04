# Integration: Supabase

Wire Supabase if you want any of:

- **The companion iOS/macOS app** to chat with your agent (requires Realtime).
- **Phone-context publishing** (motion / Wi-Fi / location → agent).
- **Persistent message + command history** that survives supervisor restarts.
- **APNs push routing** through a Supabase edge function.

Without Supabase, Jori still works for cron-driven jobs + email triage + the wiki/memory layer. The phone-channel + companion app are the only features that hard-require it.

## 1. Create a Supabase project

At https://supabase.com:

- New project. Pick a region close to your host (latency matters for Realtime).
- Note the **project ref** (the slug in `<ref>.supabase.co`).
- Service-role key → Settings → API → `service_role` (this is the secret one).
- Anon key → Settings → API → `anon` `public`.

Record the project in `agent/local/instance.json` (`"supabase_project": "<ref>"` — `jori init` asks for it; `JORI_SUPABASE_PROJECT` in `.env` overrides), the public anon key in `agent/local/config/supabase.json` (`{"anon_key": "..."}`), and the secret in `.env`:

```
SUPABASE_SERVICE_ROLE_KEY=...
# SUPABASE_URL defaults to https://<supabase_project>.supabase.co; set it only for a custom domain.
```

For the MCP server's Management-API access (creating/inspecting projects via the agent):

```
SUPABASE_ACCESS_TOKEN=sbp_...    # generate at supabase.com/dashboard/account/tokens
```

## 2. Create the schema

The schema is in the kernel at `system/migrations/` (one idempotent file per capability). Run `bin/jori-migrate` for a dry run of the plan, then `bin/jori-migrate --apply --project <ref> --allow-user <email>`. [schema.md](../schema.md) says which capability needs which tables and how the allowlist works.

## 3. Verify

Start the agent (`./bin/jori up`), check the logs:

```
[phone-channel] subscribed to jori_messages realtime
[phone-channel] subscribed to phone_context realtime
[phone-channel] ready
```

If you see `FATAL: SUPABASE_SERVICE_ROLE_KEY not set in .env`, the env var didn't propagate — check that `.env` sits at `$JORI_HOME/.env` and that `process-manager.mjs` loaded it (it logs a warning when it cannot).

## 4. Companion app pairing

For the iOS/macOS companion app at `apps/companion/`:

1. Build per [`apps/companion/CODE-SIGNING.md`](../../apps/companion/CODE-SIGNING.md).
2. The app sources carry placeholders, not a project: replace `${JORI_SUPABASE_PROJECT}` and `${JORI_SUPABASE_ANON_KEY}` in `apps/companion/Jori/SupabaseManager.swift` (and, for Trainer, `apps/trainer/Trainer/Services/TrainerSupabase.swift` plus the `SupabaseURL` / `SupabaseAnonKey` keys in `apps/trainer/Trainer/Info.plist`) with your project ref and anon key in your local build — or inject them at build time — and don't commit the filled-in values (`.tools/sanitize-guard.py` flags a committed JWT).
3. Run the app, sign in (Google Sign-In is the default; the app exchanges the Google credential for a Supabase session).
4. The app subscribes to `jori_messages` and posts new user messages there. The phone-channel daemon on your host sees them via Realtime and routes them to the chat-supervisor.

## RLS policies

Every table has Row Level Security on. The agent uses the **service-role** key, which bypasses RLS. The companion app and the sites sign in as `authenticated` users and reach a table only when their email is in `jori_allowed_users` (`jori_is_allowed_user()`); `anon` has no row policy anywhere. See [schema.md](../schema.md).

## Cost

A typical chat-only deployment fits in Supabase's free tier (500 MB DB + 50 MB file storage + 2 GB egress + unlimited Realtime). If you also enable health-data sync (10+ tables, 10k+ rows/day depending on Apple Health activity), you'll need the Pro plan ($25/month).

## A dedicated project for the agent

Give the agent's operational data its own Supabase project (and, ideally, its own account identity) rather than reusing a personal one: token scope stays minimal, rotation stays simple, and nothing else breaks when you reset it.
