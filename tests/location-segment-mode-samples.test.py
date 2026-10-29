#!/usr/bin/env python3
"""location-segment-mode-samples.test.py — a single gap has a speed, not a mode.

Two fixes, 1.47 km apart, 5.8 minutes apart (15 km/h, straightness 1.0) were
classified "cycled" at 0.55 — a subway ride between the two fits that exactly
as well. The narrator wrote "biked home". A bike ride in the
12–25 km/h band must have been SEEN: several fixes, no long silence.

Run: python3 tests/location-segment-mode-samples.test.py
"""
import os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
mod = type(sys)("locseg")
mod.__dict__["__file__"] = os.path.join(REPO, "bin", "location-segment")
exec(compile(open(os.path.join(REPO, "bin", "location-segment")).read(), "location-segment", "exec"),
     mod.__dict__)

HERE_PT = (12.3456, -65.4321)  # a fake point


def feat(**over):
    base = dict(p50_speed_kmh=15.14, p95_speed_kmh=15.14, straightness=1.0, bearing_changes_per_km=0,
                total_dist_km=1.472, geodesic_dist_km=1.472, max_gap_min=5.83, dominant_activity=None,
                n_samples=2)
    base.update(over)
    return base


class SingleGapIsNotARide(unittest.TestCase):
    def test_two_fixes_at_bike_speed_are_unknown(self):
        mode, conf = mod.classify_mode(feat(), *HERE_PT)
        self.assertEqual(mode, "unknown")

    def test_many_fixes_with_a_long_silence_are_still_unknown(self):
        mode, _ = mod.classify_mode(feat(n_samples=8, max_gap_min=4.0), *HERE_PT)
        self.assertEqual(mode, "unknown")

    def test_a_watched_ride_is_still_a_ride(self):
        mode, conf = mod.classify_mode(feat(n_samples=12, max_gap_min=0.5, straightness=0.85), *HERE_PT)
        self.assertEqual(mode, "cycled")

    def test_coremotion_cycling_needs_no_shape(self):
        mode, conf = mod.classify_mode(feat(dominant_activity="cycling"), *HERE_PT)
        self.assertEqual(mode, "cycled")
        self.assertGreaterEqual(conf, 0.85)

    def test_features_carry_the_sample_count(self):
        s = [mod.Sample(ts_ms=i * 60_000, lat=HERE_PT[0] + i * 0.002, lon=HERE_PT[1], accuracy_m=10.0, activity=None)
             for i in range(5)]
        f = mod.compute_segment_features(s)
        self.assertEqual(f["n_samples"], 5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
