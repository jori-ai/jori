"""choice-sweep-truth — an unanswered card must not claim something was saved.

Rule #2: `choice sweep --apply` once posted "(no answer — recorded X)" under
every expired prompt, and nothing anywhere stored X: no `default-applied` rows,
and several sat under stops the user had named differently. The sweep posts
nothing in the chat, ever (guessing a location default through `findme guess`
is a row write, not a chat line).

Supabase is stubbed: no request leaves this process, nothing is posted.

Run: python3 tests/choice-sweep-truth.test.py
"""
import contextlib
import io
import json
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SCRIPT = os.path.join(REPO, "bin", "choice")


def load():
    mod = type(sys)("choice_sweep_under_test")
    mod.__dict__["__name__"] = "choice_sweep_under_test"
    mod.__dict__["__file__"] = SCRIPT
    exec(compile(open(SCRIPT).read(), SCRIPT, "exec"), mod.__dict__)
    return mod


def iso(dt):
    return dt.isoformat()


class SweepWritesNothing(unittest.TestCase):
    def setUp(self):
        self.ch = load()
        self.calls = []
        now = datetime.now(timezone.utc)
        self.prompts = []
        self.replies = []
        self.now = now

        def fake_req(path, method="GET", body=None):
            self.calls.append((method, path, body))
            if method != "GET":
                return [{"id": "should-not-happen"}]
            if path.startswith("jori_messages?role=eq.assistant"):
                return self.prompts
            if path.startswith("jori_messages?reply_to=in."):
                return self.replies
            raise AssertionError(f"unexpected request {path}")

        self.ch.req = fake_req
        # Now an expired location card's default goes to
        # `findme guess` (tests/choice-default-guess.test.py). Here it
        # refuses, so these cases pin what never changed: nothing is ever
        # POSTED in the chat, and a card that was not guessed says "left open".
        class Refused:
            returncode, stdout, stderr = 2, '{"applied": false, "reason": "refused in test"}', ""
        self.ch.subprocess.run = lambda *a, **k: Refused()

    def card(self, mid, expires_delta_h, default="o1"):
        p = {"v": 1, "id": f"p-{mid}", "kind": "location_stop", "ref": f"visit-{mid}",
             "options": [{"id": "o1", "label": "El Nopalito Deli"},
                         {"id": "o2", "label": "Sumatra restaurant"}],
             "expires_at": iso(self.now + timedelta(hours=expires_delta_h))}
        if default:
            p["default_id"] = default
        self.prompts.append({"id": mid, "content": "Where was this?",
                             "created_at": iso(self.now - timedelta(hours=13)),
                             "metadata": {"choices": json.dumps(p)}})

    def sweep(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.ch.cmd_sweep(self.ch.argparse.Namespace(apply=True))
        return out.getvalue()

    def writes(self):
        return [c for c in self.calls if c[0] != "GET"]

    def test_expired_unanswered_card_posts_nothing(self):
        self.card("m-expired", expires_delta_h=-1)
        out = self.sweep()
        self.assertEqual(self.writes(), [],
                         "an expired card must not get a '(no answer — recorded X)' reply")
        self.assertNotIn("recorded El Nopalito Deli", out)
        self.assertIn("left open", out)

    def test_expired_card_without_default_posts_nothing(self):
        self.card("m-nodefault", expires_delta_h=-1, default=None)
        self.sweep()
        self.assertEqual(self.writes(), [])

    def test_tapped_card_is_closed_and_untouched(self):
        self.card("m-tapped", expires_delta_h=-1)
        self.replies.append({"id": "r1", "role": "user", "content": "Sumatra restaurant",
                             "reply_to": "m-tapped", "metadata": {},
                             "created_at": iso(self.now)})
        out = self.sweep()
        self.assertEqual(self.writes(), [])
        self.assertIn("answered by tap", out)

    def test_open_card_is_untouched(self):
        self.card("m-open", expires_delta_h=+3)
        out = self.sweep()
        self.assertEqual(self.writes(), [])
        self.assertIn("not expired yet", out)


if __name__ == "__main__":
    unittest.main()
