# Clash Royale battle mechanics brief (build 160402020)

This brief collects what the exact-engine research established about the
original engine, as starting facts for the simulator. It was compiled
2026-10-11 from Codex's notes.

**Tags:**

| Tag | Source |
| --- | --- |
| [OBS] | Seen in an original native run: the 8-input Normal diagnostic episode (EP) or a native fixture |
| [STAT] | Read from the static decompilation |
| [DATA] | Taken from the original decoded game data |
| [HYP] | Inference |

**Paths:**
- `research/…` and `scripts/…` are in this repo.
- `work/…` exists only on the owner's Mac, next to the repo checkout; it is not in the repo.
- `EP` = `work/root-verification/external-eight-input-episode-v1`.
- `D` = decoded `csv_logic`. Originals are in `game-files/asset-pack/assets/csv_logic`; decode them with `tools/data/`.

## 1. Time

- **Tick length:** one tick is 50 ms (20 Hz).
  - The attack timer advances by 50 each tick [OBS] (research/evidence/native-attack-clock.json; research/findings.md:290).
  - At the end of EP, timeline field +0x24 = 45150 = 903×50, and field +0x28 = 180000 [OBS] (EP/episode-result.json).
  - Observed attack intervals match the data's hit speeds [OBS] (EP/visual/frames.jsonl.gz): Princess tower every 16 ticks (800 ms), King tower every 20 (1000 ms), Wizard every 28 (1400 ms).
  - The production loop converts accumulated seconds to ticks at ×20 and subtracts 0.05 s per tick [STAT] (work/platform-agent/action-interface-static-v2/findings.txt:6-7).
- **Diagnostic length:** 904 steps, or 45.2 s. It ended early when owner 0's King tower died (research/findings.md:884-891).
- **Deploy delay:** every command commits exactly 20 ticks after submission (97→117, 100→120, and so on for all 8) [OBS] (research/evidence/native-external-full-match.json).
  - The command manager checks for an age of at least 20 ticks [STAT] (work/static-agent/external-action-review/findings.txt:55; work/platform-agent/action-interface-static-v2/findings.txt:15).
  - The actor joins the live list on the tick after commit [OBS].
  - It starts moving 20 ticks later, which matches DeployTime 1000 ms (118→138, 304→324, 755→775) [OBS].
  - The 5 Barbarians started 2 ticks apart (145, 147, 149, 151, 153). This looks like DeployDelay 400 ms spread across 5 units [OBS/HYP].
- **Match timeline:** the Default timeline is 180 s Normal plus 120 s Overtime [DATA] (D/battle_timelines.csv:3-5).
  - StartingElixir is 6.
  - The time to fill the elixir bar is 28000 ms, then 14000 ms, then 9300 ms.
  - NextSpellCooldown is 1000 ms, then 500 ms, then 350 ms.
- **Start cooldown:** LOGIC_BATTLE_START_COOLDOWN is 4500 (D/globals.csv:271). Context field +0x200 counts down by 50 per tick and fires a startup path at zero [STAT] (work/static-agent/deployment-analysis/findings.txt:55).
- **Test cap:** the built-in test runner stops after 36000 steps [STAT].

## 2. Space

- **Units:** integer, 1000 units per tile. The arena is 18000×32000 [OBS].
- **Towers at frame 0** [OBS] (EP frame 0):
  - Owner 0: King at (9000,3000) with 2400 HP; Princess towers at (3500,6500) and (14500,6500) with 3052 HP each.
  - Owner 1: mirrored with y′ = 32000−y, so (9000,29000), (3500,25500) and (14500,25500).
- **Map grid:** 36×64 cells, 500 units each (research/findings.md:459-461). From `assets/tilemaps/tilemap.csv`:
  - Water (value 32) fills rows 30–33, which is y 15000–17000.
  - Bridges are columns 5–8 and 27–30, which is x 2500–4500 and 13500–15500.
  - Road cells are 1 and 2 (left and right lane). Blocked cells are 16.
  - The King tower's footprint is x 7500–10500, y 1500–4500.
- **Path grid:** path destinations are divided by 500 to get grid cells [STAT] (work/runtime-agent/findings.txt:128).
- **Deploy zones** [OBS]: owner 0's deploy y is clamped to at most 14500; owner 1's to at least 17499.
- **Snapping:**
  - Owner 0 snaps to tile centres at 1000k+500.
  - Owner 1 snaps to 1000k+499, which fits snapping in a mirrored frame of (17999−x, 31999−y) [OBS/HYP]. One exception: (13701,10693) became (13500,17499).
  - LOGIC_SYMMETRICAL_DEPLOY_SNAP is TRUE (D/globals.csv:266).
  - The 2×2 Goblin Drill snapped to a tile corner: (11560,3193) became (12000,3000) [OBS].
  - The spawn centre is clamped to 250..(dim×500−250) [STAT] (work/static-agent/deployment-analysis/findings.txt:33).
- **Teams:** team = owner % 2 [STAT] (work/runtime-agent/findings.txt:157).

## 3. Elixir

- One elixir is 10000 units [STAT] (work/static-agent/deployment-analysis/findings.txt:31).
- Playing a card debits min(cost×10000, current) and adds it to an accumulator at `king+0x340` [STAT].
- Regeneration is exactly **178 units per tick** on every interval between commits, which is floor(100000/560) [OBS].
- Elixir equals 60000 + 178×frame through frame 754, consistent with StartingElixir 6 [OBS+DATA].
- MAX_MANA is 10 (D/globals.csv:7).
- Double and triple elixir probably regenerate 357 and 537 units per tick [HYP].

## 4. Movement and pathfinding

- **Search:** A* using a binary heap. Neighbour order is N, S, W, E, NW, SW, SE, NE [STAT] (work/runtime-agent/findings.txt:113-115).
  - Each step costs 10 (straight) or 14 (diagonal), multiplied by the destination cell's cost. The heuristic is octile distance.
  - Native fixture path costs of 448, 280, 406 and 496 confirm this [OBS] (research/evidence/native-pathfinding.json; research/findings.md:260-273).
  - The returned path is reversed and excludes the start cell.
- **Cell costs:** default 8, road 5, water 7, blocked or building 50. SAMEPATH_EPSILON is 3, and dynamic occlusions are on (D/globals.csv:734-758).
- **Speed:** a unit moves its data **Speed** value in units per tick [OBS].
  - Speed 60 troops moved 59–60 units per tick; Speed 90 troops moved 89–90; Speed 120 Goblins moved 120.
  - SpawnPathfindSpeed 300 moved 300 per tick.
  - A fixture with speed 50 moved (+35,+35) diagonally (research/evidence/native-world-movement.json).
  - crforge's "60 = 1000 units/s" contradicts this.
- **Step limits:** the last step is clamped to the remaining distance, and positions are clamped at the arena edges [STAT/OBS] (work/runtime-agent/findings.txt:140).
- **Collision:** there is a neighbour scan each update, and the data has Mass, CollisionRadius and MAX_PUSHBACK_LENGTH 40000. The push algorithm itself was **not** recovered.

## 5. Targeting

- **Range check:** a target is in range when dist² ≤ (Range + target collision radius + extra)². There is an optional minimum range [STAT] (work/static-agent/attack-execution/…__attack_range_check.c).
- **Target filter:** rejects same-team targets and applies tag and buildings-only checks [STAT] (work/static-agent/attack-analysis/…__target_policy.c).
- **Retargeting:** appears to reset the timer and set load progress to LoadTime − (timer mod HitSpeed), then request a new path [STAT, low confidence] (work/static-agent/attack-analysis/…__attack_candidate.c).
- **Related globals** (D/globals.csv:258-283): RANGE_EXTENSION_TO_KEEP_TARGET 25, PRESERVE_TARGET_IF_HIT_STARTED, CANCEL_HIT_FROM_LONG_DISTANCE_RANGE 1500, XPOS_BASED_TOWER_TARGETING, PRINCESS_TOWERS_ALWAYS_AS_DEFAULT_TARGET. Also EXTRA_SIGHT_RANGE_TO_CROWN_TOWERS 2000 (D/globals.csv:176).
- **King activation:** the King tower stays INACTIVE until `king_tower_damaged() || tower_destroyed()`, then spends 3300 ms ACTIVATING [DATA] (D/characters/king_tower.toml:54-61).
  - In EP the King was first hit at tick 621 and fired first at tick 697 [OBS].
  - 697 = 621 + 66 (3300 ms) + 10 (LoadTime 500 ms) [HYP].

## 6. Attacks

- **Clock scaling:** the per-tick increment is 50 × max(100, strongest haste)/100 × clamp(100 − strongest slow, 0..100)/100 [STAT] (work/static-agent/attack-dependencies/…__time_delta_scale.c).
  - Fixtures confirm it: haste 150 gave 75; slow −35 gave 32; both gave 48; −100 freezes the clock [OBS] (research/evidence/native-attack-clock.json).
- **Delay field:** while the delay field (+0x2c) is positive, it decreases by 50 per tick and the attack timer doesn't advance [OBS].
- **First hit:** units spawn **preloaded**. The timer starts at LoadTime+50, so the first hit lands after HitSpeed − LoadTime.
  - The Knight hit at ticks 9, 33 and 57 (HP 690→611→532→453) [OBS] (research/findings.md:336-340).
  - The Wizard finished deploying around tick 141 and fired first at 150 [OBS].
- **Damage timing:** damage is queued during the attack and applied at the **end of the same world tick** [OBS] (research/evidence/native-world-melee.json).
- **Shields:** a 100-point shield took 79 (leaving 21), then a hit broke it while HP stayed at 690. Excess damage is lost [OBS].
- **Projectiles:**
  - They spawn at ProjectileStartRadius toward the target, plus ProjectileYOffset for the King: (9750,3400) [OBS].
  - They fly their Speed in units per tick (600 for arrows, 1000 for the King's shot) and home on the target.
  - Damage lands the tick after the last observed position.
  - Wizard splash hit 4 Barbarians at once [OBS].
- **Related globals:** ATTACK_FINISH_TIME_MS 250, MELEE_RANGE_LIMIT 1900 (D/globals.csv:43,72).

## 7. Towers and end conditions

- **Princess tower:** HitSpeed 800, Range 7500, arrow damage 50 at base (109 at the test level) [DATA/OBS] (D/characters/princesstower.toml:16-56).
- **King tower:** HitSpeed 1000, LoadTime 500, Range 7000 [DATA/OBS] (D/characters/king_tower.toml:15-31).
- **Match end:**
  - The match ends **immediately** when any player/King actor's HP reaches 0 or below [STAT] (work/static-agent/runner-audit/findings.txt:12-19).
  - Otherwise it ends when elapsed time reaches the limit, subject to the stage rules. In timeline phase +0x2c == 1, it ends as soon as the scores differ.
  - Winner: score0 < score1 gives 1; score0 > score1 gives 0; equal gives −1.
  - In EP, owner 0's King went from 165 HP to 0 at frame 904, and the winner was 1 [OBS] (work/static-agent/external-end-audit-v1/findings.txt).

## 8. Object model

These are analyst labels; no original class names were recovered.

- **Classes:**
  - Base actor constructor `f939f4`.
  - Character `f7df40`, vtable `0x1935908`.
  - Projectile `f8d6e8`, vtable `0x1936050`.
  - Tower `f9c460`, vtable `0x1936518`.
  - An unknown class with vtable `0x1935708` and IDs from 3,000,000, created about once per tick.
- **Actor fields:** data pointer +0x48, owner +0x78, x/y at +0x7c/+0x80 (INT_MAX means unset). The global ID is at data+0x40 (work/platform-agent/visual-state/findings.txt:19-25).
- **Attack component:** target +0x10, timer +0x24, load +0x28, delay +0x2c.
- **ID ranges:** characters and buildings from 5,000,000; projectiles from 4,000,000.
- **Per-tick order** [STAT] (work/static-agent/deployment-analysis/findings.txt:55; research/findings.md:330-334):
  1. `10ca81c` calls `10ca9a0`.
  2. The command manager `d75ed0` runs.
  3. The level/world tick `f8cd90` runs: per-actor attack (`fc7e20`), actor and movement updates (`f800bc`, `fcc578`) and health, then the damage flush (`fd08cc`).
  4. The end check `10cb17c` runs.
  5. The frame counter increments.

## 9. The diagnostic Normal battle

- **Setup:** test mode, seed 1131, decks chosen by the game's own random logic. Levels follow TournamentLevelIndex: Common 10, Rare 8, Epic 5, Legendary 2 (work/runtime-agent/test-setup-audit/findings.txt:19-23).
- **Card names:** resolved from D/global_ids_oldformat.csv.
- **Owner 1:** Barbarians, Goblin Drill and Valkyrie, plus two unidentified cards.
  - The Goblin Drill digs, then drills, then spawns a Goblin every 60 ticks, plus 2 Goblins on death.
  - The unidentified cards: a 2-elixir unit with 896 HP and speed 90, and a 4-elixir building-hitter with 2030 HP.
- **Owner 0:** Wizard and Giant Skeleton, plus one unidentified 4-elixir ranged unit with a 1.1 s hit speed.
- **Knight:** appears only in the synthetic fixtures (690 HP, 79 damage).

## Audited public engines (for comparison)

- **crforge:** Java, 20 TPS, 1000 units per tile, float speeds (60 = 1000 units/s), starting elixir 5, ECS design. Its docs inconsistently cite 30 TPS.
- **ClashRoyaleAi:** C++, float tile units, an 18×34 board, 10 ticks/s, regulation time of 1800 ticks.
- Both approximate the game and differ from the native engine on speed scale, tick rate and starting elixir.

## Most useful files for a deeper look

- `research/findings.md`
- `research/evidence/{native-external-full-match, native-world-melee, native-attack-clock, native-pathfinding, native-world-movement}.json`
- `EP/visual/frames.jsonl.gz`: per-tick positions and HP for all 905 frames (Mac only)
- `work/static-agent/{findings.txt, deployment-analysis/findings.txt, runner-audit/findings.txt, attack-*/*.c}` (Mac only)
- `work/runtime-agent/findings.txt` and `work/platform-agent/action-interface-static-v2/findings.txt` (Mac only)
