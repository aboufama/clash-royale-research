# Project state: Clash Royale real-time simulator

The single source of truth for where the project stands. Read it after
[GOAL.md](GOAL.md) and [AGENTS.md](AGENTS.md), and keep it current.
Last updated 2026-10-11 (native movement, spells and formations ported; 70 cards with original art).

## The owner and what they want

- The owner (GitHub `aboufama`) plays Clash Royale **heavily** and judges the
  simulator by watching and playing it. They will notice wrong hit timings,
  speeds, ranges, retargeting and pathing.
- They want a fully working battle simulator where you can place any troop,
  with all projectiles, troops and art rendered properly. It must run **in
  real time**, because a "bitter lesson" style policy will be trained on it and
  must make dynamic decisions the way a player does. Headless training should
  run far faster than real time.
- **Update 2026-10-11 (mid-session):** the owner now wants the visuals to be
  indistinguishable from the real game and the behaviour byte-identical for a
  limited troop set; they will smell-test it by playing. Byte-identity can only
  be shown against the original engine, so mechanics are ported from the
  decompiled `libg` and checked against the recorded native traces
  ([docs/DECISIONS.md](docs/DECISIONS.md)).
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
| Engine | ✅ `sim/core`: deterministic 20 Hz integer engine; 70 playable cards (`supportedCards`). Ported from the decompiled `libg` (P in [docs/FIDELITY.md](docs/FIDELITY.md)): world tick order, attack clock, targeting and retargeting, default tower by lane, collision push, A* and cell costs, dynamic building occlusion, goal-cell selection, path requests, arena collision, avoidance sidestep, stop-and-go walking, knockback, river jump, charge, area-effect pulses, building decay, spell cast from the King tower (Arrows scatter on the native RNG), summon formations and deploy delays, pending-damage targeting, projectile hits and chain hops, piercing and rolling projectiles (Log, Barbarian Barrel, Bowler, Executioner, Magic Archer), projectile spawn/setup and height, impact spawns (Goblin Barrel), tower and building default targets, stuns and damage over time, jumping-unit rules, the damage-key window and the deploy check with its zone map. 67 core tests, including the 400-tick native trace (539/539 positions and all HP exact) and the 12 native A* cases. ~3,500× real time per core |
| Viewer | ✅ `sim/viewer`: the build's own SC2 movie clips in WebGL for every supported unit, building, projectile, area effect and buff; tower ruins, deploy clocks, original card art in the hands and palette; drag-and-drop for both sides, sandbox palette, pause/step/speed. The battle projection is the client's own (0x857ffc: 30 × 24 px per tile, 12 px per 1000 height, blue sees the 180°-turned view with logic x right-to-left) and shadows follow the client's shadow pass (flipped skewed silhouettes, one composite with the location colour). The HUD is the client's own exports and layout (hand cards with the RadialFill elixir mask, elixir bar, clock, crowns, the played card's "-cost" float text); the arena's nested clips animate and the location cloud shadows drift (0x857a50); the effect system (particles with tails measured on the clip's current rotated height, screen shake) is ported. The sandbox side panel wears sc/ui_common.sc buttons and popups (`?clean` hides it). Unit libraries stream in on demand (core + both decks at startup) |
| Demo (GitHub Pages) | ✅ Live at https://aboufama.github.io/clash-royale-research/ . `.github/workflows/pages.yml` bakes the art, tests and builds the viewer and deploys on every push to `main` (Pages source: GitHub Actions). The repository was made public by the owner (2026-10-11) to serve Pages; the Checks workflow flags `game-files/` in a public repo by design |
| Training bridge | ❌ Not started |

### Key facts so far

These come from the brief and the data notes.

- **Ticks:** 20 per second (50 ms each). The match is 180 s plus 120 s of overtime.
- **Space:** integer game units at 1000 per tile. The arena is 18000×32000. The path grid is 36×64 cells of 500 units, with the river at y 15000–17000.
- **Elixir:** stored ×10000. It regenerates exactly 178 units per tick at 1× elixir. Players start with 6, and the max is 10.
- **Deploying:** a deploy commits 20 ticks after it is played. The unit becomes active after its data `DeployTime` (usually 1000 ms).
- **Hand cycle:** the played card stays in its slot (hidden by the client) until its play commits; then the slot empties and the hand timer refills it from the queue, at most one fill per NextSpellCooldownMS (1000 ms at first), so the next card appears about 1 s after the release (0xf9f23c, 0xfa5b4c).
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
| `sim/` | `core/` engine + tests, `viewer/` browser viewer, `bench/` throughput, `data/gamedata.json` (generated by `tools/data/export_sim_data.py`) |
| `research/`, `scripts/`, `tests/` | Paused exact-engine track |

**Only on the owner's Mac:** the Unicorn harness and per-tick frame captures
of full native matches live in Codex's local `work/` folder. Differential
(V-level) checks against whole native matches have to run there.

**In this cloud container (ignored, not committed):** `work/native/` holds a
rebuilt decrypted `libg` (`libg-patched.so`), two Ghidra projects,
`decompile.sh` (headless decompile of any address), `PORT_NOTES.md` and 146+
decompiled battle functions. A fresh container must rebuild them with the
recovery scripts (see `work/native/RECOVERY_LOG.md` if present, or the
README's native-track section).

## Prior art (public, permissive licenses)

- **ClashRoyaleAi**, github.com/itzik123/ClashRoyaleAi (MIT): C++, 132 cards and
  41 Evolutions, about 20,000× real time, Python bindings, PPO, WASM.
- **crforge**, github.com/voonhous/crforge (Apache-2.0): Java ECS, 100+ cards,
  Gymnasium bridge, docs on established versus guessed mechanics.
- **Both get native fundamentals wrong.** ClashRoyaleAi runs at 10 ticks/s on
  an 18×34 float board. crforge uses float speeds (60 = 1000 units/s) and a
  starting elixir of 5. Use them for ideas and coverage lists, not numbers.

## How to run

```sh
cd sim && npm install
npm test                 # engine tests (Node 22+ runs the TypeScript directly)
npm run bench            # headless throughput
npm run dev              # viewer at http://localhost:8080 (needs baked art for the original look)
```

Bake the original art for the viewer (about 2 minutes, ~150 MB into the
ignored `sim/viewer/assets/`): `.venv/bin/python tools/art/bake_web.py`
(see [tools/art/README.md](tools/art/README.md)).

Regenerate data: `python3 -I tools/data/decode_assets.py && python3 -I tools/data/build_json.py && python3 -I tools/data/build_cards.py && python3 -I tools/data/export_sim_data.py`.

## Next steps

1. **Remaining native ports** (A rows in docs/FIDELITY.md): the default lane
   goal without a target (0xd43a4c: a mode subsystem at ctx+0x358 whose vt+0x48
   is not yet identified), King activation conditions (TOML scripting), the
   buff add/refresh rules (Buff_add 0xfc0e08 is decompiled in
   `work/native/decomp_eng/`) with the attack stun field (attack +0x74), damage
   over time first-tick timing, spawner and death-spawn placement, the Miner
   state machine, area-effect candidate grid order, the world-list interleaving
   of characters, projectiles and area effects in the actor-update phase.
   Done 2026-10-11 (third pass, PORT_NOTES §9, `projectiles.test.ts`,
   `towers.test.ts`): piercing and rolling projectiles (0xf8f2d0 / 0xf8ff74 box
   query, out-and-back axe, Log/Barbarian Barrel cast from the target point),
   projectile spawn and setup (0xf8e4c8 / 0xf8e6fc / 0xf8fb34, projectile
   height `z`), impact spawns (Goblin Barrel formation, priorities), tower and
   building default targets, the Arrows scatter check, jumping-unit rules
   (targetability, Log immunity, JumpHack pushback immunity), summon lane hints
   and the arena clamp of 0xd35ab4, and the loader's Mass formula (crown towers
   derive mass 20; the fitted value is gone). Earlier: pending-damage overkill
   rule (0xf94824), projectile flight/hit/chain (0xf90708, 0xf9188c), damage
   apply and key window (0xfcaeec), deploy check and zones (0xf9e16c, 0xfa2c0c,
   0xfa023c); see `sim/core/test/ported.test.ts`.
2. **Differential checks:** ask the owner to run the Mac harness on a few
   scripted matches (two knights crossing, Arrows on Skeleton Army, Giant vs
   Cannon, Hog Rider jump) and record per-tick positions/HP; add them as tests.
3. **Card coverage (M4)** by mechanic family: dashes, attack sequences,
   scripted actions, multi-projectile troops, Tornado, Clone, Graveyard,
   Earthquake, champions, evolutions.
4. **Speed:** the native movement made each tick dearer (~4,000× real time);
   inline the A* visit loop, keep spatial queries allocation-free.
5. **HUD left:** the timed announcements of the HUD time update 0x8d38c4
   (print_endTimer countdown, print_60secondsLeft(_overtime) /
   print_30secondsLeft, print_extra_time, print_tiebreaker, the elixir-speed
   banner 0x8d4fe0), the elixir float texts (the own play's path is not
   recovered: 0x8df9fc is the spectate HUD; 0x85ada8 → 0xbe5898 is the other
   caller), the full-elixir hand wiggle (0x907654 / 0x907ab0). Training bridge
   (M3) and the fidelity pass (M5); see [GOAL.md](GOAL.md).
6. **Viewer fidelity left:** the battle layer's vertical placement under the
   HUD (width framing is ported: 578.5 SC px on tall phones), the arena clip field
   +0x84 used as the 180° turn's ty (768 assumed), how the client picks
   direction frames under the flip, particle emitter semantics, the deploy
   preview (the engine now snaps drops with the deploy check 0xf9e16c; the
   viewer still previews at the pointer). 0x83c0ac is the HideBeforeFirstHit
   scale, which no unit in this build uses. Decompiles for the view work are in
   `work/native/decomp_shadow/` and `decomp_anim/`.

## Open questions for the owner

- Pocket deploy area after a Princess tower falls: now from the decompiled zone
  map (the fallen tower stops stamping its 11×21 no-deploy area; the King's
  18×16 area still blocks), i.e. that lane from the river to y 20999. Worth a
  smell test.
- Starting elixir: the owner said to follow the decompile; data and the native
  run both give 6.
- Training stack: the owner says it doesn't matter yet; optimise for speed
  (millions of runs).
- Which cards or decks should come first after M1?

## Known gaps

- Unit-vs-unit pushing, avoidance, knockback and formations are ported from
  the code but not yet checked against a native trace.
- The battle RNG uses the native algorithm with a local seed.
- Double and triple elixir regen rates are inferred, not observed.
- Some card stats may round rather than floor (see `docs/DATA_FIELDS.md`).
- Live game updates after install aren't included in `game-files/`.
- The overtime tiebreak (lowest tower HP decides a tied match) has a UI string
  (`TID_OVERTIME_TIEBREAKER`) but no logic in the data. The native test runner
  scored a tie as a draw (−1), so the tiebreak will be an approximation (A).
