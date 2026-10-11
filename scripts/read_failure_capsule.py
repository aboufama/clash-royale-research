"""Read hash-verified private guest-memory captures without executing code."""

from collections import OrderedDict
import hashlib
import json
from pathlib import Path
import zlib


class CapsuleMemory:
    def __init__(self, directory, *, cached_regions=2):
        if type(cached_regions) is not int or cached_regions < 1:
            raise ValueError("At least one verified region must be cached")
        self.directory = Path(directory)
        self.report = json.loads((self.directory / "report-private.json").read_text())
        self.regions = sorted(
            self.report["regions"], key=lambda row: int(row["start"], 0)
        )
        self.cache = OrderedDict()
        self.cached_regions = cached_regions
        previous = -1
        for region in self.regions:
            low, high = int(region["start"], 0), int(region["end_inclusive"], 0)
            if low <= previous or high < low or region["bytes"] != high + 1 - low:
                raise ValueError("Invalid or overlapping capture region")
            previous = high

    def _load(self, index):
        if index in self.cache:
            self.cache.move_to_end(index)
            return self.cache[index]
        region = self.regions[index]
        name = region.get("file")
        if not name or Path(name).name != name or region.get("capture_error"):
            raise ValueError("Region lacks a complete private memory capture")
        decoder = zlib.decompressobj()
        raw = decoder.decompress(
            (self.directory / name).read_bytes(), region["bytes"] + 1
        )
        if not decoder.eof or decoder.unused_data or len(raw) != region["bytes"]:
            raise ValueError("Incomplete or incorrectly sized compressed region")
        if hashlib.sha256(raw).hexdigest() != region["sha256"]:
            raise ValueError("Captured region SHA-256 mismatch")
        self.cache[index] = raw
        while len(self.cache) > self.cached_regions:
            self.cache.popitem(last=False)
        return raw

    def read(self, address, length):
        if (
            type(address) is not int
            or type(length) is not int
            or address < 0
            or length < 0
        ):
            raise ValueError("Address and length must be nonnegative integers")
        result = bytearray()
        while len(result) < length:
            cursor = address + len(result)
            match = next(
                (
                    (index, row)
                    for index, row in enumerate(self.regions)
                    if int(row["start"], 0) <= cursor <= int(row["end_inclusive"], 0)
                ),
                None,
            )
            if match is None:
                raise ValueError(f"No captured mapped bytes at {cursor:#x}")
            index, row = match
            start = cursor - int(row["start"], 0)
            count = min(length - len(result), row["bytes"] - start)
            result.extend(self._load(index)[start : start + count])
        return bytes(result)

    def pointer(self, address):
        return int.from_bytes(self.read(address, 8), "little")

    def word(self, address):
        return int.from_bytes(self.read(address, 4), "little")

    def cstring(self, address, *, limit=4096):
        raw = bytearray()
        for offset in range(limit):
            value = self.read(address + offset, 1)
            if value == b"\0":
                return bytes(raw)
            raw.extend(value)
        raise ValueError("No terminator inside bounded captured string")
