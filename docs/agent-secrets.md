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
- `GOG_KEYRING_PASSWORD`: `gog` is an external binary that only reads its keyring password from its environment, and agents run it directly. **This is a documented remainder** until gog gets a shim that reads `.env`.
- Anything in the installation's `keep` list.

Everything else (PATH, HOME, the Claude Code settings variables, the supervisor's own non-secret variables) passes unchanged.

**Spawn sites wired:**
- `agent/supervisor/claude-session.mjs`, the four supervisors' sessions (`agentEnvId` = the agents.json id).
- `agent/scripts/lib/run-ephemeral-opus.sh` and `run-ephemeral-fable.sh`, every Opus/Fable fork (`agent-env.sh` `jori_agent_env_cmd forks` → `env -i …`). The runner still sources `.env` for its own needs; only `claude` gets the filtered set.

**Not yet wired (they inherit the full environment):**
- Tool-less or strict one-shots: `stateless-executor`, `email-inbound-run`, `agent-oneshot`, `family-qa`, `speak-gate`, `local-llm`. They have no Bash, so the model cannot read the environment.
- `bin/findme`, `bin/daily-summary-run` and `bin/finance-review-run`, which launch `claude -p` themselves.

**Tools read their own secrets.** A program that needs a key loads `.env` itself: `lib/load-env.js` `loadEnv()` (Node; many libs call it at import, e.g. `plaid-api.js`, `supabase-rest.js`), `lib/supabase_local.py` `env_value()` (Python), or a `sed -n 's/^NAME=//p' .env` fallback (bash; `site-pass`, `card-pass`, `dev-pass`, `supabase-mcp`). The tools MCP server loads `.env` at start, so the CLIs it runs (`gog`, `homectl`, `imsg`) have what they need. A new tool that reads a secret must do the same: never rely on the agent's environment.

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

**Not airtight.** Everything still runs as the same macOS user: an agent can read `.env` from disk. § 2 notices and then blocks that. A broker running under its own user, owning the secrets and talking only to each key's own site, is the follow-up (Step B, largest-risk keys first: the 1Password service-account tokens, then the bank feed, database, Slack, iCloud).

## 2. The secrets read-guard

`bin/secrets-guard` (logic `lib/secrets-guard.mjs`) is a PreToolUse hook (matcher `Bash|Read|Grep|Glob|Edit|Write`). It is wired into every Jori session that has the git rollback guard, through `lib/rollback-guard-settings.mjs` `gitGuardHooks()` (the supervisors' `--settings`, and the fork launchers through `rollback-guard --settings-json`).

It finds the agent's own tool call reaching:
- any `.env` (not `.env.example` / `.sample` / `.tpl` / `.template`);
- the repo's top-level `secrets/` and `credentials/`;
- `data/.supabase-oauth.json`;
- 1Password's local config and store;
- `op …`;
- `security find-generic-password | find-internet-password | dump-keychain | export`;
- an environment dump (`env`, `printenv`, `export -p`, bare `set`).

It follows `cd`, `bash -c`/`sh -c` and `eval`, like the git guard. It only sees the agent's call, never what a tool does inside its own process, so `bin/site-pass` reading 1Password for the user's auto-login is not touched.

**Modes:** set by `agent-env.json` `guard`, re-read on every call.
- `"log"` (default): allow, and append `LOGGED <tool> in <cwd> :: <kind>:<target>` to `agent/logs/secrets-guard.log`.
- `"block"`: exit 2 with a reason the model reads.
- `"off"`.

The log names the kind and the matched path or program, never the command line, which can carry a value.

Roll-out: a week in `log`; read the log; move what legitimately needs a secret into a tool; then `block`.

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
