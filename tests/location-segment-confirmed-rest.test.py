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
import io, json, os, sys, unittest
from unittest import mock

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


# Two different places inside the ring: ask, don't pick (a café 12 m from a
# rental used to name nights at the rental by nearest-wins).
CAFE_NEXT_DOOR = {"name": "Example Cafe", "centroid": dict(zip(("lat", "lon"), P(8.0, 9.0)))}
CLUB_WORDY = {"name": "example jazz club - drinks after the show", "centroid": dict(zip(("lat", "lon"), P(2.0, 1.0)))}


class ConfirmedStopAmbiguity(unittest.TestCase):
    def test_two_different_places_in_the_ring_name_nothing(self):
        self.assertIsNone(mod.match_confirmed_stop(CLUB_LAT, CLUB_LON, [CLUB, CAFE_NEXT_DOOR]))
        self.assertIsNone(mod.match_confirmed_stop_at_rest(club_stop(), [CLUB, CAFE_NEXT_DOOR]))

    def test_one_answer_worded_two_ways_is_one_place(self):
        hit = mod.match_confirmed_stop(CLUB_LAT, CLUB_LON, [CLUB, CLUB_WORDY])
        self.assertIsNotNone(hit)
        self.assertEqual(hit[0]["name"], "Example Jazz Club")

    def test_a_place_outside_the_ring_does_not_make_it_ambiguous(self):
        hit = mod.match_confirmed_stop(CLUB_LAT, CLUB_LON, [CLUB, NEIGHBOUR])
        self.assertEqual(hit[0]["name"], "Example Jazz Club")


# -- One Nominatim answer gives a point's neighborhood AND every area level it holds.
# REGRESSION GUARD for a walk inside one district read as a walk to it: the start
# answered with its small neighbourhood, the far end of the same short walk (no
# neighbourhood field) with the wider suburb that CONTAINS it, and the two strings
# differed. `areas` hands every level to the caller (lib/day-excursions.js
# titleFor); `neighborhood` keeps its old value.


class PureHelper(unittest.TestCase):
    def test_start_point_holds_the_small_neighbourhood_and_the_wider_levels(self):
        nbhd, areas = mod.neighborhood_and_areas(
            {"neighbourhood": "Old Quarter", "suburb": "Harbour District", "city": "Metro City"})
        self.assertEqual(nbhd, "Old Quarter")
        self.assertEqual(areas, ["Old Quarter", "Harbour District", "Metro City"])

    def test_far_end_holds_only_the_wider_level(self):
        nbhd, areas = mod.neighborhood_and_areas({"suburb": "Harbour District", "city": "Metro City"})
        self.assertEqual(nbhd, "Harbour District")
        self.assertEqual(areas, ["Harbour District", "Metro City"])

    def test_neighborhood_keeps_the_old_chain_and_borough_is_only_an_area(self):
        # borough was never part of the neighborhood chain; it is an area level.
        nbhd, areas = mod.neighborhood_and_areas({"borough": "Borough Example", "city": "Metro City"})
        self.assertEqual(nbhd, "Metro City")
        self.assertEqual(areas, ["Borough Example", "Metro City"])
        nbhd, _ = mod.neighborhood_and_areas(
            {"quarter": "Q", "city_district": "CD", "suburb": "S", "city": "C", "town": "T", "village": "V"})
        self.assertEqual(nbhd, "Q")

    def test_deduped_case_insensitively_and_empty_dropped_fine_to_coarse(self):
        _, areas = mod.neighborhood_and_areas(
            {"neighbourhood": "Metro City", "suburb": "", "city": "metro city", "town": None,
             "village": "   ", "road": "Example Street", "square": "Example Square"})
        self.assertEqual(areas, ["Metro City"])

    def test_nothing_to_find(self):
        self.assertEqual(mod.neighborhood_and_areas({}), (None, []))
        self.assertEqual(mod.neighborhood_and_areas(None), (None, []))


class OneRequest(unittest.TestCase):
    def _urlopen(self, payload, calls):
        def fake(req, timeout=None):
            calls.append(req.full_url)
            return io.BytesIO(json.dumps(payload).encode())
        return fake

    def test_both_fields_come_from_a_single_request(self):
        calls = []
        payload = {"address": {"neighbourhood": "Old Quarter", "suburb": "Harbour District", "city": "Metro City"}}
        with mock.patch.object(mod.urllib.request, "urlopen", self._urlopen(payload, calls)):
            self.assertEqual(mod.nominatim_neighborhood_areas(1.0, 2.0),
                             ("Old Quarter", ["Old Quarter", "Harbour District", "Metro City"]))
        self.assertEqual(len(calls), 1)

    def test_the_old_entry_point_is_unchanged(self):
        calls = []
        payload = {"address": {"suburb": "Harbour District", "city": "Metro City"}}
        with mock.patch.object(mod.urllib.request, "urlopen", self._urlopen(payload, calls)):
            self.assertEqual(mod.nominatim_neighborhood(1.0, 2.0), "Harbour District")
        self.assertEqual(len(calls), 1)

    def test_a_failure_is_none_and_empty(self):
        def boom(req, timeout=None):
            raise OSError("no network")
        with mock.patch.object(mod.urllib.request, "urlopen", boom):
            self.assertEqual(mod.nominatim_neighborhood_areas(1.0, 2.0), (None, []))
            self.assertIsNone(mod.nominatim_neighborhood(1.0, 2.0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
