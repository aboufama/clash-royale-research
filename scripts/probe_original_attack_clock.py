#!/usr/bin/env python3
"""Execute original attack-clock routine on explicit synthetic object fixtures.
No gameplay implementation, imports, return-value stubs, instruction patches,
or running game required. Objects are synthetic and do not prove engine init.
"""

import argparse
import hashlib
import json
import struct
import tomllib
from pathlib import Path
from unicorn import (
    Uc,
    UC_ARCH_ARM64,
    UC_MODE_ARM,
    UC_HOOK_INTR,
    UC_HOOK_CODE,
    UC_PROT_READ,
    UC_PROT_WRITE,
    UC_PROT_EXEC,
)
from unicorn.arm64_const import (
    UC_ARM64_REG_X0,
    UC_ARM64_REG_SP,
    UC_ARM64_REG_LR,
    UC_ARM64_REG_PC,
    UC_ARM64_REG_CPACR_EL1,
)
from audit_asset_pack import private_extraction_root, extraction_target

PIN = "32403dbc667e587a0327d76a92c0f5d562050f185dc42d7b8543103b6cf9882e"
KNIGHT_SHA = "82c000ea05ec5d7e4d344f6153d08a0aca7dc99804666f3c7dce7bb4bf1a44cb"
BASE = 0x10000000
HEAP = 0x30000000
STACK = 0x40000000
# Keep the return sentinel distinct from every canonical import relocation.
STOP = 0x70000000
COMP = HEAP
ACTOR = HEAP + 0x1000
DATA = HEAP + 0x2000
WORLD = HEAP + 0x3000
LEVEL = HEAP + 0x4000
BUFF = HEAP + 0x5000
SLOTS = HEAP + 0x6000
TARGET = HEAP + 0x7000
BUFF_LIST = HEAP + 0x8000


def execute(image, card, case):
    u = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
    u.mem_map(BASE, (len(image) + 4095) & -4096)
    u.mem_write(BASE, image)
    u.mem_protect(BASE, (len(image) + 4095) & -4096, UC_PROT_READ | UC_PROT_EXEC)
    for start, size in [(HEAP, 0x20000), (STACK, 0x10000), (STOP, 4096)]:
        u.mem_map(start, size, UC_PROT_READ | UC_PROT_WRITE)

    def write(addr, fmt, *v):
        u.mem_write(addr, struct.pack("<" + fmt, *v))

    write(COMP + 8, "Q", ACTOR)
    write(COMP + 0x10, "Q", TARGET)
    write(COMP + 0x20, "i", -1)
    write(ACTOR + 0x10, "Q", WORLD)
    write(WORLD + 0x98, "Q", LEVEL)
    write(ACTOR + 0x48, "Q", DATA)
    write(ACTOR + 0x30, "B", 8)
    write(ACTOR + 0x24, "i", 4)
    write(ACTOR + 0x18, "Q", SLOTS)
    write(SLOTS + 0x18, "Q", BUFF)
    write(DATA + 0x418, "i", card["HitSpeed"])
    write(DATA + 0x48C, "i", card["LoadTime"])
    write(COMP + 0x24, "i", case.get("timer", 0))
    write(COMP + 0x28, "i", case.get("load_progress", card["LoadTime"]))
    write(COMP + 0x2C, "i", case.get("delay", 0))
    write(COMP + 0x3E, "B", case.get("flag3e", 0))
    write(COMP + 0x3F, "B", case.get("flag3f", 0))
    write(COMP + 0x40, "B", case.get("flag40", 0))
    write(COMP + 0xAB, "B", case.get("flagab", 0))
    write(LEVEL + 0x1E0, "B", case.get("level_gate", 0))
    modifiers = case.get("modifiers", [])
    write(BUFF + 0x24, "i", len(modifiers))
    write(BUFF + 0x18, "Q", BUFF_LIST)
    for i, modifier in enumerate(modifiers):
        inst = HEAP + 0x9000 + i * 0x200
        buffdata = inst + 0x100
        write(BUFF_LIST + 8 * i, "Q", inst)
        write(inst + 0x18, "Q", buffdata)
        write(buffdata + 0xE0, "i", modifier)
    seen = set()
    interrupts = []

    def trace(u, pc, size, data):
        if not BASE <= pc < BASE + len(image):
            interrupts.append("Execution left the original code image")
            u.emu_stop()
            return
        seen.add(pc - BASE)

    def interrupt(u, n, data):
        interrupts.append(n)
        u.emu_stop()

    u.hook_add(UC_HOOK_CODE, trace)
    u.hook_add(UC_HOOK_INTR, interrupt)
    initial = bytes(u.mem_read(COMP, 0x100))
    states = []

    def state():
        raw = bytes(u.mem_read(COMP, 0x100))
        return {
            "timer_0x24": struct.unpack_from("<i", raw, 0x24)[0],
            "load_progress_0x28": struct.unpack_from("<i", raw, 0x28)[0],
            "delay_0x2c": struct.unpack_from("<i", raw, 0x2C)[0],
            "flag_0x3e": raw[0x3E],
            "flag_0x3f": raw[0x3F],
            "flag_0x40": raw[0x40],
            "flag_0xab": raw[0xAB],
            "raw_component_sha256": hashlib.sha256(raw).hexdigest(),
        }

    start = state()
    for tick in range(case.get("steps", 1)):
        for r, v in [
            (UC_ARM64_REG_X0, COMP),
            (UC_ARM64_REG_SP, STACK + 0x8000),
            (UC_ARM64_REG_LR, STOP),
            (UC_ARM64_REG_CPACR_EL1, 3 << 20),
        ]:
            u.reg_write(r, v)
        u.emu_start(BASE + 0xFC90B0, STOP, count=100000, timeout=1_000_000)
        if u.reg_read(UC_ARM64_REG_PC) != STOP or interrupts:
            raise RuntimeError(
                "Original routine did not return without imports/interrupts: "
                + case["name"]
            )
        states.append(state())
    final = bytes(u.mem_read(COMP, 0x100))
    return {
        "fixture": case,
        "initial": start,
        "steps": states,
        "returned": True,
        "executed_instruction_addresses": len(seen),
        "changed_component_byte_offsets": [
            hex(i) for i, (x, y) in enumerate(zip(initial, final)) if x != y
        ],
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--image", type=Path, required=True)
    p.add_argument("--knight-data", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    output = private_extraction_root(a.out)
    if a.image.stat().st_size != 28217344 or a.knight_data.stat().st_size > 1_000_000:
        raise ValueError("Input exceeds the pinned/bounded size")
    b = a.image.read_bytes()
    sha = hashlib.sha256(b).hexdigest()
    if sha != PIN:
        raise ValueError("Unknown decoded native image")
    asset = a.knight_data.read_bytes()
    if hashlib.sha256(asset).hexdigest() != KNIGHT_SHA:
        raise ValueError(
            "Knight data differs from the pinned decoded install-time asset"
        )
    card = tomllib.loads(asset.decode())["CHARACTER"]["Knight"]
    card = {k: card[k] for k in ["HitSpeed", "LoadTime"]}
    cases = [
        {"name": "ordinary_10_steps", "steps": 10},
        {"name": "initial_load_zero", "load_progress": 0},
        {"name": "existing_timer", "timer": 1190, "steps": 3},
        {
            "name": "level_gate_resets",
            "timer": 500,
            "level_gate": 1,
            "flag3e": 1,
            "flagab": 1,
        },
        {"name": "delay_1", "delay": 1},
        {"name": "delay_75", "delay": 75, "steps": 3},
        {"name": "boundary_flag3f", "timer": 1250, "flag3f": 1},
        {"name": "boundary_flag40", "timer": 1250, "flag40": 1},
        {"name": "haste_150", "modifiers": [150]},
        {"name": "slow_35", "modifiers": [-35]},
        {"name": "haste_and_slow", "modifiers": [150, -35]},
        {"name": "strongest_modifiers", "modifiers": [120, 150, -20, -35]},
        {"name": "full_slow", "timer": 1250, "flag3e": 1, "modifiers": [-100]},
        {"name": "overfull_slow", "timer": 1250, "flag3e": 1, "modifiers": [-150]},
    ]
    report = {
        "schema_version": 1,
        "image_sha256": sha,
        "knight_data_sha256": hashlib.sha256(asset).hexdigest(),
        "native_entry_elf_va": "0xfc90b0",
        "asset_fields": card,
        "fixtures": [execute(b, card, c) for c in cases],
        "limits": "Original attack-clock routine and original callees only; zero function stubs/imports/syscalls/instruction patches. Explicit synthetic component/actor/world/level/buff layouts. This is NOT full initialization, target selection, damage, tower combat, or tick-equivalence validation.",
        "image_policy": "Original image mapped read/execute only; canonical import addresses unmapped. Unknown imports, interrupts, execution outside the original image, or time/instruction limits fail.",
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output = extraction_target(private_extraction_root(output.parent), output.name)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                "entry": report["native_entry_elf_va"],
                "fixtures": [
                    {
                        "name": r["fixture"]["name"],
                        "returned": r["returned"],
                        "first": r["steps"][0],
                        "last": r["steps"][-1],
                    }
                    for r in report["fixtures"]
                ],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
