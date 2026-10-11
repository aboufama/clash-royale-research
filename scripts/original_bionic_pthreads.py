"""Original Bionic pthread once/key calls with explicit isolated-thread storage.

Native code performs all once/key bookkeeping. The one modeled kernel action
is a verified FUTEX_WAKE_PRIVATE with no other guest threads/waiters.
"""

import hashlib, io, struct
from pathlib import Path


class OriginalBionicPthreads:

    def __init__(self, engine, attachment, libc_path, *, single_thread):
        if single_thread is not True:
            raise ValueError("Explicit single-thread platform required")
        if getattr(engine, "thread_keys", {}):
            raise ValueError("Cannot mix modeled and original pthread key namespaces")
        if getattr(engine, "next_thread_key", 0):
            raise ValueError("Cannot replace historical modeled pthread keys")
        for field in ("import_calls", "extra_calls"):
            if any(
                (
                    count
                    and name.rsplit(":", 1)[-1]
                    in (
                        "pthread_once",
                        "pthread_key_create",
                        "pthread_key_delete",
                        "pthread_getspecific",
                        "pthread_setspecific",
                        "__cxa_thread_atexit_impl",
                    )
                    for name, count in getattr(engine, field, {}).items()
                )
            ):
                raise ValueError("Cannot switch after modeled pthread/TLS calls")
        self.engine = engine
        self.attachment = attachment
        self.events = []
        self.pending_once = set()
        self.entries = {}
        raw = Path(libc_path).read_bytes()
        if hashlib.sha256(raw).hexdigest() != attachment.sha256:
            raise ValueError("Different Bionic image")
        from elftools.elf.elffile import ELFFile

        symbols = ELFFile(io.BytesIO(raw)).get_section_by_name(".dynsym")
        tls = engine.u.reg_read(engine.reg.UC_ARM64_REG_TPIDR_EL0)
        slot = tls - 8
        page = slot & -4096
        if not any(
            (lo <= slot and slot + 7 <= hi for lo, hi, _ in engine.u.mem_regions())
        ):
            if any(
                (
                    page <= hi and lo < page + 4096
                    for lo, hi, _ in engine.u.mem_regions()
                )
            ):
                raise ValueError("Partial TLS prefix page overlap")
            engine.u.mem_map(
                page, 4096, engine.unicorn.UC_PROT_READ | engine.unicorn.UC_PROT_WRITE
            )
        if engine.pointer(slot):
            raise ValueError("Existing Bionic key-storage pointer unsupported")
        self.key_storage = engine.allocate(130 * 16)
        self.tls_slot = slot
        engine.write64(slot, self.key_storage)
        self.hooks = []
        for name in (
            "pthread_once",
            "pthread_key_create",
            "pthread_key_delete",
            "pthread_getspecific",
            "pthread_setspecific",
            "__cxa_thread_atexit_impl",
        ):
            target = attachment.BASE + symbols.get_symbol_by_name(name)[0]["st_value"]
            attachment.targets[name] = target
            self.hooks.append(
                engine.u.hook_add(
                    engine.unicorn.UC_HOOK_CODE,
                    self._entry,
                    user_data=name,
                    begin=target,
                    end=target,
                )
            )

    def _entry(self, u, pc, size, name):
        self.entries[name] = self.entries.get(name, 0) + 1
        if name == "pthread_once":
            pointer = u.reg_read(self.engine.reg.UC_ARM64_REG_X0)
            if self.engine.word(pointer) == 0:
                self.pending_once.add(pointer)

    def handle_interrupt(self, e, u, number):
        if e is not self.engine or u is not e.u:
            raise ValueError("Wrong pthread platform engine")
        r = e.reg
        pc = u.reg_read(r.UC_ARM64_REG_PC)
        syscall = u.reg_read(r.UC_ARM64_REG_X8)
        if number != 2 or syscall != 98 or pc != self.attachment.BASE + 351776:
            return False
        args = [u.reg_read(r.UC_ARM64_REG_X0 + i) for i in range(6)]
        address, operation, count, a3, a4, a5 = args
        if (
            address not in self.pending_once
            or operation != 129
            or count != 2147483647
            or any((a3, a4, a5))
            or (e.word(address) != 2)
        ):
            raise ValueError("Unsupported Bionic futex operation/state")
        self.events.append(
            {
                "syscall": 98,
                "operation": "FUTEX_WAKE_PRIVATE",
                "address": hex(address),
                "count": count,
                "result": 0,
                "platform_assumption": "one guest thread; no waiters",
            }
        )
        self.pending_once.remove(address)
        u.reg_write(r.UC_ARM64_REG_X0, 0)
        return True

    def report(self):
        return {
            "original_function_entries": self.entries,
            "kernel_events": self.events,
            "native_thread_destructor_head": hex(
                self.engine.pointer(self.attachment.synthetic_thread + 232)
            ),
            "pending_once_controls": [hex(x) for x in sorted(self.pending_once)],
            "synthetic_thread_key_storage": {
                "tls_slot": hex(self.tls_slot),
                "storage": hex(self.key_storage),
                "keys": 130,
                "record_bytes": 16,
            },
            "scope": "Original Bionic once/key/destructor-registration algorithms; explicit single-thread TLS storage and zero-waiter futex wake boundary. No destructor execution, thread creation, contention, or Android thread startup modeled.",
        }
