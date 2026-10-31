"""osm_places — named places and their real FOOTPRINTS, from OpenStreetMap.

An alternative to Google for naming stops: no photos or ratings are needed
here, only place names and locations.

Two problems collapse into one source here.

COST. Google Places is billed per field, and the field mask Jori sends
(rating, editorial summary, photos) pushes it into a higher tier — the 2026-07
bill reached $267 on mask contents alone. Naming a stop needs a name, a
position and a type; everything else was being paid for and discarded. Overpass
is free, and a single call returned 314 named features around one stop where
Google's distance-ranked search returns 20.

GEOMETRY, which Google cannot sell at any price. Google gives a PIN. A visitor
to a large site stands at its perimeter, so a pin plus a radius is a bad proxy
for a boundary: it once let a courtyard 161m away, a square 237m away and a
scattering of art galleries win segments they merely overlapped, and named the
user's flat after a museum. OSM maps those as WAYS,
so `out geom` returns the actual polygon and containment becomes a
point-in-polygon test rather than a guess about how big a place probably is.

WHAT THIS IS NOT. OSM's coverage of brand-new businesses is patchier than
Google's, so callers should keep a Google fallback for segments this cannot
name. And Overpass is a shared public service under fair use — every response
is cached to disk, because a segmenter re-running a day must never re-query.
"""

import hashlib
import json
import math
import os
import time
import urllib.parse
import urllib.request

from overpass_client import post as overpass_post, USER_AGENT  # shared mirror list
import places_local

CACHE_DIR = places_local.data_path(".cache", "osm-places")
CACHE_TTL_SEC = 30 * 24 * 3600      # a café does not move; a month is conservative

# Tags that denote somewhere a person goes. Deliberately tag-driven rather than
# a hand-kept name list: OSM's own vocabulary already encodes the distinction
# that `stop-identify`'s destination prior was approximating by hand.
INTERESTING_KEYS = ("amenity", "shop", "tourism", "leisure", "historic", "craft", "office")

DESTINATION_VALUES = {
    "cafe", "restaurant", "fast_food", "bar", "pub", "biergarten", "ice_cream",
    "bakery", "confectionery", "chocolate", "pastry", "deli", "greengrocer",
    "supermarket", "convenience", "books", "clothes", "shoes", "gift", "art",
    "museum", "gallery", "attraction", "artwork", "viewpoint", "zoo", "theme_park",
    "park", "garden", "playground", "pitch", "sports_centre", "fitness_centre",
    "cinema", "theatre", "nightclub", "marketplace", "archaeological_site",
    "monument", "memorial", "ruins", "castle", "church", "cathedral", "library",
}
SERVICE_VALUES = {
    "pharmacy", "doctors", "dentist", "clinic", "hospital", "veterinary",
    "bank", "post_office", "police", "fire_station", "school", "kindergarten",
    "college", "university", "laundry", "dry_cleaning", "hairdresser", "beauty",
    "insurance", "lawyer", "estate_agent", "accountant", "car_repair",
}
DEMOTED_VALUES = {
    "bus_station", "bus_stop", "parking", "parking_entrance", "bicycle_parking",
    "atm", "toilets", "waste_basket", "bench", "recycling", "fuel", "charging_station",
    "hotel", "hostel", "guest_house", "apartment", "motel",
}


def _cache_path(k):
    return os.path.join(CACHE_DIR, f"{k}.json")


def _cache_get(k):
    p = _cache_path(k)
    try:
        if not os.path.exists(p) or time.time() - os.path.getmtime(p) > CACHE_TTL_SEC:
            return None
        with open(p) as fh:
            return json.load(fh)
    except Exception:
        return None


def _cache_set(k, v):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = _cache_path(k) + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(v, fh)
        os.replace(tmp, _cache_path(k))
    except Exception:
        pass


def _query(q):
    """Run one Overpass query, retrying across mirrors with backoff.

    RETRIES ARE NOT OPTIONAL HERE. Overpass allocates a small number of
    execution slots per client and answers 429 (or hangs to timeout) when they
    are busy — one attempt per endpoint left 2 of 3 clusters empty on a live
    run, which is indistinguishable from "this part of Paris has no shops". The
    waits are deliberately generous: this is a free shared service, results are
    cached for a month, and being slow once is much cheaper than being wrong.
    """
    last = None
    for attempt, wait in enumerate((0, 3, 8)):
        if wait:
            time.sleep(wait)
        try:
            return overpass_post(q, timeout_s=45, user_agent=USER_AGENT)
        except Exception as e:
            last = e
    raise RuntimeError(f"overpass unavailable after 3 rounds: {last}")


# English first (2026-10-20): an English name sits in its own tag ("Western Wall" beside
# "הכותל המערבי"): a field lookup, no judgment. The rest is place_naming.english_names' job.
EN_NAME_KEYS = ("name:en", "int_name", "name:latn", "official_name:en")


def osm_display_name(tags):
    """(display, native): the element's English-tagged name with its `name`
    tag kept as `native`, or (name, None) when it has no English field."""
    native = (tags.get("name") or "").strip()
    for k in EN_NAME_KEYS:
        v = tags.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip(), (native if native and native != v.strip() else None)
    return native, None


def _classify(tags):
    for k in INTERESTING_KEYS:
        v = tags.get(k)
        if not v:
            continue
        if v in DEMOTED_VALUES:
            return "demoted", v
        if v in DESTINATION_VALUES:
            return "destination", v
        if v in SERVICE_VALUES:
            return "service", v
        return "other", v
    return "other", ""


def _centroid(poly):
    return (sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly))


def point_in_polygon(lat, lon, poly):
    """Ray casting. `poly` is [(lat, lon), …].

    This is the whole point of preferring OSM: containment stops being "within
    N metres of a pin", which is generous in every direction and therefore lets
    a big place claim a pavement beside it, and becomes "inside the boundary".
    """
    inside = False
    n = len(poly)
    for i in range(n):
        y1, x1 = poly[i]
        y2, x2 = poly[(i + 1) % n]
        if (y1 > lat) != (y2 > lat):
            xint = (x2 - x1) * (lat - y1) / ((y2 - y1) or 1e-12) + x1
            if lon < xint:
                inside = not inside
    return inside


def meters(a, b):
    return math.hypot((b[0] - a[0]) * 111320.0,
                      (b[1] - a[1]) * 111320.0 * math.cos(math.radians(a[0])))


def nearby(lat, lon, radius=250):
    """Named OSM features near a point.

    Returns [{osm_id, name, lat, lon, kind, category, polygon}] where `polygon`
    is [(lat, lon), …] for mapped areas and None for point features. Cached on a
    ~110m grid: adjacent fixes reuse one response, so a day costs a handful of
    calls against a shared public service.
    """
    cell = f"{round(lat,3)}|{round(lon,3)}|{radius}"
    # "|en": entries cached before osm_display_name hold the local name only.
    gk = hashlib.md5(f"{cell}|en".encode()).hexdigest()[:16]
    restore = lambda hit: [{**p, "polygon": [tuple(c) for c in p["polygon"]] if p.get("polygon") else None}
                           for p in hit]
    hit = _cache_get(gk)
    if hit is not None:
        return restore(hit)

    filt = "|".join(INTERESTING_KEYS)
    # Double-quoted regexes: the single-quoted form returned zero elements
    # against an area where this returns ~490.
    #
    # RELATIONS ARE A SEPARATE QUERY, and that is not tidiness. `out center` on
    # a relation TIMES OUT, and because Overpass fails a whole statement rather
    # than one clause, folding relations into this query returned nothing at
    # all. They are fetched below with `out geom` instead — which is also the
    # only way to get their rings. Without them a multipolygon site is reachable
    # only through its parts: Arènes de Lutèce appeared solely as its seating,
    # "Gradins", 148m from the anchor.
    q = (f'[out:json][timeout:40];('
         f'node(around:{radius},{lat},{lon})[name][~"^({filt})$"~"."];'
         f'way(around:{radius},{lat},{lon})[name][~"^({filt})$"~"."];'
         f');out center geom tags;')
    try:
        data = _query(q)
    except Exception:
        # Overpass down: the pre-English entry for this cell beats nothing.
        old = _cache_get(hashlib.md5(cell.encode()).hexdigest()[:16])
        return restore(old) if old is not None else []

    out = []
    for e in data.get("elements", []):
        tags = e.get("tags") or {}
        name, native = osm_display_name(tags)
        if not name:
            continue
        poly = None
        geom = e.get("geometry")
        if geom and len(geom) >= 3:
            poly = [(g["lat"], g["lon"]) for g in geom]
        c = e.get("center") or e
        plat, plon = c.get("lat"), c.get("lon")
        if plat is None and poly:
            plat, plon = _centroid(poly)
        if plat is None:
            continue
        cat, kind = _classify(tags)
        out.append({"osm_id": f"{e['type']}/{e['id']}", "name": name, "name_native": native,
                    "lat": plat, "lon": plon, "kind": kind, "category": cat,
                    "polygon": poly})

    out.extend(_relations_near(lat, lon, radius, filt))
    _cache_set(gk, out)
    return out


def _relations_near(lat, lon, radius, filt):
    """Multipolygon sites — parks, campuses, monument grounds.

    Their outer ring is assembled from member ways, so `out geom` is required
    (and `out center` is what times out). Members arrive as separate way
    geometries; the longest `outer` ring is taken as the boundary, which is
    right for the simple single-outer case and degrades to the largest part of a
    complex one rather than to nothing.
    """
    q = (f'[out:json][timeout:40];'
         f'relation(around:{radius},{lat},{lon})[name][~"^({filt})$"~"."];'
         f'out geom tags;')
    try:
        data = _query(q)
    except Exception:
        return []
    out = []
    for e in data.get("elements", []):
        tags = e.get("tags") or {}
        name, native = osm_display_name(tags)
        if not name:
            continue
        # Tolerant on purpose. Filtering members to role == "outer" dropped all
        # six relations in the test area — real data puts the ring on members
        # whose role is empty, "outer", or absent entirely, and some relations
        # carry no member geometry at all. Take the longest ring available from
        # ANY member, and fall back to the relation's own bounding box, which is
        # coarse but is still a boundary rather than a pin.
        rings = [m.get("geometry") for m in (e.get("members") or []) if m.get("geometry")]
        best = max(rings, key=len) if rings else None
        bbox_only = False
        if best and len(best) >= 3:
            poly = [(g["lat"], g["lon"]) for g in best]
        else:
            b = e.get("bounds")
            if not b:
                continue
            poly = [(b["minlat"], b["minlon"]), (b["minlat"], b["maxlon"]),
                    (b["maxlat"], b["maxlon"]), (b["maxlat"], b["minlon"])]
            # SAY SO. A bounding box is a rectangle around a shape, not the
            # shape — callers must be able to distrust its size without having
            # to distrust every large place. Left unmarked, the only available
            # defence was a flat size cap, and that cap threw out the real
            # 522m ring of a city park along with the 2.6km rectangle it was
            # aimed at.
            bbox_only = True
        clat, clon = _centroid(poly)
        cat, kind = _classify(tags)
        out.append({"osm_id": f"relation/{e['id']}", "name": name, "name_native": native,
                    "lat": clat, "lon": clon, "kind": kind, "category": cat,
                    "polygon": poly, "bbox_only": bbox_only})
    return out


def contains(place, lat, lon, pad_m=25.0):
    """Is this fix inside the place?

    A polygon is tested exactly, with a small pad for GPS error at the boundary
    — standing at a park railing is being at the park. A point feature falls
    back to a modest radius, because a node carries no size and pretending it
    does is what the OSM switch exists to stop.
    """
    if place.get("polygon"):
        if point_in_polygon(lat, lon, place["polygon"]):
            return True
        edge = min(meters((lat, lon), p) for p in place["polygon"])
        return edge <= pad_m
    return meters((lat, lon), (place["lat"], place["lon"])) <= 55.0
