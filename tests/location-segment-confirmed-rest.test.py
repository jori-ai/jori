#!/usr/bin/env python3
"""location-segment-confirmed-rest.test.py — a past confirmation is matched where the user SAT.

`confirmed-stops.json` had carried a jazz club's name for months, 13 m from
the visit row. `resolve_place` measured it from the cluster's centroid, which
averaged in the walk down the avenue and landed 41 m off -- past the 30 m ring
-- so the stop went unnamed and the ladder fell through to a food-truck guess.
The samples themselves had nine precise, stationary fixes within 10 m of the
club. Synthetic coordinates: metres north/east of a fake base point.

Run: python3 tests/location-segment-confirmed-rest.test.py
"""
import os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
mod = type(sys)("locseg")
mod.__dict__["__file__"] = os.path.join(REPO, "bin", "location-segment")
exec(compile(open(os.path.join(REPO, "bin", "location-segment")).read(), "location-segment", "exec"),
     mod.__dict__)

import math

BASE_LAT, BASE_LON = 12.3456, -65.4321


def P(north_m, east_m):
    """The point north_m / east_m metres from the fake base."""
    return (BASE_LAT + north_m / 111320.0,
            BASE_LON + east_m / (111320.0 * math.cos(math.radians(BASE_LAT))))


CLUB_LAT, CLUB_LON = P(0, 0)
CLUB = {"name": "Example Jazz Club", "centroid": {"lat": CLUB_LAT, "lon": CLUB_LON},
        "address": "12 Example St"}
NEIGHBOUR = {"name": "Example Comedy Room", "centroid": dict(zip(("lat", "lon"), P(-74.6, 21.9)))}

T0 = 1_788_823_371_000  # 2026-09-07T23:22:51Z
OPTS = mod.Options(min_stop_min=8, stop_radius_m=75, merge_gap_min=5, snap="none",
                   no_places=True, no_overpass=True, no_photos=True, no_audio=True, debug=False)


def sample(minute, lat, lon, acc=12.0, activity="stationary"):
    return mod.Sample(ts_ms=T0 + minute * 60_000, lat=lat, lon=lon, accuracy_m=acc, activity=activity)


def club_stop():
    pts = [sample(0, *P(492.0, 33.7), 28, "walking"),          # the avenue, on the way
           sample(4, *P(155.8, 15.2), 14, "walking"),
           sample(8, *P(64.6, 10.1), 20, "walking")]
    for i in range(9):                                        # sat at the club
        pts.append(sample(10 + i * 14, *P(3.3, -3.4)))
    return mod.StopCandidate(samples=pts)


class ConfirmedStopAtRest(unittest.TestCase):
    def test_the_centroid_misses_the_ring_but_the_rest_does_not(self):
        stop = club_stop()
        clat, clon = stop.centroid()
        self.assertGreater(mod.haversine_m(clat, clon, CLUB_LAT, CLUB_LON), mod.CONFIRMED_STOP_MATCH_M)
        self.assertIsNone(mod.match_confirmed_stop(clat, clon, [CLUB]))
        hit = mod.match_confirmed_stop_at_rest(stop, [CLUB])
        self.assertIsNotNone(hit)
        self.assertEqual(hit[0]["name"], "Example Jazz Club")
        self.assertLess(hit[1], mod.CONFIRMED_STOP_MATCH_M)

    def test_resolve_place_names_it_from_the_confirmation(self):
        primary, _ = mod.resolve_place(club_stop(), OPTS, [], [], confirmed=[CLUB])
        self.assertEqual(primary.name, "Example Jazz Club")
        self.assertEqual(primary.source, "confirmed_stop")

    def test_a_confirmation_only_walked_past_does_not_match(self):
        stop = club_stop()
        self.assertIsNone(mod.match_confirmed_stop_at_rest(stop, [NEIGHBOUR]))

    def test_imprecise_samples_cannot_make_the_claim(self):
        stop = club_stop()
        for s in stop.samples:
            s.accuracy_m = 1414.0                       # cell-tower fixes
        self.assertIsNone(mod.match_confirmed_stop_at_rest(stop, [CLUB]))

    def test_a_walk_along_the_block_is_not_a_rest(self):
        # eleven precise samples spread down the block, only two at the door
        pts = [sample(i * 3, *P(3.3 + 44.5 * (i - 5), -3.4), 10, "walking") for i in range(11)]
        stop = mod.StopCandidate(samples=pts)
        self.assertIsNone(mod.match_confirmed_stop_at_rest(stop, [CLUB]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
