"""places_nearby — one Google Places 'searchNearby' for every Python caller.

Extracted from `findme` on 2026-08-10 so that anything which identifies a stop
can ask what is AT that stop, rather than only the enrichment queue: the most
likely places near an identified stop always come from the Google API.

WHY THIS HAD TO BE SHARED, not copied. The candidate list is only as good as
the coordinate it was queried at, and coordinates now MOVE: `visit-anchor`
refits a visit's anchor from the fixes it contains, and one day that shifted
one stop 118m and another 37m. Candidates
computed before a move describe the old point. A second copy of this lookup
would have drifted from findme's the first time either was touched — and the
thing that must not drift is the FIELD MASK, which is billed per field: the
2026-07 Places bill spiked to $267 because the mask selects the price tier.

The disk cache is keyed on rounded coordinates, so a moved anchor re-queries
naturally while a stop that has not moved stays free.

BUDGET FAILS OPEN TO EMPTY, NEVER TO AN ERROR. Nearby names are an enrichment
on top of a GPS fix, and "where am I" has to keep working on a blown Places
budget — every caller already handles an empty list, which is also what a rural
fix returns. A block is deliberately NOT cached: when it lifts, the names come
back.
"""

import hashlib
import json
import math
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from places_log import log_call as _places_log, timed as _places_timed
except Exception:  # never let the logger break a caller
    def _places_log(*a, **k): pass
    class _places_timed:
        ms = None
        def __enter__(self): return self
        def __exit__(self, *e): return False

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import places_local  # noqa: E402

CACHE_DIR = places_local.data_path(".cache", "google-places")
CACHE_TTL_SEC = 7 * 24 * 3600
ENV_FILE = os.path.join(places_local.install_root(), ".env")

# Billed per field, and the field mask IS the price tier. Trimmed to Essentials
# on 2026-08-21 after the billing export named the cost precisely: of Jori's
# $22.17 Places spend that month, $21.72 -- 98% -- was a single SKU, "Places API
# Text Search Enterprise + Atmosphere", 1,111 calls at ~$19.55/1,000. The same
# month's "Text Search Essentials" line was $0.07 for 371 calls.
#
# Three fields were buying that tier and nothing else: `rating` and
# `userRatingCount` lift a call to ENTERPRISE, `editorialSummary` lifts it to
# ATMOSPHERE. `primaryTypeDisplayName` is dropped with them; callers already do
# `c.get("type_display") or c["primary_type"]`.
#
# What this costs us is ranking signal, and the answer is that we already run
# without it: OSM candidates have carried rating=None/reviews=None since the
# fallback landed, and `_score_candidate` degrades cleanly -- `reviews` folds to
# a 0 popularity term and `rating` to its 3.0 default, leaving type priority
# plus proximity, which is what actually separates candidates at these radii.
# osm_places.py states the same conclusion: no photos or ratings are needed
# here, only place names and locations.
#
# Adding a field back changes the price tier of EVERY Places call in Jori.
# Check the SKU in the billing export before you do.
FIELD_MASK = (
    "places.displayName,places.formattedAddress,places.primaryType,"
    "places.types,places.location,places.id"
)

def api_key():
    k = os.environ.get("GOOGLE_PLACES_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if k:
        return k
    try:
        with open(ENV_FILE) as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("GOOGLE_PLACES_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def is_blocked():
    """True when the Jori Places budget is spent. Never raises: callers sit
    on the location hot path, so a missing or malformed guard reads as
    'not blocked'."""
    try:
        from places_guard import places_block_reason
        return places_block_reason() is not None
    except Exception:
        return False


def _haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# ── Locales: ask Google in the local language, for the local region ────────
#
# With no language or region on the request, Google's candidates in a country
# whose signage is in another script come back as transliterations or noise (a
# clinic offered for a café), and OSM fills the gap with whatever `name` tag it
# has. So inside a configured bounding box the lookup asks in that country's
# language (`languageCode`) and region (`regionCode`). The test is GEOMETRY
# (code owns geometry, Rule #0b): a bounding box, generous at the edges because
# the only effect of a false positive is that names come back in the local
# language where Google has them. Everywhere else the request is byte-identical
# to before, and so is its cache key — a warm cache outside a locale stays warm.
#
# Config — agent/local/config/places-locales.json (none: every request default):
#   locales  [{ "bbox": [min_lat, min_lon, max_lat, max_lon],
#               "languageCode": "<BCP-47>", "regionCode": "<CLDR region>" }]
def _locales():
    out = []
    for loc in places_local.local_config("places-locales", {"locales": []}).get("locales") or []:
        try:
            bbox = tuple(float(x) for x in loc["bbox"])
        except (KeyError, TypeError, ValueError):
            continue
        fields = {k: loc[k] for k in ("languageCode", "regionCode") if loc.get(k)}
        if len(bbox) == 4 and fields:
            out.append((bbox, fields))
    return out


LOCALES = _locales()


def places_locale(lat, lon):
    """Request fields for a coordinate's locale, or {} for the default."""
    try:
        la, lo = float(lat), float(lon)
    except (TypeError, ValueError):
        return {}
    for (a, b, c, d), fields in LOCALES:
        if a <= la <= c and b <= lo <= d:
            return dict(fields)
    return {}


def _cache_key(prefix, lat, lon, radius_m, max_results, query=""):
    raw = (f"{prefix}|{round(lat, 4)}|{round(lon, 4)}|"
           f"{int(radius_m / 20) * 20}|{max_results}|{query}")
    return hashlib.md5(raw.encode("utf-8")).hexdigest()[:16]


def _cache_get(key):
    path = os.path.join(CACHE_DIR, f"{key}.json")
    try:
        if not os.path.exists(path):
            return None
        if time.time() - os.path.getmtime(path) > CACHE_TTL_SEC:
            return None
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


def _cache_set(key, results):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        path = os.path.join(CACHE_DIR, f"{key}.json")
        tmp = path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(results, fh)
        os.replace(tmp, path)
    except Exception:
        pass


def nearby(lat, lon, radius=40, max_results=20, cache_prefix="findme-nearby"):
    """Places within `radius` metres, nearest first.

    Returns [{name, address, rating, reviews, primary_type, type_display,
              types, summary, lat, lon, distance_m, place_id}], or [] on any
    failure. `cache_prefix` preserves findme's historical cache namespace so
    the extraction does not invalidate a warm cache.
    """
    locale = places_locale(lat, lon)
    # Locale in the key only when there is one, so non-Israel keys are unchanged.
    ck = _cache_key(cache_prefix, lat, lon, radius, max_results,
                    query=("lang=" + locale["languageCode"]) if locale else "")
    cached = _cache_get(ck)
    if cached is not None:
        _places_log(cache_prefix.split("-")[0], "searchNearby", mask=FIELD_MASK, cached=True)
        return cached
    if is_blocked():
        return []
    key = api_key()
    if not key:
        return []
    try:
        body = {
            "locationRestriction": {
                "circle": {"center": {"latitude": lat, "longitude": lon},
                           "radius": radius}
            },
            "rankPreference": "DISTANCE",
            "maxResultCount": max_results,
            **locale,
        }
        import places_client  # the one guarded door: prices, gates, logs
        try:
            data = places_client.post(cache_prefix.split("-")[0], "places:searchNearby", body, FIELD_MASK,
                                      "searchNearby", timeout=10, api_key=key, lat=lat, lon=lon, radius=radius)
        except places_client.PlacesRefused as e:
            print(f"[places_nearby] refused: {e.reason}", file=sys.stderr)
            return []

        results = []
        for p in data.get("places", []):
            plat = p["location"]["latitude"]
            plon = p["location"]["longitude"]
            summary = p.get("editorialSummary")
            type_disp = p.get("primaryTypeDisplayName")
            results.append({
                "name": p.get("displayName", {}).get("text", "?"),
                "address": p.get("formattedAddress", ""),
                "rating": p.get("rating"),
                "reviews": p.get("userRatingCount", 0),
                "primary_type": p.get("primaryType", ""),
                "type_display": type_disp.get("text") if isinstance(type_disp, dict) else "",
                "types": p.get("types", []),
                "summary": summary.get("text") if isinstance(summary, dict) else "",
                "lat": plat,
                "lon": plon,
                "distance_m": _haversine_m(lat, lon, plat, plon),
                "place_id": p.get("id", ""),
            })
        _cache_set(ck, results)
        return results
    except Exception as e:
        print(f"[places_nearby] error: {e}", file=sys.stderr)
        return []
