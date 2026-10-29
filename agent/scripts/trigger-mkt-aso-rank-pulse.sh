#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger mkt-aso-rank-pulse — daily rank pulse for the app across its target keywords × locales × 2 stores.
dispatch_or_skip '{"job": "mkt-aso-rank-pulse"}' mkt-aso-rank-pulse
