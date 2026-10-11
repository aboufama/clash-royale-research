"""Synthetic guard tests; no APK, original binary, or original asset required."""

import struct
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
try:
    import unicorn
    from unicorn import arm64_const as reg
    from native_import_data_guard import NativeImportDataGuard
except ModuleNotFoundError as error:
    if error.name not in ("unicorn", "elftools"):
        raise
    unicorn = None
    reg = None


class Symbol(dict):
    def __init__(self, name, *, defined=False, value=0, size=8):
        super().__init__(
            st_shndx=1 if defined else "SHN_UNDEF",
            st_info={"type": "STT_OBJECT"},
            st_value=value,
            st_size=size,
        )
        self.name = name


class Dynamic:
    def __init__(self, symbols, relocations):
        self.symbols = symbols
        self.relocations = relocations

    def __getitem__(self, key):
        return "PT_DYNAMIC"

    def iter_symbols(self):
        return iter(self.symbols)

    def get_symbol(self, index):
        return self.symbols[index]

    def get_relocation_tables(self):
        return {
            "RELA": SimpleNamespace(iter_relocations=lambda: iter(self.relocations))
        }


class Elf:
    def __init__(self, symbols=(), relocations=()):
        self.dynamic = Dynamic(symbols, relocations)

    def get_section_by_name(self, name):
        return self.dynamic

    def iter_segments(self):
        return iter([self.dynamic])


class Engine:
    BASE = 0x10000000
    STUB = 0x50000000
    CODE = 0x01000000
    DATA = 0x80000000
    unicorn = unicorn
    reg = reg

    def __init__(self):
        self.u = unicorn.Uc(unicorn.UC_ARCH_ARM64, unicorn.UC_MODE_ARM)
        for start, size in [
            (self.CODE, 0x1000),
            (self.BASE, 0x1000),
            (self.STUB - 0x1000, 0x102000),
            (0x21FFF000, 0x12000),
            (self.DATA, 0x1000),
        ]:
            self.u.mem_map(start, size)
        self.stop_reason = None

    def pointer(self, address):
        return struct.unpack("<Q", self.u.mem_read(address, 8))[0]

    def write64(self, address, value):
        self.u.mem_write(address, struct.pack("<Q", value))

    def execute(self, code, address, value=0):
        self.stop_reason = None
        self.u.mem_write(self.CODE, code)
        self.u.reg_write(reg.UC_ARM64_REG_X0, address)
        self.u.reg_write(reg.UC_ARM64_REG_X1, value)
        self.u.emu_start(self.CODE, self.CODE + len(code), count=8)
        if self.stop_reason:
            raise ValueError(self.stop_reason)


@unittest.skipIf(
    unicorn is None, "Optional Unicorn/pyelftools analysis dependencies unavailable"
)
class ImportDataGuardTests(unittest.TestCase):
    def make_guard(self, elves=None):
        engine = Engine()
        attachment = SimpleNamespace(engine=engine, BASE=0x20000000, STUB=0x22000000)
        with patch(
            "native_import_data_guard.read_elf",
            side_effect=elves or [Elf(), Elf(), Elf()],
        ):
            guard = NativeImportDataGuard(
                engine, Path("libg"), Path("libcxx"), Path("bionic"), attachment
            )
        return engine, guard

    def test_native_read_rejected(self):
        engine, guard = self.make_guard()
        # Locally authored ldr x2, [x0].
        with self.assertRaisesRegex(ValueError, "GUEST_ACCESS"):
            engine.execute(bytes.fromhex("020040f9"), engine.STUB)
        self.assertEqual(guard.depth, 0)
        self.assertEqual(guard.events[-1]["bytes"], 8)

    def test_native_write_rejected(self):
        engine, guard = self.make_guard()
        # Locally authored str x1, [x0]. Stopping is guaranteed; no claim of rollback.
        with self.assertRaisesRegex(ValueError, "GUEST_ACCESS"):
            engine.execute(bytes.fromhex("010000f9"), engine.STUB, 17)
        self.assertEqual(guard.depth, 0)

    def test_native_cross_boundary_reads_and_writes_rejected(self):
        for instruction in ("020040f9", "010000f9"):
            for offset in (-7, -4, -1, 0, 0x100000 - 1):
                with self.subTest(instruction=instruction, offset=offset):
                    engine, guard = self.make_guard()
                    with self.assertRaisesRegex(ValueError, "GUEST_ACCESS"):
                        engine.execute(
                            bytes.fromhex(instruction), engine.STUB + offset, 17
                        )
                    self.assertEqual(guard.depth, 0)

    def test_bionic_cross_boundary_reads_and_writes_rejected(self):
        for instruction in ("020040f9", "010000f9"):
            for offset in (-7, -1, 0, 0xFFFF):
                with self.subTest(instruction=instruction, offset=offset):
                    engine, guard = self.make_guard()
                    with self.assertRaisesRegex(ValueError, "GUEST_ACCESS"):
                        engine.execute(
                            bytes.fromhex(instruction), 0x22000000 + offset, 17
                        )
                    self.assertEqual(guard.depth, 0)

    def adapter_action(self, engine, function):
        def callback(uc, pc, size, user):
            function()

        hook = engine.u.hook_add(
            unicorn.UC_HOOK_CODE, callback, begin=engine.CODE, end=engine.CODE
        )
        try:
            engine.execute(bytes.fromhex("1f2003d5"), engine.DATA)
        finally:
            engine.u.hook_del(hook)

    def test_adapter_read_rejected(self):
        engine, guard = self.make_guard()
        with self.assertRaisesRegex(ValueError, "ADAPTER_READ"):
            self.adapter_action(engine, lambda: engine.u.mem_read(engine.STUB, 8))
        self.assertEqual(guard.depth, 0)

    def test_adapter_write_rejected(self):
        engine, guard = self.make_guard()
        with self.assertRaisesRegex(ValueError, "ADAPTER_WRITE"):
            self.adapter_action(engine, lambda: engine.u.mem_write(engine.STUB, b"ab"))
        self.assertEqual(guard.depth, 0)
        self.assertEqual(bytes(engine.u.mem_read(engine.STUB, 2)), b"\0\0")

    def test_adapter_cross_boundary_overlap_rejected(self):
        engine, guard = self.make_guard()
        for address, length in [
            (engine.STUB - 1, 2),
            (engine.STUB + 0x100000 - 1, 2),
            (0x22000000 - 1, 2),
        ]:
            with self.subTest(address=address):
                with self.assertRaisesRegex(ValueError, "ADAPTER_READ"):
                    self.adapter_action(
                        engine, lambda: engine.u.mem_read(address, length)
                    )
        self.assertEqual(guard.depth, 0)

    def test_exact_adjacent_extent_is_allowed(self):
        engine, guard = self.make_guard()
        self.adapter_action(engine, lambda: engine.u.mem_read(engine.STUB - 8, 8))
        self.adapter_action(
            engine, lambda: engine.u.mem_read(engine.STUB + 0x100000, 8)
        )
        self.assertEqual(guard.events, [])

    def test_non_stub_native_data_is_allowed(self):
        engine, guard = self.make_guard()
        engine.write64(engine.DATA, 0x1122334455667788)
        engine.execute(bytes.fromhex("020040f9"), engine.DATA)
        self.assertEqual(engine.u.reg_read(reg.UC_ARM64_REG_X2), 0x1122334455667788)
        self.assertEqual(guard.events, [])

    def test_inspection_outside_execution_remains_allowed(self):
        engine, guard = self.make_guard()
        self.assertEqual(bytes(engine.u.mem_read(engine.STUB, 8)), bytes(8))
        self.assertEqual(guard.events, [])
        self.assertEqual(guard.depth, 0)

    def test_emulation_error_restores_depth(self):
        engine, guard = self.make_guard()
        with self.assertRaises(unicorn.UcError):
            engine.u.emu_start(0xDEADBEEF, 0xDEADBEF0, count=1)
        self.assertEqual(guard.depth, 0)

    def test_original_data_export_binding(self):
        imported = Symbol("fixture_data")
        exported = Symbol("fixture_data", defined=True, value=0x120, size=8)
        relocation = {
            "r_info_type": 1025,
            "r_info_sym": 0,
            "r_offset": 0x80,
            "r_addend": 0,
        }
        engine, guard = self.make_guard(
            [Elf([imported], [relocation]), Elf(), Elf([exported])]
        )
        self.assertEqual(engine.pointer(engine.BASE + 0x80), 0x20000120)
        self.assertEqual(guard.data_inventory[0]["provider"], "bionic")

    def test_unresolved_object_is_rejected(self):
        imported = Symbol("missing_data")
        relocation = {
            "r_info_type": 1025,
            "r_info_sym": 0,
            "r_offset": 0x80,
            "r_addend": 0,
        }
        with self.assertRaisesRegex(ValueError, "Unresolved imported data object"):
            self.make_guard([Elf([imported], [relocation]), Elf(), Elf()])

    def test_object_addend_outside_export_is_rejected(self):
        imported = Symbol("fixture_data")
        exported = Symbol("fixture_data", defined=True, value=0x120, size=8)
        relocation = {
            "r_info_type": 257,
            "r_info_sym": 0,
            "r_offset": 0x80,
            "r_addend": 8,
        }
        with self.assertRaisesRegex(ValueError, "addend outside exported object"):
            self.make_guard([Elf([imported], [relocation]), Elf([exported]), Elf()])


if __name__ == "__main__":
    unittest.main()
