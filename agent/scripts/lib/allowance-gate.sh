# allowance-gate.sh — ask the allowance governor (bin/allowance-brake) whether
# a job may start now, and on which model. Sourced by run-ephemeral-opus.sh
# (every heavy fork passes through it) and by the queue-driven triggers that
# must decide BEFORE they claim a request (trigger-chat-build.sh,
# trigger-daily-summary-fix.sh), which then set JORI_BRAKE_DECIDED=1 so the
# runner does not ask a second time.
#
#   allowance_gate <job> [<key>]
#     sets BRAKE_RC     0 run · 3 hold · 4 run on the cheaper model
#          BRAKE_REASON the governor's one-line why
#          BRAKE_MODEL  the full model id to use when BRAKE_RC=4 (else empty)
#          BRAKE_EFFORT the effort to use when BRAKE_RC=4 (may be empty)
#
# Fail-open like the governor itself: any error leaves BRAKE_RC=0.

# Held by the governor: a runner exit that is neither success nor failure.
ALLOWANCE_HELD_RC=75

allowance_gate() {
  local job="$1" key="${2:-}" out
  BRAKE_RC=0; BRAKE_REASON=""; BRAKE_MODEL=""; BRAKE_EFFORT=""
  local brake="${JORI_INSTALL_TOOLS:?}/bin/allowance-brake"
  [ -x "$brake" ] || return 0
  out="$("$brake" check "$job" --json ${key:+--key "$key"} 2>/dev/null)"
  BRAKE_RC=$?
  case "$BRAKE_RC" in 0|3|4) ;; *) BRAKE_RC=0 ;; esac
  # One JSON line; node is on PATH in every caller (the signed ~/.local/node build).
  local fields
  fields="$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write([j.reason||"",j.model||"",j.effort||""].map(x=>String(x).replace(/[\t\n]/g," ")).join("\t"))}catch{}})' 2>/dev/null)"
  IFS=$'\t' read -r BRAKE_REASON BRAKE_MODEL BRAKE_EFFORT <<< "$fields"
  if [ "$BRAKE_RC" -eq 4 ]; then
    [ -n "${JORI_MODEL_SONNET:-}" ] || { [ -f "$JORI_INSTALL_TOOLS/agent/config/models.env" ] && source "$JORI_INSTALL_TOOLS/agent/config/models.env"; }
    # Tier names in the config resolve through agent/config/models.env.
    case "$BRAKE_MODEL" in
      sonnet) BRAKE_MODEL="${JORI_MODEL_SONNET:-}" ;;
      opus)   BRAKE_MODEL="${JORI_MODEL_OPUS:-}" ;;
      haiku)  BRAKE_MODEL="${JORI_MODEL_HAIKU:-}" ;;
    esac
    # No usable model id: run as usual rather than guess one.
    [ -n "$BRAKE_MODEL" ] || BRAKE_RC=0
  fi
  return 0
}
