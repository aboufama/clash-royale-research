#!/usr/bin/env python3
"""Reproduce ELF relocation and direct pointer-reference analysis; no target execution."""

import argparse, hashlib, json, struct
from pathlib import Path
from elftools.elf.elffile import ELFFile
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN
from capstone.arm64 import ARM64_OP_REG, ARM64_OP_IMM, ARM64_OP_MEM

p = argparse.ArgumentParser()
p.add_argument("library", type=Path)
p.add_argument("--out", type=Path, default=Path("work/builds/160402020/static-trace"))
a = p.parse_args()
a.out.mkdir(parents=True, exist_ok=True)
data = a.library.read_bytes()
f = a.library.open("rb")
elf = ELFFile(f)
segs = [s for s in elf.iter_segments() if s["p_type"] == "PT_LOAD"]


def off(va):
    for s in segs:
        if s["p_vaddr"] <= va < s["p_vaddr"] + s["p_filesz"]:
            return s["p_offset"] + va - s["p_vaddr"]
    raise ValueError(hex(va))


def read(va, size):
    return data[off(va) : off(va) + size]


tags = {
    t.entry.d_tag: t.entry.d_val
    for s in elf.iter_segments()
    if s["p_type"] == "PT_DYNAMIC"
    for t in s.iter_tags()
}
syms = []
# Symbol count sufficient through highest relocation, not a heuristic scan.
relocs = []
for key, size in [("DT_RELA", "DT_RELASZ"), ("DT_JMPREL", "DT_PLTRELSZ")]:
    if key in tags:
        for pos in range(0, tags[size], 24):
            dst, info, add = struct.unpack("<QQq", read(tags[key] + pos, 24))
            idx = info >> 32
            typ = info & 0xFFFFFFFF
            namepos, info2, other, shndx, value, ssize = struct.unpack(
                "<IBBHQQ", read(tags["DT_SYMTAB"] + idx * 24, 24)
            )
            name = (
                read(tags["DT_STRTAB"] + namepos, 1024)
                .split(b"\0")[0]
                .decode(errors="replace")
            )
            relocs.append(
                dict(
                    address=hex(dst),
                    type=typ,
                    symbol=name,
                    index=idx,
                    addend=hex(add),
                    symbol_value=hex(value),
                )
            )
relby = {int(r["address"], 16): r for r in relocs}
interesting = range(0x6ACE00, 0x6ACE40, 8)
focus = [
    r
    for r in relocs
    if int(r["address"], 16) in interesting
    or 0x6C6400 <= int(r["address"], 16) < 0x6C6550
]
init_array = []
for pos in range(0, tags.get("DT_INIT_ARRAYSZ", 0), 8):
    va = tags["DT_INIT_ARRAY"] + pos
    r = relby.get(va)
    init_array.append(
        {
            "slot": hex(va),
            "raw": hex(struct.unpack("<Q", read(va, 8))[0]),
            "relocation": r,
        }
    )
cs = Cs(CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN)
cs.detail = True
cs.skipdata = True
# Track direct ADR/ADRP/address arithmetic without trusting flow across branches.
refs = []
allins = []
regs = {}
for s in segs:
    if not s["p_flags"] & 1:
        continue
    for ins in cs.disasm(s.data(), s["p_vaddr"]):
        allins.append((ins.address, ins.mnemonic, ins.op_str))
        if ins.id == 0:
            regs = {}
            continue
        ops = ins.operands
        before = regs.copy()
        try:
            _, writes = ins.regs_access()
            for reg in writes:
                regs.pop(reg, None)
        except Exception:
            pass
        if ins.mnemonic in ("adr", "adrp") and len(ops) == 2:
            regs[ops[0].reg] = ops[1].imm
        elif (
            ins.mnemonic == "add"
            and len(ops) == 3
            and ops[1].type == ARM64_OP_REG
            and ops[2].type == ARM64_OP_IMM
            and ops[1].reg in before
        ):
            regs[ops[0].reg] = before[ops[1].reg] + ops[2].imm
        elif ins.mnemonic == "mov" and len(ops) == 2:
            if ops[1].type == ARM64_OP_REG and ops[1].reg in before:
                regs[ops[0].reg] = before[ops[1].reg]
            elif ops[1].type == ARM64_OP_IMM:
                regs[ops[0].reg] = ops[1].imm
        for op in ops:
            if op.type == ARM64_OP_MEM and op.mem.base in before and op.mem.index == 0:
                va = before[op.mem.base] + op.mem.disp
                if 0x6C6400 <= va < 0x6C6550 or va in interesting:
                    refs.append(
                        {
                            "pc": hex(ins.address),
                            "instruction": ins.mnemonic + " " + ins.op_str,
                            "referent": hex(va),
                            "relocation": relby.get(va),
                        }
                    )
                if (
                    ins.mnemonic == "ldr"
                    and ops[0].type == ARM64_OP_REG
                    and op == ops[-1]
                ):
                    r = relby.get(va)
                    if r and r["type"] == 1027:
                        regs[ops[0].reg] = int(r["addend"], 16)
        if (
            ins.mnemonic in ("b", "br", "ret", "blr", "bl")
            or ins.mnemonic.startswith("b.")
            or ins.mnemonic in ("cbz", "cbnz", "tbz", "tbnz")
        ):
            regs = {}
report = {
    "library": a.library.name,
    "sha256": hashlib.sha256(data).hexdigest(),
    "tags": {k: hex(v) for k, v in tags.items()},
    "focus_relocations": focus,
    "init_array": init_array,
    "direct_references": refs,
}
(a.out / "callback-trace.json").write_text(json.dumps(report, indent=2))
with (a.out / "constructor-disassembly.txt").open("w") as out:
    for addr, mn, op in allins:
        if 0x65CC00 <= addr <= 0x682500:
            out.write(f"{addr:08x} {mn:10} {op}\n")
print(
    json.dumps(
        {"focus_relocations": focus, "init_array": init_array, "references": refs},
        indent=2,
    )
)
