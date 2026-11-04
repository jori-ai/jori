"""named_places — the user's named places (data/named-locations.json) for the
small Python location tools (geofence-check, location-commute,
location-pattern), by name or alias, plus the haversine they all use.

The same file lib/named-locations.js and place_naming.py read. Each entry is
{name, lat, lon, kind?, address?, aliases?: [lower-case short names]}. A
missing or unreadable file (a fresh install) is an empty list: named targets
are unknown and callers fall back to coordinates or an address.
JORI_NAMED_LOCATIONS_FILE points elsewhere (tests).
"""

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import places_local  # noqa: E402


def named_locations_file():
    return os.environ.get("JORI_NAMED_LOCATIONS_FILE") or places_local.data_path("named-locations.json")


def load(path=None):
    """Entries with a name and coordinates."""
    try:
        with open(path or named_locations_file()) as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        return []
    items = raw if isinstance(raw, list) else (raw.get("entries") or []) if isinstance(raw, dict) else []
    out = []
    for e in items:
        if not isinstance(e, dict) or not e.get("name"):
            continue
        try:
            lat, lon = float(e["lat"]), float(e["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        out.append({**e, "lat": lat, "lon": lon, "aliases": [str(a).lower() for a in (e.get("aliases") or [])]})
    return out


def resolve(target, entries=None):
    """The entry whose name or alias is `target` (case-insensitive), or None."""
    t = str(target or "").lower().strip()
    if not t:
        return None
    for e in (load() if entries is None else entries):
        if t == e["name"].lower() or t in e.get("aliases", []):
            return e
    return None


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def nearest(lat, lon, radius_km, entries=None):
    """(entry, distance_km) of the closest named place within radius_km, else (None, None)."""
    best = (None, None)
    for e in (load() if entries is None else entries):
        d = haversine_km(lat, lon, e["lat"], e["lon"])
        if d <= radius_km and (best[1] is None or d < best[1]):
            best = (e, d)
    return best
