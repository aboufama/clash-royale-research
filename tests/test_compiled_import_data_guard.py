"""Compile only authored observation code; guest instructions are synthetic."""

import ctypes
import functools
import gc
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import test_native_import_data_guard as reference

ROOT = Path(__file__).resolve().parents[1]
if reference.unicorn is not None:
    from compiled_import_data_guard import CompiledImportDataGuard


@unittest.skipIf(reference.unicorn is None, "Optional native dependencies unavailable")
class CompiledGuardTests(reference.ImportDataGuardTests):
    @classmethod
    def setUpClass(cls):
        compiler = shutil.which("cc")
        if compiler is None:
            raise unittest.SkipTest("A C compiler is needed for the authored observer")
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        cls.library_path = Path(cls.directory.name) / "observer.so"
        include = Path(reference.unicorn.__file__).parent / "include"
        flags = ["-dynamiclib"] if sys.platform == "darwin" else ["-shared", "-fPIC"]
        subprocess.run(
            [
                compiler,
                "-std=c11",
                "-O2",
                "-Wall",
                "-Wextra",
                "-Werror",
                *flags,
                "-I",
                str(include),
                str(ROOT / "scripts/import_data_observer.c"),
                "-o",
                str(cls.library_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

    def make_guard(self, elves=None):
        with patch.object(
            reference,
            "NativeImportDataGuard",
            functools.partial(
                CompiledImportDataGuard, observer_library=self.library_path
            ),
        ):
            return super().make_guard(elves)

    def test_changed_ranges_rejected_before_execution(self):
        engine, guard = self.make_guard()
        guard.ranges.append((engine.DATA, engine.DATA + 8))
        with self.assertRaisesRegex(ValueError, "range configuration changed"):
            engine.execute(bytes.fromhex("1f2003d5"), engine.DATA)
        self.assertEqual(guard.depth, 0)

    def test_nested_violation_reaches_inner_caller(self):
        engine, guard = self.make_guard()
        inner = engine.CODE + 0x80
        engine.u.mem_write(inner, bytes.fromhex("020040f9"))
        observed = []

        def callback(uc, pc, size, user):
            uc.reg_write(engine.reg.UC_ARM64_REG_X0, engine.STUB)
            try:
                uc.emu_start(inner, inner + 4, count=1)
            except ValueError as error:
                observed.append(str(error))
            finally:
                # No resumption of a failed nested engine.
                uc.emu_stop()

        hook = engine.u.hook_add(
            engine.unicorn.UC_HOOK_CODE, callback, begin=engine.CODE, end=engine.CODE
        )
        try:
            with self.assertRaisesRegex(ValueError, "GUEST_ACCESS"):
                engine.execute(bytes.fromhex("1f2003d5"), engine.DATA)
        finally:
            engine.u.hook_del(hook)
        self.assertEqual(len(observed), 1)
        self.assertIn("GUEST_ACCESS", observed[0])
        self.assertEqual(len(guard.events), 1)
        self.assertEqual(guard.depth, 0)

    def test_allowed_nested_read(self):
        engine, guard = self.make_guard()
        inner = engine.CODE + 0x80
        engine.u.mem_write(inner, bytes.fromhex("020040f9"))
        engine.write64(engine.DATA, 0x123456789ABCDEF0)

        def callback(uc, pc, size, user):
            uc.emu_start(inner, inner + 4, count=1)
            uc.reg_write(engine.reg.UC_ARM64_REG_PC, engine.CODE + 4)

        hook = engine.u.hook_add(
            engine.unicorn.UC_HOOK_CODE, callback, begin=engine.CODE, end=engine.CODE
        )
        try:
            engine.execute(bytes.fromhex("1f2003d5"), engine.DATA)
        finally:
            engine.u.hook_del(hook)
        self.assertEqual(
            engine.u.reg_read(engine.reg.UC_ARM64_REG_X2), 0x123456789ABCDEF0
        )
        self.assertEqual(guard.depth, 0)
        self.assertEqual(guard.events, [])

    def test_callback_state_and_library_survive_gc(self):
        engine, guard = self.make_guard()
        address = ctypes.addressof(guard.native_state)
        del guard
        gc.collect()
        self.assertEqual(
            ctypes.addressof(engine.native_import_data_guard.native_state), address
        )
        with self.assertRaisesRegex(ValueError, "GUEST_ACCESS"):
            engine.execute(bytes.fromhex("020040f9"), engine.STUB)

    def test_observer_api_failures_reject(self):
        for read_failed, stop_failed in [(True, False), (False, True), (True, True)]:
            with self.subTest(read_failed=read_failed, stop_failed=stop_failed):
                engine, guard = self.make_guard()
                callbacks = []
                if read_failed:
                    callback = ctypes.CFUNCTYPE(
                        ctypes.c_int, ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p
                    )(lambda *args: 42)
                    callbacks.append(callback)
                    guard.native_state.read = ctypes.cast(
                        callback, ctypes.c_void_p
                    ).value
                if stop_failed:
                    callback = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p)(
                        lambda *args: 43
                    )
                    callbacks.append(callback)
                    guard.native_state.stop = ctypes.cast(
                        callback, ctypes.c_void_p
                    ).value
                with self.assertRaisesRegex(ValueError, "native observer API failure"):
                    engine.execute(bytes.fromhex("020040f9"), engine.STUB)
                self.assertEqual(guard.depth, 0)
                self.assertEqual(len(guard.events), 1)

    def test_first_stop_failure_is_preserved(self):
        engine, guard = self.make_guard()
        calls = []

        def fail_then_succeed(uc):
            calls.append(uc)
            return 43 if len(calls) == 1 else 0

        callback = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p)(fail_then_succeed)
        guard.native_state.stop = ctypes.cast(callback, ctypes.c_void_p).value
        engine.u.mem_write(engine.CODE, bytes.fromhex("020040f9") * 2)
        engine.u.reg_write(engine.reg.UC_ARM64_REG_X0, engine.STUB)
        with self.assertRaisesRegex(ValueError, "native observer API failure 0/43"):
            engine.u.emu_start(engine.CODE, engine.CODE + 8, count=2)
        self.assertEqual(len(calls), 2)
        self.assertEqual(guard.native_state.stop_error, 43)

    def test_callback_exception_restores_depth(self):
        engine, guard = self.make_guard()

        def callback(*args):
            raise RuntimeError("synthetic callback failure")

        hook = engine.u.hook_add(
            engine.unicorn.UC_HOOK_CODE, callback, begin=engine.CODE, end=engine.CODE
        )
        try:
            with self.assertRaisesRegex(RuntimeError, "synthetic callback failure"):
                engine.execute(bytes.fromhex("1f2003d5"), engine.DATA)
        finally:
            engine.u.hook_del(hook)
        self.assertEqual(guard.depth, 0)
        self.assertEqual(guard.events, [])

    def test_interval_predicate_matches_unbounded_integers(self):
        library = ctypes.CDLL(str(self.library_path))
        overlap = library.cr_guard_overlap
        overlap.argtypes = [ctypes.c_uint64] * 4
        overlap.restype = ctypes.c_int
        edges = [
            0,
            1,
            2,
            7,
            8,
            15,
            16,
            0x21FFFFFF,
            0x22000000,
            0x50000000,
            0xFFFFFFFF,
            1 << 63,
            (1 << 64) - 2,
            (1 << 64) - 1,
        ]
        for low, high in [
            (0x22000000, 0x22010000),
            (0x50000000, 0x50100000),
            (0, 1),
            ((1 << 64) - 8, (1 << 64) - 1),
        ]:
            for address in edges + [low - 1 if low else 0, low, high - 1, high]:
                for length in edges:
                    expected = length > 0 and address < high and low < address + length
                    self.assertEqual(
                        bool(overlap(address, length, low, high)), expected
                    )
        rng = random.Random(61139)
        for _ in range(100000):
            address, length, a, b = [rng.getrandbits(64) for _ in range(4)]
            low, high = min(a, b), max(a, b)
            if low != high:
                expected = length > 0 and address < high and low < address + length
                self.assertEqual(bool(overlap(address, length, low, high)), expected)


if __name__ == "__main__":
    unittest.main()
