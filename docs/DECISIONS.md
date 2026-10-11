# Decisions

Newest first. Each entry gives the decision, why it was made, and what would
change it.

## 2026-10-11 — Pivot from exact emulation to a real-time simulator

- **Decision:** the active goal is a real-time simulator with original art
  that passes the owner's expert smell test ([GOAL.md](../GOAL.md)). The
  byte-identical native-engine track is paused and kept as a reference and
  verification oracle.
- **Why:** the owner wants to train a large "bitter lesson" policy that acts
  in real time like a player, and wants to judge fidelity themselves. The
  emulated original engine took about 8 minutes (instrumented) to boot and run
  a 904-step diagnostic match, well below real time. Arbitrary card placement,
  full state capture and reset were also unproven.
- **Would change if:** the native engine became fast enough to drive directly
  and could accept arbitrary actions.

## 2026-10-11 — Keep the game files in this repository; make it private

- **Decision:** commit the pinned APK and the unpacked install-time asset pack
  under `game-files/`, and switch the repository to private. CI refuses
  `game-files/` in a public repository.
- **Why:** cloud sessions can't reach the owner's Mac, and the download
  sources (APKMirror, APKFab) may be blocked or need fresh links.

## 2026-10-11 — Engine language: TypeScript, one core for browser and headless

- **Decision:** write the engine in TypeScript so the same deterministic core
  runs in the browser viewer and headless in Node for training.
- **Why:** one codebase for both the renderer and training. Node 26 is
  available, and no Rust toolchain was installed on the Mac.
- **Open:** whether to fork an existing open-source engine instead of starting
  from scratch. See "Open questions for the owner" in [STATE.md](../STATE.md). If
  throughput is too low for training, port the core to Rust or C++ (with WASM
  for the browser) behind the same interface.
