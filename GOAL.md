# Goal: a real-time Clash Royale battle simulator for reinforcement learning

Build a battle simulator for the pinned Android build **160402020** that:

1. **Runs in real time or faster.** It renders at the game's native tick rate
   for people, and runs headless far faster than real time (target ≥1,000×
   per CPU core) for training. A policy must be able to act at any tick, the
   way a player does.
2. **Accepts any card at any legal position at any time,** for either side.
   That covers troops, buildings, spells, projectiles, area effects, buffs and
   status effects, spawners, death spawns, charge/dash/jump, evolutions and
   champions/heroes, added in stages.
3. **Renders everything with the original art** from the pinned build: every
   unit, building, projectile, spell and effect gets its correct animation,
   facing and team. Also the arena, towers, HP bars, elixir, hand, timer and
   crowns.
4. **Passes an expert player's smell test.** The owner plays Clash Royale
   heavily and will judge fidelity by watching and playing. Byte-identical
   equivalence is **not** required for this goal.
5. **Offers a training interface:** deterministic `reset(seed)` /
   `step(action)`, observations (units, elixir, hand, time, towers), a
   legal-action mask, self-play, and exact replays from (seed, actions).

## Fidelity policy

Approximation is allowed, but every mechanic records where its behavior comes
from in [docs/FIDELITY.md](docs/FIDELITY.md), most trusted first:

| Level | Meaning |
| --- | --- |
| **V** | Ported from the original game code and differentially checked against it running in the native emulator (see `research/`) |
| **P** | Ported from decompiled original game code, not yet differentially checked |
| **D** | Behavior driven by values in the build's own data files (`game-files/`) |
| **A** | Approximation from community knowledge or observation. It must be labelled as such |
| **–** | Not implemented |

Prefer the build's data over remembered numbers. Where a mechanic's exact
logic matters to how the game feels (hit timing, retargeting, pathing,
pushing, level scaling), port it from the original code; REA's DX-Ball
showcase demonstrates the port-then-differential-test pattern.
Never present an A-level mechanic as data-driven or ported.

## Milestones

| # | Result | Evidence |
| --- | --- | --- |
| M0 | Inputs and extraction | Hash-verified `game-files/`; all gameplay tables decoded to JSON; sprite/animation decoder renders sample troops, a tower, a projectile and the arena |
| M1 | Engine core | Arena, towers, elixir, timer/overtime, deploy rules, crowns; first cards (Knight, Archers, Giant, Musketeer, Fireball, Arrows); deterministic headless tests |
| M2 | Viewer | Browser renderer with original art for M1 cards; drag-and-drop for both sides; pause/step/speed; real-time loop |
| M3 | Training bridge | Python env, legal-action mask, throughput benchmark, random-vs-random self-play |
| M4 | Card coverage | Every card in the build, grouped by mechanic family |
| M5 | Fidelity pass | Key formulas ported from the original code and differentially tested; owner smell-test sessions with logged findings |

## Non-goals

- Byte-identical replication of the original engine. That was the previous
  goal, which is preserved as a paused reference track in
  [research/EXACT_ENGINE_GOAL.md](research/EXACT_ENGINE_GOAL.md).
- Online play, accounts, or any interaction with Supercell servers.
- Redistribution. This repository is private because `game-files/` contains
  the original game's files.
