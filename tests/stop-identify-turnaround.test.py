#!/usr/bin/env python3
"""stop-identify-turnaround.test.py — the question asked about the far end of a drive.

A drive out and back makes the turning-around point a destination worth
asking about, if the purpose of the drive is not already known.
bin/day-segments writes the row; this is the question on it.

The Places stub reproduces an airport run: the terminal sat 1.7 km from the
mean of the fixes, behind a café, a car park and a hotel that were all nearer.
Synthetic places and coordinates.

Run: python3 tests/stop-identify-turnaround.test.py
"""
import os, sys, types, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

CANDS = [
    {"name": "Example Cafe", "distance_m": 310, "primary_type": "cafe", "types": ["cafe", "food"],
     "type_display": "Cafe", "reviews": 120, "place_id": "p1"},
    {"name": "Example Car Park", "distance_m": 520, "primary_type": "parking", "types": ["parking"],
     "type_display": "Parking", "reviews": 40, "place_id": "p2"},
    {"name": "9 Example Road", "distance_m": 600, "primary_type": "street_address", "types": ["street_address"],
     "type_display": "Address", "reviews": 0, "place_id": "p3"},
    {"name": "Example International Airport", "distance_m": 1700, "primary_type": "airport", "types": ["airport", "point_of_interest"],
     "type_display": "Airport", "reviews": 98000, "place_id": "p4"},
    {"name": "Example Railway Station", "distance_m": 2100, "primary_type": "train_station", "types": ["train_station"],
     "type_display": "Train station", "reviews": 3000, "place_id": "p5"},
    {"name": "Example Hotel", "distance_m": 900, "primary_type": "lodging", "types": ["lodging"],
     "type_display": "Hotel", "reviews": 500, "place_id": "p6"},
]
calls = []
stub = types.ModuleType("places_nearby")
stub.nearby = lambda lat, lon, radius=40, max_results=20, **kw: (calls.append(radius) or list(CANDS))
sys.modules["places_nearby"] = stub

SRC = os.path.join(REPO, "bin", "stop-identify")
mod = type(sys)("stopidentify")
mod.__file__ = SRC          # the script locates calendar-at next to itself
with open(SRC) as fh:
    exec(compile(fh.read(), SRC, "exec"), mod.__dict__)


ORIG_OSM = mod._osm_fallback_candidates


class AskTurnaround(unittest.TestCase):
    def setUp(self):
        stub.nearby = lambda lat, lon, radius=40, max_results=20, **kw: (calls.append(radius) or list(CANDS))
        mod._osm_fallback_candidates = ORIG_OSM

    def ask(self, ctx="06:00–06:16 (16 min), after The rental"):
        out = {"id": "v1"}
        return mod._ask_turnaround(out, 12.3456, -65.4321, ctx)

    def test_the_airport_leads_even_though_it_is_not_the_nearest(self):
        r = self.ask()
        labels = [o["label"] for o in r["options"]]
        self.assertEqual(labels[0], "Example International Airport")
        self.assertEqual(labels[1], "Example Railway Station")      # a station is a destination here

    def test_noise_is_not_offered(self):
        labels = [o["label"] for o in self.ask()["options"]]
        self.assertNotIn("9 Example Road", labels)           # an address is the question restated
        self.assertNotIn("Example Hotel", labels)                   # lodging
        self.assertNotIn("Example Car Park", labels)       # parking

    def test_the_user_can_say_it_was_somewhere_else_or_just_a_drive(self):
        opts = self.ask()["options"]
        self.assertEqual(opts[-2]["value"], mod.OTHER_VALUE)
        self.assertEqual(opts[-1]["value"], "not a stop")
        self.assertLessEqual(len(opts), mod.MAX_CHOICES + 1)

    def test_no_default_because_silence_applies_one(self):
        r = self.ask()
        self.assertIsNone(r["default_id"])
        self.assertEqual(r["verdict"], "choose")

    def test_it_searches_wide(self):
        calls.clear()
        self.ask()
        self.assertEqual(calls, [mod.TURNAROUND_PLACE_RADIUS_M])
        self.assertGreaterEqual(mod.TURNAROUND_PLACE_RADIUS_M, 2000)

    def test_the_prompt_says_what_happened_not_where_was_this(self):
        p = self.ask()["prompt"]
        self.assertTrue(p.startswith("06:00–06:16 (16 min), after The rental — "))
        self.assertIn("drove out", p)
        self.assertNotIn("Where was this", p)

    def test_the_floor_matches_what_findme_resolve_will_name(self):
        self.assertEqual(mod.TURNAROUND_MIN_MIN, 8.0)
        self.assertLess(mod.TURNAROUND_MIN_MIN, mod.MIN_STOP_MIN)

    def test_a_drive_to_a_place_with_no_candidates_still_asks(self):
        stub.nearby = lambda *a, **k: []
        mod._osm_fallback_candidates = lambda *a, **k: []
        r = self.ask()
        self.assertEqual([o["value"] for o in r["options"]], [mod.OTHER_VALUE, "not a stop"])


if __name__ == "__main__":
    unittest.main()
