import hashlib
import json
from pathlib import Path
import tempfile
import sys
import unittest
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from read_failure_capsule import CapsuleMemory


class CapsuleReadTests(unittest.TestCase):
    def fixture(self, directory):
        rows = []
        for index, (low, raw) in enumerate(
            [(0x1000, b"abcd"), (0x1004, b"ef\0g"), (0x2000, b"test")]
        ):
            name = f"region-{index}.zlib"
            (Path(directory) / name).write_bytes(zlib.compress(raw))
            rows.append(
                {
                    "start": hex(low),
                    "end_inclusive": hex(low + len(raw) - 1),
                    "bytes": len(raw),
                    "file": name,
                    "sha256": hashlib.sha256(raw).hexdigest(),
                }
            )
        (Path(directory) / "report-private.json").write_text(
            json.dumps({"regions": rows})
        )
        return CapsuleMemory(directory, cached_regions=1)

    def test_contiguous_regions_exact_and_gap_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            memory = self.fixture(directory)
            self.assertEqual(memory.read(0x1002, 5), b"cdef\0")
            self.assertEqual(memory.cstring(0x1001), b"bcdef")
            self.assertEqual(memory.word(0x1000), int.from_bytes(b"abcd", "little"))
            with self.assertRaisesRegex(ValueError, "No captured mapped"):
                memory.read(0x1006, 5)
            self.assertEqual(len(memory.cache), 1)

    def test_mutated_memory_does_not_read_as_valid(self):
        with tempfile.TemporaryDirectory() as directory:
            memory = self.fixture(directory)
            (Path(directory) / "region-0.zlib").write_bytes(zlib.compress(b"xbcd"))
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                memory.read(0x1000, 1)

    def test_truncated_capture_does_not_supply_zero_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            memory = self.fixture(directory)
            path = Path(directory) / "region-0.zlib"
            path.write_bytes(path.read_bytes()[:-3])
            with self.assertRaisesRegex(ValueError, "Incomplete"):
                memory.read(0x1000, 1)


if __name__ == "__main__":
    unittest.main()
