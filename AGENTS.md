# Agent rules

Read [GOAL.md](GOAL.md) first, then [HANDOFF.md](HANDOFF.md) for the current
state and next steps.

## Repository privacy (hard rule)

- This repository is **private** and contains the original game files in
  `game-files/`. Never make it public, never copy `game-files/` or anything
  decoded from it (sprites, atlases, data JSON, audio) into a public location,
  and never upload it to third-party services.
- CI fails if `game-files/` exists while the repository is public. Do not
  weaken that check.
- Generated or decoded assets go under ignored paths (`work/`, `dist/`), or are
  rebuilt by scripts. Commit the scripts, not the bulk outputs. Small decoded
  data the engine needs at runtime (for example gameplay JSON) may be
  committed under `sim/data/` because the repository is private.

## Simulator work

- Record every mechanic's fidelity level (V/P/D/A/–) in
  [docs/FIDELITY.md](docs/FIDELITY.md) in the same commit that changes it.
  Never label an approximation as data-driven or ported.
- Use the build's own data over remembered stats. When you must use outside
  knowledge, mark it **A** and say where it came from.
- Keep the engine deterministic: fixed tick, integer/fixed-point game units,
  seeded RNG, stable iteration order. A replay of (seed, actions) must
  reproduce the match exactly.
- The engine must not depend on the renderer; headless and browser use the
  same core.
- Keep [HANDOFF.md](HANDOFF.md) current when the state, next steps or open
  decisions change, so a fresh agent can continue.
- Record decisions with their reasons in [docs/DECISIONS.md](docs/DECISIONS.md).

## Native research track (paused reference)

- `research/`, `scripts/` and `tests/` hold the exact native-engine work. Its
  claims keep the strict evidence rules in
  [research/EXACT_ENGINE_AGENTS.md](research/EXACT_ENGINE_AGENTS.md). The
  per-push chart review is retired; update `research/status.json` and run
  `python scripts/progress.py render --review "..."` only when native research
  changes.
- Most native recovery artifacts (recovered memory images, Ghidra project,
  emulator harness state) live only on the owner's Mac under the ignored
  `work/` directory. They are not in this repository.

## Checks before pushing

- `python3 -m unittest discover -s tests`
- `python3 scripts/check_public_tree.py`
- `python3 scripts/progress.py check`
- Simulator tests (once `sim/` exists).
- Install the hook: `git config core.hooksPath .githooks`.
