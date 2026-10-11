#!/usr/bin/env python3
"""Run every shipped logic TOML asset through the pinned original ARM64 parser.

This establishes parser execution, not complete typed data loading or battle
equivalence. The native tree remains in a live emulator. Memory/string/libc
models are explicit; unknown operations stop execution. No assets are bundled.
"""

import argparse
from collections import Counter
import json
from pathlib import Path
import time
import zipfile

from initialize_original_tags import ParserProbe
from native_decimal import decimal_to_binary64
from probe_original_pathfinding import (
    ASSET_PACK_SHA,
    IMAGE_SHA,
    LIBRARY_SHA,
    TEXT_SHA,
    TEXT_SIZE,
    TEXT_START,
    NativeProbeError,
    pinned_file,
    private_output,
    sha,
)
from sc_lzma import decode


class TomlProbe(ParserProbe):
    def __init__(self, image, library):
        self.decimal_conversions = Counter()
        super().__init__(image, library)

    def _import_hook(self, uc, pc, size, data):
        name = self.names.get(pc)
        if name not in ("strnlen", "__strlen_chk", "atof"):
            return super()._import_hook(uc, pc, size, data)
        self.extra_calls[name] += 1
        r = self.reg
        address, bound = (uc.reg_read(r.UC_ARM64_REG_X0 + i) for i in range(2))
        try:
            if name == "atof":
                if uc.reg_read(r.UC_ARM64_REG_FPCR) != 0:
                    raise NativeProbeError("Nondefault FPCR requires original libc")
                literal = self.cstring(address, limit=129)
                bits = decimal_to_binary64(literal)
                self.decimal_conversions[(literal.decode("ascii"), hex(bits))] += 1
                uc.reg_write(r.UC_ARM64_REG_D0, bits)
            elif name == "strnlen":
                if bound > 1_048_576:
                    raise NativeProbeError("strnlen exceeds bounded domain")
                length = 0
                while length < bound and uc.mem_read(address + length, 1)[0]:
                    length += 1
                uc.reg_write(r.UC_ARM64_REG_X0, length)
            else:
                length = len(self.cstring(address))
                if length >= bound:
                    raise NativeProbeError("Original checked strlen exceeds bound")
                uc.reg_write(r.UC_ARM64_REG_X0, length)
            uc.reg_write(r.UC_ARM64_REG_PC, uc.reg_read(r.UC_ARM64_REG_LR))
        except Exception as error:
            self.stop_reason = str(error)
            uc.emu_stop()


def parse_original_toml(engine, raw):
    """Return native tree and diagnostics, retaining all original heap objects."""
    if len(raw) > 2_000_000:
        raise ValueError("TOML input exceeds bounded size")
    if not getattr(engine, "toml_static_initialized", False):
        engine.invoke(0x12A86FC, [])
        engine.toml_static_initialized = True
    text = engine.make_string(raw)
    errors = []
    callback = engine.STOP + 0x100
    vtable = engine.allocate(8)
    engine.write64(vtable, callback)
    observer = engine.allocate(8)
    engine.write64(observer, vtable)

    def on_error(uc, pc, size, data):
        errors.append(
            engine.string(uc.reg_read(engine.reg.UC_ARM64_REG_X1)).decode("utf-8")
        )
        uc.reg_write(
            engine.reg.UC_ARM64_REG_PC, uc.reg_read(engine.reg.UC_ARM64_REG_LR)
        )

    hook = engine.u.hook_add(
        engine.unicorn.UC_HOOK_CODE, on_error, begin=callback, end=callback
    )
    try:
        tree = engine.invoke(0x12A6E64, [text, observer])
    finally:
        engine.u.hook_del(hook)
    return tree, errors


def probe_one(image, library, raw):
    engine = TomlProbe(image, library)
    started = time.monotonic()
    report = {"decoded_sha256": sha(raw), "decoded_bytes": len(raw)}
    try:
        tree, errors = parse_original_toml(engine, raw)
        report.update(
            returned=True, nonnull_tree=bool(tree), error_callbacks=len(errors)
        )
        # Diagnostic strings are retained only in private command output files.
        report["errors_private"] = errors
        if tree:
            report["root_vtable_va"] = hex(engine.pointer(tree) - engine.BASE)
    except Exception as error:
        report.update(returned=False, nonnull_tree=False, error=str(error))
    after = bytes(engine.u.mem_read(engine.BASE + TEXT_START, TEXT_SIZE))
    report["text_unchanged"] = sha(after) == TEXT_SHA
    report["success"] = (
        report["returned"]
        and report["nonnull_tree"]
        and report.get("error_callbacks") == 0
        and report["text_unchanged"]
    )
    report["imports"] = dict(engine.import_calls + engine.extra_calls)
    report["decimal_conversions"] = [
        {"literal": literal, "binary64_bits": bits, "calls": count}
        for (literal, bits), count in sorted(engine.decimal_conversions.items())
    ]
    report["elapsed_seconds"] = round(time.monotonic() - started, 4)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("image", "library", "asset-pack", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument(
        "--asset", help="One exact csv_logic-relative asset name; default tests all 297"
    )
    args = parser.parse_args()
    try:
        output = private_output(args.out)
        output.mkdir(parents=True, exist_ok=True)
        if (output / "report.json").is_symlink():
            raise ValueError("Output report must not be a symlink")
        image = pinned_file(args.image, IMAGE_SHA, 29_000_000)
        library = pinned_file(args.library, LIBRARY_SHA, 29_000_000)
        pinned_file(args.asset_pack, ASSET_PACK_SHA, 1_000_000_000, read=False)
        rows = []
        with zipfile.ZipFile(args.asset_pack) as archive:
            names = sorted(
                name
                for name in archive.namelist()
                if name.startswith("assets/csv_logic/") and name.endswith(".toml")
            )
            if len(names) != 297:
                raise ValueError("Pinned TOML corpus membership differs")
            if args.asset:
                selected = "assets/csv_logic/" + args.asset
                if selected not in names:
                    raise ValueError(
                        "Requested asset is outside the pinned TOML corpus"
                    )
                names = [selected]
            for index, name in enumerate(names):
                packed = archive.read(name)
                raw = decode(packed, max_output=2_000_000)
                row = probe_one(image, library, raw)
                row.update(
                    asset=name.removeprefix("assets/csv_logic/"),
                    packed_sha256=sha(packed),
                )
                rows.append(row)
                if not row["success"] or (index + 1) % 25 == 0:
                    print(
                        json.dumps(
                            {
                                "completed": index + 1,
                                "total": len(names),
                                "success": row["success"],
                            }
                        ),
                        flush=True,
                    )
        report = {
            "image_sha256": sha(image),
            "library_sha256": sha(library),
            "asset_pack_sha256": ASSET_PACK_SHA,
            "corpus_count": 297,
            "tested": len(rows),
            "success_count": sum(row["success"] for row in rows),
            "all_tested_text_unchanged": all(row["text_unchanged"] for row in rows),
            "scope": "Original TOML parsing with a fresh emulator per asset. Nonnull trees and zero error callbacks do not establish fully loaded gameplay data or battle equivalence.",
            "runtime_models": [
                "Bounded allocator, memory and ASCII string primitives; exit callbacks are recorded only",
                "Standard next-prime helper restricted to the exercised bounded domain",
                "atof: exact-rational decimal to nearest-even normal binary64, default FPCR only; original Bionic implementation is not executed",
                "Error observer records original messages and returns; unknown formatting imports still stop execution",
            ],
            "rows": rows,
        }
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({k: v for k, v in report.items() if k != "rows"}), flush=True)
        return 0 if report["success_count"] == report["tested"] else 1
    except (ValueError, OSError, NativeProbeError) as error:
        print(json.dumps({"completed": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
