"""overpass_client — one Overpass POST across the shared mirror list.

Mirrors live in lib/overpass-endpoints.json (also read by
day-excursions.js, which keeps the same health file). Resilience, in order:

- Sticky: the mirror that answered last is tried first, so a dead primary
  costs nothing once another mirror has answered.
- Backoff: a failed mirror is skipped for a window that doubles with each
  consecutive failure (2 min → `skip_failed_max_min`). A refused connection
  starts at `skip_refused_min`, because a server refusing outright is down,
  not busy. One success clears the mirror's record.
- Deadline: `timeout_s` bounds the WHOLE call. Each mirror gets at most
  `per_mirror_s`, so a mirror that hangs cannot use up the time the next
  one needs. (A 90 s per-mirror timeout over five mirrors is how a single
  OSM place lookup once hung for minutes.)
- Last resort: if every mirror is in backoff, all of them are tried anyway.
  The caller's own stale cache is the fallback after that.
- Visibility: `_last_success` / `_all_failed_since` in the health file feed the
  watchdog's "OpenStreetMap lookups failing" check, and every failure is
  appended to data/overpass-log.jsonl.
"""
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import places_local  # noqa: E402

_CONFIG = os.path.join(_HERE, "overpass-endpoints.json")
_DATA = places_local.data_path()
_HEALTH = os.path.join(_DATA, ".cache", "overpass-health.json")
_LOG = os.path.join(_DATA, "overpass-log.jsonl")
# The public OSM services ask for a contact in the User-Agent: the owner's
# address (instance owner_email) when one is set.
_CONTACT = places_local.instance().get("owner_email") or ""
USER_AGENT = f"jori-location/1.0 (personal assistant{'; contact ' + _CONTACT if _CONTACT else ''})"

_DEFAULTS = {
    "endpoints": ["https://overpass-api.de/api/interpreter"],
    "per_mirror_s": 20,
    "skip_failed_min": 2,
    "skip_refused_min": 30,
    "skip_failed_max_min": 120,
}


def _config():
    c = dict(_DEFAULTS)
    try:
        with open(_CONFIG) as f:
            c.update({k: v for k, v in json.load(f).items() if v})
    except Exception:
        pass
    return c


def _load_health():
    try:
        with open(_HEALTH) as f:
            h = json.load(f)
        return h if isinstance(h, dict) else {}
    except Exception:
        return {}


def _save_health(h):
    try:
        os.makedirs(os.path.dirname(_HEALTH), exist_ok=True)
        tmp = f"{_HEALTH}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            json.dump(h, f, indent=1)
        os.replace(tmp, _HEALTH)
    except Exception:
        pass


def _log(rec):
    try:
        with open(_LOG, "a") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception:
        pass


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def _rec(h, url):
    r = h.get(url)
    return r if isinstance(r, dict) else {}


def endpoints(now=None):
    """Mirrors to try, best first: not in backoff, most recent success first,
    then config order. Every mirror, if all are in backoff."""
    now = time.time() if now is None else now
    c, h = _config(), _load_health()
    urls = list(c["endpoints"])
    order = {u: i for i, u in enumerate(urls)}
    live = [u for u in urls if _rec(h, u).get("skip_until", 0) <= now]
    pool = live or urls
    return sorted(pool, key=lambda u: (-_rec(h, u).get("last_ok", 0), order[u]))


def _classify(e):
    """'refused' for a server that is down (connect refused / DNS / no route),
    'busy' for timeouts, 429 and 5xx, 'bad' for anything else."""
    if isinstance(e, urllib.error.HTTPError):
        return "busy" if e.code == 429 or e.code >= 500 else "bad"
    reason = getattr(e, "reason", e)
    if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(reason):
        return "busy"
    if isinstance(reason, (ConnectionRefusedError, socket.gaierror)) or \
            getattr(reason, "errno", None) in (61, 64, 65, 8):
        return "refused"
    return "busy"


def _note(url, ok, err=None, kind=None, ms=None):
    c, h, now = _config(), _load_health(), time.time()
    r = _rec(h, url)
    if ok:
        r = {"last_ok": now, "ms": ms}
        h["_last_success"] = _iso(now)
        h.pop("_all_failed_since", None)
    else:
        fails = int(r.get("fails", 0)) + 1
        base = float(c["skip_refused_min"] if kind == "refused" else c["skip_failed_min"])
        skip = min(base * (2 ** (fails - 1)), float(c["skip_failed_max_min"]))
        r.update({"fails": fails, "skip_until": now + skip * 60,
                  "last_fail": _iso(now), "last_error": f"{kind}: {err}"[:200]})
        _log({"ts": _iso(now), "url": url, "kind": kind, "error": str(err)[:200],
              "fails": fails, "skip_min": round(skip, 1)})
    h[url] = r
    _save_health(h)


def post(query, timeout_s=30, user_agent=USER_AGENT):
    """POST `query`; return parsed JSON from the first mirror that answers
    within the overall `timeout_s`. Raises when none does."""
    c = _config()
    deadline = time.time() + timeout_s
    last = None
    tried = 0
    for url in endpoints():
        left = deadline - time.time()
        if left < 2:
            break
        tried += 1
        t0 = time.time()
        try:
            req = urllib.request.Request(
                url, data=urllib.parse.urlencode({"data": query}).encode("utf-8"),
                headers={"User-Agent": user_agent})
            with urllib.request.urlopen(req, timeout=min(float(c["per_mirror_s"]), left)) as r:
                data = json.loads(r.read())
            if not isinstance(data, dict) or "elements" not in data:
                raise ValueError("response has no elements")
            _note(url, True, ms=int((time.time() - t0) * 1000))
            return data
        except Exception as e:
            last = e
            _note(url, False, err=e, kind=_classify(e))
    h = _load_health()
    if not h.get("_all_failed_since"):
        h["_all_failed_since"] = _iso(time.time())
        _save_health(h)
    raise RuntimeError(f"overpass: no mirror answered ({tried} tried; last: {last})")


def status():
    """Health snapshot for the CLI / watchdog."""
    return {"endpoints": endpoints(), "health": _load_health()}


if __name__ == "__main__":
    print(json.dumps(status(), indent=2))
