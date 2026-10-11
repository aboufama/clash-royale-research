"""Asset-free ABI controls. These do not substitute for native integration tests."""

import argparse, json, unittest
from pathlib import Path
from types import SimpleNamespace
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from original_bionic_absent_file import OriginalBionicAbsentFile

PATH = b"csv_logic/globalIdDb.csv"
BASE = 0x20000000


class FakeUC:
    def __init__(self):
        self.registers = {}
        self.memory = {}
        self.stopped = False

    def reg_read(self, r):
        return self.registers.get(r, 0)

    def reg_write(self, r, v):
        self.registers[r] = v

    def mem_read(self, a, n):
        return bytes(self.memory[a + i] for i in range(n))

    def emu_stop(self):
        self.stopped = True

    def store(self, a, b):
        self.memory.update({a + i: v for i, v in enumerate(b)})


def fixture(function="fopen"):
    u = FakeUC()
    r = SimpleNamespace(
        UC_ARM64_REG_X0=0,
        UC_ARM64_REG_X1=1,
        UC_ARM64_REG_X8=8,
        UC_ARM64_REG_LR=30,
        UC_ARM64_REG_PC=32,
    )
    e = SimpleNamespace(u=u, reg=r, stop_reason=None)
    o = OriginalBionicAbsentFile.__new__(OriginalBionicAbsentFile)
    o.engine = e
    o.attachment = SimpleNamespace(BASE=BASE)
    o.paths = (PATH,)
    o.pending = (function, 0x1000, PATH, 0x3000, 0x70000000)
    o.events = []
    o.entries = {"fopen": 0, "stat": 0}
    o.rejections = []
    o.file_allocations = 0
    u.store(0x1000, PATH + b"\0")
    u.store(0x2000, b"rb\0")
    args = [
        0xFFFFFF9C,
        0x1000,
        0 if function == "fopen" else 0x3000,
        0,
        0x123456789,
        0xFFFFFFFFFFFFFFFF,
    ]
    for i, v in enumerate(args):
        u.reg_write(i, v)
    u.reg_write(8, 56 if function == "fopen" else 79)
    u.reg_write(32, BASE + (0xAA938 if function == "fopen" else 0xAA9B8))
    u.reg_write(30, BASE + 0x6520C if function == "fopen" else 0x70000000)
    return o, u


class BoundaryTests(unittest.TestCase):
    def constructor_fixture(self):
        engine = SimpleNamespace(import_calls={}, extra_calls={})
        attachment = SimpleNamespace(engine=engine, targets={})
        return engine, attachment

    def test_constructor_rejects_wrong_engine_before_reading_binary(self):
        engine, attachment = self.constructor_fixture()
        attachment.engine = object()
        with self.assertRaisesRegex(ValueError, "Wrong Bionic file engine"):
            OriginalBionicAbsentFile(
                engine, attachment, "unused", verified_absent_paths=(PATH,)
            )

    def test_constructor_rejects_already_routed_file_functions(self):
        for function in ("fopen", "stat"):
            with self.subTest(function=function):
                engine, attachment = self.constructor_fixture()
                attachment.targets[function] = 123
                with self.assertRaisesRegex(ValueError, "already routed"):
                    OriginalBionicAbsentFile(
                        engine, attachment, "unused", verified_absent_paths=(PATH,)
                    )

    def test_constructor_rejects_prior_modeled_file_calls_in_all_counters(self):
        for counter in ("import_calls", "extra_calls"):
            for function in ("fopen", "stat", "libcxx:fopen", "libg:stat"):
                with self.subTest(counter=counter, function=function):
                    engine, attachment = self.constructor_fixture()
                    getattr(engine, counter)[function] = 1
                    with self.assertRaisesRegex(ValueError, "after modeled file API"):
                        OriginalBionicAbsentFile(
                            engine, attachment, "unused", verified_absent_paths=(PATH,)
                        )

    def test_constructor_rejects_invalid_absence_domains_before_binary_read(self):
        domains = [
            [],
            (),
            (PATH, PATH),
            (b"",),
            ("text",),
            (b"a\0b",),
            (b"x" * 4096,),
            tuple(bytes([i + 1]) for i in range(17)),
        ]
        for domain in domains:
            with self.subTest(domain=repr(domain)[:80]):
                engine, attachment = self.constructor_fixture()
                with self.assertRaises(ValueError):
                    OriginalBionicAbsentFile(
                        engine, attachment, "unused", verified_absent_paths=domain
                    )

    def rejected(self, change, function="fopen"):
        o, u = fixture(function)
        change(o, u)
        before = dict(u.registers)
        with self.assertRaises(ValueError):
            o.handle_interrupt(u, 2)
        self.assertEqual(u.registers, before)
        self.assertEqual(o.events, [])

    def test_openat_accepts_only_raw_kernel_error_and_ignores_unused_regs(self):
        o, u = fixture()
        memory = dict(u.memory)
        self.assertTrue(o.handle_interrupt(u, 2))
        self.assertEqual(u.reg_read(0), 0xFFFFFFFFFFFFFFFE)
        self.assertEqual(u.memory, memory)
        self.assertIsNone(o.pending)

    def test_fstatat_accepts_without_writing_stat_buffer(self):
        o, u = fixture("stat")
        memory = dict(u.memory)
        self.assertTrue(o.handle_interrupt(u, 2))
        self.assertEqual(u.reg_read(0), 0xFFFFFFFFFFFFFFFE)
        self.assertEqual(u.memory, memory)

    def test_wrong_dirfd(self):
        self.rejected(lambda o, u: u.reg_write(0, 0))

    def test_wrong_open_flags(self):
        self.rejected(lambda o, u: u.reg_write(2, 1))

    def test_wrong_open_mode(self):
        self.rejected(lambda o, u: u.reg_write(3, 0o666))

    def test_wrong_stat_flags(self):
        self.rejected(lambda o, u: u.reg_write(3, 0x100), "stat")

    def test_changed_path_pointer(self):
        self.rejected(lambda o, u: u.reg_write(1, 0x1001))

    def test_changed_path_bytes(self):
        self.rejected(lambda o, u: u.store(0x1000, b"x"))

    def test_wrong_return_pc(self):
        self.rejected(lambda o, u: u.reg_write(30, 0))

    def test_stat_changed_buffer(self):
        self.rejected(lambda o, u: u.reg_write(2, 0x3008), "stat")

    def test_unattributed_open(self):
        self.rejected(lambda o, u: setattr(o, "pending", None))

    def test_mismatched_api(self):
        self.rejected(
            lambda o, u: setattr(
                o, "pending", ("stat", 0x1000, PATH, 0x3000, 0x70000000)
            )
        )

    def test_wrong_syscall_is_not_handled(self):
        o, u = fixture()
        u.reg_write(8, 63)
        self.assertFalse(o.handle_interrupt(u, 2))
        self.assertEqual(o.events, [])

    def test_wrong_pc_is_not_handled(self):
        o, u = fixture()
        u.reg_write(32, BASE + 0xAA934)
        self.assertFalse(o.handle_interrupt(u, 2))
        self.assertEqual(o.events, [])

    def test_wrong_interrupt_is_not_handled(self):
        o, u = fixture()
        self.assertFalse(o.handle_interrupt(u, 1))
        self.assertEqual(o.events, [])

    def test_wrong_engine(self):
        o, u = fixture()
        with self.assertRaisesRegex(ValueError, "Wrong Bionic"):
            o.handle_interrupt(FakeUC(), 2)

    def test_absence_set_is_rechecked(self):
        self.rejected(lambda o, u: setattr(o, "paths", (b"other",)))

    def test_duplicate_open_is_not_replayed(self):
        o, u = fixture()
        self.assertTrue(o.handle_interrupt(u, 2))
        with self.assertRaisesRegex(ValueError, "Unattributed"):
            o.handle_interrupt(u, 2)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path)
    a = p.parse_args()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(BoundaryTests)
    r = unittest.TextTestRunner(verbosity=2).run(suite)
    if a.out:
        a.out.mkdir(parents=True, exist_ok=True)
        (a.out / "report.json").write_text(
            json.dumps(
                {
                    "scope": "Asset-free boundary admission/ABI failure controls; no original implementation or guest execution",
                    "passed": r.wasSuccessful(),
                    "tests": r.testsRun,
                    "failures": len(r.failures),
                    "errors": len(r.errors),
                },
                indent=2,
            )
            + "\n"
        )
    raise SystemExit(not r.wasSuccessful())
