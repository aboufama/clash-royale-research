"""Synthetic input/bounds tests only; no original code or data fixtures."""

from collections import Counter
import csv
import io
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import probe_original_pathfinding as probe


def rows():
    result = [
        [key, str(index + 1), ""]
        for index, key in enumerate(probe.NUMBER_FIELDS.values())
    ]
    result.extend(
        [key, "", "TRUE" if index % 2 else "FALSE"]
        for index, key in enumerate(probe.BOOLEAN_FIELDS.values())
    )
    return result


def csv_bytes(values, header=("Name", "NumberValue", "BooleanValue")):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(header)
    writer.writerows(values)
    return output.getvalue().encode()


class GlobalsTests(unittest.TestCase):
    def test_synthetic_numeric_boolean_fields(self):
        actual = probe.parse_globals(csv_bytes(rows()))
        self.assertEqual(len(actual), 12)
        self.assertEqual(actual["PATHFINDING_DEFAULT_COST"], 1)
        self.assertIs(actual["NEW_PATHFINDING_CODE"], False)

    def test_duplicate_required_row_rejected(self):
        data = rows()
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            probe.parse_globals(csv_bytes(data + [data[0]]))

    def test_missing_required_row_rejected(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            probe.parse_globals(csv_bytes(rows()[1:]))

    def test_unknown_bool_values_rejected(self):
        for value in ("", "true", "FALSE ", "0", "maybe"):
            data = rows()
            data[-1][2] = value
            with self.subTest(value=value), self.assertRaisesRegex(
                ValueError, "boolean"
            ):
                probe.parse_globals(csv_bytes(data))

    def test_int32_bounds_and_non_integer_rejected(self):
        for value in ("2147483648", "-2147483649", "1.0", " 5", "+1", "01"):
            data = rows()
            data[0][1] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                probe.parse_globals(csv_bytes(data))

    def test_duplicate_header_and_extra_required_cells_rejected(self):
        with self.assertRaisesRegex(ValueError, "columns"):
            probe.parse_globals(csv_bytes(rows(), ("Name", "Name", "BooleanValue")))
        data = rows()
        data[0].append("unexpected")
        with self.assertRaisesRegex(ValueError, "malformed"):
            probe.parse_globals(csv_bytes(data))

    def test_unrelated_globals_do_not_supply_defaults(self):
        data = rows() + [["unrelated", "not numeric", "not boolean"]]
        self.assertEqual(
            probe.parse_globals(csv_bytes(data)), probe.parse_globals(csv_bytes(rows()))
        )


class FixtureTests(unittest.TestCase):
    def test_all_synthetic_cases_are_explicit_and_bounded(self):
        cases = probe.synthetic_cases()
        self.assertEqual(len(cases), 12)
        for case in cases:
            probe.validate_case(case)
        self.assertEqual(sum(c["dynamic_enabled"] for c in cases), 3)
        cases[0]["cells"][0] = 99
        self.assertEqual(cases[1]["cells"][0], 0)

    def test_invalid_grid_index_count_and_values_rejected(self):
        changes = [
            ("start", -1),
            ("goal", 25),
            ("start", True),
            ("width", 6),
            ("dynamic_enabled", 1),
            ("cells", [0] * 24),
            ("cells", [0] * 24 + [-1]),
            ("dynamic_costs", [0] * 24 + [2**32]),
        ]
        for key, value in changes:
            case = probe.synthetic_cases()[0]
            case[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                probe.validate_case(case)

    def test_output_root_and_symlink_guard(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "work").mkdir()
            (root / "outside").mkdir()
            (root / "work/escape").symlink_to(
                root / "outside", target_is_directory=True
            )
            self.assertEqual(
                probe.private_output(root / "work/probe", root), root / "work/probe"
            )
            for target in [
                root / "research/probe",
                root / "work/escape/probe",
                root / "work/../outside",
            ]:
                with self.subTest(target=target), self.assertRaises(ValueError):
                    probe.private_output(target, root)

    def test_wrong_input_fails_before_native_dependencies(self):
        with self.assertRaisesRegex(ValueError, "Unrecognized"):
            probe.PathfindingProbe(b"synthetic image", b"synthetic ELF", {})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input"
            path.write_bytes(b"synthetic")
            with self.assertRaisesRegex(ValueError, "provenance"):
                probe.pinned_file(path, probe.LIBRARY_SHA, 1000)


class FakeEmulator:
    def __init__(self):
        self.registers, self.writes = {}, []
        self.stopped = False

    def reg_read(self, register):
        return self.registers.get(register, 0)

    def reg_write(self, register, value):
        self.registers[register] = value

    def emu_stop(self):
        self.stopped = True

    def emu_start(self, *args, **kwargs):
        pass

    def mem_write(self, address, data):
        self.writes.append((address, data))


def fake_probe():
    result = object.__new__(probe.PathfindingProbe)
    result.u = FakeEmulator()
    result.reg = SimpleNamespace(
        UC_ARM64_REG_X0=0, UC_ARM64_REG_PC=32, UC_ARM64_REG_SP=33, UC_ARM64_REG_LR=34
    )
    result.unicorn = SimpleNamespace(UcError=RuntimeError)
    result.names, result.allocations, result.fixture_regions = {}, {}, {}
    result.import_calls, result.stop_reason = Counter(), None
    result.next_address = result.HEAP + 0x100000
    return result


class NativeBoundaryTests(unittest.TestCase):
    def test_unknown_import_fails_closed(self):
        native = fake_probe()
        native._import_hook(native.u, native.STUB, 4, None)
        self.assertTrue(native.u.stopped)
        self.assertIn("Unmodeled import", native.stop_reason)

    def test_memory_import_cannot_write_original_image(self):
        native = fake_probe()
        native.names[native.STUB] = "memset"
        native.u.registers.update({0: native.BASE, 1: 0, 2: 4, 3: 4})
        native._import_hook(native.u, native.STUB, 4, None)
        self.assertTrue(native.u.stopped)
        self.assertIn("outside modeled heap/stack", native.stop_reason)
        self.assertEqual(native.u.writes, [])

    def test_checked_copy_respects_destination_bound(self):
        native = fake_probe()
        native.names[native.STUB] = "__memcpy_chk"
        native.u.registers.update({0: native.HEAP, 1: native.HEAP + 32, 2: 8, 3: 4})
        native._import_hook(native.u, native.STUB, 4, None)
        self.assertTrue(native.u.stopped)
        self.assertEqual(native.u.writes, [])

    def test_timeout_or_instruction_limit_cannot_pass(self):
        native = fake_probe()
        with self.assertRaisesRegex(probe.NativeProbeError, "no return"):
            native.invoke(probe.SEARCH, [0, 0, 24, 0])

    def test_interrupt_has_no_host_forwarding(self):
        native = fake_probe()
        native._interrupt(native.u, 2, None)
        self.assertTrue(native.u.stopped)
        self.assertIn("no host forwarding", native.stop_reason)

    def test_native_array_count_and_allocation_extent(self):
        native = fake_probe()
        native.allocations = {0x1000: 16}
        native.allocation_extent(0x1004, 12)
        with self.assertRaises(probe.NativeProbeError):
            native.allocation_extent(0x1004, 13)
        for count in [-1, 26]:
            with self.subTest(count=count), self.assertRaises(probe.NativeProbeError):
                native.read_array(0x1000, count)

    def test_inline_controller_vector_is_owned_fixture(self):
        native = fake_probe()
        native.fixture_regions = {0x2000: 0x100}
        native.owned_extent(0x2050, 8)
        with self.assertRaises(probe.NativeProbeError):
            native.owned_extent(0x20FC, 8)

    def test_allocator_exhaustion_is_fatal(self):
        native = fake_probe()
        native.next_address = native.HEAP + native.HEAP_SIZE - 16
        with self.assertRaises(probe.NativeProbeError):
            native.allocate(17)


if __name__ == "__main__":
    unittest.main()
