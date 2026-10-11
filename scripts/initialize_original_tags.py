#!/usr/bin/env python3
"""Execute the original CSV parser and tag registry on pinned game_tags.csv bytes.

Original parser/table/registry code executes unchanged. The owner registry and
one-file bundle remain synthetic fixtures; this is not full game initialization.
The image output preserves native tag globals and inline CSV static strings,
but omits the native heap. Keep ParserProbe alive when its heap objects are needed."""

import argparse
import collections
import json
import math
import re
from pathlib import Path
import struct

from probe_original_pathfinding import (
    PathfindingProbe,
    NativeProbeError,
    LIBRARY_SHA,
    IMAGE_SHA,
    private_output,
    pinned_file,
    sha,
    TEXT_START,
    TEXT_SIZE,
    TEXT_SHA,
)


class ParserProbe(PathfindingProbe):
    def _factory(self):
        pass

    def __init__(self, image, library):
        self.extra_calls = collections.Counter()
        self.atexit = []
        self.writable_regions = []
        super().__init__(image, library, {})
        from elftools.elf.elffile import ELFFile
        import io

        for segment in ELFFile(io.BytesIO(library)).iter_segments():
            if segment["p_type"] == "PT_LOAD" and segment["p_flags"] & 2:
                low = segment["p_vaddr"] & -4096
                high = (segment["p_vaddr"] + segment["p_memsz"] + 4095) & -4096
                self.u.mem_protect(
                    self.BASE + low,
                    high - low,
                    self.unicorn.UC_PROT_READ | self.unicorn.UC_PROT_WRITE,
                )
                self.writable_regions.append(
                    (self.BASE + segment["p_vaddr"], segment["p_memsz"])
                )

    def cstring(self, address, limit=1048576):
        result = bytearray()
        while len(result) < limit:
            chunk = bytes(self.u.mem_read(address + len(result), 1))
            if chunk == b"\0":
                return bytes(result)
            result += chunk
        raise NativeProbeError("Unterminated native string")

    def string(self, address):
        length = self.word(address + 4)
        if not 0 <= length < 1048576:
            raise NativeProbeError("Invalid original String length")
        data = self.pointer(address + 8) if length > 7 else address + 8
        return bytes(self.u.mem_read(data, length))

    def _import_hook(self, uc, pc, size, user_data):
        name = self.names.get(pc)
        r = self.reg
        x, y, z, bound = [uc.reg_read(r.UC_ARM64_REG_X0 + i) for i in range(4)]
        if name in (
            "memcpy",
            "memmove",
            "memset",
            "__memcpy_chk",
            "__memmove_chk",
            "__memset_chk",
        ) and any(
            base <= x and x + z <= base + length
            for base, length in self.writable_regions
        ):
            self.extra_calls[name] += 1
            try:
                if z > 1048576 or name.endswith("_chk") and z > bound:
                    raise NativeProbeError("Static-data memory import exceeds bound")
                data = (
                    bytes([y & 255]) * z
                    if "memset" in name
                    else bytes(uc.mem_read(y, z))
                )
                if data:
                    uc.mem_write(x, data)
                uc.reg_write(r.UC_ARM64_REG_X0, x)
                uc.reg_write(r.UC_ARM64_REG_PC, uc.reg_read(r.UC_ARM64_REG_LR))
            except Exception as error:
                self.stop_reason = str(error)
                uc.emu_stop()
            return
        if name not in (
            "strlen",
            "memcmp",
            "strncasecmp",
            "strcasecmp",
            "atoi",
            "__cxa_atexit",
            "_ZNSt6__ndk112__next_primeEm",
        ):
            return super()._import_hook(uc, pc, size, user_data)
        self.extra_calls[name] += 1
        try:
            if name == "strlen":
                result = len(self.cstring(x))
            elif name == "atoi":
                value = self.cstring(x)
                if any(byte >= 128 for byte in value):
                    raise NativeProbeError(
                        "Non-ASCII atoi input requires original locale implementation"
                    )
                match = re.match(rb"[\t\n\v\f\r ]*([+-]?[0-9]+)", value)
                result = int(match.group(1)) if match else 0
                if not -(1 << 31) <= result < (1 << 31):
                    raise NativeProbeError(
                        "atoi overflow requires original Bionic implementation"
                    )
            elif name == "memcmp":
                if z > 1048576:
                    raise NativeProbeError("Unbounded compare")
                left, right = bytes(uc.mem_read(x, z)), bytes(uc.mem_read(y, z))
                result = next((a - b for a, b in zip(left, right) if a != b), 0)
            elif name in ("strncasecmp", "strcasecmp"):
                if name == "strcasecmp":
                    z = 1048576
                if z > 1048576:
                    raise NativeProbeError("Unbounded case compare")
                result = 0
                for index in range(z):
                    left = uc.mem_read(x + index, 1)[0]
                    right = uc.mem_read(y + index, 1)[0]
                    if left >= 128 or right >= 128:
                        raise NativeProbeError(
                            "Non-ASCII case comparison requires original locale implementation"
                        )
                    left = left + 32 if 65 <= left <= 90 else left
                    right = right + 32 if 65 <= right <= 90 else right
                    result = left - right
                    if result or left == 0:
                        break
                else:
                    if name == "strcasecmp":
                        raise NativeProbeError("Unterminated case comparison")
            elif name == "__cxa_atexit":
                self.atexit.append((x, y, z))
                result = 0
            else:
                if not 2 <= x <= 100000:
                    raise NativeProbeError("Unsupported prime primitive domain")
                result = x
                while any(result % d == 0 for d in range(2, math.isqrt(result) + 1)):
                    result += 1
            uc.reg_write(r.UC_ARM64_REG_X0, result & 0xFFFFFFFFFFFFFFFF)
            uc.reg_write(r.UC_ARM64_REG_PC, uc.reg_read(r.UC_ARM64_REG_LR))
        except Exception as error:
            self.stop_reason = str(error)
            uc.emu_stop()

    def invoke(self, address, args):
        r = self.reg
        self.stop_reason = None
        for index in range(29):
            self.u.reg_write(r.UC_ARM64_REG_X0 + index, 0)
        for index, value in enumerate(args):
            self.u.reg_write(r.UC_ARM64_REG_X0 + index, value & 0xFFFFFFFFFFFFFFFF)
        self.u.reg_write(r.UC_ARM64_REG_SP, self.STACK + 0x200000)
        self.u.reg_write(r.UC_ARM64_REG_LR, self.STOP)
        try:
            self.u.emu_start(
                self.BASE + address, self.STOP, timeout=15_000_000, count=50_000_000
            )
        except self.unicorn.UcError as error:
            raise NativeProbeError(f"Original function faulted: {error}") from error
        if self.stop_reason or self.u.reg_read(r.UC_ARM64_REG_PC) != self.STOP:
            raise NativeProbeError(
                self.stop_reason or "Native timeout/instruction budget; no return"
            )
        return self.u.reg_read(r.UC_ARM64_REG_X0)

    def make_string(self, text):
        data = self.allocate(len(text) + 1)
        self.u.mem_write(data, text + b"\0")
        result = self.allocate(16)
        self.invoke(0x142FDE4, [result, data])
        return result


TAGS_SHA = "88e657c9a71b4039467794f6acfc11ccf775dae78c0aeb1412dcb831a6ba02ff"


def native_csv_table(engine, raw, filename):
    """Return original file and table pointers, preserving the live native heap."""
    engine.invoke(0x1289B94, [])
    name = engine.make_string(filename.encode())
    payload = engine.allocate(len(raw) + 1)
    engine.u.mem_write(payload, raw + b"\0")
    fileobj = engine.allocate(0x68)
    engine.invoke(0x1288F2C, [fileobj, payload, len(raw), name])
    return fileobj, engine.invoke(0x1289A04, [fileobj])


def initialize_tags(engine, raw):
    if sha(raw) != TAGS_SHA:
        raise ValueError("Require exact pinned decoded game_tags.csv")
    fileobj, table = native_csv_table(engine, raw, "game_tags.csv")
    if engine.word(table + 0x44) != 3 or engine.word(table + 0x54) != 62:
        raise NativeProbeError("Pinned native tag-table dimensions differ")
    if [engine.invoke(0x128AA80, [table, c]) for c in range(3)] != [0, 0, 0]:
        raise NativeProbeError("Pinned native tag-column types differ")
    registry = engine.allocate(0x1080)
    # Remaining fixtures are registry owners / file-bundle linkage, not parsed data.
    for offset in (0x1038, 0x1060):
        engine.u.mem_write(registry + offset, struct.pack("<f", 1.0))
    bundle = engine.allocate(0x18)
    entries = engine.allocate(8)
    entry = engine.allocate(0x18)
    engine.write64(bundle + 8, entries)
    engine.write32(bundle + 0x14, 1)
    engine.write64(entries, entry)
    engine.write64(entry + 0x10, fileobj)
    engine.invoke(0xE16234, [registry, bundle])
    count = engine.word(registry + 0x1074)
    if count != 62:
        raise NativeProbeError("Original registry tag count differs")
    # Keep every original output byte. No raw table is reconstructed with Python.
    return {
        "file": fileobj,
        "table": table,
        "registry": registry,
        "bundle": bundle,
        "tags": count,
    }


def intervals(addresses):
    output = []
    for address in addresses:
        if output and output[-1][1] == address:
            output[-1][1] += 1
        else:
            output.append([address, address + 1])
    return [{"elf_va": hex(start), "bytes": end - start} for start, end in output]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--image", type=Path, required=True)
    p.add_argument("--library", type=Path, required=True)
    p.add_argument("--raw-tags", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    out = private_output(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for name in ("runtime-memory.bin", "summary.json"):
        if (out / name).is_symlink():
            raise ValueError("Output symlink rejected")
    image = pinned_file(a.image, IMAGE_SHA, 29_000_000)
    library = pinned_file(a.library, LIBRARY_SHA, 29_000_000)
    raw = pinned_file(a.raw_tags, TAGS_SHA, 100_000)
    engine = ParserProbe(image, library)
    state = initialize_tags(engine, raw)
    after = bytes(engine.u.mem_read(engine.BASE, len(image)))
    changes = [
        index for index, (old, new) in enumerate(zip(image, after)) if old != new
    ]
    static_lengths = [
        engine.word(engine.BASE + address + 4)
        for address in (0x1A90AF0, 0x1A90B00, 0x1A90B10)
    ]
    report = {
        "scope": "Original raw CSV bytes to native table and native tag masks; owner registry and file-bundle linkage remain explicit fixtures.",
        "input_image_sha256": sha(image),
        "library_sha256": sha(library),
        "decoded_tags_sha256": sha(raw),
        "output_image_sha256": sha(after),
        "text_unchanged": sha(after[TEXT_START : TEXT_START + TEXT_SIZE]) == TEXT_SHA,
        "native_columns": 3,
        "native_rows": 62,
        "native_tags": state["tags"],
        "csv_static_initializer": "0x1289b94",
        "native_csv_constructor": "0x1288f2c",
        "native_tag_registry_loader": "0xe16234",
        "native_tag_global_writer": "0xf72e24",
        "changed_image_bytes": len(changes),
        "changed_image_intervals": intervals(changes),
        "csv_static_string_lengths": static_lengths,
        "csv_static_strings_inline": all(0 <= length <= 7 for length in static_lengths),
        "written_globals": [
            {"va": hex(va), "mask": hex(engine.pointer(engine.BASE + va))}
            for va in range(0x1A65F68, 0x1A66110, 8)
        ],
        "imports": dict(engine.import_calls + engine.extra_calls),
        "models": [
            "Bounded bump allocator with no reclamation; standard memory/string routines",
            "ASCII-only strncasecmp/strcasecmp; bounded prime primitive; atexit records only",
            "Registry owner zeroed with standard hash-table load factors 1.0; one-file bundle fixture",
            "No Python CSV parsing in native execution; no game code patches or OS forwarding",
        ],
        "runtime_reuse": "Prefer ParserProbe + initialize_tags in the same emulator to preserve native heap objects. Flat image omits native table/registry heap.",
    }
    if not report["text_unchanged"]:
        raise NativeProbeError("Original text changed")
    if sha(after) != "fc3eab1cf3c15e7a73550445829b4ed50fa20913bf1bca2f7f20af0b07033f12":
        raise NativeProbeError(
            "Original tag initialization output differs from independently verified image"
        )
    if not report["csv_static_strings_inline"]:
        raise NativeProbeError("Flat image would omit CSV static String heap storage")
    (out / "runtime-memory.bin").write_bytes(after)
    (out / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
