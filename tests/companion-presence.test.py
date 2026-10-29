"""Who was with the user, from Find My against the user's own trail.

A day's summary kept asking whether a companion was with the user first thing
and on an evening walk, when they were together all day. bin/companion-presence
samples Find My every 10 minutes; lib/companion_presence.py compares each
reading with where the user's trail puts the user and adds the person to the
user's visit rows. These pin the geometry and the tagging rule: together across
a row adds the name, any apart reading inside a row blocks it, a reading the
user's trail cannot place yet decides nothing, and nothing is ever removed.
Synthetic people and coordinates.

Run: python3 tests/companion-presence.test.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "lib"))
import companion_presence as cp  # noqa: E402

FLAT = (12.34560, -65.43210)
CAFE = (12.34721, -65.42763)       # a café ~518 m from the flat
MIN = cp.MIN
T0 = cp.parse_ms("2026-10-17T05:00:00Z")


def at(minutes):
    return T0 + minutes * MIN


def fix(minutes, pos, acc=15):
    return {"segment_type": "transit", "arrived_at": cp.iso(at(minutes)), "latitude": pos[0],
            "longitude": pos[1], "accuracy_m": acc}


def visit(rid, a, b, pos, place_type="named", companions=None, acc=20):
    return {"id": rid, "segment_type": "visit", "place_type": place_type,
            "arrived_at": cp.iso(at(a)), "departed_at": None if b is None else cp.iso(at(b)),
            "latitude": pos[0], "longitude": pos[1], "accuracy_m": acc, "companions": companions}


def reading(minutes, pos, person="Sam", acc=10):
    return {"person": person, "at": cp.iso(at(minutes)), "lat": pos[0], "lon": pos[1], "acc_m": acc}


def offset(pos, metres_north):
    return (pos[0] + metres_north / 111_320.0, pos[1])


def run(rows, samples, now_min=600, known=frozenset({"Sam", "Kim"}), aliases=None):
    fixes = cp.fixes_from_rows(rows)
    spans = cp.visit_spans(rows)
    readings = cp.classify(samples, fixes, spans)
    visits = [r for r in rows if r["segment_type"] == "visit"]
    return readings, cp.row_additions(visits, readings, at(now_min), aliases=aliases or {}, known=set(known))


class Verdict(unittest.TestCase):
    def test_thresholds(self):
        self.assertEqual(cp.verdict(60, 30), "together")
        self.assertEqual(cp.verdict(150, 30), None)            # the next café is not "together"
        self.assertEqual(cp.verdict(250, 260), None)           # capped at 200 m however vague
        self.assertEqual(cp.verdict(50, 350), None)            # too vague to say together
        self.assertEqual(cp.verdict(500, 30), "apart")
        self.assertEqual(cp.verdict(500, 300), None)           # apart needs 2x the uncertainty


class Rows(unittest.TestCase):
    def test_together_across_a_visit_adds_her(self):
        rows = [visit("flat", 0, 120, FLAT)]
        samples = [reading(m, offset(FLAT, 20)) for m in range(5, 120, 10)]
        _, adds = run(rows, samples)
        self.assertEqual([(a["id"], a["person"], a["companions"]) for a in adds], [("flat", "Sam", ["Sam"])])

    def test_one_apart_reading_inside_blocks_the_row(self):
        # 2026-10-17 shape: a long row at the flat with a solo walk out of it. resolve-day
        # can carve the walk out of that row and would carry the name onto it.
        rows = [visit("flat", 0, 240, FLAT, acc=40)] + [fix(m, CAFE) for m in (110, 114, 118, 122, 126)]
        samples = [reading(m, offset(FLAT, 10)) for m in range(5, 240, 10)]
        readings, adds = run(rows, samples)
        apart = [r for r in readings if r["verdict"] == "apart"]
        self.assertEqual([cp.iso(r["t"])[11:16] for r in apart], ["06:55", "07:05"])
        self.assertEqual(adds, [])

    def test_apart_at_the_edge_is_arrival_skew(self):
        rows = [visit("cafe", 0, 60, CAFE), fix(2, CAFE), fix(4, CAFE)]
        samples = [reading(3, FLAT)] + [reading(m, CAFE) for m in range(10, 60, 10)]
        _, adds = run(rows, samples)
        self.assertEqual([a["id"] for a in adds], ["cafe"])

    def test_half_cover_needed(self):
        rows = [visit("flat", 0, 240, FLAT)]
        samples = [reading(m, FLAT) for m in (10, 20, 30)]       # 40 min of a 4 h row
        _, adds = run(rows, samples)
        self.assertEqual(adds, [])

    def test_never_removes_and_reads_aliases(self):
        rows = [visit("flat", 0, 60, FLAT, companions=["Sam Example", "Lee"])]
        samples = [reading(m, FLAT) for m in range(5, 60, 10)] + \
                  [reading(m, FLAT, person="Kim") for m in range(5, 60, 10)]
        _, adds = run(rows, samples, aliases={"Sam Example": "Sam"})
        self.assertEqual([(a["person"], a["companions"]) for a in adds], [("Kim", ["Sam Example", "Lee", "Kim"])])

    def test_only_known_people(self):
        rows = [visit("flat", 0, 60, FLAT)]
        samples = [reading(m, FLAT, person="Stranger") for m in range(5, 60, 10)]
        _, adds = run(rows, samples)
        self.assertEqual(adds, [])

    def test_open_row_needs_thirty_minutes_at_eighty_percent(self):
        rows = [visit("flat", 0, None, FLAT), fix(0, FLAT), fix(90, FLAT)]
        early = [reading(m, FLAT) for m in (5, 15)]
        _, adds = run(rows, early, now_min=20)
        self.assertEqual(adds, [])
        later = [reading(m, FLAT) for m in range(5, 90, 10)]
        _, adds = run(rows, later, now_min=95)
        self.assertEqual([(a["id"], a["open"]) for a in adds], [("flat", True)])

    def test_non_stop_row_is_tagged_but_never_places_the_user(self):
        walk_mid = offset(FLAT, 300)
        rows = [visit("walk", 0, 30, walk_mid, place_type="non-stop")]
        samples = [reading(m, walk_mid) for m in (5, 15, 25)]
        readings, adds = run(rows, samples)
        self.assertTrue(all(not r["placed"] for r in readings))   # no fixes: undecided, not "together"
        self.assertEqual(adds, [])
        rows += [fix(m, walk_mid) for m in (4, 6, 14, 16, 24, 26)]
        _, adds = run(rows, samples)
        self.assertEqual([a["id"] for a in adds], ["walk"])


class Provisional(unittest.TestCase):
    def test_open_row_name_comes_off_when_the_person_leaves(self):
        # Both home in the morning, the open row is tagged; then the person goes out
        # while the user stays (otherwise the whole stay reads "with Sam").
        rows = [visit("flat", 0, None, FLAT)] + [fix(m, FLAT) for m in range(0, 300, 4)]
        samples = [reading(m, FLAT) for m in range(5, 60, 10)]
        readings, adds = run(rows, samples, now_min=60)
        self.assertEqual([(a["id"], a["open"]) for a in adds], [("flat", True)])
        prov = {"flat": ["Sam"]}
        later = samples + [reading(m, CAFE) for m in range(65, 200, 10)]
        readings, _ = run(rows, later, now_min=200)
        withdraw, keep = cp.review_provisional(rows, readings, prov, at(200))
        self.assertEqual((withdraw, keep), ([("flat", "Sam")], {}))

    def test_still_together_stays_provisional_until_closed_and_placed(self):
        rows = [visit("flat", 0, None, FLAT)] + [fix(m, FLAT) for m in range(0, 120, 4)]
        readings, _ = run(rows, [reading(m, FLAT) for m in range(5, 120, 10)], now_min=120)
        self.assertEqual(cp.review_provisional(rows, readings, {"flat": ["Sam"]}, at(120)),
                         ([], {"flat": ["Sam"]}))
        closed = [visit("flat", 0, 120, FLAT)] + rows[1:]
        readings, _ = run(closed, [reading(m, FLAT) for m in range(5, 120, 10)], now_min=125)
        self.assertEqual(cp.review_provisional(closed, readings, {"flat": ["Sam"]}, at(125)), ([], {}))

    def test_a_row_that_began_before_the_window_is_not_judged(self):
        # Its early apart readings have aged out; cover alone would add her.
        rows = [visit("flat", 0, 660, FLAT)]
        samples = [reading(m, FLAT) for m in range(190, 660, 10)]
        _, adds = run(rows, samples)
        self.assertEqual([a["id"] for a in adds], ["flat"])
        visits = [r for r in rows if r["segment_type"] == "visit"]
        readings = cp.classify(samples, [], cp.visit_spans(rows))
        self.assertEqual(cp.row_additions(visits, readings, at(700), known={"Sam"}, window_start_ms=at(185)), [])

    def test_blocked_pair_is_never_added(self):
        rows = [visit("flat", 0, 60, FLAT)]
        readings = cp.classify([reading(m, FLAT) for m in range(5, 60, 10)], [], cp.visit_spans(rows))
        self.assertEqual(cp.row_additions(rows, readings, at(100), known={"Sam"}, blocked={("flat", "Sam")}), [])


class Trail(unittest.TestCase):
    def test_a_visit_row_does_not_outrank_his_own_fixes(self):
        # A solo walk inside a long row at the flat, with fixes 8 min apart.
        walk = offset(FLAT, 700)
        rows = [visit("flat", 0, 240, FLAT), fix(112, walk), fix(128, walk)]
        readings, _ = run(rows, [reading(120, FLAT)])
        self.assertNotEqual(readings[0].get("basis"), "visit")
        self.assertNotEqual(readings[0]["verdict"], "together")

    def test_a_reading_the_users_trail_cannot_place_yet_decides_nothing(self):
        # Deferred upload: the user's fixes after the reading have not arrived.
        rows = [fix(0, FLAT)]
        readings, _ = run(rows, [reading(60, CAFE)])
        self.assertFalse(readings[0]["placed"])
        self.assertIsNone(readings[0]["verdict"])
        readings, _ = run(rows + [fix(120, CAFE), fix(58, CAFE), fix(62, CAFE)], [reading(60, CAFE)])
        self.assertEqual(readings[0]["verdict"], "together")

    def test_silence_is_stillness(self):
        rows = [fix(0, FLAT), fix(300, offset(FLAT, 30))]
        readings, _ = run(rows, [reading(150, FLAT)])
        self.assertEqual((readings[0]["verdict"], readings[0]["basis"]), ("together", "still"))

    def test_driving_together_interpolates(self):
        # 15 m/s, a fix every 30 s, the person's reading between two of the user's.
        rows = [fix(m / 2, offset(FLAT, 450 * m)) for m in range(0, 20)]
        readings, _ = run(rows, [reading(4.25, offset(FLAT, 450 * 8.5))])
        self.assertEqual(readings[0]["verdict"], "together")

    def test_vague_reading_decides_nothing(self):
        rows = [fix(0, FLAT), fix(10, FLAT)]
        readings, _ = run(rows, [reading(5, FLAT, acc=900)])
        self.assertIsNone(readings[0]["verdict"])


class Stretches(unittest.TestCase):
    def test_apart_splits_a_stretch(self):
        rs = [{"person": "Sam", "t": at(m), "verdict": v} for m, v in
              [(0, "together"), (10, "together"), (20, "apart"), (30, None), (40, "together")]]
        s = cp.stretches(rs)["Sam"]
        self.assertEqual([(x["n"]) for x in s], [2, 1])
        self.assertEqual(s[0]["start"], at(0) - cp.STRETCH_PAD_MS)

    def test_cover(self):
        self.assertAlmostEqual(cp.cover(at(0), at(60), [at(10), at(30), at(50)]), 48 / 60)


class Cli(unittest.TestCase):
    def test_show_and_who_read_the_readings_files(self):
        with tempfile.TemporaryDirectory() as d:
            readings = [{"person": "Sam", "t": cp.iso(cp.parse_ms("2026-10-17T16:00:00Z") + m * MIN),
                         "verdict": "together", "placed": True} for m in range(0, 60, 10)]
            with open(os.path.join(d, "readings-2026-10-17.json"), "w") as f:
                json.dump(readings, f)
            env = {**os.environ, "COMPANION_PRESENCE_DIR": d}
            cli = os.path.join(REPO, "bin", "companion-presence")
            out = subprocess.run([sys.executable, cli, "who", "2026-10-17", "19:00", "19:50",
                                  "--tz", "Asia/Jerusalem", "--json"], env=env, capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertEqual(json.loads(out.stdout)["people"]["Sam"]["answer"], "together")
            out = subprocess.run([sys.executable, cli, "show", "2026-10-17", "--tz", "Asia/Jerusalem"],
                                 env=env, capture_output=True, text=True)
            self.assertIn("Sam: together 18:55-19:55", out.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=1)
