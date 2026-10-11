"""Asset-free adapter admission/futex boundary tests; no native code emulated."""

import subprocess
import sys
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import original_bionic_pthreads as pthread_module
from original_bionic_pthreads import OriginalBionicPthreads
from original_bionic_synchronization import OriginalBionicSynchronization


class Engine:
    def __init__(self):
        self.thread_keys = {}
        self.next_thread_key = 0
        self.mutexes = set()
        self.extra_calls = Counter()
        self.import_calls = Counter()
        self.writes = []
        self.word_value = 0

    def word(self, address):
        return self.word_value

    def write32(self, address, value):
        self.writes.append((address, value))


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.engine = Engine()
        self.attachment = SimpleNamespace(engine=self.engine, synthetic_thread=0x1000)

    def pthread(self, **kwargs):
        return OriginalBionicPthreads(
            self.engine, self.attachment, "absent-native-libc", **kwargs
        )

    def synchronization(self, **kwargs):
        return OriginalBionicSynchronization(
            self.engine, self.attachment, "absent-native-libc", **kwargs
        )

    def test_import_and_rejection_without_optional_packages(self):
        directory = Path(pthread_module.__file__).resolve().parent
        code = f"""
import sys
sys.path.insert(0, {str(directory)!r})
from original_bionic_pthreads import OriginalBionicPthreads
from original_bionic_synchronization import OriginalBionicSynchronization
assert not any(name.startswith(('elftools', 'unicorn')) for name in sys.modules)
for cls, kw in [(OriginalBionicPthreads, {{}}), (OriginalBionicSynchronization, {{'thread_id': 1}})]:
    try:
        cls(None, None, None, single_thread=False, **kw)
    except ValueError:
        pass
    else:
        raise AssertionError('Admission accepted')
"""
        subprocess.run(
            [sys.executable, "-S", "-c", code], check=True, capture_output=True
        )

    def test_explicit_single_thread_required(self):
        for value in (None, False, 0, 1, "true"):
            with self.subTest(value=value), self.assertRaisesRegex(
                ValueError, "Explicit single-thread"
            ):
                self.pthread(single_thread=value)
            with self.subTest(value=value), self.assertRaisesRegex(
                ValueError, "Explicit single-thread"
            ):
                self.synchronization(single_thread=value, thread_id=1)
        self.assertEqual(self.engine.writes, [])

    def test_live_modeled_keys_rejected(self):
        self.engine.thread_keys[0] = {"value": 0}
        with self.assertRaisesRegex(ValueError, "Cannot mix modeled"):
            self.pthread(single_thread=True)

    def test_deleted_modeled_keys_rejected(self):
        self.engine.next_thread_key = 1
        with self.assertRaisesRegex(ValueError, "historical modeled"):
            self.pthread(single_thread=True)

    def test_prefixed_pthread_history_rejected(self):
        for name in (
            "pthread_once",
            "pthread_getspecific",
            "modeled_single_thread:pthread_key_create",
            "modeled_single_thread:pthread_key_delete",
            "modeled_single_thread:pthread_setspecific",
            "modeled_runtime:__cxa_thread_atexit_impl",
        ):
            self.engine.extra_calls = Counter({name: 1})
            with self.subTest(name=name), self.assertRaisesRegex(
                ValueError, "after modeled pthread/TLS"
            ):
                self.pthread(single_thread=True)

    def test_wrong_attachment_engine_rejected(self):
        self.attachment.engine = object()
        with self.assertRaisesRegex(ValueError, "Wrong Bionic attachment"):
            self.synchronization(single_thread=True, thread_id=1)

    def test_thread_id_must_match_platform(self):
        for value in (0, 2, True, 1.0, "1", None):
            with self.subTest(value=value), self.assertRaisesRegex(
                ValueError, "thread_id=1"
            ):
                self.synchronization(single_thread=True, thread_id=value)

    def test_previous_modeled_synchronization_state_rejected(self):
        for field in (
            "mutexes",
            "mutex_attributes",
            "initialized_mutex_types",
            "condition_attributes",
            "initialized_conditions",
        ):
            prior = getattr(self.engine, field, None)
            setattr(self.engine, field, {17: 0})
            with self.subTest(field=field), self.assertRaisesRegex(
                ValueError, "populated modeled"
            ):
                self.synchronization(single_thread=True, thread_id=1)
            setattr(self.engine, field, prior)
        self.assertEqual(self.engine.writes, [])

    def test_prefixed_lifecycle_history_rejected_after_destroy(self):
        for field in ("extra_calls", "import_calls"):
            for name in (
                "pthread_mutex_lock",
                "modeled_lifecycle:pthread_mutex_init",
                "modeled_lifecycle:pthread_mutex_destroy",
                "modeled_lifecycle:pthread_cond_init",
                "modeled_lifecycle:pthread_cond_destroy",
            ):
                setattr(self.engine, field, Counter({name: 1}))
                with self.subTest(field=field, name=name), self.assertRaisesRegex(
                    ValueError, "after modeled synchronization"
                ):
                    self.synchronization(single_thread=True, thread_id=1)
            setattr(self.engine, field, Counter())

    def test_existing_tid_preserved(self):
        self.engine.word_value = 5
        with self.assertRaisesRegex(ValueError, "ID already initialized"):
            self.synchronization(single_thread=True, thread_id=1)
        self.assertEqual(self.engine.word_value, 5)
        self.assertEqual(self.engine.writes, [])

    def test_duplicate_attachment_rejected(self):
        self.engine.original_synchronization = object()
        with self.assertRaisesRegex(ValueError, "already attached"):
            self.synchronization(single_thread=True, thread_id=1)


class InterruptBoundaryTests(unittest.TestCase):
    def build(self):
        registers = {
            0: 0x4000,
            1: 0x81,
            2: 0x7FFFFFFF,
            3: 0,
            4: 0,
            5: 0,
            8: 98,
            100: 0x20055E20,
        }
        writes = []

        def write(register, value):
            registers[register] = value
            writes.append((register, value))

        uc = SimpleNamespace(reg_read=registers.__getitem__, reg_write=write)
        engine = SimpleNamespace(
            u=uc,
            reg=SimpleNamespace(
                UC_ARM64_REG_PC=100, UC_ARM64_REG_X8=8, UC_ARM64_REG_X0=0
            ),
            word=lambda pointer: 2,
        )
        helper = OriginalBionicPthreads.__new__(OriginalBionicPthreads)
        helper.engine = engine
        helper.attachment = SimpleNamespace(BASE=0x20000000)
        helper.pending_once = {0x4000}
        helper.events = []
        return engine, uc, helper, registers, writes

    def test_exact_once_wake_is_only_permitted_case(self):
        engine, uc, helper, registers, writes = self.build()
        self.assertTrue(helper.handle_interrupt(engine, uc, 2))
        self.assertEqual(writes, [(0, 0)])
        self.assertEqual(helper.pending_once, set())
        self.assertEqual(len(helper.events), 1)
        self.assertEqual(helper.events[0]["result"], 0)

    def test_unrelated_interrupt_not_claimed(self):
        for register, value in [(100, 0x20055E24), (8, 178)]:
            engine, uc, helper, registers, writes = self.build()
            registers[register] = value
            self.assertFalse(helper.handle_interrupt(engine, uc, 2))
            self.assertEqual(writes, [])
        engine, uc, helper, registers, writes = self.build()
        self.assertFalse(helper.handle_interrupt(engine, uc, 1))

    def test_futex_wait_and_each_wrong_argument_fail_closed(self):
        for register, value in [
            (0, 0x5000),
            (1, 0x80),
            (1, 1),
            (2, 1),
            (3, 1),
            (4, 1),
            (5, 1),
        ]:
            engine, uc, helper, registers, writes = self.build()
            registers[register] = value
            with self.subTest(register=register, value=value), self.assertRaisesRegex(
                ValueError, "Unsupported Bionic futex"
            ):
                helper.handle_interrupt(engine, uc, 2)
            self.assertEqual(writes, [])
            self.assertEqual(helper.events, [])
            self.assertEqual(helper.pending_once, {0x4000})

    def test_native_once_completion_required(self):
        engine, uc, helper, registers, writes = self.build()
        engine.word = lambda pointer: 1
        with self.assertRaisesRegex(ValueError, "Unsupported Bionic futex"):
            helper.handle_interrupt(engine, uc, 2)
        self.assertEqual(writes, [])

    def test_wrong_engine_or_uc_rejected(self):
        engine, uc, helper, registers, writes = self.build()
        for a, b in [(object(), uc), (engine, object())]:
            with self.assertRaisesRegex(ValueError, "Wrong pthread platform engine"):
                helper.handle_interrupt(a, b, 2)
        self.assertEqual(writes, [])


if __name__ == "__main__":
    unittest.main()
