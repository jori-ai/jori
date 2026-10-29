#!/usr/bin/env python3
"""day-path-nearest-place.test.py -- a dwell joins the place it sits at; a leg's pace is its fixes'.

Replays a real day (2026-10-25, synthetic places via tests/fixtures/fake_geo.py; tests/fixtures/day-path-2026-10-25.rows.json, the
rows as they sat in location_history that night). The flat and Café Example are
73 m apart. The morning's café rows renamed the place the overnight row had built
"Café Example"; the phone named the 17:43 arrival "The Harbor Flat", its own
place. The 20:22-21:14 stay sat 13 m from that one and 72 m from the café's, but
the place fold took the first place under PLACE_M (150 m) in the order the day
built them, so the evening at home came out "Café Example" and the daily summary
headed the night "8:18pm · Café Example".

Same day, the beach walk 17:11-17:28: 4.7 km/h over its 8 fixes, but the pace was
read over the 4 thinned routing waypoints (8.6 km/h), so the leg was "riding" and
the header's miles walked left out the mile printed as "Walk on the beach · 1.0 mi".

Run: python3 tests/day-path-nearest-place.test.py
"""
import json, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, "fixtures"))
from fake_geo import at as G, load_rows  # noqa: E402,F401
mod = type(sys)("daypath")
exec(compile(open(os.path.join(REPO, "bin", "day-path")).read(), "day-path", "exec"), mod.__dict__)
ROWS = load_rows(os.path.join(HERE, "fixtures", "day-path-2026-10-25.rows.json"))


def build(match=False, **env):
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    saved = mod.valhalla_route_points, mod.osrm_match
    if match:
        def offline(*a, **k):
            raise RuntimeError("offline")      # no router in a test: legs degrade to raw
        mod.valhalla_route_points = mod.osrm_match = offline
    try:
        return mod.build("2026-10-25", "Asia/Jerusalem", ROWS, do_match=match)
    finally:
        mod.valhalla_route_points, mod.osrm_match = saved
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def beach_leg(**env):
    legs = [n for n in build(match=True, **env)["spine"] if n["type"] == "leg" and n["start"] == "17:11"]
    assert len(legs) == 1, legs
    return legs[0]


def dwells(**env):
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    try:
        day = mod.build("2026-10-25", "Asia/Jerusalem", ROWS, do_match=False)
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    return [(n["start"], n["end"], (n["place"] or {}).get("name")) for n in day["spine"] if n["type"] == "dwell"]


class NearestPlaceWins(unittest.TestCase):
    def setUp(self):
        self.d = dwells()

    def test_the_evening_at_the_flat_is_the_flat(self):
        self.assertIn(("20:22", "21:14", "The Harbor Flat"), self.d)

    def test_the_rest_of_the_day_is_unchanged(self):
        for want in [("10:05", "13:29", "Café Example"), ("13:29", "14:16", "pita place"),
                     ("17:43", "19:04", "The Harbor Flat"), ("19:04", "20:18", "Example Bakery")]:
            self.assertIn(want, self.d)


class PaceFromEveryFix(unittest.TestCase):
    def test_the_beach_walk_is_walking(self):
        leg = beach_leg()
        self.assertEqual(leg["mode"], "walking", leg)
        self.assertLess(leg["median_kmh"], 7)

    def test_waypoint_switch_restores_riding(self):
        self.assertEqual(beach_leg(JORI_PACE_FROM_WAYPOINTS="1")["mode"], "riding")


class SwitchRestoresTheOldOrder(unittest.TestCase):
    def test_first_built_order(self):
        self.assertIn(("20:22", "21:14", "Café Example"), dwells(JORI_NEAREST_PLACE="0"))


if __name__ == "__main__":
    unittest.main()
