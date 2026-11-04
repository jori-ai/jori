#!/usr/bin/env python3
"""day-path-place-tiebreak.test.py — at equal rank, the LONGER visit names the place.

Replays a real day's shape (tests/fixtures/day-path-2026-09-07.rows.json, the
rows as they sat in location_history the next morning, at synthetic places --
tests/fixtures/fake_geo.py). That evening two
`address` rows 144 m apart -- inside the 150 m "one place, one identity"
radius -- merged into one place:

  - "354–358 Cedar Ave", 19:22–20:23, a sweeper-synthesized 61-minute row on
    the walk in;
  - "131 Sample St", 19:28–21:47, the 139 minutes the user actually sat at
    the jazz club.

Arrival order let the short row name AND place the marker, so the map labelled
the evening with the wrong twin's address 144 m up the block.

Run: python3 tests/day-path-place-tiebreak.test.py
"""
import json, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, "fixtures"))
from fake_geo import at as G, load_rows  # noqa: E402
mod = type(sys)("daypath")
exec(compile(open(os.path.join(REPO, "bin", "day-path")).read(), "day-path", "exec"), mod.__dict__)
ROWS = load_rows(os.path.join(HERE, "fixtures", "day-path-2026-09-07.rows.json"))

CLUB_ROW = G(72.28, -1301.17)          # "131 Sample St"
SIDE_AVE_ROW = G(84.07, -1157.73)     # "354–358 Cedar Ave"


def build(rows=ROWS, **kw):
    return mod.build("2026-09-07", "America/New_York", rows, do_match=False, **kw)


class LongerVisitNamesThePlace(unittest.TestCase):
    def setUp(self):
        self.day = build()

    def evening_place(self):
        cands = [p for p in self.day["places"]
                 if mod.haversine((p["lat"], p["lon"]), CLUB_ROW) < 200]
        self.assertEqual(len(cands), 1, [p["name"] for p in self.day["places"]])
        return cands[0]

    def test_the_place_carries_the_longer_rows_name(self):
        pl = self.evening_place()
        self.assertEqual(pl["name"], "131 Sample St")

    def test_the_marker_sits_at_the_longer_row(self):
        pl = self.evening_place()
        self.assertLess(mod.haversine((pl["lat"], pl["lon"]), CLUB_ROW), 30)
        self.assertGreater(mod.haversine((pl["lat"], pl["lon"]), SIDE_AVE_ROW), 100)

    def test_the_spine_dwell_agrees(self):
        dwells = [n for n in self.day["spine"] if n["type"] == "dwell"
                  and mod.haversine((n["place"]["lat"], n["place"]["lon"]), CLUB_ROW) < 200]
        self.assertTrue(dwells)
        self.assertEqual({d["place"]["name"] for d in dwells}, {"131 Sample St"})

    def test_the_visit_handed_to_resolve_day_sits_at_the_place_too(self):
        # The dwell kept its FIRST row's point (here the avenue row on
        # the walk in), so resolve-day pinned the stop there while the spine and
        # the map drew it at the place. The visit list carries the place's point.
        evening = [v for v in self.day["visits"]
                   if mod.haversine((v["lat"], v["lon"]), CLUB_ROW) < 200
                   or mod.haversine((v["lat"], v["lon"]), SIDE_AVE_ROW) < 200]
        self.assertTrue(evening)
        for v in evening:
            self.assertLess(mod.haversine((v["lat"], v["lon"]), CLUB_ROW), 30, v)

    def test_a_higher_rank_still_wins_over_length(self):
        rows = json.loads(json.dumps(ROWS))
        for r in rows:
            if r.get("place_name") == "354–358 Cedar Ave":
                r["place_type"] = "user-confirmed"
                r["place_name"] = "Sports Bar Example"
        day = build(rows)
        cands = [p for p in day["places"] if mod.haversine((p["lat"], p["lon"]), SIDE_AVE_ROW) < 200]
        self.assertEqual([p["name"] for p in cands], ["Sports Bar Example"])



ROWS_0908 = load_rows(os.path.join(HERE, "fixtures", "day-path-2026-09-08.rows.json"))


class ConfirmedSpanSurvivesTheMerge(unittest.TestCase):
    """2026-09-08: the 42-minute confirmed "Union Market" row and the 171-minute
    "113 Placeholder St" address row for the same building are one dwell; the
    dwell must still say which part of it the user confirmed."""

    def test_dwell_carries_the_confirmed_rows_own_span(self):
        day = mod.build("2026-09-08", "America/New_York", ROWS_0908, do_match=False)
        essex = [v for v in day["visits"] if v["name"] == "Union Market"]
        self.assertEqual(len(essex), 1)
        v = essex[0]
        self.assertEqual(v["ptype"], "user-confirmed")
        self.assertEqual((v["start"], v["end"]), ("18:07", "20:58"))
        tz = mod.ZoneInfo("America/New_York")
        fmt = lambda x: mod.datetime.fromtimestamp(x / 1000, tz).strftime("%H:%M")
        self.assertEqual((fmt(v["confirmed_start_ms"]), fmt(v["confirmed_end_ms"])), ("18:09", "18:51"))

    def test_an_unconfirmed_dwell_has_no_confirmed_span(self):
        day = mod.build("2026-09-08", "America/New_York", ROWS_0908, do_match=False)
        for v in day["visits"]:
            if v["ptype"] != "user-confirmed":
                self.assertIsNone(v["confirmed_start_ms"], v["name"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
