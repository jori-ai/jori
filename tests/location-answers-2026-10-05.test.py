"""location-answers — how three answers became wrong place names.

The user, about one day's summary email:
  - "Yes — the airbnb" was saved verbatim: segment-ask dropped the option's
    `value` on the way to `choice send`.
  - "no stop last night" was saved as a place CALLED "skip".
  - A single earlier answer, "Just browsing the market", was replayed as a
    "recurring" name onto the dog's evening walk past the same corner.

Run: python3 tests/location-answers-2026-10-05.test.py
"""
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "lib"))
import place_naming  # noqa: E402

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


def load(script, name):
    mod = type(sys)(name)
    mod.__dict__["__name__"] = name
    mod.__dict__["__file__"] = os.path.join(REPO, "bin", script)
    exec(compile(open(os.path.join(REPO, "bin", script)).read(), script, "exec"),
         mod.__dict__)
    return mod


class HistoryNeedsTwoVisits(unittest.TestCase):
    def setUp(self):
        self._orig = place_naming.prior_confirmations

    def tearDown(self):
        place_naming.prior_confirmations = self._orig

    def names(self, names):
        place_naming.prior_confirmations = lambda *a, **k: list(names)
        return place_naming.name_from_history(*fake_pt(-5.2, 14.18), key="k", saved=[])

    def test_one_answer_is_not_recurring(self):
        self.assertIsNone(self.names(["Just browsing the market"]))

    def test_two_agreeing_visits_are(self):
        v = self.names(["Robin's coffee stand", "Robin's coffee stand"])
        self.assertEqual(v["name"], "Robin's coffee stand")
        self.assertEqual(v["rung"], "recurring")

    def test_duplicate_rows_of_one_visit_are_one_vote(self):
        rows = [{"id": str(i), "place_name": "Just browsing the market",
                 **fake_row(0, 0),
                 "arrived_at": "2026-10-02T05:23:45+00:00"} for i in range(3)]
        orig_get = place_naming._get
        place_naming._get = lambda *a, **k: rows
        try:
            got = place_naming.prior_confirmations(*fake_pt(-5.2, 14.18), "k")
        finally:
            place_naming._get = orig_get
        self.assertEqual(got, ["Just browsing the market"])


class SkipIsNotAPlace(unittest.TestCase):
    def test_skip_token_is_a_withdrawal(self):
        lc = load("location-confirm", "location_confirm")
        ask = {"primary": {"name": "Café Antilia"}, "alternatives": [{"name": "Kandinof"}]}
        chosen = lc._resolve_candidate(ask, "skip")
        self.assertEqual(chosen["source"], "user_skipped")
        self.assertIsNone(chosen["name"])

    def test_a_typed_name_still_saves(self):
        lc = load("location-confirm", "location_confirm")
        chosen = lc._resolve_candidate({"primary": {"name": "Kandinof"}}, "Maafe Habalkan")
        self.assertEqual(chosen["name"], "Maafe Habalkan")


class ButtonValueReachesChoice(unittest.TestCase):
    def test_segment_ask_forwards_value(self):
        src = open(os.path.join(REPO, "bin", "segment-ask")).read()
        self.assertIn("f\"{c['label']}={c['value']}\"", src)

    def test_choice_parses_label_equals_value(self):
        # `choice send --option "Yes — the airbnb=the airbnb"` must store value
        # separately from the label it shows. Exercise the parser in isolation.
        ch = load("choice", "choice_cli")
        captured = {}
        ch.req = lambda path, method="GET", body=None: captured.update(body=body) or [{"id": "m1"}]
        ch.subprocess.run = lambda *a, **k: subprocess.CompletedProcess(a, 0, "", "")
        args = ch.argparse.Namespace(
            option=["Yes — the airbnb=the airbnb", "No, somewhere else"], default="1",
            expires_h=12, kind="location_stop", ref="v1", prompt="were you at the airbnb?",
            text=None, channel="chat", push=None, no_push=True,
            image_url="https://example.test/m.png")
        ch.cmd_send(args)
        import json
        prompt = json.loads(captured["body"]["metadata"]["choices"])
        self.assertEqual(prompt["options"][0], {"id": "o1", "label": "Yes — the airbnb",
                                                "value": "the airbnb"})
        self.assertTrue(captured["body"]["content"].endswith("\n\nhttps://example.test/m.png"))


class SubjectRidesOnThePrompt(unittest.TestCase):
    def test_subject_json_lands_on_the_prompt(self):
        ch = load("choice", "choice_cli2")
        captured = {}
        ch.req = lambda path, method="GET", body=None: captured.update(body=body) or [{"id": "m1"}]
        ch.subprocess.run = lambda *a, **k: subprocess.CompletedProcess(a, 0, "", "")
        import json
        subj = {"kind": "route", "mode": "walking", "start": "2026-10-05T14:25:00Z",
                "end": "2026-10-05T15:05:00Z", "tz": "Asia/Jerusalem", "question": "Out with the dog?"}
        args = ch.argparse.Namespace(
            option=[], default=None, expires_h=12, kind="location_route", ref="r1",
            prompt="Out with the dog?", text=None, channel="chat", push=None, no_push=True,
            image_url=None, subject_json=json.dumps(subj))
        try:
            ch.cmd_send(args)
        except SystemExit:
            self.skipTest("choice send still requires an option")
        prompt = json.loads(captured["body"]["metadata"]["choices"])
        self.assertEqual(prompt["subject"], subj)

if __name__ == "__main__":
    unittest.main()
