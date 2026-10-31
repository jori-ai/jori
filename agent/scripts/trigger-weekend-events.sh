#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger weekend events digest via webhook channel → ops agent
dispatch_or_skip '{"job": "weekend-events"}' weekend-events
