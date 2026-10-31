#!/usr/bin/env python3
"""hum-metrics-collect-pings-delivered.test.py — unit tests for the
`pings_delivered` instrumentation field in bin/hum-metrics-collect
(hum-i-20260628-02).

`surfaced` / `ticks_info` (and the `surface_rate` they feed) come from
hum-runs.jsonl tick *decisions* -- they answer "how often did a tick decide
to ship something", not "how many pushes actually reached the user" once
whatever send-time gate or cap sits between a decision and the real push has
run. `pings_delivered` is a distinct, additive count sourced from
hum-feedback.jsonl -- written by `hum-ping` only on an actual successful
send (jobs/hum-operations.md § Step 2 file shape) -- so it's a genuine
post-delivery count. This suite checks:

  - pings_delivered_for_day(): local-day window filtering, dedup by ping_id,
    fallback to message_id, fallback to counting rows outright when neither
    id is present.
  - collect_for_day(): `pings_delivered` is present and correct alongside
    the existing fields, and adding it changes nothing else in the row
    (surfaced / ticks_info / surface_rate / signal_per_surfaced are
    untouched by this field's presence).

Run: python3 -m unittest tests/hum-metrics-collect-pings-delivered.test.py -v
"""

import importlib.machinery
import importlib.util
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


class PingsDeliveredForDayTest(unittest.TestCase):
    def setUp(self):
        self.tz = hmc.get_local_tz()
        self.target_date = date(2026, 6, 20)
        self.start, self.end = hmc.et_day_window(self.target_date, self.tz)
        self.in_day = self.start.isoformat()

    def test_counts_rows_sent_inside_window(self):
        feedback = [
            {"ping_id": "hum-1", "sent_at": self.in_day, "message_id": "m1"},
            {"ping_id": "hum-2", "sent_at": self.in_day, "message_id": "m2"},
        ]
        self.assertEqual(hmc.pings_delivered_for_day(feedback, self.start, self.end), 2)

    def test_excludes_rows_outside_window(self):
        other_day = hmc.et_day_window(date(2026, 6, 19), self.tz)[0].isoformat()
        feedback = [
            {"ping_id": "hum-1", "sent_at": self.in_day},
            {"ping_id": "hum-2", "sent_at": other_day},
        ]
        self.assertEqual(hmc.pings_delivered_for_day(feedback, self.start, self.end), 1)

    def test_dedups_by_ping_id(self):
        # Same ping_id logged twice (e.g. a retried write) must not double-count.
        feedback = [
            {"ping_id": "hum-1", "sent_at": self.in_day},
            {"ping_id": "hum-1", "sent_at": self.in_day},
        ]
        self.assertEqual(hmc.pings_delivered_for_day(feedback, self.start, self.end), 1)

    def test_falls_back_to_message_id_when_ping_id_missing(self):
        feedback = [
            {"sent_at": self.in_day, "message_id": "m1"},
            {"sent_at": self.in_day, "message_id": "m1"},
            {"sent_at": self.in_day, "message_id": "m2"},
        ]
        self.assertEqual(hmc.pings_delivered_for_day(feedback, self.start, self.end), 2)

    def test_counts_row_outright_when_no_id_present(self):
        # Neither id present -- degrade to counting the row rather than
        # silently dropping a real delivered ping because it can't be keyed.
        feedback = [
            {"sent_at": self.in_day},
            {"sent_at": self.in_day},
        ]
        self.assertEqual(hmc.pings_delivered_for_day(feedback, self.start, self.end), 2)

    def test_malformed_row_is_skipped_not_fatal(self):
        feedback = ["not-a-dict", {"ping_id": "hum-1", "sent_at": self.in_day}]
        self.assertEqual(hmc.pings_delivered_for_day(feedback, self.start, self.end), 1)

    def test_empty_feedback_is_zero(self):
        self.assertEqual(hmc.pings_delivered_for_day([], self.start, self.end), 0)


class CollectForDayPingsDeliveredTest(unittest.TestCase):
    """collect_for_day() wires pings_delivered in additively -- present and
    correct, without perturbing any pre-existing field."""

    def setUp(self):
        self.tz = hmc.get_local_tz()
        self.target_date = date(2026, 6, 20)
        self.start, self.end = hmc.et_day_window(self.target_date, self.tz)
        self.ts = self.start.isoformat()
        # collect_for_day() calls derive_context_flags(), which now shells out
        # to `home-presence` to resolve the traveling flag -- stub it so this
        # suite stays hermetic (no live Supabase/network dependency) and
        # focused on the pings_delivered fields it actually asserts on.
        # Coverage for derive_context_flags() itself lives in
        # hum-metrics-collect-traveling-flag.test.py.
        patcher = mock.patch.object(
            hmc, "derive_context_flags",
            return_value={"traveling": None, "hum_paused_hours": None,
                          "calendar_density": None})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_pings_delivered_present_and_independent_of_surfaced(self):
        # A day where hum-runs.jsonl shows one surfaced tick but
        # hum-feedback.jsonl shows more delivered pings than surfaced ticks --
        # exactly the discrepancy the action item hypothesizes.
        runs = [
            {"ts": self.ts, "sonnet": {"decision": "info", "based_on_topic": "ideas"},
             "outcome": {"sent": True, "ping_id": "p-1"},
             "harvest": {"candidates": [{"topic": "ideas"}]}},
        ]
        feedback = [
            {"ping_id": "hum-a", "sent_at": self.ts, "lane": "ideas"},
            {"ping_id": "hum-b", "sent_at": self.ts, "lane": "ideas"},
            {"ping_id": "hum-c", "sent_at": self.ts, "lane": "ideas"},
        ]
        row = hmc.collect_for_day(self.target_date, self.tz, runs, feedback, [])
        self.assertEqual(row["pings_delivered"], 3)
        # Existing fields untouched by this field's presence.
        self.assertEqual(row["surfaced"], 1)
        self.assertEqual(row["ticks_info"], 1)
        self.assertAlmostEqual(row["surface_rate"], 1.0)

    def test_pings_delivered_zero_when_no_feedback_rows(self):
        row = hmc.collect_for_day(self.target_date, self.tz, [], [], [])
        self.assertEqual(row["pings_delivered"], 0)

    def test_unrelated_fields_unchanged_from_pre_existing_behavior(self):
        # Same fixture shape as the accountability-suite's discretionary test,
        # to confirm this field's addition didn't perturb signal_per_surfaced
        # / signal_per_surfaced_discretionary computation at all.
        runs = [
            {"ts": self.ts, "sonnet": {"decision": "info", "based_on_topic": "music"},
             "outcome": {"sent": True, "ping_id": "p-mu-1"},
             "harvest": {"candidates": [{"topic": "music"}]}},
        ]
        history = [
            {"kind": "reaction", "ts": self.ts, "subject_key": "music:xyz",
             "reaction_token": "up", "message_id": "m2"},
        ]
        row = hmc.collect_for_day(self.target_date, self.tz, runs, [], history)
        self.assertEqual(row["signal_per_surfaced"], row["signal_per_surfaced_discretionary"])
        self.assertEqual(row["surfaced"], row["surfaced_discretionary"])
        self.assertEqual(row["pings_delivered"], 0)


if __name__ == "__main__":
    unittest.main()
