"""Check the original 160-block protection-runtime integrity table.

This verifies a specific recovered code region against expected checksums
embedded in the pinned binary. Fletcher-64 is not cryptographic authentication,
and this does not verify gameplay, main payload recovery, or a full runtime.
"""

import argparse
import hashlib
import json
from pathlib import Path
import struct

BLOCKS = 160
MASK64 = (1 << 64) - 1


def fletcher64(words, seed1, seed2, chunk):
    if not 1 <= chunk <= (1 << 20):
        raise ValueError("Invalid checksum reduction interval")
    s1, s2 = seed1, seed2
    for start in range(0, len(words), chunk):
        for word in words[start : start + chunk]:
            s1 = (s1 + word) & MASK64
            s2 = (s2 + s1) & MASK64
        s1 %= 0xFFFFFFFF
        s2 %= 0xFFFFFFFF
    return (s2 << 32) | s1


def verify(data, base=0x20000000):
    if len(data) < 0x6C4D10:
        raise ValueError("Image is too short for the pinned runtime metadata")
    qword = lambda offset: struct.unpack_from("<Q", data, offset)[0]
    table = struct.unpack_from("<160Q", data, 0x6C47F8)
    length = table[table[0] & 159] ^ qword(0x6C47E8)
    anchor = qword(0x6AEC78)
    start = anchor - (table[table[159] & 159] ^ qword(0x6C47F0)) - base
    seed1, seed2, chunk = (qword(offset) for offset in (0x6C4CF8, 0x6C4D00, 0x6C4D08))
    if length < BLOCKS * 4 or length % 4 or not 0 <= start <= len(data) - length:
        raise ValueError(
            "Decoded checksum region is empty, unaligned, or outside the image"
        )
    words_per_block = length // (BLOCKS * 4)
    results, cursor = [], start
    for index in range(BLOCKS):
        count = words_per_block + (
            length % (BLOCKS * 4) // 4 if index == BLOCKS - 1 else 0
        )
        words = struct.unpack_from(f"<{count}I", data, cursor)
        actual = fletcher64(words, seed1, seed2, chunk)
        expected = qword(0x6C42E8 + index * 8) ^ table[table[159 - index] & 159]
        results.append(
            {
                "index": index,
                "elf_va": hex(cursor),
                "size": count * 4,
                "actual": hex(actual),
                "expected": hex(expected),
                "matches": actual == expected,
            }
        )
        cursor += count * 4
    return {
        "input_sha256": hashlib.sha256(data).hexdigest(),
        "region_start_elf_va": hex(start),
        "region_size": length,
        "region_sha256": hashlib.sha256(data[start : start + length]).hexdigest(),
        "algorithm": "Original seeded Fletcher-64 over little-endian uint32 words",
        "blocks": BLOCKS,
        "matching_blocks": sum(row["matches"] for row in results),
        "complete_region_covered": cursor == start + length,
        "results": results,
        "scope": "Protection-runtime region only; not gameplay equivalence or cryptographic authentication.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("memory", type=Path)
    parser.add_argument("--base", type=lambda value: int(value, 0), default=0x20000000)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = verify(args.memory.read_bytes(), args.base)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {key: value for key, value in report.items() if key != "results"}, indent=2
        )
    )
    return (
        0
        if report["complete_region_covered"] and report["matching_blocks"] == BLOCKS
        else 1
    )


if __name__ == "__main__":
    raise SystemExit(main())
