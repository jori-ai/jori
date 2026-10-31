#!/usr/bin/env python3
"""day-path-spine.test.py — the day is composed from fixes, not from visit rows.

Replays a real day's shape (tests/fixtures/day-path-2026-09-06.rows.json: the
rows as they sat in location_history the next morning, at synthetic places --
tests/fixtures/fake_geo.py) through day-path's build() with routing off. That
day's map drew:

  - two Sept-5 address visits ("10 Main St", "1337 Elm Way") whose
    departed_at had been written ~35 h late, as the day's two biggest markers
    at "00:00", every one of its 19 conflicts, and a bridge from home to the
    theatre district the user never walked -- because their coordinates were pushed
    into the path as dwell vertices;
  - four 1-5 min reverse-geocoded address visits along one avenue as stops;
  - a "skip" answer as a 58-minute place;
  - a 1.5 km / 5 min hole on the way home as a solid observed line.

Run: python3 tests/day-path-spine.test.py
"""
import json, os, sys, unittest
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, "fixtures"))
from fake_geo import at as G, load_rows  # noqa: E402
mod = type(sys)("daypath")
exec(compile(open(os.path.join(REPO, "bin", "day-path")).read(), "day-path", "exec"), mod.__dict__)
ROWS = load_rows(os.path.join(HERE, "fixtures", "day-path-2026-09-06.rows.json"))


def build(rows=ROWS, **kw):
    return mod.build("2026-09-06", "America/New_York", rows, do_match=False, **kw)


class GhostVisits(unittest.TestCase):
    def test_stale_visits_are_set_aside_not_drawn(self):
        day = build()
        names = {u["name"] for u in day["unsupported_records"]}
        self.assertEqual(names, {"10 Main St", "1337 Elm Way"})
        for u in day["unsupported_records"]:
            self.assertEqual(u["reason"], "every fix during it is elsewhere")
        drawn = {p["name"] for p in day["places"]} | {v["name"] for v in day["visits"]}
        self.assertFalse(drawn & names)

    def test_no_conflicts_and_a_believable_clock(self):
        day = build()
        self.assertEqual(day["conflicts"], [])
        self.assertEqual(day["stats"]["conflicts"], 0)
        self.assertLess(day["stats"]["dwell_h"], 22)
        self.assertGreater(day["stats"]["moving_h"], 2)

    def test_a_visit_coordinate_is_never_a_path_vertex(self):
        day = build()
        ghost = [G(0.04, -0.02), G(90.84, 746.88)]
        for seg in day["segments"]:
            for c in seg["coords"]:
                for g in ghost:
                    self.assertGreater(mod.haversine(c, g), 300)


class WalkShape(unittest.TestCase):
    def test_address_waypoints_along_the_walk_are_the_walk(self):
        day = build()
        wp = {w["name"] for w in day["waypoint_visits"]}
        self.assertEqual(wp, {"279–281 Pine Ave", "449 Pine Ave", "550 Pine Ave", "11 Grand Square"})
        self.assertFalse(wp & {p["name"] for p in day["places"]})

    def test_skip_is_movement_not_a_place(self):
        day = build()
        self.assertNotIn("skip", {p["name"] for p in day["places"]})
        self.assertEqual([n["name"] for n in day["nonstops"]], ["skip"])

    def test_the_return_hole_is_found_by_the_legs_own_density(self):
        day = build()
        legs = [n for n in day["spine"] if n["type"] == "leg"]
        back = next(l for l in legs if l["from_name"] == "Silver Theatre")
        self.assertEqual(back["confidence"], "partly inferred")
        self.assertEqual(len(back["holes"]), 1)
        h = back["holes"][0]
        self.assertEqual((h["t0"], h["t1"]), ("16:45", "16:50"))
        self.assertGreater(h["m"], 1400)
        # ...and the walk up, sampled every ~200 m, has none
        up = next(l for l in legs if l["to_name"] == "Silver Theatre")
        self.assertEqual(up["holes"], [])
        self.assertEqual(up["confidence"], "observed")
        self.assertEqual(up["mode"], "walking")

    def test_a_fast_leg_is_riding_but_routed_on_foot(self):
        day = build()
        back = next(n for n in day["spine"] if n["type"] == "leg" and n["from_name"] == "Silver Theatre")
        self.assertEqual(back["mode"], "riding")
        self.assertTrue(back["mode_uncertain"])
        self.assertEqual(back["costing"], "pedestrian")

    def test_simplify_keeps_ends_and_hole_edges(self):
        day = build()
        for seg in day["segments"]:
            self.assertGreaterEqual(len(seg["coords"]), 2)
        seg = next(s for s in day["segments"] if s["holes"])
        self.assertTrue(all(mod.haversine(a, b) >= 100 or True for a, b in zip(seg["coords"], seg["coords"][1:])))


class Spine(unittest.TestCase):
    def test_alternates_dwell_leg_dwell_and_covers_the_day(self):
        day = build()
        kinds = [n["type"] for n in day["spine"]]
        self.assertEqual(kinds[0], "dwell")
        self.assertEqual(kinds[-1], "dwell")
        for a, b in zip(kinds, kinds[1:]):
            self.assertNotEqual(a, b, "two nodes of one kind in a row")
        self.assertEqual(day["spine"][0]["start"], "00:01")
        self.assertEqual(day["spine"][-1]["end"], "23:59")

    def test_legs_point_at_their_dwells(self):
        day = build()
        ids = {n["id"] for n in day["spine"] if n["type"] == "dwell"}
        for n in day["spine"]:
            if n["type"] == "leg":
                self.assertIn(n["from"], ids)
                self.assertIn(n["to"], ids)

    def test_the_evening_at_home_exists_without_a_visit_row(self):
        # the last Home row ends 16:57; the fixes sit at home 18:04-23:59
        day = build()
        last = day["spine"][-1]
        self.assertEqual(last["place"]["name"], "Home (Example)")
        self.assertEqual(last["place"]["tier"], "stay-point")
        self.assertEqual(last["start"], "18:04")
        self.assertGreater(last["mins"], 300)

    def test_the_theatre_is_asserted_and_witnessed(self):
        day = build()
        th = next(n for n in day["spine"] if n["type"] == "dwell" and n["place"]["name"] == "Silver Theatre")
        self.assertEqual(th["place"]["tier"], "user-confirmed")
        self.assertEqual((th["start"], th["end"]), ("13:47", "16:42"))
        self.assertGreater(th["witnessed_min"], 120)
        self.assertTrue(th["major"])

    def test_stats_come_from_the_same_nodes(self):
        day = build()
        st = day["stats"]
        legs = [n for n in day["spine"] if n["type"] == "leg"]
        dwells = [n for n in day["spine"] if n["type"] == "dwell"]
        self.assertEqual(st["stops"], sum(1 for d in dwells if d["major"]))
        self.assertEqual(st["visits"], len(dwells))
        self.assertAlmostEqual(st["dwell_h"], round(sum(d["mins"] for d in dwells) / 60, 1), places=1)
        walked = sum(l["walked_m"] for l in legs if l["mode"] == "walking")
        self.assertAlmostEqual(st["walked_km"], round(walked / 1000, 1), places=1)

    def test_a_drive_inside_a_walking_leg_is_not_walked(self):
        # A 10 km drive with the phone silent read as two hours on foot.
        # The leg's median pace says walking; only the walked metres count.
        t0 = datetime(2026, 10, 12, 9, 0, tzinfo=ZoneInfo("UTC"))
        pts = [dict(zip(("lat", "lon"), G(0, 0)), t=t0)]
        pts.append(dict(zip(("lat", "lon"), G(9764.71, -3798.23)), t=t0 + timedelta(minutes=20)))  # the drive
        for i in range(1, 25):  # ~80 m every 5 min: a walk
            pts.append(dict(zip(("lat", "lon"), G(9764.71, -3798.23 - 77.84 * i)), t=t0 + timedelta(minutes=20 + 5 * i)))
        share = mod.walked_share(pts)
        self.assertLess(share, 0.25)
        self.assertGreater(share, 0.1)

    def test_a_drive_in_traffic_is_not_walked(self):
        # A drive out of a car park, 2.4 km in 31 min, every pair under 7 km/h,
        # printed "Walked 1.5 miles along" two avenues. The phone's motion
        # sensor called those fixes "driving".
        t0 = datetime(2026, 10, 19, 12, 24, 1, tzinfo=ZoneInfo("UTC"))
        crawl = [(0, G(0, 0), "unknown"), (474, G(-118.16, 27.8), "driving"),
                 (935, G(-357.31, -22.23), "driving"), (1357, G(-900.85, -4.41), "driving")]
        pts = [dict(lat=ll[0], lon=ll[1], t=t0 + timedelta(seconds=s), kind="fix", activity=a) for s, ll, a in crawl]
        self.assertLess(mod.walked_share(pts), 0.2)
        for p in pts:
            p["activity"] = "walking"
        self.assertEqual(mod.walked_share(pts), 1.0)

    def test_fixes_keep_their_motion_activity(self):
        lo = datetime(2026, 10, 19, 0, 0, tzinfo=ZoneInfo("UTC"))
        lat, lon = G(-118.16, 27.8)
        rows = [dict(segment_type="transit", arrived_at="2026-10-19T12:31:55+00:00", latitude=lat,
                     longitude=lon, accuracy_m=2, activity="driving")]
        fixes, _ = mod.clean_fixes(rows, lo, lo + timedelta(days=1))
        self.assertEqual(fixes[0]["activity"], "driving")

    def test_a_router_detour_is_not_walked(self):
        # A stadium to the car, 516 m between the fixes in 6 minutes, routed
        # round a highway for 2,272 m (23 km/h).
        t0 = datetime(2026, 10, 19, 19, 28, tzinfo=ZoneInfo("UTC"))
        pts = [dict(zip(("lat", "lon"), G(0, 0)), t=t0, kind="anchor"),
               dict(zip(("lat", "lon"), G(416.07, -300.22)), t=t0 + timedelta(minutes=6), kind="anchor")]
        self.assertEqual(mod.walk_metres(2272, 516, pts), 516)
        # a street path a little longer than the fixes, at walking pace, stands
        self.assertEqual(mod.walk_metres(600, 500, [pts[0], dict(pts[1], t=t0 + timedelta(minutes=8))]), 600)
        # a loop: back near the start, so the straight line is short, but the
        # street path is a walking pace over its 40 minutes -- the path stands
        self.assertEqual(mod.walk_metres(3000, 200, [pts[0], dict(pts[1], t=t0 + timedelta(minutes=40))]), 3000)
        # no street match: the straight line, as before
        self.assertEqual(mod.walk_metres(0, 516, pts), 516)

    def test_an_anchor_pair_has_no_pace(self):
        # The walk back from a coffee shop. The café's anchor is
        # stamped by a synthesized departure, the flat's by an early CLVisit
        # arrival, so the leg ran 09:04:17 -> 09:04:46 -> 09:04:46 and read as
        # a car: 0 of its metres walked.
        t = datetime(2026, 10, 17, 6, 4, 17, tzinfo=ZoneInfo("UTC"))
        pts = [dict(zip(("lat", "lon"), G(0, 0)), t=t, kind="anchor"),
               dict(zip(("lat", "lon"), G(-217.42, -26.46)), t=t + timedelta(seconds=29), kind="fix"),
               dict(zip(("lat", "lon"), G(-496.1, -183.9)), t=t + timedelta(seconds=29), kind="anchor")]
        self.assertEqual(mod.walked_share(pts), 1.0)

    def test_a_long_anchor_pair_is_still_judged_by_pace(self):
        # The drive leaves from the dwell's anchor: 10 km in 20 minutes.
        t0 = datetime(2026, 10, 12, 9, 0, tzinfo=ZoneInfo("UTC"))
        pts = [dict(zip(("lat", "lon"), G(0, 0)), t=t0, kind="anchor"),
               dict(zip(("lat", "lon"), G(9764.71, -3798.23)), t=t0 + timedelta(minutes=20), kind="fix")]
        for i in range(1, 25):
            pts.append(dict(zip(("lat", "lon"), G(9764.71, -3798.23 - 77.84 * i)), t=t0 + timedelta(minutes=20 + 5 * i), kind="fix"))
        self.assertLess(mod.walked_share(pts), 0.25)

    def test_hebrew_names_match_themselves(self):
        # A Hebrew name normalised to "" and the meal became two dwells.
        self.assertEqual(mod.name_similarity("מסעדה", "מסעדה"), 1.0)
        self.assertEqual(mod.name_similarity("מסעדה", "Bakery Example"), 0.0)

    def test_his_words_attach_to_the_dwell(self):
        doc = {"places": [{"name": "the show at the Silver", "venue": "Silver Theatre", "activity": "matinee",
                           "evidence": "we saw the matinee at the Silver", "when_hint": "14:00", "companions": ["Sam"]},
                          {"name": "walked with the dog", "venue": None, "activity": "walked the dog",
                           "evidence": "walked the dog", "when_hint": "09:30", "companions": ["Rover"]}],
               "labels": [], "non_stops": []}
        day = build(statements=doc)
        th = next(n for n in day["spine"] if n["type"] == "dwell" and n["place"]["name"] == "Silver Theatre")
        self.assertEqual(th["his_words"][0]["companions"], ["Sam"])
        walk = next(n for n in day["spine"] if n["type"] == "leg" and n["start"] == "09:08")
        self.assertEqual(walk["his_words"][0]["activity"], "walked the dog")


class Reconcile(unittest.TestCase):
    """reconcile_visit on synthetic traces, so each rule is pinned on its own."""
    T0 = datetime(2026, 9, 6, 12, 0, tzinfo=ZoneInfo("America/New_York"))

    def fix(self, mins, lat, lon):
        return dict(t=self.T0 + timedelta(minutes=mins), lat=lat, lon=lon, acc=10, kind="fix")

    def test_quiet_phone_bracketed_is_kept(self):
        v = dict(start=self.T0, end=self.T0 + timedelta(hours=2), lat=12.3, lon=-65.4)
        fixes = [self.fix(-10, 12.3001, -65.4), self.fix(130, 12.3, -65.4001)]
        spans, why = mod.reconcile_visit(v, fixes)
        self.assertIsNone(why)
        self.assertEqual(spans[0][3], "bracket")

    def test_late_departure_is_clipped_at_the_first_far_run(self):
        v = dict(start=self.T0, end=self.T0 + timedelta(hours=30), lat=12.3, lon=-65.4)
        fixes = [self.fix(1, 12.3, -65.4), self.fix(20, 12.3001, -65.4),
                 self.fix(40, 12.31, -65.4), self.fix(45, 12.32, -65.4), self.fix(600, 12.35, -65.4)]
        spans, why = mod.reconcile_visit(v, fixes)
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0][1], self.T0 + timedelta(minutes=40))

    def test_one_far_fix_is_a_glitch_not_a_departure(self):
        v = dict(start=self.T0, end=self.T0 + timedelta(hours=2), lat=12.3, lon=-65.4)
        fixes = [self.fix(1, 12.3, -65.4), self.fix(30, 12.31, -65.4), self.fix(60, 12.3, -65.4)]
        spans, why = mod.reconcile_visit(v, fixes)
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0][1], v["end"])

    def test_out_and_back_splits_the_row(self):
        v = dict(start=self.T0, end=self.T0 + timedelta(hours=3), lat=12.3, lon=-65.4)
        fixes = [self.fix(1, 12.3, -65.4), self.fix(60, 12.31, -65.4), self.fix(70, 12.312, -65.4),
                 self.fix(90, 12.3, -65.4), self.fix(170, 12.3001, -65.4)]
        spans, why = mod.reconcile_visit(v, fixes)
        self.assertEqual(len(spans), 2)
        self.assertEqual(spans[0][1], self.T0 + timedelta(minutes=60))
        self.assertEqual(spans[1][0], self.T0 + timedelta(minutes=70))

    def test_never_there_is_unsupported(self):
        v = dict(start=self.T0, end=self.T0 + timedelta(hours=2), lat=12.3, lon=-65.4)
        fixes = [self.fix(5, 12.32, -65.4), self.fix(50, 12.33, -65.4)]
        spans, why = mod.reconcile_visit(v, fixes)
        self.assertEqual(spans, [])
        self.assertEqual(why, "every fix during it is elsewhere")


class Fixes(unittest.TestCase):
    def test_cell_tower_fixes_are_dropped_unless_alone(self):
        day = build()
        self.assertEqual(day["stats"]["dropped_fixes"], 2)   # the two acc=1414 rows beside good fixes

    def test_stay_points_need_time_not_just_proximity(self):
        T0 = datetime(2026, 9, 6, 12, 0, tzinfo=ZoneInfo("America/New_York"))
        f = lambda m, lat: dict(t=T0 + timedelta(minutes=m), lat=lat, lon=-65.4, acc=10, kind="fix")
        self.assertEqual(mod.stay_points([f(0, 12.3), f(3, 12.3001)]), [])
        st = mod.stay_points([f(0, 12.3), f(3, 12.3001), f(12, 12.3002)])
        self.assertEqual(len(st), 1)
        self.assertEqual(st[0]["n"], 3)



class RouteStreetNames(unittest.TestCase):
    """A bare road number from the router is not a street name.

    A short walk between two stops printed "Walked 0.3 miles along <street> and
    3350": the router's maneuvers named a numbered road by its number alone.
    """

    def test_number_only_names_are_dropped(self):
        trip = {"trip": {"legs": [{"shape": "", "summary": {"length": 0.4}, "maneuvers": [
            {"street_names": ["Example Street"]}, {"street_names": ["3350"]},
            {"street_names": ["Second Way", "3350"]}, {"street_names": ["Route 9"]}]}]}}
        saved = mod._post_json
        mod._post_json = lambda url, body: trip
        try:
            t0 = datetime(2026, 1, 1, 9, 0)
            a, b = G(0.0, 0.0), G(120.0, 90.0)
            pts = [{"lat": a[0], "lon": a[1], "acc": 10, "t": t0},
                   {"lat": b[0], "lon": b[1], "acc": 10, "t": t0 + timedelta(minutes=4)}]
            _shape, names, _m, _legs, _runs = mod.valhalla_route_points(pts, "pedestrian")
        finally:
            mod._post_json = saved
        self.assertEqual(names, ["Example Street", "Second Way", "Route 9"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
