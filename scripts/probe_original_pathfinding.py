#!/usr/bin/env python3
"""Run original factory/search functions on explicitly synthetic 5x5 grids.

This is an isolated native probe, not a simulator, troop movement model, or
battle-equivalence test. The game code is never rewritten. Original globals are
decoded in memory from the pinned signed asset pack. A minimal synthetic object
graph exposes selected original CSV fields to the original native factory; it
does not reproduce the game's CSV loader or complete arena/actor state.
"""

import argparse
from collections import Counter
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import struct
import sys
import zipfile

from sc_lzma import decode

ROOT = Path(__file__).resolve().parents[1]
LIBRARY_SHA = "347afc57c8d168bb67d0defa488a89f76297025cac1e8544b5182bb7e70ff433"
IMAGE_SHA = "32403dbc667e587a0327d76a92c0f5d562050f185dc42d7b8543103b6cf9882e"
TEXT_SHA = "3a4b013d548d28ca41f547d801877b7bbd54dff003dec07e2d6b8549424baca5"
ASSET_PACK_SHA = "3e62afcf73786919be08b0a48f1744d82b618642fed8e8db7d1a76b5b2eb3fd3"
GLOBALS_PACKED_SHA = "b7c786b0e260e211ca721154e1155dbb22a962f75f255f04bcb1f0f24d1cd3e1"
GLOBALS_SHA = "af87c4faf1d965a92a3f3f1b813e683c978c656ed09d041536d0424b0ffd92cd"
TEXT_START, TEXT_SIZE = 0x7706B0, 17877920
FACTORY, SEARCH = 0x11D8778, 0x11D7B58
NUMBER_FIELDS = {
    0x7C4: "PATHFINDING_DEFAULT_COST",
    0x7C8: "PATHFINDING_ROAD_COST",
    0x7CC: "PATHFINDING_MATCHINGROAD_COST",
    0x7D0: "PATHFINDING_BLOCKED_COST",
    0x7D4: "PATHFINDING_BUILDING_COST",
    0x7D8: "PATHFINDING_DEFAULTHEURISTIC_COST",
    0x7DC: "PATHFINDING_WATER_COST",
    0x7E0: "PATHFINDING_HEURISTIC_METHOD",
}
BOOLEAN_FIELDS = {
    0x7C0: "NEW_PATHFINDING_CODE",
    0x7C1: "PATHFINDING_DYNAMIC_OCCLUSIONS",
    0x7C2: "PATHFINDING_REFRESH_OPENNODES",
    0x7C3: "PATHFINDING_REOPEN_CLOSEDNODES",
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pinned_file(path, expected, maximum, read=True):
    path = Path(path)
    if path.stat().st_size > maximum:
        raise ValueError("Input exceeds its bounded maximum size")
    with path.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != expected:
            raise ValueError("Input does not match pinned 160402020 provenance")
    return path.read_bytes() if read else None


def parse_globals(data):
    reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig")), strict=True)
    header = reader.fieldnames
    if (
        not header
        or len(set(header)) != len(header)
        or not {"Name", "NumberValue", "BooleanValue"} <= set(header)
    ):
        raise ValueError("Missing or duplicate globals CSV columns")
    required = set(NUMBER_FIELDS.values()) | set(BOOLEAN_FIELDS.values())
    result = {}
    for row in reader:
        name = row["Name"]
        if name not in required:
            continue
        if (
            name in result
            or None in row
            or any(value is None for value in row.values())
        ):
            raise ValueError("Duplicate or malformed required globals row")
        if name in NUMBER_FIELDS.values():
            value = row["NumberValue"]
            if not re.fullmatch(r"-?(?:0|[1-9][0-9]*)", value):
                raise ValueError(
                    "Globals numeric field is not a canonical decimal integer"
                )
            parsed = int(value)
            if not -(1 << 31) <= parsed < (1 << 31):
                raise ValueError("Globals numeric field exceeds int32")
        else:
            value = row["BooleanValue"]
            if value not in ("TRUE", "FALSE"):
                raise ValueError("Globals boolean field must be TRUE or FALSE")
            parsed = value == "TRUE"
        result[name] = parsed
    if set(result) != required:
        raise ValueError("Required pathfinding globals are missing")
    return result


def globals_from_pack(path):
    pinned_file(path, ASSET_PACK_SHA, 1_000_000_000, read=False)
    with zipfile.ZipFile(path) as archive:
        packed = archive.read("assets/csv_logic/globals.csv")
    if sha(packed) != GLOBALS_PACKED_SHA:
        raise ValueError("Packed globals asset hash differs")
    original = decode(packed, max_output=1_000_000)
    if sha(original) != GLOBALS_SHA:
        raise ValueError("Decoded globals asset hash differs")
    return parse_globals(original)


def private_output(path, root=ROOT):
    root = Path(root).resolve()
    work = root / "work"
    destination = Path(path).resolve()
    if work.resolve() != work or not destination.is_relative_to(work):
        raise ValueError("Probe output must remain inside repository work/")
    return destination


def synthetic_cases():
    result = []
    for name, cells, dynamic in [
        ("empty", [0] * 25, [0] * 25),
        ("road_diagonal", [int(i % 6 == 0) for i in range(25)], [0] * 25),
        ("blocked_center", [32 if i == 12 else 0 for i in range(25)], [0] * 25),
        ("dynamic_center", [0] * 25, [500 if i == 12 else 0 for i in range(25)]),
    ]:
        for start, goal in [(0, 24), (4, 20), (12, 12)]:
            result.append(
                {
                    "name": name,
                    "width": 5,
                    "height": 5,
                    "start": start,
                    "goal": goal,
                    "cells": cells.copy(),
                    "dynamic_costs": dynamic.copy(),
                    "dynamic_enabled": name == "dynamic_center",
                }
            )
    return result


def validate_case(case):
    if case["width"] != 5 or case["height"] != 5:
        raise ValueError("Only explicitly bounded synthetic 5x5 fixtures are supported")
    if any(
        type(case[key]) is not int or not 0 <= case[key] < 25
        for key in ("start", "goal")
    ):
        raise ValueError("Synthetic start or goal is outside the grid")
    for key in ("cells", "dynamic_costs"):
        if len(case[key]) != 25 or any(
            type(value) is not int or not 0 <= value < (1 << 32) for value in case[key]
        ):
            raise ValueError("Synthetic grid must contain 25 uint32 values")
    if type(case["dynamic_enabled"]) is not bool:
        raise ValueError("Synthetic dynamic flag must be a boolean")


class NativeProbeError(RuntimeError):
    pass


class PathfindingProbe:
    BASE, STACK, STUB, HEAP, STOP = (
        0x10000000,
        0x40000000,
        0x50000000,
        0x60000000,
        0x70000000,
    )
    HEAP_SIZE = 0x1000000

    def __init__(self, image, library, settings):
        if sha(image) != IMAGE_SHA or sha(library) != LIBRARY_SHA:
            raise ValueError(
                "Unrecognized original ELF or canonical relocated code image"
            )
        if sha(image[TEXT_START : TEXT_START + TEXT_SIZE]) != TEXT_SHA:
            raise ValueError("Recovered original text region differs")
        from elftools.elf.elffile import ELFFile
        import unicorn
        from unicorn import arm64_const as registers

        self.unicorn, self.reg = unicorn, registers
        self.image, self.settings = image, settings
        elf = ELFFile(io.BytesIO(library))
        if elf["e_machine"] != "EM_AARCH64":
            raise ValueError("Expected ARM64 ELF")
        loads = [
            segment for segment in elf.iter_segments() if segment["p_type"] == "PT_LOAD"
        ]
        tags = {
            tag.entry.d_tag: tag.entry.d_val
            for segment in elf.iter_segments()
            if segment["p_type"] == "PT_DYNAMIC"
            for tag in segment.iter_tags()
        }

        def offset(address):
            for segment in loads:
                if (
                    segment["p_vaddr"]
                    <= address
                    < segment["p_vaddr"] + segment["p_filesz"]
                ):
                    return segment["p_offset"] + address - segment["p_vaddr"]
            raise ValueError("ELF address has no file backing")

        self.names = {}
        self.relocation_sites = 0
        for key, size_key in [("DT_RELA", "DT_RELASZ"), ("DT_JMPREL", "DT_PLTRELSZ")]:
            if tags[size_key] % 24:
                raise ValueError("Unexpected ELF relocation width")
            for position in range(
                offset(tags[key]), offset(tags[key]) + tags[size_key], 24
            ):
                target, info, addend = struct.unpack_from("<QQq", library, position)
                kind = info & 0xFFFFFFFF
                if kind in (0, 1027):
                    continue
                if kind not in (257, 1025, 1026):
                    raise ValueError("Unsupported ELF relocation kind")
                number, _, _, section, _, _ = struct.unpack_from(
                    "<IBBHQQ", library, offset(tags["DT_SYMTAB"]) + (info >> 32) * 24
                )
                if section:
                    continue
                start = offset(tags["DT_STRTAB"]) + number
                name = library[start : library.index(0, start)].decode("ascii")
                address = struct.unpack_from("<Q", image, target)[0]
                if (
                    addend != 0
                    or address % 16
                    or not self.STUB <= address < self.STUB + 0x100000
                ):
                    raise ValueError(
                        "Undefined-symbol relocation violates canonical stub layout"
                    )
                if address in self.names and self.names[address] != name:
                    raise ValueError("Conflicting canonical import identity")
                self.names[address] = name
                self.relocation_sites += 1
        if self.relocation_sites != 1755:
            raise ValueError("Pinned undefined-symbol relocation count differs")
        self.u = unicorn.Uc(unicorn.UC_ARCH_ARM64, unicorn.UC_MODE_ARM)
        image_size = (len(image) + 4095) & -4096
        self.u.mem_map(self.BASE, image_size)
        self.u.mem_write(self.BASE, image)
        # Factory/search may mutate synthetic heap state, never original image bytes.
        self.u.mem_protect(
            self.BASE, image_size, unicorn.UC_PROT_READ | unicorn.UC_PROT_EXEC
        )
        for address, size in [
            (self.STACK, 0x400000),
            (self.STUB, 0x100000),
            (self.HEAP, self.HEAP_SIZE),
            (self.STOP, 4096),
        ]:
            self.u.mem_map(address, size)
        self.u.reg_write(registers.UC_ARM64_REG_TPIDR_EL0, self.HEAP)
        self.u.reg_write(registers.UC_ARM64_REG_CPACR_EL1, 3 << 20)
        self.next_address, self.allocations = self.HEAP + 0x100000, {}
        self.import_calls, self.stop_reason = Counter(), None
        self.u.hook_add(
            unicorn.UC_HOOK_CODE,
            self._import_hook,
            begin=self.STUB,
            end=self.STUB + 0xFFFFF,
        )
        self.u.hook_add(unicorn.UC_HOOK_INTR, self._interrupt)
        self.controller, self.arena, self.grid = (
            self.HEAP + 0x11000,
            self.HEAP + 0x12000,
            self.HEAP + 0x13000,
        )
        self.fixture_regions = {
            self.controller: 0x100,
            self.arena: 0x100,
            self.grid: 100,
            self.HEAP + 0x16000: 0x100,
            self.HEAP + 0x17000: 0x100,
            self.HEAP + 0x18000: 0x800,
        }
        self._factory()

    def allocate(self, size):
        if not 0 <= size <= self.HEAP_SIZE:
            raise NativeProbeError("Allocation exceeds modeled bounds")
        address = self.next_address
        end = address + ((max(1, size) + 15) & -16)
        if end > self.HEAP + self.HEAP_SIZE:
            raise NativeProbeError("Modeled heap exhausted")
        self.next_address = end
        self.allocations[address] = size
        return address

    def allocation_extent(self, address, length):
        if length < 0 or not any(
            base <= address and address + length <= base + size
            for base, size in self.allocations.items()
        ):
            raise NativeProbeError(
                f"Native output 0x{address:x}+{length} is outside a modeled allocation"
            )

    def owned_extent(self, address, length):
        if length >= 0 and any(
            base <= address and address + length <= base + size
            for base, size in self.fixture_regions.items()
        ):
            return
        self.allocation_extent(address, length)

    def _import_hook(self, uc, pc, instruction_size, user_data):
        r = self.reg
        name = self.names.get(pc)
        x, y, z, bound = [uc.reg_read(r.UC_ARM64_REG_X0 + i) for i in range(4)]
        self.import_calls[name or "<unknown>"] += 1
        try:
            if name in ("malloc", "_Znwm", "_Znam"):
                result = self.allocate(x)
            elif name in ("free", "_ZdlPv", "_ZdaPv"):
                if x and x not in self.allocations:
                    raise NativeProbeError(
                        "Free does not identify a modeled allocation"
                    )
                result = 0
            elif name in (
                "memset",
                "__memset_chk",
                "memcpy",
                "memmove",
                "__memcpy_chk",
                "__memmove_chk",
            ):
                if z > self.HEAP_SIZE or (name.endswith("_chk") and z > bound):
                    raise NativeProbeError("Memory operation exceeds its bound")
                if not (
                    (self.HEAP <= x and x + z <= self.HEAP + self.HEAP_SIZE)
                    or (self.STACK <= x and x + z <= self.STACK + 0x400000)
                ):
                    raise NativeProbeError(
                        "Memory import cannot write outside modeled heap/stack"
                    )
                if z:
                    value = (
                        bytes([y & 255]) * z
                        if "memset" in name
                        else bytes(uc.mem_read(y, z))
                    )
                    uc.mem_write(x, value)
                result = x
            else:
                raise NativeProbeError(f"Unmodeled import: {name}")
            uc.reg_write(r.UC_ARM64_REG_X0, result)
            uc.reg_write(r.UC_ARM64_REG_PC, uc.reg_read(r.UC_ARM64_REG_LR))
        except Exception as error:
            self.stop_reason = str(error)
            uc.emu_stop()

    def _interrupt(self, uc, number, user_data):
        self.stop_reason = f"Target interrupt {number}; no host forwarding"
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
                self.BASE + address, self.STOP, timeout=1_000_000, count=2_000_000
            )
        except self.unicorn.UcError as error:
            raise NativeProbeError(f"Original function faulted: {error}") from error
        if self.stop_reason or self.u.reg_read(r.UC_ARM64_REG_PC) != self.STOP:
            raise NativeProbeError(
                self.stop_reason or "Native timeout/instruction budget; no return"
            )

    def write32(self, address, value):
        self.u.mem_write(address, struct.pack("<I", value & 0xFFFFFFFF))

    def write64(self, address, value):
        self.u.mem_write(address, struct.pack("<Q", value))

    def pointer(self, address):
        return struct.unpack("<Q", self.u.mem_read(address, 8))[0]

    def word(self, address):
        return struct.unpack("<i", self.u.mem_read(address, 4))[0]

    def _factory(self):
        level, tables, globals_data = (
            self.HEAP + 0x16000,
            self.HEAP + 0x17000,
            self.HEAP + 0x18000,
        )
        self.write64(self.arena + 0x98, self.grid)
        self.write32(self.arena + 0xA8, 5)
        self.write32(self.arena + 0xAC, 5)
        self.write64(level + 0x20, tables)
        self.write64(tables + 0x18, globals_data)
        for offset, key in NUMBER_FIELDS.items():
            self.write32(globals_data + offset, self.settings[key])
        for offset, key in BOOLEAN_FIELDS.items():
            self.u.mem_write(globals_data + offset, bytes([self.settings[key]]))
        self.invoke(FACTORY, [self.controller, level, self.arena])
        self.obj = self.pointer(self.controller + 0x40)
        self.allocation_extent(self.obj, 0x77)
        vector = self.pointer(self.controller + 0x28)
        self.owned_extent(vector, 8)
        self.dynamic = self.pointer(vector)
        self.allocation_extent(self.dynamic, 100)
        cost_names = [
            "PATHFINDING_WATER_COST",
            "PATHFINDING_BLOCKED_COST",
            "PATHFINDING_BUILDING_COST",
            "PATHFINDING_DEFAULT_COST",
            "PATHFINDING_ROAD_COST",
            "PATHFINDING_MATCHINGROAD_COST",
            "PATHFINDING_DEFAULTHEURISTIC_COST",
        ]
        matches = (
            self.word(self.controller) == 5 and self.word(self.controller + 4) == 5
        )
        matches &= all(
            self.word(self.controller + 0xC + 4 * i) == self.settings[key]
            for i, key in enumerate(cost_names)
        )
        matches &= (
            self.word(self.obj + 0x18) == self.settings["PATHFINDING_HEURISTIC_METHOD"]
        )
        matches &= bytes(self.u.mem_read(self.obj + 0x74, 3)) == bytes(
            [
                not self.settings["NEW_PATHFINDING_CODE"],
                self.settings["PATHFINDING_REFRESH_OPENNODES"],
                self.settings["PATHFINDING_REOPEN_CLOSEDNODES"],
            ]
        )
        if not matches:
            raise NativeProbeError(
                "Original factory did not preserve pinned globals/fixture dimensions"
            )

    def read_array(self, address, count):
        if not 0 <= count <= 25:
            raise NativeProbeError("Native result count exceeds synthetic grid bound")
        if not count:
            return []
        self.allocation_extent(address, count * 4)
        return list(
            struct.unpack("<" + "i" * count, self.u.mem_read(address, count * 4))
        )

    def run_case(self, case):
        validate_case(case)
        self.u.mem_write(self.grid, struct.pack("<25I", *case["cells"]))
        self.u.mem_write(self.dynamic, struct.pack("<25I", *case["dynamic_costs"]))
        # Explicit synthetic state input, not a code patch or inferred game state.
        self.u.mem_write(self.controller + 0x71, bytes([case["dynamic_enabled"]]))
        self.invoke(SEARCH, [self.obj, case["start"], case["goal"], 0])
        path = self.read_array(
            self.pointer(self.obj + 0x48), self.word(self.obj + 0x50)
        )
        if any(not 0 <= cell < 25 for cell in path):
            raise NativeProbeError("Native path contains out-of-grid cell")
        statuses = self.read_array(self.pointer(self.obj + 0x28), 25)
        costs = self.read_array(self.pointer(self.obj + 0x38), 25)
        return {
            **case,
            "path_reverse_excludes_start": path,
            "goal_cost": costs[case["goal"]],
            "goal_status": statuses[case["goal"]],
        }


def probe(image_path, library_path, asset_pack, output):
    output = private_output(output)
    image = pinned_file(image_path, IMAGE_SHA, 64 * 1024 * 1024)
    library = pinned_file(library_path, LIBRARY_SHA, 64 * 1024 * 1024)
    settings = globals_from_pack(asset_pack)
    native = PathfindingProbe(image, library, settings)
    cases = [native.run_case(case) for case in synthetic_cases()]
    if sha(bytes(native.u.mem_read(native.BASE, len(image)))) != IMAGE_SHA:
        raise NativeProbeError("Original code image changed during the probe")
    report = {
        "schema_version": 1,
        "scope": "Original native factory/search on explicit synthetic 5x5 grids with null actor; no troop movement or battle-equivalence claim.",
        "image_sha256": IMAGE_SHA,
        "library_sha256": LIBRARY_SHA,
        "text_sha256": TEXT_SHA,
        "asset_pack_sha256": ASSET_PACK_SHA,
        "packed_globals_sha256": GLOBALS_PACKED_SHA,
        "globals_sha256": GLOBALS_SHA,
        "image_policy": "Exact canonical whole-image hash required; no normalized or alternative image is accepted. Existing undefined-symbol relocation sites are identified from the pinned original ELF; none is rewritten by this probe.",
        "undefined_symbol_relocation_sites": native.relocation_sites,
        "native_entries": {"factory": hex(FACTORY), "search": hex(SEARCH)},
        "native_factory_costs_and_search_flags_match_globals": True,
        "original_image_unchanged": True,
        "assumptions": [
            "Synthetic level/table/arena object graph; original CSV fields materialized at observed offsets",
            "Original native factory constructs controller/search objects; original native search computes all outputs",
            "Null actor; synthetic grid bit patterns and explicit per-case dynamic flag/cost array",
            "Controller byte +0x71 is a synthetic override; its relationship to the shipped dynamic-occlusion setting is not established",
            "Single-thread execution, bounded bump allocator, no storage reclamation, modeled memory imports",
            "No Android ART/Bionic initialization, game account, host syscall forwarding, or battle tick",
        ],
        "limits": {
            "seconds_per_call": 1,
            "instructions_per_call": 2_000_000,
            "heap_bytes": native.HEAP_SIZE,
        },
        "imports": dict(sorted(native.import_calls.items())),
        "cases": cases,
        "all_cases_completed": len(cases) == 12,
    }
    output.mkdir(parents=True, exist_ok=True)
    output = private_output(output)
    target = output / "report.json"
    if target.is_symlink() or not target.resolve().is_relative_to(output):
        raise ValueError("Report target escapes local output directory")
    target.write_text(json.dumps(report, indent=2) + "\n")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--asset-pack", type=Path, required=True)
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Explicit output inside repository work/",
    )
    args = parser.parse_args(argv)
    try:
        report = probe(args.image, args.library, args.asset_pack, args.out)
    except (
        ValueError,
        NativeProbeError,
        OSError,
        csv.Error,
        zipfile.BadZipFile,
    ) as error:
        print(f"Probe failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
