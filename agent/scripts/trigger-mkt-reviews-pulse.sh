#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger daily mkt-reviews-pulse job — Apple RSS poll for new App Store reviews of the app, per storefront.
dispatch_or_skip '{"job": "mkt-reviews-pulse"}' mkt-reviews-pulse
