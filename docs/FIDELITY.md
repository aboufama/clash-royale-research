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
| Movement | Pathfinding (A*) | P | Path_astarRun 0x11d84ac / expand 0x11d7e18: start expanded first, neighbours N,S,W,E (10) then NW,SW,SE,NE (14) × destination cell cost, f = g + 5·(10(dx+dy) − 6·min), native heap sift rules (ties go to the right child), open nodes refreshed, closed never reopened, out-of-grid goal moved to the nearest in-grid cell. Path_cellCost 0x11d9304: river (tile bit 32) = water cost 7 for Hovering/JumpEnabled, else 50; static building tile 50; road 5 / default 8; max with the dynamic occlusion grid. Actor lanes not modelled (road and matching-road costs are equal in this build) | Trace ✓ 12 native A* fixture cases: paths and goal costs exact | |
| Movement | Path request and goal cell | P | Movement_requestPath 0xfcca18 every walking tick and on every target change: goal cell 0xfcdefc (cells within R/500+1 of the target's cell whose centre is within the approach distance R = Range + own radius; dry and unoccluded cells first; nearest to self, native scan order for ties; the fast search is checked against the plain scan), path kept while its goal cell is unchanged unless the team's occluders changed (FRIENDLYONLY_OCCLUSIONS), old path kept when the occlusion change touches neither path (0x11d9c2c); flyers path straight to the goal cell. No target: the default lane goal 0xd43a4c is not ported (path kept) (A) | 20000 random cases fast = plain scan | |
| Movement | Dynamic occlusion | P | 0x11d8d9c each pre-tick: every building (crown towers included) stamps cost 50 over the cells of a square of half-size CollisionRadius around the cell corner at/above its position (0x11d8f10); per-team occluder hashes trigger re-paths | – | |
| Movement | Path following | P | MovementComp_update 0xfcc578 / geometricStep 0xfcef48: sub-steps ≤ 250, waypoint consumed when the remaining distance along its stored direction < 1001, velocity quantised to 1/256; with no path, a step toward the approach point (target + (self − target) scaled to R) or standing when in range (0xfcedb0); facing set to the step direction at length 256 | Trace ✓ 400-tick fixture exact | |
| Movement | Arena collision | P | Arena_collision 0x11d988c: per axis, crossing into a cell outside the grid is clamped to the cell edge; river tiles block only deploying ground units (or callers that ask). Walking units are kept off the river by path costs only | – | |
| Movement | Avoidance sidestep | P | Movement_avoidSidestep 0xfce42c: query one facing vector ahead (radius min(r, 500)) in native grid order; static blockers drop a waypoint inside them and pick the side by cross product; moving blockers not heading the same way pick by their side or sidestep; ±200 (nudged ±20), decays 10/tick, rotates the step (0xfcef48) | – | |
| Movement | Stop-and-go walking (Giant, Golem, Royal Giant, Ice Golem…) | P | Walking clock +50/tick (buff-scaled /2); after StopMovementAfterMS the unit stands for WaitMS, then the clock wraps | – | |
| Movement | Lane / default target | P | AttackComp_findDefaultTarget 0xfc5398 (XPOS_BASED_TOWER_TARGETING, PRINCESS_TOWERS_ALWAYS_AS_DEFAULT_TARGET): the enemy princess tower on the unit's lane with the smallest \|dx\| if nearer than the King, else the King; lane = road bits of the nearest road cell at spawn (0xd38d9c). With nothing in sight a unit keeps its target while its path runs backwards (LOGIC_PATHFIND_BACKWARDS_TRY_KEEP_TARGET, 0xfcf680); an invalid default leaves the target unchanged | – | |
| Movement | Collision push | V/A | Movement_collidePush 0xfce900: neighbours from the 1024-unit grid (tick-start cells) within radius+20, pen = min(R−len,300)×m_other/m_self ≤ 299, push += (pen+1)·d/len, averaged and capped at length 150; static neighbours use self radius ≤ 500; deploying, attacking and frozen units are pushed too; jumping units neither push nor are pushed (P). Crown towers push as mass 20 (fitted; the radius rule gives 2) (A) | Trace ✓ 539/539 positions exact | |
| Movement | Mass | P | Missing Mass derived from radius, clamped to [1, 20] (loader 0xdde618) | – | |
| Movement | Knockback (pushback) | P | applyPushback 0xfcfac4 / startPushback 0xfcfbd4: refused while already knocked back or for IgnorePushback (unless PushbackAll); destination pos + direction × min(amount, 40000); step speed starts at the smallest 25n with 25(1+…+n) ≥ distance, −25 per tick through a final unguarded −25 step (travels short of the nominal distance); no swing while knocked back; dry-land snap 0xd392c8 on river/no-deploy tiles; piercing projectiles push along their flight (0xfcfe18) | – | |
| Targeting | Target choice | P/A | AttackComp_findTarget 0xfc4c38: grid query order, sight = SightRange + own radius, +2000 to crown towers, SightClip/SightClipSide, nearest dist2, ties keep the earlier (P); default target 0xfc5398 (P, see Lane row); buildings take no default target (A); pending-damage overkill skip (A) | Trace ✓ fixture choices | |
| Targeting | Keep / drop target, ranges | P | inRange: dist2 ≤ (r_target + Range + r_self + extra)²; keep with +25 (+500 for ranged units mid-swing); setTarget resets the attack only for an out-of-range new target (0xfc3cb4) | Trace ✓ retarget at tick 3 | |
| Targeting | Air vs ground, buildings-only | D | AttacksAir / AttacksGround / TargetOnlyBuildings / TargetOnlyTroops | – | |
| Attack | Hit timing, preload, reload | V | AttackComp_update/advanceClock 0xfc7e20/0xfc90b0: monotonic timer, hit when floor(timer/HitSpeed) increases, first swing starts at LoadTime − load, load = LoadTime after each attack, swing continues once started, cancelled beyond range+1500 | Trace ✓ Knight 9/33/57; 400-tick fixture all HP exact | |
| Attack | Clock while walking | P | When a unit is not swinging (target out of range and no swing in progress, or knocked back) the attack resets and the unit walks again (0xfc7e20); load counts down 50/tick | – | |
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
| Special | River jump (Hog, Prince, Royal Hogs…) | P/A | JumpEnabled units path with water cost 7; on reaching a waypoint before a river cell they jump (state 5) to the first dry path cell at JumpSpeed until fewer than 2 steps remain (0xfcc578, 0xfcf594); no attacks and no collision while jumping (P); jump height for the viewer and targetability during the jump (A) | – | |
| Special | Charge (Prince, Dark Prince, Battle Ram) | P/A | Charge += step·1000/ChargeRange while walking; resets on any step < 1 or non-walking state (except jumping); a charged unit's first swing completes at once (attack+0x3f, 0xfc90b0) with DamageSpecial (P); ChargeRange units (A: read as the data value) | – | |
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
| Unit, building, tower, projectile, effect art | D/A | Original SC2 movie clips from the build's `.sc`/`.sctx` files (tools/art/bake_web.py), played in WebGL for all 70 supported cards (D). Clip choice from engine state (deploy / attack timed to the hit tick / run / idle), building turrets and Tesla states, and effect/particle playback timing (A) |
| Area effects, buff filters, tower ruins | D/A | Area-effect ground circles scaled to the data radius, looping/one-shot effects for the object's lifetime; buff colour filters (cold, rage, poison); white hit flash approximated with `filter_target`; tower ruins from the default death effects' permanent particles (D); buff filter ease-out on expiry not recovered (A) |
| Deploy clock, card art | D | `troopDeployTimer_player/_enemy` over deploying units (fraction of DeployTime); hand and palette use the original card frame, icon and elixir cost |
| HUD (hand, elixir, clock, crowns, HP bars) | A | Placeholder HTML/canvas styling, not the game's HUD art yet |
