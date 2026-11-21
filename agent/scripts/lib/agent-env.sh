#!/bin/bash
# agent-env.sh — start a fork's `claude` with the agent environment, not the
# runner's (the runner sources all of .env for its own needs).
#
#   source agent-env.sh
#   jori_agent_env_cmd forks
#   ${AGENT_ENV_CMD[@]+"${AGENT_ENV_CMD[@]}"} "$CLAUDE" -p …
#
# Sets the array AGENT_ENV_CMD to `env -i NAME=VALUE …` (the filtered set from
# lib/agent-env.cjs) when the installation locks the agent down
# (agent/local/config/agent-env.json `lockdown`), and to an empty array
# otherwise, so the command inherits the runner's environment exactly as
# before. Fails open: if node or the library is unavailable the array stays
# empty and the run proceeds unchanged. Never prints a value.
# Design: docs/agent-secrets.md.

jori_agent_env_cmd() {
  AGENT_ENV_CMD=()
  local agent="${1:-forks}" kv lib
  local -a kept=()
  lib="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/lib/agent-env.cjs"
  [ -f "$lib" ] || return 0
  while IFS= read -r -d '' kv; do kept+=("$kv"); done < <("${JORI_NODE:-node}" "$lib" --agent "$agent" --print0 2>/dev/null)
  if [ "${#kept[@]}" -gt 0 ]; then
    AGENT_ENV_CMD=(env -i "${kept[@]}")
  fi
  return 0
}
