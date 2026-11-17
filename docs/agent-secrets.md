# Agent secrets and tool profiles

The agents read untrusted text all day (mail from anyone, web pages, group chats) and run with every permission. This page is how Jori keeps the installation's keys, tokens and passwords out of their reach, and how each agent gets only the tools it needs. The rule itself is in `agent/CLAUDE.md` § Secrets; this is the mechanics.

## 1. No secrets in the agent's environment

**Before:** `agent/bin/process-manager.mjs` loads every line of `.env` into its environment. The supervisors and the fork runners handed that whole environment to `claude -p`, so every agent's Bash tool and every MCP server it started could print every secret with one `env`.

**Now:** every place that starts an agent builds its environment with `lib/agent-env.cjs` `agentEnv(agent)`. It drops a name when:
- it is **shaped like a secret** (`TOKEN`, `SECRET`, `PASSWORD`, `*_API_KEY`, `*_KEY`, `COOKIE`, `CREDENTIAL`, …; `*_ID` names are identifiers and pass);
- it is a **`.env` key that is not plainly configuration** (a URL, host, path, model, id, any `JORI_*` setting). An unknown `.env` key is assumed to be a secret;
- or the installation lists it in `strip`.

It keeps by name the few secrets the agent process itself needs:
- `CLAUDE_CODE_OAUTH_TOKEN`: the Max login under cron (`bin/cron-run`).
- (Until 2026-11-16 also `GOG_KEYRING_PASSWORD`. `gog` reads its keyring password only from its environment, so a locked-down environment now puts `bin/shims` first on `PATH` and sets `GOG_BIN` to `bin/shims/gog`, a wrapper that reads the password from `.env` in its own process and runs the real gog. Every tool that runs gog honours `GOG_BIN`; cron and launchd jobs source `.env` and pass straight through. The password is briefly in the gog process's own environment while it runs.)
- Anything in the installation's `keep` list.

Everything else (PATH, HOME, the Claude Code settings variables, the supervisor's own non-secret variables) passes unchanged.

**Spawn sites wired:**
- `agent/supervisor/claude-session.mjs`, the four supervisors' sessions (`agentEnvId` = the agents.json id).
- `agent/scripts/lib/run-ephemeral-opus.sh` and `run-ephemeral-fable.sh`, every Opus/Fable fork (`agent-env.sh` `jori_agent_env_cmd forks` → `env -i …`). The runner still sources `.env` for its own needs; only `claude` gets the filtered set.
- `bin/daily-summary-run` (id `daily-summary`) and `bin/finance-review-run` (id `finance-review`), the same way. Each logs `agent env: locked down, N kept` or `inherited` per run.
- `bin/findme`'s tool-less Haiku call (id `findme`, `_agent_env`).

**Rule, held by `tests/agent-env-launchers.test.mjs`:** every launcher that starts `claude -p` with `bypassPermissions` goes through the lockdown. That combination gives the model Bash, so it could print its environment.

**Model calls made by code** (id `model-calls`, since 2026-11-16): `lib/agent-env.cjs` `modelEnv()`, the same filter plus the Anthropic keys stripped. The model in these calls has no Bash, but the call runs inside a tool that has loaded `.env` (the phone channel, hum-sense, a cron job), and **a process's starting environment is readable by any process of the same user** (`ps eww <pid>`). So a `claude -p` handed the loaded `.env` showed every secret to any agent with Bash for as long as it ran: on 2026-11-16 a tool-less judgment from the phone channel was seen holding 106 variables, the whole `.env`. Wired:
- the shared helpers `lib/jev-claude.mjs` and `lib/max-judge.js` (`maxOnlyEnv`), which most judgments go through: Jev, claim checks, outbound precheck, the speak gate, stop evidence, watch fit, the cheap-model rung (`lib/local-llm.mjs`), `day-statements`, the daily-summary review, photo place names;
- `agent/core/stateless-executor.mjs` (the strict triage one-shot, `agent-oneshot`, family Q&A, wiki dedup), `agent/core/agent.mjs`, `agent/runtime/repl-sandbox.mjs`;
- the WebSearch forks: `agent/capabilities/web-search.mjs`, `agent/supervisor/web-read.mjs`, the art and music harvesters, `bin/watch-discover`, `bin/watchlist-intro-email`, `trip-day-render`, `trip-day-select`, `trip-reservoir-build`, `lib/reservoir-refine.js`;
- `lib/place_naming.py` (`_model_env`, through `agent-env.cjs --agent model-calls --print0`).

The speak gate's research session runs gog through `bin/shims/gog`, since it no longer gets the keyring password. **Rule, held by `tests/model-call-env.test.mjs`:** every file that starts the `claude` binary with `-p` in process (Node or Python) references the filter. A process's own environment set by `process.env` assignments after it started is not in `ps eww`; only what a child is started with is.

**Still open (2026-11-16):** `agent/bin/process-manager.mjs` loads `.env` into its own environment and starts its children with it: the four supervisors, the iMessage, Slack and WhatsApp channels and both wiki servers. Each of those holds the whole `.env` (94 variables on the mini) in its starting environment for as long as it runs, and `bin/secrets-guard` does not refuse `ps eww`, so an agent with Bash can read them. The agents' own `claude` processes and the model calls are filtered; their parents are not. **The fix, rolling out per process:** `lib/env-isolate.cjs` `isolateProcessEnv(name)`, called first thing by the child, re-executes the same process in place (`process.execve`: same pid, argv and stdio, so process-manager notices nothing) with every variable whose value comes unchanged from `.env` left out of the starting environment, and `node --env-file=.env` to load them back into `process.env`. A name is left out only when `util.parseEnv` (the `--env-file` parser) reads the same value from `.env` as the process holds, so `process.env` afterwards is exactly what it was; on the mini all 83 keys parse identically under process-manager's loader and `--env-file` (checked 2026-11-16). Which processes do it: `agent/local/config/agent-env.json` `isolate` (process-manager names, or `"all"`), read when the child starts, so turning one on or off takes effect at that child's next restart and process-manager itself is never restarted. Off: drop the name, or `JORI_ENV_ISOLATE=0`. The child logs `[env-isolate] <name>: …` to its own log. Wired: `bin/wiki serve` (`wiki-server`, `wiki-server-public`) calls it directly; an ES-module entry point imports `lib/env-isolate-first.mjs` as its **first** import (ES modules evaluate imports in order, so it runs before any other module), which names the process from its entry file (`env-isolate.cjs` `ENTRIES`): the iMessage, Slack and WhatsApp channels. The re-exec goes through the path the process was started with (process-manager's `node` symlink, whose target is the signed build the macOS privacy grants are tied to), so the command line reads the same plus `--env-file`. The trial started with `wiki-server-public`; both wiki servers, the three channels and the four supervisors (`<agent>-supervisor`, `chat-supervisor`) run isolated since 2026-11-16, so no process-manager child holds the `.env` in its starting environment. What remains readable that way: a child those processes start with their default environment (a `job-run` job, a bin a tool runs, a cron job that sources `.env`) for as long as it runs, and gog through its shim.

**Tools read their own secrets.** A program that needs a key loads `.env` itself: `lib/load-env.js` `loadEnv()` (Node; many libs call it at import, e.g. `plaid-api.js`, `supabase-rest.js`), `lib/supabase_local.py` `env_value()` (Python), or a `sed -n 's/^NAME=//p' .env` fallback (bash; `site-pass`, `card-pass`, `dev-pass`, `supabase-mcp`). The tools MCP server loads `.env` at start, so the CLIs it runs (`gog`, `homectl`, `imsg`) have what they need. A new tool that reads a secret must do the same: never rely on the agent's environment.

**MCP servers defined in Claude Code's user config.** `~/.claude.json` on the host defines MCP servers that every Claude session starts, locked-down agents included, even when their tools are disallowed. A key in such a server's `args` sits on its command line, readable by any same-user process (`ps`), and a key in its `env` block sits in the config file. The lockdown does not reach either. So no key goes there: the server runs through a launcher that reads `.env` in its own process. The Browserbase server (`bin/browserbase-mcp`) is the first. Its keys moved on 2026-11-16 from `--modelApiKey` and the config's `env` to `.env` (`BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `BROWSERBASE_MODEL_API_KEY`); `bin/bb-verify` checks the setup and warns when a key is back in the config. Claude Code keeps copies of the old config under `~/.claude/backups/`, so a key that sat in the config is still on disk there until it is rotated.

**Roll-out, per agent.** `agent/local/config/agent-env.json`:

```json
{ "lockdown": ["ops-haiku", "ops-light"],
  "keep": [], "strip": [],
  "guard": "log" }
```

- `lockdown` is a list of agents.json ids plus `"forks"`, or `"all"`. An agent not listed inherits everything, as before.
- The file is **re-read at every session start and every fork**: a change takes effect at the next `jori restart <agent>` or the next fork, with no supervisor process restart.
- `JORI_AGENT_ENV_LOCKDOWN=0` in a supervisor's environment is the emergency off switch.
- Order: ops-haiku → ops-light → forks → ops → chat. A tool that expected a key in its environment fails loudly; add a `.env` read to it, or put the name in `keep` while it is fixed.

**Check an agent:** `node lib/agent-env.cjs --agent ops --explain` prints what it keeps and drops, names only. On a live agent, the supervisor log line `agent env lockdown (<agent>): N kept, M dropped` confirms it at spawn.

**Not airtight.** Everything still runs as the same macOS user: an agent can read `.env` from disk. § 2 catches the plain reads but not one that builds the path in pieces or loads `.env` through the repo's own loader (checked 2026-11-17). The fix is the secrets broker (`docs/secrets-broker.md`), running as its own user and owning the keys. Stage 1, built 2026-11-17, takes the 1Password service-account tokens; the bank feed, database, Slack and iCloud follow.

## 2. The secrets read-guard

`bin/secrets-guard` (logic `lib/secrets-guard.mjs`) is a PreToolUse hook (matcher `Bash|Read|Grep|Glob|Edit|Write`). It is wired into every Jori session that has the git rollback guard, through `lib/rollback-guard-settings.mjs` `gitGuardHooks()` (the supervisors' `--settings`, and the fork launchers through `rollback-guard --settings-json`).

It finds the agent's own tool call reaching:
- any `.env` (not `.env.example` / `.sample` / `.tpl` / `.template`);
- the repo's top-level `secrets/` and `credentials/`;
- `data/.supabase-oauth.json`;
- Claude Code's user config, `~/.claude.json` and its copies (`~/.claude.json.*`, `~/.claude/backups/`);
- 1Password's local config and store;
- gog's keyring and OAuth client file (`~/Library/Application Support/gogcli/keyring`, `credentials.json`; its attachments folder stays readable);
- `op …`;
- `security find-generic-password | find-internet-password | dump-keychain | export`;
- an environment dump (`env`, `printenv`, `export -p`, bare `set`).

It follows `cd`, `bash -c`/`sh -c` and `eval`, like the git guard. It only sees the agent's call, never what a tool does inside its own process, so `bin/site-pass` reading 1Password for the user's auto-login is not touched.

**Modes:** set by `agent-env.json` `guard`, re-read on every call.
- `"log"` (default): allow, and append `LOGGED <tool> in <cwd> :: <kind>:<target>` to `agent/logs/secrets-guard.log`.
- `"block"`: exit 2 with a reason the model reads. An environment dump is still only logged: a locked-down agent's environment holds no secret, and `env | grep PATH` is ordinary debugging.
- `"off"`.

The log names the kind and the matched path or program, never the command line, which can carry a value.

Roll-out: the plan was a week in `log`; the user switched to `block` on 2026-11-16, once every agent was locked down. Playbooks that had the agent source `.env` were moved onto tools that read it themselves (`improvement-plan` → `db-read`, the portfolio quotes → the installation's quotes CLI). The paused marketing playbooks (`mkt-*`) still tell the agent to source `.env` or run `op`; they fail at the guard if unpaused, and need the same move first.

## 3. Tool profiles

Jori's own MCP tool server (`agent/tools-mcp`, ~100+ tools) used to be served whole to every agent and fork: lock and lights control, iMessage and WhatsApp send, Gmail actions. Now each launcher sets `JORI_TOOL_PROFILE` in its MCP config, and the server lists **and serves** only that profile's tools (`agent/tools-mcp/profiles.mjs`).
- A denied tool is gone from the model's context, and a call by name is refused.
- The `homectl` passthrough can be held to read-only commands (`status`, `list`, `snapshot`, `help`, …) or switched off.

Profiles are defined in `agent/config/tool-profiles.json`. An installation overrides or adds one in `agent/local/config/tool-profiles.json`, where a top-level profile replaces the kernel's.

| Profile | Who | What |
|---|---|---|
| `full` | chat (`chat-mcp-config.json`) | everything: the user asks the chat agent for anything |
| `ops` | ops and its forks (the ops cwd's `.mcp.json`, installation-local) | no home actuation (lock, lights, shades, TV, speakers, speech), no caller-id change, no reservation sniping; `homectl` read-only |
| `triage` | ops-light (`ops-light-agent/.mcp.json`) | the `ops` set minus WhatsApp send, Office/Notes writes, `delegate` and `homectl` |
| `watcher` | ops-haiku (`ops-haiku-agent/.mcp.json`) | an allowlist of read tools (wiki, recall, episodes, contacts, location, flights, `check_later`, the notify tool) |

The profiles were drawn from 30 days of real `mcp__tools__*` calls per agent (2026-11-15). Every tool a tier called is in its profile. When a job needs a denied tool, the call fails with a message naming the profile: add it to that profile.

An unset or unknown profile serves everything and warns on stderr (`[tools-mcp] JORI_TOOL_PROFILE is not set`).

`JORI_AGENT_ID` is a separate setting and stays as it is. The ops cwd's `.mcp.json` leaves it unset on purpose. tools-mcp then keys `check_later` to `chat`, and the chat supervisor's ticker is the only one that fires wakes.

**Not a security boundary while the agent has Bash.** `bin/imsg`, `bin/homectl` and `bin/email-send` reach the same actions. A profile takes the tool out of the model's context and its call path. The containment is § 1 and § 2, and later a broker.

**Next (not built):** third-party email triage on a strict toolbox, like the one-shot `email-inbound` server. The separate user-scope `mcp__homectl` server had zero calls from any agent in those 30 days, so it is a candidate for each tier's `disallowed_tools` (`agent/local/config/agents.json`).

## 4. Auto mode (trial)

Claude Code's **auto mode** has a classifier screen each action, in place of `bypassPermissions`, where everything runs. An installation picks a mode per ops tier in `agent/local/config/agents.json` `permission_mode` (`{"ops-haiku": "auto"}`). Allowed values are `bypassPermissions`, `auto`, `dontAsk` and `acceptEdits`; anything else is ignored with a warning. The supervisor reads it at process start (`index.mjs` `loadAgentConfig`), so a change needs that supervisor restarted.

**Probe on the host before the trial (2026-11-16, Claude Code 2.1.319, Haiku, unattended `claude -p`):**
- It works headless: no prompt hangs. A refused action comes back to the model as a denial and is listed in the result's `permission_denials`.
- The agent's broad `--allowedTools Bash …` does not skip the classifier.
- It **refused** `rm -rf` of a scratch directory: a false block.
- It **allowed** an exfiltration-shaped `curl -X POST … --data-binary @/etc/hosts` to an outside host.

So auto mode trims destructive actions, but it is not a defence against data leaving. That remains § 1 and § 2.

**Trial:** ops-haiku runs in auto mode from 2026-11-16 for a week. Review its denials: the `result` events' `permission_denials` in `agent/logs/supervisor-ops-haiku/events.ndjson`, with their count in `timing.ndjson` `turn_summary`. Then decide whether to keep it, widen it to another tier, or revert by deleting the entry and restarting the supervisor.
