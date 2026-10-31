"""stop-identify-overnight-lodging — a night at the booked lodging is never asked.

A night's sleep at the booked rental triggered "Looking back to this morning,
around 02:43 — 02:43–09:56 (433 min) … which of these was it?" (a café, a bike
rental). A night at the booking must never trigger a question. Synthetic
places and coordinates.

The stay's position had been moved 38 m to its longest rest — the 54 minutes
the phone sat at the café after waking — so no earlier night was close enough
for the lodging rung, and the stop fell through to Places. These tests rebuild
that stay and pin: a long stay keeps its row when the rest is a slice of it;
another night of the same booking within 150 m names it the booking before any
venue rung; the first night is placed by the booking's street address (a model,
stubbed here); a duplicate row of the stay itself is not "another night"; short
stays and the user's own homes are unchanged.

Run: python3 tests/stop-identify-overnight-lodging.test.py
"""
import os
import sys
import types
import unittest
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "lib"))

# classify() imports places_nearby lazily for the venue rung; a fake keeps the
# test offline and gives the fall-through case two cafés to choose between.
_fake_places = types.ModuleType("places_nearby")
_fake_places.nearby = lambda lat, lon, radius=30, max_results=20: [
    {"name": "Example Cafe", "place_id": "p1", "distance_m": 4.0, "types": ["cafe"], "reviews": 300},
    {"name": "Example Bikes", "place_id": "p2", "distance_m": 9.0, "types": ["bicycle_store"], "reviews": 10},
]
sys.modules["places_nearby"] = _fake_places


def load(script, name):
    mod = type(sys)(name)
    mod.__dict__["__name__"] = name
    mod.__dict__["__file__"] = os.path.join(REPO, "bin", script)
    with open(os.path.join(REPO, "bin", script)) as fh:
        src = fh.read()
    exec(compile(src, script, "exec"), mod.__dict__)
    return mod


TZ = ZoneInfo("Asia/Jerusalem")
import math
ROW = (12.3456, -65.4321)                        # the visit row (iOS centroid)
CAFE = (ROW[0] - 13.7 / 111320.0,                # its longest rest: 09:00–09:56 at the café, ~38 m off
        ROW[1] + 35.6 / (111320.0 * math.cos(math.radians(ROW[0]))))
NAME = "Example St 4, Old Town"
BOOKING = {"name": NAME,
           "arrive_at": datetime(2026, 10, 1, 13, 25, tzinfo=timezone.utc),
           "depart_at": datetime(2026, 10, 31, 17, 5, tzinfo=timezone.utc)}


def visit(arrived="2026-10-17T23:43:25+00:00", departed="2026-10-18T06:56:46+00:00"):
    return {"id": "083c5ff8-ea3f-4a79-ab96-73e4984baaa1", "latitude": ROW[0], "longitude": ROW[1],
            "arrived_at": arrived, "departed_at": departed,
            "place_name": "4A Example Street", "place_type": "address"}


def night_row(rid, arrived, departed, lat=ROW[0] + 0.0003, lon=ROW[1]):
    return {"id": rid, "latitude": lat, "longitude": lon, "arrived_at": arrived, "departed_at": departed}


class OvernightAtTheBooking(unittest.TestCase):
    def setUp(self):
        si = load("stop-identify", "stop_identify_overnight")
        self.si = si
        self.calls = {"booking_lookups": 0, "address": []}
        self.rows = []
        si._context = lambda *a, **k: ""
        si._calendar_hint = lambda *a, **k: None
        si.match_named_location = lambda lat, lon: None
        si.match_named_location_by_address = lambda lat, lon, labels=None: None
        # From the café, the user's own answers there would name it.
        si.prior_confirmations = lambda lat, lon, key, exclude_id=None: ["Example Cafe"]
        si.repeat_stay_name = lambda *a, **k: None
        si.sleeps_here = lambda *a, **k: (0, [])
        si.scheduled_lodging = lambda day: None
        si.rest_anchor = lambda v, arr, dep: {"lat": CAFE[0], "lon": CAFE[1], "rest_min": 53.6, "moved_m": 38}
        si._get = lambda path, key: list(self.rows)

        def booking(day):
            self.calls["booking_lookups"] += 1
            return BOOKING
        si.scheduled_lodging_stay = booking

        def by_address(lat, lon, name, labels=None, run=None):
            self.calls["address"].append((lat, lon, name, list(labels or [])))
            return None
        si.match_booking_by_address = by_address

    def classify(self, v):
        return self.si.classify(v, "key", saved=[], tz=TZ)

    def test_the_night_is_the_booking_and_not_asked(self):
        self.rows = [night_row("n1", "2026-10-16T17:13:00+00:00", "2026-10-17T04:48:00+00:00")]
        out = self.classify(visit())
        self.assertEqual(out["verdict"], "skip-known")
        self.assertEqual(out["confidence"], "lodging-booked")
        self.assertEqual(out["name"], NAME)
        self.assertNotIn("options", out)
        # Measured from the row: the café hour is a slice of the night.
        self.assertEqual(out["anchor"]["source"], "row")
        self.assertEqual(out["anchor"]["rest_ignored"]["rest_min"], 53.6)
        self.assertEqual((out["lat"], out["lon"]), ROW)
        self.assertEqual(self.calls["address"], [], "an earlier night settles it without a model call")

    def test_a_night_near_only_the_rest_point_still_counts(self):
        # 200 m from the row but 10 m from the rest: either position is this stay.
        far_lat = ROW[0] + 200 / 111320.0
        self.si.rest_anchor = lambda v, arr, dep: {"lat": far_lat, "lon": ROW[1], "rest_min": 400, "moved_m": 200}
        self.rows = [night_row("n1", "2026-10-15T20:00:00+00:00", "2026-10-16T05:00:00+00:00",
                               lat=far_lat + 10 / 111320.0)]
        out = self.classify(visit())
        self.assertEqual(out["confidence"], "lodging-booked")
        self.assertEqual(out["anchor"]["source"], "rest", "a rest covering most of the stay still anchors it")

    def test_a_duplicate_row_of_this_stay_is_not_another_night(self):
        self.rows = [night_row("twin", "2026-10-17T23:43:26+00:00", "2026-10-18T06:56:40+00:00")]
        out = self.classify(visit())
        self.assertNotEqual(out.get("confidence"), "lodging-booked")
        self.assertEqual(len(self.calls["address"]), 1, "with no other night, the address is asked")

    def test_short_stays_and_far_nights_do_not_count(self):
        self.rows = [
            night_row("nap", "2026-10-16T12:00:00+00:00", "2026-10-16T14:00:00+00:00"),          # 2 h
            night_row("far", "2026-10-15T20:00:00+00:00", "2026-10-16T05:00:00+00:00",
                      lat=ROW[0] + 400 / 111320.0),                                               # 400 m
        ]
        nights = self.si.booked_nights_near([ROW, CAFE], "key", BOOKING,
                                            datetime(2026, 10, 17, 23, 43, tzinfo=timezone.utc),
                                            datetime(2026, 10, 18, 6, 56, tzinfo=timezone.utc))
        self.assertEqual(nights, set())

    def test_a_long_day_nearby_is_not_a_night(self):
        # 10:00–18:00 local, 100 m away: a day at a friend's, not where the user sleeps.
        self.rows = [night_row("day", "2026-10-16T07:00:00+00:00", "2026-10-16T15:00:00+00:00",
                               lat=ROW[0] + 100 / 111320.0)]
        out = self.classify(visit())
        self.assertNotEqual(out.get("confidence"), "lodging-booked")

    def test_a_night_split_into_a_short_piece_is_still_the_booking(self):
        # 02:43–05:43 local: under six hours, but it covers the small hours.
        self.rows = [night_row("n1", "2026-10-16T17:13:00+00:00", "2026-10-17T04:48:00+00:00")]
        out = self.classify(visit(arrived="2026-10-17T23:43:25+00:00", departed="2026-10-18T02:43:25+00:00"))
        self.assertEqual(out["verdict"], "skip-known")
        self.assertEqual(out["confidence"], "lodging-booked")

    def test_overlaps_night_reads_local_small_hours(self):
        on = self.si.overlaps_night
        utc = lambda *a: datetime(*a, tzinfo=timezone.utc)
        self.assertTrue(on(utc(2026, 10, 17, 23, 43), utc(2026, 10, 18, 6, 56), TZ))   # 02:43–09:56
        self.assertTrue(on(utc(2026, 10, 18, 2, 39), utc(2026, 10, 18, 11, 20), TZ))   # 05:39–14:20
        self.assertFalse(on(utc(2026, 10, 18, 7, 0), utc(2026, 10, 18, 15, 0), TZ))    # 10:00–18:00
        self.assertFalse(on(utc(2026, 10, 17, 17, 0), utc(2026, 10, 17, 22, 30), TZ))  # 20:00–01:30
        self.assertIsNone(on(utc(2026, 10, 18, 0, 0), utc(2026, 10, 18, 3, 0), None))

    def test_the_first_night_is_placed_by_the_bookings_address(self):
        self.rows = []
        self.si.match_booking_by_address = lambda lat, lon, name, labels=None, run=None: (
            self.calls["address"].append((lat, lon, name, list(labels or []))) or name)
        out = self.classify(visit())
        self.assertEqual(out["verdict"], "skip-known")
        self.assertEqual(out["confidence"], "lodging-booked")
        self.assertIn("first night", out["reason"])
        lat, lon, name, labels = self.calls["address"][0]
        self.assertEqual((lat, lon), ROW)
        self.assertEqual(name, NAME)
        self.assertEqual(labels, ["4A Example Street"], "the geocoder's label goes along, never the user's words")

    def test_no_booking_falls_through_as_before(self):
        self.si.scheduled_lodging_stay = lambda day: None
        out = self.classify(visit())
        self.assertEqual(out["verdict"], "choose")
        self.assertEqual(self.calls["address"], [])

    def test_own_home_outranks_the_booking(self):
        self.si.match_named_location = lambda lat, lon: ({"name": "Parents' home"}, 20.0)
        out = self.classify(visit())
        self.assertEqual(out["confidence"], "named_location")
        self.assertEqual(self.calls["booking_lookups"], 0)

    def test_a_short_stay_keeps_its_rest_anchor_and_skips_the_night_rung(self):
        # The booking is still looked up for the tap list (stop-identify-lodging-
        # candidate.test.py); the night rung itself must not run.
        night_rung = []
        self.si.overnight_at_booking = lambda *a, **k: night_rung.append(a)
        out = self.classify(visit(arrived="2026-10-18T09:00:00+00:00",
                                  departed="2026-10-18T10:06:00+00:00"))
        self.assertEqual(out["anchor"]["source"], "rest")
        self.assertEqual((out["lat"], out["lon"]), CAFE)
        self.assertEqual(night_rung, [])


class BookingAddressMatch(unittest.TestCase):
    def setUp(self):
        import place_naming
        self.pn = place_naming

    def test_passes_the_booking_and_labels_to_the_cli(self):
        seen = []
        out = self.pn.match_booking_by_address(
            12.3456, -65.4321, NAME, ["4A Example Street"],
            run=lambda cmd: seen.append(cmd) or '{"match": {"name": "Example St 4, Old Town"}}')
        self.assertEqual(out, NAME)
        cmd = seen[0]
        self.assertEqual(cmd[cmd.index("--booking") + 1], NAME)
        self.assertEqual(cmd[cmd.index("--label") + 1], "4A Example Street")

    def test_a_miss_or_a_broken_cli_names_nothing(self):
        self.assertIsNone(self.pn.match_booking_by_address(1, 2, "X", run=lambda c: '{"match": null}'))
        self.assertIsNone(self.pn.match_booking_by_address(1, 2, "X", run=lambda c: "not json"))
        self.assertIsNone(self.pn.match_booking_by_address(1, 2, "", run=lambda c: '{"match": {"name": ""}}'))


if __name__ == "__main__":
    unittest.main()
