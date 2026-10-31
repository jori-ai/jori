#!/usr/bin/env python3
"""An answer about a stop renames that stop's rows, not the stay it sat inside
Confirming a café for 10:18-10:57 one morning also renamed
the flat's 05:39-14:20 visit row, because the overlap clause took any row sharing
five minutes within 500 m. One visit's twin shares most of BOTH windows; a stay
that merely contains the stop does not. The case the clause exists for
(a twin whose centroid was smeared 320 m away) still matches.

Run: python3 tests/location-confirm-stop-in-stay.test.py
"""
import io, json, os, sys, unittest
from contextlib import redirect_stderr

# Synthetic coordinates: metres east/north of an obviously fake origin, so the
# fixtures keep the real traces' geometry without pinning a real place.
import math as _fake_math
_FAKE_ORIGIN = (12.3456, -65.4321)
_FAKE_M_PER_DEG = 6371000 * _fake_math.pi / 180


def fake_pt(e, n):
    lat = _FAKE_ORIGIN[0] + n / _FAKE_M_PER_DEG
    return (lat, _FAKE_ORIGIN[1] + e / (_FAKE_M_PER_DEG * _fake_math.cos(_fake_math.radians(lat))))


def fake_at(e, n):
    lat, lon = fake_pt(e, n)
    return {"lat": lat, "lon": lon}


def fake_row(e, n):
    lat, lon = fake_pt(e, n)
    return {"latitude": lat, "longitude": lon}


def fake_kw(e, n):
    return fake_at(e, n)

# A stand-in project URL: the module builds REST URLs at load; every call is stubbed.
os.environ.setdefault("SUPABASE_URL", "https://example-project.supabase.co")
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), "bin", "location-confirm")

CAFE = fake_pt(39.87, -11.79)
ROWS = [
    {"id": "e9b495dd", "latitude": CAFE[0], "longitude": CAFE[1],          # the café row itself
     "arrived_at": "2026-10-16T07:18:57+00:00", "departed_at": "2026-10-16T07:57:21+00:00"},
    {"id": "7af07d6a", **fake_row(0, 0),      # the flat, 41 m, 05:39-14:20
     "arrived_at": "2026-10-16T02:39:30+00:00", "departed_at": "2026-10-16T11:20:09+00:00"},
    {"id": "twin-far", **fake_row(39.58, 304.67),      # same visit, centroid smeared 320 m
     "arrived_at": "2026-10-16T07:05:00+00:00", "departed_at": "2026-10-16T07:55:00+00:00"},
]
ASK = {"ask_id": "lc-visit-e9b495dd", "centroid": {"lat": CAFE[0], "lon": CAFE[1]}, "exact_window": True,
       "first_sample_ts": "2026-10-16T07:18:57+00:00", "last_sample_ts": "2026-10-16T07:57:21+00:00"}


class FakeResp(io.BytesIO):
    status = 204
    def __enter__(self): return self
    def __exit__(self, *a): return False


class StopInStay(unittest.TestCase):
    def setUp(self):
        lc = self.lc = type(sys)("lc")
        lc.__dict__["__file__"] = SCRIPT
        exec(compile(open(SCRIPT).read(), "location-confirm", "exec"), lc.__dict__)
        lc._supabase_key = lambda: "k"
        self.patched = []
        real = lc.urllib.request.urlopen

        def fake(req, timeout=None):
            if getattr(req, "method", None) == "PATCH":
                self.patched.append(req.full_url.split("id=eq.")[1])
                return FakeResp(b"")
            return FakeResp(json.dumps(ROWS).encode())
        lc.urllib.request.urlopen = fake
        self.addCleanup(setattr, lc.urllib.request, "urlopen", real)

    def patch(self):
        with redirect_stderr(io.StringIO()):
            return self.lc._patch_location_history(dict(ASK), "Corner Cafe", "findme_resolve")

    def test_the_stay_around_the_stop_keeps_its_own_name(self):
        self.assertTrue(self.patch())
        self.assertIn("e9b495dd", self.patched)
        self.assertNotIn("7af07d6a", self.patched, "the flat's morning is not the café")

    def test_a_smeared_twin_of_the_same_visit_still_matches(self):
        self.patch()
        self.assertIn("twin-far", self.patched)

    def test_his_answer_for_the_stay_leaves_the_stop_inside_it_alone(self):
        flat_ask = {"ask_id": "lc-visit-7af07d6a", "centroid": {**fake_at(0, 0)}, "exact_window": True,
                    "first_sample_ts": "2026-10-16T02:39:30+00:00", "last_sample_ts": "2026-10-16T11:20:09+00:00"}
        with redirect_stderr(io.StringIO()):
            self.lc._patch_location_history(flat_ask, "The Rental Flat", "findme_resolve")
        self.assertIn("7af07d6a", self.patched)
        self.assertNotIn("e9b495dd", self.patched, "the café inside the morning keeps his answer")

    def test_a_card_answer_keeps_the_full_reach(self):
        """2026-08-04: a card's window, smeared 319 m by the walk in, still names a
        73-minute visit row it only partly overlaps."""
        global ROWS
        keep = ROWS
        ROWS = [{"id": "venue", **fake_row(38.64, 304.67),
                 "arrived_at": "2026-10-16T07:30:00+00:00", "departed_at": "2026-10-16T08:43:00+00:00"}]
        try:
            card = {"ask_id": "lc-20261016-0700", "centroid": {**fake_at(38.64, -6.67)},
                    "first_sample_ts": "2026-10-16T07:00:00+00:00", "last_sample_ts": "2026-10-16T07:50:00+00:00"}
            with redirect_stderr(io.StringIO()):
                self.lc._patch_location_history(card, "Land&Monkeys", "user")
            self.assertIn("venue", self.patched)
        finally:
            ROWS = keep

    def test_the_open_row_of_a_live_stop_is_still_named(self):
        """save-current: the ask window starts on the walk in; the venue's row is open."""
        global ROWS
        keep = ROWS
        ROWS = [{"id": "open", "latitude": CAFE[0], "longitude": CAFE[1],
                 "arrived_at": "2026-10-16T07:40:00+00:00", "departed_at": None}]
        try:
            live = dict(ASK, first_sample_ts="2026-10-16T07:00:00+00:00", last_sample_ts="2026-10-16T08:30:00+00:00")
            with redirect_stderr(io.StringIO()):
                self.lc._patch_location_history(live, "Corner Cafe", "user_stated_direct")
            self.assertIn("open", self.patched)
        finally:
            ROWS = keep

    def test_a_walk_in_judged_not_a_stop_is_not_renamed_by_nearness(self):
        """2026-10-19: "Aricha Sabich" for 15:58-16:31 also renamed the open walk-in
        row from 15:47, 273 m away, that stop-passage had marked non-stop."""
        global ROWS
        keep = ROWS
        ROWS = [
            {"id": "0be0a80c", **fake_row(43323.3, -29885.86), "place_type": "address",
             "arrived_at": "2026-10-19T12:58:15+00:00", "departed_at": "2026-10-19T13:31:08+00:00"},
            {"id": "646abd98", **fake_row(43449.09, -30129.38), "place_type": "non-stop",
             "arrived_at": "2026-10-19T12:47:16+00:00", "departed_at": None},
            {"id": "twin-ns", **fake_row(43323.3, -29885.86), "place_type": "non-stop",
             "arrived_at": "2026-10-19T12:58:15+00:00", "departed_at": "2026-10-19T13:31:08+00:00"},
        ]
        try:
            ask = {"ask_id": "lc-visit-0be0a80c", "centroid": {**fake_at(43323.3, -29885.86)}, "exact_window": True,
                   "first_sample_ts": "2026-10-19T12:58:15+00:00", "last_sample_ts": "2026-10-19T13:31:08+00:00"}
            with redirect_stderr(io.StringIO()):
                self.lc._patch_location_history(ask, "Aricha Sabich", "findme_resolve")
            self.assertIn("0be0a80c", self.patched)
            self.assertNotIn("646abd98", self.patched, "the walk in is not the sabich stall")
            self.assertIn("twin-ns", self.patched, "a twin he names over a pipeline verdict still takes his answer")
        finally:
            ROWS = keep

    def test_a_stop_inside_a_stay_that_began_minutes_earlier_leaves_the_stay(self):
        """2026-10-23: "Asufa" for the 14:16-14:25 visit also renamed both rows of the
        14:12-17:35 afternoon at the flat 34 m away: they arrived 4 minutes before the
        shop, inside the proximity clause's ±30 min arrival window."""
        global ROWS
        keep = ROWS
        ROWS = [
            {"id": "0533c86f", **fake_row(119.81, 19.96),
             "arrived_at": "2026-10-22T11:16:52+00:00", "departed_at": "2026-10-22T11:25:28+00:00"},
            {"id": "f90ec82f", **fake_row(36.61, -3.19),
             "arrived_at": "2026-10-22T11:12:33+00:00", "departed_at": "2026-10-22T14:35:58+00:00"},
            {"id": "71755bd8", **fake_row(36.61, -3.19),
             "arrived_at": "2026-10-22T11:12:33+00:00", "departed_at": "2026-10-22T14:35:36+00:00"},
            {"id": "twin-same-arrival", **fake_row(119.81, 19.96),
             "arrived_at": "2026-10-22T11:16:52+00:00", "departed_at": "2026-10-22T11:16:56+00:00"},
        ]
        try:
            ask = {"ask_id": "lc-visit-0533c86f", "centroid": {**fake_at(119.81, 19.96)},
                   "exact_window": True,
                   "first_sample_ts": "2026-10-22T11:16:52+00:00", "last_sample_ts": "2026-10-22T11:25:28+00:00"}
            with redirect_stderr(io.StringIO()):
                self.lc._patch_location_history(ask, "Asufa", "findme_resolve")
            self.assertIn("0533c86f", self.patched)
            self.assertNotIn("f90ec82f", self.patched, "the afternoon at the flat is not the shop")
            self.assertNotIn("71755bd8", self.patched, "the afternoon at the flat is not the shop")
            self.assertIn("twin-same-arrival", self.patched, "an iOS twin sharing its arrival still takes his answer")
        finally:
            ROWS = keep

    def test_a_stay_opening_on_the_same_second_elsewhere_keeps_its_name(self):
        """The user's name for an 08:49-08:58 bakery visit also renamed the
        08:49-13:47 row of the morning at the flat, 206 m away: iOS opened all three
        rows on the same second, so the stay needed no minute's lead to slip past
        `outer`. The bakery's own twin, on the same point, still takes his answer;
        an answer for the flat's stay leaves the bakery rows alone."""
        global ROWS
        keep = ROWS
        bakery, flat = fake_pt(110.72, 188.16), fake_pt(-4.71, 17.24)
        ROWS = [
            {"id": "00b0f33d", "latitude": bakery[0], "longitude": bakery[1],
             "arrived_at": "2026-10-23T05:49:46+00:00", "departed_at": "2026-10-23T05:58:07+00:00"},
            {"id": "202b45fc", "latitude": bakery[0], "longitude": bakery[1],
             "arrived_at": "2026-10-23T05:49:46+00:00", "departed_at": "2026-10-23T06:01:42+00:00"},
            {"id": "b0d0988b", "latitude": flat[0], "longitude": flat[1],
             "arrived_at": "2026-10-23T05:49:46+00:00", "departed_at": "2026-10-23T10:47:39+00:00"},
        ]
        try:
            ask = {"ask_id": "lc-visit-00b0f33d", "centroid": {"lat": bakery[0], "lon": bakery[1]},
                   "exact_window": True,
                   "first_sample_ts": "2026-10-23T05:49:46+00:00", "last_sample_ts": "2026-10-23T05:58:07+00:00"}
            with redirect_stderr(io.StringIO()):
                self.lc._patch_location_history(ask, "Corner Bakery", "findme_resolve")
            self.assertIn("00b0f33d", self.patched)
            self.assertIn("202b45fc", self.patched, "the bakery's twin on the same point takes his answer")
            self.assertNotIn("b0d0988b", self.patched, "the morning at the flat is not the bakery")
            self.patched.clear()
            flat_ask = {"ask_id": "lc-visit-b0d0988b", "centroid": {"lat": flat[0], "lon": flat[1]},
                        "exact_window": True,
                        "first_sample_ts": "2026-10-23T05:49:46+00:00", "last_sample_ts": "2026-10-23T10:47:39+00:00"}
            with redirect_stderr(io.StringIO()):
                self.lc._patch_location_history(flat_ask, "The Rental Flat", "findme_resolve")
            self.assertEqual(self.patched, ["b0d0988b"], "the bakery inside the morning keeps his answer")
        finally:
            ROWS = keep

    def test_kill_switch_restores_the_old_reach(self):
        os.environ["LC_OVERLAP_SHARE"] = "0"
        try:
            self.patch()
            self.assertIn("7af07d6a", self.patched)
        finally:
            del os.environ["LC_OVERLAP_SHARE"]


if __name__ == "__main__":
    unittest.main()
