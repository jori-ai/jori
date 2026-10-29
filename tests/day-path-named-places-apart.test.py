#!/usr/bin/env python3
"""day-path-named-places-apart.test.py -- two places the day names stay two places.

Replays a real day (2026-10-22, synthetic places via tests/fixtures/fake_geo.py; tests/fixtures/day-path-2026-10-22.rows.json, the
rows as they sat in location_history that night). The flat and Café Example are
73 m apart. The phone named the 10:41 arrival "The Harbor Flat" and the 14:12
arrival "Café Example"; iOS ran the café row to 17:35, though from 14:35 to 17:28
58 precise fixes sat at the flat.

Two defects, one shape -- a bar built for one venue's footprint applied to two
places the user named:
  * the place fold: the café row joined the flat's place (under PLACE_M, 150 m),
    won the tie on length, and the overnight and the late morning at the flat both
    came out "Café Example" (only two ANSWERS were kept apart, at 30 m);
  * the stay split: the afternoon stay at the flat sat under STAY_SPLIT_M (130 m)
    from the café row, so it never cut it.

Run: python3 tests/day-path-named-places-apart.test.py
"""
import json, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, "fixtures"))
from fake_geo import at as G, load_rows  # noqa: E402,F401
mod = type(sys)("daypath")
exec(compile(open(os.path.join(REPO, "bin", "day-path")).read(), "day-path", "exec"), mod.__dict__)
ROWS = load_rows(os.path.join(HERE, "fixtures", "day-path-2026-10-22.rows.json"))


def dwells(**env):
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    try:
        day = mod.build("2026-10-22", "Asia/Jerusalem", ROWS, do_match=False)
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    return [(n["start"], n["end"], (n["place"] or {}).get("name")) for n in day["spine"] if n["type"] == "dwell"]


class NamedPlacesStayApart(unittest.TestCase):
    def setUp(self):
        self.d = dwells()

    def named(self, start):
        hit = [d for d in self.d if d[0] == start]
        self.assertEqual(len(hit), 1, self.d)
        return hit[0][2]

    def test_the_night_at_the_flat_is_the_flat(self):
        self.assertEqual(self.named("03:11"), "The Harbor Flat")

    def test_the_late_morning_at_the_flat_is_the_flat(self):
        self.assertEqual(self.named("10:41"), "The Harbor Flat")

    def test_the_cafe_row_keeps_only_its_own_stretch(self):
        cafe = [d for d in self.d if d[2] == "Café Example"]
        self.assertEqual(cafe, [("14:12", "14:35", "Café Example")], self.d)

    def test_the_afternoon_at_the_flat_is_its_own_dwell(self):
        self.assertIn(("14:35", "17:28", "The Harbor Flat"), self.d)

    def test_the_rest_of_the_day_is_unchanged(self):
        for want in [("09:19", "10:37", "מאפה לדוגמה"), ("13:32", "14:11", "Hummus Example"),
                     ("18:47", "21:45", "Gran")]:
            self.assertIn(want, self.d)


class SwitchesRestoreTheOldShape(unittest.TestCase):
    def test_named_own_place_off(self):
        d = dwells(JORI_NAMED_OWN_PLACE="0", JORI_STAY_AT_NAMED="0")
        self.assertIn(("03:11", "09:19", "Café Example"), d)
        self.assertIn(("14:12", "17:35", "Café Example"), d)

    def test_stay_at_named_off_keeps_the_fold_fix(self):
        d = dwells(JORI_STAY_AT_NAMED="0")
        self.assertIn(("03:11", "09:19", "The Harbor Flat"), d)
        self.assertIn(("14:12", "17:35", "Café Example"), d)


if __name__ == "__main__":
    unittest.main()
