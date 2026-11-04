"""places_cache — a disk cache in front of the `places` CLI's Google calls.

The requirement: keep Places calls to a minimum (cache what can be cached,
prefer free or cheaper sources).

WHY THE `places` CLI HAS ITS OWN. Stop naming (via places_nearby.py) keeps its
own cache. The paid calls that matter come through `places`, which anything
looking around where the user is standing runs, often from the same few
streets day after day; without a cache every one of those is a billed search.

THE KEY. A search is the same search when the query, the radius, the open-now
flag and the field mask are the same and the position falls in the same cell.
The cell is 0.001 degrees (about 110 m of latitude; less of longitude away
from the equator): in a neighbourhood walked daily, most sweeps are repeats of
a cell already answered. The cached value is Google's RAW response, so
distances are recomputed against the caller's true position on every hit; only
the candidate pool was gathered around the cell's first visitor.

THE TTL is one year. A café does not move and a rating does not change
overnight. What does change with the clock is "open now", which the CLI
re-derives on every hit from the stored weekly hours (see `places`), so a
weekday answer is not served as open on a day the place is shut. What a year
can change and the cache cannot see is a place closing for good; `places
--refresh` re-fetches and overwrites an entry.

Cache files are JSON (about 60 KB for a full page of 20 places). Each file's
mtime is set to its own expiry, so `prune()` is a stat per file with no reads,
and it runs on a sample of writes: an entry is removed a day after it expires,
without a cron job.
"""

import hashlib
import json
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import places_local  # noqa: E402

CACHE_DIR = os.environ.get("PLACES_CACHE_DIR") or places_local.data_path(".cache", "places-cli")
SEARCH_TTL_SEC = 365 * 24 * 3600    # nearby / at: one year
DETAILS_TTL_SEC = 365 * 24 * 3600   # Place Details (hours) for `check`
RESOLVE_TTL_SEC = 365 * 24 * 3600   # query -> place_id: a place id does not change
EXPIRY_GRACE_SEC = 24 * 3600        # a file outlives its TTL by a day before it is pruned
CELL_DEG = 0.001
_VERSION = 1


def normalize_query(q):
    """Case and whitespace only. The query is composed by our own callers
    (machine text), so this is canonicalisation, not interpretation."""
    return " ".join(str(q or "").casefold().split())


def cell(lat, lng):
    """The ~110 m grid cell a position falls in, as a stable string."""
    return f"{round(float(lat) / CELL_DEG) * CELL_DEG:.3f},{round(float(lng) / CELL_DEG) * CELL_DEG:.3f}"


def make_key(kind, *parts):
    raw = "|".join([kind] + [str(p) for p in parts])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def search_key(query, lat, lng, radius, open_now, mask, when=""):
    """`when` is a time-of-week bucket for entries whose open-now answer cannot
    be re-derived on a hit (the lean mask carries no hours); "" otherwise."""
    return make_key("search", normalize_query(query), cell(lat, lng), int(radius),
                    "open" if open_now else "any", mask, when)


def resolve_key(query, near=None):
    where = ""
    if near:
        # Coarser than a search cell: this only biases which "Le Coucou" wins.
        where = f"{round(float(near[0]), 2):.2f},{round(float(near[1]), 2):.2f}"
    return make_key("resolve", normalize_query(query), where)


def details_key(place_id, mask):
    return make_key("details", place_id, mask)


def _path(key):
    return os.path.join(CACHE_DIR, f"{key}.json")


def get(key, ttl_sec, now=None):
    """The stored entry {payload, stored_at, age_sec}, or None when absent,
    expired or unreadable. Never raises: a broken cache is a miss."""
    try:
        with open(_path(key)) as fh:
            entry = json.load(fh)
        now = time.time() if now is None else now
        age = now - float(entry["stored_at"])
        if entry.get("v") != _VERSION or age < 0 or age > ttl_sec:
            return None
        return {"payload": entry["payload"], "stored_at": entry["stored_at"], "age_sec": age}
    except Exception:
        return None


def put(key, payload, ttl_sec=SEARCH_TTL_SEC, now=None):
    """Store atomically. Never raises: failing to cache must not fail the call.
    The file's mtime is set to when it stops being useful (TTL plus a day's
    grace) so `prune` can tell without opening it."""
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        path = _path(key)
        tmp = f"{path}.{os.getpid()}.tmp"
        stored_at = time.time() if now is None else now
        with open(tmp, "w") as fh:
            json.dump({"v": _VERSION, "stored_at": stored_at, "payload": payload}, fh)
        expires = stored_at + ttl_sec + EXPIRY_GRACE_SEC
        os.utime(tmp, (expires, expires))
        os.replace(tmp, path)
        if random.random() < 0.02:
            prune()
    except Exception:
        pass


def prune(now=None):
    """Delete entries whose expiry (their mtime) has passed, and temp files
    abandoned by a killed process. Returns how many were removed."""
    removed = 0
    try:
        now = time.time() if now is None else now
        for name in os.listdir(CACHE_DIR):
            path = os.path.join(CACHE_DIR, name)
            try:
                if os.path.getmtime(path) < now:
                    os.remove(path)
                    removed += 1
            except OSError:
                continue
    except OSError:
        pass
    return removed
