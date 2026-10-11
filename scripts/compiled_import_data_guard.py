"""Optional compiled host observer for complete import-stub access intervals.

Build the authored import_data_observer.c locally and pass observer_library.
Original guest code stays in Unicorn. The reference guard supplies original
data binding and host-access wrappers. This is version-pinned instrumentation,
not a complete emulator-state receipt, rollback mechanism, or parity proof.
Discard failed nested engines instead of trying to resume them.
"""

import ctypes
from pathlib import Path
from native_import_data_guard import NativeImportDataGuard


class Range(ctypes.Structure):
    _fields_ = [("low", ctypes.c_uint64), ("high", ctypes.c_uint64)]


class State(ctypes.Structure):
    _fields_ = [
        ("stop", ctypes.c_void_p),
        ("read", ctypes.c_void_p),
        ("ranges", Range * 8),
        ("range_count", ctypes.c_uint32),
        ("pc_register", ctypes.c_int32),
        ("address", ctypes.c_uint64),
        ("pc", ctypes.c_uint64),
        ("access", ctypes.c_int32),
        ("size", ctypes.c_int32),
        ("read_error", ctypes.c_int32),
        ("stop_error", ctypes.c_int32),
        ("violated", ctypes.c_uint32),
    ]


class CompiledImportDataGuard(NativeImportDataGuard):
    def __init__(self, *args, observer_library, **kwargs):
        self.native_state = None
        super().__init__(*args, **kwargs)
        import unicorn
        from unicorn.unicorn_py3 import unicorn as backend

        if unicorn.__version__ != "2.1.4":
            raise ValueError("Unverified native Unicorn hook ABI")
        self.library = ctypes.CDLL(str(Path(observer_library).resolve()))
        self.library.cr_guard_size.restype = ctypes.c_size_t
        if self.library.cr_guard_size() != ctypes.sizeof(State):
            raise ValueError("Native guard state ABI mismatch")
        self.library.cr_guard_init.argtypes = [
            ctypes.POINTER(State),
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.POINTER(Range),
            ctypes.c_uint,
        ]
        self.library.cr_guard_init.restype = ctypes.c_int
        self.library.cr_guard_reset.argtypes = [ctypes.POINTER(State)]
        self.library.cr_guard_reset.restype = None
        self.native_state = State()
        self.compiled_ranges = tuple(self.ranges)
        self.native_event_reported = False
        ranges = (Range * len(self.ranges))(*(Range(*x) for x in self.ranges))
        result = self.library.cr_guard_init(
            ctypes.byref(self.native_state),
            ctypes.cast(backend.uclib.uc_emu_stop, ctypes.c_void_p),
            ctypes.cast(backend.uclib.uc_reg_read, ctypes.c_void_p),
            self.engine.reg.UC_ARM64_REG_PC,
            ranges,
            len(self.ranges),
        )
        if result:
            raise ValueError("Native guard initialization failed: " + str(result))
        handle = ctypes.c_size_t()
        result = backend.uclib.uc_hook_add(
            self.engine.u._uch,
            ctypes.byref(handle),
            unicorn.UC_HOOK_MEM_READ | unicorn.UC_HOOK_MEM_WRITE,
            ctypes.cast(self.library.cr_guard_hook, ctypes.c_void_p),
            ctypes.cast(ctypes.byref(self.native_state), ctypes.c_void_p),
            ctypes.c_uint64(1),
            ctypes.c_uint64(0),
        )
        if result:
            raise unicorn.UcError(result)
        # Hold all callback/state references for the engine lifetime. The native
        # hook is installed before the slower reference hook is removed.
        self.native_handle = handle.value
        self.backend = backend
        for old in self.hooks:
            self.engine.u.hook_del(old)
        self.hooks = []

    def _emulate(self, *args, **kwargs):
        outer = self.depth == 0
        if self.native_state is not None and tuple(self.ranges) != self.compiled_ranges:
            raise ValueError("Compiled guard range configuration changed")
        if outer and self.native_state is not None:
            self.library.cr_guard_reset(ctypes.byref(self.native_state))
            self.native_event_reported = False
        try:
            return super()._emulate(*args, **kwargs)
        finally:
            state = self.native_state
            if state is not None and state.violated:
                event = {
                    "kind": "GUEST_ACCESS",
                    "address": hex(state.address),
                    "bytes": state.size,
                    "pc": hex(state.pc),
                }
                if not self.native_event_reported:
                    self.events.append(event)
                    self.native_event_reported = True
                reason = (
                    f"UNSUPPORTED_IMPORT_STUB_DATA_GUEST_ACCESS "
                    f"address={state.address:#x} size={state.size}"
                )
                if state.read_error or state.stop_error:
                    reason += f" native observer API failure {state.read_error}/{state.stop_error}"
                self.engine.stop_reason = reason
                raise ValueError(reason)
