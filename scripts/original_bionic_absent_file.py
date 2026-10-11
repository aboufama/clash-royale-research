"""Execute pinned Bionic fopen/stat for an explicit, verified absent read-only path.

Only the observed ARM64 openat/newfstatat kernel ABIs receive raw -ENOENT. Native
Bionic performs mode parsing, errno/TLS writes, and the error return. This is not a
filesystem implementation: every other path, mode, syscall, or flag is rejected.
The caller must establish absence in its declared input namespace before use.
"""

import hashlib, io
from pathlib import Path


class OriginalBionicAbsentFile:
    def __init__(self, engine, attachment, libc_path, *, verified_absent_paths):
        if engine is not attachment.engine:
            raise ValueError("Wrong Bionic file engine")
        if any(name in attachment.targets for name in ("fopen", "stat")):
            raise ValueError("Original file API already routed")
        for field in ("import_calls", "extra_calls"):
            if any(
                count and name.rsplit(":", 1)[-1] in ("fopen", "stat")
                for name, count in getattr(engine, field, {}).items()
            ):
                raise ValueError("Cannot switch after modeled file API")
        if (
            type(verified_absent_paths) is not tuple
            or not 1 <= len(verified_absent_paths) <= 16
        ):
            raise ValueError("Explicit finite verified absence tuple required")
        if any(
            type(p) is not bytes or not 1 <= len(p) < 4096 or b"\0" in p
            for p in verified_absent_paths
        ):
            raise ValueError("Invalid verified absent pathname")
        if len(set(verified_absent_paths)) != len(verified_absent_paths):
            raise ValueError("Duplicate absent pathname")
        raw = Path(libc_path).read_bytes()
        if hashlib.sha256(raw).hexdigest() != attachment.sha256:
            raise ValueError("Different Bionic image")
        from elftools.elf.elffile import ELFFile

        symbols = ELFFile(io.BytesIO(raw)).get_section_by_name(".dynsym")
        symbol = symbols.get_symbol_by_name("fopen")[0]
        if symbol["st_value"] != 0xB6190 or symbol["st_size"] != 392:
            raise ValueError("Unexpected original fopen symbol")
        self.engine = engine
        self.attachment = attachment
        self.paths = verified_absent_paths
        self.pending = None
        self.events = []
        self.entries = {"fopen": 0, "stat": 0}
        self.file_allocations = 0
        self.rejections = []
        address = attachment.BASE + symbol["st_value"]
        attachment.targets["fopen"] = address
        self.entry_hook = engine.u.hook_add(
            engine.unicorn.UC_HOOK_CODE,
            self._entry,
            user_data="fopen",
            begin=address,
            end=address,
        )
        stat = symbols.get_symbol_by_name("stat")[0]
        if stat["st_value"] != 0x69A80 or stat["st_size"] != 24:
            raise ValueError("Unexpected original stat symbol")
        address = attachment.BASE + stat["st_value"]
        attachment.targets["stat"] = address
        self.stat_hook = engine.u.hook_add(
            engine.unicorn.UC_HOOK_CODE,
            self._entry,
            user_data="stat",
            begin=address,
            end=address,
        )
        allocator = attachment.BASE + 0xB5A7C
        self.allocation_hook = engine.u.hook_add(
            engine.unicorn.UC_HOOK_CODE,
            self._allocation,
            begin=allocator,
            end=allocator,
        )

    def _cstring(self, address, bound):
        data = bytearray()
        for offset in range(bound):
            value = bytes(self.engine.u.mem_read(address + offset, 1))
            if value == b"\0":
                return bytes(data)
            data.extend(value)
        raise ValueError("Unterminated file boundary string")

    def _entry(self, u, pc, size, function):
        e = self.engine
        r = e.reg
        try:
            if self.pending is not None:
                raise ValueError("Nested/unresolved original file call unsupported")
            path_pointer = u.reg_read(r.UC_ARM64_REG_X0)
            other = u.reg_read(r.UC_ARM64_REG_X1)
            path = self._cstring(path_pointer, 4096)
            if path not in self.paths:
                raise ValueError("Outside verified absent pathname domain")
            if function == "fopen" and self._cstring(other, 8) != b"rb":
                raise ValueError("Outside verified read-only fopen mode")
            if function == "stat" and not other:
                raise ValueError("Null stat output buffer unsupported")
            self.entries[function] += 1
            self.pending = (
                function,
                path_pointer,
                path,
                other,
                u.reg_read(r.UC_ARM64_REG_LR),
            )
        except Exception as error:
            self.rejections.append(str(error))
            e.stop_reason = str(error)
            u.emu_stop()

    def _allocation(self, u, pc, size, user):
        self.file_allocations += 1
        self.engine.stop_reason = "Unexpected native FILE allocation on absent path"
        u.emu_stop()

    def handle_interrupt(self, u, number):
        e = self.engine
        r = e.reg
        if u is not e.u:
            raise ValueError("Wrong Bionic file emulator")
        pc = u.reg_read(r.UC_ARM64_REG_PC)
        syscall = u.reg_read(r.UC_ARM64_REG_X8)
        expected = {
            56: (self.attachment.BASE + 0xAA938, "fopen"),
            79: (self.attachment.BASE + 0xAA9B8, "stat"),
        }
        if number != 2 or syscall not in expected or pc != expected[syscall][0]:
            return False
        args = [u.reg_read(r.UC_ARM64_REG_X0 + i) for i in range(6)]
        if self.pending is None:
            raise ValueError("Unattributed original file syscall")
        function, pointer, path, other, caller = self.pending
        if function != expected[syscall][1]:
            raise ValueError("Original file API/syscall mismatch")
        required = (
            [0xFFFFFF9C, pointer, 0, 0]
            if function == "fopen"
            else [0xFFFFFF9C, pointer, other, 0]
        )
        expected_lr = self.attachment.BASE + 0x6520C if function == "fopen" else caller
        if args[:4] != required or u.reg_read(r.UC_ARM64_REG_LR) != expected_lr:
            raise ValueError("Unsupported original file syscall ABI/flags")
        if self._cstring(pointer, 4096) != path or path not in self.paths:
            raise ValueError("Original pathname changed before syscall")
        # ARM64 openat and newfstatat consume exactly x0..x3. x4/x5 are unchanged
        # caller-clobbered registers, not extra arguments to these kernel operations.
        self.events.append(
            {
                "syscall": syscall,
                "entry_pc_elf_va": hex(pc - self.attachment.BASE),
                "operation": "openat" if function == "fopen" else "newfstatat",
                "dirfd_u64": "0xffffff9c",
                "path_hex": path.hex(),
                "flags": 0,
                "mode": 0 if function == "fopen" else None,
                "unused_x4_x5": [hex(v) for v in args[4:]],
                "kernel_result": -2,
                "source": "caller-verified absence in explicit input namespace",
            }
        )
        # Do not write errno, stat output, or skip original libc error handling.
        self.pending = None
        u.reg_write(r.UC_ARM64_REG_X0, 0xFFFFFFFFFFFFFFFE)
        return True

    def report(self):
        return {
            "verified_absent_paths_hex": [p.hex() for p in self.paths],
            "original_function_entries": dict(self.entries),
            "original_FILE_allocations": self.file_allocations,
            "kernel_events": self.events,
            "pending_operation": self.pending is not None,
            "rejections": self.rejections,
            "scope": "Original pinned AOSP Bionic fopen/stat/error/TLS paths; exact read-only openat/newfstatat kernel ENOENT for caller-verified finite absent path set. No present-file or general filesystem behavior; no stream allocator or stat-buffer substitution.",
        }
