#!/usr/bin/env python3
"""Execute pinned original ARM64 world ticks on explicit synthetic melee fixtures.

Reports selected fixture state, not full original-game parity. Native code and
assets are supplied privately by the caller and are never bundled by this tool.
"""

import argparse
import collections
import csv
import hashlib
import io
import json
import math
import struct
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def private_output(path, root=ROOT):
    root = Path(root).resolve()
    work = root / "work"
    destination = Path(path).resolve()
    if work.resolve() != work or not destination.is_relative_to(work):
        raise ValueError("Probe output must remain inside repository work/")
    return destination


def bounded_read(path, maximum):
    if not 0 < path.stat().st_size <= maximum:
        raise ValueError("Input file size exceeds the supported bound")
    return path.read_bytes()


def run_probe(a):
    from elftools.elf.elffile import ELFFile
    from unicorn import (
        Uc,
        UcError,
        UC_ARCH_ARM64,
        UC_MODE_ARM,
        UC_PROT_READ,
        UC_PROT_WRITE,
        UC_PROT_EXEC,
        UC_HOOK_CODE,
        UC_HOOK_INTR,
    )
    from unicorn.arm64_const import (
        UC_ARM64_REG_X0,
        UC_ARM64_REG_X3,
        UC_ARM64_REG_TPIDR_EL0,
        UC_ARM64_REG_CPACR_EL1,
        UC_ARM64_REG_PC,
        UC_ARM64_REG_LR,
        UC_ARM64_REG_SP,
    )

    b = bounded_read(a.image, 30_000_000)
    raw = bounded_read(a.library, 30_000_000)
    knight = tomllib.loads(bounded_read(a.knight_data, 100_000).decode("utf-8"))[
        "CHARACTER"
    ]["Knight"]
    EXPECTED_IMAGES = {
        "fc3eab1cf3c15e7a73550445829b4ed50fa20913bf1bca2f7f20af0b07033f12"
    }
    if hashlib.sha256(b).hexdigest() not in EXPECTED_IMAGES:
        raise ValueError("unrecognized canonical tag-initialized image")
    for path, expected in [
        (a.library, "347afc57c8d168bb67d0defa488a89f76297025cac1e8544b5182bb7e70ff433"),
        (
            a.knight_data,
            "82c000ea05ec5d7e4d344f6153d08a0aca7dc99804666f3c7dce7bb4bf1a44cb",
        ),
        (a.globals, "af87c4faf1d965a92a3f3f1b813e683c978c656ed09d041536d0424b0ffd92cd"),
    ]:
        if hashlib.sha256(bounded_read(path, 30_000_000)).hexdigest() != expected:
            raise ValueError("unrecognized pinned input")
    elf = ELFFile(io.BytesIO(raw))
    loads = [s for s in elf.iter_segments() if s["p_type"] == "PT_LOAD"]
    tags = {
        t.entry.d_tag: t.entry.d_val
        for s in elf.iter_segments()
        if s["p_type"] == "PT_DYNAMIC"
        for t in s.iter_tags()
    }

    def off(v):
        for s in loads:
            if s["p_vaddr"] <= v < s["p_vaddr"] + s["p_filesz"]:
                return s["p_offset"] + v - s["p_vaddr"]
        raise ValueError(hex(v))

    names = {}
    for key, sz in [("DT_RELA", "DT_RELASZ"), ("DT_JMPREL", "DT_PLTRELSZ")]:
        for at in range(off(tags[key]), off(tags[key]) + tags[sz], 24):
            target, info, add = struct.unpack_from("<QQq", raw, at)
            if info & 0xFFFFFFFF not in (257, 1025, 1026):
                continue
            ni, _, _, sec, value, _ = struct.unpack_from(
                "<IBBHQQ", raw, off(tags["DT_SYMTAB"]) + (info >> 32) * 24
            )
            if not sec:
                name = raw[off(tags["DT_STRTAB"]) + ni :].split(b"\0", 1)[0].decode()
                dest = struct.unpack_from("<Q", b, target)[0]
                if add != 0 or dest % 16 or not 0x50000000 <= dest < 0x50100000:
                    raise ValueError("noncanonical import relocation")
                if dest in names and names[dest] != name:
                    raise ValueError("conflicting import identity")
                names[dest] = name
    BASE = 0x10000000
    STACK = 0x40000000
    STUB = 0x50000000
    HEAP = 0x60000000
    STOP = 0x70000000
    u = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
    u.mem_map(BASE, (len(b) + 4095) & -4096)
    u.mem_write(BASE, b)
    u.mem_protect(BASE, (len(b) + 4095) & -4096, UC_PROT_READ)
    for segment in loads:
        if segment["p_type"] == "PT_LOAD":
            lo = segment["p_vaddr"] & -4096
            hi = (segment["p_vaddr"] + segment["p_memsz"] + 4095) & -4096
            flags = UC_PROT_READ
            if segment["p_flags"] & 1:
                flags |= UC_PROT_EXEC
            if segment["p_flags"] & 2:
                flags |= UC_PROT_WRITE
            u.mem_protect(BASE + lo, hi - lo, flags)
    for addr, size in [
        (STACK, 0x400000),
        (STUB, 0x100000),
        (HEAP, 0x1000000),
        (STOP, 4096),
    ]:
        u.mem_map(
            addr,
            size,
            (
                UC_PROT_READ | UC_PROT_EXEC
                if addr in (STUB, STOP)
                else UC_PROT_READ | UC_PROT_WRITE
            ),
        )
    for reg, val in [(UC_ARM64_REG_TPIDR_EL0, HEAP), (UC_ARM64_REG_CPACR_EL1, 3 << 20)]:
        u.reg_write(reg, val)
    nxt = HEAP + 0x100000
    allocs = {}
    freed = set()
    calls = []
    stopreason = None

    def alloc(size):
        nonlocal nxt
        if not 0 <= size <= 0x1000000:
            raise ValueError("allocation exceeds modeled size bound")
        addr = nxt
        nxt += (max(1, size) + 15) & -16
        if nxt > HEAP + 0x1000000:
            raise ValueError("allocator limit")
        allocs[addr] = size
        return addr

    def memory_extent(addr, length, write=False):
        if not 0 <= length <= 0x1000000:
            raise ValueError("memory primitive length exceeds bounds")
        regions = [(STACK, 0x400000), (HEAP, 0x1000000)]
        if not write:
            regions.append((BASE, len(b)))
        if not any(
            start <= addr and addr + length <= start + size for start, size in regions
        ):
            raise ValueError("memory primitive crosses modeled bounds")

    def import_hook(u, pc, size, data):
        nonlocal stopreason
        x, y, z = [u.reg_read(UC_ARM64_REG_X0 + i) for i in range(3)]
        name = names.get(pc)
        calls.append({"name": name, "args": [hex(x), hex(y), hex(z)]})
        try:
            if name in ("malloc", "_Znwm", "_Znam"):
                ret = alloc(x)
            elif name in ("free", "_ZdlPv", "_ZdaPv"):
                if x and (x not in allocs or x in freed):
                    raise ValueError("invalid or repeated native free")
                if x:
                    freed.add(x)
                ret = 0
            elif name in ("memset", "__memset_chk"):
                memory_extent(x, z, True)
                if name.endswith("_chk") and z > u.reg_read(UC_ARM64_REG_X3):
                    raise ValueError("checked memset overflow")
                if z:
                    u.mem_write(x, bytes([y & 255]) * z)
                ret = x
            elif name in ("memcpy", "memmove", "__memcpy_chk", "__memmove_chk"):
                memory_extent(x, z, True)
                memory_extent(y, z)
                if name.endswith("_chk") and z > u.reg_read(UC_ARM64_REG_X3):
                    raise ValueError("checked memory copy overflow")
                if z:
                    u.mem_write(x, bytes(u.mem_read(y, z)))
                ret = x
            elif name == "_ZNSt6__ndk112__next_primeEm":
                import math

                if not 2 <= x <= 100000:
                    raise ValueError(
                        "next_prime argument outside verified bounded domain"
                    )
                ret = x
                while any(ret % d == 0 for d in range(2, math.isqrt(ret) + 1)):
                    ret += 1
            else:
                raise ValueError("unmodeled import " + str(name))
            u.reg_write(UC_ARM64_REG_X0, ret & 0xFFFFFFFFFFFFFFFF)
            u.reg_write(UC_ARM64_REG_PC, u.reg_read(UC_ARM64_REG_LR))
        except Exception as ex:
            stopreason = str(ex)
            u.emu_stop()

    def intr(u, n, data):
        nonlocal stopreason
        stopreason = "target interrupt " + str(n)
        u.emu_stop()

    u.hook_add(UC_HOOK_CODE, import_hook, begin=STUB, end=STUB + 0xFFFFF)

    def assert_stop(u, pc, size, data):
        nonlocal stopreason
        stopreason = "assertion LR=" + hex(u.reg_read(UC_ARM64_REG_LR))
        u.emu_stop()

    u.hook_add(UC_HOOK_CODE, assert_stop, begin=BASE + 0x128DF18, end=BASE + 0x128DF18)
    u.hook_add(UC_HOOK_INTR, intr)
    watched = {
        0xF8CD90: "world_tick",
        0xFC7E20: "attack_tick",
        0xFC619C: "attack_execute",
        0xFC7080: "melee_execute",
        0xFCA3D4: "damage_enqueue",
        0xFD08CC: "damage_flush",
        0xFCAEEC: "damage_apply",
        0xFCB29C: "hp_application",
        0xF800BC: "actor_tick",
        0xFC99E0: "health_tick",
    }
    visited = collections.Counter()

    def trace_entry(u, pc, size, va):
        visited[watched[va]] += 1

    for va in watched:
        u.hook_add(
            UC_HOOK_CODE, trace_entry, user_data=va, begin=BASE + va, end=BASE + va
        )

    def invoke(va, args):
        nonlocal stopreason
        stopreason = None
        for i in range(29):
            u.reg_write(UC_ARM64_REG_X0 + i, 0)
        for i, value in enumerate(args):
            u.reg_write(UC_ARM64_REG_X0 + i, value & 0xFFFFFFFFFFFFFFFF)
        u.reg_write(UC_ARM64_REG_SP, STACK + 0x200000)
        u.reg_write(UC_ARM64_REG_LR, STOP)
        try:
            u.emu_start(BASE + va, STOP, timeout=1000000, count=2000000)
        except UcError as ex:
            stopreason = str(ex)
        if stopreason or u.reg_read(UC_ARM64_REG_PC) != STOP:
            raise ValueError(
                f"0x{va:x} stopped at {u.reg_read(UC_ARM64_REG_PC):x}: {stopreason}"
            )
        return u.reg_read(UC_ARM64_REG_X0)

    def write32(addr, val):
        u.mem_write(addr, struct.pack("<I", val & 0xFFFFFFFF))

    def write64(addr, val):
        u.mem_write(addr, struct.pack("<Q", val))

    def q(addr):
        return struct.unpack("<Q", u.mem_read(addr, 8))[0]

    def word(addr):
        return struct.unpack("<i", u.mem_read(addr, 4))[0]

    report = {
        "scenario": a.scenario,
        "image_sha256": hashlib.sha256(b).hexdigest(),
        "library_sha256": hashlib.sha256(raw).hexdigest(),
        "knight_sha256": hashlib.sha256(a.knight_data.read_bytes()).hexdigest(),
    }
    (
        actor,
        chardata,
        world,
        level,
        datacontext,
        tables,
        globalsdata,
        observer,
        matchcontext,
        matchobserver,
        health,
        buff,
        componentarray,
        event,
    ) = [HEAP + i * 0x1000 for i in range(16, 30)]
    write64(chardata + 0x10, datacontext)
    write64(datacontext + 0x78, tables)
    write64(tables + 0x18, globalsdata)
    write64(world + 0x98, level)
    write64(level + 8, matchcontext)
    write64(level + 0x20, tables)
    write64(matchcontext + 0xB0, matchobserver)
    write64(globalsdata + 0x180, observer)
    write32(chardata + 0x7A8, knight["Hitpoints"])
    write32(
        chardata + 0x40, 1
    )  # Synthetic nonzero data-record ID, required by original assertion
    handlepool, queue = HEAP + 0x30000, HEAP + 0x31000
    source, sourcehealth, sourcebuff, attack = (
        HEAP + 0x32000,
        HEAP + 0x33000,
        HEAP + 0x34000,
        HEAP + 0x35000,
    )
    sequence_index, sequence_ptrs, sequence = (
        HEAP + 0x36000,
        HEAP + 0x37000,
        HEAP + 0x38000,
    )
    write32(chardata + 0x3D4, 1)
    write64(chardata + 0x3C8, sequence_index)
    write64(chardata + 0x2A8, sequence_ptrs)
    write64(
        sequence_ptrs, sequence
    )  # Explicit single synthetic attack-sequence fixture
    write32(sequence + 0xE8, 100)
    write32(chardata + 0x420, knight["Range"])
    write32(chardata + 0x434, knight["SightRange"])
    u.mem_write(chardata + 0x58A, bytes([knight["AttacksGround"]]))
    write32(chardata + 0x7B0, knight["Damage"])
    write32(chardata + 0x418, knight["HitSpeed"])
    write32(chardata + 0x48C, knight["LoadTime"])
    if a.scenario == "shield":
        write32(
            chardata + 0x7AC, 100
        )  # Explicit synthetic shield input for separate case
    write64(world + 0x68, matchcontext)
    write64(world + 0xB0, handlepool)
    cfg = {
        r["Name"]: r
        for r in csv.DictReader(
            io.StringIO(bounded_read(a.globals, 1_000_000).decode("utf-8"))
        )
    }
    controller, arena, grid, eventbus = (
        HEAP + 0x3A000,
        HEAP + 0x3B000,
        HEAP + 0x3C000,
        HEAP + 0x3D000,
    )
    write64(arena + 0x98, grid)
    write32(arena + 0xA8, 5)
    write32(arena + 0xAC, 5)
    write64(level + 0x10, controller)
    write64(level + 0xC0, arena)
    write32(level + 0x188, 5)
    write32(level + 0x18C, 5)
    for offset, key in [
        (0x7C0, "NEW_PATHFINDING_CODE"),
        (0x7C1, "PATHFINDING_DYNAMIC_OCCLUSIONS"),
        (0x7C2, "PATHFINDING_REFRESH_OPENNODES"),
        (0x7C3, "PATHFINDING_REOPEN_CLOSEDNODES"),
        (0x7E8, "PATHFINDING_FRIENDLYONLY_OCCLUSIONS"),
    ]:
        u.mem_write(globalsdata + offset, bytes([cfg[key]["BooleanValue"] == "TRUE"]))
    for offset, key in [
        (0x7C4, "PATHFINDING_DEFAULT_COST"),
        (0x7C8, "PATHFINDING_ROAD_COST"),
        (0x7CC, "PATHFINDING_MATCHINGROAD_COST"),
        (0x7D0, "PATHFINDING_BLOCKED_COST"),
        (0x7D4, "PATHFINDING_BUILDING_COST"),
        (0x7D8, "PATHFINDING_DEFAULTHEURISTIC_COST"),
        (0x7DC, "PATHFINDING_WATER_COST"),
        (0x7E0, "PATHFINDING_HEURISTIC_METHOD"),
        (0x7E4, "PATHFINDING_SAMEPATH_EPSILON"),
    ]:
        write32(globalsdata + offset, int(cfg[key]["NumberValue"]))
    try:
        invoke(0xD5A27C, [eventbus])
        write64(level + 0x330, eventbus)
        invoke(0x11D8778, [controller, level, arena])
        invoke(0xFD3F50, [observer])
        invoke(0x10C94F8, [matchobserver])
        write64(matchcontext + 0x208, tables)
        invoke(0xF961F0, [world, matchcontext])
        write64(world + 0x98, level)
        invoke(0xF97964, [world, level])
        team_module = HEAP + 0x39000
        invoke(0xD556C0, [team_module, level])
        write64(level + 0x348, team_module)
        invoke(0xF7DF40, [actor, chardata])
        invoke(0xF8915C, [actor, world])
        invoke(0xFC0500, [buff, 0, actor])
        invoke(0xFC96F4, [health, actor])
        report["constructor_state"] = {
            "actor_vtable": hex(q(actor)),
            "health_vtable": hex(q(health)),
            "hp": word(health + 0x10),
            "maxhp": word(health + 0x14),
            "shield": word(health + 0x2C),
            "buff_stats": [word(buff + i) for i in range(0x30, 0x40, 4)],
        }
        invoke(0xF89164, [actor, health])
        invoke(0xF89164, [actor, buff])
        queue = invoke(0xF9922C, [world])
        invoke(0xF7DF40, [source, chardata])
        invoke(0xF8915C, [source, world])
        invoke(0xFC96F4, [sourcehealth, source])
        invoke(0xFC0500, [sourcebuff, 0, source])
        invoke(0xFC2FA4, [attack, source])
        invoke(0xF89164, [source, sourcehealth])
        invoke(0xF89164, [source, sourcebuff])
        if a.scenario != "unattached_attack":
            invoke(0xF89164, [source, attack])
        invoke(0xF94050, [source, 0])
        invoke(0xF94050, [actor, 1])
        invoke(0xF8C50C, [world, actor, 0, 1])
        invoke(0xF8C50C, [world, source, 0, 1])
        invoke(0xFC3CB4, [attack, actor, 0, 0, 0])
        before = len(calls)
        report["ticks"] = []
        frame_count = 80
        for tick in range(frame_count):
            write32(matchcontext + 0x60, tick)
            invoke(0xF8CD90, [world, tick])
            report["ticks"].append(
                {
                    "tick": tick,
                    "attack_timer": word(attack + 0x24),
                    "pending_damage": word(health + 0x28),
                    "queued_events": word(queue + 0x20),
                    "target_hp": word(health + 0x10),
                    "target_shield": word(health + 0x2C),
                    "source_state": word(source + 0x11C),
                    "target_state": word(actor + 0x11C),
                    "actor_count": word(world + 0x14),
                    "attack_calls": visited["attack_execute"],
                    "damage_applies": visited["damage_apply"],
                }
            )
        report["completed"] = True
        report["final_state"] = report["ticks"][-1]
        report["imports_during_ticks"] = dict(
            collections.Counter(c["name"] for c in calls[before:])
        )
    except Exception as ex:
        report["error"] = str(ex)
        report["registers"] = {
            f"x{i}": hex(u.reg_read(UC_ARM64_REG_X0 + i)) for i in range(29)
        }
    report.setdefault("completed", False)
    report["globals_sha256"] = hashlib.sha256(a.globals.read_bytes()).hexdigest()
    report["original_entry_counts"] = dict(visited)
    report["native_entries"] = {label: hex(va) for va, label in watched.items()}
    report["scope"] = (
        "Original native world loop, actor/component registration, attack target setter and target policy, clock, melee event, damage queue and health application on explicit synthetic fixture inputs. No battle equivalence claim."
    )
    report["fixture_limits"] = [
        "Character data fields materialized from pinned Knight TOML; original data parser and full record initialization not executed",
        "Synthetic nonzero data-record ID 1; single synthetic sequence record with timing field +0xe8=100 and all other fields zero",
        "Initial target supplied through original native setter; autonomous target acquisition not established",
        "Synthetic empty 5x5 arena and context; only pathfinding globals materialized from shipped globals CSV; other globals zero",
        "Original tag registry initialized in input image; original native constructors used for actors, attack/health/buff components, observers, world, eventbus, handlepool, spatial index, pathcontroller and team module",
        "Scenario shield changes parsed shield HP to 100 as an explicit synthetic input; unattached_attack omits only native attack-component attachment, so original world slot iteration has no attack component",
        "Only selected state fields are recorded; this report is not complete per-tick state/event coverage",
        "Single-threaded bump allocation, memory primitives and bounded standard next-prime helper are modeled; target assertions, unknown imports and syscalls fail closed",
    ]
    text_regions = [(s["p_vaddr"], s["p_filesz"]) for s in loads if s["p_flags"] & 1]
    report["code_integrity"] = [
        {
            "start": hex(start),
            "length": size,
            "before_sha256": hashlib.sha256(b[start : start + size]).hexdigest(),
            "after_sha256": hashlib.sha256(
                bytes(u.mem_read(BASE + start, size))
            ).hexdigest(),
            "unchanged": b[start : start + size]
            == bytes(u.mem_read(BASE + start, size)),
        }
        for start, size in text_regions
    ]
    report["hooks"] = [
        "Import hook implements listed standard primitives and returns to original LR",
        "Entry hooks count selected original native routine invocations without modifying machine state",
        "Assertion hook stops before original failure-report routine; no assertion bypass",
        "Interrupt hook stops on any target syscall/interrupt",
    ]
    report["imports_summary"] = dict(collections.Counter(c["name"] for c in calls))
    report["pc"] = hex(u.reg_read(UC_ARM64_REG_PC))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("image", "library", "knight-data", "globals", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument(
        "--scenario",
        choices=("baseline", "shield", "unattached_attack"),
        default="baseline",
    )
    args = parser.parse_args()
    try:
        args.out = private_output(args.out)
        args.out.mkdir(parents=True, exist_ok=True)
        if (args.out / "report.json").is_symlink():
            raise ValueError("Output report must not be a symlink")
        report = run_probe(args)
    except (ValueError, OSError, KeyError, struct.error) as error:
        print(
            json.dumps(
                {"completed": False, "error": type(error).__name__ + ": " + str(error)}
            )
        )
        return 1
    (args.out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {key: value for key, value in report.items() if key != "ticks"}, indent=2
        )
    )
    return (
        0
        if report["completed"]
        and all(item["unchanged"] for item in report["code_integrity"])
        else 1
    )


if __name__ == "__main__":
    raise SystemExit(main())
