import struct
import unittest
from decimal import Decimal

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from native_decimal import decimal_to_binary64


class DecimalConversionTests(unittest.TestCase):
    def test_known_binary64_representations(self):
        for text, bits in [
            (b"0", 0),
            (b"-0.0", 1 << 63),
            (b"1.0", 0x3FF0000000000000),
            (b"0.1", 0x3FB999999999999A),
            (b"1.2", 0x3FF3333333333333),
            (b"-5.5", 0xC016000000000000),
        ]:
            with self.subTest(text=text):
                self.assertEqual(decimal_to_binary64(text), bits)

    def test_halfway_rounding_selects_even_significand(self):
        self.assertEqual(
            decimal_to_binary64(
                b"1.00000000000000011102230246251565404236316680908203125"
            ),
            0x3FF0000000000000,
        )
        self.assertEqual(
            decimal_to_binary64(
                b"1.00000000000000033306690738754696212708950042724609375"
            ),
            0x3FF0000000000002,
        )

    def test_independent_host_decimal_conversion_corpus(self):
        for coefficient in (1, 3, 17, 12345, 9007199254740993, 9999999999999999):
            for exponent in (-100, -20, -3, 0, 7, 100):
                literal = f"{coefficient}e{exponent}"
                expected = struct.unpack(
                    "<Q", struct.pack("<d", float(Decimal(literal)))
                )[0]
                self.assertEqual(decimal_to_binary64(literal.encode()), expected)

    def test_unsupported_inputs_fail_closed(self):
        for literal in (
            b"",
            b"nan",
            b"inf",
            b"0x1p0",
            b" 1.2",
            b"1.2junk",
            b"1e-320",
            b"1e400",
            b"1e1000",
            b"1" * 129,
        ):
            with self.subTest(literal=literal), self.assertRaises(ValueError):
                decimal_to_binary64(literal)


if __name__ == "__main__":
    unittest.main()
