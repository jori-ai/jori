# Quickstart

Jori needs a computer that stays on. A Mac is not required:

| Where | How |
|---|---|
| **Mac** | [Jori.dmg](https://github.com/jori-ai/jori/releases/latest/download/Jori.dmg) (the menu bar app below), or the one-line install. |
| **Windows 10 (2004+) / 11** | [JoriSetup.exe](https://github.com/jori-ai/jori/releases/latest/download/JoriSetup.exe), or in PowerShell `irm https://getjori.ai/install.ps1 \| iex`. Jori runs inside WSL 2; see [Windows](#windows). |
| **A rented server** | [getjori.ai/cloud](https://getjori.ai/cloud); see [A rented server](#a-rented-server). |
| **Linux** | the one-line install. |

iMessage, Notes, Photos and Find My need Jori on a Mac; everything else works everywhere.

## The one-line install (macOS, Linux)

```bash
curl -fsSL https://getjori.ai/install.sh | bash
```

That installs what is missing (Node.js 22.5+, git, Claude Code, Ollama with its embedding model), puts Jori in `~/Dev/jori`, and opens the **setup page** in your browser. On a Mac it uses Homebrew if you have it; without Homebrew it needs no password (Node goes into `~/.local/node`, git comes from Apple's developer tools, which may open Apple's installer window once, and Ollama into `~/Applications`). The page needs about two minutes and a few clicks:

1. **This computer** — checks Node, Claude Code and memory search, and installs what is missing.
2. **Claude sign-in** — signs in with your Claude subscription (`claude auth login` underneath) and checks the plan. Jori is built for Max.
3. **About you** — your name, email, home city, time zone and the assistant's name, filled in from this Mac (macOS account name, the Claude sign-in's email, the system time zone). Each field says what it changes. Fix what is wrong and save.
4. **Connect services** — one card per outside service, each saying what it switches on and what it costs: Supabase (needed for the phone app; the card also creates its tables), Google, instant mail (a Cloudflare Tunnel), your own email address, WhatsApp, Slack and Jev. **Test and save** checks the keys with the provider and saves only what works. Skip any; the same cards come back with `jori setup` or `jori init`.
5. **Keep it running** — one button. It installs the `ai.jori.session` launch agent (Jori starts now and at every login, and restarts after a crash) and schedules the starter jobs in `system/starter-jobs.json`, shown as a routine (every morning, all day, each evening, overnight, in the background). Jobs waiting for a service switch on once you connect it.
6. **Your phone** — a code the Jori app scans to find this installation.
7. **Try me** — send a message from the app and watch it arrive and get answered, with things to try this week.

Already cloned? Run `./bin/jori setup` from the checkout. It is safe to re-run: it fills only what is missing, never restarts a running service and never adds a job that is already in the crontab. `jori setup status` gives the same checks in the terminal, and `jori setup start` does step 4 without a browser.

The same installer, other ways:

| | |
|---|---|
| **Mac app** | `Jori.dmg` from [releases](https://github.com/jori-ai/jori/releases): drag to Applications and open it. It installs Jori, opens the setup page, then lives in the menu bar (running or not, control room, update, restart, logs). Source: `apps/mac/`. |
| **Homebrew** | `brew trust jori-ai/tap && brew install jori-ai/tap/jori`, then `jori setup` (Homebrew asks you to trust a tap before installing from it). Installs a `jori` launcher that installs the checkout on first use; `jori update` updates Jori, `brew upgrade jori` only the launcher. |
| **npm** | `npm create jori` (or `npx create-jori`). Source: `packages/create-jori/`. |

Keep it current with `jori update` (fast-forward pull, packages, restart).

### Windows

`JoriSetup.exe` (source `apps/windows/`, logic in `site/install.ps1`) turns on WSL if it is off (Windows asks for approval once and may need a restart, after which the install resumes by itself), imports Ubuntu 24.04 as a WSL distro named **Jori** with systemd on and a Linux user named after you, runs the normal installer inside it, and opens the setup page in your Windows browser. It also adds a `Jori` item to the Windows Startup folder that keeps the distro running (Windows otherwise stops it when its last window closes) and Start-menu items: **Jori setup**, **Jori control room**, **Update Jori**, **Repair Jori**. Keep the PC plugged in with sleep off (setup checks). The exe is not code-signed yet: SmartScreen says "Windows protected your PC"; choose **More info → Run anyway**. Uninstall from Settings → Apps; it asks before deleting the Jori distro and what it stored.

### A rented server

No computer to keep on: [getjori.ai/cloud](https://getjori.ai/cloud) makes a private key in your browser and gives you cloud-init lines to paste into the provider's *user data* / *Cloud config* box when you create an Ubuntu 24.04 server (Hetzner CX22, a DigitalOcean 4 GB droplet, or any provider). On first boot `site/cloud-init.sh` creates a `jori` user, runs the normal installer, and serves the setup page at `https://<ip-with-dashes>.sslip.io/?t=<key>` through Caddy (a real certificate, no warning). The cloud page polls the server and lights up **Open setup** when it is ready (about ten minutes). Pressing **Finish** on the setup page stops the server answering on the internet; the phone app reaches Jori through your Supabase project, not the server's address. Log: `/var/log/jori-cloud-init.log`.

### On a Mac mini or a virtual machine

Jori is happiest on a machine that never sleeps. Run the same one-liner **over SSH** on the host:

```bash
ssh you@mac-mini.local          # or your VM
curl -fsSL https://getjori.ai/install.sh | bash
```

`jori setup` notices the SSH session and, instead of opening a browser on a screen nobody is looking at, prints where to open the setup page from your own computer: the host's **Tailscale** address when it is on a tailnet (the page answers there only to tailnet addresses, and only with the token in the URL), or an `ssh -N -L 9087:127.0.0.1:9087 …` tunnel otherwise. Claude's sign-in works the same way from afar: open the sign-in link the page shows, then paste the code Claude gives you.

The **Keep it running** step then checks that the host stays on by itself and shows the command for anything that isn't set:

| Host | Checks |
|---|---|
| Mac mini / always-on Mac | signed in to the desktop, automatic login, never sleeps, restarts after a power cut, FileVault off (so a restart needs nobody at the keyboard) |
| macOS VM (Tart, UTM, Parallels, cloud Mac) | signed in to the desktop, automatic login, never sleeps |
| Linux VM | systemd lingering (keeps running after you log out), cron, `node` at `/opt/homebrew/bin/node` |
| Laptop | none: it sleeps, and Jori runs while it is awake |

`jori setup status` shows the same checks in the terminal. On Linux the service is a systemd user unit (`jori.service`); the Mac-only features (Messages, Photos, Find My, AppleScript) stay off. A machine without systemd (a container) runs `jori up` under its own supervisor; the starter jobs still go into cron.

Installer options (environment): `JORI_HOME` (default `~/Dev/jori`), `JORI_REPO`, `JORI_NO_OLLAMA=1`, `JORI_NO_SETUP=1`, `JORI_NO_LINK=1`. The script is [`site/install.sh`](../site/install.sh); read it before piping it to a shell.

---

## The manual install

Five commands and a few prompts, for when you want each step in the terminal. Result: Jori's supervisors running on your host, a webhook you can dispatch jobs to, and an event stream in your terminal.

## Before you start

Install once:

- **Node.js 22.5+** (built-in `node:sqlite`). Verify with `node --version`.
- **The Claude Code CLI**, logged in with a **Claude Max** subscription: `npm install -g @anthropic-ai/claude-code`, then run `claude` once and sign in. Every agent runs through `claude -p` on that login; the supervisors deliberately hide `ANTHROPIC_API_KEY` from those sessions (see [`agent-auth-model.md`](agent-auth-model.md)).
- **[Ollama](https://ollama.com)** for local classification and memory embeddings:
  ```bash
  ollama pull gemma3:1b              # small local classifier
  ollama pull nomic-embed-text       # embeddings for memory
  ollama serve                       # leave running
  ```

The bootstrap script probes for everything else and tells you what is missing. Jori is developed on macOS; parts of it (launchd, Keychain, `ioreg`) are macOS-only — see [`dependencies.md`](dependencies.md).

## Step 1 — Clone + bootstrap

```bash
# Clone this repository — copy its URL from the green "Code" button on GitHub
git clone <this repository's URL> ~/Dev/jori
cd ~/Dev/jori
./scripts/bootstrap.sh
```

What the bootstrap does:

- Verifies Node 22.5+, npm, Ollama and optional tools (`claude`, `gh`, `op`, `gog`, `jq`).
- Runs `npm install` in every package (root, `agent/`, the supervisor, `tools-mcp`, the channels, `browsing-skills/`, `bin/`).
- Creates the runtime directories: `data/`, `logs/`, `agent/logs/`, `agent/supervisor/state/{ops,chat}/`, `agent/local/`, `secrets/`, `credentials/`.
- Marks the CLIs and scripts executable and copies `.env.example` → `.env` if `.env` is absent.

Idempotent — re-run it after every `git pull`.

**Cloned somewhere else?** The CLI and scripts find the installation through `JORI_HOME` (default `~/Dev/jori`). Export it in your shell and keep it in `.env`.

## Step 2 — Configure

```bash
./bin/jori init
```

A short wizard:

1. **`JORI_HOME`** — the checkout path. Enter accepts it.
2. **`ANTHROPIC_API_KEY`** — optional; only developer tools such as `jori review-pr` use it.
3. **Identity** — your name, email, the From: address for mail the agent sends, your time zone, your GitHub user. Written to `agent/local/instance.json`, which the kernel reads through `lib/instance.cjs`.
4. **Supabase** (optional) — project ref, service-role key, Management API token, anon key. Without it the phone channel and companion apps stay off.
5. **Ollama** — URL and model names (defaults match the models above).
6. **Telemetry** — whether to send one anonymous install ping (no PII, no raw IP; `JORI_NO_TELEMETRY=1` skips the question and the ping).

It also generates a random webhook token in `secrets/webhook-token`, creates the runtime dirs, and seeds `data/hum-interests.json`, `data/hum-intent.md` and `data/user-timezone.json` from `examples/` (never overwriting). Re-run with `--force` to overwrite. Every variable is documented in [`.env.example`](../.env.example).

Then check the install:

```bash
./bin/jori doctor
```

Before `up`, the supervisor and channel checks fail (nothing is running yet); everything else should pass or tell you what to fix.

## Step 3 — Run

```bash
./bin/jori up
```

That runs `agent/bin/process-manager.mjs` in the foreground: the chat supervisor, the three ops tiers (`ops`, `ops-light`, `ops-haiku`) and the channel processes. Ctrl-C stops the tree. Logs go to `agent/logs/`.

## Step 4 — Fire a job (in another terminal)

```bash
./bin/jori dispatch morning-digest
```

`dispatch` posts `{"job": "morning-digest"}` to the webhook of the job's tier (its `model` in `agent/config/job-routing.json`: haiku → `ops-haiku` :9072, other non-opus → `ops-light` :9082, opus → `ops` :9092), falling back to a higher tier when that one isn't healthy. The supervisor loads `agent/ops-agent/jobs/morning-digest.md`, appends your own additions from `agent/local/jobs/morning-digest.md` if you wrote any, and hands it to the agent. With no arguments, `jori dispatch` lists the playbooks and their tiers.

## Step 5 — Watch it work

```bash
./bin/jori tail ops
```

That follows `agent/logs/supervisor-ops/events.ndjson`, one JSON line per event. Others:

```bash
./bin/jori tail ops-light      # or ops-haiku, chat
./bin/jori tail --all          # every supervisor
./bin/jori tail usage-push     # agent/logs/<name>.log (else logs/<name>.log)
```

---

## What now

1. **Tell Jori about you.** Put your standing rules in `agent/local/shared.md` (every agent) and `agent/local/chat.md` / `ops.md` (one role) — template: [`examples/local/shared.example.md`](../examples/local/shared.example.md). The supervisors append them to the kernel rules and reload them on change.
2. **Tune a job without forking it.** Add `agent/local/jobs/<job>.md` to extend a kernel playbook, or drop a whole new playbook in `agent/ops-agent/jobs/_ext/`. See [`writing-a-job.md`](writing-a-job.md).
3. **Keep your own layer in a private repo.** `agent/local/` and the `_ext/` dirs are gitignored; `./bin/jori overlay add <path>` links a private repo into them. See [`architecture-public-private.md`](architecture-public-private.md).
4. **Wire Gmail** — [`integrations/gmail.md`](integrations/gmail.md).
5. **Read the architecture map** — [`system/architecture.md`](../system/architecture.md).

For 24/7 operation see [`installer.md`](installer.md).

---

## When something doesn't work

- `./bin/jori status` — supervisor health, last activity, restart counts.
- `./bin/jori doctor` — drift and health checks (schedules vs tasks, MCP configs, Claude Code on PATH, ...).
- `./bin/jori logs <component>` — a slice of a log instead of following it.
- `./scripts/bootstrap.sh --quiet` — re-run setup; reports missing prerequisites.

Most first-run problems are one of: `claude` not logged in (or not on a Max plan), `JORI_HOME` not set for a checkout outside `~/Dev/jori`, Ollama not running, or a port already in use (the supervisors use 9071–9073, 9081–9083, 9090–9095).
