"""Versioned read-only receipts for explicit guest and adapter observations.

Not a restorable snapshot, complete Unicorn/CPU/host state, or Android oracle.
Opaque Unicorn state, hook registrations/callback closures, module contents,
Python container internals and external state remain outside this observation.
"""

from collections import Counter
import hashlib
import json
import platform
import struct
import sys
import types

SCHEMA = "native-state-receipt-v2"
BASE_REGISTERS = (
    tuple(f"X{i}" for i in range(31))
    + ("SP", "PC", "NZCV", "FPCR", "FPSR", "CPACR_EL1", "TPIDR_EL0")
    + tuple(f"Q{i}" for i in range(32))
)
# Each was independently write/read tested on an isolated ARM64 Unicorn2.1.4
# instance. Production receipt capture only reads, never writes these registers.
EXTRA_REGISTERS = (
    "PSTATE",
    "TPIDRRO_EL0",
    "TPIDR_EL1",
    "SP_EL0",
    "SP_EL1",
    "SP_EL2",
    "SP_EL3",
    "ELR_EL0",
    "ELR_EL1",
    "ELR_EL2",
    "ELR_EL3",
    "TTBR0_EL1",
    "TTBR1_EL1",
    "VBAR_EL0",
    "VBAR_EL1",
    "VBAR_EL2",
    "VBAR_EL3",
)


class StateReceipts:
    def __init__(self, engine):
        self.engine = engine
        self.immutable_bytes = {}
        self.attribute_names = tuple(vars(engine))
        self.register_names = BASE_REGISTERS + EXTRA_REGISTERS
        # Fail closed when a listed register is unavailable, rather than omit it.
        for name in self.register_names:
            engine.u.reg_read(getattr(engine.reg, "UC_ARM64_REG_" + name))
        self.configuration = self.read_configuration()
        self.configuration_sha256 = self.digest(self.configuration)

    def read_configuration(self):
        engine = self.engine
        return {
            "schema": SCHEMA,
            "python_implementation": platform.python_implementation(),
            "python_version": platform.python_version(),
            "host_byteorder": sys.byteorder,
            "unicorn_python_version": engine.unicorn.__version__,
            "unicorn_native_version": list(engine.unicorn.uc_version()),
            "engine_class_mro": [
                c.__module__ + "." + c.__qualname__ for c in type(engine).__mro__
            ],
            "unicorn_arch": engine.u.ctl_get_arch(),
            "unicorn_mode": engine.u.ctl_get_mode(),
            "unicorn_cpu_model": engine.u.ctl_get_cpu_model(),
            "unicorn_page_size": engine.u.ctl_get_page_size(),
            "register_names": list(self.register_names),
            "engine_constants": {
                name: self.serialize(getattr(engine, name))
                for name in ("BASE", "HEAP", "HEAP_SIZE", "STACK", "STUB", "STOP")
                if hasattr(engine, name)
            },
        }

    @staticmethod
    def digest(value):
        raw = json.dumps(
            value, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
        return hashlib.sha256(raw).hexdigest()

    def serialize(self, value, seen=None):
        """Typed graph encoding; preserve observed container order and aliases.

        Object numbers are traversal indices, not process-specific Python ids.
        Unknown subclasses are rejected. Modules are identity references ONLY.
        Set/frozenset iteration order is observed; internal hash tables are not.
        """
        if seen is None:
            seen = {}
        kind = type(value)
        if value is None:
            return ["none"]
        if kind is bool:
            return ["bool", value]
        if kind is int:
            return ["int", str(value)]
        if kind is str:
            return ["str", value]
        if kind is float:
            return ["float64_bits", struct.pack(">d", value).hex()]
        if kind is bytes:
            key = id(value)
            if key not in self.immutable_bytes:
                self.immutable_bytes[key] = (value, hashlib.sha256(value).hexdigest())
            return ["bytes_sha256", len(value), self.immutable_bytes[key][1]]
        if kind is types.ModuleType:
            return ["module_reference", value.__name__]
        tags = {
            dict: "dict",
            Counter: "collections.Counter",
            list: "list",
            tuple: "tuple",
            set: "set",
            frozenset: "frozenset",
        }
        if kind not in tags:
            raise TypeError(
                "Uncaptured adapter state type: "
                + kind.__module__
                + "."
                + kind.__qualname__
            )
        key = id(value)
        if key in seen:
            return ["reference", seen[key]]
        index = len(seen)
        seen[key] = index
        if kind in (dict, Counter):
            children = [
                [self.serialize(k, seen), self.serialize(v, seen)]
                for k, v in value.items()
            ]
        else:
            children = [self.serialize(v, seen) for v in value]
        return [tags[kind], index, children]

    def capture(self, tick):
        e = self.engine
        if tuple(vars(e)) != self.attribute_names:
            raise ValueError(
                "Adapter attribute names or insertion order changed during capture"
            )
        if self.digest(self.read_configuration()) != self.configuration_sha256:
            raise ValueError("Explicit engine configuration changed during capture")
        regions = []
        for start, end, permissions in e.u.mem_regions():
            h = hashlib.sha256()
            for address in range(start, end + 1, 1048576):
                h.update(e.u.mem_read(address, min(1048576, end + 1 - address)))
            regions.append(
                {
                    "start": hex(start),
                    "end_inclusive": hex(end),
                    "permissions": permissions,
                    "sha256": h.hexdigest(),
                }
            )
        registers = {
            name: hex(e.u.reg_read(getattr(e.reg, "UC_ARM64_REG_" + name)))
            for name in self.register_names
        }
        fields = {key: value for key, value in vars(e).items() if key != "u"}
        field_hashes = {
            key: self.digest(self.serialize(value)) for key, value in fields.items()
        }
        graph_hash = self.digest(self.serialize(fields))
        receipt = {
            "schema": SCHEMA,
            "tick": tick,
            "regions": regions,
            "registers": registers,
            "adapter_field_sha256": field_hashes,
            "adapter_graph_sha256": graph_hash,
            "configuration_sha256": self.configuration_sha256,
        }
        # Include tick in the hashed observation, unlike v1.
        receipt["receipt_sha256"] = self.digest(receipt)
        return receipt
