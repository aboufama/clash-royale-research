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
transition was independently rerun and verified. At this constructor-only stage,
the runtime target `0x19fee0` remains encoded. The subsequent recovery below
makes it readable; a working engine remains open.

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


## Complete pinned install-time fingerprint

The missing `install_time_asset_pack.apk` is now acquired from the
[recorded APKFab release](https://apkfab.com/clash-royale/com.supercell.clashroyale/download?sha1=a2168a5311707371c3126463ded78917413d8336).
The 913,096,301-byte split has the same package/version and APK signing
certificate as the pinned base and ARM64 APKs. Google's `apksigner` verifies
v1, v2, v3, and SourceStamp signatures. Container variants from different
providers are not asserted to be identical.

Its fingerprint records 17,307 unique paths. All match exactly: 10,719 raw ZIP
members and 6,588 raw SQLite BLOBs. The mapping is explicit:
`meta.assetFilename` names the fingerprint path and `meta.path = asset.path`
joins to `asset.data`. No guessed filename extensions are used. All 389
`csv_logic/` entries match. See [asset audit](evidence/asset-fingerprint.json)
and [acquisition evidence](evidence/asset-acquisition.json).

608 selected compressed files decode using the observed five-byte LZMA
properties plus four-byte output length; restoring the absent upper four zero
length bytes yields an LZMA-alone stream. Decoding checks exact declared length,
end of stream, and absence of trailing input. Three selected files are unchanged.
297 TOML files parse. `character_buffs.toml` has a duplicate
`ImmuneToWeakPushback` table rejected by Python's parser; preserve its original
bytes and leave original-game parser semantics unresolved.

This establishes completeness against the signed install-time fingerprint.
Later live downloads and cache overrides have not been observed. It does not
establish the data selected by a running battle or recover gameplay algorithms.

## Recovery integrity and main support-code transform

The constructor-decoded protection region spans `0x62fac8..0x65ccf0`
(184,872 bytes). All 160 blocks match the original binary's embedded, seeded
Fletcher-64 expectations. Independently flipping one bit makes block 0 fail.
Fletcher-64 is noncryptographic: this is an intrinsic consistency check for that
region, not proof of authenticity or engine correctness. The
[summary](evidence/runtime-integrity.json) records both checks.

An experimental isolated process model follows the original parent/child
handshake. The parent permits child tracing; the child attaches, observes
process state, and handles the original four-byte IPC protocol. Replaying a
response captured from the original child code allows the original parent to
transform its main executable region. No host process is traced or modified.
Synthetic OS behavior remains an explicit limitation of this experiment.

The original native function at `0x68192c` applies ChaCha8 to the region
`0x18d0a0..0x62fac8`, length **4,860,456 bytes**. The decoded-region SHA-256 is
`821a8deac13d24121f199db16c3395d4f4703913aad10e6a3015d68b9f49b78a`.
An independently written portable transform, using arguments captured from that
native call, matches every output byte. Twelve direct original-native cipher
trials also match: rounds 8 and 20, each over 0, 1, 63, 64, 65, and 1,024 bytes.
See [independent verification](evidence/support-main-text.json).

The public verifier can reproduce those comparisons when supplied with local
research captures:

```sh
python scripts/verify_chacha_recovery.py \
  --library work/builds/160402020/native/libsupercell_clashroyale.so \
  --capture-report work/private-stage2/report.json \
  --memory work/builds/160402020/support-constructor/runtime-memory.bin \
  --decoded-memory work/private-stage2/runtime-memory.bin \
  --out work/stage2-verification.json
```

The capture report contains original call parameters and stays private. The
experimental runtime/IPC capture harness is not yet a packaged public recovery
pipeline. This command validates supplied captures; it does not generate them.

The recovered dispatcher at `0x19fee0` installs handlers at `0x19fcec` and
`0x19fd60`. The first checks original runtime readiness and uses an initialized
decoder structure. Merely making the code readable does not initialize that
state. Forcing its readiness check would not count as original execution.
At that stage no gameplay routine was callable. The subsequent extraction below
uses an explicitly bounded selector-data adapter; full original support readiness
is still unresolved and no exact simulation claim is made.

## Original metadata and game-code recovery

The base APK contains a 968,971-byte metadata container at
`assets/anjeamelnchn.dat`. The original context constructor at `0x386f00` and
decoder at `0x2739cc` accept all 416 selector records, producing 108,448 bytes.
Independent execution matches every record. The ordered selector/length/payload
digest is `7fca2a35a1f6b23514d26c6cf541749883770243a0e8f548cccb79fe78bd3d53`.
The original SHA-256 trailer and padding checks execute unchanged; changing one
ciphertext bit makes the native decoder reject the record. The outer container
signature has not been independently verified. Main package metadata also
decodes to 772,014 bytes, hash
`2057a3c586fd4d791ce7489673e9cb37aee1e9542ecf7631aa1e1f1c02bd288f`.

The original `libg` initializer at `0x1ae3c20` now returns. The extraction harness
models process maps, process identity and memory protection, and replaces only
the support selector handler with a copy of the exact native-decoded 672-byte
record for selector `0x7e33eb5e`. The original dispatcher, base-address handler
and initializer execute. This is an extraction adapter, not successful original
support-runtime initialization.

The initializer changes 19,116,296 mapped bytes excluding relocations. The
17,877,920-byte recovered text region at `0x7706b0` has SHA-256
`3a4b013d548d28ca41f547d801877b7bbd54dff003dec07e2d6b8549424baca5`.
An independent run reproduces the complete research image. The packaged public
extractor produces the same code and data; its different synthetic import
addresses explain all 3,489 byte differences across 1,755 undefined-symbol
relocation sites. There are zero differences elsewhere. The two whole-image
hashes and region checks are in [code-recovery evidence](evidence/libg-recovery.json).

The public metadata and `libg` recovery commands require the exact locally
captured support image; public generation of that prerequisite remains open.
All original payloads and images stay under ignored `work/` paths. Summaries
contain hashes, counts, addresses and explicit modeling limits.

## Original pathfinding execution

The original factory at `0x11d8778` creates the native controller and search
objects from pinned globals CSV values materialized in a synthetic level/table
layout. The original search at `0x11d7b58` computes 12 cases: four synthetic 5×5
grids, each with two opposite-corner queries and a same-cell query. All outputs
match the earlier independent native-constructor experiment. Rerunning each
query with a fresh original factory also preserves every result.

Open ground yields cost 448 for both diagonal queries; a diagonal road changes
those costs to 280 and 406. A flagged center cell or explicit dynamic penalty
causes the native routine to choose a five-segment detour with cost 496. The
returned array stores the reverse route without the start. These are measured
native outputs; there is no replacement pathfinding implementation in the probe.

Important limits: the actor argument is null; the grid, level and table object
graph are synthetic; allocation/memory imports are modeled. Controller byte
`+0x71` is explicitly set per fixture and its relationship to the shipped
dynamic-occlusion setting is not established. Original CSV loading, actor state,
actual arena topology and battle-tick integration are not reproduced. The exact
code image is read/execute only and remains unchanged. See
[all cases and assumptions](evidence/native-pathfinding.json).

## Original attack-clock execution

Original function `0xfc90b0` and its original callees execute 14 independent
synthetic actor/component/buff fixtures without imports, syscalls, gameplay
stubs or instruction patches. The pinned Knight data supplies `HitSpeed=1200`
and `LoadTime=700`; other object fields are explicit synthetic inputs.

The ordinary fixture advances its timer by 50 per call. Synthetic modifiers
150 and −35 produce increments 75 and 32; both together produce 48 through
original integer arithmetic. Delay 75 becomes 25, then zero, then permits timer
advancement on the following call. Boundary flags and level gating have their
own recorded state transitions. These observations do not infer which legal
battle actions produce those synthetic modifiers or flags.

All recorded fields and complete 256-byte component hashes match independent
execution on the separate research image and the canonical public-tool image.
The probe maps the code image read/execute only and leaves imports unmapped;
unknown execution, interrupts or instruction/time limits fail. It is a clock
slice, not attack execution, hit detection, damage, targeting, tower combat or
complete state capture. Later native status-tag initialization is still needed
for broader actor predicates. See [clock evidence](evidence/native-attack-clock.json).
