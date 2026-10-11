import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "integrity",
    Path(__file__).resolve().parents[1] / "scripts/verify_runtime_integrity.py",
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class IntegrityTests(unittest.TestCase):
    def test_known_short_sequence(self):
        # Running sums for [1,2,3]: s1=6; s2=1+3+6=10.
        self.assertEqual(module.fletcher64([1, 2, 3], 0, 0, 3), (10 << 32) | 6)

    def test_seeded_modular_reduction(self):
        self.assertEqual(module.fletcher64([0xFFFFFFFF, 1], 2, 3, 1), (8 << 32) | 3)

    def test_empty_image_cannot_pass(self):
        with self.assertRaises(ValueError):
            module.verify(b"")
        with self.assertRaises(ValueError):
            module.verify(bytes(0x6C4D10))

    def test_invalid_chunk_is_rejected(self):
        for chunk in (0, -1, (1 << 20) + 1):
            with self.subTest(chunk=chunk), self.assertRaises(ValueError):
                module.fletcher64([1], 0, 0, chunk)


if __name__ == "__main__":
    unittest.main()
