#!/usr/bin/env python3
"""hum-metrics-collect-qual-queue-collision.test.py — unit tests for the
single-slot collision guard in dispatch_qualitative_question() (bin/
hum-metrics-collect), hum-i-20260712-02.

hum-qual-delivery-queue.json (QUAL_QUEUE) holds exactly ONE queued
lane-diagnosis question at a time — hum-deliver-qual consumes and deletes it
once delivered, or once past its own deliver_by. dispatch_qualitative_question
is called once per decay event detected in a single collector run (see
main()'s `for ev in decay_events` loop), and its write to QUAL_QUEUE was an
unconditional full-object overwrite: two decay events landing in the same run
(observed 2026-07-09: lane_decay_silent for both 'ideas' and 'calendar' 39ms
apart) meant the second dispatch's write silently clobbered the first's
still-undelivered question, AND still stamped the clobbered lane's cooldown
as though it had been asked — blocking a re-ask for QUAL_COOLDOWN_DAYS on a
question the user never saw.

This suite covers the fix: dispatch_qualitative_question() now checks for a
live (not-yet-expired) QUAL_QUEUE occupant before writing, and skips (without
touching cooldown) when one is present.

hum-metrics-collect is Python, not Node, so this suite runs under
`python3 -m unittest` rather than `node --test`.

Run: python3 -m unittest tests/hum-metrics-collect-qual-queue-collision.test.py -v
"""

import importlib.machinery
import importlib.util
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPT_PATH = os.path.join(REPO_ROOT, "bin", "hum-metrics-collect")

# hum-metrics-collect has no .py suffix (it's a `#!/usr/bin/env python3` CLI
# entrypoint under bin/), so spec_from_file_location can't infer a
# loader from the extension -- give it one explicitly.
_loader = importlib.machinery.SourceFileLoader("hum_metrics_collect", SCRIPT_PATH)
_spec = importlib.util.spec_from_loader("hum_metrics_collect", _loader)
hmc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hmc)  # module-level code only defines funcs/consts; __name__ != "__main__"


def _decay_event(kind, lane=None):
    if kind == "lane_decay_silent":
        return {"type": "lane_decay_silent", "lane": lane, "days_silent": 6,
                "surfaced_in_window": 4, "ts": datetime.now(timezone.utc).isoformat()}
    return {"type": "global_decay_drop", "today_3d": 0.1, "baseline_7d": 0.5,
            "delta_pct": -0.8, "ts": datetime.now(timezone.utc).isoformat()}


class QualQueueCollisionTest(unittest.TestCase):
    def setUp(self):
        # Redirect QUAL_QUEUE and QUAL_COOLDOWN to scratch files for the
        # duration of each test, same pattern as the lane-scoped-measurement
        # suite's INTERVENTIONS redirect.
        fd, queue_path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        os.unlink(queue_path)  # start absent, matching a fresh/consumed queue
        self._orig_queue = hmc.QUAL_QUEUE
        hmc.QUAL_QUEUE = queue_path
        self.addCleanup(self._cleanup_path, hmc, "QUAL_QUEUE", self._orig_queue, queue_path)

        fd, cooldown_path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        os.unlink(cooldown_path)
        self._orig_cooldown = hmc.QUAL_COOLDOWN
        hmc.QUAL_COOLDOWN = cooldown_path
        self.addCleanup(self._cleanup_path, hmc, "QUAL_COOLDOWN", self._orig_cooldown, cooldown_path)

        # QUAL_STARVATION (hum-i-20260830-02, added after this suite) is
        # read AND written on every slot_occupied skip. Without redirecting
        # it, each run of this suite incremented the real
        # data/hum-qual-starvation.json, and once a key crossed
        # QUAL_STARVATION_THRESHOLD the next dispatch preempted instead of
        # skipping -- making these assertions depend on how many times the
        # suite had run before.
        fd, starvation_path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        os.unlink(starvation_path)
        self._orig_starvation = hmc.QUAL_STARVATION
        hmc.QUAL_STARVATION = starvation_path
        self.addCleanup(self._cleanup_path, hmc, "QUAL_STARVATION", self._orig_starvation, starvation_path)

        self.queue_path = queue_path
        self.cooldown_path = cooldown_path

    @staticmethod
    def _cleanup_path(module, attr, orig, path):
        setattr(module, attr, orig)
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass

    def _write_queue(self, **overrides):
        now = datetime.now(timezone.utc)
        entry = {
            "id": "qual-ideas-20260709",
            "lane": "ideas",
            "question": "What's not working with ideas?",
            "queued_at": now.isoformat(),
            "deliver_by": (now + timedelta(hours=24)).isoformat(),
        }
        entry.update(overrides)
        with open(self.queue_path, "w") as f:
            json.dump(entry, f)
        return entry

    def test_second_event_same_run_does_not_clobber_first(self):
        # Simulate main()'s loop: two lane_decay_silent events land in the
        # same run for different lanes. The first dispatch queues normally.
        row = {"lane_yield": {"ideas": {"signal_per_surfaced": 0.0},
                               "calendar": {"signal_per_surfaced": 0.0}}}
        first = hmc.dispatch_qualitative_question(_decay_event("lane_decay_silent", "ideas"), row)
        self.assertIn("queued", first)
        self.assertEqual(first["lane"], "ideas")

        with open(self.queue_path) as f:
            queued_after_first = json.load(f)
        self.assertEqual(queued_after_first["lane"], "ideas")

        # Second event, different lane, same run -- must NOT overwrite the
        # still-live 'ideas' question.
        second = hmc.dispatch_qualitative_question(_decay_event("lane_decay_silent", "calendar"), row)
        self.assertEqual(second["skipped"], "slot_occupied")
        self.assertEqual(second["lane"], "calendar")
        self.assertEqual(second["occupied_by_lane"], "ideas")

        with open(self.queue_path) as f:
            queue_still = json.load(f)
        self.assertEqual(queue_still["lane"], "ideas",
                          "the first-dispatched lane's question must survive the second call")

    def test_skipped_lane_cooldown_is_not_stamped(self):
        self._write_queue(lane="ideas")
        row = {"lane_yield": {}}
        result = hmc.dispatch_qualitative_question(_decay_event("lane_decay_silent", "calendar"), row)
        self.assertEqual(result["skipped"], "slot_occupied")

        cooldown = hmc.load_json(self.cooldown_path, {})
        # Cooldown keys are "<lane>:<event_type>" since hum-i-20260712-03;
        # the bare-lane key is only a legacy read fallback. Check both.
        self.assertNotIn("calendar:lane_decay_silent", cooldown,
                          "a skipped (never-delivered) lane must not have its cooldown stamped")
        self.assertNotIn("calendar", cooldown,
                          "a skipped (never-delivered) lane must not have its cooldown stamped")

    def test_expired_occupant_does_not_block_new_write(self):
        # The occupant's deliver_by is in the past (hum-deliver-qual would
        # have dropped it as stale on its next tick, but hasn't run yet) --
        # a new dispatch should proceed rather than treat it as still live.
        past = datetime.now(timezone.utc) - timedelta(hours=1)
        self._write_queue(lane="ideas", deliver_by=past.isoformat())
        row = {"lane_yield": {"calendar": {"signal_per_surfaced": 0.0}}}
        result = hmc.dispatch_qualitative_question(_decay_event("lane_decay_silent", "calendar"), row)
        self.assertIn("queued", result)
        self.assertEqual(result["lane"], "calendar")

        with open(self.queue_path) as f:
            queue_now = json.load(f)
        self.assertEqual(queue_now["lane"], "calendar")

    def test_missing_queue_file_writes_normally(self):
        # No file at all (already delivered + unlinked by hum-deliver-qual).
        self.assertFalse(os.path.exists(self.queue_path))
        row = {"lane_yield": {"music": {"signal_per_surfaced": 0.0}}}
        result = hmc.dispatch_qualitative_question(_decay_event("lane_decay_silent", "music"), row)
        self.assertIn("queued", result)

    def test_malformed_deliver_by_treated_as_still_occupied(self):
        # Defensive: an unparseable deliver_by must never be read as "already
        # expired" and clobbered -- fail toward not destroying a live question.
        self._write_queue(lane="ideas", deliver_by="not-a-timestamp")
        row = {"lane_yield": {}}
        result = hmc.dispatch_qualitative_question(_decay_event("lane_decay_silent", "calendar"), row)
        self.assertEqual(result["skipped"], "slot_occupied")

    def test_global_decay_drop_event_also_respects_slot_guard(self):
        self._write_queue(lane="ideas")
        row = {"lane_yield": {}}
        result = hmc.dispatch_qualitative_question(_decay_event("global_decay_drop"), row)
        self.assertEqual(result["skipped"], "slot_occupied")
        self.assertEqual(result["lane"], "global")

    def test_normal_single_event_still_queues_and_stamps_cooldown(self):
        # No-regression check: a lone decay event with an empty queue behaves
        # exactly as before the fix.
        row = {"lane_yield": {"music": {"signal_per_surfaced": 0.0}}}
        result = hmc.dispatch_qualitative_question(_decay_event("lane_decay_silent", "music"), row)
        self.assertEqual(result["queued"], "qual-music-" + datetime.now(timezone.utc).strftime("%Y%m%d"))
        cooldown = hmc.load_json(self.cooldown_path, {})
        # Keyed by (lane, event_type) as of hum-i-20260712-03, not the bare
        # lane name -- see dispatch_qualitative_question's docstring.
        self.assertIn("music:lane_decay_silent", cooldown)


if __name__ == "__main__":
    unittest.main()
