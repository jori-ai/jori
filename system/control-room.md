# Control room

The **Control** tab on the memory site (the wiki hostname behind Cloudflare
Access, and the wiki on the host at :9096 and :9097) is where the owner sees and changes how Jori is set up:
every recurring job and when it runs, watches, agents and models, the budget
brake, channels, every feature's settings, identity and addresses, outside
services and their keys, the machine, and a history of every change.

Goal: **everything that varies between installations or over time is a
setting, and every setting is visible and editable here.** A value written
straight into code is a bug to fix, listed on the tab's "Not configurable yet"
page until it is gone.

## How it is served

- Routes live under `/control` in `lib/wiki-serve.js`, rendered by
  `lib/control/*.mjs` inside the shared site shell (`lib/wiki-render.js`), so
  the tab looks and navigates like the rest of the memory site.
- The wiki hostname: the Cloudflare Worker (`wiki-worker/src/index.js`) passes
  `/control*` straight through to the origin on the host (:9097), like
  `/search` and `/api/*`. The control room always reads live state on the
  host; the cloud mirror has none of it. If the host is down, the tab says so.
- Who may use it: only the owner. On :9097 the verified Cloudflare Access
  email must be `owner_email` (or listed in `control.json` `admins`). On the
  tailnet instance (:9096, no Access) a request must come from loopback or a
  Tailscale address (100.64.0.0/10); LAN addresses get read-only pages and no
  writes. The tab is shown in the site nav only to someone who may use it.
- Writes are POSTs carrying a per-process CSRF token that is embedded in the
  page; a cross-site form cannot change anything.

## What each page reads and writes

| Page | Reads | Writes through |
|---|---|---|
| Today | everything below | — |
| Schedule | `crontab -l`, `~/Library/LaunchAgents/{ai.claude,com.jori,ai.jori}.*.plist`, `launchctl list`, `data/cron-runs.jsonl`, job routing (`lib/registry.cjs`), `allowance-brake.json` | crontab: `bin/crontab-safe replace <--label tag>` (never a raw `crontab -`); launchd: plist edited with `plutil`, then `launchctl bootout` + `bootstrap`; run now: `cron-run` detached / `launchctl kickstart` |
| Watches | `bin/watch list --json` | `bin/watch pause|resume` |
| Agents & models | supervisors' `/health`, `agent/config/agents.json`, `agent/config/models.env` | `models.env` line edit; supervisor `POST /restart` |
| Budget | `agent/local/config/allowance-brake.json` | same file |
| Channels | channel configs, quiet hours (`agent/local/config/quiet-hours.json`) | same files |
| Feature settings | `agent/local/config/*.json` | same file |
| Identity & addresses | `agent/local/instance.json` via `lib/instance.cjs` | same file |
| Services & keys | `system/service-catalog.json` + `.env` key **names** | nothing (key values are never read into a page or written from one; rotate in 1Password, then `.env`) |
| The machine | `instance.json` host keys, `lib/ports.cjs`, `system/services.json` + local | `agent/local/config/ports.json` |
| Not configurable yet | `data/control-hardcoded.json` from `bin/control-scan` | — |
| Change history | `data/config-audit.jsonl` | "Put back" reapplies the recorded `before` |
| Jev (on Agents) | `data/jev-config.json`, question files, `data/jev-shadow/` (7 days), `data/.jev-off`, `TYPESAFE_API_KEY` set or not | `data/jev-config.json` (thresholds, per-site on/off, privacy, budget); `data/.jev-off` |
| Setup | every part above, plus Ollama, webhook token, Supabase, Cloudflare Access | — (each item links the page that fixes it) |
| Failing jobs (on Schedule and Today) | `data/job-failure-state.json`, `data/job-repair-queue.json` | — (`bin/job-failure-watch`, run by the watchdog) |

Every file write is atomic (`lib/atomic-write.js`), keeps the previous copy in
`data/backups/control/`, refuses a JSON file that does not parse, and appends
one line to `data/config-audit.jsonl`: `{ts, who, page, target, before, after}`.

## Making everything configurable

The settings come from three layers, which already existed:
`lib/instance.cjs` (`instance.json`, with `JORI_*` env vars overriding it),
`localConfig(name, defaults)` (`agent/local/config/<name>.json`) and
`agent/config/models.env`. These additions close the gaps:

1. **Identity keys** (done): `assistant_name` (default "Jori"),
   `sender_name`, `assistant_aliases`, `partner_name`, `home_city` in
   `lib/instance.cjs`, with `assistantName()` / `assistantAliases()`.
2. **Ports** (done): `lib/ports.cjs`, one registry of the local ports, with
   overrides from `agent/local/config/ports.json` or `JORI_PORT_<NAME>`.
3. **Batches** that move the hardcoded values onto those layers, one
   category at a time, each with tests:
   - A. The assistant's name in notification titles, email sender names,
     subjects, page titles and app strings → `assistantName()` /
     `sender_name`.
   - B. Owner and partner names, owner email, home time zone, site URLs in
     kernel code → `instance()` values; personal lists (cities, venues)
     → `localConfig`.
   - C. Port literals → `lib/ports.cjs`; model ids → `lib/models.cjs`.
   - D. Policy constants (awake hours, daily and hourly caps, dedup windows,
     dollar thresholds) → `localConfig("<feature>", defaults)` so each shows
     up as a setting.
   - E. Absolute `/Users/<user>/…` paths in launch-agent plists → generated
     from templates at install time (`agent/launch-agents/install.sh`
     substitutes `$HOME` and the install dir).
4. **Keeping it that way**: `bin/control-scan` searches code for the
   installation's own values (taken from `instance.json`, the port registry
   and `models.env`) and writes `data/control-hardcoded.json`; the control
   room lists what it finds. Cron runs it hourly on the host
   (`--label control-scan`), and the page has a Scan now button.

What stays out of settings on purpose: secret values (1Password and `.env`
only), the kernel's product name inside identifiers that stored data depends
on (table names, launchd labels, approval contexts already in use), and
prompts written as the owner's own words (playbooks under `agent/local/`).
