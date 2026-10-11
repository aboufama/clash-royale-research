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

The public recovery tool now generates the required local captures directly
from the original support ELF, followed by independent verification:

```sh
python scripts/recover_support_image.py \
  --library work/builds/160402020/native/libsupercell_clashroyale.so \
  --out work/support-recovered
python scripts/verify_chacha_recovery.py \
  --library work/builds/160402020/native/libsupercell_clashroyale.so \
  --capture-report work/support-recovered/capture-private.json \
  --memory work/support-recovered/constructor-memory.bin \
  --decoded-memory work/support-recovered/runtime-memory.bin \
  --out work/stage2-verification.json
```

The capture report contains original call parameters and stays private. The
recovery tool runs three deterministic branches: parent to blocked IPC, child
against the captured blocked-parent state, and a fresh parent with the original
child's messages. Only the exact known partial-initialization boundaries and
whole-image hashes are accepted; an unexpected stop or error fails recovery.
No transcript, cipher key or decrypted image is bundled. All input to the
independent verifier is generated locally from the original library.

The output matches the earlier independent whole support image at SHA-256
`58735fa9ae5a6d7ea5f828066f3f06e7669eecb79c8ce4c49d4db5d704b72aac`.
Original worker code runs under cooperative scheduling; mutexes, process files,
entropy, process identity and selected OS operations are modeled. The child
reads and writes an in-memory blocked-parent snapshot, not a live host process.
The final parent stops at `getauxval`; it has decoded the desired region but
has not completed JNI initialization. These assumptions are recorded in the
[support-chain summary](evidence/support-recovery-chain.json).

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

The public metadata and `libg` recovery commands consume the exact support image
generated by the public recovery tool. All original payloads and images stay
under ignored `work/` paths. Summaries
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

## Native CSV loading and tag initialization

The original CSV static initializer at `0x1289b94`, file constructor at
`0x1288f2c`, tag registry loader at `0xe16234` and global writer at `0xf72e24`
now execute on the pinned raw `game_tags.csv` bytes. The native parser produces
three columns and 62 rows; the registry produces 62 masks. No Python CSV parser
or replacement parsing algorithm is used on this execution path.

Independent runs match every registered mask, every written tag global and
the entire resulting image at SHA-256
`fc3eab1cf3c15e7a73550445829b4ed50fa20913bf1bca2f7f20af0b07033f12`.
There are 69 changed image bytes: 53 in the tag globals and 16 in three CSV
static strings. Those strings have inline lengths 1, 1 and 2, so the flat
image has no missing heap storage for them. Native table/registry objects do
live on the emulator heap and are deliberately not represented as a complete
runtime snapshot. Keep the live parser instance for continued table loading.

Owner registry load factors and one-file bundle linkage are explicit fixtures.
Imports model allocation, bounded memory and ASCII string primitives, a bounded
prime helper and exit-callback registration. Unknown operations stop execution;
these models have not been established equivalent across the complete game.
See [native tag evidence](evidence/native-csv-tags.json).

## Original world-loop integration

Original world constructor `0xf961f0`, event-bus constructor `0xd5a27c`, actor
registration `0xf8c50c` and world tick `0xf8cd90` now execute. Native component
registration determines the update order. The loop calls attack updates,
actor-state updates and damage processing itself; the probe does not manually
schedule gameplay phases or manually apply damage between world ticks.

Three independent 80-tick synthetic melee fixtures reproduce all 240 selected
state records. The baseline attacks at zero-based ticks 9, 33 and 57, moving
target HP from 690 to 611, 532 and 453. A synthetic 100-point shield absorbs the
first two hits, with HP remaining 690, and the third hit leaves HP 611. Omitting
only the attack component's native attachment leaves HP 690 through all 80
ticks, with zero attack or damage invocations. Executable `PT_LOAD` regions
remain byte-identical before and after every run and are mapped read/execute.

These are fixtures, not complete Knight battles. Selected statistics come from
the pinned Knight TOML through Python's parser; complete native character and
sequence loading has not run. The arena is an empty synthetic 5×5 grid, most
globals are zero, the attack sequence is synthetic and the initial target is
supplied through the native setter. Only selected fields are captured. Extending
the exploratory baseline to a lethal hit reaches a native assertion in missing
battle context; that failure is not bypassed or counted as a working match.
See [world melee evidence](evidence/native-world-melee.json).

A separate integration experiment executes 60 world ticks through the original
movement update `0xfcc578`, path request/search, geometric movement `0xfcef48`,
arena collision `0x11d988c` and actor-state update `0xf800bc`. All selected
records match independent runs. The synthetic actor moves from `(750,750)` to
`(1520,1520)` and empties its path under the original cell rules; no guessed
arrival at the requested `(1750,1750)` is imposed. This does not test original
troop deployment, moving neighbors or real arena geometry. Its exploratory
harness remains private; [summarized movement evidence](evidence/native-world-movement.json)
records the fixture, entry points and observed trace.

The next missing layer is original battle initialization: full data tables,
deployment and target acquisition, towers, outer match rules and complete state
capture. None of these finite fixture results establishes full-match parity.

## Original TOML parsing and native-loaded Knight integration

The original TOML static initializer `0x12a86fc` and parser `0x12a6e64` now
accept all 297 pinned `csv_logic` TOML assets. Each asset uses a fresh emulator
and unchanged original input bytes, including the duplicate-table
`character_buffs.toml` that a conventional TOML parser rejects. All calls
return nonnull trees with zero error callbacks and unchanged original `.text`.
The separate executions match every selected deterministic result, input hash,
import count and observed decimal conversion. Complete parse-tree contents
have not been independently compared.

Three files require `atof`. The explicit bounded model converts exact decimal
ratios to normal IEEE binary64 using nearest-even rounding with default FPCR.
It fails on unsupported syntax, range, subnormal results or nondefault FPCR.
This model is not recovered Bionic and does not establish full runtime parity.
An exploratory malformed-input control stopped at an unsupported formatting
import; it is not evidence that the native parser rejected the input.
See [the public corpus probe evidence](evidence/native-toml-corpus.json).

The native table owner, original tag and rarity CSV parsers, original Knight
TOML reader, all three Knight typed-loader phases, original global-ID ingestion
and native collection preparation now run in one retained emulator heap.
The original code supplies Knight HP 690, damage 79, Common rarity, ID 34000000
and its generated attack sequence. Original actor/component constructors create
the combat objects. These fields and that sequence are no longer handwritten.

Two such actors exchange attacks through 80 original world ticks: both take
damage at zero-based ticks 9, 33 and 57, reaching HP 611, 532 and 453. The
original code enqueues and applies all six damage events. Independent execution
reproduces the entire recorded report, including all 80 selected tick records,
entry/import counts and all three executable-region hashes. Original libg and
shipped libc++ executable regions remain unchanged.

The fixture still supplies an empty 5x5 arena, manual world/context links,
selected globals parsed with Python CSV, and initial targets. It does not load
all dependency records or test death, autonomous acquisition, towers or match
rules. Memory/string/platform imports include explicit bounded models. No
complete state capture or independent live Android battle comparison has run.
See [the native-loaded Knight evidence](evidence/native-loaded-knight.json);
its frozen exploratory harness has not yet joined the public command set.

## Original asset manifest

The original static descriptor builder produces 157 bundles with 160 ordered
paths. Parsing the unchanged `data_manifest.toml` with the original TOML reader
and calling the original merge produces 158 bundles with 421 ordered paths.
Every referenced path exists in the pinned pack; duplicates and order are
preserved. Independent runs reproduce the entire private report, and original
text stays unchanged.

The enclosing native constructor is stopped at its asset-provider boundary;
parsing and merging are subsequently invoked as separate original calls.
This establishes the native asset-load plan, not a completed Android asset
cache/provider or successful typed loading of every asset. See
[manifest evidence](evidence/native-asset-manifest.json).


## Automatic acquisition, projectiles and lethal removal

A frozen extension of the native-loaded combat probe executes 400 world ticks
with original Knight, KingTower, projectile, action and statistic records.
Original actor factories create the actors; the original level spawn routine
creates both KingTowers and fills the level's tower slots. No host call to the
target setter occurs in this automatic mode. The original world code enters
that setter seven times during execution.

The run records 62 original damage applications, 22 melee executions and 53
projectile-update entries. These are function-entry counts, not a claim of 53
separate projectiles. The original world removes the target Knight at zero-based
tick 270 and the source Knight at 271. Both KingTowers remain in the live actor
list at every captured tick and finish with 1231 HP each. Dead Knights are
reported absent; leftover allocation contents are not treated as live state.

A separate process reproduces the entire JSON report, including all 400 selected
tick records, imported-operation counts, original entry counts and executable
hashes. All three libg/libc++ executable regions remain unchanged. See
[the complete selected trace](evidence/native-automatic-combat.json).

This is still an explicit synthetic fixture: empty 5x5 arena, selected globals
materialized from CSV, manual context links, original default mode constructor,
synthetic player-level records and explicit frame-index writes. The original
KingTower starting-action pointer resolves and its enqueue path runs, but normal
inactive/activation semantics remain unverified. The newly recovered real map
and match constructor described below are separate experiments. Neither has
been integrated into this frozen combat run. Complete ordered event/state
capture and an independent Android reference are still missing.

## Original map and match-object construction

Native arena loaders combine 163 base and 201 alternate arena records into 364
native records. The location loaders resolve TrainingCamp from the original
location CSV, while selected Default timeline and Friendly mode records pass
all three native loader phases. The original filename getters select unchanged
`locations/training_arena.csv` and `tilemaps/tilemap.csv`; original CSV parsing
and map constructor `0xe1a4f4` produce a 36x64 map.

Independent execution reproduces both complete map-array hashes: cells
`b26825cb1f47f5508eff8b3ac117e6c5689978429020932f89ae9eb95fb8cb01`
and flags `eb5a66d6e07980b493d18e96ac844a19b1da82296c5cff195bfa4fbe4bafe69f`.
This subset lacks the map's object/effect dependencies, so both such counts are
zero; only geometry is established by this result.

Original match-context constructor `0x10c9514` now returns and creates its world,
level, observer and match-service objects, including their native links. The
harness allocates the observed context size and calls the original constructor;
it does not fill those context/world/service fields itself. Earlier data-owner
and sound-manager wrapper setup remains explicit harness orchestration.

The platform adapter supplies two monotonic-clock reads and one epoch-time read,
all explicitly zero for this fixture. Original RNG initialization executes with
those inputs. App-wide clock/static initialization and Android runtime parity
are not established. Bounded allocation, libc primitives, decimal conversion
and uncontended synchronization remain modeled dependencies.

Separate executions reproduce the entire construction report with unchanged
original libg text and shipped libc++ text. No world tick runs here, and no
players, decks or playable mode/map configuration is installed on the constructed
match. See [construction inputs, hashes and limitations](evidence/native-match-construction.json).


## Per-tick mapped-memory repeatability

The frozen 400-tick automatic-combat fixture now has a read-only receipt at
each native call boundary. Each receipt hashes all 16 mapped guest regions,
including their final bytes, extents and permissions: 51,613,696 bytes per tick.
It also records 87 explicitly named ARM64 register values and a typed graph of
serializable adapter attributes, including allocator bookkeeping and mutex
ownership. All earlier selected gameplay fields, native entry/import counts
and executable hashes remain exactly unchanged by this added observation.

Two separate processes produce byte-identical complete reports at SHA-256
`ac7a41daa5bbfc8b6e9fe1ac8ae3f63b28114f823b4278ff4e08ad48a4925316`.
The public [receipt helper](../scripts/native_state_receipt.py) has the same
Python AST as the verified frozen helper. The [evidence](evidence/native-memory-repeatability.json)
pins the harness sources, native emulator library and capture configuration,
and provides all per-region hashes for every tick. Protected memory contents
remain local.

An independent audit caught weaknesses in the first serializer: dictionary
order and some concrete Python container types were merged, mutable aliases
were absent, and only 70 registers were observed. The verified second version
preserves concrete allowed types, insertion/observed iteration order, float bit
patterns, cycles and cross-attribute container aliases. Unknown types fail.
Twenty-one synthetic controls detect changes to memory boundaries, permissions,
mappings, register high bits, allocator state, runtime configuration and typed
container relationships. These controls do not modify any original game bytes.

This is stronger repeatability evidence, not complete state capture or Android
parity. Opaque Unicorn state, exclusive monitors, unenumerated system registers,
hook order, callback/module globals and Python process/container internals remain
outside the receipt. It is not a validated reset/restore mechanism. The original
fixture's synthetic arena/player/context and platform-model limitations still
apply, and it still lacks the original outer match loop and a full live-game
reference. The exactness gate remains unvalidated.

## Original startup and Android conversion boundaries

All 763 original `DT_INIT_ARRAY` entries now return in their exact table order.
Separate executions reproduce the entire report at SHA-256
`33c6c3c7870dac02e028b14171923c54f9db7cf1138e5fe07c2b192cb2a6af72`.
This checkpoint uses explicit auxiliary-vector, property, clock, loaded-image
and isolated synchronization inputs, plus the previously authenticated support
metadata-extraction adapter. It does not establish complete Android or game
initialization. See the [ordered entries and source pins](evidence/native-startup-constructors.json).

The original initializer at index 739 rewrites 736 already-run constructor
entrypoints to return instructions. Every write comes from original guest PC
`0x1462adc`; the destinations are precisely initializer indices 3 through 738.
No later constructor entrypoint is overwritten by these writes. They change
2,899 bytes in the original main executable segment. Separately, ten
authenticated metadata-adapter writes change 5,027 bytes in the protection
segment. An independent replay from the canonical image verifies every recorded
before-state and exactly reconstructs both final executable-region hashes.
Original libc++ and Bionic executable bytes remain unchanged. Raw original
instruction and memory bytes stay private; the public evidence records hashes,
addresses, write origins and counts. These guest writes must be preserved as
part of the original startup behavior, not concealed by an unchanged-text claim.

A pinned official AOSP runtime APEX supplies executable ARM64 Bionic code;
the SDK library was inspected and rejected because its routines were stubs.
Original `newlocale`, `strtoull_l` and `__errno` now run through the game probe's
existing import route. All 2,016 deterministic hexadecimal cases match exact
return values, end pointers and preseeded errno. Independent processes reproduce
the complete report, including unchanged original executable bytes.

Original Bionic `atof` also runs through that route. Its return bits match the
bounded rational model for 2,024 normal finite decimal cases, including all
16 distinct literals observed in the current bootstrap. The comparison also
finds a concrete mismatch in the old adapter: original conversion sets FPSR to
`0x10` for five observed literals while the adapter leaves it at zero. Both
implementations were invoked through the same import entry with cleared initial
FPSR. These literals are `0.8`, `0.35`, `0.45`, `0.1` and `1.2`.
The newer attachment executes the original conversion rather than adding a
special-case flag model. Earlier parser/combat checkpoints retain their stated
modeled-platform limitations.

An import audit identifies 18 undefined data-object relocations across the game
and its shipped libc++. Fifteen already resolve to original libc++ exports;
the remaining three now resolve to original Bionic `stderr`/`__sF` objects.
Unresolved callable stubs may no longer silently serve zero bytes as data:
guards reject native data accesses and host-adapter reads/writes during guest
execution. Controls verify native and adapter failures while allowing trusted
inspection outside execution. No original native code was patched.

The [Bionic attachment](../scripts/original_bionic_locale.py) and
[import data guard](../scripts/native_import_data_guard.py) are public, with
the same Python ASTs as the frozen verified implementations. Fourteen additional
synthetic tests exercise guest/adapter reads and writes, overlapping boundaries,
data binding, unknown objects and cleanup after failure without original game
inputs. The end-to-end integration drivers remain local while startup is incomplete.

The audit also caught a boundary weakness in Unicorn's range-filtered hooks:
a native access starting before a stub could cross into its bytes without
triggering the hook. Execute-only permissions did not reject the tested
crossing load either. The final guard observes all guest reads/writes and
checks the complete accessed interval. Regression controls cover crossing
native loads and stores at both stub regions. This observation adds execution
overhead; no speedup is claimed.

The [platform checkpoint](evidence/native-bionic-boundary.json) records provenance,
inputs, counts, discrepancies and controls. This AOSP libc is not identified as
the runtime of the APK's original device. Allocation, synthetic thread/TLS
state, IFUNC feature inputs and other platform adapters remain explicit;
Android stream startup, full loader behavior and battle equivalence remain
unvalidated. These are bootstrap improvements, not a completed match.

## Original thread storage, synchronization and resource completion

The next bootstrap executes original Bionic `pthread_once`, thread-key
creation/deletion and thread-specific get/set routines. Shipped libc++
`__emutls_get_address` returns stable native storage on repeated access.
Original resource stack push/pop now reaches the original
`__cxa_thread_atexit_impl`, which allocates and links its own destructor
registration. Registration is established; thread exit and destructor execution
are not.

The platform supplies one explicit synthetic guest thread, its TLS/key storage
and TID 1. Original routines manage that storage. The sole accepted futex
operation is the observed once-initialization wake with no waiters, at its
verified original call site and state. Other operations stop. Actual contended
mutex, condition wait and unfulfilled C++ future controls are rejected; there
is no synthetic signaller or forced completion. Late attachment is also
rejected after modeled keys or synchronization have been used, including
destroyed objects and prefixed historical import counters.

All 30 original exported mutex/condition routines are routed before guest
initialization. A fresh run with original thread keys and synchronization
completes all 763 constructors, reproducing the complete report independently
at SHA-256 `d1f8d9b92a2d88e69985d6f3d93b9f0a8e65845cc3c7a8a807853d3e98b8b0d1`.
Native startup calls include 77 lock/unlock pairs, six mutex initializations,
one condition initialization and 30 broadcasts. The original self-erasing
constructor changes remain preserved and exactly accounted for.

In a separate bounded resource fixture, original-constructed empty collections
and an empty resource manager reach the original resource service, shipped
C++ promise completion, wait and future destructor. The original completion
byte becomes 1; no readiness field is patched. Independent runs and the public
helper variants reproduce the entire report at SHA-256
`ed18f035074eeeae4dd7f8d8efc76476ba1291c6d840814b8770aabcefeffeff`.
All guest executable regions remain unchanged in this fixture.

The [threading checkpoint](evidence/native-bionic-threading.json) records the
inputs, exact reports, rejection controls and public helper hashes. Sixteen
asset-free tests exercise admission and the narrow futex boundary without
original binaries or optional analysis packages. These are improvements to the
explicit recovery platform. Full loaded-resource completion, multithreaded
scheduling, Android thread startup and a complete match remain unverified.

## Reducing complete-interval observation overhead

The optional [compiled observer](../scripts/compiled_import_data_guard.py)
keeps the same reference data bindings and host-access wrappers, while moving
the global native memory callback into locally authored C. The observer is
compiled for the host; all original game code remains inside Unicorn. Native
accesses are still checked against full intervals, including accesses beginning
before a protected region. No checks are sampled or removed.

Twenty-two public synthetic tests cover the reference boundary cases, nested
accesses, callback lifetime, configuration drift and native observer API
failures. The interval predicate matches unbounded Python integer arithmetic
in 101,008 boundary/random cases. A violation is retained across nested calls,
and the first failed stop request cannot be concealed by a later successful
request. Rejection does not establish rollback; failed engines must be discarded.
An independent test found that trying to resume an invalid-PC nested emulation
can crash Unicorn with either observer. That recovery path is unsupported.

Fifty identical original parses of the unchanged 5,082-byte game-tag asset take
3.065 seconds with the Python observer and 1.411 seconds with the compiled
observer in the recorded local run, a 2.17 ratio. All 19 mapped guest regions
(308,756,480 bytes), their permissions, 87 explicit registers and native row
counts match. Original Bionic executable bytes remain unchanged. These are
local microbenchmark observations, not full-bootstrap or full-match performance.

The [observer evidence](evidence/compiled-import-observer.json) pins sources,
the local build and the full private comparison report. The public controls
compile only the authored observer and use synthetic guest instructions; no
original native bytes are required. The adapter pins Unicorn 2.1.4 and relies
on its private Python backend ABI. Opaque emulator state, unenumerated registers
and host runtime state remain outside the comparison. The exact battle gate
does not change.
