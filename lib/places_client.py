"""places_client — the ONLY way Python in this repo reaches Google Places.

Every request is priced and gated BEFORE it is sent, against one policy
(lib/places-tier-policy.json — read its notes) and one month ledger
(data/places-ledger.json), shared with the Node twin
lib/places-client.js. tests/places-choke-point.test.mjs fails any
other file that names places.googleapis.com.

    from places_client import post, get, PlacesRefused
    data = post("findme", "places:searchNearby", body, mask=FIELD_MASK,
                method="searchNearby", lat=lat, lon=lon, radius=r)
    place = get("places", f"places/{pid}", mask=M, method="details", place_id=pid)

Refusals raise PlacesRefused(code, reason): 3 month blocked by places-budget,
4 tier opt-in/daily cap, 5 month ceiling, 6 cannot verify (wrong host, policy /
ledger / lock unreadable — fail closed). Every refusal and every live call is
logged (places_log). HTTP errors from Google propagate as urllib errors.
"""
import json
import os
import socket
import sys
import time
import urllib.request
from datetime import datetime, timezone

_LIB = os.path.dirname(os.path.abspath(__file__))
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

import places_log  # noqa: E402
import places_guard  # noqa: E402
import places_local  # noqa: E402

BASE_URL = "https://places.googleapis.com/v1/"
DATA = places_local.data_path()


def _ledger_file():
    return os.environ.get("PLACES_LEDGER_FILE") or os.path.join(DATA, "places-ledger.json")


def _state_file():
    return os.environ.get("PLACES_BUDGET_STATE_FILE") or places_guard.STATE_FILE


class PlacesRefused(Exception):
    def __init__(self, code, reason):
        super().__init__(reason)
        self.code = code
        self.reason = reason


def _month():
    now = datetime.now(timezone.utc)
    return f"{now.year}-{now.month:02d}"


def _host():
    return socket.gethostname().split(".")[0]


class _Lock:
    """O_EXCL lock file shared with places-client.js. Stale after 30 s."""
    def __init__(self, path, wait_s=5.0):
        self.path, self.wait_s, self.fd = path + ".lock", wait_s, None

    def __enter__(self):
        deadline = time.time() + self.wait_s
        while True:
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                return self
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(self.path) > 30:
                        os.unlink(self.path)
                        continue
                except FileNotFoundError:
                    continue
                if time.time() > deadline:
                    raise PlacesRefused(6, "Places ledger is locked (another call in flight?) — refusing rather than guessing.")
                time.sleep(0.05)

    def __exit__(self, *exc):
        try:
            os.close(self.fd)
            os.unlink(self.path)
        except Exception:
            pass
        return False


def _read_policy():
    try:
        return places_guard.read_policy()
    except Exception as e:
        raise PlacesRefused(6, f"Places policy unreadable ({e}) — refusing (fail closed).")


def _billed_so_far():
    """places-budget's billed figure and account-pool view for this month, if any."""
    try:
        with open(_state_file()) as f:
            st = json.load(f)
        if st.get("month") != _month():
            return 0.0, {}
        g = (st.get("scopes") or {}).get("jori") or {}
        return float(g.get("spend_usd") or 0), st.get("free_pool_remaining") or {}
    except FileNotFoundError:
        return 0.0, {}
    except Exception as e:
        raise PlacesRefused(6, f"places-budget state unreadable ({e}) — refusing (fail closed).")


def _block_reason():
    """places-budget's monthly block, read from the same state file as the bill."""
    try:
        with open(_state_file()) as f:
            st = json.load(f)
    except FileNotFoundError:
        return None
    except Exception as e:
        raise PlacesRefused(6, f"places-budget state unreadable ({e}) — refusing (fail closed).")
    g = (st.get("scopes") or {}).get("jori") or {}
    if st.get("month") == _month() and (g.get("level") == "blocked" or g.get("manually_blocked")):
        return (f"Jori's Places spend is ${float(g.get('spend_usd') or 0):.2f} this month, over the "
                f"${float(g.get('limit_usd') or 0):.2f} cap. Places calls are stopped.")
    return None


def _read_ledger(path):
    if not os.path.exists(path):
        return {"month": _month(), "skus": {}, "total_usd": 0.0}
    try:
        with open(path) as f:
            led = json.load(f)
    except Exception as e:
        raise PlacesRefused(6, f"Places ledger unreadable ({e}) — refusing (fail closed).")
    if led.get("month") != _month():
        return {"month": _month(), "skus": {}, "total_usd": 0.0, "previous": {"month": led.get("month"), "total_usd": led.get("total_usd")}}
    return led


def call_cost(policy, ledger, pools, sku, price, n=1):
    """Pure: what n more calls of this SKU cost under the ledger's free-pool view."""
    free = int((policy.get("assumed_free_per_month") or {}).get(sku, 0))
    if sku in pools:
        free = min(free, int(pools[sku]))
    used = int(((ledger.get("skus") or {}).get(sku) or {}).get("calls", 0))
    billable = max(0, used + n - max(free, used))
    return round(billable * price, 6)


def preflight(tool, method, tier, n=1, caller=None, ask=None):
    """Every gate, in order. Reserves the cost in the ledger. Returns the reservation."""
    ask = ask or {}
    policy = _read_policy()
    # An empty allowed_hosts means a single-machine installation: any host.
    hosts = policy.get("allowed_hosts") or []
    if hosts and _host() not in hosts:
        raise PlacesRefused(6, f"Places calls are made only from {', '.join(hosts)} (this is {_host()}); "
                               "the spend ledger lives there. Run it there.")
    reason = _block_reason()
    if reason:
        raise PlacesRefused(3, reason)
    # The policy names lanes (--lane / PLACES_LANE), else the tool; a bare
    # hand run of the general-purpose `places` CLI is "untagged".
    caller = caller or os.environ.get("PLACES_LANE") or ("untagged" if tool == "places" else tool)
    if method == "searchText" and tier in places_guard.CAPPED_TIERS:
        # A paid tier always needs an opt-in: a tier missing from the policy
        # means nobody may buy it, never "uncapped".
        caps = (policy.get("daily_live_caps") or {}).get(tier) or {}
        if caller not in caps:
            raise PlacesRefused(4, f"'{caller}' has no opt-in for {tier} text search (lib/places-tier-policy.json). "
                                   "Use a cheaper mask (--lean, or drop --tier rich).")
        used = places_guard._read_counts()["counts"].get(f"{tier}|{caller}", 0)
        if used >= int(caps[caller]):
            raise PlacesRefused(4, f"'{caller}' used its {caps[caller]} {tier} text searches for today (UTC).")
    sku = places_log.sku_for(method, tier) or f"{method}/{tier}"
    price = places_log.price_for(method, tier)
    path = _ledger_file()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with _Lock(path):
        led = _read_ledger(path)
        billed, pools = _billed_so_far()
        cost = call_cost(policy, led, pools, sku, price, n)
        spent = max(float(led.get("total_usd") or 0), billed)
        ceiling = float(policy.get("monthly_ceiling_usd", 0))
        if spent + cost > ceiling:
            raise PlacesRefused(5, f"Places month ceiling: ${spent:.2f} spent (ledger ${led.get('total_usd', 0):.2f}, "
                                   f"bill ${billed:.2f}) + ${cost:.3f} for this call > ${ceiling:.2f}.")
        s = led.setdefault("skus", {}).setdefault(sku, {"calls": 0, "est_usd": 0.0})
        s["calls"] += n
        s["est_usd"] = round(s["est_usd"] + cost, 6)
        led["total_usd"] = round(float(led.get("total_usd") or 0) + cost, 6)
        led["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            json.dump(led, f, indent=1)
        os.replace(tmp, path)
    return {"caller": caller, "sku": sku, "cost": cost}


def _key(api_key):
    k = api_key or os.environ.get("GOOGLE_PLACES_API_KEY")
    if not k:
        try:
            with open(os.path.join(places_local.install_root(), ".env")) as f:
                for line in f:
                    if line.startswith("GOOGLE_PLACES_API_KEY="):
                        k = line.split("=", 1)[1].strip().strip('"').strip("'")
        except Exception:
            pass
    if not k:
        raise PlacesRefused(6, "GOOGLE_PLACES_API_KEY not set")
    return k


def _request(tool, method, path, body, mask, tier, timeout, ask, api_key, caller, http):
    tier = tier or places_log.tier_for_mask(mask)
    try:
        # No key = Places is not set up here: refuse before reserving any cost.
        key = _key(api_key)
        res = preflight(tool, method, tier, caller=caller, ask=ask)
    except PlacesRefused as e:
        places_log.log_call(tool, method, tier=tier, blocked=True, note=f"refused {e.code}: {e.reason}"[:120], **ask)
        raise
    headers = {"X-Goog-Api-Key": key, "X-Goog-FieldMask": mask}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    req = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method=http)
    t0 = time.time()
    status = None
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            out = json.loads(resp.read().decode() or "{}")
        return out
    except urllib.error.HTTPError as e:
        status = e.code
        raise
    finally:
        places_log.log_call(tool, method, tier=tier, status=status, ms=(time.time() - t0) * 1000, **ask)
        places_guard.count_tier_call(res["caller"], tier)


def post(tool, path, body, mask, method, tier=None, timeout=15, api_key=None, caller=None, **ask):
    """POST places:searchText / places:searchNearby through every gate."""
    return _request(tool, method, path, body, mask, tier, timeout, ask, api_key, caller, "POST")


def get(tool, path, mask, method="details", tier=None, timeout=15, api_key=None, caller=None, **ask):
    """GET places/<id> through every gate."""
    return _request(tool, method, path, None, mask, tier, timeout, ask, api_key, caller, "GET")


def refused_exit(e, tool):
    """For CLIs whose whole job is Places: print and exit with the refusal code."""
    print(f"{tool}: {e.reason}", file=sys.stderr)
    sys.exit(e.code)
