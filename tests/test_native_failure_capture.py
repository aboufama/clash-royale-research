"""Synthetic failed-state retention; no original code or assets."""

import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import sys
import unittest
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
try:
    import unicorn
    from unicorn import arm64_const as reg
except ImportError:
    unicorn = None
    reg = None
from native_failure_capture import capture_failure


@unittest.skipUnless(
    unicorn is not None, "Unicorn is required for synthetic failure controls"
)
class FailureCaptureTests(unittest.TestCase):
    def engine(self):
        uc = unicorn.Uc(unicorn.UC_ARCH_ARM64, unicorn.UC_MODE_ARM)
        uc.mem_map(0x100000, 0x1000)
        uc.mem_map(0x200000, 0x1000)
        uc.mem_write(0x100000, bytes.fromhex("020040f9"))
        uc.reg_write(reg.UC_ARM64_REG_X0, 0x8C)
        uc.reg_write(reg.UC_ARM64_REG_SP, 0x200040)
        uc.reg_write(reg.UC_ARM64_REG_X29, 0x200080)
        uc.mem_write(
            0x200080,
            (0x2000C0).to_bytes(8, "little") + (0x100104).to_bytes(8, "little"),
        )
        uc.mem_write(0x2000C0, bytes(8) + (0x100208).to_bytes(8, "little"))
        engine = SimpleNamespace(u=uc, reg=reg, stop_reason=None)
        try:
            uc.emu_start(0x100000, 0x100004, count=1)
        except unicorn.UcError as error:
            return engine, error
        raise AssertionError("Synthetic unmapped read did not fail")

    def test_failed_registers_memory_and_frames_are_retained_without_writes(self):
        engine, error = self.engine()
        uc = engine.u
        original = [
            (low, high, permissions, bytes(uc.mem_read(low, high + 1 - low)))
            for low, high, permissions in uc.mem_regions()
        ]
        registers = {
            name: uc.reg_read(getattr(reg, "UC_ARM64_REG_" + name))
            for name in ["X0", "X29", "PC", "SP", "NZCV"]
        }
        with tempfile.TemporaryDirectory() as directory:
            result = capture_failure(engine, error, directory)
            self.assertEqual(result["registers"]["X0"], "0x8c")
            self.assertFalse(result["pointer_windows"]["X0"]["mapped"])
            self.assertEqual(result["registers"]["PC"], "0x100000")
            self.assertEqual(
                [x["saved_return_address"] for x in result["frames"]],
                ["0x100104", "0x100208"],
            )
            self.assertEqual(result["frame_chain_stop"], "null")
            for item, (low, high, permissions, raw) in zip(result["regions"], original):
                self.assertEqual(
                    zlib.decompress((Path(directory) / item["file"]).read_bytes()), raw
                )
                self.assertEqual(item["sha256"], hashlib.sha256(raw).hexdigest())
                self.assertEqual(bytes(uc.mem_read(low, high + 1 - low)), raw)
            self.assertEqual(
                list(uc.mem_regions()), [(a, b, c) for a, b, c, _ in original]
            )
            self.assertEqual(
                registers,
                {
                    name: uc.reg_read(getattr(reg, "UC_ARM64_REG_" + name))
                    for name in registers
                },
            )

    def test_cyclic_frame_chain_stops(self):
        engine, error = self.engine()
        engine.u.mem_write(0x2000C0, (0x200080).to_bytes(8, "little"))
        with tempfile.TemporaryDirectory() as directory:
            result = capture_failure(engine, error, directory, dump_memory=False)
            self.assertEqual(result["frame_chain_stop"], "cycle")
            self.assertEqual(len(result["frames"]), 2)
            self.assertEqual(len(list(Path(directory).iterdir())), 1)

    def test_capture_requires_unwound_emulation(self):
        engine, error = self.engine()
        engine.native_import_data_guard = SimpleNamespace(depth=1)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "stopped top-level"):
                capture_failure(engine, error, directory)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_existing_report_is_preserved(self):
        engine, error = self.engine()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report-private.json"
            path.write_text("previous evidence")
            with self.assertRaisesRegex(ValueError, "overwrite"):
                capture_failure(engine, error, directory)
            self.assertEqual(path.read_text(), "previous evidence")


if __name__ == "__main__":
    unittest.main()
