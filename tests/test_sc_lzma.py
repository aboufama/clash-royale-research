import lzma
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import sc_lzma


def encoded(payload):
    standard = lzma.compress(
        payload,
        format=lzma.FORMAT_ALONE,
        filters=[{"id": lzma.FILTER_LZMA1, "dict_size": 256 * 1024}],
    )
    return standard[:5] + len(payload).to_bytes(4, "little") + standard[13:]


class SupercellLzmaTests(unittest.TestCase):
    def test_exact_roundtrip(self):
        for payload in (b"", b"[test]\nspeed = 60\n", bytes(range(256)) * 400):
            with self.subTest(size=len(payload)):
                self.assertEqual(sc_lzma.decode(encoded(payload)), payload)

    def test_wrong_declared_length_is_rejected(self):
        data = encoded(b"example payload")
        for size in (3, 100):
            with self.subTest(size=size), self.assertRaises(
                (ValueError, lzma.LZMAError)
            ):
                sc_lzma.decode(data[:5] + size.to_bytes(4, "little") + data[9:])

    def test_limit_truncated_wrong_header_and_trailing_bytes(self):
        data = encoded(b"example payload")
        for candidate in (b"", b"bad header", data[:-5], data + b"junk"):
            with self.subTest(candidate=candidate), self.assertRaises(
                (ValueError, lzma.LZMAError)
            ):
                sc_lzma.decode(candidate)
        with self.assertRaisesRegex(ValueError, "limit"):
            sc_lzma.decode(data, max_output=4)


if __name__ == "__main__":
    unittest.main()
