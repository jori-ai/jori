# Jori (formerly Edva, originally Merlin)

**An assistant that pays attention — even when you're not asking.**

One open-source assistant for your life and your work: run Jori as your personal assistant, or as your team's AI coworker. See [getjori.ai](https://getjori.ai).

Most assistants wait. You type, they reply, the moment passes. Jori stays on. It learns what you like, watches what matters, and quietly handles the things you'd rather not think about.

> Runs on the Claude subscription you already have. No API keys. No per-token bills.

> **Formerly Edva, originally Merlin.** The project was Merlin until 2026-10-25, Edva until 2026-10-28, and is now Jori, one name for the personal assistant and the business coworker. It lives at [github.com/jori-ai/jori](https://github.com/jori-ai/jori) (old Edva and Merlin links point here). Existing installs: move the checkout to `~/Dev/jori`, rename `EDVA_*` (or `MERLIN_*`) environment variables to `JORI_*`, rename the `edva_*` (or `merlin_*`) Supabase tables to `jori_*`, and swap the `ai.edva.session` (or `ai.merlin.session`) launch agent for `ai.jori.session` per [`docs/installer.md`](docs/installer.md).

→ Get started: **[docs/quickstart.md](docs/quickstart.md)**

---

## On the Claude you already have

You may have seen agent frameworks like *openclaw*. They're powerful, but they plug into the Claude API — separate account, pay per token, a bill that scales with how much your agent does.

Jori works the other way around. It runs through Anthropic's official Claude environment on the subscription you already use in your browser. Sign in once with `claude`, and Jori works through your account.

- **No API key to manage.** No per-token billing.
- **No new account.** Same Claude, just always on.
- **Flat monthly cost** — built for an assistant that runs continuously.

The agents run only on that subscription (a Claude Max login): Jori never quietly falls back to per-token billing, and if the subscription is unavailable it stops and tells you. An API key is optional, for a few developer tools such as `jori review-pr`.

---

## What Jori does

- **Keeps an eye on your inbox.** The urgent things find your phone the moment they arrive. Receipts, newsletters, and the routine noise get sorted and out of the way before you sit down.
- **Manages your calendar.** "Put Alice on for Tuesday at 2." Done. Move it, decline a conflict, send the invite — Jori handles the rest.
- **Books your table.** Mention the place and the night. If a window opens up, Jori grabs it.
- **Brings you the morning.** A quiet brief with today's calendar, your tasks, the weather, and the headlines you'd care about — waiting for you before you're out of bed.
- **Knows your taste.** Recommends restaurants by what you actually like and where you are, not what's popular this week.
- **Watches the world for you.** A flight you've been pricing drops. Tickets to a show you'd want. A friend's birthday is in a week. The follow-up call you meant to schedule. You'll hear about it at the right moment, from the right direction.
- **Helps with the rest.** "Write that no for me." "Summarize this." "Plan a long weekend away under two thousand." Describe what you need; Jori does the work.
- **Stays close.** A companion iOS/macOS app keeps the conversation going. Reply with 👍 to confirm, or "skip" to teach Jori what not to bring up again.

## What makes Jori different

Five things most AI assistants miss.

🧠 **It remembers you.** Your preferences, your decisions, the things you said last month. The longer you use it, the more it understands what *you* actually want.

🐝 **It reaches out.** When Jori notices something worth knowing, it tells you. Quietly. At the right moment. When there's nothing useful to say, it stays quiet.

🛠️ **It gets things done.** Doesn't just suggest. Writes the email, books the dinner, sets the reminder, runs the research. With safety rails for the things that matter — no money moves without you saying yes.

⏰ **It shows up on time.** Recurring work happens on schedule, in the background. You don't have to remember; it does.

📈 **It gets better as you live with it.** Every week, Jori reviews how it did, learns from how you responded, and tunes itself to fit your life more closely.

---

## Quickstart

For the technically inclined:

```bash
# Clone this repository — copy its URL from the green "Code" button on GitHub
git clone <this repository's URL> ~/Dev/jori
cd ~/Dev/jori

# 1. Install deps, set up runtime dirs, check Ollama
./scripts/bootstrap.sh

# 2. Interactive setup — writes .env and agent/local/instance.json,
#    generates a webhook token, seeds starter config from examples/
./bin/jori init

# 3. Check the install, then start everything in the foreground (Ctrl-C to stop)
./bin/jori doctor
./bin/jori up

# In another terminal — fire a test job
./bin/jori dispatch morning-digest

# Watch it work
./bin/jori tail ops
```

Cloned somewhere other than `~/Dev/jori`? Export `JORI_HOME=<path>` (and keep it in `.env`) — the CLI, scripts and MCP configs resolve the install from it. For 24/7 deployment see [`docs/installer.md`](docs/installer.md).

## What ships out of the box

| | |
|---|---|
| Kernel | process-manager, supervisors, channel framework, MCP shell bridge, kernel test suite |
| CLIs | ~90 tools — `jori` (with Jori's own `init`, `overlay`, `up`, `dispatch`, `tail`, `audit`, `review-pr`, `telemetry` in `bin/cli.d/`), `wiki`, `memory`, `email-*`, `context-*`, `hum-*`, `job-*`, `cron-*`, `self-improve-*` |
| Libraries | `instance` (per-install identity + config), `registry`, `wiki-store`, `local-llm`, `apns-push`, `supabase-rest`, `jori-context`, the outbound/claim gates |
| Apps | Two SwiftUI companion apps — chat (`apps/companion/`) and fitness tracker (`apps/trainer/`) |
| Reference jobs | `morning-digest`, the hum family (`hum`, `hum-review`, `hum-ideation`, `hum-daily`, `hum-consolidate`, `hum-explore`), the weekly self-improvement loop (`nightly-review`, `improvement-plan`, `system-issue-review`, `skill-repair`, `cost-efficiency-review`), wiki upkeep, `context-sync` |
| CI | iOS + macOS TestFlight workflows, secret-scan, sanitize-guard, narrative review |

## What you'll build yourself

Jori is deliberately a small, opinionated kernel — not a turnkey product. The integrations are sparse because *your* assistant should know about *your* life.

- **Make it yours without forking the kernel.** Your identity, rules and values go in `agent/local/` (`instance.json`, `shared.md`, `config/*.json`), your own code in the `_ext/` hook dirs. Both are gitignored; keep them in a private repo and link it with `jori overlay add`. See [`docs/architecture-public-private.md`](docs/architecture-public-private.md).
- **Populate Hum's awareness loop.** Empty on day 1. See [`docs/hum.md`](docs/hum.md).
- **Populate your memory corpus.** Empty on day 1. See [`docs/memory.md`](docs/memory.md).
- **Wire up integrations** — Gmail ([guide](docs/integrations/gmail.md)), Supabase ([guide](docs/integrations/supabase.md)), SMTP ([guide](docs/integrations/smtp.md)), or your own.
- **Write your own jobs.** Markdown playbooks. See [`docs/writing-a-job.md`](docs/writing-a-job.md).
- **Set your Apple signing identity** — for the companion apps. See [`apps/companion/CODE-SIGNING.md`](apps/companion/CODE-SIGNING.md).

---

## Requirements

Minimum:

- **macOS** (Apple Silicon preferred) or **Linux**
- **Node.js 22.5+** (built-in `node:sqlite`)
- **[Ollama](https://ollama.com)** with `gemma3:1b` and `nomic-embed-text` pulled
- A **Claude Max subscription**, with the Claude Code CLI logged in on the host (`claude`)

Full dependency matrix, per-feature requirements, and platform notes in [`docs/dependencies.md`](docs/dependencies.md). The bootstrap script probes for what's installed and warns about gaps.

## Under the hood

For the curious. Jori is built on Claude Code with persistent `claude -p` supervisors, durable session resume, an MCP shell bridge that turns any CLI into an agent tool, a SQLite memory layer with full-text + embedding search, a local Ollama model handling latency-sensitive acknowledgments, and markdown playbooks describing every scheduled job. Read the architecture: [`system/architecture.md`](system/architecture.md).

## License + contributing

Apache 2.0 — see [`LICENSE`](LICENSE). Contributions welcome; see [`CONTRIBUTING.md`](CONTRIBUTING.md). Security disclosures via [`SECURITY.md`](SECURITY.md).

<!--
  Anonymous view-counter pixel — no PII, no raw IP retention. The
  endpoint is a small open-source function under apps/telemetry/. The
  install-time first-run ping (controlled via JORI_TELEMETRY=on|off and
  JORI_NO_TELEMETRY=1) is the stronger signal; this pixel is mostly
  defeated by GitHub Camo caching. See apps/telemetry/README.md for the
  exact payload and a privacy walkthrough.
-->
![](https://jori-telemetry.vercel.app/px?r=readme)
