# Clash Royale 160402020 — gameplay data fields, units, merge rules

Source: signed install-time asset pack of Android build 160402020 (fingerprint 16.402.2).
Produced by `tools/data/*` into `extracted/data/json/`. Confidence: **H** = verified from data
and/or several known in-game values, **M** = strong inference, **L** = guess.

## 1. Where data lives / merge rule

| Kind | Format in this build | Output |
|---|---|---|
| Troops, buildings, projectiles, area effects (AEO), buffs, actions, abilities | **TOML only.** No `characters.csv`/`buildings.csv`/`projectiles.csv` exist any more. Per-unit files `characters/*.toml`, `characters/hero_form/*.toml`, `events/*.toml` with namespaced tables `[CHARACTER.X]`, `[BUILDING.X]`, `[PROJECTILE.X]`, `[AEO.X]`, `[BUFF.X]`, `[ACTION.X]`, `[ABILITY.X]`, `[EXT.X]`…; plus top-level `characters_base/buildings/projectiles/area_effect_objects/character_buffs.toml` with bare `[X]` tables (namespace implied by file). `data_manifest.toml` lists the 256 per-unit files. | characters.json, buildings.json, projectiles.json, area_effect_objects.json, character_buffs.json, actions.json, abilities.json … |
| Cards | Classic CSV `spells_characters/buildings/other/evolved/hero_form.csv` **plus** TOML extensions (`spells_*.toml` bare tables and `[SPELL_*.Name]` in per-unit files). | spells_*.json, cards.json |
| Rules/tables | CSV: `globals`, `battle_timelines`, `rarities`, `game_modes`, `arenas`, `locations`…; TOML: `spawn_groups`, `support_cards` (tower troops)… | same name .json, match_rules.json |

Rules (H, checked in `_build_report.json`):
* Every unit/projectile/AEO/buff name is defined in exactly **one** file (0 collisions). `EXT.X`
  inherits `Base="NS.Name"` and overrides; operators: `["=",v]` set, `["+",v]` add,
  `["%",p]` = p % of base (e.g. Archer_EV1 `Range=["%",120]`). CHARACTER/BUILDING are
  interchangeable as Base targets (e.g. `Cannon_EV1` Base `CHARACTER.Cannon` is a building).
  Partial tables for the same name (e.g. `[[CHARACTER.ElectroWizardHero.AttackSequenceList]]`
  next to `[EXT.ElectroWizardHero]`) are applied on top. Output carries `_meta.extends`.
* Cards: CSV row is the base; **TOML wins field-by-field** (113 conflicts, all clearly newer
  TOML values, e.g. hero `SummonCharacter` `Knight`→`KnightHero`, `EvolvedSpells` string→list).
* CSV syntax: row 1 names, row 2 types; a row with empty Name continues the entry → arrays
  (used now only for rarities levels, timeline sections, array globals, game-mode lists).
  **Spell CSVs no longer carry per-level rows**; level values come from rarity scaling.
* `Damage` may be an int, `{BaseDamage, TowerDamage}` (TowerDamage = absolute crown-tower
  damage), or a string naming a `[DAMAGE_TYPE.X]` with those two keys.

## 2. Level scaling (H)
`stat(L) = floor(base * M[L-1-RelativeLevel(unitRarity)] / 100)`, `M = [100] + rarities.PowerLevelMultiplier`
= 100,110,121,133,146,160,176,193,212,233,256,281,309,339,372,409 (L1..16).
Almost all units are stored with `Rarity="Common"` = card-level-1 values, so the card's own
rarity only sets its first level (Common 1, Rare 3, Epic 6, Legendary 9, Champion 11).
Tournament standard = level 11 (`TournamentLevelIndex`), multiplier 256. Checked: Knight
1766 HP/202 dmg, Golem 5120/312, Mega Knight 3993/268, Giant 3968, P.E.K.K.A 3760,
Prince 1920 HP. Floor (not round) is inferred from MK 3993 / Musketeer 217 (M confidence;
a few remembered values such as Prince 392 would imply rounding — verify against a live client).
Precomputed in each record: `_meta.scaled = {_levels:[…], Hitpoints:[…], Damage:[…]…}`.
Towers do **not** use card multipliers (`DamageScalingMode`): m(1)=100, m(L)=floor(m(L-1)·(100+p)/100),
p = 8 (princess HP & dmg, king dmg) / 7 (king HP) up to level 9, then 10. Gives Princess
L11 3052 HP/109 dmg, King L11 4824 HP/109 dmg (H, matches known values). See `match_rules.json:tower_scaling`.

## 3. Units of simulation fields

Distances: game units, **1000 = 1 tile** (H: UI stat units `TILES`, Musketeer Range 6000 = "6"; arena 18000×32000).

| Field (table) | Meaning / unit | Conf. |
|---|---|---|
| Hitpoints, Damage, DamageSpecial (charge dmg), DeathDamage, DashDamage, ShieldHitpoints | level-1 integer values, scale per §2 | H |
| HitSpeed | ms between attacks (Knight 1200) | H |
| LoadTime | ms wind-up before the hit lands within an attack (first attack also waits this); `LoadFirstHit` = pre-loaded | M |
| DeployTime / DeployDelay | ms until unit becomes active (1000 standard; Golem 3000) / ms visual delay for group members | H / M |
| Speed (chars) | tiles per minute: 60 = 1 tile/s. Labels from client_globals UNIT_SPEED_1..5: ≤30 Very Slow, 45 Slow, 60 Medium, 90 Fast, 120 Very Fast, >120 Ultra Fast | H (thresholds) / M (tiles/min) |
| Speed (projectiles) | same scale assumed (Musketeer 1000 ≈ 16.7 tiles/s, Fireball 600, Rocket 350) | M |
| Range, SightRange, MinimumRange | game units; measured edge-to-edge (`ADD_CHARACTER_RANGE_TO_RADIUS`=TRUE) | H / M |
| CollisionRadius | game units (Knight 500, Giant 750) | H |
| Mass | dimensionless push weight (Skeleton 1 … Golem 20) | M |
| AttacksGround / AttacksAir / TargetOnlyBuildings / TargetOnlyTroops | booleans (missing = false) | H |
| AreaDamageRadius (chars), Radius (projectiles/AEO), DeathDamageRadius | game units | H |
| ChargeRange / ChargeSpeedMultiplier | distance of uninterrupted travel before charging (units, Prince 250 → see engine) / % speed while charging (200 = 2×) | M / H |
| DashMinRange/DashMaxRange, DashCooldown, DashLandingTime, DashImmuneToDamageTime | units / ms | M |
| JumpEnabled, JumpHeight, JumpSpeed | river jump (Hog, Prince…) | M |
| SpawnCharacter, SpawnNumber, SpawnStartTime, SpawnPauseTime, SpawnInterval, SpawnLimit | spawner; times ms (Witch: 4 skeletons, first at 1000, every 7000) | H |
| DeathSpawnCharacter / DeathSpawnCount / DeathSpawnProjectile / DeathAreaEffect | on-death spawns | H |
| LifeTime (buildings) | ms lifetime; HP decays over it | H |
| Kamikaze | unit dies on its attack | H |
| VariableDamage2/3, VariableDamageTime1/2 | inferno ramp stages / ms per stage | M |
| ManaCollectAmount, ManaGenerateTimeMs, ManaOnDeath(ForOpponent) | elixir collector / golem | H |
| CrownTowerDamagePercent | % modifier vs crown towers (Fireball −77 → 23 %) | H |
| Projectile: Homing, Gravity, AoeToAir/Ground, Pushback, ChainedHitCount/Radius, SpawnProjectile/SpawnChain, TargetBuff+BuffTime | flight/impact | M |
| AEO: LifeDuration (ms), HitSpeed (ms tick), Buff/BuffTime, Damage, HitBiggestTargets, SpawnCharacter/SpawnInterval | spells like Poison/Zap/Freeze/Rage | H |
| Buff: SpeedMultiplier, HitSpeedMultiplier, SpawnSpeedMultiplier (% ; −100 = freeze/stun, 130 = rage +30 %), DamagePerSecond + HitFrequency (ms), HealPerSecond, DamageReduction (%), AttractPercentage (tornado pull), Invisible | | H/M |
| Spell card: ManaCost (elixir), Rarity, SummonCharacter/SummonNumber/SummonCharactersList, Projectile, AreaEffectObject, Mirror, CanDeployOnEnemySide, EvolvedSpells | | H |
| Evolution: `DarkElixirCost` = evolution cycles (Knight 2, Barbarians 1, MK 1) | | M |

## 4. Towers (level 1; `match_rules.json:tower_scaling`)
King: HP 2400, projectile dmg 50, HitSpeed 1000, LoadTime 500, Range 7000, Sight 7000,
CollisionRadius 1400; inactive until `king_tower_damaged() || tower_destroyed()`, then
3300 ms "ACTIVATING" action (M). Princess: HP 1400, dmg 50, HitSpeed 800, Range 7500,
CollisionRadius 1000, projectile speed 600. Tower troops via `support_cards.json` (StatCharacter).

## 5. Match rules (`battle_timelines.csv` "Default", globals) — H
MAX_MANA 10; StartingElixir **6** (commonly quoted as 5 — data says 6; check whether the
countdown consumes/shows differently); full bar 28000 ms → 2.8 s/elixir for 0–120 s;
14000 ms (2×, 1.4 s) 120–240 s (last minute + first OT minute); 9300 ms (3×, 0.93 s) 240–300 s.
Regulation 180 s, Overtime section 120 s. LOGIC_BATTLE_START_COOLDOWN 4500 ms.
Other timelines: RampUp, DoubleElixir, TripleElixir, SuddenDeath, 2v2 (40000 ms bar)…

## 6. Arena geometry (tilemaps/tilemap.csv) — M
Grid 36×64 cells of 500 units (client_globals DEFAULT_MAP_WIDTH/HEIGHT_TILES 36/64) = 18×32 tiles.
Flags: 1/2 lane roads, 16 blocked, 32 river (rows 30–33 → y 15000–17000), 257/258 bridge
markers; bridges = non-water gap at cells x 5–8 (2500–4500) and 27–30 (13500–15500).
Tower centres from spawn_groups (cell coords ×500): King (9000, 3000), Princess (3500, 6500)
and (14500, 6500); opponent mirrored (y → 32000−y). Flags 128/512 unknown.

## 7. Not covered
Native engine behaviour (targeting, retarget, pushback physics, tick length) is not in data;
ACTION/ABILITY scripts (evolutions, heroes, champions) are exported raw but need an action
interpreter. `assets.scdb` `logic/` (autochess/chaos arena) was not exported.
