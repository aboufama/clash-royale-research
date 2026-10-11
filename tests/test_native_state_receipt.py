"""Negative controls for read-only receipts; no proprietary game inputs."""

from collections import Counter
from pathlib import Path
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from native_state_receipt import StateReceipts, EXTRA_REGISTERS

try:
    import unicorn
    import unicorn.arm64_const as reg
except ImportError:
    unicorn = None
    reg = None


class Engine:
    BASE = 0x10000000
    HEAP = 0x20000000
    HEAP_SIZE = 4096
    STACK = 0x30000000
    STUB = 0x40000000
    STOP = 0x50000000

    def __init__(self):
        self.unicorn = unicorn
        self.reg = reg
        self.u = unicorn.Uc(unicorn.UC_ARCH_ARM64, unicorn.UC_MODE_ARM)
        self.u.mem_map(self.BASE, 4096, unicorn.UC_PROT_READ | unicorn.UC_PROT_WRITE)
        self.u.mem_write(self.BASE, b"\x55" * 4096)
        self.next_address = self.HEAP + 32
        self.allocations = {self.HEAP: 32}
        self.import_calls = Counter({"malloc": 1})
        self.mutexes = set()
        self.stop_reason = None


class SerializationTests(unittest.TestCase):
    def setUp(self):
        self.r = StateReceipts.__new__(StateReceipts)
        self.r.immutable_bytes = {}

    def digest(self, v):
        return self.r.digest(self.r.serialize(v))

    def test_dictionary_insertion_order(self):
        self.assertNotEqual(
            self.digest({"a": 1, "b": 2}), self.digest({"b": 2, "a": 1})
        )

    def test_counter_distinct_from_dict(self):
        self.assertNotEqual(self.digest(Counter({"a": 1})), self.digest({"a": 1}))

    def test_list_distinct_from_tuple(self):
        self.assertNotEqual(self.digest([1, 2]), self.digest((1, 2)))

    def test_set_distinct_from_frozenset(self):
        self.assertNotEqual(self.digest({1, 2}), self.digest(frozenset({1, 2})))

    def test_scalar_types_distinct(self):
        self.assertEqual(
            len({self.digest(x) for x in [None, True, 1, 1.0, "1", b"1"]}), 6
        )

    def test_float_bit_patterns(self):
        n1 = struct.unpack(">d", bytes.fromhex("7ff8000000000001"))[0]
        n2 = struct.unpack(">d", bytes.fromhex("7ff8000000000002"))[0]
        self.assertNotEqual(self.digest(n1), self.digest(n2))
        self.assertNotEqual(self.digest(-0.0), self.digest(0.0))

    def test_unknown_subclass_rejected(self):
        class MyDict(dict):
            pass

        class MyInt(int):
            pass

        for value in (MyDict(a=1), MyInt(1), bytearray(b"x")):
            with self.subTest(kind=type(value).__name__), self.assertRaises(TypeError):
                self.r.serialize(value)

    def test_shared_container_alias_distinguished(self):
        child = []
        self.assertNotEqual(self.digest([child, child]), self.digest([[], []]))

    def test_cycles_are_represented(self):
        a = []
        a.append(a)
        encoded = self.r.serialize(a)
        self.assertEqual(encoded, ["list", 0, [["reference", 0]]])


@unittest.skipUnless(
    unicorn is not None, "Unicorn is required for synthetic CPU/memory controls"
)
class NativeReceiptTests(unittest.TestCase):

    def setUp(self):
        self.e = Engine()
        self.r = StateReceipts(self.e)

    def digest(self, v):
        return self.r.digest(self.r.serialize(v))

    def test_stable_read_only(self):
        before = bytes(self.e.u.mem_read(self.e.BASE, 4096))
        registers = [
            self.e.u.reg_read(getattr(reg, "UC_ARM64_REG_" + n))
            for n in self.r.register_names
        ]
        attrs = self.digest(vars(self.e).copy() | {"u": None})
        a = self.r.capture(7)
        b = self.r.capture(7)
        self.assertEqual(a, b)
        self.assertEqual(before, bytes(self.e.u.mem_read(self.e.BASE, 4096)))
        self.assertEqual(
            registers,
            [
                self.e.u.reg_read(getattr(reg, "UC_ARM64_REG_" + n))
                for n in self.r.register_names
            ],
        )
        self.assertEqual(attrs, self.digest(vars(self.e).copy() | {"u": None}))

    def test_last_mapped_byte_changes(self):
        a = self.r.capture(0)
        self.e.u.mem_write(self.e.BASE + 4095, b"\xaa")
        b = self.r.capture(0)
        self.assertNotEqual(a["receipt_sha256"], b["receipt_sha256"])
        self.assertNotEqual(a["regions"], b["regions"])

    def test_q_high_bit_changes(self):
        a = self.r.capture(0)
        self.e.u.reg_write(reg.UC_ARM64_REG_Q31, 1 << 127)
        b = self.r.capture(0)
        self.assertNotEqual(a["receipt_sha256"], b["receipt_sha256"])
        self.assertEqual(b["registers"]["Q31"], hex(1 << 127))

    def test_allocator_cursor_changes(self):
        a = self.r.capture(0)
        self.e.next_address += 16
        b = self.r.capture(0)
        self.assertNotEqual(
            a["adapter_field_sha256"]["next_address"],
            b["adapter_field_sha256"]["next_address"],
        )

    def test_allocation_extent_changes(self):
        a = self.r.capture(0)
        self.e.allocations[self.e.HEAP] = 16
        b = self.r.capture(0)
        self.assertNotEqual(a["receipt_sha256"], b["receipt_sha256"])

    def test_region_permissions_change(self):
        a = self.r.capture(0)
        self.e.u.mem_protect(self.e.BASE, 4096, unicorn.UC_PROT_READ)
        b = self.r.capture(0)
        self.assertNotEqual(a["receipt_sha256"], b["receipt_sha256"])

    def test_new_mapping_detected(self):
        a = self.r.capture(0)
        self.e.u.mem_map(self.e.HEAP, 4096)
        b = self.r.capture(0)
        self.assertNotEqual(a["receipt_sha256"], b["receipt_sha256"])
        self.assertEqual(len(b["regions"]), 2)

    def test_cross_attribute_alias_distinguished(self):
        self.e.left = []
        self.e.right = self.e.left
        self.r = StateReceipts(self.e)
        a = self.r.capture(0)
        self.e.right = []
        b = self.r.capture(0)
        self.assertEqual(a["adapter_field_sha256"], b["adapter_field_sha256"])
        self.assertNotEqual(a["adapter_graph_sha256"], b["adapter_graph_sha256"])

    def test_tick_is_hashed(self):
        self.assertNotEqual(
            self.r.capture(0)["receipt_sha256"], self.r.capture(1)["receipt_sha256"]
        )

    def test_attribute_schema_changes_fail(self):
        self.e.new = []
        with self.assertRaises(ValueError):
            self.r.capture(0)

    def test_class_configuration_changes_fail(self):
        previous = Engine.STOP
        try:
            Engine.STOP += 4096
            with self.assertRaises(ValueError):
                self.r.capture(0)
        finally:
            Engine.STOP = previous

    def test_extra_registers_roundtrip_and_receipt(self):
        for name in EXTRA_REGISTERS:
            # Fresh isolated engines avoid banked-SP/PSTATE interactions between tests.
            e = Engine()
            r = StateReceipts(e)
            before = r.capture(0)
            ident = getattr(reg, "UC_ARM64_REG_" + name)
            value = (e.u.reg_read(ident) ^ 0x200) if name == "PSTATE" else 0x12345000
            e.u.reg_write(ident, value)
            with self.subTest(register=name):
                self.assertEqual(e.u.reg_read(ident), value)
                after = r.capture(0)
                self.assertEqual(after["registers"][name], hex(value))
                self.assertNotEqual(before["receipt_sha256"], after["receipt_sha256"])


if __name__ == "__main__":
    unittest.main()
