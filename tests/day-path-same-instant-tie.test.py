#!/usr/bin/env python3
"""day-path-same-instant-tie.test.py — two rows of one rank that start at the same
instant give the same spine whichever order the database returns them in.

Replays a real day (2026-10-17, synthetic places via tests/fixtures/fake_geo.py; tests/fixtures/day-path-2026-10-17.rows.json, the
day's rows as they sat in location_history the next morning). Walking home from
Corner Coffee, two `address` rows were written at 09:04:46:

  - "4ב Example Grove Street", 09:04–11:53, the flat (160 min witnessed by fixes);
  - "15 Example Grove Street", 09:04–09:27, a pass-by 195 m east, its departure
    synthesized later, no fix ever seen there.

day-path fetches with `order=arrived_at.asc` alone, so the pair came back in
either order. One build gave the flat the morning; the next gave 09:04–09:27 to
the pass-by, which resolve-day then named for a café 23 m from it. The summary
would have said the user stopped at a café never sat in.

Run: python3 tests/day-path-same-instant-tie.test.py
"""
import json, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, "fixtures"))
from fake_geo import at as G, load_rows  # noqa: E402,F401
mod = type(sys)("daypath")
exec(compile(open(os.path.join(REPO, "bin", "day-path")).read(), "day-path", "exec"), mod.__dict__)
ROWS = load_rows(os.path.join(HERE, "fixtures", "day-path-2026-10-17.rows.json"))
TIED_AT = "2026-10-17T06:04:46"


def dwells(rows):
    day = mod.build("2026-10-17", "Asia/Jerusalem", rows, do_match=False)
    return [(n["place"]["name"], n["start"], n["end"]) for n in day["spine"] if n["type"] == "dwell"]


def swapped(rows):
    i = [k for k, r in enumerate(rows) if r["segment_type"] == "visit" and r["arrived_at"].startswith(TIED_AT)]
    assert len(i) == 2, i
    out = list(rows)
    out[i[0]], out[i[1]] = out[i[1]], out[i[0]]
    return out


class SameInstantTie(unittest.TestCase):
    def test_either_order_gives_one_spine(self):
        self.assertEqual(dwells(ROWS), dwells(swapped(ROWS)))

    def test_the_witnessed_row_keeps_the_morning(self):
        for rows in (ROWS, swapped(ROWS)):
            morning = [d for d in dwells(rows) if "09:00" <= d[1] < "12:00"]
            self.assertEqual(morning, [("The Harbor Flat", "09:04", "11:53")])

    def test_the_pass_by_is_no_dwell(self):
        for rows in (ROWS, swapped(ROWS)):
            self.assertNotIn("15 Example Grove Street", [d[0] for d in dwells(rows)])


if __name__ == "__main__":
    unittest.main()
