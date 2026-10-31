#!/bin/bash
# run-ephemeral-fable.sh — run one job as a dedicated, ephemeral Fable 5 agent.
#
# Sibling of run-ephemeral-opus.sh (read its header for the full WHY — the
# launchd-not-cron keychain rule, the stdin-prompt rule, the auth/empty guard —
# all inherited verbatim). This variant exists for long-horizon reasoning jobs
# (e.g. a multi-agent council) that should run on claude-fable-5, the strongest
# tier on the Max subscription — above Opus.
#
# Differences from the opus launcher, and nothing else:
#   - default --model claude-fable-5, overridable with --model (so a council
#     run can be dropped to claude-opus-5 in one place if Fable is ever
#     unavailable on the Max plan — verify with:
#     `claude -p --model claude-fable-5 "say OK"` in a GUI session).
#   - guard alert text names the council, not the improvement pass.
#
# MUST BE LAUNCHED BY LAUNCHD (GUI session), NOT CRON — cron cannot unlock the
# keychain-stored Max credentials ("Not logged in", exit 0, silent miss).
#
# Usage:
#   run-ephemeral-fable.sh <job-name> <job-md-path> [--task "<opening line>"]
#                          [--timeout-min <n>] [--model <model-id>]

set -uo pipefail

export PATH="/opt/homebrew/bin:$PATH"
CLAUDE="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
source "$(dirname "${BASH_SOURCE[0]}")/root.sh"   # JORI_INSTALL, JORI_INSTALL_TOOLS
ROOT="$JORI_INSTALL"
CWD="$JORI_INSTALL_TOOLS/agent/ops-agent"
ENV_FILE="$JORI_INSTALL_TOOLS/.env"
LOGDIR="$JORI_INSTALL_TOOLS/agent/logs"

JOB="${1:-}"; JOB_MD="${2:-}"; shift 2 2>/dev/null || true
TASK=""
TIMEOUT_MIN=0
MODEL="claude-fable-5"
while [ $# -gt 0 ]; do
  case "$1" in
    --task)        TASK="${2:-}"; shift 2 ;;
    --timeout-min) TIMEOUT_MIN="${2:-0}"; shift 2 ;;
    --model)       MODEL="${2:-claude-fable-5}"; shift 2 ;;
    *)             shift ;;
  esac
done

if [ -z "$JOB" ] || [ -z "$JOB_MD" ]; then
  echo "usage: run-ephemeral-fable.sh <job-name> <job-md-path> [--task \"...\"] [--timeout-min <n>] [--model <id>]" >&2
  exit 64
fi

LOG="$LOGDIR/$JOB.log"
mkdir -p "$LOGDIR"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$JOB] $1" >> "$LOG"; }

if [ ! -f "$JOB_MD" ]; then
  log "ERROR: job file missing: $JOB_MD"
  exit 1
fi

# MCP service secrets, then force the Max session — never the metered API.
if [ -f "$ENV_FILE" ]; then set -a; source "$ENV_FILE"; set +a; fi
# Max-only (2026-10-06): scrub every variable that can move Claude Code off the
# subscription (provider switches, tokens, a base URL `auth status` can't see),
# then refuse to start unless `claude auth status` reports Max via claude.ai.
# Costs no model call. See lib/max-auth-guard.sh.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/max-auth-guard.sh"
# The instance's own rules (agent/local/): the playbook's local companion
# and the shared + role rules the cwd's CLAUDE.md files stand for. See
# lib/local-rules.sh.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/local-rules.sh"
# How the refusal names this machine: the instance host_label (lib/instance.sh).
[ -n "${JORI_HOST_LABEL:-}" ] || source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/instance.sh"
max_auth_scrub
if ! max_auth_check "$CLAUDE"; then
  # Hand-run over SSH: the keychain is out of reach, not Max. Refuse the same
  # way but page nobody — stops a false "⚠️ $JOB refused to start" alert.
  if max_auth_from_ssh; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$JOB] REFUSED: not on the Max subscription ($MAX_AUTH_SUMMARY) (SSH session; not paged)" >> "$LOG"
    {
      echo "$JOB: refused to start from an SSH session. An SSH shell cannot reach the Max login in ${JORI_HOST_LABEL:-the host}'s keychain, so \`claude auth status\` reads as signed out. Nothing ran, nothing was billed, nobody was paged."
      echo "Start it through its launchd agent instead, e.g.: launchctl kickstart gui/\$(id -u)/ai.claude.$JOB"
    } >&2
  elif max_auth_outage_owned_by_watchdog; then
    # A confirmed Max sign-in outage: watchdog.sh's 🔴 page already asked for
    # the /login, so log the refusal and page nobody — stops the duplicate
    # "⚠️ $JOB refused to start" rows.
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$JOB] REFUSED: not on the Max subscription ($MAX_AUTH_SUMMARY) (confirmed Max sign-in outage — watchdog.sh owns that page; not paged)" >> "$LOG"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$JOB] REFUSED: not on the Max subscription ($MAX_AUTH_SUMMARY)" >> "$LOG"
    "$JORI_INSTALL_TOOLS/bin/jori-send-curl" --skip-precheck --channel system --observed-error "$MAX_AUTH_SUMMARY" \
      "⚠️ $JOB refused to start: this run's \`claude auth status\` was not the Max subscription ($MAX_AUTH_SUMMARY), and these runs use nothing else. Nothing ran and nothing was billed. Remedy: sign Claude Code in to the Max account from a GUI session on ${JORI_HOST_LABEL:-the host}." >> "$LOG" 2>&1 || true
  fi
  exit "$MAX_AUTH_REFUSED_RC"
fi

OUT_TMP="$(mktemp -t "$JOB")"
# Set by the turn-cap subshell below, read by the RC>128 branch after `wait` —
# a separate process cannot hand the parent a variable, and a bare signal number
# cannot tell our own cap firing from an operator's kill. Same shape as
# run-ephemeral-opus.sh.
TIMEOUT_MARKER="$OUT_TMP.timeout"
rm -f "$TIMEOUT_MARKER"
log "start (ephemeral $MODEL, xhigh${TIMEOUT_MIN:+, ${TIMEOUT_MIN}m cap})"

# Connector deny (cost-efficiency-review): the same list as
# run-ephemeral-opus.sh, from lib/fork-connector-deny.sh. A council-style caller
# that needs a denied server sets FORK_DISALLOWED_TOOLS itself;
# FORK_DISALLOWED_TOOLS="" turns it off.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fork-connector-deny.sh"
FORK_DISALLOWED_TOOLS="${FORK_DISALLOWED_TOOLS-${JORI_FORK_CONNECTOR_DENY-}}"
# The git-rollback guard hook (D2), as this run's only --settings.
FORK_GUARD_SETTINGS="$(jori_fork_settings "")"

# Prompt = task line + the playbook (claude -p reads the prompt from stdin).
{ [ -n "$TASK" ] && printf '%s\n\n' "$TASK"; jori_job_prompt "$JOB_MD"; } > "$OUT_TMP.prompt"
# + the local rules as --append-system-prompt-file (what the supervisors pass
# their own sessions); none when the cwd loads no Jori CLAUDE.md.
LOCAL_RULES_FILE="$OUT_TMP.local-rules"
jori_local_rules_file "$(jori_local_rules_role "$CWD")" "$LOCAL_RULES_FILE" || LOCAL_RULES_FILE=""

cd "$CWD" || { rm -f "$OUT_TMP.prompt" "$OUT_TMP.local-rules"; exit 1; }
"$CLAUDE" -p \
  --model "$MODEL" \
  --effort xhigh \
  --permission-mode bypassPermissions \
  ${FORK_DISALLOWED_TOOLS:+--disallowedTools $FORK_DISALLOWED_TOOLS} \
  ${FORK_GUARD_SETTINGS:+--settings "$FORK_GUARD_SETTINGS"} \
  ${LOCAL_RULES_FILE:+--append-system-prompt-file "$LOCAL_RULES_FILE"} \
  --add-dir "$ROOT" < "$OUT_TMP.prompt" > "$OUT_TMP" 2>&1 &
CLAUDE_PID=$!

# Turn cap — no supervisor watchdog exists for an ephemeral fork, and the mini
# has neither `timeout` nor `gtimeout`.
if [ "$TIMEOUT_MIN" -gt 0 ] 2>/dev/null; then
  ( sleep $((TIMEOUT_MIN * 60))
    if kill -0 "$CLAUDE_PID" 2>/dev/null; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') [$JOB] TIMEOUT after ${TIMEOUT_MIN}m — killing $CLAUDE_PID" >> "$LOG"
      # Leave the marker BEFORE the kill, so the parent can never wake from
      # `wait` to a signal death it cannot explain.
      printf 'TIMEOUT after %sm — killing %s\n' "$TIMEOUT_MIN" "$CLAUDE_PID" > "$TIMEOUT_MARKER"
      kill -TERM "$CLAUDE_PID" 2>/dev/null
      sleep 10
      kill -KILL "$CLAUDE_PID" 2>/dev/null
    fi ) &
  WATCHDOG_PID=$!
fi

wait "$CLAUDE_PID"
RC=$?
[ -n "${WATCHDOG_PID:-}" ] && kill "$WATCHDOG_PID" 2>/dev/null
rm -f "$OUT_TMP.prompt" "$OUT_TMP.local-rules"
cat "$OUT_TMP" >> "$LOG"

# A KILLED RUN IS NOT AN AUTH FAILURE — this branch must stay ABOVE the
# auth/empty guard, because the ordering IS the fix
# (ported verbatim from run-ephemeral-opus.sh, which is where it was observed
# firing, and modelled on bin/daily-summary-run's killed-run branch).
#
# Bash reports a signal death as 128+signal, and RC was captured above and then
# never consulted. A SIGTERM'd `claude -p` has written NOTHING to $OUT_TMP — it
# emits its output at the end — so the kill fell straight through to the guard's
# `[ -s "$f" ] || return 0` empty-output arm and was paged as auth. The opus
# sibling did this live on 2026-09-27 (TIMEOUT logged at 05:12:01, "guard:
# auth/empty run" at 05:12:12); this file has the same kill path and the same
# guard, so it has only been lucky. Two harms: the remedy the wording implies
# (re-login) is the wrong action, and a habitual cap overrun can never form its
# own alert cluster while every occurrence is mislabelled as an auth outage.
if (( RC > 128 )); then
  SIG=$((RC - 128))
  if [ -f "$TIMEOUT_MARKER" ]; then
    # Our own cap fired — attested with the line the watchdog actually wrote.
    OBSERVED="$(head -n1 "$TIMEOUT_MARKER" | cut -c1-120)"
    WHAT="hit its own ${TIMEOUT_MIN}m cap and was killed (signal $SIG)"
    LOGGED="killed by signal $SIG — its own ${TIMEOUT_MIN}m cap"
  else
    # Something else killed it; the only thing observed is what `wait` returned.
    OBSERVED="exit status $RC from wait — killed by signal $SIG"
    WHAT="was killed by signal $SIG"
    LOGGED="killed by signal $SIG"
  fi
  # Wording scoped to THIS INVOCATION, same discipline as the auth/empty send
  # below (full rationale in run-ephemeral-opus.sh): this process knows the fork
  # it launched was interrupted, never the job's final outcome — no "did NOT run"
  # / "was NOT generated". One run of one process, so no machine-wide claim for
  # the fabricated-outage gate to catch, and --observed-error carries text this
  # script really captured, which is what the mechanism-attestation gate wants.
  "$JORI_INSTALL_TOOLS/bin/jori-send-curl" --skip-precheck --channel system --observed-error "$OBSERVED" \
    "⚠️ $JOB $WHAT — interrupted, not an auth failure, so re-login is not the remedy. Nothing was produced by this invocation; if this was the scheduled run, the council phase is missing." >> "$LOG" 2>&1 || true
  log "exit 1 (guard: $LOGGED)"
  rm -f "$OUT_TMP" "$TIMEOUT_MARKER"
  exit 1
fi

# Auth/empty guard — scoped to the first few lines, same reasoning (and same
# false-positive scar tissue) as run-ephemeral-opus.sh. A keychain-locked run
# is one error line in ~2s; a real pass that merely QUOTES auth text is a pass.
AUTH_FAIL_RE='not logged in|please run /login|invalid (api )?key|authentication_error|unauthorized|failed to authenticate|token has been revoked|oauth session expired'
AUTH_MAX_OUTPUT_LINES=3

auth_or_empty_run() {
  local f="$1"
  [ -s "$f" ] || return 0
  [ "$(wc -l < "$f")" -le "$AUTH_MAX_OUTPUT_LINES" ] || return 1
  grep -qiE "$AUTH_FAIL_RE" "$f"
}

if auth_or_empty_run "$OUT_TMP"; then
  FIRST="$(head -n1 "$OUT_TMP" | cut -c1-120)"
  # Wording scoped to THIS invocation on purpose — see the long note above the
  # identical send in run-ephemeral-opus.sh. This process knows only that the
  # `claude -p` it launched produced nothing; it cannot tell a hand run from the
  # scheduled one, and a later retry can always falsify a claim about the job's
  # final state. Do not restore "did NOT run" / "was NOT generated".
  "$JORI_INSTALL_TOOLS/bin/jori-send-curl" --skip-precheck --channel system --observed-error "$FIRST" \
    "⚠️ $JOB exited without producing output — auth/empty (\"${FIRST}\"). Nothing was generated by this invocation; if this was the scheduled run, the council phase is missing." >> "$LOG" 2>&1 || true
  log "exit 1 (guard: auth/empty run)"
  rm -f "$OUT_TMP" "$TIMEOUT_MARKER"
  exit 1
fi

rm -f "$OUT_TMP" "$TIMEOUT_MARKER"
log "exit $RC"
exit $RC
