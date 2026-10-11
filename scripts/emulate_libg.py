"""Emulate only libg's ELF initializer in an isolated ARM64 memory model.

No Android app is launched; no host syscalls, file access, or networking are
forwarded from emulated code. Unknown imports/syscalls stop the experiment.
The resulting bytes are an experimental memory image, not a runnable APK.
"""

from pathlib import Path
import struct, json, collections, argparse, hashlib
from inspect_native import inspect
from elftools.elf.elffile import ELFFile
from unicorn import (
    Uc,
    UcError,
    UC_ARCH_ARM64,
    UC_MODE_ARM,
    UC_HOOK_CODE,
    UC_HOOK_INTR,
    UC_HOOK_BLOCK,
)
from unicorn.arm64_const import *

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    "--workspace",
    type=Path,
    default=Path(__file__).resolve().parents[1] / "work/builds/160402020",
)
args = parser.parse_args()
ROOT = args.workspace
(ROOT / "inspection").mkdir(parents=True, exist_ok=True)
BASE, STACK, STUBS, HEAP, STOP = (
    0x10000000,
    0x40000000,
    0x50000000,
    0x60000000,
    0x70000000,
)
PAGE = 4096
round_page = lambda n: (n + PAGE - 1) & -PAGE
source = ROOT / "native/libg.so"
original = source.read_bytes()
source_sha256 = hashlib.sha256(original).hexdigest()
build_record = json.loads(
    (Path(__file__).resolve().parents[1] / "research/builds/160402020.json").read_text()
)
if source_sha256 != build_record["native"]["libg.so"]["sha256"]:
    raise ValueError("This experiment requires the pinned 160402020 libg.so")
# Regenerate symbols from these exact bytes; do not trust a stale sidecar table.
inspect(source, ROOT / "inspection")
f = source.open("rb")
elf = ELFFile(f)
segments = [s for s in elf.iter_segments() if s["p_type"] == "PT_LOAD"]
tags = {
    t.entry.d_tag: t.entry.d_val
    for t in elf.get_section_by_name(".dynamic").iter_tags()
}


def file_offset(va):
    for s in segments:
        if s["p_vaddr"] <= va < s["p_vaddr"] + s["p_filesz"]:
            return s["p_offset"] + va - s["p_vaddr"]
    raise ValueError(hex(va))


symbols = json.loads((ROOT / "inspection/libg.so.dynamic-symbols.json").read_text())
image_size = round_page(max(s["p_vaddr"] + s["p_memsz"] for s in segments))
u = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
u.mem_map(BASE, image_size)
for s in segments:
    u.mem_write(BASE + s["p_vaddr"], s.data())
u.mem_map(STACK, 0x200000)
u.mem_map(STUBS, 0x10000)
u.mem_map(HEAP, 0x400000)
u.mem_map(STOP, PAGE)
u.reg_write(UC_ARM64_REG_SP, STACK + 0x100000)
u.reg_write(UC_ARM64_REG_LR, STOP)
u.reg_write(UC_ARM64_REG_CPACR_EL1, 3 << 20)
stub_names = {}


def symbol_value(index):
    s = symbols[index]
    if s["section_index"]:
        return BASE + int(s["address"], 16)
    address = STUBS + index * 16
    stub_names[address] = s["name"]
    u.mem_write(address, bytes.fromhex("c0035fd6"))  # ret
    return address


relocations = collections.Counter()
for key, size_key in [("DT_RELA", "DT_RELASZ"), ("DT_JMPREL", "DT_PLTRELSZ")]:
    start = file_offset(tags[key])
    for offset in range(start, start + tags[size_key], 24):
        target, info, addend = struct.unpack_from("<QQq", original, offset)
        kind, sym = info & 0xFFFFFFFF, info >> 32
        relocations[kind] += 1
        if kind == 1027:
            value = BASE + addend
        elif kind in (257, 1025, 1026):
            value = symbol_value(sym) + addend
        elif kind == 0:
            continue
        else:
            raise RuntimeError(f"Unsupported relocation {kind}")
        u.mem_write(BASE + target, struct.pack("<Q", value & 0xFFFFFFFFFFFFFFFF))

report = {
    "input": source.name,
    "input_sha256": source_sha256,
    "base": hex(BASE),
    "image_size": image_size,
    "relocations": dict(relocations),
    "calls": [],
    "returned": False,
    "limitations": "Isolated initializer emulation; unknown host operations stop; not a full Android runtime.",
}
heap_next = HEAP
library_path = "/data/app/~~research/com.supercell.clashroyale/lib/arm64/libg.so"
map_lines = []
for segment in segments:
    flags = segment["p_flags"]
    permissions = (
        ("r" if flags & 4 else "-")
        + ("w" if flags & 2 else "-")
        + ("x" if flags & 1 else "-")
        + "p"
    )
    start = BASE + (segment["p_vaddr"] & -PAGE)
    end = BASE + round_page(segment["p_vaddr"] + segment["p_memsz"])
    offset = segment["p_offset"] & -PAGE
    map_lines.append(
        f"{start:08x}-{end:08x} {permissions} {offset:08x} 00:01 1 {library_path}\n"
    )
virtual_files = {"/proc/self/maps": "".join(map_lines).encode(), library_path: original}
open_files = {}


def read_c_string(address, limit=4096):
    return (
        bytes(u.mem_read(address, limit))
        .split(b"\0", 1)[0]
        .decode("utf-8", errors="replace")
    )


def stop(reason):
    report["stop_reason"] = reason
    u.emu_stop()


def ret(value):
    u.reg_write(UC_ARM64_REG_X0, value & 0xFFFFFFFFFFFFFFFF)
    u.reg_write(UC_ARM64_REG_PC, u.reg_read(UC_ARM64_REG_LR))


def model_syscall(number, args):
    if number == 226:
        return 0  # mprotect: memory is already accessible inside the emulator
    if number == 172:
        return 1000  # synthetic PID, no host query
    if number == 56:
        pathname = read_c_string(args[1])
        report.setdefault("requested_paths", []).append(pathname)
        if pathname not in virtual_files:
            raise RuntimeError(f"No virtual file model for {pathname}")
        fd = max([2] + list(open_files)) + 1
        open_files[fd] = [pathname, 0]
        return fd
    if number == 63:  # read from explicitly modelled virtual files only
        pathname, position = open_files[args[0]]
        data = virtual_files[pathname][position : position + args[2]]
        u.mem_write(args[1], data)
        open_files[args[0]][1] += len(data)
        return len(data)
    if number == 57:
        del open_files[args[0]]
        return 0
    if number == 62:
        pathname, position = open_files[args[0]]
        if args[2] not in (0, 1, 2):
            raise RuntimeError(f"Unmodelled lseek whence {args[2]}")
        offset = args[1] if args[1] < (1 << 63) else args[1] - (1 << 64)
        position = offset + (
            0
            if args[2] == 0
            else position if args[2] == 1 else len(virtual_files[pathname])
        )
        if position < 0:
            raise RuntimeError("Unmodelled negative lseek result")
        open_files[args[0]][1] = position
        return position
    raise RuntimeError(f"Unmodelled syscall {number}, args {args}")


def hook_import(uc, address, size, user_data):
    global heap_next
    name = stub_names.get(address)
    args = [uc.reg_read(UC_ARM64_REG_X0 + i) for i in range(7)]
    report["calls"].append({"name": name, "args": [hex(a) for a in args]})
    try:
        if name == "getauxval":
            if args[0] != 6:
                raise RuntimeError(f"Unmodelled auxiliary vector key {args[0]}")
            ret(PAGE)
        elif name == "getpagesize":
            ret(PAGE)
        elif name == "syscall":
            ret(model_syscall(args[0], args[1:]))
        elif name == "mprotect":
            ret(0)
        elif name in ("memcpy", "memmove", "__memcpy_chk", "__memmove_chk"):
            uc.mem_write(args[0], bytes(uc.mem_read(args[1], args[2])))
            ret(args[0])
        elif name in ("memset", "__memset_chk"):
            uc.mem_write(args[0], bytes([args[1] & 255]) * args[2])
            ret(args[0])
        elif name in ("malloc", "calloc"):
            size = args[0] * args[1] if name == "calloc" else args[0]
            alloc = heap_next
            heap_next += (size + 15) & -16
            if heap_next > HEAP + 0x400000:
                raise RuntimeError("Synthetic heap exhausted")
            ret(alloc)
        elif name == "free":
            ret(0)
        else:
            raise RuntimeError(f"Unmodelled import {name}")
    except Exception as exc:
        stop(str(exc))


def hook_intr(uc, number, user_data):
    if number != 2:
        stop(f"Unmodelled ARM64 interrupt {number}")
        return
    args = [uc.reg_read(UC_ARM64_REG_X0 + i) for i in range(6)]
    syscall = uc.reg_read(UC_ARM64_REG_X8)
    report["calls"].append(
        {"interrupt": number, "syscall": syscall, "args": [hex(a) for a in args]}
    )
    try:
        uc.reg_write(UC_ARM64_REG_X0, model_syscall(syscall, args))
    except Exception as exc:
        stop(str(exc))


u.hook_add(UC_HOOK_CODE, hook_import, begin=STUBS, end=STUBS + 0xFFFF)
u.hook_add(UC_HOOK_INTR, hook_intr)
recent_blocks = collections.deque(maxlen=16)


def hook_block(uc, address, size, user_data):
    recent_blocks.append((address, size))


u.hook_add(UC_HOOK_BLOCK, hook_block)
try:
    u.emu_start(BASE + tags["DT_INIT"], STOP, timeout=30000000, count=500000000)
    report["pc"] = hex(u.reg_read(UC_ARM64_REG_PC))
    report["returned"] = u.reg_read(UC_ARM64_REG_PC) == STOP
except UcError as exc:
    report["error"] = str(exc)
    report["pc"] = hex(u.reg_read(UC_ARM64_REG_PC))
report["recent_blocks"] = [(hex(a), s) for a, s in recent_blocks]
report["registers"] = {f"x{i}": hex(u.reg_read(UC_ARM64_REG_X0 + i)) for i in range(29)}
report["registers"]["lr"] = hex(u.reg_read(UC_ARM64_REG_LR))
report["code_samples"] = []
for offset in [0x146096C, 0x1460BD4, 0x1460B84]:
    report["code_samples"].append(
        {
            "va": hex(offset),
            "before": original[file_offset(offset) : file_offset(offset) + 32].hex(),
            "after": bytes(u.mem_read(BASE + offset, 32)).hex(),
        }
    )
if report["returned"]:
    (ROOT / "native/libg.initialized-memory.bin").write_bytes(
        bytes(u.mem_read(BASE, image_size))
    )
(ROOT / "native/libg.partial-memory.bin").write_bytes(
    bytes(u.mem_read(BASE, image_size))
)
(ROOT / "inspection/initializer-emulation.json").write_text(
    json.dumps(report, indent=2)
)
print(json.dumps(report, indent=2))
