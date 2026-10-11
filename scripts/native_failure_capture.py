"""Private read-only post-failure diagnostics; never a VM restore mechanism.

Call only after emulation has stopped. Dumped guest memory can include protected
code/assets and must stay under ignored private work paths. No guest function,
mapping, register write, or failed-engine resumption is performed here.
"""

import hashlib
import json
from pathlib import Path
import zlib


def capture_failure(engine, error, output_directory, *, dump_memory=True):
    guard = getattr(engine, "native_import_data_guard", None)
    if guard is not None and guard.depth:
        raise ValueError("Failure capture requires stopped top-level emulation")
    destination = Path(output_directory)
    destination.mkdir(parents=True, exist_ok=True)
    if (destination / "report-private.json").exists():
        raise ValueError("Refusing to overwrite an existing failure capsule")
    uc, reg = engine.u, engine.reg
    regions = sorted(uc.mem_regions())
    names = ["X" + str(index) for index in range(31)] + [
        "SP",
        "PC",
        "NZCV",
        "FPCR",
        "FPSR",
        "TPIDR_EL0",
        "TPIDRRO_EL0",
    ]
    registers = {}
    register_errors = {}
    for name in names:
        try:
            registers[name] = uc.reg_read(getattr(reg, "UC_ARM64_REG_" + name))
        except Exception as failure:
            register_errors[name] = str(failure)

    def window(address, before=0, length=128):
        region = next(
            (
                (low, high, flags)
                for low, high, flags in regions
                if low <= address <= high
            ),
            None,
        )
        if region is None:
            return {"address": hex(address), "mapped": False}
        low, high, permissions = region
        start = max(low, address - before)
        count = min(length, high + 1 - start)
        result = {
            "address": hex(address),
            "mapped": True,
            "start": hex(start),
            "bytes_requested": count,
            "permissions": permissions,
        }
        try:
            result["bytes_hex"] = bytes(uc.mem_read(start, count)).hex()
        except Exception as failure:
            result["read_error"] = str(failure)
        return result

    report = {
        "scope": "Post-failure guest diagnostics and optional raw mapped memory; "
        "private original inputs may be present. Not complete VM state, "
        "a rollback, a reset snapshot, or authorization to resume a failed engine.",
        "error": str(error),
        "stop_reason": getattr(engine, "stop_reason", None),
        "registers": {name: hex(value) for name, value in registers.items()},
        "register_errors": register_errors,
        "pointer_windows": {
            name: window(value, before=32, length=160)
            for name, value in registers.items()
            if name.startswith("X")
        },
        "stack": window(registers["SP"], length=4096) if "SP" in registers else None,
        "frames": [],
        "regions": [],
    }
    frame = registers.get("X29", 0)
    seen = set()
    for _ in range(64):
        if not frame or frame in seen:
            report["frame_chain_stop"] = "null" if not frame else "cycle"
            break
        seen.add(frame)
        item = window(frame, length=16)
        report["frames"].append(item)
        raw_hex = item.get("bytes_hex", "")
        if len(raw_hex) != 32:
            report["frame_chain_stop"] = "unreadable_or_crossing_region"
            break
        raw = bytes.fromhex(raw_hex)
        frame, return_address = int.from_bytes(raw[:8], "little"), int.from_bytes(
            raw[8:], "little"
        )
        item["previous_frame"] = hex(frame)
        item["saved_return_address"] = hex(return_address)
    else:
        report["frame_chain_stop"] = "bounded_at_64_frames"
    for index, (low, high, permissions) in enumerate(regions):
        entry = {
            "start": hex(low),
            "end_inclusive": hex(high),
            "bytes": high + 1 - low,
            "permissions": permissions,
        }
        report["regions"].append(entry)
        if not dump_memory:
            continue
        name = f"region-{index:02d}-{low:016x}.zlib"
        compressor = zlib.compressobj(level=1)
        digest = hashlib.sha256()
        try:
            with (destination / name).open("xb") as stream:
                for start in range(low, high + 1, 1 << 20):
                    raw = bytes(uc.mem_read(start, min(1 << 20, high + 1 - start)))
                    digest.update(raw)
                    stream.write(compressor.compress(raw))
                stream.write(compressor.flush())
            entry.update(
                file=name,
                sha256=digest.hexdigest(),
                compressed_bytes=(destination / name).stat().st_size,
            )
        except Exception as failure:
            entry["capture_error"] = str(failure)
    path = destination / "report-private.json"
    path.write_text(json.dumps(report, indent=2) + "\n")
    return report
