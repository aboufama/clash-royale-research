"""Boundary checks for the native loader's explicit runtime models."""

from collections import Counter
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import initialize_original_tags as tags
from test_probe_original_pathfinding import fake_probe


def native_model(name, arguments):
    engine = object.__new__(tags.ParserProbe)
    engine.__dict__.update(fake_probe().__dict__)
    engine.extra_calls = Counter()
    engine.writable_regions = [(engine.BASE + 0x3000, 0x1000)]
    engine.atexit = []
    engine.names[engine.STUB] = name
    engine.u.registers.update(enumerate(arguments))
    return engine


class ParserBoundaryTests(unittest.TestCase):
    def test_modified_tags_rejected_before_native_execution(self):
        with self.assertRaisesRegex(ValueError, "exact pinned"):
            tags.initialize_tags(None, b"synthetic modified CSV")

    def test_unknown_import_stops(self):
        engine = native_model("unmodeled", [])
        engine._import_hook(engine.u, engine.STUB, 4, None)
        self.assertTrue(engine.u.stopped)
        self.assertIn("Unmodeled import", engine.stop_reason)

    def test_static_memory_write_cannot_modify_code(self):
        engine = native_model("memset", [0x10000000, 0, 4, 4])
        engine._import_hook(engine.u, engine.STUB, 4, None)
        self.assertTrue(engine.u.stopped)
        self.assertEqual(engine.u.writes, [])

    def test_checked_static_write_honors_bound(self):
        engine = native_model("__memset_chk", [0x10003000, 0, 8, 4])
        engine._import_hook(engine.u, engine.STUB, 4, None)
        self.assertTrue(engine.u.stopped)
        self.assertEqual(engine.u.writes, [])

    def test_numeric_overflow_and_non_ascii_stop(self):
        for value in (b"2147483648", b"-2147483649", b"\xff12"):
            with self.subTest(value=value):
                engine = native_model("atoi", [0x60000000])
                engine.cstring = lambda _, value=value: value
                engine._import_hook(engine.u, engine.STUB, 4, None)
                self.assertTrue(engine.u.stopped)

    def test_case_comparison_does_not_guess_non_ascii_locale(self):
        engine = native_model("strncasecmp", [0x60000000, 0x60000010, 1])
        engine.u.mem_read = lambda address, length: b"\xff"
        engine._import_hook(engine.u, engine.STUB, 4, None)
        self.assertTrue(engine.u.stopped)
        self.assertIn("Non-ASCII", engine.stop_reason)

    def test_prime_model_rejects_unknown_domain(self):
        for value in (0, 1, 100001):
            with self.subTest(value=value):
                engine = native_model("_ZNSt6__ndk112__next_primeEm", [value])
                engine._import_hook(engine.u, engine.STUB, 4, None)
                self.assertTrue(engine.u.stopped)


if __name__ == "__main__":
    unittest.main()
