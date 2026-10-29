"""location-stops — homes come from the installation's named-locations list,
dates without a zone are the home zone's. Synthetic homes; no network.

Run: python3 tests/location-stops.test.py
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
HOME = tempfile.mkdtemp(prefix="location-stops-")
LOCAL = tempfile.mkdtemp(prefix="location-stops-local-")
os.makedirs(os.path.join(HOME, "data"))
with open(os.path.join(HOME, "data", "named-locations.json"), "w") as fh:
    json.dump({"entries": [{"name": "Home A", "lat": 12.3456, "lon": -65.4321},
                           {"name": "Home B", "lat": 23.4567, "lon": -54.321, "address": "9 Example St, Testville"}]}, fh)
with open(os.path.join(LOCAL, "instance.json"), "w") as fh:
    json.dump({"tz": "America/Chicago"}, fh)
os.environ["JORI_HOME"] = HOME
os.environ["JORI_LOCAL_DIR"] = LOCAL

mod = type(sys)("location_stops")
mod.__dict__["__file__"] = os.path.join(REPO, "bin", "location-stops")
with open(os.path.join(REPO, "bin", "location-stops")) as fh:
    exec(compile(fh.read(), "location-stops", "exec"), mod.__dict__)


def tearDownModule():
    shutil.rmtree(HOME, ignore_errors=True)
    shutil.rmtree(LOCAL, ignore_errors=True)


class LocationStops(unittest.TestCase):
    def test_homes_are_the_installation_list(self):
        self.assertEqual([e["name"] for e in mod.NAMED_LOCATIONS], ["Home A", "Home B"])
        self.assertEqual(mod.match_named_location(12.3457, -65.4321)["name"], "Home A")
        self.assertIsNone(mod.match_named_location(12.3756, -65.4321))  # ~3 km off

    def test_a_home_without_an_address_still_geocodes_by_name(self):
        self.assertEqual(mod._geocode_address_to_coords("dinner at Home A"), (12.3456, -65.4321))
        self.assertEqual(mod._geocode_address_to_coords("9 Example St"), (23.4567, -54.321))

    def test_bare_dates_are_the_home_zone(self):
        s, e = mod.parse_period(None, "2026-07-15", "2026-07-16")
        self.assertEqual(datetime.utcfromtimestamp(s / 1000).isoformat(), "2026-07-15T05:00:00")
        self.assertEqual((e - s) / 3600000, 24)


if __name__ == "__main__":
    unittest.main()
