#!/usr/bin/env python3
"""hum-metrics-collect-surface-rate-quality-gate.test.py — unit tests for the
quality cross-check added to the surface_rate_chatter branch in
detect_decay() (bin/hum-metrics-collect, added 2026-09-01).

Background: surface_rate_chatter fired 4 straight days (8/6-8/9, rolling_3d
climbing 0.30 -> 0.38 -> 0.47 -> 0.45) while signal_per_surfaced simultaneously
rose to 2-6x its ~0.35-0.44 30d baseline (1.167, 2.1, 1.25). Real "chatter"
(too much surfaced, quality dropping as volume rises) predicts the opposite
direction -- quality falling alongside the volume spike, not rising. The
detector didn't cross-check this, even though hum-intent.md's 2026-08-03 note
already said surface_rate reads low by construction post-redesign and should
be re-baselined before being trusted alone.

The fix reuses the same today_3/prior_7 rolling windows already computed
earlier in detect_decay() for global_decay_drop (mirroring that precedent
rather than inventing a new mechanism) and only fires surface_rate_chatter
when signal_per_surfaced is flat-or-declining (delta <= 0) alongside the
volume spike. Missing quality data on either side fails open -- fires as
before -- so an absent cross-check can never silently suppress a real alert.

hum-metrics-collect is Python, not Node, so this suite runs under
`python3 -m unittest` rather than `node --test`.

Run: python3 -m unittest tests/hum-metrics-collect-surface-rate-quality-gate.test.py -v
"""

import importlib.machinery
import importlib.util
import os
import unittest
from datetime import date, timedelta

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPT_PATH = os.path.join(REPO_ROOT, "bin", "hum-metrics-collect")

# hum-metrics-collect has no .py suffix (it's a `#!/usr/bin/env python3` CLI
# entrypoint under bin/), so spec_from_file_location can't infer a
# loader from the extension -- give it one explicitly.
_loader = importlib.machinery.SourceFileLoader("hum_metrics_collect", SCRIPT_PATH)
_spec = importlib.util.spec_from_loader("hum_metrics_collect", _loader)
hmc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hmc)  # module-level code only defines funcs/consts; __name__ != "__main__"


BASE = date(2026, 8, 9)  # mirrors the 8/9 day from the hypothesis


def _row(iso_date, signal_per_surfaced, surface_rate=0.1, ticks=5, include_sps=True):
    """A top-level row shape (not lane_yield) -- compute_rolling() reads
    signal_per_surfaced/surface_rate off the row directly. lane_yield is left
    empty so the per-lane silent/negative walks never iterate (both loop over
    today_row["lane_yield"].items(), which is a no-op on {})."""
    row = {"date": iso_date, "ticks": ticks, "surface_rate": surface_rate,
           "lane_yield": {}}
    if include_sps:
        row["signal_per_surfaced"] = signal_per_surfaced
    return row


def _baseline_daily(baseline_sps, include_sps=True):
    """7 rows at today-9..today-3 (the prior_7 window) all at baseline_sps,
    plus 2 more at today-2..today-1 filled in by the caller as part of the
    3-day window (today_3 = today-2, today-1, today)."""
    return [_row((BASE - timedelta(days=d)).isoformat(), baseline_sps,
                  surface_rate=0.1, ticks=5, include_sps=include_sps)
            for d in range(9, 2, -1)]  # today-9 .. today-3, ascending


class SurfaceRateChatterQualityGateTest(unittest.TestCase):
    def test_fires_when_quality_flat_or_declining_alongside_volume_spike(self):
        # Baseline 0.4, near-window (today-2, today-1, today) drops to 0.3 --
        # this is what real chatter looks like: quality degrading as volume
        # rises. delta = 0.3 - 0.4 = -0.1 <= 0 -> should still fire.
        daily = _baseline_daily(0.4)
        daily += [
            _row((BASE - timedelta(days=2)).isoformat(), 0.3, surface_rate=0.67, ticks=15),
            _row((BASE - timedelta(days=1)).isoformat(), 0.3, surface_rate=0.65, ticks=15),
        ]
        today_row = _row(BASE.isoformat(), 0.3, surface_rate=0.65, ticks=15)
        events = hmc.detect_decay({"daily": daily}, today_row)
        chatter = [e for e in events if e["type"] == "surface_rate_chatter"]
        self.assertEqual(len(chatter), 1)
        self.assertAlmostEqual(chatter[0]["signal_per_surfaced_3d"], 0.3, places=3)
        self.assertAlmostEqual(chatter[0]["signal_per_surfaced_baseline_7d"], 0.4, places=3)

    def test_skips_when_quality_rising_alongside_volume_spike(self):
        # This is the actual 8/6-8/9 shape from the hypothesis: rolling_3d
        # surface_rate well above SURFACE_RATE_HIGH (mean ~0.66) but
        # signal_per_surfaced climbing to ~1.5 against a 0.4 baseline --
        # quality is IMPROVING, not degrading, so this isn't the chatter
        # pattern the threshold exists to catch.
        daily = _baseline_daily(0.4)
        daily += [
            _row((BASE - timedelta(days=2)).isoformat(), 1.167, surface_rate=0.67, ticks=15),
            _row((BASE - timedelta(days=1)).isoformat(), 2.1, surface_rate=0.65, ticks=15),
        ]
        today_row = _row(BASE.isoformat(), 1.25, surface_rate=0.65, ticks=15)
        events = hmc.detect_decay({"daily": daily}, today_row)
        self.assertFalse(any(e["type"] == "surface_rate_chatter" for e in events),
                          "quality-improving volume spike must not fire surface_rate_chatter")

    def test_fires_on_equal_quality_delta_boundary(self):
        # delta == 0 (flat, not declining) is still "not rising" -> fires.
        # Gate is delta <= 0, not delta < 0.
        daily = _baseline_daily(0.4)
        daily += [
            _row((BASE - timedelta(days=2)).isoformat(), 0.4, surface_rate=0.67, ticks=15),
            _row((BASE - timedelta(days=1)).isoformat(), 0.4, surface_rate=0.65, ticks=15),
        ]
        today_row = _row(BASE.isoformat(), 0.4, surface_rate=0.65, ticks=15)
        events = hmc.detect_decay({"daily": daily}, today_row)
        self.assertTrue(any(e["type"] == "surface_rate_chatter" for e in events))

    def test_fails_open_when_baseline_quality_data_missing(self):
        # prior_7 rows carry no signal_per_surfaced at all -> compute_rolling
        # degrades that field to None for the baseline window. The gate must
        # not be able to suppress a real alert just because it lacks the data
        # to cross-check it -- fires as if the gate weren't there.
        daily = _baseline_daily(None, include_sps=False)
        daily += [
            _row((BASE - timedelta(days=2)).isoformat(), 1.167, surface_rate=0.67, ticks=15),
            _row((BASE - timedelta(days=1)).isoformat(), 2.1, surface_rate=0.65, ticks=15),
        ]
        today_row = _row(BASE.isoformat(), 1.25, surface_rate=0.65, ticks=15)
        events = hmc.detect_decay({"daily": daily}, today_row)
        chatter = [e for e in events if e["type"] == "surface_rate_chatter"]
        self.assertEqual(len(chatter), 1)
        self.assertIsNone(chatter[0]["signal_per_surfaced_baseline_7d"])

    def test_surface_rate_collapse_branch_is_unaffected(self):
        # The low-surface-rate branch is a separate elif arm untouched by
        # this change -- confirm it still fires on its own terms regardless
        # of quality direction.
        daily = _baseline_daily(0.4)
        daily += [
            _row((BASE - timedelta(days=2)).isoformat(), 2.0, surface_rate=0.02, ticks=15),
            _row((BASE - timedelta(days=1)).isoformat(), 2.0, surface_rate=0.02, ticks=15),
        ]
        today_row = _row(BASE.isoformat(), 2.0, surface_rate=0.02, ticks=15)
        events = hmc.detect_decay({"daily": daily}, today_row)
        self.assertTrue(any(e["type"] == "surface_rate_collapse" for e in events))
        self.assertFalse(any(e["type"] == "surface_rate_chatter" for e in events))


if __name__ == "__main__":
    unittest.main()
