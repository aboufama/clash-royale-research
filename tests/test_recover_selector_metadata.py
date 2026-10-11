"""Synthetic format, path-containment, and fail-closed tests; no game fixtures."""

from collections import Counter
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import recover_selector_metadata as recovery


def encode_varint(value):
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def field(number, value):
    if isinstance(value, int):
        return encode_varint(number << 3) + encode_varint(value)
    return encode_varint((number << 3) | 2) + encode_varint(len(value)) + value


def entry(selector, ciphertext=b"synthetic ciphertext"):
    return field(1, selector) + field(2, field(1, ciphertext))


def metadata(entries=None, extra=b""):
    if entries is None:
        entries = [entry(index) for index in range(recovery.SELECTOR_COUNT)]
    body = field(1, field(1, b"synthetic main ciphertext"))
    body += field(2, b"synthetic") * 35 + field(3, b"synthetic") * 40
    body += b"".join(field(number, b"synthetic") for number in (*range(4, 10), 11))
    body += b"".join(field(10, value) for value in entries)
    return field(1, body) + field(2, bytes(256)) + extra


def container(records=None):
    if records is None:
        records = [(0x10, b"a"), (0x20, b"bc"), (0x30, metadata())]
    return b"lbts" + b"".join(
        struct.pack("<II", kind, len(value)) + value for kind, value in records
    )


class FormatTests(unittest.TestCase):
    def test_uint64_and_negative_int32(self):
        value, end = recovery.varint(encode_varint(2**64 - 1), 0)
        self.assertEqual((value, end), (2**64 - 1, 10))
        self.assertEqual(recovery.signed_selector(value), 0xFFFFFFFF)
        self.assertEqual(recovery.signed_selector(0xFFFFFFFF80000000), 0x80000000)

    def test_invalid_varints(self):
        for data in [b"\x80", b"\x80\x00", b"\xff" * 9 + b"\x02", b"\x80" * 11]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                recovery.varint(data, 0)

    def test_int32_encoding_cannot_alias_selector(self):
        for value in [0x80000000, 0xFFFFFFFF, 0x100000000, 0xFFFFFFFF7FFFFFFF, -1]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                recovery.signed_selector(value)

    def test_bad_field_number_wire_and_length(self):
        for data in [b"\x00\x00", field(1 << 29, 0), b"\x0d1234", b"\x0a\x05x"]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                recovery.fields(data)

    def test_synthetic_container_and_metadata(self):
        records = recovery.parse_container(container())
        selectors, main = recovery.parse_metadata_record(records[0x30])
        self.assertEqual(len(selectors), 416)
        self.assertEqual(selectors[-1], (415, b"synthetic ciphertext"))
        self.assertEqual(main, b"synthetic main ciphertext")

    def test_container_magic_truncation_trailing_duplicate(self):
        valid = container()
        bad = [
            b"wrong",
            b"lbts\x10",
            valid[:-1],
            valid + b"x",
            container([(0x10, b"a"), (0x10, b"b"), (0x30, b"c")]),
            b"lbts" + struct.pack("<II", 0x10, 0xFFFFFFFF),
        ]
        for value in bad:
            with self.subTest(length=len(value)), self.assertRaises(ValueError):
                recovery.parse_container(value)

    def test_top_unknown_or_duplicate_fields_rejected(self):
        for extra in [field(3, b"extra"), field(1, b"duplicate")]:
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                recovery.parse_metadata_record(metadata(extra=extra))

    def test_missing_selector_rejected(self):
        with self.assertRaises(ValueError):
            recovery.parse_metadata_record(metadata([entry(i) for i in range(415)]))

    def test_duplicate_selector_rejected(self):
        with self.assertRaisesRegex(ValueError, "Duplicate selector"):
            recovery.parse_metadata_record(metadata([entry(0)] * 416))

    def test_wrong_wire_unknown_inner_and_empty_ciphertext(self):
        bad_entries = [
            field(1, b"wrong wire") + field(2, field(1, b"cipher")),
            entry(0) + field(3, b"unknown"),
            field(1, 0) + field(2, field(1, b"cipher") + field(2, b"unknown")),
            entry(0, b""),
        ]
        for first in bad_entries:
            with self.subTest(first=first), self.assertRaises(ValueError):
                recovery.parse_metadata_record(
                    metadata([first] + [entry(i) for i in range(1, 416)])
                )

    def test_signature_width_rejected(self):
        valid = recovery.fields(metadata())
        with self.assertRaisesRegex(ValueError, "signature length"):
            recovery.parse_metadata_record(field(1, valid[0][2]) + field(2, bytes(255)))


class OutputTests(unittest.TestCase):
    def test_only_repository_work_is_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(
                recovery.output_directory(root / "work/result", root),
                root.resolve() / "work/result",
            )
            for path in [root / "research/result", root, root / "work/../outside"]:
                with self.subTest(path=path), self.assertRaises(ValueError):
                    recovery.output_directory(path, root)

    def test_directory_symlink_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "work").mkdir()
            (root / "outside").mkdir()
            (root / "work/link").symlink_to(root / "outside", target_is_directory=True)
            with self.assertRaises(ValueError):
                recovery.output_directory(root / "work/link/result", root)

    def test_work_root_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "outside").mkdir()
            (root / "work").symlink_to(root / "outside", target_is_directory=True)
            with self.assertRaises(ValueError):
                recovery.output_directory(root / "work/result", root)

    def test_output_file_symlink_and_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "payload.bin").symlink_to(root / "elsewhere.bin")
            for name in ["payload.bin", "../payload.bin", "/payload.bin"]:
                with self.subTest(name=name), self.assertRaises(ValueError):
                    recovery.output_file(root, name)


class FakeEmulator:
    def __init__(self):
        self.registers = {}
        self.stopped = False

    def reg_read(self, register):
        return self.registers.get(register, 0)

    def reg_write(self, register, value):
        self.registers[register] = value

    def emu_start(self, *args, **kwargs):
        pass  # Simulate an instruction/time budget that ends without returning.

    def emu_stop(self):
        self.stopped = True


def fake_decoder():
    obj = object.__new__(recovery.NativeDecoder)
    obj.u = FakeEmulator()
    obj.reg = SimpleNamespace(
        UC_ARM64_REG_X0=0,
        UC_ARM64_REG_X8=8,
        UC_ARM64_REG_PC=32,
        UC_ARM64_REG_LR=33,
        UC_ARM64_REG_SP=34,
    )
    obj.unicorn = SimpleNamespace(UcError=RuntimeError)
    obj.names = {}
    obj.import_calls = Counter()
    obj.stop_reason = None
    obj.seconds = 1
    return obj


class FailClosedTests(unittest.TestCase):
    def test_wrong_pinned_input_is_rejected_without_native_dependencies(self):
        with self.assertRaisesRegex(ValueError, "pinned"):
            recovery.NativeDecoder(b"synthetic image", b"synthetic ELF")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input"
            path.write_bytes(b"synthetic")
            with self.assertRaisesRegex(ValueError, "pinned"):
                recovery.pinned_bytes(path, recovery.APK_SHA256, "APK")

    def test_unknown_import_stops_and_is_not_native_rejection(self):
        decoder = fake_decoder()
        decoder._import_hook(decoder.u, decoder.STUB, 4, None)
        self.assertTrue(decoder.u.stopped)
        self.assertIn("Unmodeled import", decoder.stop_reason)
        self.assertFalse(
            issubclass(recovery.NativeExecutionError, recovery.NativeRejected)
        )

    def test_interrupt_stops_without_host_forwarding(self):
        decoder = fake_decoder()
        decoder._interrupt(decoder.u, 2, None)
        self.assertTrue(decoder.u.stopped)
        self.assertIn("host forwarding is disabled", decoder.stop_reason)

    def test_timeout_or_budget_cannot_count_as_return(self):
        decoder = fake_decoder()
        with self.assertRaisesRegex(recovery.NativeExecutionError, "did not return"):
            decoder._call(recovery.DECODER, 0, indirect=0)

    def test_allocator_limit_rejected(self):
        decoder = fake_decoder()
        decoder.next_address = decoder.HEAP + decoder.HEAP_SIZE - 16
        decoder.allocations = {}
        with self.assertRaises(recovery.NativeExecutionError):
            decoder.malloc(17)


if __name__ == "__main__":
    unittest.main()
