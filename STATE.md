# Project state: Clash Royale real-time simulator

The single source of truth for where the project stands. Read it after
[GOAL.md](GOAL.md) and [AGENTS.md](AGENTS.md), and keep it current.
Last updated 2026-10-11.

## The owner and what they want

- The owner (GitHub `aboufama`) plays Clash Royale **heavily** and judges the
  simulator by watching and playing it. They will notice wrong hit timings,
  speeds, ranges, retargeting and pathing.
- They want a fully working battle simulator where you can place any troop,
  with all projectiles, troops and art rendered properly. It must run **in
  real time**, because a "bitter lesson" style policy will be trained on it and
  must make dynamic decisions the way a player does. Headless training should
  run far faster than real time.
- Byte-identical equivalence is **not** required. The bar is "feels exactly
  right to an expert".
- They value honest status: what works, what's approximated, what's missing.

## History

1. **Overnight, 2026-10-10 to 11:** Codex agents tried to build an *exact*
   environment by emulating the original ARM64 engine (`libg.so`) in Unicorn.
   The game's own "Normal" test battle runs 904 steps on 8 externally supplied
   troop placements and reproduces byte-for-byte. It is about **7× slower than
   real time**, can't take arbitrary actions, and has no reset or full state
   capture. Details: `research/findings.md`, `research/evidence/`, and the
   native-track section of [README.md](README.md).
2. **2026-10-11 pivot:** the owner chose a fast reimplementation with the
   original art and data. The repository was made **private** and the original
   game files were added under `game-files/` ([docs/DECISIONS.md](docs/DECISIONS.md)).
3. Codex's methods (evidence receipts; separating observed, inferred and
   unknown; parallel agents with separate scopes) came from **REA**
   (github.com/morluto/rea), which Codex reviewed but never ran
   (`research/rea-review.md`). The REA idea that matters now is its DX-Ball
   pattern: decompile one function, port it, then differentially test the port
   against the original binary. Use it for core mechanics (V-level fidelity).

## Current state

| Area | State |
| --- | --- |
| Game files | ✅ `game-files/`: the APK bundle (contains `libg.so`) and all 10,870 asset-pack files, hash-manifested ([game-files/README.md](game-files/README.md)) |
| Gameplay data | ✅ `tools/data/`, standard-library Python only. It decodes 648 logic files (0 errors) into 66 JSON tables plus `cards.json` with mechanic flags. Field meanings, units and level scaling are in [docs/DATA_FIELDS.md](docs/DATA_FIELDS.md) |
| Art | ✅ `tools/art/` decodes the SC2 sprite format (`.sc` v5: FlatBuffers + zstd) and the `.sctx` ASTC textures, and renders original animation frames to sheets plus JSON (anchor, hit frame). Verified on the Knight's run and attack animations. See [tools/art/README.md](tools/art/README.md) |
| Mechanics facts | ✅ [docs/MECHANICS_BRIEF.md](docs/MECHANICS_BRIEF.md): tick rate, units, elixir, pathfinding, attack timing, King activation and end rules, measured from native runs |
| Engine | ❌ Not started |
| Viewer | ❌ Not started |
| Training bridge | ❌ Not started |

### Key facts so far

These come from the brief and the data notes.

- **Ticks:** 20 per second (50 ms each). The match is 180 s plus 120 s of overtime.
- **Space:** integer game units at 1000 per tile. The arena is 18000×32000. The path grid is 36×64 cells of 500 units, with the river at y 15000–17000.
- **Elixir:** stored ×10000. It regenerates exactly 178 units per tick at 1× elixir. Players start with 6, and the max is 10.
- **Deploying:** a deploy commits 20 ticks after it is played. The unit becomes active after its data `DeployTime` (usually 1000 ms).
- **Movement:** a unit moves its data `Speed` value in game units per tick. Pathing is A* on the 500-unit grid, with step costs 10/14 × cell cost.
- **Attacks:** units spawn preloaded, so the first hit lands after `HitSpeed − LoadTime`. Damage is applied at the end of the same tick.
- **King tower:** activates 3300 ms after it is first damaged or a Princess tower falls.
- **Level scaling:** `stat(L) = floor(base × M[L−1−rel]/100)`, with M = 100, 110, 121, … At tournament level 11 the multiplier is 256 (Knight: 1766 HP, 202 damage).
- **Art:** units are **2D sprite movie clips**. Exports are named `{Blue|Red}ExportName_{run1|idle1|attack1}_{1..9}`: direction 1 faces away, 5 faces right, 9 faces the camera, and left-facing frames are mirrors, giving 16 directions. The frame label `action_frame` marks the hit. The `sc3d/*.glb` files use a custom Supercell FlatBuffer glTF that stock loaders reject.

## Repository map

| Path | What |
| --- | --- |
| `GOAL.md`, `AGENTS.md`, `CLAUDE.md` | Goal and rules. `CLAUDE.md` imports `AGENTS.md` |
| `STATE.md` | This file |
| `docs/FIDELITY.md` | Per-mechanic fidelity level (V/P/D/A/–) |
| `docs/DECISIONS.md` | Decisions and their reasons |
| `docs/DATA_FIELDS.md`, `docs/MECHANICS_BRIEF.md` | Data meanings and native mechanics facts |
| `game-files/` | Original inputs. **Private; never publish** |
| `tools/data/`, `tools/art/` | Extraction tools. Outputs go to the ignored `extracted/` folder |
| `sim/` | Not created yet: the engine, viewer and training bridge go here |
| `research/`, `scripts/`, `tests/` | Paused exact-engine track |

**Only on the owner's Mac:** about 7 GB of native recovery artifacts (the
Ghidra 12.1.4 project for `libg.so`, recovered memory images, the Unicorn
harness, per-tick frame captures) live in Codex's local `work/` folder.
Differential (V-level) checks against the original code have to run there.
From the cloud, list what should be checked and ask the owner.

## Prior art (public, permissive licenses)

- **ClashRoyaleAi**, github.com/itzik123/ClashRoyaleAi (MIT): C++, 132 cards and
  41 Evolutions, about 20,000× real time, Python bindings, PPO, WASM.
- **crforge**, github.com/voonhous/crforge (Apache-2.0): Java ECS, 100+ cards,
  Gymnasium bridge, docs on established versus guessed mechanics.
- **Both get native fundamentals wrong.** ClashRoyaleAi runs at 10 ticks/s on
  an 18×34 float board. crforge uses float speeds (60 = 1000 units/s) and a
  starting elixir of 5. Use them for ideas and coverage lists, not numbers.

## Next steps

1. **Set up:**
   - Verify the inputs with `cd game-files/asset-pack && shasum -a 256 -c ../asset-pack.sha256 --quiet`.
   - Run `tools/data` (three commands in its README) and set up `tools/art`
     (`pip install -r tools/art/requirements.txt`).
2. **Confirm the engine base with the owner.** The recommendation is a
   from-scratch TypeScript engine built on the native facts above, because the
   open-source engines differ on fundamentals. Record the choice in
   `docs/DECISIONS.md`.
3. **M1, engine core** in `sim/`:
   - A deterministic 20 Hz integer engine: arena and tilemap from data, towers,
     elixir, timeline and overtime, deploy rules, crowns and end conditions.
   - The first cards: Knight, Archers, Giant, Musketeer, Fireball, Arrows.
   - Headless tests that check the brief's numbers, for example Knight hits at
     ticks 9/33/57 and elixir at 60000 + 178×tick.
4. **Art bake:** turn each needed unit, tower, projectile and effect into
   texture atlases plus frame JSON (per action and direction), under an ignored
   build folder generated by a script.
5. **M2, viewer:** a browser renderer at 20 Hz with interpolation,
   drag-and-drop cards for both sides, pause/step/speed controls, HP bars,
   elixir and the clock. Show the owner early; their smell test is the
   acceptance criterion.
6. **M3, training bridge:** a Python env with a legal-action mask, a throughput
   benchmark and random-vs-random self-play.
7. Then card coverage (M4) and the fidelity pass (M5); see [GOAL.md](GOAL.md).

## Open questions for the owner

- Do they agree with the engine base (from-scratch TypeScript)?
- What training stack and scale do they plan? This sets how fast the engine needs to be.
- Which cards or decks should come first after M1?

## Known gaps

- The push/collision algorithm was not recovered; it must be approximated.
- Retargeting details are low-confidence.
- Double and triple elixir regen rates are inferred, not observed.
- Some card stats may round rather than floor (see `docs/DATA_FIELDS.md`).
- Live game updates after install aren't included in `game-files/`.
