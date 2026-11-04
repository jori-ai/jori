"""stop-identify-lodging-candidate — where the user is staying is always an answer on offer.

Right after a night at a rented flat, a "Looking back to this morning … which
of these was it?" offered a café and a bike rental, and the rental was not one
of the options. The booking has a label and no coordinates and Places never
returns a private flat, so no tap list could hold it. A 41-minute stop 30 m
from the flat went out as four unrelated businesses, and the user typed the
answer. Synthetic places and coordinates.

These tests pin: a stop within reach of the booking's nights gets the booking
as its first option (no default, since GPS cannot separate it from the café
downstairs); a stop with nothing named nearby gets it as the default; a night
nothing could place becomes one tap about the booking, not a café list; nights
elsewhere, a stay outside the booking's window, or no booking at all change
nothing; a stop the ladder already names silently stays silent.

Run: python3 tests/stop-identify-lodging-candidate.test.py
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

# classify() imports places_nearby lazily; each test sets VENUES.
VENUES = []
_fake_places = types.ModuleType("places_nearby")
_fake_places.nearby = lambda lat, lon, radius=30, max_results=20: list(VENUES)
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
M = 1 / 111320.0
FLAT = (12.3456, -65.4321)   # median of a month's nights at the rented flat
NAME = "Example St 4, Old Town"
BOOKING = {"name": NAME,
           "arrive_at": datetime(2026, 10, 1, 13, 25, tzinfo=timezone.utc),
           "depart_at": datetime(2026, 10, 31, 17, 5, tzinfo=timezone.utc)}
FOUR = [
    {"name": "Example Grill", "place_id": "v1", "distance_m": 6.0, "types": ["restaurant"], "reviews": 900},
    {"name": "Example Bar", "place_id": "v2", "distance_m": 12.0, "types": ["bar"], "reviews": 300},
    {"name": "Example Supplies", "place_id": "v3", "distance_m": 18.0, "types": ["store"], "reviews": 40},
    {"name": "Example Market", "place_id": "v4", "distance_m": 29.0, "types": ["store"], "reviews": 2},
]


def nights_at(lat, lon, days=(3, 4, 5, 6, 7)):
    """10-hour nights, 22:00–08:00 local, a few metres apart, as the client writes them."""
    return [{"id": f"n{d}", "latitude": lat + (d % 3) * 8 * M, "longitude": lon,
             "arrived_at": f"2026-10-{d:02d}T19:00:00+00:00",
             "departed_at": f"2026-10-{d + 1:02d}T05:00:00+00:00"} for d in days]


def stop(lat, lon, arrived="2026-10-09T11:06:00+00:00", departed="2026-10-09T11:47:00+00:00",
         label="6 Example Street"):
    return {"id": "ba0b3f5a-0000-0000-0000-000000000000", "latitude": lat, "longitude": lon,
            "arrived_at": arrived, "departed_at": departed,
            "place_name": label, "place_type": "address"}


class TheBookingOnOffer(unittest.TestCase):
    def setUp(self):
        global VENUES
        VENUES = list(FOUR)
        si = load("stop-identify", "stop_identify_lodging_candidate")
        self.si = si
        self.rows = nights_at(*FLAT) + [  # one stray fix, 220 m off, must not move the flat
            {"id": "stray", "latitude": FLAT[0] + 220 * M, "longitude": FLAT[1],
             "arrived_at": "2026-10-14T16:44:00+00:00", "departed_at": "2026-10-15T04:10:00+00:00"}]
        self.address = []
        self.address_says = None
        si._context = lambda *a, **k: ""
        si._calendar_hint = lambda *a, **k: None
        si._osm_fallback_candidates = lambda *a, **k: []
        si.match_named_location = lambda lat, lon: None
        si.match_named_location_by_address = lambda lat, lon, labels=None: None
        si.prior_confirmations = lambda lat, lon, key, exclude_id=None: []
        si.repeat_stay_name = lambda *a, **k: None
        si.sleeps_here = lambda *a, **k: (0, [])
        si.scheduled_lodging = lambda day: None
        si.rest_anchor = lambda v, arr, dep: None
        si._get = lambda path, key: list(self.rows)
        si.scheduled_lodging_stay = lambda day: BOOKING

        def by_address(lat, lon, name, labels=None, run=None):
            self.address.append((lat, lon, name, list(labels or [])))
            return self.address_says
        si.match_booking_by_address = by_address

    def classify(self, v):
        return self.si.classify(v, "key", saved=[], tz=TZ)

    def ids(self, out):
        return [o["id"] for o in out.get("options") or []]

    def test_a_stop_by_the_flat_offers_the_booking_first(self):
        out = self.classify(stop(FLAT[0] + 30 * M, FLAT[1]))
        self.assertEqual(out["verdict"], "choose")
        first = out["options"][0]
        self.assertEqual(first, {"id": "__lodging__", "label": NAME, "sublabel": "where you're staying"})
        # It takes the fourth venue's place; the escape hatches stay.
        self.assertEqual(self.ids(out), ["__lodging__", "v1", "v2", "v3", "__other__", "__passing__"])
        # GPS cannot tell the flat from the restaurant below it: no default.
        self.assertIsNone(out["default_id"])
        self.assertIn("other night(s) at Example St 4", out["reason"])
        self.assertEqual(self.address, [], "the user's nights placed the flat; no model call")

    def test_a_tap_on_it_stores_the_bookings_name(self):
        out = self.classify(stop(FLAT[0] + 30 * M, FLAT[1]))
        opt = out["options"][0]
        # choice-reply stores `value or label`: with no value, the booking's name.
        self.assertNotIn("value", opt)
        self.assertEqual(opt.get("value") or opt["label"], NAME)

    def test_a_cafe_across_the_market_is_not_offered_the_flat(self):
        out = self.classify(stop(FLAT[0] + 120 * M, FLAT[1]))
        self.assertEqual(out["verdict"], "choose")
        self.assertNotIn("__lodging__", self.ids(out))
        self.assertEqual(self.ids(out)[:4], ["v1", "v2", "v3", "v4"])
        self.assertEqual(out["default_id"], "v1", "the venue default is unchanged without the flat")

    def test_a_stop_by_the_stray_night_is_not_the_flat(self):
        out = self.classify(stop(FLAT[0] + 225 * M, FLAT[1]))
        self.assertNotIn("__lodging__", self.ids(out))

    def test_nothing_named_nearby_makes_the_booking_the_default(self):
        global VENUES
        VENUES = []
        out = self.classify(stop(FLAT[0] + 20 * M, FLAT[1]))
        self.assertEqual(out["verdict"], "ask")
        self.assertEqual(self.ids(out), ["__lodging__", "__other__"])
        self.assertEqual(out["default_id"], "__lodging__")

    def test_a_silent_stop_stays_silent(self):
        global VENUES
        VENUES = FOUR[:1]
        out = self.classify(stop(FLAT[0] + 20 * M, FLAT[1]))
        self.assertEqual(out["verdict"], "skip-known")
        self.assertEqual(out["confidence"], "singular")

    def test_the_calendar_shortlist_carries_it_too(self):
        self.si._calendar_hint = lambda *a, **k: {
            "source": "calendar_ambiguous", "address": "4 Example St",
            "shortlist": [{"name": "Example Cafe", "place_id": "c1"}, {"name": "Example Bikes", "place_id": "c2"}]}
        out = self.classify(stop(FLAT[0] + 20 * M, FLAT[1]))
        self.assertEqual(self.ids(out), ["c1", "c2", "__lodging__", "__other__"])

    def test_a_first_night_nothing_placed_is_one_tap_about_the_booking(self):
        self.rows = []
        global VENUES
        VENUES = FOUR[:1]   # a lone café must not name a night
        out = self.classify(stop(FLAT[0], FLAT[1], arrived="2026-10-01T20:30:00+00:00",
                                 departed="2026-10-02T05:05:00+00:00"))
        self.assertEqual(out["verdict"], "confirm")
        self.assertEqual(out["confidence"], "lodging-night")
        self.assertEqual(out["question"], f"Were you at {NAME}?")
        self.assertEqual(out["options"][0]["value"], NAME)
        self.assertEqual(out["default_id"], "__yes__")
        self.assertEqual(len(self.address), 1, "only the night rung's own address check")

    def test_own_answers_and_a_bed_slept_in_still_name_a_first_night(self):
        # The question about the booking comes after every rung that named a
        # night silently before it existed.
        self.rows = []
        night = dict(arrived="2026-10-01T20:30:00+00:00", departed="2026-10-02T05:05:00+00:00")
        self.si.prior_confirmations = lambda lat, lon, key, exclude_id=None: ["The rental"] * 2
        out = self.classify(stop(FLAT[0], FLAT[1], **night))
        self.assertEqual((out["verdict"], out["confidence"]), ("skip-known", "recurring"))
        self.si.prior_confirmations = lambda lat, lon, key, exclude_id=None: []
        self.si.sleeps_here = lambda *a, **k: (2, [])
        self.si.scheduled_lodging = lambda day: NAME
        out = self.classify(stop(FLAT[0], FLAT[1], **night))
        self.assertEqual((out["verdict"], out["confidence"]), ("skip-known", "lodging-booked"))

    def test_only_a_whole_night_is_the_booking_by_its_dates_alone(self):
        self.rows = []
        # 01:30–02:15 local at the airport on arrival night: it touches 2am, but
        # it is not where the user slept.
        out = self.classify(stop(FLAT[0] + 9000 * M, FLAT[1], arrived="2026-10-01T22:30:00+00:00",
                                 departed="2026-10-01T23:15:00+00:00"))
        self.assertNotEqual(out.get("confidence"), "lodging-night")
        self.assertNotIn("__lodging__", self.ids(out))
        # A long first day somewhere else (10:00–17:00 local) is not a night either.
        out = self.classify(stop(FLAT[0] + 9000 * M, FLAT[1], arrived="2026-10-02T07:00:00+00:00",
                                 departed="2026-10-02T14:00:00+00:00"))
        self.assertNotEqual(out.get("confidence"), "lodging-night")
        self.assertNotIn("__lodging__", self.ids(out))

    def test_a_night_with_the_bookings_nights_far_away_is_not_the_booking(self):
        self.rows = nights_at(FLAT[0] + 5000 * M, FLAT[1])
        out = self.classify(stop(FLAT[0], FLAT[1], arrived="2026-10-08T20:00:00+00:00",
                                 departed="2026-10-09T05:00:00+00:00"))
        self.assertNotEqual(out.get("confidence"), "lodging-night")
        self.assertEqual(out["verdict"], "choose")
        self.assertNotIn("__lodging__", self.ids(out))

    def test_a_night_before_check_in_is_not_the_booking(self):
        self.rows = []
        out = self.classify(stop(FLAT[0], FLAT[1], arrived="2026-10-01T01:00:00+00:00",
                                 departed="2026-10-01T09:00:00+00:00"))
        self.assertNotEqual(out.get("confidence"), "lodging-night")
        self.assertNotIn("__lodging__", self.ids(out))

    def test_the_first_day_is_placed_by_street_address(self):
        self.rows = []
        self.si.rest_anchor = lambda v, arr, dep: {"lat": FLAT[0] + 3 * M, "lon": FLAT[1], "rest_min": 30, "moved_m": 9}
        self.address_says = NAME
        v = stop(FLAT[0] + 12 * M, FLAT[1], arrived="2026-10-01T14:00:00+00:00",
                 departed="2026-10-01T15:10:00+00:00", label="4A Example Street")
        out = self.classify(v)
        self.assertEqual(self.ids(out)[0], "__lodging__")
        lat, lon, name, labels = self.address[0]
        self.assertEqual((lat, lon), (FLAT[0] + 3 * M, FLAT[1]), "read at the stop's anchor")
        self.assertEqual((name, labels), (NAME, ["4A Example Street"]))
        self.address_says = None
        self.address.clear()
        self.assertNotIn("__lodging__", self.ids(self.classify(v)))

    def test_no_booking_changes_nothing(self):
        self.si.scheduled_lodging_stay = lambda day: None
        out = self.classify(stop(FLAT[0] + 30 * M, FLAT[1]))
        self.assertEqual(self.ids(out)[:4], ["v1", "v2", "v3", "v4"])
        self.assertEqual(out["default_id"], "v1")

    def test_a_broken_lookup_builds_the_question_as_before(self):
        def boom(day):
            raise RuntimeError("supabase down")
        self.si.scheduled_lodging_stay = boom
        out = self.classify(stop(FLAT[0] + 30 * M, FLAT[1]))
        self.assertEqual(out["verdict"], "choose")
        self.assertNotIn("__lodging__", self.ids(out))

    def test_the_lookup_runs_once_per_stop(self):
        calls = []
        real = self.si.booked_lodging_option
        self.si.booked_lodging_option = lambda *a, **k: calls.append(1) or real(*a, **k)
        self.rows = nights_at(FLAT[0] + 5000 * M, FLAT[1])
        self.classify(stop(FLAT[0], FLAT[1], arrived="2026-10-08T20:00:00+00:00",
                           departed="2026-10-09T05:00:00+00:00"))
        self.assertEqual(len(calls), 1, "the night rung's answer is reused by the tap list")


if __name__ == "__main__":
    unittest.main()
