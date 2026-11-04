#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger mkt-aso-search-terms — weekly ASA search-terms pull (dormant until ASA is configured).
dispatch_or_skip '{"job": "mkt-aso-search-terms"}' mkt-aso-search-terms
