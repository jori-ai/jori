#!/usr/bin/env python3
"""hum-metrics-collect-traveling-flag.test.py — unit tests for the
`traveling` context flag in derive_context_flags() (bin/hum-metrics-collect).

Prior behavior: a hand-rolled single-city lat/lon bounding box over
confirmed-stops.json. Two failures motivated this fix:
  1. A day fully at the user's other home scored as "out of the bbox" and
     got flagged `traveling: true` -- a false positive that would mislead
     hum-improvement-ideation's confounder-honesty check
     (agent/ops-agent/jobs/hum-improvement-ideation.md § Safety
     Invariants) into blaming travel for ordinary at-home engagement.
  2. Any day without confirmed-stops rows (29 of the last 30 in the
     hypothesis's evidence) returned `traveling: null` -- no signal at all.

Fix: resolve against the canonical travel timeline via the `home-presence`
CLI (lib/presence.js HOME_METROS), which already knows
every home base and fails open to "at home" absent a timeline signal.
`traveling` is the negation of its `at_home` verdict.

hum-metrics-collect is Python, not Node, so this suite runs under
`python3 -m unittest` rather than `node --test`. It never calls the real
`home-presence` binary -- subprocess.run is monkeypatched in every test.

Run: python3 -m unittest tests/hum-metrics-collect-traveling-flag.test.py -v
"""

import importlib.machinery
import importlib.util
import json
import os
import unittest
from datetime import date
from unittest import mock

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPT_PATH = os.path.join(REPO_ROOT, "bin", "hum-metrics-collect")

# hum-metrics-collect has no .py suffix (it's a `#!/usr/bin/env python3` CLI
# entrypoint under bin/), so spec_from_file_location can't infer a
# loader from the extension -- give it one explicitly.
_loader = importlib.machinery.SourceFileLoader("hum_metrics_collect", SCRIPT_PATH)
_spec = importlib.util.spec_from_loader("hum_metrics_collect", _loader)
hmc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hmc)  # module-level code only defines funcs/consts; __name__ != "__main__"


def _fake_run(at_home=None, raise_exc=None, bad_json=False, returncode=0, extra=None):
    def fake(*args, **kwargs):
        if raise_exc:
            raise raise_exc
        result = mock.Mock()
        if bad_json:
            result.stdout = "not json"
        else:
            payload = {"date": "2026-08-24", "reason": "test"}
            if at_home is not None:
                payload["at_home"] = at_home
            if extra:
                payload.update(extra)
            result.stdout = json.dumps(payload)
        result.returncode = returncode
        return result
    return fake


class DeriveContextFlagsTravelingTest(unittest.TestCase):
    def setUp(self):
        self.tz = hmc.get_local_tz()
        self.target_date = date(2026, 8, 24)
        # derive_context_flags also makes a `gog calendar list` subprocess
        # call for calendar_density (hum-i-20260927-01, added after this
        # suite; covered by hum-metrics-collect-calendar-density.test.py).
        # Stub it out so the subprocess.run fakes below see only the
        # home-presence call.
        patcher = mock.patch.object(hmc, "derive_calendar_density", return_value=None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_false_when_home_presence_reports_at_home(self):
        # e.g. a day fully at a second home -- home-presence knows it is a
        # home metro, so at_home=true -- must NOT read as travel.
        with mock.patch.object(hmc.subprocess, "run", _fake_run(at_home=True)):
            flags = hmc.derive_context_flags(self.target_date, self.tz)
        self.assertIs(flags["traveling"], False)

    def test_true_when_home_presence_reports_away(self):
        with mock.patch.object(hmc.subprocess, "run", _fake_run(at_home=False)):
            flags = hmc.derive_context_flags(self.target_date, self.tz)
        self.assertIs(flags["traveling"], True)

    def test_true_when_home_presence_exits_nonzero_but_still_reports_away(self):
        # home-presence can exit 1 (away) while still printing valid JSON --
        # the flag must come from the parsed body, not the exit code.
        with mock.patch.object(hmc.subprocess, "run",
                                _fake_run(at_home=False, returncode=1)):
            flags = hmc.derive_context_flags(self.target_date, self.tz)
        self.assertIs(flags["traveling"], True)

    def test_reads_fail_open_at_home_even_on_error_exit(self):
        # home-presence's own internal error path still emits
        # {"at_home": true, ..., "error": true} on exit 2 (its fail-open
        # contract) -- that verdict should be honored, not discarded.
        with mock.patch.object(
                hmc.subprocess, "run",
                _fake_run(at_home=True, returncode=2, extra={"error": True})):
            flags = hmc.derive_context_flags(self.target_date, self.tz)
        self.assertIs(flags["traveling"], False)

    def test_null_on_subprocess_failure(self):
        with mock.patch.object(hmc.subprocess, "run",
                                _fake_run(raise_exc=RuntimeError("boom"))):
            flags = hmc.derive_context_flags(self.target_date, self.tz)
        self.assertIsNone(flags["traveling"])

    def test_null_on_malformed_json(self):
        with mock.patch.object(hmc.subprocess, "run", _fake_run(bad_json=True)):
            flags = hmc.derive_context_flags(self.target_date, self.tz)
        self.assertIsNone(flags["traveling"])

    def test_null_when_at_home_key_missing(self):
        with mock.patch.object(hmc.subprocess, "run", _fake_run(at_home=None)):
            flags = hmc.derive_context_flags(self.target_date, self.tz)
        self.assertIsNone(flags["traveling"])

    def test_null_when_at_home_not_a_bool(self):
        with mock.patch.object(hmc.subprocess, "run",
                                _fake_run(extra={"at_home": "yes"})):
            flags = hmc.derive_context_flags(self.target_date, self.tz)
        self.assertIsNone(flags["traveling"])

    def test_calls_home_presence_with_the_target_date_not_today(self):
        # This script processes one historical local day at a time -- the
        # travel-CLI call must be scoped to that date, never "today".
        captured = {}

        def fake(args, **kwargs):
            captured["args"] = args
            result = mock.Mock()
            result.stdout = json.dumps({"at_home": True})
            result.returncode = 0
            return result

        with mock.patch.object(hmc.subprocess, "run", fake):
            hmc.derive_context_flags(date(2026, 3, 1), self.tz)
        self.assertEqual(captured["args"][0], hmc.HOME_PRESENCE_BIN)
        self.assertIn("2026-03-01", captured["args"])
        self.assertIn("--json", captured["args"])


if __name__ == "__main__":
    unittest.main()
