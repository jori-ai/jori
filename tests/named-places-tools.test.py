"""named-places-tools — the small Python location tools read the user's named
places from data/named-locations.json (by name or alias) and the database
from the installation's config, never from literals in the code.

  - lib/named_places.py: load / resolve by name or alias / nearest.
  - lib/supabase_local.py: no project configured reads as "not configured".
  - geofence-check, location-commute, location-pattern: named targets resolve
    through the file (the network calls are never made here).

Synthetic places and coordinates. Run: python3 tests/named-places-tools.test.py
"""
import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "lib"))

TMP = tempfile.mkdtemp(prefix="named-places-")
NAMED = os.path.join(TMP, "named-locations.json")
with open(NAMED, "w") as fh:
    json.dump({"entries": [
        {"name": "Home A", "lat": 12.3456, "lon": -65.4321, "kind": "home", "aliases": ["home", "Base"],
         "address": "1 Example St"},
        {"name": "Family B", "lat": 23.4567, "lon": -54.321, "kind": "family", "aliases": ["fam"]},
        {"name": "No Coords", "address": "2 Example St", "tz": "UTC"},
    ]}, fh)
os.environ["JORI_NAMED_LOCATIONS_FILE"] = NAMED
os.environ["JORI_LOCAL_DIR"] = os.path.join(TMP, "local")  # fresh install: no instance.json
os.environ["JORI_HOME"] = TMP                               # no .env
for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JORI_SUPABASE_PROJECT"):
    os.environ.pop(k, None)

import named_places  # noqa: E402
import supabase_local  # noqa: E402


def load_bin(name):
    path = os.path.join(REPO, "bin", name)
    loader = importlib.machinery.SourceFileLoader(name.replace("-", "_"), path)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class NamedPlaces(unittest.TestCase):
    def test_load_skips_entries_without_coordinates(self):
        self.assertEqual([e["name"] for e in named_places.load()], ["Home A", "Family B"])

    def test_resolve_by_name_or_alias(self):
        self.assertEqual(named_places.resolve("home")["name"], "Home A")
        self.assertEqual(named_places.resolve("base")["name"], "Home A")
        self.assertEqual(named_places.resolve("FAMILY B")["name"], "Family B")
        self.assertIsNone(named_places.resolve("nowhere"))

    def test_nearest_within_radius(self):
        e, d = named_places.nearest(12.3460, -65.4321, 0.15)
        self.assertEqual(e["name"], "Home A")
        self.assertLess(d, 0.1)
        self.assertEqual(named_places.nearest(0.0, 0.0, 0.15), (None, None))

    def test_missing_file_is_empty(self):
        self.assertEqual(named_places.load(os.path.join(TMP, "absent.json")), [])


class Supabase(unittest.TestCase):
    def test_unconfigured(self):
        self.assertEqual(supabase_local.supabase_url(), "")
        self.assertIsNone(supabase_local.service_key())
        with self.assertRaises(RuntimeError):
            supabase_local.rest_get("location_history?limit=1")

    def test_project_from_env(self):
        proj = "exampleproj"
        os.environ["JORI_SUPABASE_PROJECT"] = proj
        try:
            self.assertEqual(supabase_local.supabase_url(), f"https://{proj}.supabase.co")
        finally:
            os.environ.pop("JORI_SUPABASE_PROJECT")


class Tools(unittest.TestCase):
    def test_geofence_check_named_target(self):
        g = load_bin("geofence-check")
        g.latest_location = lambda: {"latitude": 12.3457, "longitude": -65.4321,
                                     "arrived_at": "2026-01-01T00:00:00Z", "accuracy_m": 10}
        sys.argv = ["geofence-check", "home"]
        out = io.StringIO()
        with redirect_stdout(out):
            g.main()
        r = json.loads(out.getvalue())
        self.assertEqual(r["target"]["name"], "Home A")
        self.assertTrue(r["inside"])

    def test_geofence_check_no_database_is_no_data(self):
        g = load_bin("geofence-check")
        self.assertIsNone(g.latest_location())

    def test_commute_destination(self):
        c = load_bin("location-commute")
        self.assertEqual(c.resolve_destination("fam")["name"], "Family B")
        self.assertEqual(c.resolve_destination("Some Venue, 3 Example Rd"),
                         {"name": "Some Venue, 3 Example Rd", "address": "Some Venue, 3 Example Rd"})

    def test_pattern_match_named(self):
        p = load_bin("location-pattern")
        self.assertEqual(p.match_named(23.4568, -54.321), "Family B")
        self.assertIsNone(p.match_named(0.0, 0.0))


if __name__ == "__main__":
    unittest.main()
