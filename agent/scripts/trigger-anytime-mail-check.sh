#!/usr/bin/env bash
set -euo pipefail

# Event-driven, no cron. The installation's Gmail intake hook
# (agent/supervisor/_ext/gmail-intake.mjs) runs this when an Anytime Mailbox
# "new mail" notice lands,
# after touching data/.anytime-mail-kick. It hands the run to the GUI
# session (the Haiku fallback judge is a tool-less claude -p on Max). No sleep
# window: the run sends one chat line, like the P1 ping it replaced.
# A kick while a run is going is a no-op; the run sees the newer kick file and
# goes round again. Playbook: ops-agent/jobs/anytime-mail-check.md
source "$(dirname "$0")/lib/launchd-kick.sh"
launchd_kick ai.claude.anytime-mail-check anytime-mail-check
