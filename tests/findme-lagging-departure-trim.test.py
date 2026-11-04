"""findme resolve: confirming a stop that a far-away confirmed visit's LATE
departure overlaps trims that departure instead of refusing (a rented flat's
row ran to 08:41Z, breakfast 160m away began 07:21Z). Same-place twins still
refuse, and enrich only copies a confirmed name onto a real twin. Synthetic
places and coordinates.
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "lib"))

if "pyicloud" not in sys.modules:
    import types
    _fake = types.ModuleType("pyicloud")
    _fake.PyiCloudService = object
    sys.modules["pyicloud"] = _fake


import math

BASE_LAT, BASE_LON = 12.3456, -65.4321


def P(north_m, east_m):
    """{"latitude", "longitude"} north_m / east_m metres from the fake base."""
    return {"latitude": BASE_LAT + north_m / 111320.0,
            "longitude": BASE_LON + east_m / (111320.0 * math.cos(math.radians(BASE_LAT)))}


def load(script, name):
    mod = type(sys)(name)
    mod.__dict__["__name__"] = name
    mod.__dict__["__file__"] = os.path.join(REPO, "bin", script)
    with open(os.path.join(REPO, "bin", script)) as fh:
        src = fh.read()
    exec(compile(src, script, "exec"), mod.__dict__)
    return mod


FLAT = {"id": "47d351f6-flat", "place_name": "The rental", "notes": None, **P(0, 0),
        "arrived_at": "2026-10-02T20:18:27+00:00", "departed_at": "2026-10-03T08:41:42+00:00"}
BREAKFAST = {"id": "6aec5c60-breakfast", "place_name": None, **P(160.5, -3.3),  # ~160m north
          "arrived_at": "2026-10-03T07:21:45+00:00", "departed_at": "2026-10-03T07:40:00+00:00"}


class LaggingDepartureTrim(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fm = load("findme", "findme_trim")

    def test_the_case_trims_the_flat_to_breakfast(self):
        t = self.fm._lagging_departure_trim(BREAKFAST, [FLAT])
        self.assertEqual(t["id"], FLAT["id"])
        self.assertEqual(t["new_departed"], BREAKFAST["arrived_at"])
        self.assertEqual(t["old_departed"], FLAT["departed_at"])

    def test_works_in_the_other_direction(self):
        # Confirming the EARLIER row whose own departure runs into a confirmed later stop.
        t = self.fm._lagging_departure_trim(FLAT, [BREAKFAST])
        self.assertEqual(t["id"], FLAT["id"])
        self.assertEqual(t["new_departed"], BREAKFAST["arrived_at"])

    def test_same_place_twin_still_refuses(self):
        twin = dict(BREAKFAST, **P(15.8, 6.1))  # ~16m away
        self.assertIsNone(self.fm._lagging_departure_trim(twin, [FLAT]))

    def test_two_clashes_still_refuse(self):
        other = dict(FLAT, id="x", **P(795.1, 0))
        self.assertIsNone(self.fm._lagging_departure_trim(BREAKFAST, [FLAT, other]))

    def test_trim_that_leaves_a_sliver_refuses(self):
        short = dict(FLAT, arrived_at="2026-10-03T07:17:00+00:00")  # would keep 4.75 min
        self.assertIsNone(self.fm._lagging_departure_trim(BREAKFAST, [short]))

    def test_identical_arrivals_or_missing_coords_refuse(self):
        same = dict(BREAKFAST, arrived_at=FLAT["arrived_at"])
        self.assertIsNone(self.fm._lagging_departure_trim(same, [FLAT]))
        nocoord = dict(BREAKFAST, latitude=None)
        self.assertIsNone(self.fm._lagging_departure_trim(nocoord, [FLAT]))

    def test_open_ended_earlier_row_refuses(self):
        open_row = dict(FLAT, departed_at=None)
        self.assertIsNone(self.fm._lagging_departure_trim(BREAKFAST, [open_row]))

    def test_twin_test_for_enrich_name_copy(self):
        self.assertFalse(self.fm._is_twin(BREAKFAST, FLAT))
        self.assertTrue(self.fm._is_twin(dict(BREAKFAST, **P(15.8, 6.1)), FLAT))
        self.assertTrue(self.fm._is_twin(dict(BREAKFAST, latitude=None), FLAT))

    def test_trim_note_keeps_the_old_departure(self):
        calls = []
        self.fm._update_location_row = lambda vid, upd: calls.append((vid, upd)) or True
        t = self.fm._lagging_departure_trim(BREAKFAST, [dict(FLAT, notes="[sweeper] x")])
        self.assertTrue(self.fm._apply_departure_trim(t))
        vid, upd = calls[0]
        self.assertEqual(vid, FLAT["id"])
        self.assertEqual(upd["departed_at"], BREAKFAST["arrived_at"])
        self.assertTrue(upd["notes"].startswith("[sweeper] x; [resolve-trim] departed_at 2026-10-03T08:41:42"))


if __name__ == "__main__":
    unittest.main()
