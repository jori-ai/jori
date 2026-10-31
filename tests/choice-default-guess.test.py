"""choice-default-guess — an unanswered "where was this?" card's default is
applied as a LOW-CONFIDENCE guess, and never to a stop the user already named:
the requirement is a low-confidence guess that never names nearby future stops
and that any later tap or correction overrides.

Two halves:
  - `choice sweep --apply` hands an expired, unanswered location_stop card's
    default to `findme guess` (stubbed here) and posts nothing in the chat.
  - `findme guess`'s guard refuses a row that already carries a verdict and a
    window overlapping a row the user answered: several old recorded-but-
    never-applied defaults sat under stops the user had named.

Supabase is stubbed: no request leaves this process.
Run: python3 tests/choice-default-guess.test.py
"""
import contextlib
import io
import json
import os
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "lib"))
if "pyicloud" not in sys.modules:
    _fake = types.ModuleType("pyicloud")
    _fake.PyiCloudService = object
    sys.modules["pyicloud"] = _fake


def load(name, rel):
    path = os.path.join(REPO, rel)
    mod = type(sys)(name)
    mod.__dict__["__name__"] = name
    mod.__dict__["__file__"] = path
    exec(compile(open(path).read(), path, "exec"), mod.__dict__)
    return mod


class Proc:
    def __init__(self, code, out="", err=""):
        self.returncode, self.stdout, self.stderr = code, out, err


class SweepAppliesGuess(unittest.TestCase):
    def setUp(self):
        self.ch = load("choice_guess_under_test", "bin/choice")
        self.now = datetime.now(timezone.utc)
        self.prompts, self.replies, self.calls, self.runs = [], [], [], []
        self.findme_result = Proc(0, json.dumps({"applied": True}))

        def fake_req(path, method="GET", body=None):
            self.calls.append((method, path, body))
            if method != "GET":
                return [{"id": "should-not-happen"}]
            if path.startswith("jori_messages?role=eq.assistant"):
                return self.prompts
            if path.startswith("jori_messages?reply_to=in."):
                return self.replies
            raise AssertionError(f"unexpected request {path}")

        def fake_run(cmd, **kw):
            self.runs.append(cmd)
            return self.findme_result

        self.ch.req = fake_req
        self.ch.subprocess.run = fake_run

    def card(self, mid, ref, kind="location_stop", expires_delta_h=-1, default="o1"):
        p = {"v": 1, "id": f"p-{mid}", "kind": kind, "ref": ref,
             "options": [{"id": "o1", "label": "Yes — Dama", "value": "Dama"},
                         {"id": "o2", "label": "Somewhere else", "value": "__other__"}],
             "expires_at": (self.now + timedelta(hours=expires_delta_h)).isoformat()}
        if default:
            p["default_id"] = default
        self.prompts.append({"id": mid, "content": "Where was this?",
                             "created_at": (self.now - timedelta(hours=13)).isoformat(),
                             "metadata": {"choices": json.dumps(p)}})

    def sweep(self, apply=True):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.ch.cmd_sweep(self.ch.argparse.Namespace(apply=apply))
        return out.getvalue()

    def writes(self):
        return [c for c in self.calls if c[0] != "GET"]

    def test_expired_card_default_goes_to_findme_guess_with_its_value(self):
        self.card("m1", "visit-1")
        out = self.sweep()
        self.assertEqual(len(self.runs), 1)
        cmd = self.runs[0]
        self.assertTrue(cmd[0].endswith("bin/findme"))
        self.assertEqual(cmd[1:4], ["guess", "visit-1", "Dama"],
                         "the option's stored VALUE is the guess, not the button text")
        self.assertIn("--source", cmd)
        self.assertEqual(self.writes(), [], "nothing is posted in the chat")
        self.assertIn("probably Yes — Dama", out)

    def test_report_only_without_apply(self):
        self.card("m1", "visit-1")
        out = self.sweep(apply=False)
        self.assertEqual(self.runs, [])
        self.assertIn("not applied", out)

    def test_other_kinds_are_only_reported(self):
        self.card("m1", "evt-1", kind="calendar_rsvp")
        self.sweep()
        self.assertEqual(self.runs, [])

    def test_a_tap_on_another_card_for_the_same_stop_blocks_the_guess(self):
        self.card("m-old", "visit-1")
        self.card("m-new", "visit-1")
        self.replies.append({"id": "r1", "role": "user", "content": "Corner Bakery", "reply_to": "m-new",
                             "metadata": {}, "created_at": self.now.isoformat()})
        out = self.sweep()
        self.assertEqual(self.runs, [])
        self.assertIn("answered another card", out)

    def test_card_without_default_or_unexpired_is_untouched(self):
        self.card("m1", "visit-1", default=None)
        self.card("m2", "visit-2", expires_delta_h=+3)
        self.sweep()
        self.assertEqual(self.runs, [])

    def test_findme_refusal_leaves_the_card_open(self):
        self.findme_result = Proc(2, json.dumps({"applied": False,
                                                 "reason": "row is already user-confirmed as 'Sumatra restaurant'"}))
        self.card("m1", "visit-1")
        out = self.sweep()
        self.assertIn("left open; not guessed: row is already user-confirmed", out)
        self.assertEqual(self.writes(), [])


ROW = {"id": "v1", "segment_type": "visit", "place_name": "Example Street", "place_type": "address",
       "arrived_at": "2026-10-10T04:49:00+00:00", "departed_at": "2026-10-10T05:20:00+00:00"}


class FindmeGuessGuard(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fm = load("findme_guess_under_test", "bin/findme")

    def blocker(self, row=ROW, name="Dama", answered=()):
        return self.fm.default_guess_blocker(row, name, list(answered) if answered is not None else None)

    def test_plain_geocode_row_takes_the_guess(self):
        self.assertIsNone(self.blocker())

    def test_never_over_a_stop_the_user_named(self):
        for t in ("user-confirmed", "named", "non-stop", "default-applied"):
            why = self.blocker(dict(ROW, place_type=t, place_name="Sumatra restaurant"))
            self.assertIsNotNone(why, t)
            self.assertIn(t, why)

    def test_never_over_a_twin_the_user_named(self):
        why = self.blocker(answered=[{"id": "v2", "place_type": "user-confirmed",
                                      "place_name": "Westside Market"}])
        self.assertIn("Westside Market", why)

    def test_failed_lookup_refuses_rather_than_guessing(self):
        self.assertIn("could not check", self.blocker(answered=None))

    def test_protocol_tokens_are_not_names(self):
        for v in ("__other__", "skip", "unknown", "not a stop", "  "):
            self.assertIsNotNone(self.blocker(name=v), v)

    def test_not_a_visit_row(self):
        self.assertIsNotNone(self.blocker(dict(ROW, segment_type="transit")))
        self.assertIsNotNone(self.blocker(None))

    def test_writes_default_applied_never_user_confirmed(self):
        self.assertEqual(self.fm.DEFAULT_APPLIED_TYPE, "default-applied")
        self.assertNotIn("user-confirmed", self.fm.DEFAULT_APPLIED_TYPE)


if __name__ == "__main__":
    unittest.main()
