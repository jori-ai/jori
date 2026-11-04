"""places_log — the Python half of lib/places-log.js. Same file, same
line shape, same rule: logging never fails the call.

    from places_log import log_call, tier_for_mask
    log_call("findme", "searchNearby", mask=FIELD_MASK, status=200, ms=180)
    log_call("findme", "searchNearby", cached=True)           # served locally
    log_call("places", "searchText", mask=M, lane="hum-nearby")  # which lane asked
    log_call("places", "photoUrlIssued", n=len(photos))       # key-bearing URLs handed out

See the JS file for why this exists (2026-09-10: $27 of photo fetches on our
key that no tool in this repo made) and what each field means — including the
2026-10-20 audit fields (job/chain/tick/hum_lane/session/caller, query and
position, sku, est_usd, blocked).
"""
import json
import os
import re
import socket
import subprocess
import sys
import time

# PLACES_LOG_FILE redirects the log (tests, one-off audits); production never sets it.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import places_local  # noqa: E402

LOG_FILE = os.environ.get("PLACES_LOG_FILE") or places_local.data_path("logs", "places-calls.jsonl")

PRO_FIELDS = {
    "displayName", "formattedAddress", "photos", "primaryType", "primaryTypeDisplayName",
    "addressComponents", "adrFormatAddress", "businessStatus", "containingPlaces", "googleMapsUri",
    "iconBackgroundColor", "iconMaskBaseUri", "plusCode", "postalAddress", "shortFormattedAddress",
    "subDestinations", "utcOffsetMinutes", "viewport", "accessibilityOptions", "googleMapsLinks",
}
ENTERPRISE_FIELDS = {
    "rating", "userRatingCount", "priceLevel", "priceRange", "currentOpeningHours",
    "currentSecondaryOpeningHours", "regularOpeningHours", "regularSecondaryOpeningHours",
    "internationalPhoneNumber", "nationalPhoneNumber", "websiteUri",
}
ATMOSPHERE_FIELDS = {
    "allowsDogs", "curbsidePickup", "delivery", "dineIn", "editorialSummary", "evChargeOptions",
    "fuelOptions", "goodForChildren", "goodForGroups", "goodForWatchingSports", "liveMusic",
    "menuForChildren", "parkingOptions", "paymentOptions", "outdoorSeating", "reservable",
    "restroom", "reviews", "reviewSummary", "generativeSummary", "servesBeer", "servesBreakfast",
    "servesBrunch", "servesCocktails", "servesCoffee", "servesDessert", "servesDinner",
    "servesLunch", "servesVegetarianFood", "servesWine", "takeout", "neighborhoodSummary",
}


def _load_prices():
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "places-prices.json")) as f:
            return json.load(f)
    except Exception:
        return {"per_1000_usd": {}, "sku_method": {}, "sku_tier": {}}


PRICES = _load_prices()


def price_for(method, tier):
    """List price of ONE billable request (lib/places-prices.json)."""
    per1000 = (PRICES.get("per_1000_usd", {}).get(method) or {}).get(tier)
    return (per1000 / 1000.0) if isinstance(per1000, (int, float)) else 0.0


def sku_for(method, tier):
    m = PRICES.get("sku_method", {}).get(method)
    if not m:
        return None
    if method == "photoMedia":
        return f"Places API {m}"
    t = PRICES.get("sku_tier", {}).get(tier)
    return f"Places API {m} {t}" if t else f"Places API {m}"


_INTERPRETERS = {"node", "python", "python3", "bash", "sh", "zsh", "env", "npx", "npm"}


def _proc_name(command):
    # A token carrying "=" is an env assignment or flag value (KEY=secret): never recorded.
    toks = [t for t in str(command or "").split() if "=" not in t]
    exe = os.path.basename(toks[0] if toks else "")[:40]
    if exe not in _INTERPRETERS and re.sub(r"[0-9.]+$", "", exe) not in _INTERPRETERS:
        return exe
    script = next((t for t in toks[1:] if not t.startswith("-")), None)
    return f"{exe} {os.path.basename(script)[:40]}" if script else exe


def chain_from_ps(ps_out, pid, depth=5):
    """Pure: process ancestry as basenames from `ps -A -o pid=,ppid=,command=`.
    Arguments are never recorded — on the mini they include API keys."""
    procs = {}
    for line in str(ps_out).splitlines():
        m = re.match(r"^\s*(\d+)\s+(\d+)\s+(.*)$", line)
        if m:
            procs[int(m.group(1))] = (int(m.group(2)), m.group(3))
    names, cur = [], int(pid)
    for _ in range(depth):
        if cur <= 1 or cur not in procs:
            break
        ppid, cmd = procs[cur]
        name = _proc_name(cmd)
        if re.match(r"^(launchd|cron|sshd.*|login)$", name):
            break
        if not names or names[-1] != name:
            names.append(name)
        cur = ppid
    return " < ".join(names)[:240] if names else None


_CALLER = []


def caller_chain():
    if not _CALLER:
        try:
            out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,command="], capture_output=True,
                                 text=True, timeout=2).stdout
            _CALLER.append(chain_from_ps(out, os.getpid()))
        except Exception:
            _CALLER.append(None)
    return _CALLER[0]


def call_context(env=None):
    """Who is calling, from what cron-run / hum / Claude Code put in the environment."""
    env = os.environ if env is None else env
    ctx = {}
    if env.get("JORI_JOB"):
        ctx["job"] = env["JORI_JOB"][:60]
    if env.get("JORI_JOB_CHAIN") and env.get("JORI_JOB_CHAIN") != env.get("JORI_JOB"):
        ctx["chain"] = env["JORI_JOB_CHAIN"][:160]
    if env.get("HUM_TICK_ID"):
        ctx["tick"] = env["HUM_TICK_ID"][:40]
    if env.get("HUM_LANE"):
        ctx["hum_lane"] = env["HUM_LANE"][:40]
    if env.get("CLAUDE_CODE_SESSION_ID"):
        ctx["session"] = env["CLAUDE_CODE_SESSION_ID"][:60]
    return ctx


def tier_for_mask(mask):
    fields = [f.strip().removeprefix("places.") for f in str(mask or "").split(",") if f.strip()]
    if any(f in ATMOSPHERE_FIELDS for f in fields):
        return "enterprise_atmosphere"
    if any(f in ENTERPRISE_FIELDS for f in fields):
        return "enterprise"
    if any(f in PRO_FIELDS for f in fields):
        return "pro"
    return "essentials"


def log_call(tool, method, mask=None, tier=None, cached=False, status=None, ms=None, n=1, note=None,
             lane=None, query=None, lat=None, lon=None, radius=None, place_id=None, blocked=False):
    try:
        if tier is None:
            if mask:
                tier = tier_for_mask(mask)
            elif method in ("photoMedia", "photoUrlIssued"):
                tier = "photo"
            else:
                tier = "essentials"
        line = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z",
            "host": socket.gethostname().split(".")[0],
            "tool": tool or "unknown",
            "method": method or "unknown",
            "tier": tier,
            "cached": bool(cached),
            "status": status,
            "ms": None if ms is None else int(round(ms)),
            "n": int(n) if isinstance(n, (int, float)) else 1,
        }
        billed = not cached and not blocked and method != "photoUrlIssued"
        if blocked:
            line["blocked"] = True
        sku = sku_for(method, tier)
        if sku:
            line["sku"] = sku
        line["est_usd"] = round(price_for(method, tier) * line["n"], 4) if billed else 0
        if query is not None:
            line["query"] = str(query)[:120]
        if lat is not None and lon is not None:
            try:
                line["lat"], line["lon"] = round(float(lat), 4), round(float(lon), 4)
            except (TypeError, ValueError):
                pass
        if radius is not None:
            line["radius"] = radius
        if place_id:
            line["place_id"] = str(place_id)[:80]
        line.update(call_context())
        chain = caller_chain()
        if chain:
            line["caller"] = chain
        # Which lane asked (hum-nearby, hum-excursion, ...). The call log named the
        # tool but not the lane, so the 2026-10 audit had to infer it from burst
        # shapes. PLACES_LANE lets a wrapper tag every call a child process makes.
        lane = lane or os.environ.get("PLACES_LANE")
        if lane:
            line["lane"] = str(lane)[:40]
        if note:
            line["note"] = str(note)[:120]
        log_file = os.environ.get("PLACES_LOG_FILE") or LOG_FILE
        os.makedirs(os.path.dirname(log_file), exist_ok=True)
        with open(log_file, "a") as f:
            f.write(json.dumps(line) + "\n")
    except Exception:
        pass


class timed:
    """`with timed() as t: ...; t.ms` — elapsed milliseconds for the log line."""
    def __enter__(self):
        self._t0 = time.time()
        self.ms = None
        return self

    def __exit__(self, *exc):
        self.ms = (time.time() - self._t0) * 1000.0
        return False


if __name__ == "__main__":
    print(tier_for_mask(" ".join(sys.argv[1:])))
