# Clash Royale native-engine research

Tools and evidence for recovering the original native battle simulation from a
pinned Clash Royale Android build, with the goal of an exact environment for
reinforcement learning.

The target is behavioral equivalence for a specific build and asset set.
Extracted card statistics and plausible-looking movement do not establish that
equivalence. The original native world loop now drives movement, automatic
target selection, melee/projectile damage and lethal troop removal in synthetic
fixtures using original-loaded Knight and KingTower records. Separate probes
construct the original TrainingCamp map geometry and native match objects.
The original built-in Normal test now completes a 904-step battle with native
deployment and a native winner under explicit diagnostic platform conditions.
A second run reproduces every recorded step and both entire event-observer
files, with a first complete 905-frame capture for visual replay.
Ordinary-match and byte-identical Android equivalence remain unvalidated.

**Hard requirement: byte-identical troop interactions, attacks, projectiles and
towers. No approximation counts as success.** The [active goal and acceptance
criteria](GOAL.md) require original simulation code/data and bit-identical
complete per-tick state and events before an environment is accepted for training.

## Decompilation status

<!-- decompile-status:start -->

Android build **160402020**. Recovery is not proof of byte-identical battle behavior.

| Milestone | Status | Evidence / limit |
| --- | --- | --- |
| APK provenance and signatures | Verified | Base and ARM64 split pass APK v3 and SourceStamp verification; manifest reports 160402020. |
| Pinned install-time assets | Verified | Signed build-160402020 install-time pack acquired; all 17,307 fingerprint entries match (10,719 ZIP files and 6,588 SQLite BLOBs), including 389/389 csv_logic files. Later live updates remain unverified. Original decoder independently reproduces all 419 compressed occurrences in the 421-input diagnostic manifest, with exact bytes and full consumption; two raw JSON inputs remain unchanged. A separate original container path passes three unchanged files. Neither proves live update selection or full Android resource startup. |
| Java startup and JNI declarations | Partial | JADX processed 9,575 input classes with 200 errors; startup and JNI declarations recovered. |
| Native entry points | Recovered | libg ELF metadata yields 566 dynamic-symbol entries including createGameMain and JNI_OnLoad. |
| Loader configuration | Recovered | Decoded configuration identifies /proc/self/maps, the supporting library, and dispatch offset 0x681780. |
| Supporting native runtime | Partial | One fixed external action passes original prediction, queueing, delayed commit, debit and spawn in 121 manual core ticks; fresh repetition remains pending. Original linker maps a genuine Android DSO and resolves its eight imports with byte-identical independent reports. Normal game registration, complete state/reset and ordinary battle equivalence remain incomplete. |
| Runtime region checksums | Verified | All 160/160 original checksums match across the 184,872-byte protection-runtime tail region; a one-bit negative control leaves 159/160 matches. This checks recovered bytes, not battle equivalence. |
| Troop movement | Partial | Complete repeated diagnostic position streams match at 905 boundaries and 9,247 actor observations; 617 unknown-class rows remain unpositioned. All prior visual-only samples also match. Complete movement state and Android comparison remain pending. |
| Target acquisition | Partial | Original world code selects targets without host target assignment in a 400-tick Knight/KingTower fixture; seven original target-setter entries occur. Full arenas, activation rules and all targeting states remain unvalidated. |
| Collision and avoidance | Partial | Original arena collision and neighbor search execute during 60 synthetic movement ticks. Complete troop overlap, pushing and avoidance behavior remains unvalidated. |
| Combat interactions | Partial | Repeated full diagnostic captures match 8,160 observations with HP present, 470 getter-unavailable rows and 617 unknown-class rows, retaining zero HP distinctly. The prior 400-tick melee/projectile fixture and 5,425 original leaf calls support the scoped reader. Full-state and ordinary-match combat equivalence remain unvalidated. |
| Tower interactions | Partial | Original KingTower records, spawn and starting-action enqueue run alongside projectile combat in a 400-tick fixture. Normal inactive/activation behavior and complete match-level tower semantics remain unvalidated. |
| Byte-identical battle equivalence | Not validated | Two synthetic 400-tick runs match all 51,613,696 mapped guest bytes by per-region hashes, 87 listed registers and typed adapter observations per tick. Complete VM/state coverage and an independent Android battle comparison remain absent; exactness is not validated. |

Review **26** · **2026-10-11T12:03:13Z** · Recorded the first external native troop command: prediction at frame97, original delayed commit at117, debit, spawn and later live insertion; 121 core ticks return with unchanged code/source pins. Independent fresh repetition remains pending. Independently reproduced original Android DSO loading and all eight native symbol relocations. Ordinary-match equivalence, complete state/reset and training remain gated.

No overall completion percentage is claimed. Status labels describe the evidence available for this build.

<!-- decompile-status:end -->

The chart records demonstrated milestones, not a guessed percentage of the game.
Every push must review and update it, including pushes with no decompilation
advance. See [AGENTS.md](AGENTS.md) for the mandatory rule.

## Current evidence

- The **first externally submitted troop command executes through original code**.
  Native prediction succeeds at frame 97; original queue timing commits it at
  frame 117, charges elixir and spawns an actor later observed in the live list.
  All 121 manually scheduled core ticks return, with no random-policy entry,
  code change or source-pin mismatch. This is one diagnostic action; a fresh
  independent repetition and ordinary-match equivalence remain pending.
  See [external-action evidence](research/evidence/native-external-action-one-shot.json).
- The **original decompressor reproduces all 419 compressed inputs** in the
  421-occurrence diagnostic resource manifest; the other two inputs are raw
  JSON. Independent runs match the complete report, including exact output
  bytes, full input consumption and nine negative controls. This qualifies
  the decoder on the pinned corpus; original file/provider startup remains
  separate. See [native codec evidence](research/evidence/native-original-codec-corpus.json).
- A separate original file/container path now parses headers, allocates,
  decodes and releases three unchanged resources with identical independent
  reports. Five malformed/bound controls and seven file-boundary rejections
  pass. This uses an explicit immutable-file fixture, with original object
  constructors and unchanged native code; it is not Android provider startup.
  See [container evidence](research/evidence/native-original-container-wrapper.json).
- The original Android linker now executes startup from an unrelocated ELF,
  including **3,884 relative relocation writes, 13 resolver results and all
  17 constructors**, then prints its original help and requests exit 0.
  Independent reports match exactly; fifteen boundary controls and a missing
  entropy negative pass. This help path exits before library-list initialization,
  so the game's independently reproduced missing-library fatal remains open.
  A later original `--list` path creates a real library record for a supplied
  original ELF, with 26 boundary controls and identical independent reports.
  That target remains unrelocated and unexecuted. Seven original membership
  queries in a separate protected guest also repeat exactly; the game library
  remains unregistered. A separate normal-loader probe resolves all eight imports
  in an unchanged Android DSO and returns before target execution; 33 controls
  pass and independent reports match exactly. The DSO has entry zero, so this
  does not establish a runnable application or game loading.
  See [linker evidence](research/evidence/native-original-linker-startup.json).
- Two complete health-enabled runs produce **byte-identical position/health
  streams across all 905 samples**. All 904 recorded steps, 2,551 main events,
  669 hand events and the native winner also match the earlier diagnostic.
  Present HP, unavailable health and unknown classes remain distinct. One
  omitted host request label is recorded separately; no native difference is
  discarded. These are selected observations, not complete-state equivalence.
  See [health repeat evidence](research/evidence/native-full-match-health-repeat.json).
- The delivered [full diagnostic replay](research/evidence/native-full-match-visual-repeat.json)
  shows the earlier position-only capture and eight native deployments.
  It preserves raw positions, leaves unknown classes unplotted and adds no
  physics or interpolation. Browser checks cover playback, keyboard controls
  and narrow/wide light/dark layouts. The newer health data is not yet displayed.
- The **original game and Android asset manager now run in one native guest**
  through the optional-ID consumer. Actual native asset lookup returns the
  missing-file result; original Bionic handles finite modeled kernel ENOENT
  inputs. Both independent reports match exactly. The completed battle still
  uses the earlier diagnostic platform. A later full-data attempt on the new
  platform stops at original linker library-registration state; its native
  fatal message is preserved, and integration remains incomplete.
  See [shared-platform evidence](research/evidence/native-game-android-shared-consumer.json).
- The health reader independently preserves the entire 400-tick fixture
  report and matches 5,425 original leaf calls on selected copied fields.
  Present zero HP and getter-unavailable health remain distinct. This reader
  does not infer tower
  activation. See [health observation evidence](research/evidence/native-health-observation.json).
- The original built-in `Normal` battle now **terminates after 904 returned
  steps**, with status 0 and winner index 1 from its own end handler. All 421
  data inputs and finalization were independently replayed before this run.
  Eight primary native deployment commands are accepted; selected records
  associate twelve created actors with later live insertion. Final game/C++
  code integrity and source-pin checks pass. This remains a diagnostic test
  with modeled platform boundaries, not ordinary-match or byte-exact proof.
  See [completed native test evidence](research/evidence/native-complete-diagnostic-match.json).
- The [offline deployment checker](scripts/native_placement_lineage_v2.py)
  follows the native execution flag's bit 1 and preserves signed frame values.
  It distinguishes nested command/debit/spawn calls from temporal pointer
  associations and unobserved command cloning. Thirty-nine synthetic controls
  pass; recorded relationships cannot prove complete state or causality.
- Independently reproduced a **real Android asset manager configured with the
  pinned asset APK**. Original mode-0 lookup, length, read, EOF and close return
  a known 2,088-byte file exactly; the absent optional file returns null.
  All twelve selected executable regions remain unchanged. This earlier separate
  guest uses explicit kernel/TLS/allocation inputs; the shared-game follow-up
  is described above. See [configured platform evidence](research/evidence/native-android-configured-manager.json).
- A read-only replay sampler reproduces the existing 400-tick fixture without
  changing any captured memory or registers. Its full-bootstrap frame-zero
  check also preserves all 24 mapped regions, 87 named registers and the
  allocator cursor before the complete capture above.
  See [sampling validation](research/evidence/native-visual-sampler-validation.json).
- A subsequent [loader audit](research/evidence/native-android-loader-audit.json)
  caught an indirect-function symbol classification bug. Entry watches show
  the earlier empty-manager path never reached those resolvers. A corrected
  loader independently reproduces both lookup modes 0 and 2 and rejects two
  invalid resolver calls. Separately, all 3,218 packed relocation tuples match
  the compiled original AOSP iterator. These checks do not establish a full
  Android runtime.
- Independent 400-tick fixture runs reproduce **44 returned live actor
  insertions**, distinguishing them from queued actors and registration
  requests. This corrects the event observer; it does not demonstrate legal
  card placement. See [insertion evidence](research/evidence/native-actor-insertion-observer.json).
- Original filesystem constructors, directory setup and Bionic file-error
  handling are independently reproduced. Ten native file-error controls and
  22 public asset-free tests preserve the narrow boundary. See
  [file prerequisite evidence](research/evidence/native-file-prerequisites.json).
- [Stopped-memory capture](scripts/native_failure_capture.py) and its
  [offline reader](scripts/read_failure_capsule.py) preserve diagnostic bytes
  and reject corrupted or missing regions. Seven synthetic tests verify their
  limits. Raw captures stay private; these tools do not provide reset, rollback
  or complete VM state.
- A separate startup follow-up replaces modeled thread keys and locks with
  original pinned Bionic routines. All 763 constructors still return, and
  original resource code completes an **empty-resource** promise and wait.
  Actual incomplete waits fail instead of receiving fabricated completion.
  The later 421-input diagnostic also passes this resource stage and its final
  postprocessor; ordinary gameplay equivalence remains pending. See
  [threading and resource evidence](research/evidence/native-bionic-threading.json).
- A locally compiled, authored memory observer preserves full-interval import
  checks. In a 50-parse native CSV microbenchmark, it takes 1.41 seconds versus
  3.07 seconds for the Python observer, with identical hashes of all mapped
  guest memory and values of 87 observed registers. This is a local
  instrumentation measurement, not full-match throughput or complete-state
  equivalence. [Source, controls and limits](research/evidence/compiled-import-observer.json)
  are public; the observer never executes original guest code on the host.

- Independently reproduced **all 763 original startup constructors**, in their
  original table order under explicit platform inputs. The game's own writes
  to already-run constructors and authenticated metadata restoration are fully
  accounted for; this does not establish complete application startup.
  Separately, pinned official
  Android Bionic code passes 2,016 integer-conversion cases and 2,024 decimal
  cases. This exposed a real limitation in the older decimal adapter: matching
  result bits did not preserve floating-point status flags. The new integration
  routes these calls to original Bionic. Full data finalization and built-in
  match setup now return under the diagnostic conditions above; original-device
  runtime equivalence remains unverified. See
  [startup evidence](research/evidence/native-startup-constructors.json) and
  [platform evidence](research/evidence/native-bionic-boundary.json).

- Inspected Android version **160402020**, listed on APKMirror on October 7,
  2026, and retrieved on October 11, 2026.
- Verified the base APK and ARM64 split with Android `apksigner`: APK Signature
  Scheme v3 and SourceStamp verification both pass.
- Recovered Java startup/native declarations and the native ELF entry points.
- Decoded loader configuration identifying `libsupercell_clashroyale.so` as a
  dependency of `libg.so` initialization.
- Executed the supporting library's constructor in an isolated emulator. It
  changes **583,618 mapped image bytes after relocation** and reveals decodable JNI startup.
  Two independent runs reproduced the constructor return and callback assignment.
- Acquired and signature-verified the install-time asset split. **17,307/17,307**
  fingerprint entries match, including all 389 `csv_logic/` entries. Later live
  updates and runtime cache overrides remain unverified.
- Verified the constructor-decoded protection region against **160/160**
  original embedded Fletcher-64 checksums; a one-bit negative control fails.
- Recovered the support runtime's **4,860,456-byte main code region** by running
  its original transform after replaying a response generated by the original
  child process in isolated emulation. The public recovery tool starts from
  the original support ELF and produces its own intermediate captures.
  An independent portable ChaCha8 implementation matches every output byte;
  12 isolated original-native cipher trials also match.
- Decoded **416/416 selector records** through the original support decoder,
  including its original SHA-256 trailer and padding checks. A mutated record
  is rejected. Independent runs match all 108,448 decoded selector bytes.
- Executed the original `libg` initializer with an explicit selector-data
  adapter. It changes **19,116,296 image bytes excluding relocations**;
  the recovered 17,877,920-byte text region matches independent recovery.
- Executed the original pathfinding factory and search on **12 synthetic grid
  cases**, reproducing exact paths, costs and statuses. The original image
  remains unchanged. Null actors and synthetic arena fields limit the result.
- Executed the original attack-clock routine on **14 synthetic fixtures**,
  reproducing every recorded component state and its 256-byte hash. The clock
  calls no imports and uses no gameplay stubs; that probe isolates the clock.
- Executed the original CSV parser and tag registry on pinned raw bytes: **62
  tags** load without a replacement CSV parser. Independent runs reproduce
  every tag mask and the complete resulting code/data image. Owner registry
  and file-bundle linkage remain explicit fixtures.
- Executed **60 original world ticks** driving a movement component and actor
  state updates on a synthetic single-actor arena. All recorded movement
  fields match independent execution.
- Executed **80 original world ticks in each of three melee fixtures**. The
  original loop schedules attacks, enqueues damage and applies health changes.
  The baseline produces three hits, taking HP from 690 to 453. A synthetic
  shield case ends at 611 HP; omitting attack-component attachment produces no
  damage. All **240 selected tick records** match independent execution, with
  original executable regions unchanged.
- Subsequently executed **80 original world ticks with two Knights loaded by
  the original CSV/TOML parsers and typed loaders**. Actual rarity records,
  native-assigned IDs and native-generated attack sequences replace those
  handwritten inputs. Both Knights take three hits, ending at 453 HP. Complete
  reports match separate runs, but contain only selected state; arena/context
  setup and initial targets remain fixtures.
- Executed the original TOML parser on **297/297 shipped logic TOML assets**,
  each in a fresh emulator. All return nonnull trees without error callbacks;
  the original text region remains unchanged. A bounded decimal-to-binary64
  libc model is explicit. This is parsing, not complete gameplay-data loading.
- Executed original static asset-descriptor construction and native manifest
  merging, yielding **158 bundles and 421 ordered paths**, all present in the
  pinned asset pack. Complete reports match separate runs; Android asset-provider
  initialization is still incomplete.
- Extended native combat to **400 world ticks with automatic target selection**,
  original-loaded KingTower/projectile/action records and native actor factories.
  Original code applies 62 damage events and removes the two Knights at ticks
  270 and 271. All selected records match separate execution; native executable
  regions remain unchanged. The arena, context and player setup are fixtures;
  ordinary tower activation remains unverified. See
  [the complete selected trace and limits](research/evidence/native-automatic-combat.json).
- Separately constructed **36x64 TrainingCamp map geometry** from unchanged
  original map assets, and executed the original match-context constructor to
  create its world, level, observer and service links. Separate reports match
  exactly. Explicit zero clock inputs and incomplete data references limit the
  result; no playable match is configured. See
  [construction evidence](research/evidence/native-match-construction.json).
- Repeated that 400-tick fixture while hashing **every mapped guest-memory
  region at every tick**: 16 regions totaling 51,613,696 bytes, plus 87 named
  ARM64 registers and typed adapter observations. Both reports match exactly,
  and all previous gameplay fields remain unchanged by the read-only capture.
  The [receipt utility](scripts/native_state_receipt.py) and 21 synthetic
  controls are public. Hidden emulator state and callback/runtime
  dependencies remain outside this observation; see
  [the exact capture scope](research/evidence/native-memory-repeatability.json).
- The completed native built-in test now combines full manifest loading,
  original player/deck setup, map construction and deployment. Ordinary tower
  activation, complete match-rule coverage, Android startup and complete
  per-tick equivalence remain unvalidated. The older 400-tick synthetic fixture
  remains a separate experiment.

See [the build record](research/builds/160402020.json) and
[the investigation notes](research/findings.md). Findings distinguish direct
observations, inferences, and untested hypotheses.

The [REA source review](research/rea-review.md) assesses its Ghidra, Android,
runtime and evidence tooling against this project's exactness requirements.

## Reproduce the baseline

Use Python 3.11 or newer. The research dependencies were exercised on Python
3.14 on macOS; no Android game installation is required for the baseline.

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
git config core.hooksPath .githooks
```

Obtain the original ARM64 bundle from the
[recorded APKMirror release](https://www.apkmirror.com/apk/supercell/clash-royale/clash-royale-160402020-release/clash-royale-160402020-android-apk-download/)
and save it locally. The preparation command requires the recorded bundle hash
and extracts research inputs into the ignored `work/` directory:

```sh
python scripts/prepare_apkm.py /path/to/clash-royale-160402020.apkm
python scripts/inspect_native.py work/builds/160402020/native/libg.so \
  --output work/builds/160402020/inspection
python scripts/inspect_native.py work/builds/160402020/native/libsupercell_clashroyale.so \
  --output work/builds/160402020/inspection
python scripts/emulate_libg.py --workspace work/builds/160402020
```

The baseline emulator deliberately stops at the missing supporting runtime; a
process exit of zero means a diagnostic report was written, not that the engine
initialized. Inspect `returned`, `stop_reason`, and `error` in its JSON report.
It models selected operations in memory and never forwards Android system calls
to the host. This is a partial loader experiment, not a game simulator.

Reproduce the newly recovered support-library constructor and static callback
trace with:

```sh
python scripts/emulate_support.py \
  --library work/builds/160402020/native/libsupercell_clashroyale.so \
  --out work/builds/160402020/support-constructor
python scripts/trace_callback.py work/builds/160402020/native/libsupercell_clashroyale.so
```

The constructor report should show `constructor_returned: true` and callback
`0x2019fee0` under the emulator's chosen load base. This result uses a synthetic
libc symbol table and modeled OS behavior. Optional `--jni` exploration remains
incomplete; `--defer-threads` is an explicit modeling shortcut, not equivalent
execution of the original runtime.
The changed-byte count includes writable state and is not a count of recovered
gameplay instructions. As with the baseline, inspect the JSON outcomes even if
the Python command exits successfully.

To independently verify APK signatures, install Google's Android build tools
and a compatible JDK, then run:

```sh
python scripts/verify_apks.py --apksigner /path/to/build-tools/apksigner
```

Additional recovery checks:

```sh
python scripts/verify_runtime_integrity.py \
  work/builds/160402020/support-constructor/runtime-memory.bin \
  --out work/builds/160402020/runtime-integrity.json
```

For the install-time asset pack, obtain a fresh XAPK download URL from the
[recorded APKFab release](https://apkfab.com/clash-royale/com.supercell.clashroyale/download?sha1=a2168a5311707371c3126463ded78917413d8336)
and keep that temporary URL in an ignored local text file. The fetcher downloads
only the missing stored ZIP member and verifies its pinned hash and APK signer:

```sh
python scripts/fetch_asset_pack.py \
  --url-file work/fresh-xapk-url.txt \
  --output work/builds/160402020/install_time_asset_pack.apk \
  --apksigner /path/to/build-tools/apksigner
python scripts/audit_asset_pack.py \
  work/builds/160402020/install_time_asset_pack.apk \
  --summary work/builds/160402020/asset-audit.json
```

The asset audit checks the complete recorded fingerprint, including SQLite
BLOBs, and strictly decodes the selected compressed data. One original TOML
file contains a duplicate table that Python's parser rejects; the original
bytes are preserved without repairs or guessed parser behavior.

`recover_support_image.py` generates its own blocked-parent snapshot, executes
the original child against that snapshot, then replays the resulting IPC into
the original parent. It starts from the pinned support ELF alone. Its synthetic
OS, cooperative threads and blocked-peer process model are explicit extraction
assumptions; JNI stops at an unmodeled operation and is not fully initialized.
`verify_chacha_recovery.py` independently checks the generated transform capture
and runs synthetic inputs through the original ARM64 cipher.

## Reproduce native code extraction and isolated probes

These commands recover the native images from the pinned original APK inputs
and then execute isolated routines. No preexisting private capture is required;
all intermediate payloads and captures are generated under ignored `work/`.
No recovered memory or original game data is distributed here.

```sh
python scripts/recover_support_image.py \
  --library work/builds/160402020/native/libsupercell_clashroyale.so \
  --out work/support-recovered
python scripts/verify_chacha_recovery.py \
  --library work/builds/160402020/native/libsupercell_clashroyale.so \
  --capture-report work/support-recovered/capture-private.json \
  --memory work/support-recovered/constructor-memory.bin \
  --decoded-memory work/support-recovered/runtime-memory.bin \
  --out work/support-recovered/cipher-verification.json
python scripts/recover_selector_metadata.py \
  --image work/support-recovered/runtime-memory.bin \
  --library work/builds/160402020/native/libsupercell_clashroyale.so \
  --apk work/builds/160402020/apks/base.apk \
  --out work/selector-metadata
python scripts/recover_libg_image.py \
  --library work/builds/160402020/native/libg.so \
  --support-image work/support-recovered/runtime-memory.bin \
  --configuration work/selector-metadata/7e33eb5e.bin \
  --out work/libg-recovered
python scripts/probe_original_pathfinding.py \
  --image work/libg-recovered/libg-memory.bin \
  --library work/builds/160402020/native/libg.so \
  --asset-pack work/builds/160402020/install_time_asset_pack.apk \
  --out work/pathfinding-probe
python scripts/audit_asset_pack.py \
  work/builds/160402020/install_time_asset_pack.apk \
  --summary work/asset-audit.json --extract-data work/decoded-assets
python scripts/probe_original_attack_clock.py \
  --image work/libg-recovered/libg-memory.bin \
  --knight-data work/decoded-assets/csv_logic/characters/knight.toml \
  --out work/attack-clock/report.json
```

The extraction adapter supplies the exact native-decoded configuration record
to the original initializer; it does not establish full support-runtime readiness.
The public image differs from the separate research harness only at import
relocations: all 3,489 differing bytes are accounted for by those sites. No game
instructions are rewritten. The probes require the exact public-tool image hash.

Pathfinding uses original CSV values through a synthetic object graph, modeled
allocation/memory imports, a null actor and explicit grid inputs. One dynamic
controller flag is a synthetic override whose relationship to the shipped
setting is unresolved. The clock uses synthetic actor/component/buff layouts
and two pinned Knight parameters. These are reproducible function executions,
not a substitute for original data loading or complete battle initialization.

The original tag parser and world-loop melee probes can now be reproduced from
that same extraction chain:

```sh
python scripts/initialize_original_tags.py \
  --image work/libg-recovered/libg-memory.bin \
  --library work/builds/160402020/native/libg.so \
  --raw-tags work/decoded-assets/csv_logic/game_tags.csv \
  --out work/original-tags
python scripts/probe_original_world_melee.py \
  --image work/original-tags/runtime-memory.bin \
  --library work/builds/160402020/native/libg.so \
  --knight-data work/decoded-assets/csv_logic/characters/knight.toml \
  --globals work/decoded-assets/csv_logic/globals.csv \
  --scenario baseline --out work/world-melee-baseline
```

Repeat the world probe with `--scenario shield` or `--scenario unattached_attack`
and a separate output directory for the other fixtures. These runs use original
constructors, actor registration, component ordering and damage processing.
They still supply a first target, selected character fields, a synthetic attack
sequence and a 5×5 arena. They are evidence of native integration, not a Knight
match or a complete simulator. Only selected state fields are recorded.

The tag command executes the original CSV static initializer, file parser,
registry loader and global writer. Its flat image retains 53 changed tag-mask
bytes and 16 inline CSV-static-string bytes; it does not serialize table or
registry heap objects. The melee fixture needs these image globals only.
For further native data loading, reuse the live `ParserProbe` and
`initialize_tags` API to retain original heap objects.

Run every shipped logic TOML asset through the original parser:

```sh
python scripts/probe_original_toml.py \
  --image work/libg-recovered/libg-memory.bin \
  --library work/builds/160402020/native/libg.so \
  --asset-pack work/builds/160402020/install_time_asset_pack.apk \
  --out work/toml-corpus
```

Use `--asset characters/knight.toml` to select one exact corpus member. This
command executes the original TOML static initializer and parser; it does not
translate files through a replacement TOML parser. Every asset has a fresh
emulator, so success does not establish a complete live data registry. Original
Bionic floating-point conversion is not executed: the explicit `atof` model
supports a bounded decimal grammar and computes normal binary64 results using
exact rational arithmetic and nearest-even rounding. Unsupported operations stop
the probe. See [parser evidence](research/evidence/native-toml-corpus.json).

This older command's decimal adapter does **not** reproduce Bionic's floating-point
status flags. Direct comparison now demonstrates that difference for five
observed asset literals, including `0.1`. The newer local bootstrap executes
original pinned Bionic conversion instead; that update is not retroactively
part of this older parser checkpoint. See [platform evidence](research/evidence/native-bionic-boundary.json).

The newer [native-loaded Knight experiment](research/evidence/native-loaded-knight.json)
and [asset-manifest experiment](research/evidence/native-asset-manifest.json)
are independently reproduced integration results. Their exploratory harnesses
remain local pending incorporation into the public command set. They do not
upgrade the earlier public melee command's synthetic setup or establish a
complete original-game reference.

See [native CSV/tag evidence](research/evidence/native-csv-tags.json),
[world-loop melee evidence](research/evidence/native-world-melee.json) and
[world-loop movement evidence](research/evidence/native-world-movement.json).
The movement integration experiment is independently verified; its exploratory
harness is not yet included in the public command set.

See [support-chain evidence](research/evidence/support-recovery-chain.json),
[metadata evidence](research/evidence/selector-metadata.json),
[code recovery](research/evidence/libg-recovery.json),
[pathfinding cases](research/evidence/native-pathfinding.json) and
[clock cases](research/evidence/native-attack-clock.json).

The original APK, extracted binaries, assets, memory dumps, and third-party
decompiler output remain local. The repository contains our tools, hashes,
analysis notes, and summarized evidence.

## Development and push requirements

```sh
python -m unittest discover -s tests -v
python scripts/check_public_tree.py
python scripts/progress.py render --review "Describe the evidence reviewed and current limits"
python scripts/progress.py check
```

Before **every push**, update `research/status.json` with a truthful review,
regenerate the chart, and commit both it and `README.md`. Do this even when the
milestone states remain unchanged: record what was checked and the next step.
The pre-push hook checks the committed push range; CI repeats the checks.
Hooks must be installed in each clone using `git config core.hooksPath .githooks`.
CI detects violations after a push; local hooks and the agent rule prevent them
during the normal workflow.

## What would count as recovered movement?

1. Identify the original simulation update and its movement/pathing routines.
2. Recover or invoke their inputs, state representation, arithmetic, and timing.
3. Exercise controlled scenarios and compare per-tick positions and decisions
   against the original pinned engine.
4. Cover targeting, collisions, bridges, knockback, deployment, and interactions
   before claiming broader battle equivalence.

Successful loading is a prerequisite. It is not a claim of gameplay equivalence.
