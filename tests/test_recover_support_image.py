"""Synthetic tests of replay and snapshot boundaries; no game data fixtures."""

import copy
import hashlib
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import recover_support_image as support


def registers():
    names = [f"x{i}" for i in range(31)] + ["sp", "pc", "pstate"]
    return {name: hex(i) for i, name in enumerate(names)}


def snapshot():
    return {
        "registers": registers(),
        "images": [(0x1000, b"abcd"), (0x2000, b"xyz")],
        "report": {"thread_states": {"0": {"status": "waiting"}}},
    }


def result():
    return {
        "report": {
            "constructor_returned": True,
            "jni_returned": False,
            "stop_reason": "synthetic boundary",
            "jni_pc": "0x1000",
        },
        "image": b"synthetic image",
    }


class ReplayTests(unittest.TestCase):
    def test_original_generated_messages_keep_order(self):
        report = {
            "ipc_writes": [
                {"target": "pipe:test", "payload": item, "pc": "0x1"}
                for item in ("0102", "aabbcc")
            ]
        }
        self.assertEqual(
            support.messages(report, "pipe:test", [2, 3]),
            {"pipe:test": ["0102", "aabbcc"]},
        )
        self.assertEqual(report["ipc_writes"][0]["payload"], "0102")

    def test_wrong_message_count_target_and_fields_fail(self):
        for record in (
            {"target": "other", "payload": "00", "pc": "0x1"},
            {"target": "pipe:test", "payload": "00"},
            {"target": "pipe:test", "payload": "00", "pc": "0x1", "extra": True},
        ):
            with self.subTest(record=record), self.assertRaises(ValueError):
                support.messages({"ipc_writes": [record]}, "pipe:test", [1])
        with self.assertRaisesRegex(ValueError, "count"):
            support.messages({"ipc_writes": []}, "pipe:test", [1])

    def test_invalid_payload_lengths_and_encodings_fail(self):
        for payload in ("", "0", "0000", "GG", "AA", " 0", None, b"00"):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                support.messages(
                    {
                        "ipc_writes": [
                            {"target": "pipe:test", "payload": payload, "pc": "0x1"}
                        ]
                    },
                    "pipe:test",
                    [1],
                )


class SnapshotTests(unittest.TestCase):
    def test_memory_and_metadata_copies_are_isolated(self):
        source = snapshot()
        peer = support.clone_snapshot(source)
        support.write_peer(peer, 0x1001, b"XY")
        peer["report"]["thread_states"]["0"]["status"] = "changed"
        self.assertEqual(support.read_peer(peer, 0x1000, 4), b"aXYd")
        self.assertEqual(source["images"][0][1], b"abcd")
        self.assertEqual(source["report"]["thread_states"]["0"]["status"], "waiting")

    def test_peer_access_cannot_cross_region_or_overflow(self):
        peer = support.clone_snapshot(snapshot())
        for address, size in [
            (0x1003, 2),
            (0x0FFF, 2),
            (0x1500, 1),
            (-1, 1),
            (2**64 - 1, 2),
            (0x1000, -1),
        ]:
            with self.subTest(address=address, size=size), self.assertRaises(
                ValueError
            ):
                support.read_peer(peer, address, size)
        with self.assertRaises(ValueError):
            support.write_peer(peer, 0x1003, b"AB")
        self.assertEqual(support.read_peer(peer, 0x1000, 4), b"abcd")

    def test_snapshot_region_overlap_order_and_missing_rejected(self):
        for images in (
            [],
            [(0x1000, b"aa"), (0x1001, b"b")],
            [(0x2000, b"a"), (0x1000, b"b")],
            [(0x1000, b"")],
            [(0x1000, bytearray(b"a"))],
            [(2**64 - 1, b"ab")],
        ):
            value = snapshot()
            value["images"] = images
            with self.subTest(images=images), self.assertRaises(ValueError):
                support.clone_snapshot(value)

    def test_register_payload_uses_aarch64_order(self):
        self.assertEqual(
            struct.unpack("<34Q", support.register_payload(registers())),
            tuple(range(34)),
        )

    def test_invalid_missing_and_extra_registers_rejected(self):
        for key, value in [
            ("x0", "-1"),
            ("x0", "0Xff"),
            ("x0", 1),
            ("x0", hex(2**64)),
            ("bogus", "0x0"),
        ]:
            data = registers()
            data[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                support.register_payload(data)
        data = registers()
        del data["x30"]
        with self.assertRaises(ValueError):
            support.register_payload(data)


class AcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.expected = (
            "synthetic boundary",
            "0x1000",
            hashlib.sha256(b"synthetic image").hexdigest(),
        )
        self.patch = patch.dict(support.EXPECTED, {"test": self.expected})
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_exact_boundary_is_partial_not_initialized(self):
        support.validate_boundary(result(), "test")
        self.assertFalse(result()["report"]["jni_returned"])

    def test_unknown_stop_timeout_and_error_cannot_pass(self):
        for key, value in [
            ("constructor_returned", False),
            ("jni_returned", True),
            ("error", "native fault"),
            ("stop_reason", "unmodeled syscall"),
            ("stop_reason", None),
            ("jni_pc", "0x1004"),
        ]:
            value_result = result()
            value_result["report"][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                support.validate_boundary(value_result, "test")

    def test_image_change_cannot_be_normalized_away(self):
        value = result()
        value["image"] = b"synthetic imagf"
        with self.assertRaisesRegex(ValueError, "image differs"):
            support.validate_boundary(value, "test")

    def test_wrong_native_input_rejected_before_optional_dependencies(self):
        with self.assertRaisesRegex(ValueError, "Unrecognized"):
            support.run_branch(b"synthetic ELF", "parent")

    def test_native_size_bounds_and_bool_rejected(self):
        for size in (-1, True, 32 * 1024 * 1024 + 1, 1.0):
            with self.subTest(size=size), self.assertRaises(ValueError):
                support.bounded_size(size)
        self.assertEqual(support.bounded_size(0), 0)

    def test_output_path_and_symlink_escape_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "work").mkdir()
            (root / "outside").mkdir()
            (root / "work/escape").symlink_to(
                root / "outside", target_is_directory=True
            )
            self.assertEqual(
                support.private_output(root / "work/result", root), root / "work/result"
            )
            for output in (
                root / "work",
                root / "research/result",
                root / "work/escape/result",
            ):
                with self.subTest(output=output), self.assertRaises(ValueError):
                    support.private_output(output, root)


if __name__ == "__main__":
    unittest.main()
