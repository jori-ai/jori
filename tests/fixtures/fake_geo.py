"""fake_geo — synthetic coordinates for location tests (the Python twin of
tests/fixtures/fake-geo.mjs): a point is metres east / north of an obviously
fake origin, read as an azimuthal equidistant offset, so a test keeps a real
day's geometry (distances and bearings) without its place."""

import json
import math

ORIGIN = (12.3456, -65.4321)
R = 6371000.0


def at(east_m, north_m, origin=ORIGIN):
    """(lat, lon) east_m metres east and north_m metres north of origin."""
    d = math.hypot(east_m, north_m) / R
    if d == 0:
        return origin
    brg = math.atan2(east_m, north_m)
    la1, lo1 = math.radians(origin[0]), math.radians(origin[1])
    la2 = math.asin(math.sin(la1) * math.cos(d) + math.cos(la1) * math.sin(d) * math.cos(brg))
    lo2 = lo1 + math.atan2(math.sin(brg) * math.sin(d) * math.cos(la1),
                           math.cos(d) - math.sin(la1) * math.sin(la2))
    return (math.degrees(la2), math.degrees(lo2))


def load_rows(path, lat_key="latitude", lon_key="longitude"):
    """Rows from a fixture whose points are e_m / n_m, with lat_key / lon_key restored."""
    out = []
    for r in json.load(open(path)):
        if r.get("e_m") is not None and r.get("n_m") is not None:
            r = dict(r)
            lat, lon = at(r.pop("e_m"), r.pop("n_m"))
            r[lat_key], r[lon_key] = lat, lon
        out.append(r)
    return out
