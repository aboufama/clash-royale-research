# Clash Royale native-engine research

Tools and evidence for recovering the native battle simulation from a pinned
Clash Royale Android build, with the long-term goal of a faithful environment
for reinforcement learning.

The target is behavioral equivalence for a specific build and asset set.
Extracted card statistics and plausible-looking movement do not establish that
equivalence. No troop movement implementation has been recovered yet.

## Decompilation status

<!-- decompile-status:start -->

Android build **160402020**. Recovery is not proof of behavioral equivalence.

| Milestone | Status | Evidence / limit |
| --- | --- | --- |
| APK provenance and signatures | Verified | Base and ARM64 split pass APK v3 and SourceStamp verification; manifest reports 160402020. |
| Java startup and JNI declarations | Partial | JADX processed 9,575 input classes with 200 errors; startup and JNI declarations recovered. |
| Native entry points | Recovered | libg ELF metadata yields 566 dynamic-symbol entries including createGameMain and JNI_OnLoad. |
| Loader configuration | Recovered | Decoded configuration identifies /proc/self/maps, the supporting library, and dispatch offset 0x681780. |
| Supporting native runtime | Partial | Constructor returns; 583,618 mapped image bytes change after relocation and JNI startup becomes readable. Full JNI/runtime and gameplay remain incomplete. |
| Troop movement | Not recovered | No troop movement algorithm has been recovered. |
| Target acquisition | Not recovered | No target acquisition algorithm has been recovered. |
| Collision and avoidance | Not recovered | No collision or avoidance algorithm has been recovered. |
| Combat interactions | Not recovered | No attack, damage, or timing algorithm has been recovered. |
| Behavioral equivalence | Not validated | No per-tick comparison against the original battle runtime has been run. |

Review **2** · **2026-10-11T05:36:42Z** · Initial public baseline: signatures reverified; constructor decoding and callback assignment independently reproduced; full JNI and gameplay remain unresolved.

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
- Traced the recovered startup into its next bootstrap stage. Full JNI startup
  and the game engine are still incomplete.

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
