#!/usr/bin/env python3
"""Recover pinned metadata with original native code in isolated ARM64 emulation.

No Android/runtime or battle-equivalence claim is made. Inputs contain all target
code/key material; this script contains only format descriptions, addresses, and
provenance hashes. No target syscall is forwarded to the host. Output payloads
are restricted to this repository's work/ directory; public summaries contain
counts, hashes, and explicitly modeled operations only.
"""

import argparse
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
APK_SHA256 = "0d0dfed74fdb755b71f5424e70af9234ed25471c029d09863b657fed9057b13e"
LIBRARY_SHA256 = "20132160e841a00740ef818e0ae2796508cbdd4f5173834f53e7c6d5af045f2f"
IMAGE_SHA256 = "58735fa9ae5a6d7ea5f828066f3f06e7669eecb79c8ce4c49d4db5d704b72aac"
ASSET_SHA256 = "834217feba3588c1f4d28e8dcf2a309c9baa1903eb5c08f535a628b50751d60b"
PAYLOAD_SHA256 = "7fca2a35a1f6b23514d26c6cf541749883770243a0e8f548cccb79fe78bd3d53"
MAIN_SHA256 = "2057a3c586fd4d791ce7489673e9cb37aee1e9542ecf7631aa1e1f1c02bd288f"
ASSET_NAME = "assets/anjeamelnchn.dat"
SELECTOR_COUNT = 416
CONSTRUCTOR = 0x386F00
DECODER = 0x2739CC
MAX_INPUT = 64 * 1024 * 1024
MAX_MESSAGE = 2 * 1024 * 1024
MODELED_OPERATIONS = [
    "bounded bump allocator (free does not reclaim storage)",
    "memory-copy/set operations and comparison sign",
    "uncontended single-thread mutexes",
    "synthetic single-thread identity",
]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def pinned_bytes(path, expected, label):
    path = Path(path)
    if path.stat().st_size > MAX_INPUT:
        raise ValueError(f"{label} exceeds bounded input size")
    data = path.read_bytes()
    if sha256(data) != expected:
        raise ValueError(f"{label} does not match the pinned 160402020 input")
    return data


def varint(data, position):
    """Read a canonical unsigned protobuf varint, bounded to uint64."""
    start = position
    value = 0
    for index in range(10):
        if position >= len(data):
            raise ValueError("Truncated protobuf varint")
        byte = data[position]
        position += 1
        if index == 9 and byte > 1:
            raise ValueError("Protobuf varint exceeds uint64")
        value |= (byte & 0x7F) << (7 * index)
        if byte < 0x80:
            if position - start > 1 and byte == 0:
                raise ValueError("Noncanonical protobuf varint")
            return value, position
    raise ValueError("Unterminated protobuf varint")


def fields(data):
    if len(data) > MAX_MESSAGE:
        raise ValueError("Protobuf message exceeds bounded size")
    result = []
    position = 0
    while position < len(data):
        tag, position = varint(data, position)
        number, wire = tag >> 3, tag & 7
        if not 1 <= number < (1 << 29):
            raise ValueError("Invalid protobuf field number")
        if wire == 0:
            value, position = varint(data, position)
        elif wire == 2:
            length, position = varint(data, position)
            if length > len(data) - position:
                raise ValueError("Truncated protobuf length-delimited field")
            value = data[position : position + length]
            position += length
        else:
            raise ValueError("Unexpected protobuf wire type")
        result.append((number, wire, value))
    return result


def layout(data, schema):
    """Require exactly the observed fields, wire types and multiplicities."""
    parsed = fields(data)
    counts = Counter()
    result = {number: [] for number in schema}
    for number, wire, value in parsed:
        if number not in schema or wire != schema[number][0]:
            raise ValueError("Unexpected protobuf field or wire type")
        counts[number] += 1
        result[number].append(value)
    if any(counts[n] != count for n, (_, count) in schema.items()):
        raise ValueError("Protobuf field multiplicity mismatch")
    return result


def parse_container(data):
    if len(data) > MAX_MESSAGE or data[:4] != b"lbts":
        raise ValueError("Wrong or oversized metadata container")
    position = 4
    records = {}
    for expected_kind in (0x10, 0x20, 0x30):
        if len(data) - position < 8:
            raise ValueError("Truncated container record header")
        kind, length = struct.unpack_from("<II", data, position)
        position += 8
        if kind != expected_kind or length > len(data) - position:
            raise ValueError("Unexpected, duplicate, or truncated container record")
        records[kind] = data[position : position + length]
        position += length
    if position != len(data):
        raise ValueError("Trailing container data")
    return records


def signed_selector(value):
    # Protobuf int32 uses a sign-extended ten-byte varint for negative values.
    if not (
        0 <= value <= 0x7FFFFFFF or 0xFFFFFFFF80000000 <= value <= 0xFFFFFFFFFFFFFFFF
    ):
        raise ValueError("Selector is not a sign-extended protobuf int32")
    return value & 0xFFFFFFFF


def parse_metadata_record(data):
    outer = layout(data, {1: (2, 1), 2: (2, 1)})
    if len(outer[2][0]) != 256:
        raise ValueError("Unexpected outer signature length")
    schema = {number: (2, 1) for number in range(1, 12)}
    schema.update({2: (2, 35), 3: (2, 40), 10: (2, SELECTOR_COUNT)})
    body = layout(outer[1][0], schema)
    entries = []
    seen = set()
    for entry in body[10]:
        parsed = layout(entry, {1: (0, 1), 2: (2, 1)})
        selector = signed_selector(parsed[1][0])
        if selector in seen:
            raise ValueError("Duplicate selector")
        seen.add(selector)
        ciphertext = layout(parsed[2][0], {1: (2, 1)})[1][0]
        if not ciphertext:
            raise ValueError("Empty selector ciphertext")
        entries.append((selector, ciphertext))
    main_ciphertext = layout(body[1][0], {1: (2, 1)})[1][0]
    if not main_ciphertext:
        raise ValueError("Empty main metadata ciphertext")
    return entries, main_ciphertext


def output_directory(path, root=ROOT):
    root = Path(root).resolve()
    work = root / "work"
    if work.resolve() != work:
        raise ValueError(
            "Repository work directory must not redirect through a symlink"
        )
    destination = Path(path).resolve()
    if not destination.is_relative_to(work):
        raise ValueError("Original payload output must be inside repository work/")
    return destination


def output_file(directory, name):
    if Path(name).name != name:
        raise ValueError("Output name must be a single filename")
    target = Path(directory) / name
    if target.is_symlink() or not target.resolve().is_relative_to(
        Path(directory).resolve()
    ):
        raise ValueError("Output file escapes its local directory")
    return target


class NativeExecutionError(RuntimeError):
    """The helper did not complete within the explicitly modeled environment."""


class NativeRejected(ValueError):
    """The original decoder completed and returned its no-value result."""


class NativeDecoder:
    BASE = 0x20000000
    STACK = 0x40000000
    STUB = 0x50000000
    HEAP = 0x60000000
    STOP = 0x70000000
    HEAP_SIZE = 0x1000000
    OUT = HEAP + 0x8000

    def __init__(self, image, library, seconds=30):
        if sha256(image) != IMAGE_SHA256 or sha256(library) != LIBRARY_SHA256:
            raise ValueError("Native inputs are not the pinned recovered image and ELF")
        if not 0 < seconds <= 60:
            raise ValueError("Per-call timeout must be between zero and 60 seconds")
        # Keep pure parsers importable by the standard-library unit tests.
        import unicorn
        from unicorn import arm64_const as registers
        from elftools.elf.elffile import ELFFile

        self.unicorn, self.reg = unicorn, registers
        self.u = unicorn.Uc(unicorn.UC_ARCH_ARM64, unicorn.UC_MODE_ARM)
        self.seconds = seconds
        self.image_size = len(image)
        self.u.mem_map(self.BASE, (len(image) + 4095) & -4096)
        self.u.mem_write(self.BASE, image)
        for address, size in [
            (self.STACK, 0x400000),
            (self.STUB, 0x100000),
            (self.HEAP, self.HEAP_SIZE),
            (self.STOP, 4096),
        ]:
            self.u.mem_map(address, size)
        self.u.reg_write(registers.UC_ARM64_REG_TPIDR_EL0, self.HEAP)
        self.u.reg_write(registers.UC_ARM64_REG_CPACR_EL1, 3 << 20)
        self.next_address = self.HEAP + 0x10000
        self.allocations = {}
        self.import_calls = Counter()
        self.stop_reason = None
        self.result_type = None
        elf = ELFFile(io.BytesIO(library))
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
            raise ValueError("ELF virtual address has no file backing")

        self.names = {}
        for key, size_key in [("DT_RELA", "DT_RELASZ"), ("DT_JMPREL", "DT_PLTRELSZ")]:
            if tags[size_key] % 24:
                raise ValueError("Unexpected ELF relocation width")
            for position in range(0, tags[size_key], 24):
                target, info, addend = struct.unpack_from(
                    "<QQq", library, offset(tags[key]) + position
                )
                if info & 0xFFFFFFFF not in (257, 1025, 1026):
                    continue
                number, _, _, section, _, _ = struct.unpack_from(
                    "<IBBHQQ", library, offset(tags["DT_SYMTAB"]) + (info >> 32) * 24
                )
                if section:
                    continue
                name = (
                    library[offset(tags["DT_STRTAB"]) + number :]
                    .split(b"\0", 1)[0]
                    .decode("ascii")
                )
                address = struct.unpack_from("<Q", image, target)[0]
                if self.STUB <= address < self.STUB + 0x100000:
                    if address in self.names and self.names[address] != name:
                        raise ValueError("Conflicting import-stub identities")
                    self.names[address] = name
        self.u.hook_add(
            unicorn.UC_HOOK_CODE,
            self._import_hook,
            begin=self.STUB,
            end=self.STUB + 0xFFFFF,
        )
        self.u.hook_add(unicorn.UC_HOOK_INTR, self._interrupt)
        self._call(CONSTRUCTOR, self.OUT, indirect=self.OUT)

    def malloc(self, size):
        if not 0 <= size <= self.HEAP_SIZE:
            raise NativeExecutionError("Allocation exceeds modeled heap")
        address = self.next_address
        end = address + ((max(size, 1) + 15) & -16)
        if end > self.HEAP + self.HEAP_SIZE:
            raise NativeExecutionError("Modeled heap exhausted")
        self.next_address = end
        self.allocations[address] = size
        return address

    def _cstring(self, address):
        for size in range(65536):
            if self.u.mem_read(address + size, 1) == b"\0":
                return size
        raise NativeExecutionError("Unterminated bounded C string")

    def _import_hook(self, uc, pc, size, user_data):
        r = self.reg
        name = self.names.get(pc)
        args = [uc.reg_read(r.UC_ARM64_REG_X0 + index) for index in range(4)]
        x, y, z, bound = args
        self.import_calls[name or "<unknown>"] += 1
        try:
            if name in ("malloc", "_Znwm", "_Znam"):
                result = self.malloc(x)
            elif name == "calloc":
                result = self.malloc(x * y)
                if x * y:
                    uc.mem_write(result, bytes(x * y))
            elif name == "realloc":
                if x and x not in self.allocations:
                    raise NativeExecutionError(
                        "Realloc does not name a modeled allocation"
                    )
                result = self.malloc(y)
                if x:
                    uc.mem_write(
                        result, bytes(uc.mem_read(x, min(y, self.allocations[x])))
                    )
            elif name in ("free", "_ZdlPv", "_ZdaPv"):
                if x and x not in self.allocations:
                    raise NativeExecutionError(
                        "Free does not name a modeled allocation"
                    )
                result = 0
            elif name in (
                "memcpy",
                "memmove",
                "__memcpy_chk",
                "__memmove_chk",
                "memset",
                "__memset_chk",
                "memcmp",
            ):
                if z > self.HEAP_SIZE or (name.endswith("_chk") and z > bound):
                    raise NativeExecutionError(
                        "Memory operation exceeds explicit bound"
                    )
                if name == "memcmp":
                    left, right = bytes(uc.mem_read(x, z)), bytes(uc.mem_read(y, z))
                    result = (left > right) - (left < right)
                elif name in ("memset", "__memset_chk"):
                    if z:
                        uc.mem_write(x, bytes([y & 255]) * z)
                    result = x
                else:
                    if z:
                        uc.mem_write(x, bytes(uc.mem_read(y, z)))
                    result = x
            elif name == "strlen":
                result = self._cstring(x)
            elif name == "pthread_self":
                result = self.HEAP
            elif name in ("pthread_mutex_lock", "pthread_mutex_unlock"):
                result = 0
            else:
                raise NativeExecutionError(f"Unmodeled import: {name}")
            uc.reg_write(r.UC_ARM64_REG_X0, result & 0xFFFFFFFFFFFFFFFF)
            uc.reg_write(r.UC_ARM64_REG_PC, uc.reg_read(r.UC_ARM64_REG_LR))
        except Exception as error:
            self.stop_reason = str(error)
            uc.emu_stop()

    def _interrupt(self, uc, number, user_data):
        self.stop_reason = f"Target interrupt {number}; host forwarding is disabled"
        uc.emu_stop()

    def _call(self, entry, *args, indirect):
        r = self.reg
        self.stop_reason = None
        for index, value in enumerate(args):
            self.u.reg_write(r.UC_ARM64_REG_X0 + index, value)
        for register, value in [
            (r.UC_ARM64_REG_X8, indirect),
            (r.UC_ARM64_REG_LR, self.STOP),
            (r.UC_ARM64_REG_SP, self.STACK + 0x200000),
        ]:
            self.u.reg_write(register, value)
        try:
            self.u.emu_start(
                self.BASE + entry,
                self.STOP,
                timeout=int(self.seconds * 1_000_000),
                count=1_000_000_000,
            )
        except self.unicorn.UcError as error:
            raise NativeExecutionError(f"Original helper faulted: {error}") from error
        if self.stop_reason:
            raise NativeExecutionError(self.stop_reason)
        if self.u.reg_read(r.UC_ARM64_REG_PC) != self.STOP:
            raise NativeExecutionError(
                "Original helper did not return (timeout/instruction budget)"
            )

    def decode(self, ciphertext):
        address = self.malloc(len(ciphertext))
        self.u.mem_write(address, ciphertext)
        result_address = self.OUT + 0x100
        self.u.mem_write(result_address, bytes(0x100))
        self._call(DECODER, self.OUT, address, len(ciphertext), indirect=result_address)
        result_type, pointer, capacity, length, has_value = struct.unpack(
            "<QQQQB", self.u.mem_read(result_address, 33)
        )
        if has_value == 0 and length == 0:
            raise NativeRejected("Original decoder returned no value")
        if not (
            has_value == 1
            and 0 < length <= capacity <= len(ciphertext)
            and pointer in self.allocations
            and capacity <= self.allocations[pointer]
            and self.BASE <= result_type < self.BASE + self.image_size
        ):
            raise NativeExecutionError(
                "Invalid native result structure or allocation extent"
            )
        if self.result_type is None:
            self.result_type = result_type
        elif self.result_type != result_type:
            raise NativeExecutionError("Native successful-result type changed")
        return bytes(self.u.mem_read(pointer, length))


def recover(image_path, library_path, apk_path, out, seconds=30):
    destination = output_directory(out)
    image = pinned_bytes(image_path, IMAGE_SHA256, "Recovered support image")
    library = pinned_bytes(library_path, LIBRARY_SHA256, "Original support ELF")
    apk = pinned_bytes(apk_path, APK_SHA256, "Original base APK")
    with zipfile.ZipFile(io.BytesIO(apk)) as archive:
        asset = archive.read(ASSET_NAME)
    if sha256(asset) != ASSET_SHA256:
        raise ValueError("Metadata asset does not match pinned provenance")
    records = parse_container(asset)
    if {k: len(v) for k, v in records.items()} != {
        0x10: 1296,
        0x20: 23888,
        0x30: 943759,
    }:
        raise ValueError("Pinned container record lengths changed")
    entries, main_ciphertext = parse_metadata_record(records[0x30])
    decoder = NativeDecoder(image, library, seconds)
    payloads = []
    ordered = hashlib.sha256()
    for index, (selector, ciphertext) in enumerate(entries):
        try:
            payload = decoder.decode(ciphertext)
        except NativeRejected as error:
            raise NativeExecutionError(
                f"Original decoder rejected selector record {index}"
            ) from error
        ordered.update(struct.pack("<II", selector, len(payload)))
        ordered.update(payload)
        payloads.append((f"{selector:08x}.bin", payload))
    if ordered.hexdigest() != PAYLOAD_SHA256:
        raise NativeExecutionError(
            "Recovered selector aggregate does not match independent evidence"
        )
    try:
        main = decoder.decode(main_ciphertext)
    except NativeRejected as error:
        raise NativeExecutionError("Original decoder rejected main metadata") from error
    if sha256(main) != MAIN_SHA256:
        raise NativeExecutionError(
            "Recovered main metadata does not match independent evidence"
        )
    mutation = bytearray(entries[0][1])
    mutation[80] ^= 1
    try:
        decoder.decode(bytes(mutation))
    except NativeRejected:
        pass
    else:
        raise NativeExecutionError(
            "Original decoder accepted the one-bit negative control"
        )
    summary = {
        "schema_version": 1,
        "apk_sha256": APK_SHA256,
        "library_sha256": LIBRARY_SHA256,
        "recovered_support_image_sha256": IMAGE_SHA256,
        "metadata_asset_sha256": ASSET_SHA256,
        "metadata_asset_bytes": len(asset),
        "selector_records": len(entries),
        "records_accepted_by_original_decoder": len(payloads),
        "total_decoded_selector_bytes": sum(len(data) for _, data in payloads),
        "ordered_payload_sha256": ordered.hexdigest(),
        "ordered_payload_hash_layout": "Container order: uint32_le(selector), uint32_le(payload_length), exact payload.",
        "main_metadata_bytes": len(main),
        "main_metadata_sha256": sha256(main),
        "negative_control": {"ciphertext_bit_offset": 640, "mutated_rejected": True},
        "outer_signature_bytes": 256,
        "outer_signature_independently_verified": False,
        "modeled_operations": MODELED_OPERATIONS,
        "modeled_import_call_counts": dict(sorted(decoder.import_calls.items())),
        "readiness_or_integrity_code_patched": False,
        "scope": "Original metadata recovery and decoder acceptance only; Android initialization and battle equivalence remain unverified.",
    }
    # Do not leave partial decoded data after a rejected/faulting native run.
    payloads.append(("main-metadata.bin", main))
    destination.mkdir(parents=True, exist_ok=True)
    for name, data in payloads:
        target = output_file(destination, name)
        if target.exists() and target.read_bytes() != data:
            raise ValueError("Existing payload differs; refusing to overwrite it")
        target.write_bytes(data)
    output_file(destination, "public-summary.json").write_text(
        json.dumps(summary, indent=2) + "\n"
    )
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Explicit original-payload destination inside repository work/",
    )
    parser.add_argument(
        "--seconds",
        type=float,
        default=30,
        help="Bounded timeout per original native call (maximum 60)",
    )
    args = parser.parse_args(argv)
    try:
        summary = recover(args.image, args.library, args.apk, args.out, args.seconds)
    except (ValueError, NativeExecutionError, OSError, zipfile.BadZipFile) as error:
        print(f"Recovery failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
