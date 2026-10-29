#!/usr/bin/env python3
"""hum-metrics-collect-decay-dedup.test.py — unit tests for the
decay-triggered-ideation dedup gate in bin/hum-metrics-collect
(hum-i-20260711-02).

Background: trigger-hum-metrics-collect.sh dispatches a full ops-agent
`HUM IMPROVEMENT IDEATION: decay <lane>` turn whenever today's decay event
lane has ANY answered qualitative-diagnosis question on file for it -- with
no check for whether that exact answer already produced a fix idea that's
simply sitting open/unapplied. Measured: the `ideas` lane dispatched four
byte-for-byte redundant ideation turns (7/7, 7/9, 7/10, 7/11) for the
identical `qual-ideas-20260707` answer, each re-deriving the same
conclusion (fix already proposed as hum-i-20260705-01/-02) at full xhigh
cost with zero new signal.

This suite covers the three new functions that close the gap:

  - latest_qualitative_id_for_lane(): which answered qual-*.json id is
    "current" for a lane, sorted by answered_at (falling back to asked_at),
    not file order.
  - find_blocking_idea(): whether an open (status: proposed) idea already
    cites that exact (lane, qualitative_id) pair -- and that a *resolved*
    idea (applied / abandoned / retired / no_change_recommended) no longer
    blocks, so a fresh decay against an old, already-fixed diagnosis is not
    permanently suppressed.
  - bump_recurrence() / run_dedup_check(): the CLI-facing (--dedup-check)
    entry point, including its fail-open behavior on any internal error.

hum-metrics-collect is Python, not Node, so this suite runs under
`python3 -m unittest` rather than `node --test`.

Run: python3 -m unittest tests/hum-metrics-collect-decay-dedup.test.py -v
"""

import importlib.machinery
import importlib.util
import json
import os
import tempfile
import unittest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPT_PATH = os.path.join(REPO_ROOT, "bin", "hum-metrics-collect")

# hum-metrics-collect has no .py suffix (it's a `#!/usr/bin/env python3` CLI
# entrypoint under bin/), so spec_from_file_location can't infer a
# loader from the extension -- give it one explicitly.
_loader = importlib.machinery.SourceFileLoader("hum_metrics_collect", SCRIPT_PATH)
_spec = importlib.util.spec_from_loader("hum_metrics_collect", _loader)
hmc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hmc)  # module-level code only defines funcs/consts; __name__ != "__main__"


class LatestQualitativeIdForLaneTest(unittest.TestCase):
    def test_none_when_no_learnings_for_lane(self):
        learnings = [{"id": "qual-music-20260520", "subject": "hum music lane decay"}]
        self.assertIsNone(hmc.latest_qualitative_id_for_lane("ideas", learnings))

    def test_matches_on_exact_subject_shape(self):
        learnings = [{"id": "qual-ideas-20260707", "subject": "hum ideas decay",
                      "answered_at": "2026-07-08T12:09:47.291Z"}]
        self.assertEqual(hmc.latest_qualitative_id_for_lane("ideas", learnings),
                          "qual-ideas-20260707")

    def test_picks_most_recently_answered_when_several_exist(self):
        learnings = [
            {"id": "qual-ideas-20260707", "subject": "hum ideas decay",
             "answered_at": "2026-07-08T12:09:47.291Z"},
            {"id": "qual-ideas-20260801", "subject": "hum ideas decay",
             "answered_at": "2026-08-01T09:00:00Z"},
        ]
        self.assertEqual(hmc.latest_qualitative_id_for_lane("ideas", learnings),
                          "qual-ideas-20260801")

    def test_not_fooled_by_file_order_only_by_answered_at(self):
        # Newer answer appears EARLIER in the (append-only, but not always
        # perfectly ordered) file -- sort must still pick it correctly.
        learnings = [
            {"id": "qual-ideas-20260801", "subject": "hum ideas decay",
             "answered_at": "2026-08-01T09:00:00Z"},
            {"id": "qual-ideas-20260707", "subject": "hum ideas decay",
             "answered_at": "2026-07-08T12:09:47.291Z"},
        ]
        self.assertEqual(hmc.latest_qualitative_id_for_lane("ideas", learnings),
                          "qual-ideas-20260801")

    def test_falls_back_to_asked_at_when_answered_at_missing(self):
        learnings = [
            {"id": "qual-ideas-early", "subject": "hum ideas decay",
             "asked_at": "2026-07-01T00:00:00Z"},
            {"id": "qual-ideas-late", "subject": "hum ideas decay",
             "asked_at": "2026-07-20T00:00:00Z"},
        ]
        self.assertEqual(hmc.latest_qualitative_id_for_lane("ideas", learnings),
                          "qual-ideas-late")

    def test_ignores_rows_without_id(self):
        learnings = [{"subject": "hum ideas decay", "answered_at": "2026-07-08T00:00:00Z"}]
        self.assertIsNone(hmc.latest_qualitative_id_for_lane("ideas", learnings))

    def test_tolerates_non_dict_rows(self):
        learnings = ["not-a-dict", {"id": "qual-ideas-20260707", "subject": "hum ideas decay",
                                     "answered_at": "2026-07-08T00:00:00Z"}]
        self.assertEqual(hmc.latest_qualitative_id_for_lane("ideas", learnings),
                          "qual-ideas-20260707")


class FindBlockingIdeaTest(unittest.TestCase):
    def test_none_when_qualitative_id_falsy(self):
        ideas = [{"lane": "ideas", "status": "proposed",
                  "evidence": {"qualitative_id": "qual-ideas-20260707"}}]
        self.assertIsNone(hmc.find_blocking_idea("ideas", None, ideas))
        self.assertIsNone(hmc.find_blocking_idea("ideas", "", ideas))

    def test_none_when_no_row_matches_lane(self):
        ideas = [{"id": "hum-i-1", "lane": "music", "status": "proposed",
                  "evidence": {"qualitative_id": "qual-ideas-20260707"}}]
        self.assertIsNone(hmc.find_blocking_idea("ideas", "qual-ideas-20260707", ideas))

    def test_none_when_qualitative_id_differs(self):
        ideas = [{"id": "hum-i-1", "lane": "ideas", "status": "proposed",
                  "evidence": {"qualitative_id": "qual-ideas-OLDER"}}]
        self.assertIsNone(hmc.find_blocking_idea("ideas", "qual-ideas-20260707", ideas))

    def test_matches_open_proposed_idea(self):
        ideas = [{"id": "hum-i-20260711-02", "lane": "ideas", "status": "proposed",
                  "evidence": {"qualitative_id": "qual-ideas-20260707"}}]
        blocker = hmc.find_blocking_idea("ideas", "qual-ideas-20260707", ideas)
        self.assertIsNotNone(blocker)
        self.assertEqual(blocker["id"], "hum-i-20260711-02")

    def test_resolved_statuses_do_not_block(self):
        for status in ("applied", "abandoned", "retired", "no_change_recommended"):
            with self.subTest(status=status):
                ideas = [{"id": "hum-i-1", "lane": "ideas", "status": status,
                          "evidence": {"qualitative_id": "qual-ideas-20260707"}}]
                self.assertIsNone(hmc.find_blocking_idea("ideas", "qual-ideas-20260707", ideas))

    def test_most_recent_open_match_wins_when_several_exist(self):
        ideas = [
            {"id": "hum-i-20260801-01", "lane": "ideas", "status": "proposed",
             "evidence": {"qualitative_id": "qual-ideas-20260707"}},
            {"id": "hum-i-20260802-01", "lane": "ideas", "status": "proposed",
             "evidence": {"qualitative_id": "qual-ideas-20260707"}},
        ]
        blocker = hmc.find_blocking_idea("ideas", "qual-ideas-20260707", ideas)
        self.assertEqual(blocker["id"], "hum-i-20260802-01")

    def test_tolerates_non_dict_rows(self):
        ideas = ["not-a-dict", {"id": "hum-i-1", "lane": "ideas", "status": "proposed",
                                 "evidence": {"qualitative_id": "qual-ideas-20260707"}}]
        blocker = hmc.find_blocking_idea("ideas", "qual-ideas-20260707", ideas)
        self.assertEqual(blocker["id"], "hum-i-1")


class BumpRecurrenceAndDedupCheckTest(unittest.TestCase):
    def setUp(self):
        # Redirect HUM_LEARNINGS / HUM_IMPROVEMENT_IDEAS to scratch files for
        # the duration of each test, same pattern as
        # hum-metrics-collect-lane-scoped-measurement.test.py uses for
        # INTERVENTIONS -- never touch the real repo data files.
        fd1, self.learnings_path = tempfile.mkstemp(suffix=".jsonl")
        os.close(fd1)
        fd2, self.ideas_path = tempfile.mkstemp(suffix=".jsonl")
        os.close(fd2)
        self._orig_learnings = hmc.HUM_LEARNINGS
        self._orig_ideas = hmc.HUM_IMPROVEMENT_IDEAS
        hmc.HUM_LEARNINGS = self.learnings_path
        hmc.HUM_IMPROVEMENT_IDEAS = self.ideas_path
        self.addCleanup(setattr, hmc, "HUM_LEARNINGS", self._orig_learnings)
        self.addCleanup(setattr, hmc, "HUM_IMPROVEMENT_IDEAS", self._orig_ideas)
        self.addCleanup(os.remove, self.learnings_path)
        self.addCleanup(os.remove, self.ideas_path)

    def _write_jsonl(self, path, rows):
        with open(path, "w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")

    def test_bump_recurrence_first_time_sets_count_to_1(self):
        ideas_rows = [{"id": "hum-i-1", "lane": "ideas", "status": "proposed",
                       "evidence": {"qualitative_id": "qual-ideas-20260707"}}]
        new_count = hmc.bump_recurrence("hum-i-1", ideas_rows)
        self.assertEqual(new_count, 1)
        with open(hmc.HUM_IMPROVEMENT_IDEAS) as f:
            written = json.loads(f.readline())
        self.assertEqual(written["recurrence_count"], 1)
        self.assertEqual(len(written["recurrence_dispatches"]), 1)

    def test_bump_recurrence_increments_existing_count(self):
        ideas_rows = [{"id": "hum-i-1", "lane": "ideas", "status": "proposed",
                       "recurrence_count": 2,
                       "recurrence_dispatches": ["2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z"],
                       "evidence": {"qualitative_id": "qual-ideas-20260707"}}]
        new_count = hmc.bump_recurrence("hum-i-1", ideas_rows)
        self.assertEqual(new_count, 3)
        with open(hmc.HUM_IMPROVEMENT_IDEAS) as f:
            written = json.loads(f.readline())
        self.assertEqual(written["recurrence_count"], 3)
        self.assertEqual(len(written["recurrence_dispatches"]), 3)

    def test_bump_recurrence_preserves_other_rows_untouched(self):
        ideas_rows = [
            {"id": "hum-i-1", "lane": "ideas", "status": "proposed",
             "evidence": {"qualitative_id": "qual-ideas-20260707"}},
            {"id": "hum-i-2", "lane": "music", "status": "proposed",
             "evidence": {"qualitative_id": "qual-music-20260520"}},
        ]
        hmc.bump_recurrence("hum-i-1", ideas_rows)
        with open(hmc.HUM_IMPROVEMENT_IDEAS) as f:
            written = [json.loads(line) for line in f]
        self.assertEqual(len(written), 2)
        other = next(r for r in written if r["id"] == "hum-i-2")
        self.assertNotIn("recurrence_count", other)

    def test_bump_recurrence_returns_none_and_does_not_write_when_id_missing(self):
        ideas_rows = [{"id": "hum-i-1", "lane": "ideas", "status": "proposed"}]
        result = hmc.bump_recurrence("hum-i-does-not-exist", ideas_rows)
        self.assertIsNone(result)
        with open(hmc.HUM_IMPROVEMENT_IDEAS) as f:
            self.assertEqual(f.read(), "")

    def test_run_dedup_check_blocks_and_bumps_when_open_idea_exists(self):
        self._write_jsonl(self.learnings_path, [
            {"id": "qual-ideas-20260707", "subject": "hum ideas decay",
             "answered_at": "2026-07-08T12:09:47.291Z"},
        ])
        self._write_jsonl(self.ideas_path, [
            {"id": "hum-i-20260711-02", "lane": "ideas", "status": "proposed",
             "evidence": {"qualitative_id": "qual-ideas-20260707"}},
        ])
        result = hmc.run_dedup_check("ideas")
        self.assertTrue(result["blocked"])
        self.assertEqual(result["idea_id"], "hum-i-20260711-02")
        self.assertEqual(result["qualitative_id"], "qual-ideas-20260707")
        self.assertEqual(result["recurrence_count"], 1)
        # A second call bumps again -- e.g. a second redundant morning.
        result2 = hmc.run_dedup_check("ideas")
        self.assertTrue(result2["blocked"])
        self.assertEqual(result2["recurrence_count"], 2)

    def test_run_dedup_check_does_not_block_when_no_answer_recorded(self):
        self._write_jsonl(self.learnings_path, [])
        self._write_jsonl(self.ideas_path, [
            {"id": "hum-i-1", "lane": "ideas", "status": "proposed",
             "evidence": {"qualitative_id": "qual-ideas-20260707"}},
        ])
        result = hmc.run_dedup_check("ideas")
        self.assertFalse(result["blocked"])
        self.assertEqual(result["reason"], "no_qualitative_answer_recorded")

    def test_run_dedup_check_does_not_block_when_prior_idea_already_resolved(self):
        # The whole point: once the blocking idea's status moves off
        # "proposed" (applied here), a fresh decay against the same answer
        # is genuinely new information again and must NOT be suppressed.
        self._write_jsonl(self.learnings_path, [
            {"id": "qual-ideas-20260707", "subject": "hum ideas decay",
             "answered_at": "2026-07-08T12:09:47.291Z"},
        ])
        self._write_jsonl(self.ideas_path, [
            {"id": "hum-i-20260711-02", "lane": "ideas", "status": "applied",
             "evidence": {"qualitative_id": "qual-ideas-20260707"}},
        ])
        result = hmc.run_dedup_check("ideas")
        self.assertFalse(result["blocked"])
        self.assertEqual(result["qualitative_id"], "qual-ideas-20260707")

    def test_run_dedup_check_does_not_block_unrelated_lane(self):
        self._write_jsonl(self.learnings_path, [
            {"id": "qual-music-20260520", "subject": "hum music lane decay",
             "answered_at": "2026-05-20T00:00:00Z"},
        ])
        self._write_jsonl(self.ideas_path, [
            {"id": "hum-i-1", "lane": "ideas", "status": "proposed",
             "evidence": {"qualitative_id": "qual-ideas-20260707"}},
        ])
        result = hmc.run_dedup_check("music")
        self.assertFalse(result["blocked"])

    def test_run_dedup_check_fails_open_on_internal_error(self):
        # Point HUM_LEARNINGS at a directory (not a file) so load_jsonl's
        # open() raises something other than FileNotFoundError -- exercises
        # the try/except fail-open path rather than load_jsonl's own
        # FileNotFoundError handling.
        hmc.HUM_LEARNINGS = tempfile.mkdtemp()
        result = hmc.run_dedup_check("ideas")
        self.assertFalse(result["blocked"])
        self.assertTrue(result["reason"].startswith("error:"))


class DedupCheckCliTest(unittest.TestCase):
    """Smoke test for the --dedup-check / --lane argparse wiring itself,
    isolated from any real data by redirecting both source files to empty
    scratch files -- confirms main() takes the early-return branch and
    prints a single JSON line without touching the normal daily-collection
    path (which would require hum-runs.jsonl / suggestion-history.jsonl
    etc. and isn't what this flag is for)."""

    def setUp(self):
        fd1, self.learnings_path = tempfile.mkstemp(suffix=".jsonl")
        os.close(fd1)
        fd2, self.ideas_path = tempfile.mkstemp(suffix=".jsonl")
        os.close(fd2)
        self._orig_learnings = hmc.HUM_LEARNINGS
        self._orig_ideas = hmc.HUM_IMPROVEMENT_IDEAS
        hmc.HUM_LEARNINGS = self.learnings_path
        hmc.HUM_IMPROVEMENT_IDEAS = self.ideas_path
        self.addCleanup(setattr, hmc, "HUM_LEARNINGS", self._orig_learnings)
        self.addCleanup(setattr, hmc, "HUM_IMPROVEMENT_IDEAS", self._orig_ideas)
        self.addCleanup(os.remove, self.learnings_path)
        self.addCleanup(os.remove, self.ideas_path)

    def test_main_dedup_check_missing_lane_reports_error_without_crashing(self):
        import sys
        from unittest import mock
        with mock.patch.object(sys, "argv", ["hum-metrics-collect", "--dedup-check"]):
            with mock.patch("builtins.print") as mock_print:
                hmc.main()
        printed = json.loads(mock_print.call_args[0][0])
        self.assertFalse(printed["blocked"])
        self.assertEqual(printed["reason"], "missing --lane")

    def test_main_dedup_check_with_lane_returns_unblocked_on_empty_state(self):
        import sys
        from unittest import mock
        with mock.patch.object(sys, "argv",
                                ["hum-metrics-collect", "--dedup-check", "--lane", "ideas"]):
            with mock.patch("builtins.print") as mock_print:
                hmc.main()
        printed = json.loads(mock_print.call_args[0][0])
        self.assertFalse(printed["blocked"])


if __name__ == "__main__":
    unittest.main()
