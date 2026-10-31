#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger mkt-aso-baseline job — weekly snapshot of the app's + competitors' store metadata (iOS + Android).
# Off without agent/local/config/marketing.json (the playbook exits silent).
dispatch_or_skip '{"job": "mkt-aso-baseline"}' mkt-aso-baseline
