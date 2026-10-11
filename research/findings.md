# Investigation notes

## Scope

All addresses below are ELF virtual addresses for ARM64 build **160402020**,
unless explicitly labelled otherwise. A Ghidra import may add an image base;
the initial Ghidra projects used `0x100000`. The isolated emulator maps `libg`
at `0x10000000`. Do not confuse rebased addresses with file offsets.

## Verified baseline

The original bundle and extracted core libraries are pinned in the
[build record](builds/160402020.json). The base and native split pass Google's
APK signature verification. This checks the supplied artifacts; it does not
establish server/client behavior or completeness of remotely delivered assets.

JADX 1.5.6 processed 9,575 input classes and reported 200 decompilation errors.
Recovered startup code loads a supporting native library and enters native
game lifecycle functions. This is partial Java decompilation, not recovered
battle logic.

`libg.so` has no ordinary `.dynsym` section header. Its program-header dynamic
metadata still yields 566 symbols. `libsupercell_clashroyale.so` yields 241.
The `inspect_native.py` script uses those program headers directly.

Selected `libg` exports:

| Export | ELF virtual address |
| --- | --- |
| `JNI_OnLoad` | `0x146096c` |
| `GameApp_createGameMain` | `0x1460bd4` |
| `GameApp_getAllowedScreenRotations` | `0x1460b84` |

The bytes at these entries do not yet decode as expected ARM64 routines.
The ELF initializer at `0x1ae3c20` and helper at `0x1adf748` do disassemble.
Packing/runtime transformation is the current hypothesis; decompiler output
alone is not a demonstration that the gameplay payload was unpacked.

## Loader dependency

The isolated `libg` initializer opens a modeled `/proc/self/maps` and looks for
`libsupercell_clashroyale.so`. An independent XOR decode of its small loader
configuration recovers both strings. Its runtime state is at `0x1abf368`, and
the encoded configuration begins at `0x1abf3b0`.

It attempts a call to the support library at offset `0x681780`. That dispatcher
reads the function pointer at `0x6c6470`. In the baseline environment the support
library is missing, so lookup supplies no load base and execution stops at
unmapped address `0x681780`. See the
[baseline evidence](evidence/loader-baseline.json).

The initializer's modeled `/proc` reads and mprotect calls are not forwarded to
the host. A diagnostic run ending successfully as a Python process must not be
interpreted as successful native initialization. The current baseline does not
change the inspected gameplay entry bytes.

## Validation target

Continued interactions after disconnecting are consistent with substantial
client simulation. They do not, by themselves, distinguish prediction from
exact shared simulation. The client can advance local simulation time even
when authoritative input acceptance or outcomes are controlled by a server.

Before claiming any gameplay recovery, identify its update routine, establish
the required original state and data, and compare controlled per-tick outputs
against the original build. Repeat across collision, targeting, path choice,
deployment, knockback, attack timing, and random-event cases. Until then,
movement and battle equivalence remain unvalidated.

## Supporting constructor recovered

Static relocation analysis identifies the support-library constructor at
`0x65ccf0`, runtime callback slot `0x6c6470`, and JNI callback slot `0x6c6468`.
The initial runtime callback points to `0x19fee0`; the initial JNI callback
points to `0x64449c`. See [the callback trace](callback-trace.txt).

The constructor now returns in isolated ARM64 emulation with a synthetic libc
symbol table and explicit models for its observed OS calls. **583,618 mapped image bytes
change after relocations have already been applied**, separating actual
constructor writes from loader relocation effects. The runtime slot is written
at PC `0x6692b8`, with value `load_base + 0x19fee0`.

This count includes writable state. It is not a count of decoded instructions
or a measure of gameplay coverage.

At JNI target `0x64449c`, the original first 32 bytes yield only one instruction
before disassembly fails. After the constructor, the same 32 bytes yield eight
valid ARM64 instructions forming a normal function prologue. This specific
transition was independently rerun and verified. The runtime target `0x19fee0`
is still encoded, so this is partial unpacking rather than a working engine.

Recovered JNI startup follows `0x64449c` to bootstrap `0x65440c`, then
`JavaVM.GetEnv`, then `0x6476dc`. The substantive bootstrap uses initializer array
`0x6c3a20` and another callback slot `0x6c4228`, initially pointing to still-encoded
`0x29eacc`. Those are concrete next targets. The constructor's successful return
does not establish that JNI startup, worker threads, or libg initialization work.

A subsequent local exploratory run reaches `fork()` from caller `0x657edc`,
after worker synchronization and IPC setup. It stops there; no host process is
created. Only 143 writable-state bytes differ from constructor-only memory,
with no further executable-segment changes. This is a boundary requiring an
accurate process/IPC model or an instrumented Android runtime. The experimental
thread/process model is not part of the validated public constructor baseline.
