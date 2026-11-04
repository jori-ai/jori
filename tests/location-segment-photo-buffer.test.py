#!/usr/bin/env python3
"""location-segment-photo-buffer.test.py — a photo taken seconds before a stop
'officially' starts is still that stop's photo.

2026-09-13: the Bellevue Hospital stop's photo, taken 37s before
stop.start_ts_ms, missed attach_photos_to_stop's strict [start, end] bound and
fell into the day's unmatched-photo bucket. resolve-day.js's own
attachPhotosToStop had already grown a +/-5min buffer for its orphan-visit
path; this backports the same buffer to the primary matcher every regular
GPS-clustered stop uses.

Run: python3 tests/location-segment-photo-buffer.test.py
"""
import os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
mod = type(sys)("locseg")
mod.__dict__["__file__"] = os.path.join(REPO, "bin", "location-segment")
exec(compile(open(os.path.join(REPO, "bin", "location-segment")).read(), "location-segment", "exec"),
     mod.__dict__)

STOP_START_MS = 1_757_000_000_000
STOP_END_MS = STOP_START_MS + 45 * 60_000


def make_stop(**over):
    place = mod.PlaceCandidate(name="Example Hospital", address=None, source="google_places", confidence=0.9)
    base = dict(id="s1", start_ts_ms=STOP_START_MS, end_ts_ms=STOP_END_MS,
                centroid_lat=12.3456, centroid_lon=-65.4321, cluster_radius_m=20.0,
                sample_count=6, primary=place)
    base.update(over)
    return mod.Stop(**base)


def photo_at(ts_ms, lat=12.3456, lon=-65.4321):
    return {"ts_ms": ts_ms, "lat": lat, "lon": lon}


class PhotoJustOutsideTheStrictWindow(unittest.TestCase):
    def test_photo_37s_before_start_still_attaches(self):
        stop = make_stop()
        mod.attach_photos_to_stop(stop, [photo_at(STOP_START_MS - 37_000)])
        self.assertEqual(len(stop.photos), 1)

    def test_photo_37s_after_end_still_attaches(self):
        stop = make_stop()
        mod.attach_photos_to_stop(stop, [photo_at(STOP_END_MS + 37_000)])
        self.assertEqual(len(stop.photos), 1)

    def test_photo_well_inside_window_still_attaches(self):
        stop = make_stop()
        mod.attach_photos_to_stop(stop, [photo_at(STOP_START_MS + 5 * 60_000)])
        self.assertEqual(len(stop.photos), 1)

    def test_photo_beyond_the_buffer_does_not_attach(self):
        stop = make_stop()
        mod.attach_photos_to_stop(stop, [photo_at(STOP_START_MS - 10 * 60_000)])
        self.assertEqual(len(stop.photos), 0)

    def test_nearby_time_but_far_away_place_does_not_attach(self):
        stop = make_stop()
        mod.attach_photos_to_stop(stop, [photo_at(STOP_START_MS - 30_000, lat=12.3456 + 0.0204, lon=-65.4321)])
        self.assertEqual(len(stop.photos), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
