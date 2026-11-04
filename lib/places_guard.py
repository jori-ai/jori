"""The jori-side half of `places-budget`, for the Python Places callers.

Mirrors lib/places-guard.js exactly — see that file for why the state is
read directly rather than by shelling out. Kept dependency-free and importable
from a venv interpreter (findme runs under its own), so it does nothing at
import time beyond defining two functions.
"""

import json
import os
import sys
from datetime import datetime, timezone

_LIB = os.path.dirname(os.path.abspath(__file__))
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)
import places_local  # noqa: E402

STATE_FILE = places_local.data_path("places-budget-state.json")
# The places-budget scope that meters this installation's own Places calls
# (the same key lib/places_client.py reads).
SCOPE = "jori"


def _state_file():
    return os.environ.get("PLACES_BUDGET_STATE_FILE") or STATE_FILE


def _month_key():
    now = datetime.now(timezone.utc)
    return f"{now.year}-{now.month:02d}"


def places_block_reason():
    """None when allowed, else a human-readable reason."""
    try:
        with open(_state_file()) as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        return None  # no meter yet — never block on absence of information

    # A state file from last month tells us nothing about this month's budget.
    if state.get("month") != _month_key():
        return None
    scope = (state.get("scopes") or {}).get(SCOPE)
    if not scope or scope.get("level") != "blocked":
        return None
    return (
        f"Jori's Places API spend is ${float(scope['spend_usd']):.2f} this month, "
        f"over the ${float(scope['limit_usd']):.2f} cap. Places calls are stopped.\n"
        f"Lift with: places-budget unblock {SCOPE}"
    )


def assert_places_allowed(tool_name, method="unknown", **ask):
    """Exit 3 when blocked — the agreed 'stopped on budget' code, distinct from 1.

    A refused call is logged (blocked: true) with what it asked for, so the
    call log still shows demand while the cap is on — Oct 13-20 2026 logged
    nothing at all. `ask` takes places_log.log_call's mask/tier/query/lat/lon/
    radius/place_id/lane."""
    reason = places_block_reason()
    if reason is None:
        return
    try:
        from places_log import log_call
        log_call(tool_name, method, blocked=True, **ask)
    except Exception:
        pass
    print(f"{tool_name}: {reason}", file=sys.stderr)
    sys.exit(3)


# ── Per-caller tier caps (2026-10-20) ────────────────────────────────────────
# lib/places-tier-policy.json says which caller may buy Enterprise or
# Enterprise + Atmosphere on a text search, and how many live calls a day.
# Mirrors lib/places-guard.js; same files, same exit code (4).

POLICY_FILE = os.path.join(_LIB, "places-tier-policy.json")
COUNTS_FILE = places_local.data_path(".cache", "places-tier-counts.json")


def merge_policy(base, local):
    """Twin of places-guard.js mergePolicy: scalars and lists replace;
    assumed_free_per_month and each daily_live_caps tier merge key by key."""
    out = dict(base)
    for k, v in (local or {}).items():
        if k == "assumed_free_per_month":
            out[k] = {**(base.get(k) or {}), **(v or {})}
        elif k == "daily_live_caps":
            caps = {t: dict(c) for t, c in (base.get(k) or {}).items()}
            for tier, c in (v or {}).items():
                caps[tier] = {**caps.get(tier, {}), **(c or {})}
            out[k] = caps
        else:
            out[k] = v
    return out


def read_policy():
    """The effective policy: lib/places-tier-policy.json (generic defaults) with
    agent/local/config/places-tier-policy.json merged over it.
    PLACES_POLICY_FILE (tests) is used alone. Raises when unreadable."""
    env = os.environ.get("PLACES_POLICY_FILE")
    if env:
        with open(env) as f:
            return json.load(f)
    with open(POLICY_FILE) as f:
        base = json.load(f)
    return merge_policy(base, places_local.local_config("places-tier-policy", {}))
CAPPED_TIERS = ("enterprise", "enterprise_atmosphere")


def _utc_day():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _counts_file():
    return os.environ.get("PLACES_TIER_COUNTS_FILE") or COUNTS_FILE


def _read_counts(path=None):
    try:
        with open(path or _counts_file()) as f:
            c = json.load(f)
        if c.get("day") == _utc_day():
            return c
    except Exception:
        pass
    return {"day": _utc_day(), "counts": {}}


def tier_cap_reason(caller, tier, policy_file=None, counts_file=None):
    """None when this caller may make one more live call at this tier today."""
    if tier not in CAPPED_TIERS:
        return None
    try:
        if policy_file:
            with open(policy_file) as f:
                pol = json.load(f)
        else:
            pol = read_policy()
        caps = pol.get("daily_live_caps", {}).get(tier, {})
    except Exception:
        return None  # no policy file — never block on absence of information
    caller = caller or "untagged"
    if caller not in caps:
        return (f"'{caller}' has no opt-in for {tier} text search "
                f"(lib/places-tier-policy.json). Use a cheaper mask (--lean, or drop --tier rich).")
    used = _read_counts(counts_file)["counts"].get(f"{tier}|{caller}", 0)
    if used >= int(caps[caller]):
        return f"'{caller}' used its {caps[caller]} {tier} text searches for today ({_utc_day()} UTC)."
    return None


def count_tier_call(caller, tier, counts_file=None):
    """Record one live call. Best effort; a lost increment only loosens the cap."""
    if tier not in CAPPED_TIERS:
        return
    path = counts_file or _counts_file()
    try:
        c = _read_counts(path)
        k = f"{tier}|{caller or 'untagged'}"
        c["counts"][k] = c["counts"].get(k, 0) + 1
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            json.dump(c, f)
        os.replace(tmp, path)
    except Exception:
        pass


def assert_tier_allowed(tool_name, caller, tier, method="searchText", **ask):
    """Exit 4 (tier cap, distinct from 3 = monthly budget) and log the refusal."""
    reason = tier_cap_reason(caller, tier)
    if reason is None:
        return
    try:
        from places_log import log_call
        log_call(tool_name, method, tier=tier, blocked=True, note=f"tier-cap: {reason}"[:120], **ask)
    except Exception:
        pass
    print(f"{tool_name}: {reason}", file=sys.stderr)
    sys.exit(4)
