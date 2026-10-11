# Clash Royale native-engine research

Tools and evidence for recovering the original native battle simulation from a
pinned Clash Royale Android build, with the goal of an exact environment for
reinforcement learning.

The target is behavioral equivalence for a specific build and asset set.
Extracted card statistics and plausible-looking movement do not establish that
equivalence. Original native pathfinding and attack-clock routines now execute
on synthetic fixtures; a complete battle environment is still unavailable.

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
| Pinned install-time assets | Verified | Signed build-160402020 install-time pack acquired; all 17,307 fingerprint entries match (10,719 ZIP files and 6,588 SQLite BLOBs), including 389/389 csv_logic files. Later live updates remain unverified. |
| Java startup and JNI declarations | Partial | JADX processed 9,575 input classes with 200 errors; startup and JNI declarations recovered. |
| Native entry points | Recovered | libg ELF metadata yields 566 dynamic-symbol entries including createGameMain and JNI_OnLoad. |
| Loader configuration | Recovered | Decoded configuration identifies /proc/self/maps, the supporting library, and dispatch offset 0x681780. |
| Supporting native runtime | Partial | Public tools recover support image, 416 selector records and libg code directly from pinned original inputs; independent cipher/checksum/image checks pass. Parent/child OS behavior and selector delivery remain explicitly modeled; full native/Android initialization is incomplete. |
| Runtime region checksums | Verified | All 160/160 original checksums match across the 184,872-byte protection-runtime tail region; a one-bit negative control leaves 159/160 matches. This checks recovered bytes, not battle equivalence. |
| Troop movement | Partial | Original factory/search executes 12 synthetic grids/queries; independent runs match paths, costs and statuses. Null actors and synthetic arena fields limit this to pathfinding; full troop movement and battle ticks remain unvalidated. |
| Target acquisition | Not recovered | No target acquisition algorithm has been recovered. |
| Collision and avoidance | Not recovered | Complete troop collision and avoidance behavior remains unvalidated; no full actor-interaction comparison has been run. |
| Combat interactions | Partial | Original attack-clock routine executes 14 synthetic fixtures with exact independent component-state/hash matches, no imports or gameplay stubs. Attack execution, projectiles and damage remain unvalidated. |
| Tower interactions | Not recovered | Authentic tower configuration is available; tower targeting, attack timing, and damage behavior remain unrecovered and unvalidated. |
| Byte-identical battle equivalence | Not validated | No complete per-tick state/event comparison against the original pinned battle runtime has been run. Byte-identical interactions remain a hard gate before policy training. |

Review **5** · **2026-10-11T06:42:51Z** · Public support recovery now generates parent/child IPC and code images from the original ELF without private prerequisites. Root independently reproduced the canonical image, 160/160 checksums and all 4,860,456 cipher bytes; complete original battle initialization remains open.

No overall completion percentage is claimed. Status labels describe the evidence available for this build.

<!-- decompile-status:end -->

The chart records demonstrated milestones, not a guessed percentage of the game.
Every push must review and update it, including pushes with no decompilation
advance. See [AGENTS.md](AGENTS.md) for the mandatory rule.

## Current evidence

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
  calls no imports and uses no gameplay stubs. Damage and attacks are not run.
- Full native/Android initialization, complete battle state, troop interactions,
  towers and per-tick equivalence remain unvalidated.

See [the build record](research/builds/160402020.json) and
[the investigation notes](research/findings.md). Findings distinguish direct
observations, inferences, and untested hypotheses.

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
