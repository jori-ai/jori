"""location-annotate — an unfamiliar companion is refused, the roster is the
installation's data/known-companions.json, times without a zone are the home
zone's. Synthetic names; no network, nothing written to the live roster.

Run: python3 tests/location-annotate.test.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BIN = os.path.join(REPO, "bin", "location-annotate")
HOME = tempfile.mkdtemp(prefix="location-annotate-")
LOCAL = tempfile.mkdtemp(prefix="location-annotate-local-")
os.makedirs(os.path.join(HOME, "data"))
with open(os.path.join(HOME, "data", "known-companions.json"), "w") as fh:
    json.dump({"names": ["Sam Example", "Rover"]}, fh)
with open(os.path.join(LOCAL, "instance.json"), "w") as fh:
    json.dump({"tz": "America/Chicago"}, fh)
ENV = {**os.environ, "JORI_HOME": HOME, "JORI_LOCAL_DIR": LOCAL}
os.environ.update({"JORI_HOME": HOME, "JORI_LOCAL_DIR": LOCAL})

mod = type(sys)("location_annotate")
mod.__dict__["__file__"] = BIN
with open(BIN) as fh:
    exec(compile(fh.read(), "location-annotate", "exec"), mod.__dict__)


def tearDownModule():
    shutil.rmtree(HOME, ignore_errors=True)
    shutil.rmtree(LOCAL, ignore_errors=True)


class Companions(unittest.TestCase):
    def test_the_roster_is_the_installation_file(self):
        self.assertEqual(mod.KNOWN_FILE, os.path.join(HOME, "data", "known-companions.json"))
        known = mod.load_known_companions()
        self.assertTrue(mod.is_known_companion("Sam", known), "a first name opens a known full name")
        self.assertTrue(mod.is_known_companion("rover", known))
        self.assertFalse(mod.is_known_companion("Iad", known))

    def test_an_unfamiliar_name_is_refused_before_anything_is_read(self):
        r = subprocess.run([BIN, "--last", "30m", "--companion", "Iad"], capture_output=True, text=True, env=ENV)
        self.assertEqual(r.returncode, mod.EXIT_UNKNOWN_COMPANION)
        self.assertEqual(json.loads(r.stderr)["unknown"], ["Iad"])


class Window(unittest.TestCase):
    def test_bare_start_and_end_are_the_home_zone(self):
        a = types.SimpleNamespace(last=None, start="2026-07-15T12:00", end="2026-07-15T13:00",
                                  today=None, yesterday=None, date=None, date_range=None)
        s, e = mod.resolve_window(a)
        self.assertEqual(s.isoformat(), "2026-07-15T17:00:00+00:00")
        self.assertEqual(e.isoformat(), "2026-07-15T18:00:00+00:00")


class NearbyVisit(unittest.TestCase):
    """A note stamps the next unresolved visit, never one that ended before the window."""

    def stamp(self, rows, start="2026-07-15T19:23:16+00:00"):
        import io
        from unittest import mock
        patched = []
        body = io.BytesIO(json.dumps(rows).encode())
        fake = mock.MagicMock()
        fake.__enter__.return_value = body
        with mock.patch.object(mod.urllib.request, "urlopen", return_value=fake), \
             mock.patch.dict(mod.__dict__, {
                 "get_key": lambda: "k",
                 "patch_row": lambda rid, patch: patched.append((rid, patch)) or True}):
            out = mod.resolve_nearby_visit(mod.datetime.fromisoformat(start), "Sam came over")
        return out, patched

    def test_a_pause_that_ended_before_the_window_is_left_alone(self):
        out, patched = self.stamp([
            {"id": "pause", "arrived_at": "2026-07-15T19:15:38+00:00",
             "departed_at": "2026-07-15T19:18:16+00:00", "place_type": "address", "place_name": "1 Example St"},
            {"id": "home", "arrived_at": "2026-07-15T19:23:16+00:00",
             "departed_at": "2026-07-16T03:12:26+00:00", "place_type": "named", "place_name": "Home"},
        ])
        self.assertIsNone(out)
        self.assertEqual(patched, [])

    def test_a_visit_still_open_at_the_window_is_stamped(self):
        out, patched = self.stamp([
            {"id": "early", "arrived_at": "2026-07-15T19:20:00+00:00",
             "departed_at": "2026-07-15T19:40:00+00:00", "place_type": "address", "place_name": "2 Example St"},
        ])
        self.assertEqual(out["id"], "early")
        self.assertEqual(patched, [("early", {"place_name": "Sam came over", "place_type": "user-confirmed"})])

    def test_the_destination_after_a_named_stop_is_stamped(self):
        out, patched = self.stamp([
            {"id": "pause", "arrived_at": "2026-07-15T19:10:00+00:00",
             "departed_at": "2026-07-15T19:12:00+00:00", "place_type": None, "place_name": None},
            {"id": "home", "arrived_at": "2026-07-15T19:23:16+00:00",
             "departed_at": "2026-07-15T19:30:00+00:00", "place_type": "named", "place_name": "Home"},
            {"id": "cafe", "arrived_at": "2026-07-15T19:45:00Z",
             "departed_at": None, "place_type": "poi", "place_name": "Example Cafe"},
        ])
        self.assertEqual(out["id"], "cafe")
        self.assertEqual([p[0] for p in patched], ["cafe"])


if __name__ == "__main__":
    unittest.main()
