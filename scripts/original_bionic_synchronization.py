"""Route original Bionic mutex/condition routines before all guest initialization.

This adds no mutex/condition algorithm or wake/timeout model. Original routines
write their own state. Any reached kernel operation still passes through the
existing fail-closed platform boundary. Only one explicitly identified guest
thread is supported; this is not a scheduler or Android thread startup.
"""

import hashlib
import io
from pathlib import Path


class OriginalBionicSynchronization:

    def __init__(self, engine, attachment, libc_path, *, single_thread, thread_id):
        if single_thread is not True:
            raise ValueError("Explicit single-thread platform required")
        if type(thread_id) is not int or thread_id != 1:
            raise ValueError(
                "Only explicit thread_id=1 matches the existing gettid boundary"
            )
        if attachment.engine is not engine:
            raise ValueError("Wrong Bionic attachment engine")
        if getattr(engine, "original_synchronization", None) is not None:
            raise ValueError("Original synchronization already attached")
        for field in (
            "mutexes",
            "mutex_attributes",
            "initialized_mutex_types",
            "condition_attributes",
            "initialized_conditions",
        ):
            if getattr(engine, field, None):
                raise ValueError(
                    "Cannot replace populated modeled synchronization state: " + field
                )
        for field in ("import_calls", "extra_calls"):
            counter = getattr(engine, field, {})
            if any(
                (
                    count
                    and name.rsplit(":", 1)[-1].startswith(
                        ("pthread_mutex", "pthread_cond")
                    )
                    for name, count in counter.items()
                )
            ):
                raise ValueError("Cannot switch after modeled synchronization calls")
        if engine.word(attachment.synthetic_thread + 16):
            raise ValueError("Synthetic Bionic thread ID already initialized")
        raw = Path(libc_path).read_bytes()
        if hashlib.sha256(raw).hexdigest() != attachment.sha256:
            raise ValueError("Different Bionic image")
        from elftools.elf.elffile import ELFFile

        symbols = ELFFile(io.BytesIO(raw)).get_section_by_name(".dynsym")
        targets = {}
        for symbol in symbols.iter_symbols():
            name = symbol.name
            if (
                name.startswith(("pthread_mutex", "pthread_cond"))
                and symbol["st_shndx"] != "SHN_UNDEF"
                and (symbol["st_info"]["type"] == "STT_FUNC")
            ):
                if name in attachment.targets:
                    raise ValueError("Synchronization export already routed: " + name)
                targets[name] = attachment.BASE + symbol["st_value"]
        if (
            not {"pthread_mutex_lock", "pthread_mutex_unlock", "pthread_cond_wait"}
            <= targets.keys()
        ):
            raise ValueError("Incomplete original synchronization export inventory")
        self.engine = engine
        self.attachment = attachment
        self.thread_id = thread_id
        self.entries = {}
        self.hooks = []
        self.targets = targets
        engine.write32(attachment.synthetic_thread + 16, thread_id)
        attachment.targets.update(targets)
        for name, target in targets.items():
            self.hooks.append(
                engine.u.hook_add(
                    engine.unicorn.UC_HOOK_CODE,
                    self._entry,
                    user_data=name,
                    begin=target,
                    end=target,
                )
            )
        engine.original_synchronization = self

    def _entry(self, uc, pc, size, name):
        self.entries[name] = self.entries.get(name, 0) + 1

    def report(self):
        return {
            "original_function_entries": dict(self.entries),
            "routed_original_exports": sorted(self.targets),
            "synthetic_thread_id": self.thread_id,
            "thread_id_address": hex(self.attachment.synthetic_thread + 16),
            "scope": "Original pinned AOSP Bionic mutex/condition routines; one synthetic guest thread, TID1. No host synchronization algorithm, scheduler, waiter, timeout, or new futex model. Unsupported kernel paths fail through the existing boundary.",
        }
