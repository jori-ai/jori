#!/usr/bin/env python3
"""day-segments-turnaround.test.py — the far end of a drive out and back is a stop.

Driving to a place and returning without a stop makes that turning-around
point a destination worth asking about, when the purpose of the drive is not
already known. The case: an airport drop-off run (the third one saved by hand).

The phone logged a fix every five minutes, each tagged `driving`, and never
rested, so day-segments saw one out-and-back move and no stop. The fixes below
are that trace's shape (UTC; local was +2h) at synthetic places
(tests/fixtures/fake_geo.py), with the airport terminal at TERMINAL.

Run: python3 tests/day-segments-turnaround.test.py
"""
import os, sys, unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, "fixtures"))
from fake_geo import at as G  # noqa: E402
mod = type(sys)("daysegments")
exec(compile(open(os.path.join(REPO, "bin", "day-segments")).read(), "day-segments", "exec"),
     mod.__dict__)

FLAT = G(0, 0)
TERMINAL = G(10999.25, -5911.27)


def east(m):
    """(lat, lon) `m` metres east of the flat."""
    return G(m, 0)


def t(hms, day=28):
    h, m, s = (int(x) for x in hms.split(":"))
    return datetime(2026, 10, day, h, m, s, tzinfo=timezone.utc)


def fx(hms, lat, lon):
    return {"t": t(hms), "lat": lat, "lon": lon}


# The trace: the flat, the drive out, the airport roads, the drive home.
AIRPORT_RUN = [
    fx("03:14:13", *FLAT), fx("03:20:44", *FLAT), fx("03:20:48", *FLAT),
    fx("03:40:47", *G(272.32, -36.02)), fx("03:45:58", *G(1535.7, -1088.47)),
    fx("03:50:59", *G(2977.05, -698.75)), fx("03:55:59", *G(6901.99, -4385.41)),
    fx("04:00:59", *G(12411.08, -7192.28)), fx("04:06:34", *G(12286.28, -6699.09)),
    fx("04:11:34", *G(10929.13, -5842.87)), fx("04:16:34", *G(13315.06, -7163.54)),
    fx("04:21:35", *G(8335.8, -5516.3)), fx("04:26:35", *G(5137.87, -3874.5)),
    fx("04:31:36", *G(3291.47, -2142.74)), fx("04:36:36", *G(675.28, -1570.66)),
    fx("04:41:36", *G(789.05, 170.58)), fx("04:44:34", *G(129.97, 163.58)),
    fx("04:44:39", *G(74.27, 68.79)), fx("04:46:37", *G(27.38, -14.53)),
    fx("05:03:39", *FLAT), fx("05:18:52", *FLAT), fx("06:01:09", *FLAT),
]


def stop(a, b, name="The Harbor Flat"):
    return {"start": t(a), "end": t(b), "minutes": (t(b) - t(a)).total_seconds() / 60,
            "place": {"name": name}, "centroid": FLAT}


# The flat on either side, the way the day's real stops sit around the drive.
FLAT_STOPS = [stop("00:00:00", "03:20:48"), stop("04:44:39", "06:15:00")]


def miles(a, b):
    return mod.meters(a, b)


class Turnaround(unittest.TestCase):
    def test_airport_run_is_a_stop_at_its_far_end(self):
        got = mod.turnaround_stops(AIRPORT_RUN, FLAT_STOPS)
        self.assertEqual(len(got), 1)
        r = got[0]
        # the window the hand-saved airport stop used: 06:00:59-06:16:34 local
        self.assertEqual((r["start"], r["end"]), (t("04:00:59"), t("04:16:34")))
        self.assertAlmostEqual(r["minutes"], 15.6, places=1)
        self.assertTrue(r["turnaround"])
        self.assertGreater(r["away_m"], 10_000)
        # the mean of the fixes lands within the shortlist radius of the terminal
        self.assertLess(miles(r["centroid"], TERMINAL), 2500)

    def test_it_has_what_reconcile_writes(self):
        r = mod.turnaround_stops(AIRPORT_RUN, FLAT_STOPS)[0]
        for k in ("start", "end", "minutes", "n", "n_in", "place", "motion", "centroid", "worst_m"):
            self.assertIn(k, r)
        self.assertEqual(r["place"]["_rung"], "turnaround")

    def test_a_walk_out_and_back_is_not_a_drive(self):
        # 2 km out and back at 4.5 km/h, a fix every 5 min: no ride leg, and
        # day-excursions owns walks.
        step = 320.79   # metres
        fixes, clock = [fx("10:00:00", *FLAT)], t("10:00:00")
        for i in range(1, 8):
            clock += timedelta(minutes=5)
            fixes.append({"t": clock, "lat": east(step * i)[0], "lon": east(step * i)[1]})
        for i in range(6, -1, -1):
            clock += timedelta(minutes=5)
            fixes.append({"t": clock, "lat": east(step * i)[0], "lon": east(step * i)[1]})
        stops = [stop("09:00:00", "10:00:00"), stop("11:10:00", "12:00:00")]
        self.assertEqual(mod.turnaround_stops(fixes, stops), [])

    def test_a_one_way_trip_is_not_a_loop(self):
        fixes = [f for f in AIRPORT_RUN if f["t"] <= t("04:16:34")]
        self.assertEqual(mod.turnaround_stops(fixes, [stop("00:00:00", "03:20:48")]), [])

    def test_a_stop_at_the_destination_means_there_is_no_turnaround(self):
        # airport recorded as a stop: the run is split in two, neither closes.
        stops = FLAT_STOPS + [stop("04:00:59", "04:16:34", "Example Airport")]
        self.assertEqual(mod.turnaround_stops(AIRPORT_RUN, stops), [])

    def test_touching_the_far_point_briefly_is_a_u_turn_not_a_destination(self):
        # 17 km out and back at highway speed, a fix every 5 min (~5.6 km apart):
        # one fix at the far end, its neighbours well outside 3 km. Nothing says
        # the user was anywhere for 8 minutes.
        step = 5661.01   # metres
        fixes, clock = [fx("10:00:00", *FLAT)], t("10:00:00")
        for i in list(range(1, 4)) + [2, 1]:
            clock += timedelta(minutes=5)
            fixes.append({"t": clock, "lat": east(step * i)[0], "lon": east(step * i)[1]})
        clock += timedelta(minutes=5)
        fixes.append({"t": clock, "lat": FLAT[0], "lon": FLAT[1]})
        stops = [stop("08:00:00", "10:00:00"), stop("10:30:00", "12:00:00")]
        self.assertEqual(mod.turnaround_stops(fixes, stops), [])
        # ...and the same drive with the phone lingering at the far end is a destination
        far = east(step * 3)
        fixes[3:3] = [{"t": fixes[3]["t"] + timedelta(minutes=2), "lat": far[0], "lon": far[1]},
                      {"t": fixes[3]["t"] + timedelta(minutes=9), "lat": far[0], "lon": far[1]}]
        fixes = sorted(fixes, key=lambda f: f["t"])
        self.assertEqual(len(mod.turnaround_stops(fixes, [stop("08:00:00", "10:00:00"), stop("11:00:00", "12:00:00")])), 1)

    def test_a_silence_mid_trip_does_not_close_a_loop(self):
        fixes = [dict(f) for f in AIRPORT_RUN]
        for f in fixes:                      # the phone goes quiet 40 min at the far end
            if f["t"] >= t("04:21:35"):
                f["t"] = f["t"] + timedelta(minutes=40)
        stops = [stop("00:00:00", "03:20:48"), stop("05:24:39", "07:00:00")]
        self.assertEqual(mod.turnaround_stops(fixes, stops), [])

    def test_a_short_hop_is_not_far_enough(self):
        # a 1 km drive to the shop and back, with a fix at the far end
        shop = east(622.71)
        fixes = [fx("10:00:00", *FLAT), fx("10:05:00", *shop),
                 fx("10:15:00", *shop), fx("10:22:00", *shop),
                 fx("10:30:00", *FLAT)]
        self.assertEqual(mod.turnaround_stops(fixes, [stop("08:00:00", "10:00:00"), stop("10:30:00", "12:00:00")]), [])

    def test_the_loop_is_reported_as_the_two_legs_either_side(self):
        chosen = sorted(FLAT_STOPS + mod.turnaround_stops(AIRPORT_RUN, FLAT_STOPS), key=lambda r: r["start"])
        moves = mod.moves_between(AIRPORT_RUN, chosen)
        self.assertFalse(any(m["loop"] and m["motion"]["mode"] == "vehicle" for m in moves))


class SleepingPhoneAtHome(unittest.TestCase):
    """An airport pick-up: the last fix at the flat was 01:13, the next 01:44
    already 792 m down the road. Distances below are metres from the flat
    along one line; the hand-saved airport stop was 02:02:16-02:18:48."""
    RUN = [("01:44:38", 792), ("01:47:15", 1888), ("01:52:15", 4699), ("01:57:16", 11650),
           ("02:02:16", 15360), ("02:08:47", 14869), ("02:13:47", 12498), ("02:18:48", 14052),
           ("02:23:49", 11879), ("02:28:49", 3967), ("02:33:49", 1875), ("02:38:49", 574),
           ("02:40:56", 187), ("02:43:50", 31)]

    def fixes(self):
        out = [{"t": t("00:13:55", 16), "lat": FLAT[0], "lon": FLAT[1]},
               {"t": t("01:13:39", 16), "lat": FLAT[0], "lon": FLAT[1]}]
        for hms, d in self.RUN:
            out.append({"t": t(hms, 16), "lat": east(d)[0], "lon": east(d)[1]})
        out.append({"t": t("02:49:12", 16), "lat": east(39)[0], "lon": east(39)[1]})
        return out

    def stops(self):
        return [{"start": t("00:13:55", 16), "end": t("01:13:39", 16), "minutes": 60,
                 "place": {"name": "The Harbor Flat"}, "centroid": FLAT},
                {"start": t("02:49:12", 16), "end": t("04:00:00", 16), "minutes": 70,
                 "place": {"name": "The Harbor Flat"}, "centroid": FLAT}]

    def test_a_run_that_starts_down_the_road_still_closes(self):
        got = mod.turnaround_stops(self.fixes(), self.stops())
        self.assertEqual(len(got), 1)
        self.assertEqual((got[0]["start"], got[0]["end"]), (t("02:02:16", 16), t("02:18:48", 16)))

    def test_a_one_way_drive_of_that_length_does_not(self):
        fx_ = [f for f in self.fixes() if f["t"] <= t("02:18:48", 16)]
        self.assertEqual(mod.turnaround_stops(fx_, self.stops()[:1]), [])


class ReconcileTurnaround(unittest.TestCase):
    def setUp(self):
        self.r = mod.turnaround_stops(AIRPORT_RUN, FLAT_STOPS)[0]
        self.writes = []
        mod.write_req = lambda path, method, body=None: self.writes.append((path, method, body))

    def run_it(self, rows, apply=True):
        acted = []
        mod.reconcile_turnaround(self.r, rows, acted, apply)
        return acted[0][1], acted[0][2]

    def row(self, **kw):
        return {"id": "11111111-aaaa", "latitude": self.r["centroid"][0], "longitude": self.r["centroid"][1],
                "source": None, "place_type": "address", "notes": None, "place_name": "Airport Example Road", **kw}

    def test_inserts_with_the_token_and_no_name_of_a_place(self):
        # the flat's stay, stretched over the whole drive by a late departure, is 15 km away
        stretched = self.row(id="22222222-bbbb", latitude=FLAT[0], longitude=FLAT[1], place_type="segment-derived",
                             source="day-segments", place_name="The Harbor Flat")
        what, _ = self.run_it([stretched])
        self.assertEqual(what, "insert")
        path, method, body = self.writes[0]
        self.assertEqual((path, method), ("location_history", "POST"))
        self.assertIn(mod.TURNAROUND_TOKEN, body["notes"])
        self.assertEqual(body["place_type"], "segment-derived")
        self.assertEqual(body["place_name"], mod.TURN_NAME)

    def test_a_row_already_recording_a_stop_there_is_left_alone(self):
        what, _ = self.run_it([self.row()])
        self.assertEqual(what, "skip")
        self.assertEqual(self.writes, [])

    def test_a_settled_row_is_never_overwritten(self):
        for ptype in ("user-confirmed", "named", "non-stop", "default-applied"):
            self.writes.clear()
            what, _ = self.run_it([self.row(place_type=ptype, source="day-segments",
                                            notes=f"{mod.TURNAROUND_TOKEN} was ours")])
            self.assertEqual(what, "skip", ptype)
            self.assertEqual(self.writes, [], ptype)

    def test_its_own_unanswered_row_is_updated_in_place(self):
        own = self.row(place_type="segment-derived", source="day-segments", place_name=mod.TURN_NAME,
                       notes=f"{mod.TURNAROUND_TOKEN} earlier run")
        what, _ = self.run_it([own])
        self.assertEqual(what, "update")
        self.assertEqual(self.writes[0][1], "PATCH")

    def test_dry_run_writes_nothing(self):
        self.run_it([], apply=False)
        self.assertEqual(self.writes, [])


class Agreement(unittest.TestCase):
    def test_every_reader_uses_the_same_token(self):
        # the writer, stop-passage, stop-identify and resolve-day match one string
        for rel in ("bin/stop-identify", "lib/stop-passage.mjs", "lib/resolve-day.js"):
            with open(os.path.join(REPO, rel)) as fh:
                src = fh.read()
            self.assertIn(f'"{mod.TURNAROUND_TOKEN}"', src, rel)


if __name__ == "__main__":
    unittest.main()
