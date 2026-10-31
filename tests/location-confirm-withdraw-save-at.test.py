#!/usr/bin/env python3
"""location-confirm withdraw / save-at. save-current bound names to where the
user stood when typing (a café's name on the rental flat's doorstep, a
restaurant's 166 m off); a wrong entry can now come out, and a place be saved
where it is. Synthetic names and coordinates.
Run: python3 tests/location-confirm-withdraw-save-at.test.py
"""
import argparse, io, json, os, sys, tempfile, unittest
from contextlib import redirect_stderr, redirect_stdout

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
FLAT = {**fake_at(0, 0)}
SHAWARMA = fake_pt(155.09, 199.51)


def entry(ask_id, name, c=FLAT):
    return {"ask_id": ask_id, "centroid": dict(c), "name": name, "source": "user_stated_direct",
            "stop_window": {"start": "2026-10-14T06:37:14+00:00", "end": "2026-10-14T09:59:00+00:00"}}


class Base(unittest.TestCase):
    def setUp(self):
        lc = self.lc = type(sys)("lc")
        lc.__dict__["__file__"] = SCRIPT
        exec(compile(open(SCRIPT).read(), "location-confirm", "exec"), lc.__dict__)
        d = tempfile.mkdtemp()
        for k in ("CONFIRMED_FILE", "PENDING_FILE", "RECENT_ASKS_FILE", "WITHDRAWN_FILE", "NIGHTLY_STATE_FILE"):
            setattr(lc, k, os.path.join(d, k.lower() + ".json"))
        self.patched, self.rerendered = [], []
        lc._patch_location_history = lambda *a, **k: self.patched.append(a) or True
        lc._dispatch_silent_rerender = lambda dates: self.rerendered.append(dates) or len(dates)
        with open(lc.CONFIRMED_FILE, "w") as f:
            json.dump([entry("lc-a", "מאפיית דוגמה"), entry("lc-direct-20261014-100912", "Corner Cafe")], f)

    def run_cmd(self, fn, **kw):
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            rc = fn(argparse.Namespace(**kw))
        return rc, (json.loads(out.getvalue()) if out.getvalue().strip() else None)

    def stored(self, path=None):
        return json.load(open(path or self.lc.CONFIRMED_FILE))


class Withdraw(Base):
    def test_moves_exactly_the_entry_and_archives_it(self):
        rc, out = self.run_cmd(self.lc.cmd_withdraw, ask_id="lc-direct-20261014-100912",
                               reason="saved on the flat's doorstep", name="Corner Cafe")
        self.assertEqual((rc, out["remaining"]), (0, 1))
        self.assertEqual([e["name"] for e in self.stored()], ["מאפיית דוגמה"])
        arch = self.stored(self.lc.WITHDRAWN_FILE)
        self.assertEqual((arch[0]["name"], arch[0]["withdrawn"]["reason"]), ("Corner Cafe", "saved on the flat's doorstep"))
        self.assertEqual((self.patched, self.rerendered), ([], []))

    def test_a_wrong_name_or_an_unknown_id_writes_nothing(self):
        before = self.stored()
        self.assertEqual(self.run_cmd(self.lc.cmd_withdraw, ask_id="lc-direct-20261014-100912",
                                      reason="x", name="Airbnb")[0], 3)
        self.assertEqual(self.run_cmd(self.lc.cmd_withdraw, ask_id="lc-nope", reason="x", name=None)[0], 2)
        self.assertEqual(self.stored(), before)
        self.assertFalse(os.path.exists(self.lc.WITHDRAWN_FILE))


    def test_only_name_takes_one_of_two_answers_sharing_an_ask_id(self):
        # A stop answered twice keeps one ask_id: the bare first answer and the
        # corrected one. --only-name withdraws the first and keeps the second.
        lc = self.lc
        with open(lc.CONFIRMED_FILE, "w") as f:
            json.dump([entry("lc-twice", "supermarket"), entry("lc-twice", "US1 Supermarket"),
                       entry("lc-a", "מאפיית דוגמה")], f)
        rc, out = self.run_cmd(lc.cmd_withdraw, ask_id="lc-twice", reason="bare category noun",
                               name=None, only_name="supermarket")
        self.assertEqual((rc, out["remaining"]), (0, 2))
        self.assertEqual([e["name"] for e in self.stored()], ["US1 Supermarket", "מאפיית דוגמה"])
        arch = self.stored(lc.WITHDRAWN_FILE)
        self.assertEqual([(e["name"], e["withdrawn"]["reason"]) for e in arch], [("supermarket", "bare category noun")])

    def test_only_name_with_no_match_or_with_name_writes_nothing(self):
        before = self.stored()
        self.assertEqual(self.run_cmd(self.lc.cmd_withdraw, ask_id="lc-direct-20261014-100912",
                                      reason="x", name=None, only_name="Airbnb")[0], 2)
        self.assertEqual(self.run_cmd(self.lc.cmd_withdraw, ask_id="lc-direct-20261014-100912",
                                      reason="x", name="Corner Cafe", only_name="Corner Cafe")[0], 2)
        self.assertEqual(self.stored(), before)
        self.assertFalse(os.path.exists(self.lc.WITHDRAWN_FILE))

class SaveAt(Base):
    def save(self, **kw):
        a = dict(venue="Example Shawarma", lat=SHAWARMA[0], lon=SHAWARMA[1], start="2026-10-16T17:38:25Z",
                 end="2026-10-16T18:42:40Z", source=None, answer=None)
        a.update(kw)
        return self.run_cmd(self.lc.cmd_save_at, **a)

    def test_writes_at_the_given_point_and_patches_nothing(self):
        rc, out = self.save(answer="had dinner here with Sam and Kim")
        self.assertEqual(rc, 0)
        e = out["saved"]
        self.assertEqual(e["centroid"], {"lat": SHAWARMA[0], "lon": SHAWARMA[1]})
        self.assertTrue(e["ask_id"].startswith("lc-at-"))
        self.assertIs(e["patched_location_history"], False)
        self.assertEqual((self.patched, self.rerendered), ([], []), "no visit row is renamed, nothing re-rendered")
        self.assertEqual(self.stored()[-1]["name"], "Example Shawarma")

    def test_companions_his_words_name_ride_on_the_entry(self):
        rc, out = self.save(companions="Sam, Kim,Sam")
        self.assertEqual(rc, 0)
        self.assertEqual(out["saved"]["companions"], ["Sam", "Kim"])
        rc, out = self.save(venue="Ben Gurion Airport", lat="31.99965", lon="34.87102")
        self.assertNotIn("companions", out["saved"], "none given, none stored")

    def test_twice_is_once(self):
        self.save()
        rc, out = self.save(venue=" example shawarma ")
        self.assertEqual(out, {"saved": None, "reason": "already saved"})
        self.assertEqual(len(self.stored()), 3)

    def test_bad_input_writes_nothing(self):
        for kw in (dict(lat="abc"), dict(lat=0), dict(lon=181), dict(venue="skip"),
                   dict(start="2026-10-16T19:00:00Z"), dict(start="2026-10-16T17:38:25")):
            self.assertEqual(self.save(**kw)[0], 2, kw)
        self.assertEqual(len(self.stored()), 2)

    def test_the_default_write_path_still_patches(self):
        ask = {"centroid": dict(FLAT), "first_sample_ts": "2026-10-16T17:13:41+00:00",
               "last_sample_ts": "2026-10-16T17:30:00+00:00", "duration_min": 16}
        with redirect_stderr(io.StringIO()):
            self.lc._write_confirmation(ask, {"name": "The Rental Flat", "source": "user_answer"}, "lc-x",
                                        remove_pending=False)
        self.assertEqual(len(self.patched), 1)


class SaveCurrentMovedOn(Base):
    """2026-10-28: "back at the cafe", typed minutes after he left the flat, found no
    open stop and was saved onto the flat's overnight rows (the stop that had just
    closed), naming the night for the cafe. The closed stop takes the name only while
    he is still near it."""
    CLOSED = {"centroid": {"lat": 10.0, "lon": 20.0}, "first_sample_ts": "2026-01-01T21:20:46+00:00",
              "last_sample_ts": "2026-01-02T06:58:07+00:00", "duration_min": 577.4}

    def save(self, fix):
        lc, wrote = self.lc, []
        lc._current_stop_ask = lambda: None
        lc._recently_closed_stop_ask = lambda minutes: dict(self.CLOSED)
        lc._latest_fix_since = lambda since: fix
        lc._write_confirmation = lambda ask, chosen, ask_id, remove_pending=False: wrote.append(chosen["name"]) or {"name": chosen["name"]}
        rc, _ = self.run_cmd(lc.cmd_save_current, venue="The Cafe", lookback_min=20.0)
        return rc, wrote

    def test_a_fix_far_from_the_closed_stop_writes_nothing(self):
        rc, wrote = self.save({"latitude": 10.0024, "longitude": 20.0, "accuracy_m": 12})   # ~267 m
        self.assertEqual((rc, wrote), (5, []))

    def test_still_beside_the_closed_stop_it_is_saved(self):
        rc, wrote = self.save({"latitude": 10.0005, "longitude": 20.0, "accuracy_m": 12})   # ~56 m
        self.assertEqual((rc, wrote), (0, ["The Cafe"]))

    def test_no_fix_since_it_closed_keeps_the_old_behaviour(self):
        rc, wrote = self.save(None)
        self.assertEqual((rc, wrote), (0, ["The Cafe"]))


class SaveCurrentKnownPlace(Base):
    """2026-10-28: his reply to "15:03-15:23 ... which of these was it?" was a Maps link
    to a shop he had left 50 minutes earlier; save-current saved it on the flat he was
    sitting in, already confirmed as The Rental Flat on five other days."""
    OPEN = {"centroid": dict(FLAT), "first_sample_ts": "2026-10-28T13:48:45+00:00",
            "last_sample_ts": "2026-10-28T14:16:12+00:00", "duration_min": 27.5}

    def setUp(self):
        super().setUp()
        flat = [dict(entry(f"lc-visit-{d}", "The Rental Flat"), ts=f"2026-10-{d}T19:30:00+00:00",
                     stop_window={"start": f"2026-10-{d}T19:00:00+00:00"}) for d in ("07", "09", "12")]
        with open(self.lc.CONFIRMED_FILE, "w") as f:
            json.dump(flat, f)

    def save(self, venue, **kw):
        lc, wrote = self.lc, []
        lc._current_stop_ask = lambda: dict(self.OPEN)
        lc._write_confirmation = lambda ask, chosen, ask_id, remove_pending=False: wrote.append(chosen["name"]) or {"name": chosen["name"]}
        rc, _ = self.run_cmd(lc.cmd_save_current, venue=venue, lookback_min=20.0, **kw)
        return rc, wrote

    def test_another_name_on_his_lodging_writes_nothing(self):
        self.assertEqual(self.save("מתוקשוק"), (5, []))

    def test_the_lodging_own_name_is_saved(self):
        self.assertEqual(self.save("the rental flat"), (0, ["the rental flat"]))

    def test_new_place_here_overrides(self):
        self.assertEqual(self.save("מתוקשוק", new_place_here=True), (0, ["מתוקשוק"]))

    def test_one_other_day_or_somewhere_else_is_not_a_known_place(self):
        with open(self.lc.CONFIRMED_FILE, "w") as f:
            json.dump([entry("lc-1", "The Rental Flat"),
                       dict(entry("lc-2", "Far Cafe", c={"lat": FLAT["lat"] + 0.001, "lon": FLAT["lon"]}),
                            stop_window={"start": "2026-10-09T08:00:00+00:00"}),
                       dict(entry("lc-3", "Far Cafe", c={"lat": FLAT["lat"] + 0.001, "lon": FLAT["lon"]}),
                            stop_window={"start": "2026-10-12T08:00:00+00:00"})], f)
        self.assertEqual(self.save("Some Cafe"), (0, ["Some Cafe"]))


if __name__ == "__main__":
    unittest.main()
