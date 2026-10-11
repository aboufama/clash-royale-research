# Decisions

Newest first. Each entry gives the decision, why it was made, and what would
change it.

## 2026-10-11 — Owner: visuals indistinguishable, mechanics as exact as possible

- **Decision:** the owner asked for visuals indistinguishable from the real
  game and byte-identical behaviour for a limited troop set, judged by playing.
  Strategy: render the build's own SC2 movie clips (not redrawn art); implement
  mechanics from native facts; recover the decrypted `libg` in the cloud and
  decompile combat functions to port them; check every mechanic against
  recorded native traces (`research/evidence/`) and label the result in
  docs/FIDELITY.md.
- **Why:** byte-identity can only be shown by comparison with the original
  engine. The repo holds a few native traces (Knight fixture, King-vs-Knight
  400-tick fixture, 8-input match actions); the full-match per-frame captures
  live only on the owner's Mac.
- **Would change if:** the owner provides the Mac-only captures or the native
  harness runs in the cloud, enabling full-match differential tests.

## 2026-10-11 — Collision push fitted to a native trace

- **Decision:** push = per overlapping neighbour min(overlap, 90) × 150/90 along
  the centre line, capped at 150 units/tick, applied inside each actor's
  movement update. Unit-vs-unit pushes weight it by Mass.
- **Why:** the push algorithm was never decompiled, but
  `native-automatic-combat.json` records two Knights being pushed by King
  towers every tick. This rule reproduces 508/539 positions exactly (max error
  6 units) and the tick-0 step exactly. A sweep over alternatives fitted worse.
- **Would change if:** the decompiled movement code (`0xfcc578`, `0xfcef48`,
  `0x11d988c`) gives the real formula; it then replaces this fit.

## 2026-10-11 — Engine base confirmed: from-scratch TypeScript

- **Decision:** the owner confirmed the from-scratch deterministic 20 Hz
  TypeScript engine (`sim/core`) on 2026-10-11, optimised for speed (millions
  of headless matches). M1 needs all graphics and at least 8 troops.
- **Why:** both open-source engines get the fundamentals wrong (tick rate,
  units, starting elixir); one TypeScript core serves the browser and
  headless runs. First benchmark: ~7,000× real time per core with random play.

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
