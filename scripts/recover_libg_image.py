"""Execute the original libg initializer with pinned recovered support inputs.

This is code extraction, not Android initialization or a battle environment.
The support selector handler is explicitly replaced by an exact copy of a
previously native-decoded, integrity-checked configuration record. The original
support dispatcher, base-address handler, and libg initializer execute unchanged.
Unknown imports/syscalls stop. No target syscall is forwarded to the host.
"""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import struct
import time

from audit_asset_pack import private_extraction_root, extraction_target

LIBG_SHA = "347afc57c8d168bb67d0defa488a89f76297025cac1e8544b5182bb7e70ff433"
SUPPORT_SHA = "58735fa9ae5a6d7ea5f828066f3f06e7669eecb79c8ce4c49d4db5d704b72aac"
CONFIG_SHA = "29f73c4325b635d46233ca040c0048cad83570b7cad0fb456099785140f1bb83"
TEXT_SHA = "3a4b013d548d28ca41f547d801877b7bbd54dff003dec07e2d6b8549424baca5"
BASE, SUPPORT, STACK, STUBS, TLS, STOP = (
    0x10000000,
    0x20000000,
    0x40000000,
    0x50000000,
    0x60000000,
    0x70000000,
)
PAGE = 4096


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pinned(path, expected):
    data = path.read_bytes()
    if sha(data) != expected:
        raise ValueError("Input does not match the pinned recovery artifact")
    return data


def align(value):
    return (value + PAGE - 1) & -PAGE


def recover(library, support_image, configuration, output, seconds=120):
    from elftools.elf.elffile import ELFFile
    from unicorn import (
        Uc,
        UcError,
        UC_ARCH_ARM64,
        UC_MODE_ARM,
        UC_HOOK_CODE,
        UC_HOOK_INTR,
    )
    from unicorn.arm64_const import (
        UC_ARM64_REG_SP,
        UC_ARM64_REG_LR,
        UC_ARM64_REG_PC,
        UC_ARM64_REG_X0,
        UC_ARM64_REG_X8,
        UC_ARM64_REG_TPIDR_EL0,
        UC_ARM64_REG_CPACR_EL1,
    )

    output = private_extraction_root(output)
    raw = pinned(library, LIBG_SHA)
    support = pinned(support_image, SUPPORT_SHA)
    config = pinned(configuration, CONFIG_SHA)
    if len(config) != 672 or seconds <= 0:
        raise ValueError("Invalid configuration size or execution timeout")
    with library.open("rb") as source:
        elf = ELFFile(source)
        if elf["e_machine"] != "EM_AARCH64":
            raise ValueError("Expected ARM64 ELF")
        segments = [
            dict(s.header, data=s.data())
            for s in elf.iter_segments()
            if s["p_type"] == "PT_LOAD"
        ]
        dynamic = next(s for s in elf.iter_segments() if s["p_type"] == "PT_DYNAMIC")
        tags = {t.entry.d_tag: t.entry.d_val for t in dynamic.iter_tags()}

    def file_offset(va):
        for segment in segments:
            if segment["p_vaddr"] <= va < segment["p_vaddr"] + segment["p_filesz"]:
                return segment["p_offset"] + va - segment["p_vaddr"]
        raise ValueError("ELF address has no file-backed bytes")

    u = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
    image_size = align(max(s["p_vaddr"] + s["p_memsz"] for s in segments))
    u.mem_map(BASE, image_size)
    for segment in segments:
        u.mem_write(BASE + segment["p_vaddr"], segment["data"])
    u.mem_map(SUPPORT, align(len(support)))
    u.mem_write(SUPPORT, support)
    for address, length in [
        (STACK, 0x400000),
        (STUBS, 0x100000),
        (TLS, PAGE),
        (STOP, PAGE),
    ]:
        u.mem_map(address, length)

    imported_symbols, relocations = {}, Counter()
    for key, size_key in [("DT_RELA", "DT_RELASZ"), ("DT_JMPREL", "DT_PLTRELSZ")]:
        begin = file_offset(tags[key])
        for offset in range(begin, begin + tags[size_key], 24):
            target, info, addend = struct.unpack_from("<QQq", raw, offset)
            kind, index = info & 0xFFFFFFFF, info >> 32
            relocations[kind] += 1
            if kind == 1027:
                value = BASE + addend
            elif kind in (257, 1025, 1026):
                name_offset, _, _, section, va, _ = struct.unpack_from(
                    "<IBBHQQ", raw, file_offset(tags["DT_SYMTAB"]) + index * 24
                )
                if section:
                    value = BASE + va + addend
                else:
                    start = file_offset(tags["DT_STRTAB"]) + name_offset
                    name = raw[start : raw.index(0, start)].decode("ascii")
                    if name not in imported_symbols:
                        imported_symbols[name] = STUBS + len(imported_symbols) * 16
                    value = imported_symbols[name] + addend
            elif kind == 0:
                continue
            else:
                raise ValueError("Unsupported ELF relocation")
            u.mem_write(BASE + target, struct.pack("<Q", value & ((1 << 64) - 1)))

    # Only this virtual proc file is readable. It identifies the pinned images.
    mapping_lines = []
    for segment in segments:
        flags = segment["p_flags"]
        permission = (
            "".join(
                c if flags & bit else "-" for c, bit in [("r", 4), ("w", 2), ("x", 1)]
            )
            + "p"
        )
        mapping_lines.append(
            f"{BASE + (segment['p_vaddr'] & -PAGE):x}-{BASE + align(segment['p_vaddr'] + segment['p_memsz']):x} "
            f"{permission} {segment['p_offset'] & -PAGE:08x} 00:01 3 /data/app/research/lib/arm64/libg.so\n"
        )
    mapping_lines.append(
        f"{SUPPORT:x}-{SUPPORT + align(len(support)):x} r-xp 00000000 00:01 1 "
        "/data/app/research/lib/arm64/libsupercell_clashroyale.so\n"
    )
    maps = "".join(mapping_lines).encode()
    descriptors, calls, adapters = {}, [], []
    failure = None

    def fail(message):
        nonlocal failure
        failure = message
        u.emu_stop()

    def interrupt(uc, interrupt_number, _):
        try:
            if interrupt_number != 2:
                raise ValueError("Unsupported target interrupt")
            number = uc.reg_read(UC_ARM64_REG_X8)
            args = [uc.reg_read(UC_ARM64_REG_X0 + i) for i in range(6)]
            calls.append({"number": number, "arguments": [hex(x) for x in args]})
            if number == 226:  # mprotect: extraction memory is already mapped RWX.
                address, length, protection = args[:3]
                if (
                    address % PAGE
                    or length <= 0
                    or not BASE <= address <= BASE + image_size - align(length)
                    or protection != 7
                ):
                    raise ValueError("Unsupported target memory-protection operation")
                result = 0
            elif number == 172:
                result = 1000
            elif number == 56:
                path = bytes(uc.mem_read(args[1], 256)).split(b"\0", 1)[0]
                if path != b"/proc/self/maps" or args[2] != 0:
                    raise ValueError("Unsupported target file open")
                result = max([2] + list(descriptors)) + 1
                descriptors[result] = 0
            elif number == 63:
                position = descriptors[args[0]]
                data = maps[position : position + args[2]]
                uc.mem_write(args[1], data)
                descriptors[args[0]] += len(data)
                result = len(data)
            elif number == 57:
                del descriptors[args[0]]
                result = 0
            else:
                raise ValueError(f"Unsupported target syscall {number}")
            uc.reg_write(UC_ARM64_REG_X0, result)
        except Exception as exc:
            fail(str(exc))

    def selector_adapter(uc, pc, size, _):
        try:
            selector = (uc.reg_read(UC_ARM64_REG_X0) ^ 1000) & 0xFFFFFFFF
            destination = uc.reg_read(UC_ARM64_REG_X0 + 1)
            if (
                selector != 0x7E33EB5E
                or not BASE <= destination <= BASE + image_size - len(config)
            ):
                raise ValueError("Unexpected selector or configuration destination")
            uc.mem_write(destination, config)
            adapters.append(
                {"selector": hex(selector), "bytes": len(config), "sha256": CONFIG_SHA}
            )
            uc.reg_write(UC_ARM64_REG_X0, 0)
            uc.reg_write(UC_ARM64_REG_PC, uc.reg_read(UC_ARM64_REG_LR))
        except Exception as exc:
            fail(str(exc))

    u.hook_add(UC_HOOK_INTR, interrupt)
    u.hook_add(
        UC_HOOK_CODE, selector_adapter, begin=SUPPORT + 0x19FCEC, end=SUPPORT + 0x19FCEC
    )
    u.hook_add(
        UC_HOOK_CODE,
        lambda *_: fail("Unexpected target import"),
        begin=STUBS,
        end=STUBS + 0xFFFFF,
    )
    u.reg_write(UC_ARM64_REG_SP, STACK + 0x200000)
    u.reg_write(UC_ARM64_REG_LR, STOP)
    u.reg_write(UC_ARM64_REG_TPIDR_EL0, TLS)
    u.reg_write(UC_ARM64_REG_CPACR_EL1, 3 << 20)
    before = bytes(u.mem_read(BASE, image_size))
    started = time.monotonic()
    try:
        u.emu_start(
            BASE + tags["DT_INIT"],
            STOP,
            timeout=seconds * 1_000_000,
            count=1_000_000_000,
        )
    except UcError as exc:
        failure = str(exc)
    after = bytes(u.mem_read(BASE, image_size))
    text = after[0x7706B0 : 0x7706B0 + 17877920]
    returned = u.reg_read(UC_ARM64_REG_PC) == STOP
    if not returned and failure is None:
        failure = "Native initializer reached the time or instruction limit"
    verified = (
        returned and failure is None and len(adapters) == 1 and sha(text) == TEXT_SHA
    )
    report = {
        "schema_version": 1,
        "scope": "Original initializer code extraction only; no Android or battle execution.",
        "libg_sha256": LIBG_SHA,
        "support_image_sha256": SUPPORT_SHA,
        "selector_adapter": adapters,
        "returned": returned,
        "stop_reason": failure,
        "elapsed_seconds": time.monotonic() - started,
        "changed_bytes_excluding_relocations": sum(
            x != y for x, y in zip(before, after)
        ),
        "image_bytes": len(after),
        "image_sha256": sha(after),
        "text_region": {
            "elf_va": "0x7706b0",
            "bytes": len(text),
            "sha256": sha(text),
            "matches_independent_recovery": sha(text) == TEXT_SHA,
        },
        "relocations": dict(relocations),
        "syscalls": calls,
        "verified_recovery": verified,
        "limitations": "Support handler A is replaced by a pinned original decoded record copy. Import addresses, process ID, proc maps, TLS and memory protection are modeled. Whole-image addresses may differ from other extraction runs. No full runtime or gameplay equivalence claim.",
    }
    output.mkdir(parents=True, exist_ok=True)
    extraction_target(output, "report.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    if verified:
        extraction_target(output, "libg-memory.bin").write_bytes(after)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--support-image", type=Path, required=True)
    parser.add_argument("--configuration", type=Path, required=True)
    parser.add_argument(
        "--out", type=Path, required=True, help="Directory inside repository work/"
    )
    parser.add_argument("--seconds", type=int, default=120)
    args = parser.parse_args()
    report = recover(
        args.library, args.support_image, args.configuration, args.out, args.seconds
    )
    print(json.dumps({k: v for k, v in report.items() if k != "syscalls"}, indent=2))
    return 0 if report["verified_recovery"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
