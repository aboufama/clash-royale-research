"""GAE over semi-MDP transitions (train/crl/rollout.py). Run: python -m unittest discover -s train/tests"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from crl.rollout import Rollout  # noqa: E402


def add(buf, value):
    z = np.zeros((1, buf.obs.shape[1]), np.float16)
    return int(buf.add(z, np.ones((1, 5), np.uint8), np.ones((1, buf.tile_mask.shape[1]), np.uint8),
                       np.array([0]), np.array([0]), np.array([0.0]), np.array([value]))[0])


class RolloutTest(unittest.TestCase):
    def test_gae_matches_hand_computation(self):
        g, lam = 0.99, 0.9
        buf = Rollout(16, 4, 3)
        a, b, c = add(buf, 0.5), add(buf, 0.2), add(buf, -0.1)
        buf.finish(a, 0.0, 2, False, 0.2, b)  # 2 ticks to b
        buf.finish(b, 0.3, 1, False, -0.1, c)
        buf.finish(c, 1.0, 3, True, 0.0)  # terminal win
        idx, adv, ret = buf.advantages(g, lam)
        dc = 1.0 - (-0.1)
        db = 0.3 + g * -0.1 - 0.2
        da = 0.0 + g ** 2 * 0.2 - 0.5
        ac = dc
        ab = db + g * lam * ac
        aa = da + g ** 2 * lam * ab
        np.testing.assert_allclose(adv, [aa, ab, ac], rtol=1e-5)
        np.testing.assert_allclose(ret, [aa + 0.5, ab + 0.2, ac - 0.1], rtol=1e-5)

    def test_truncated_stream_bootstraps_and_compact_keeps_pending(self):
        buf = Rollout(16, 4, 3)
        a, b = add(buf, 0.4), add(buf, 0.1)
        buf.finish(a, 0.2, 5, False, 0.1, b)  # b is still pending
        idx, adv, _ = buf.advantages(0.9, 0.95)
        self.assertEqual(list(idx), [a])
        np.testing.assert_allclose(adv, [0.2 + 0.9 ** 5 * 0.1 - 0.4], rtol=1e-5)
        last = {("s", 0): b}
        buf.compact(last)
        self.assertEqual(buf.n, 1)
        self.assertEqual(last[("s", 0)], 0)
        self.assertAlmostEqual(float(buf.value[0]), 0.1, places=6)


if __name__ == "__main__":
    unittest.main()
