# Quickstart

## The one-line install (macOS)

```bash
curl -fsSL https://getjori.ai/install.sh | bash
```

That installs what is missing (Homebrew, Node.js 22.5+, git, Claude Code, Ollama with its embedding model), puts Jori in `~/Dev/jori`, and opens the **setup page** in your browser. The page needs about two minutes and a few clicks:

1. **Your Mac** — checks Node, Claude Code and memory search, and installs what is missing.
2. **Claude sign-in** — signs in with your Claude subscription (`claude auth login` underneath) and checks the plan. Jori is built for Max.
3. **About you** — your name, email, home city, time zone and the assistant's name, filled in from this Mac (macOS account name, the Claude sign-in's email, the system time zone). Fix what is wrong and save.
4. **Keep it running** — one button. It installs the `ai.jori.session` launch agent (Jori starts now and at every login, and restarts after a crash) and schedules the starter jobs in `system/starter-jobs.json`: the watchdog, the morning brief, hum, memory upkeep and the two repair loops. Other jobs switch on from the control room as you connect what they need.
5. **Ways to reach you** — the Jori app, iMessage, WhatsApp, Slack and Gmail, each set up from the control room.

Already cloned? Run `./bin/jori setup` from the checkout. It is safe to re-run: it fills only what is missing, never restarts a running service and never adds a job that is already in the crontab. `jori setup status` gives the same checks in the terminal, and `jori setup start` does step 4 without a browser.

The same installer, other ways:

| | |
|---|---|
| **Mac app** | `Jori.dmg` from [releases](https://github.com/jori-ai/jori/releases): drag to Applications and open it. It installs Jori, opens the setup page, then lives in the menu bar (running or not, control room, update, restart, logs). Source: `apps/mac/`. |
| **Homebrew** | `brew install jori-ai/tap/jori`, then `jori setup`. Installs a `jori` launcher that installs the checkout on first use; `jori update` updates Jori, `brew upgrade jori` only the launcher. |
| **npm** | `npm create jori` (or `npx create-jori`). Source: `packages/create-jori/`. |

Keep it current with `jori update` (fast-forward pull, packages, restart).

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
