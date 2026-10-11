"""Attach pinned official AOSP ARM64 Bionic locale functions to a native probe.

This is a platform recovery boundary, not the APK device's identified libc.
Original code handles locale/number conversion. The existing allocator, a
synthetic Bionic thread/TLS slot, and fixed IFUNC hardware features are explicit
platform inputs. Every unsupported import/TLSDESC invocation fails closed.
"""

import collections
import hashlib
import io
import struct
from pathlib import Path
from elftools.elf.elffile import ELFFile

LIBC_SHA256 = "9f1f93bbd186af5c40a93f6ca4425bfdce82b7f3b9c730e59bb5c7fa598593cf"
IFUNC_ABI_SOURCE = "https://android.googlesource.com/platform/bionic/+/46cce4899/libc/include/sys/ifunc.h"


class BionicLocaleAttachment:
    BASE = 536870912
    STUB = 570425344

    def __init__(self, engine, libc_path):
        self.engine = engine
        self.events = []
        self.platform_calls = collections.Counter()
        self.native_entries = collections.Counter()
        self.names = {}
        self.ifuncs = {}
        self.tlsdesc = []
        self.relocations = collections.Counter()
        raw = Path(libc_path).read_bytes()
        self.sha256 = hashlib.sha256(raw).hexdigest()
        if self.sha256 != LIBC_SHA256:
            raise ValueError("Unrecognized original Bionic libc")
        e = engine
        u = e.u
        elf = ELFFile(io.BytesIO(raw))
        symbols = elf.get_section_by_name(".dynsym")
        loads = [s for s in elf.iter_segments() if s["p_type"] == "PT_LOAD"]
        size = max((s["p_vaddr"] + s["p_memsz"] for s in loads)) + 4095 & -4096
        mappings = [(self.BASE, size), (self.STUB, 65536)]
        for base, length in mappings:
            if any(
                (base <= hi and lo < base + length for lo, hi, _ in u.mem_regions())
            ):
                raise ValueError("Bionic attachment mapping overlap")
        for base, length in mappings:
            u.mem_map(base, length)
        for s in loads:
            u.mem_write(
                self.BASE + s["p_vaddr"],
                raw[s["p_offset"] : s["p_offset"] + s["p_filesz"]],
            )
        self.text_regions = [
            (
                self.BASE + s["p_vaddr"],
                raw[s["p_offset"] : s["p_offset"] + s["p_filesz"]],
            )
            for s in loads
            if s["p_flags"] & 1
        ]
        for s in loads:
            lo = s["p_vaddr"] & -4096
            hi = s["p_vaddr"] + s["p_memsz"] + 4095 & -4096
            permission = (
                e.unicorn.UC_PROT_READ
                | (e.unicorn.UC_PROT_WRITE if s["p_flags"] & 2 else 0)
                | (e.unicorn.UC_PROT_EXEC if s["p_flags"] & 1 else 0)
            )
            u.mem_protect(self.BASE + lo, hi - lo, permission)
        u.mem_protect(self.STUB, 65536, e.unicorn.UC_PROT_READ | e.unicorn.UC_PROT_EXEC)
        tls = u.reg_read(e.reg.UC_ARM64_REG_TPIDR_EL0)
        if not (e.HEAP <= tls and tls + 16 <= e.HEAP + e.HEAP_SIZE):
            raise ValueError("Unsupported TLS base")
        if e.pointer(tls + 8):
            raise ValueError(
                "Bionic TLS thread slot already initialized; refuse overwrite"
            )
        self.synthetic_thread = e.allocate(1024)
        e.write64(tls + 8, self.synthetic_thread)
        self.errno_address = self.synthetic_thread + 768
        prior = getattr(getattr(e, "c_locale_boundary", None), "errno_address", None)
        if prior is not None:
            u.mem_write(self.errno_address, bytes(u.mem_read(prior, 4)))
        self.tls_base = tls
        self.hook = u.hook_add(
            e.unicorn.UC_HOOK_CODE,
            self._platform_hook,
            begin=self.STUB,
            end=self.STUB + 65535,
        )
        self.stub_read_hook = u.hook_add(
            e.unicorn.UC_HOOK_MEM_READ, self._reject_stub_read
        )
        pending = []

        def binding(symbol):
            if symbol.name == "malloc":
                return self._stub("modeled_existing_allocator:malloc")
            if symbol["st_shndx"] == "SHN_UNDEF":
                return (
                    0
                    if symbol["st_info"]["bind"] == "STB_WEAK"
                    else self._stub("UNSUPPORTED_IMPORT:" + symbol.name)
                )
            if symbol["st_shndx"] == "SHN_ABS":
                return symbol["st_value"]
            return self.BASE + symbol["st_value"]

        for sec in elf.iter_sections():
            if sec["sh_type"] != "SHT_RELA":
                continue
            for relocation in sec.iter_relocations():
                kind = relocation["r_info_type"]
                self.relocations[kind] += 1
                site = self.BASE + relocation["r_offset"]
                add = relocation["r_addend"]
                symbol = symbols.get_symbol(relocation["r_info_sym"])
                width = 16 if kind == 1030 else 8
                if any(
                    (
                        site < start + len(data) and start < site + width
                        for start, data in self.text_regions
                    )
                ):
                    raise ValueError("Unexpected executable relocation")
                if kind == 1027:
                    e.write64(site, self.BASE + add)
                elif kind == 1030:
                    e.write64(site, self._stub("UNSUPPORTED_TLSDESC"))
                    e.write64(site + 8, add)
                    self.tlsdesc.append(hex(relocation["r_offset"]))
                elif kind in (1025, 1026, 257):
                    if symbol["st_info"]["type"] == "STT_LOOS":
                        pending.append((site, symbol, add))
                    else:
                        e.write64(site, binding(symbol) + add)
                else:
                    raise ValueError("Unsupported relocation " + str(kind))
        if dict(self.relocations) != {1027: 924, 1025: 35, 257: 7, 1030: 1, 1026: 515}:
            raise ValueError("Unexpected Bionic relocation inventory")
        arg = e.allocate(24)
        u.mem_write(arg, struct.pack("<QQQ", 24, 3, 0))
        for site, symbol, add in pending:
            if symbol.name not in self.ifuncs:
                target = e.invoke(
                    self.BASE + symbol["st_value"] - e.BASE, [3 | 1 << 62, arg]
                )
                va = target - self.BASE
                if not any(
                    (
                        s["p_flags"] & 1
                        and s["p_vaddr"] <= va < s["p_vaddr"] + s["p_filesz"]
                        for s in loads
                    )
                ):
                    raise ValueError("IFUNC returned outside original text")
                self.ifuncs[symbol.name] = {
                    "resolver": hex(symbol["st_value"]),
                    "target": hex(va),
                }
            e.write64(
                site, self.BASE + int(self.ifuncs[symbol.name]["target"], 16) + add
            )
        self.targets = {
            name: self.BASE + symbols.get_symbol_by_name(name)[0]["st_value"]
            for name in ("newlocale", "strtoull_l", "__errno", "atof")
        }
        for name, address in self.targets.items():

            def observe(uc, pc, size, key):
                self.native_entries[key] += 1

            u.hook_add(
                e.unicorn.UC_HOOK_CODE,
                observe,
                user_data=name,
                begin=address,
                end=address,
            )
        for name, item in self.ifuncs.items():
            address = self.BASE + int(item["target"], 16)

            def observe_ifunc(uc, pc, size, key):
                self.native_entries["ifunc_body:" + key] += 1

            u.hook_add(
                e.unicorn.UC_HOOK_CODE,
                observe_ifunc,
                user_data=name,
                begin=address,
                end=address,
            )
        if not self.code_unchanged():
            raise ValueError("Original Bionic executable bytes changed")

    def _stub(self, name):
        for address, prior in self.names.items():
            if prior == name:
                return address
        address = self.STUB + 16 * len(self.names)
        self.names[address] = name
        return address

    def _reject_stub_read(self, uc, access, address, size, value, user):
        if not (address < self.STUB + 65536 and self.STUB < address + size):
            return
        self.platform_calls["UNSUPPORTED_BIONIC_STUB_DATA_READ"] += 1
        self.engine.stop_reason = (
            f"UNSUPPORTED_BIONIC_STUB_DATA_READ address={address:#x} size={size}"
        )
        uc.emu_stop()

    def _platform_hook(self, uc, pc, size, user):
        e = self.engine
        name = self.names.get(pc, "UNKNOWN_BIONIC_PLATFORM_STUB")
        self.platform_calls[name] += 1
        try:
            if name != "modeled_existing_allocator:malloc":
                raise ValueError(name)
            result = e.allocate(uc.reg_read(e.reg.UC_ARM64_REG_X0))
            uc.reg_write(e.reg.UC_ARM64_REG_X0, result)
            uc.reg_write(e.reg.UC_ARM64_REG_PC, uc.reg_read(e.reg.UC_ARM64_REG_LR))
        except Exception as ex:
            e.stop_reason = str(ex)
            uc.emu_stop()

    def handle(self, e, uc, name):
        if name not in self.targets:
            return False
        if e is not self.engine or uc is not e.u:
            raise ValueError("Wrong engine for Bionic attachment")
        self.events.append(
            {
                "function": name,
                "implementation": "original_aosp_bionic",
                "target_elf_va": hex(self.targets[name] - self.BASE),
            }
        )
        uc.reg_write(e.reg.UC_ARM64_REG_PC, self.targets[name])
        return True

    def code_unchanged(self):
        return all(
            (
                bytes(self.engine.u.mem_read(start, len(raw))) == raw
                for start, raw in self.text_regions
            )
        )

    def report(self):
        return {
            "libc_sha256": self.sha256,
            "base": hex(self.BASE),
            "ifunc_abi_source": IFUNC_ABI_SOURCE,
            "ifunc_inputs": {"size": 24, "hwcap": 3, "hwcap2": 0, "extended_bit": 62},
            "ifuncs": self.ifuncs,
            "relocations": dict(self.relocations),
            "unsupported_tlsdesc_sites": self.tlsdesc,
            "stub_data_reads_fail_closed": True,
            "platform_calls": dict(self.platform_calls),
            "native_entries": dict(self.native_entries),
            "synthetic_tls": {
                "tls": hex(self.tls_base),
                "thread": hex(self.synthetic_thread),
                "errno": hex(self.errno_address),
            },
            "executable_code_unchanged": self.code_unchanged(),
            "scope": "Original official AOSP libc, not identified APK-device libc; existing platform allocator and synthetic TLS/thread, fixed IFUNC capabilities; no native code patches",
        }
