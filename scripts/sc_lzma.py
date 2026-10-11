"""Decode the observed nine-byte-header Supercell LZMA format without guessing.

The signed 160402020 asset pack uses properties 5d00000400 and a four-byte
little-endian output length. LZMA-alone instead expects an eight-byte length.
Restoring the upper four zero bytes leaves all compressed payload bytes intact.
This recovers asset bytes, not game algorithms or a runtime implementation.
"""

import argparse
import lzma
from pathlib import Path

PROPERTIES = bytes.fromhex("5d00000400")
DEFAULT_LIMIT = 64 * 1024 * 1024


def decode(data: bytes, max_output: int = DEFAULT_LIMIT) -> bytes:
    if len(data) < 10 or data[:5] != PROPERTIES:
        raise ValueError("Unsupported or truncated Supercell LZMA header")
    expected = int.from_bytes(data[5:9], "little")
    if expected > max_output:
        raise ValueError("Declared output exceeds configured limit")
    decoder = lzma.LZMADecompressor(format=lzma.FORMAT_ALONE, memlimit=32 * 1024 * 1024)
    result = decoder.decompress(data[:9] + bytes(4) + data[9:], max_length=expected + 1)
    if len(result) != expected:
        raise ValueError("Decoded output length does not match the header")
    if not decoder.eof:
        # Some LZMA streams end on the known size without an EOS marker;
        # LZMA-alone recognizes that size in either valid encoding.
        raise ValueError("Compressed stream did not reach its declared end")
    if decoder.unused_data:
        raise ValueError("Trailing compressed data is unsupported")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--max-output", type=int, default=DEFAULT_LIMIT)
    args = parser.parse_args()
    result = decode(args.input.read_bytes(), args.max_output)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(result)
    print(f"Decoded {len(result)} bytes with exact declared-length validation.")


if __name__ == "__main__":
    main()
