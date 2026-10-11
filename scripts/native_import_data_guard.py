"""Bind actual imported data and reject stub bytes as guest/adapter data.

Host reads outside emu_start remain available for trusted inspection/receipts.
This does not model platform stream startup or identify a device's libc.
"""

import collections, hashlib, io, struct
from pathlib import Path
from elftools.elf.elffile import ELFFile

PINS = {
    "libg": "347afc57c8d168bb67d0defa488a89f76297025cac1e8544b5182bb7e70ff433",
    "libcxx": "4397241b4bd20a8e579bfb41d21107857e12985f6a01ca0c2a5f83380d1270b4",
    "bionic": "9f1f93bbd186af5c40a93f6ca4425bfdce82b7f3b9c730e59bb5c7fa598593cf",
}


def read_elf(path, pin):
    raw = Path(path).read_bytes()
    if hashlib.sha256(raw).hexdigest() != pin:
        raise ValueError("Unrecognized import-data input")
    return ELFFile(io.BytesIO(raw))


def symbols(elf):
    table = elf.get_section_by_name(".dynsym")
    return table or next(
        (s for s in elf.iter_segments() if s["p_type"] == "PT_DYNAMIC")
    )


class NativeImportDataGuard:

    def __init__(self, engine, library, libcxx, bionic, attachment):
        self.engine = engine
        self.events = []
        self.depth = 0
        self.bindings = []
        self.data_inventory = []
        if getattr(engine, "native_import_data_guard", None):
            raise ValueError("Import data guard already attached")
        if attachment.engine is not engine:
            raise ValueError("Bionic attachment engine mismatch")
        libraries = [
            ("libg", engine.BASE, read_elf(library, PINS["libg"])),
            ("libcxx", 805306368, read_elf(libcxx, PINS["libcxx"])),
            ("bionic", attachment.BASE, read_elf(bionic, PINS["bionic"])),
        ]
        exports = {}
        for label, base, elf in libraries[1:]:
            for symbol in symbols(elf).iter_symbols():
                if (
                    symbol["st_shndx"] not in ("SHN_UNDEF", "SHN_ABS")
                    and symbol["st_info"]["type"] == "STT_OBJECT"
                ):
                    if symbol.name in exports:
                        raise ValueError("Ambiguous native data export " + symbol.name)
                    exports[symbol.name] = (
                        base + symbol["st_value"],
                        symbol["st_size"],
                        label,
                    )
        pending = []
        for label, base, elf in libraries[:2]:
            dyn = next((s for s in elf.iter_segments() if s["p_type"] == "PT_DYNAMIC"))
            symtab = symbols(elf)
            for table in dyn.get_relocation_tables().values():
                for relocation in table.iter_relocations():
                    if relocation["r_info_type"] not in (257, 1025, 1026):
                        continue
                    symbol = symtab.get_symbol(relocation["r_info_sym"])
                    if (
                        symbol["st_shndx"] != "SHN_UNDEF"
                        or symbol["st_info"]["type"] != "STT_OBJECT"
                    ):
                        continue
                    name = symbol.name
                    if name not in exports:
                        raise ValueError("Unresolved imported data object " + name)
                    target, length, provider = exports[name]
                    site = base + relocation["r_offset"]
                    addend = relocation["r_addend"]
                    value = target + addend
                    if length <= 0 or not target <= value < target + length:
                        raise ValueError(
                            "Imported data addend outside exported object " + name
                        )
                    pending.append((site, value))
                    self.data_inventory.append(
                        {
                            "consumer": label,
                            "symbol": name,
                            "provider": provider,
                            "object_bytes": length,
                            "site": hex(site),
                            "value": hex(value),
                        }
                    )
        for site, value in pending:
            previous = engine.pointer(site)
            if previous != value:
                engine.write64(site, value)
                self.bindings.append(
                    {"site": hex(site), "previous": hex(previous), "target": hex(value)}
                )
        self.ranges = [
            (engine.STUB, engine.STUB + 1048576),
            (attachment.STUB, attachment.STUB + 65536),
        ]
        self.original_mem_read = engine.u.mem_read
        self.original_mem_write = engine.u.mem_write
        self.original_emu_start = engine.u.emu_start
        self.hooks = []
        self.hooks.append(
            engine.u.hook_add(
                engine.unicorn.UC_HOOK_MEM_READ | engine.unicorn.UC_HOOK_MEM_WRITE,
                self._guest_access,
            )
        )
        if getattr(attachment, "stub_read_hook", None) is not None:
            engine.u.hook_del(attachment.stub_read_hook)
            attachment.stub_read_hook = None
        engine.u.mem_read = self._host_read
        engine.u.mem_write = self._host_write
        engine.u.emu_start = self._emulate
        engine.native_import_data_guard = self

    def _overlap(self, address, length):
        return length > 0 and any(
            (address < high and low < address + length for low, high in self.ranges)
        )

    def _reason(self, kind, address, length):
        record = {
            "kind": kind,
            "address": hex(address),
            "bytes": length,
            "pc": hex(self.engine.u.reg_read(self.engine.reg.UC_ARM64_REG_PC)),
        }
        self.events.append(record)
        return f"UNSUPPORTED_IMPORT_STUB_DATA_{kind} address={address:#x} size={length}"

    def _guest_access(self, uc, access, address, size, value, user):
        if not self._overlap(address, size):
            return
        self.engine.stop_reason = self._reason("GUEST_ACCESS", address, size)
        uc.emu_stop()

    def _host_read(self, address, length):
        if self.depth and self._overlap(address, length):
            raise ValueError(self._reason("ADAPTER_READ", address, length))
        return self.original_mem_read(address, length)

    def _host_write(self, address, data):
        if self.depth and self._overlap(address, len(data)):
            raise ValueError(self._reason("ADAPTER_WRITE", address, len(data)))
        return self.original_mem_write(address, data)

    def _emulate(self, *args, **kwargs):
        self.depth += 1
        try:
            return self.original_emu_start(*args, **kwargs)
        finally:
            self.depth -= 1

    def report(self):
        return {
            "imported_data_objects": self.data_inventory,
            "changed_data_bindings": self.bindings,
            "events": self.events,
            "guest_access_observation": "all native reads and writes; full interval intersection",
            "guarded_stub_ranges": [[hex(x), hex(y)] for x, y in self.ranges],
            "adapter_depth": self.depth,
            "scope": "Original imported objects bound from shipped libc++ or pinned official AOSP Bionic. Stub accesses fail during native execution and host adapters; trusted host inspection outside execution remains allowed. Bionic stream/runtime startup is not modeled.",
        }
