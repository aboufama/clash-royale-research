# Mechanics fidelity tracker

Levels (see [GOAL.md](../GOAL.md#fidelity-policy)): **V** ported and
differentially verified against original code · **P** ported from decompiled
original code · **D** driven by the build's data files · **A** approximation
(say from where) · **–** not implemented.

The **Level** says where the behaviour comes from. The **Native check** column
says whether it was compared with the original engine, and how. "Trace ✓"
means a test in `sim/core/test/` replays a recorded native run from
`research/evidence/` or the native facts in
[MECHANICS_BRIEF.md](MECHANICS_BRIEF.md) and gets identical numbers. A mechanic
implemented from native observations and checked against a native trace is
still **D** or **A**, not V or P, until it is ported from the decompiled code.

Update a row in the same commit that changes the mechanic. "Owner check"
records the result of the owner's smell test, with the date.

Engine: `sim/core` (TypeScript, 20 Hz, integer game units). Tests: `cd sim && npm test`.

| Area | Mechanic | Level | Source / notes | Native check | Owner check |
| --- | --- | --- | --- | --- | --- |
| Match | Tick rate, per-tick order | P | 50 ms tick; world tick 0xf8cd90: all attack components, then all movement, buffs, actor updates, damage flush (PORT_NOTES §1.3); projectile/AEO interleaving with actor updates (A) | Trace ✓ 400-tick fixture exact | |
| Match | Match clock, overtime, sudden death | D | Default timeline 180 s + 120 s overtime; overtime ends at the first crown lead | – | |
| Match | Tiebreak after overtime | A | Lower lowest-tower HP loses (community rule). The data has a "Tiebreaker!" text but no logic; the native test runner scored ties as a draw | – | |
| Match | Elixir generation, max elixir | D | Start 6, max 10, per tick floor(10000×50/msPerElixir) = 178 at 1× | Trace ✓ 60000 + 178×tick; debit at commit (8 native debits) | |
| Match | 2× / 3× elixir | D | Same formula on the timeline's 14000/9300 ms bars → 357/537 per tick; not natively observed | – | |
| Match | Deck, hand of 4, next card, cycle | D/A | Played card goes to the back of the queue (A); next-card cooldown from NextSpellCooldownMS 1000/500/350 (D); seeded shuffle (A) | – | |
| Match | Crowns, tower destruction, end | D | King death ends at once; Princess = 1 crown, King = 3 (brief §7) | – | |
| Arena | Coordinates, arena size, river, bridges | D | 18000×32000 units, 36×64 path grid from tilemap.csv; towers from spawn group King_PrincessTowers | Trace ✓ tower positions (frame 0) | |
| Arena | Deploy zones | D | Own side clamp y ≤ 14500 / ≥ 17499, tile-centre snap, mirrored snap for red | Trace ✓ 6 native snap cases | |
| Arena | Pocket after a Princess tower falls | A | Lane half of the enemy side up to y 25000 (mirrored) — community knowledge, unverified | – | |
| Arena | Deploy blocked on towers/blocked tiles | A | UI rule: unit circle may not overlap a building; blocked/water tiles refused | – | |
| Deploy | Command delay | D | Commits when aged ≥ 20 ticks; joins the live list next tick; active after DeployTime | Trace ✓ 97→117 commit, 118 live, 138 moving | |
| Deploy | Group stagger | D | SummonDeployDelay per member (2 ticks for 100 ms) | Trace ✓ Barbarians 145,147,149,151,153 | |
| Deploy | Multi-unit formation positions | A | Circle of SummonRadius (default 500), starting left | – | |
| Movement | Speed units | D | Speed = game units per tick, components truncated | Trace ✓ speed 50 diagonal = (+35,+35) | |
| Movement | Pathfinding | D/A | A* on 500-unit cells, costs 10/14 × cell cost (default 8, road 5, blocked/building 50), neighbour order N,S,W,E,NW,SW,SE,NE, octile × 5 heuristic (D); water impassable for walkers (A); heap tie order (A) | Partial: costs match native fixture rules | |
| Movement | Path following | P/A | Sub-steps ≤ 250, waypoint consumed when remaining distance along its direction < 1001, velocity quantised to 1/256 (0xfcc578/0xfcef48) (P); path request timing (0xfcca18 not read) and arena collision (0x11d988c not read) (A) | Movement fixture rule ✓ | |
| Movement | Lane / default target | A | Nearest crown tower of the unit's lane by x (LOGIC_XPOS_BASED_TOWER_TARGETING), else King | – | |
| Movement | Collision push | V/A | Movement_collidePush 0xfce900: neighbours from the 1024-unit grid within radius+20, pen = min(R−len,300)×m_other/m_self ≤ 299, push += (pen+1)·d/len, averaged and capped at length 150; static neighbours use self radius ≤ 500 (P). Crown towers push as mass 20 (fitted; the radius rule gives 2) (A) | Trace ✓ 539/539 positions exact | |
| Movement | Mass | P | Missing Mass derived from radius, clamped to [1, 20] (loader 0xdde618) | – | |
| Movement | Knockback (Fireball pushback) | A | Pushback distance applied over 4 ticks; IgnorePushback respected | – | |
| Targeting | Target choice | P/A | AttackComp_findTarget 0xfc4c38: grid query order, sight = SightRange + own radius, +2000 to crown towers, SightClip/SightClipSide, nearest dist2, ties keep the earlier (P); default target when none in sight = lane crown tower (A: 0xfc5398 not read); pending-damage overkill skip (A) | Trace ✓ fixture choices | |
| Targeting | Keep / drop target, ranges | P | inRange: dist2 ≤ (r_target + Range + r_self + extra)²; keep with +25 (+500 for ranged units mid-swing); setTarget resets the attack only for an out-of-range new target (0xfc3cb4) | Trace ✓ retarget at tick 3 | |
| Targeting | Air vs ground, buildings-only | D | AttacksAir / AttacksGround / TargetOnlyBuildings / TargetOnlyTroops | – | |
| Attack | Hit timing, preload, reload | V | AttackComp_update/advanceClock 0xfc7e20/0xfc90b0: monotonic timer, hit when floor(timer/HitSpeed) increases, first swing starts at LoadTime − load, load = LoadTime after each attack, swing continues once started, cancelled beyond range+1500 | Trace ✓ Knight 9/33/57; 400-tick fixture all HP exact | |
| Attack | Clock while walking | P | Timer reset when the unit has no target; load counts down 50/tick | – | |
| Attack | Retarget keeps the clock | D | Observed natively | Trace ✓ | |
| Attack | Melee damage, damage at end of tick | D | Damage queued, applied in the end-of-tick flush | Trace ✓ HP sequences | |
| Attack | Projectiles: spawn, flight, homing, impact | D | Spawn at ProjectileStartRadius toward the target (+ProjectileYOffset), no move on spawn tick, Speed per tick with truncation, damage on arrival tick | Trace ✓ spawn (1730,1071), (548,1002); flight (665,930)→(84,117) | |
| Attack | Splash | P | World_areaDamage 0xf97be8: circles overlap strictly, buildings by the closest point of their square; centre = target snapshot or self (SelfAsAoeCenter) | – | |
| Attack | Kamikaze | D/A | Unit dies on its attack (Fire Spirits) | – | |
| Attack | Shields | D | Shield absorbs first; excess on the breaking hit is lost | brief §6 (not yet a test) | |
| Towers | Princess and King stats | D | Tower scaling table (L11: 3052 HP / 4824 HP, 109 dmg) | – | |
| Towers | King activation | D | Inactive until damaged or a Princess tower falls; 3300 ms ACTIVATING | Trace ✓ first shot 76 ticks after first damage (621→697) | |
| Towers | Tower targeting | A | Nearest enemy in range, locked until out of range or dead | Trace ✓ (Kings in fixture) | |
| Spells | Fireball, Arrows | D/A | Projectile, speed, radius, damage, crown-tower % from data (D); launched from the caster's King tower (A); Arrows: 3 waves 200 ms apart, damage radius = card Radius 3500 (A: the 10 visual arrows ignored) | – | |
| Spells | Crown-tower damage reduction | P | ((max(p,−100)+100)·dmg + 99)/100, rounded up (0xde0334); TowerDamage absolute when given (D) | – | |
| Effects | Buff speed / hit-speed multipliers (stun, slow, freeze, rage) | D | SpeedMultiplier/HitSpeedMultiplier from buffs; attack clock = 50×max(100,haste)/100×clamp(100−slow)/100 truncated (STAT formula); same shape for movement (A) | Clock formula ✓ (native fixture values 75/32/48) | |
| Effects | Stun/freeze resets the attack | A | A −100 hit-speed buff zeroes the attack timer and drops the target (community knowledge) | – | |
| Effects | Damage / heal over time | D/A | DamagePerSecond, HealPerSecond, HitFrequency, BuildingDamagePercent, CrownTowerDamagePercent (D); first tick one HitFrequency after application, immediate for HitTickFromSource (A: gives Poison 8 ticks, Earthquake 3) | – | |
| Effects | Buff stacking | D/A | EnableStacking: one instance per source; else refresh (A on refresh rule) | – | |
| Effects | Pull (Tornado), invisibility, damage reduction | – | | | |
| Spells | Area effect objects (Zap, Freeze, Poison, Lightning, Rage) | D/A | Radius, LifeDuration, HitSpeed/Offset, Damage/TowerDamage, Buff/BuffTime, Filter (game_object_filters), HitBiggestTargets, MaximumTargets, OneHitPerTarget, SpawnAreaEffectObject (D); hit schedule offset, offset+HitSpeed… ≤ LifeDuration (A: gives Lightning 3 strikes); Lightning bolt as a projectile landing next tick (A) | – | |
| Spells | Rage (bottle + area) | D | RageBottle lands (DeployTime 500), expires, spawns the Rage AEO and RageDamage | – | |
| Buildings | Lifetime decay | D/A | LifeTime from data (D); linear integer HP decay while active (A) | – | |
| Buildings | Minimum range (Mortar) | D | MinimumRange excluded from targeting and range checks | – | |
| Special | Death spawns | D/A | DeathSpawnCharacter/Count/Radius/DeployTime (D); positions on a circle starting left (A); death bombs (Balloon, Giant Skeleton) are 0-HP buildings that land after DeployTime and explode via DeathAreaEffect (D) | – | |
| Special | Spawners (Witch, Night Witch, Tombstone, huts) | D/A | SpawnNumber/PauseTime/Interval/StartTime, SpawnSpeedMultiplier from buffs (D); first group after SpawnStartTime else SpawnPauseTime, placement on a SpawnRadius circle from the front or in front of buildings (A) | – | |
| Special | Shields (Guards, Dark Prince) | D | ShieldHitpoints scaled; absorbs first, excess lost | brief §6 | |
| Special | River jump (Hog, Prince, Royal Hogs…) | A | JumpEnabled units may path through water (water cost 7) at JumpSpeed over water; jump arc, targetability during the jump not modelled | – | |
| Special | Charge (Prince, Dark Prince, Battle Ram) | D/A | ChargeSpeedMultiplier, DamageSpecial (D); ChargeRange read as data × 10 game units (A); reset by stopping without a target or by stun (A) | – | |
| Special | Elixir to opponent on death | A | ManaOnDeathForOpponent read as elixir × 1000 | – | |
| Special | Multi-character summons | D/A | SummonCharacterSecond(+Count, delay), SummonCharactersList with SummonCharactersOffsets and delay list, CustomDeployTime (D); two-group placement (A) | – | |
| Special | Deploy-time spells (Ice Wizard, Electro Wizard) | D/A | SpellAsDeploy card AreaEffectObject cast at commit, then the summon (A: timing of the cast) | – | |
| Special | Multiple targets + stun on damage (Electro Wizard) | D/A | MultipleTargets, BuffOnDamage/Time (D); extra targets = nearest others in range (A) | – | |
| Special | Inferno ramp | D | Damage → VariableDamage2 → VariableDamage3 after VariableDamageTime1/2 ms of attacking; reset on retarget/stun (A) | – | |
| Special | Chain lightning (Electro Dragon, Electro Spirit) | D/A | ChainedHitCount/Radius, TargetBuff (D); nearest unhit enemy from the last target, instantaneous hops (A) | – | |
| Special | Piercing projectiles (Bowler, Executioner, Magic Archer, Log, Barbarian Barrel) | D/A | ProjectileRange, ProjectileRadius(/Y rectangle), Pushback (D); straight flight from shooter (rolling spells from the target point toward the enemy) (A); Executioner out to max(MinDistance, target) ≤ range/2 then back (A) | – | |
| Special | Projectile spawns (Goblin Barrel, Barbarian Barrel) | D | SpawnCharacter/Count/DeployTime, card SummonCharactersOffsets | – | |
| Special | Elixir Collector | D | ManaCollectAmount every ManaGenerateTimeMs, ManaOnDeath | – | |
| Special | Tesla hiding | D/A | HidesWhenNotAttacking, HideTimeMs, UpTimeMs (D); untargetable while hidden, state machine (A) | – | |
| Special | Miner tunnelling | D/A | SpawnPathfindSpeed from the King tower, straight line, untargetable while underground (A) | – | |
| Special | Dash, scripted actions (heroes, champions, newer cards), attack sequences, evolutions | – | Planned | | |
| Scaling | Level and rarity scaling | D | floor(base × M[L−1−rel]/100), towers from tower scaling | Known L11 values ✓ | |

## Rendering (viewer)

| Item | Level | Notes |
| --- | --- | --- |
| Unit, tower, projectile, effect art | – | Being built: original SC2 movie clips played back in WebGL from the build's `.sc`/`.sctx` files (tools/art/bake_web.py) |
| HUD (hand, elixir, clock, crowns, HP bars) | A | Placeholder HTML/canvas styling, not the game's HUD art yet |
