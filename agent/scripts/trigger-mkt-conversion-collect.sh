#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Daily — assemble the paid-ads → download conversion funnel from upstream
# collector state (after the Reddit-ads monitor + mkt-metrics-collect, before
# the ideation and digest jobs). Off without agent/local/config/marketing.json.
dispatch_or_skip '{"job": "mkt-conversion-collect"}' mkt-conversion-collect
