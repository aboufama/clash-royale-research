# Effects coverage

Which of the client's visual elements each supported card shows, and where each comes from
(level as in [FIDELITY.md](FIDELITY.md): **P** ported from the decompiled client, **D** data,
**A** approximation, **–** missing; "n/a" = the client draws nothing there). Addresses are libg
160402020 offsets; the decompiles are in `work/native/decomp_*/`.

## Spells

The supported spell cards (`supportedCards` in `sim/core/src/data.ts`), the two deploy zaps cast as
SpellAsDeploy area effects, and the area effects other cards leave behind. Ported in
`sim/viewer/src/sc/area_view.ts` (area-effect object view, buff views, buff filters; decompiles in
`work/native/decomp_aoe/`), `sc/effects.ts` (effect instances, SWF length / hold-and-fade),
`sc/projectile_view.ts`, `sc/area_rings.ts` and the event hooks in `sim/viewer/src/art.ts`.

### Shared elements

| Element | Level | Client code |
| --- | --- | --- |
| Cast effect (card Effect at the target) | P | Tower_castSpell 0xf9f47c: SpellData +0x110 → world listener vt+0x48 0x850258 → 0x82dc54 (once, z 0, angle 0, no parent, enemy version for the opponent) |
| Area-effect object view | P | factory 0x84fc88 (class 3) → ctor 0x833b84 / per frame 0x8342c8 / removal 0x834038 (vtable 0x188c8f8, layer 10) |
| ScaledEffect timing | P | 0x82ccd8 D = life − 200 and 0x82ccd0 E = 200 on the instance, read by 0x82c58c into each own SWF component (0x82a360); 0x82a994 stretches the clip over D, then holds its last frame with alpha (D + E − t)/E (0x123cbc0) |
| LoopingEffect end | P | attached to the object; when it leaves the world 0x82d300 stops it (0x82d074): clips finish their loop, then fade over E = 200 |
| OneShotEffect | P | 0x82dc54, no parent, E = 200 (holds its last frame and fades for 200 ms) |
| Pulse HitEffect | P | AreaEffect_update 0xf7a34c end of pulse → view vt+0x80 0x84e784 (engine event `aoePulse`); no supported area effect has one |
| NoFollowObjectEffect | P | 0x8342c8 while the object follows no target; no supported area effect has one |
| Followed target, own clip, Clone mode, deflection | – | +0x138 re-parenting (0x8342c8), FileName / ExportName on the GO_SPRITE (0x833e34), +0xbc = 2 (0x833b84), DeflectionFBEffect (vt+0x58 0x834104): no supported user |
| Radius scaling of area-effect art | n/a | the view scales nothing; the clips are drawn at the radius they were authored for |
| Buff filter on the unit | P | 0x82ea34 / 0x82ebdc from the buff view 0x8348c8: loops over the clip length (no supported buff sets FilterInheritLifeDuration), first child's colour multiplied in with byte arithmetic; per-frame ms truncation not reproduced (A) |
| Buff Effect on the unit | P | 0x8348c8 → 0x82dcb0 (parent the unit, follows with FollowParent), deleted with the buff view (0x834e54 → 0x82e160) |
| Buff MarkEffect | n/a | only preloaded (0xe6d00c); no battle view plays it |
| Buff filters on crown towers | – | towers are drawn without their buffs' colour |
| Projectile sprite, trail, shadow | P | projectile view 0x8554b0 / 0x8545e0 / 0x855304 (`sc/projectile_view.ts`) |
| Projectile HitEffect | P | 0xf9188c → 0xf8f978 → listener vt+0x48 0x850258 |
| Area-damage / pushback rings | P | World_areaDamage 0xf97be8 → 0xbe76e8 / 0xbe7980, pulses 0xf7a34c (`sc/area_rings.ts`) |
| Drag preview, radius indicator | P/A | battle UI (`battle_ui.ts`, see FIDELITY "Drag preview and released plays") |

### Per spell

| Spell | Cast effect | Projectile / object | Hit / pulse | Area effect view | Buff on targets | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Zap | none | – (AEO Zap, life 1) | none (area-effect damage makes no ring; no Pushback) | OneShot vfx_zap_polish (P; its Filter component has no parent: no filter) | ZapFreeze: filter_cold loop (P) | one pulse on the object's first update |
| Freeze | Spell_freeze_cast, sound only (P) | AEO Freeze, 3500 ms | none (no Pushback) | Scaled Spell_freeze_ground over 3300 + 200 ms, Looping Spell_freeze_loop (P) | Freeze: filter_cold loop (P) | frozen unit's idle clip keeps running on the battle clock (A, anim.ts); attack and walk clips stop with the engine's timers |
| Poison | none | AEO Poison, 8000 ms, pulses every 250 ms | none | Scaled Spell_poison_ground (its Loop overridden) over 7800 + 200 ms, Looping Spell_poison_loop, OneShot Spell_poison_effect (P) | Poison: filter_poison loop, Effect PoisonSteam following the unit, deleted when the buff ends (P) | damage ticks' effects: character views (other module) |
| Rage | none | RageBottle building (deploy clip, P) → death: rage_bottle_explode_02 (P 0x850504) → AEO Rage 4500 ms + RageDamage | none | Rage: Scaled Spell_rage_ground over 4300 + 200 ms, Looping Spell_rage_loop, OneShot Spell_rage_effect (P); RageDamage: none | Rage: filter_rage loop (P), Effect Spell_rage_hit_effect (sound only), MarkEffect Healing not played (n/a) | |
| Lightning | spell_lightning_deploy (P) | AEO Lightning 1500 ms, no view effects; per target a LighningSpell bolt (no sprite) | bolt HitEffect Spell_lightning_effect at the target (P) | none | ZapFreeze from the bolt: filter_cold (P) | three strikes, biggest targets first (engine) |
| Fireball | none | FireballSpell sprite, trail vfx_fireball_trail, shadow (P) | Fireball_explosion (P), rings (P) | – | – | |
| Arrows | Cast_RainOfArrows, sound only (P) | 3 waves × 10 ArrowsSpell, HideWhenDelayed (P) | ArrowHitGround (P), one ring per wave (P) | – | – | |
| Rocket | none | RocketSpell sprite (use360Frames), trail Rocket_Emitter, shadow (P) | Rocket_explosion (P), rings (P) | – | – | prestige skins not modelled (variant 0) |
| Giant Snowball | none | SnowballSpell sprite (RedExportName for the enemy), trail snowball_continuous (P) | Snowball_ground (P), rings (P) | – | IceWizardSlowDown: filter_cold (P) | |
| Goblin Barrel | goblin_barrel_spawn, sound only (P) | GoblinBarrelSpell sprite, trail, shadow (P) | goblin_barrel_explosion (P); no ring (P) | – | – | goblins' spawn effects: unit views (SpawnEffect P; no deploy filter: the projectile has no SpawnDeployBaseAnim, 0xf9188c, P) |
| The Log | log_deploy, sound only (P) | LogProjectile → LogProjectileRolling, rolling clip (P) | log_hit where the thrown log lands (P), no ring; the rolling log's log_die at its last hit (P, 0xf9188c) | – | – | |
| Barbarian Barrel | barb_log_deploy, sound only (P) | BarbLogProjectile → rolling (P) | barb_barrel_hit where the barrel lands (P), no ring; the rolling barrel's vfx_barbarian_barrel_explosion_polish at its last hit (P, 0xf9188c) | – | – | the Barbarian's deploy filter: unit views (the rolling barrel's SpawnDeployBaseAnim filter_deploy_unit_miner via vt+0x140, 0xf9188c, P) |
| Ice Wizard (deploy) | CharacterDeploy, sound only (P) | AEO IceWizardCold, life 1 | none | OneShot spell_ice_effect (P) | IceWizardCold: filter_cold (P) | |
| Electro Wizard (deploy) | CharacterDeploy, sound only (P) | AEO ElectroWizardZap, life 1 | none | OneShot Spell_zap_effect (P) | ZapFreeze: filter_cold (P) | |

### Area effects left by other cards

| Source | Area effect | View effects | Picture |
| --- | --- | --- | --- |
| Golem / Golemite death | GolemDeathExplosion / GolemiteDeathExplosion | none | the unit's DeathEffect golem_die / small_golem_die (P 0x850504), pushback rings of the pulses (P) |
| Giant Skeleton bomb | GiantSkeletonExplosion | none | bomb building clip, DeathEffect vfx_giantskeleton_death_bomb_explosion (P), pushback ring of the pulse (P) |
| Balloon bomb | BalloonBombExplosion | none | bomb building clip, DeathEffect vfx_balloon_death_bomb_explosion (P); no ring (no Pushback) |
| Ice / Fire / Electro Spirit | none (projectiles) | – | projectile HitEffects (P); Ice Spirit Freeze and Electro Spirit ZapFreeze buffs: filter_cold (P) |

### Not supported cards

Tornado, Clone, Earthquake, Graveyard, Heal Spirit, Royal Delivery, Mirror and the evolutions are not
supported by the engine (–). Their view paths that the area-effect view already covers: followed
targets and the Clone render mode (not ported, see above), SpawnEffect of spawned characters
(engine side, 0xf7a34c → 0xd35ab4).

## Units and buildings

Which effect fields of the supported cards' characters, buildings, projectiles, buffs and crown towers
the viewer plays, where the client plays them (libg 160402020 addresses) and how faithfully. The
fidelity levels are those of [FIDELITY.md](FIDELITY.md): **P** ported from the decompile, **A**
approximation, **–** not played. Decompiles of this pass are in `work/native/decomp_fx2/` (earlier
ones in `decomp_units3/`, `decomp_audit/`, `decomp_rings/`, `decomp_anim/`, `decomp_vis/`).

Code: `sim/viewer/src/art.ts` (events, spawn / death / attack-start / shooter effects, projectiles),
`sim/viewer/src/sc/char_effects.ts` (the rest of this table), `sc/unit_fx.ts` (footsteps),
`sc/effects.ts` (effect system; beam targets, Filter components), `sc/beam.ts` (beam matrix).
Area-effect objects and buff views (DeathAreaEffect visuals, buff `Effect` and filters) belong to
`sc/area_view.ts` and are covered by its FIDELITY rows. Engine events used here (recorded only, no
simulation change): `damage`, `shieldLost`, `spawn.src`, `spawn.pid`, `hit` / `shoot` `src` and `fx`, `impact`
`src` and `z` (`sim/core/src/entities.ts` BattleEvent).

### How the client plays them

The effect manager's play call is 0x82dcb0 (0x82dc54 = it + setLoop(0), 0x82dedc = it + setLoop(1),
both passing p13 = 1). With a parent actor and p13 the effect starts at the parent view's sprite (x,
y ∓ 0.01 world so it sorts in front, z) whatever position the caller passes, and follows the sprite
when the call attaches it (p8) or when the effect has FollowParent; the enemy flag (the view's actor is
not the viewer's, 0x84ddcc) selects EnemyVersion; p11 = 1 lets the effect start a screen shake.

| Call | Address | Behaviour |
| --- | --- | --- |
| view vt+0x80 | 0x84e784 | 0x82dcb0 on the actor, not attached: keeps the effect's own Loop |
| view vt+0xc0 | 0x84f11c | 0x82dc54 on the actor: once (the existing `playOnActor` started at the logic position and never followed; fixed) |
| view vt+0x90 | 0x84e8e0 | 0x82dcb0 on the actor + beam target 0x82d484 + source offset vt+0x48 (attack_pivot_<i+1> of the sprite, else (0, TargetEffectY)) + update(1) |
| 0x82dedc on the actor, attached | 0x83fcc8, 0x83b6d8 | looping, follows the sprite; stops when the actor's view goes (0x82d300) |
| world listener vt+0x48 / vt+0x60 | 0x850258 / 0x850504 | 0x82dc54 at a point with an angle, no parent: always once (shooter, spawn, hit, death and cast effects pass `loop: false`) |
| projectile view vt+0xa8 | 0x84ef20 | 0x82dcb0 with an optional parent (the shooter) + fixed beam end 0x82d508 + the parent's projectile pivot |

Beams: a SWF component with FlashWidth and a target (actor: x, y, z + 2·CollisionRadius (vt+0xa8
0xf829ec) plus the target view's damage pivot; or a fixed point) gets the matrix R(atan2 d)·S(|d| /
FlashWidth, 1) from its position + offset each update (0x82a994; FlashWidth −1 rotates only).
Filter components (0x82ea34 / 0x82ebdc) recolour the effect's parent actor while they run. They are
the buff filter's class: the clip length, frame step and colour arithmetic are one implementation
(`sc/area_view.ts` filterClipLength / filterFrame / applyFilterColor) used by both.

### Fields

| Field (data) | Client call site | Status | Notes |
| --- | --- | --- | --- |
| SpawnEffect (+0x1e8) | cast summons: Deploy_summon 0xd423bc → view vt+0x138 0x846b2c (reveal / vt+0xc0); spawner, death and projectile spawns: 0xd35ab4 → listener vt+0x48 | P | Miner: 0xd423bc calls the tunnel view vt+0x168 instead, and the tunnel's end (vt+0x170 0x845a8c) gives vt+0x138(0) |
| SpawnCharacterEffect (+0x208, 0xde0738) | spawn request 0xf8aac8 → 0xd35ab4 param 6 | P | replaces the spawned unit's SpawnEffect when the source character has one (Witch, Night Witch); engine `spawn.src` |
| SpawnDeployBaseAnim (+0x278), DeathSpawnDeployBaseAnim (+0x288), DeployBaseAnimExportName (+0x5b0, 0xde1298) of a death spawn | 0xf83990 puts the dying character's DeathSpawnDeployBaseAnim, else its DeployBaseAnimExportName, in the request (+0x48, 0xf870e8); 0xf8aac8 → view vt+0x140 0x846e6c with the spawned character's SpawnDeployBaseAnim, else that clip | P | vt+0x140 does nothing unless the actor is in state 4 or 8, so members active at once (death spawns with hitpoints and no request deploy time: Golemites, Lava Pups, Elixir Golem halves, Bats, Tombstone / hut members) get no filter; deploying members do (Battle Ram's Barbarians: BattleRam's filter_deploy_unit_default; Balloon / Giant Skeleton bombs: their dying carrier's filter_deploy_unit_default, which the bombs' own rows lack). Cast summons keep vt+0x138's DeployBaseAnimExportName (0x846b2c); a spawner's members with SpawnCharacterWithDeploy go through vt+0x138 too (0xf8aac8 @cVar14; no supported user) |
| SpawnDeployBaseAnim of a projectile (+0x158) | Projectile_applyHit 0xf9188c: each spawned character (0xd35ab4), SpawnCharacterDeployTime > 0 → 0xf85324 (state 4), then view vt+0x140 with the projectile's clip if set | P | Barbarian Barrel's Barbarian: filter_deploy_unit_miner; Goblin Barrel's goblins: none (they showed their own filter_deploy_unit_default before); engine `spawn.pid` |
| deploy filter of a spawner's members | 0xf800bc → 0xf8aac8: request without a clip (no 0xf870e8), so vt+0x140 only with the member's SpawnDeployBaseAnim | A | no supported member sets it; they keep their own DeployBaseAnimExportName from the engine's deploy start (A: natively a member with hitpoints is in state 4 only with SpawnCharacterWithDeploy, 0xf8aac8 cVar14 = request +0x68) |
| DeathEffect (+0x1d0) | 0xf83990 → listener vt+0x60 0x850504; buff DeathEffectOverride 0xfc2288 | P | angle from the lethal entry's vector (A: rebuilt from events) |
| AttackStartEffect (+0x500, seq. +0xe0) | 0x840d44 → 0x83e524 → vt+0xc0 | P / – | troops and direction buildings (Inferno Tower); single-clip buildings (Tesla) – (0x840d44's clip branch not traced) |
| DamageEffect (+0x128) / DamageEffectSpecial (+0x130) | single target: Damage_enqueue 0xfca3d4 (melee 0xfc7080, projectile 0xf8f618 / 0xf8ff74 with the projectile's +0x190) → Health_applyHit 0xfcb29c → victim view vt+0xc0; melee splash: 0xfc7080 → listener vt+0x48 at the AoE centre | P | the victim's sprite and team version (the old viewer played it at the target with the attacker's team on melee hits only); the splash centre gets it once with the attacker's team and facing angle, z = the target snapshot's (or the attacker's with SelfAsAoeCenter); Special while charging (movement +0x1e0 ≥ 10000, 0xde0450) |
| "Damage" (Tables +0xec0, static 0x1a5e498) | World_areaDamage 0xf97be8 entries; UseFallbackDamageEffect (+0x138, default true) for attackers without DamageEffect; spell (0xf9f47c) and spawned (0xf9188c) projectiles; buff damage over time 0xf86668 without BuffData +0x248 HitEffect | P | the effect_Hit1 spark on every such victim (baked as a global effect) |
| TakeDamageEffect (+0x310) | 0xfcb29c → vt+0xc0 | – | no supported card sets it |
| MoveEffect (+0x318), LoopMoveEffect | 0x840d44 run / charge clip action_frame1/2 | P | `sc/unit_fx.ts` |
| ProjectileEffect (+0x108) | 0xfc619c → 0xf85244 → listener vt+0x48 | P | OverrideShooterProjectileEffect first |
| LandingEffect (+0x100) | 0xf7f2c8 (leaving state 5) → vt+0x80 | P | |
| AppearEffect (+0x3f0) / HideEffect (+0x3f8) | 0xf8247c / 0xf81b3c → vt+0x80 | P | Tesla |
| ContinuousEffect (+0x118, 0xde0664) | view ctor 0x836e58 → 0x83fcc8 → 0x82dedc attached | P | from the view's creation (deploy included) until the view goes |
| ChargeEffect (+0x200, 0xde0828) | 0x840d44 @0x841c78: walk branch, charge ≥ 10000, charge clip present, previous action ≠ 3 | P | non-looping effects via vt+0xc0 (all three); their Filter component (filter_protection) recolours the charger (0x82ebdc). The effect_charge clip's TextInstanceName is not filled (–) |
| TargetedHitEffect (+0x220, 0xde1258) | AttackComp_execute 0xfc619c (not cancelled) → view vt+0x90; extra targets AttackComp_update 0xfc8fc8 | P / A | Tesla, Electro Wizard beams (attack_pivot_1 / _2), Battle Ram, Executioner (sound only); the view's list +0x2e0 of these effects (stop conditions) not traced; the extra targets' pivot index follows the engine's order (A); a hit cancelled by distance still plays it (A) |
| ShieldLostEffect (+0x140, 0xde0484) | 0xfcb29c → 0xf85730 → view vt+0x110 0x846850 → vt+0xc0 | P | engine `shieldLost`; the bar container's "chef_upgrade" label of 0x846850 is not played (–) |
| SpawnPathfindEffect (+0x210 / _water +0x218) | tunnel view vt+0x168 0x84593c → 0x845944; per frame 0x83c194; end vt+0x170 0x845a8c | P / A | Miner; follows the tunnel (0x82cce0(1)); restarted on a water-flag change (the Miner has no _water variant: none over the river); 0x11d9838 taken as the engine's river tiles (A) |
| TargettedDamageEffect1..3, FlameEffect1..3, DamageLevelTransitionEffect12 / 23 (level entries +0xb0 / +0xb8 / +0xd0, 0xde10e0 / 0xde1180 / 0xde1130) | 0x839b08 → 0x83b6d8 slots 0 / 2 / 1 (attack timer +0x24 > 0, not in states 4 / 11) | P / A | Inferno Tower, Inferno Dragon; level 0 carries transition "12", level 1 "23" (loader 0xdde618); the view's +0x4cc follows the attack sequence index at the attack clip's cycle (840d44), taken as the engine's ramp level (A); a new target restarts the beam and flame (A) |
| TargetEffectY (+0x808, 0xde1220) | 0x83b6d8, 0x84e8e0 | P | beam source offset in px |
| LoadAttackEffect1..3 (level entry +0xc0 list), LoadAttackEffectReady (+0x510) | Ready: 0x83b6d8 LoadFirstHit branch (slot 3) | – | Electro Dragon: no LoadFirstHit, so Ready never plays; the list's call site was not found; all four are sound-only |
| DeathAreaEffect | death 0xf83990 → area effect | (area_view.ts) | |
| CrowdEffects (+0x7f8) | crowd sounds | n/a | sound |
| Kamikaze / KamikazeEffect, DashEffect, DashStartEffect, BuffWhenNotAttackingEffect, ReflectedAttack*, AbilityPendingEffect, SpecialReadyEffect | – | – | no supported card sets the effect |
| HasDamageVisualPivot, PivotClip (effect) | 0x82a994; effect +0xc8 | – | not exported; electro_wizard_beam's PivotClip not ported |
| ShakesTargets / ShakesShooter / TargetedEffectVisualPushback (sprite recoil, view vt+0xf8 0x83e4d8) | 0xfc619c, 0xf9188c | – | sprite offsets, not effects |

Projectiles:

| Field | Call site | Status |
| --- | --- | --- |
| HitEffect (+0xa8) | Projectile_applyHit 0xf9188c → 0xf8f978 → listener vt+0x48 at the aim point, z = the projectile's z (+0x8c), angle start → hit | P (z now from the engine's `impact.z`) |
| DeathEffect (+0x130) | 0xf9188c: a piercing projectile (0xe5a908) plays it instead of HitEffect at its last hit | P (was played where the projectile vanished, A) |
| TrailEffect (+0x128) | projectile view 0x8545e0 → 0x82dcb0 attached | P |
| TargettedEffect (+0x148) | single-target hit 0xf8f618 → projectile view vt+0xa8 0x84ef20 (DragBackSpeed < 1) | P: from the previous hit (the first from the start, parented to the shooter with its projectile pivot 0x846ab4) to the target's x, y, z; the pivot is read at the hit, not at the shot (A) |
| PingpongDeathEffect (+0x1c8) | Projectile_update 0xf90708: back at the start without its shooter → projectile view vt+0x80 | P |
| OverrideShooterProjectileEffect (+0x348) | 0xf85244 | P |
| ChainedHitEndEffect (+0x140) | 0xf8fd88, 0xf91ee4 | – (no supported projectile) |

Buffs: `Effect` and the filter clip — `sc/area_view.ts` BuffViews (0x8348c8); `HitEffect` (+0x248) —
the damage-over-time entry's effect (P, above); `DeathEffectOverride` (+0x1b0) — P (0xfc2288);
`MarkEffect` (+0x98) — only read by the preloader 0xe6d00c, never played in battle (n/a).

Crown towers: King tower DeathEffect, ProjectileEffect (King_attack) and DamageEffect (musketeer_hit on
its projectile's victims) P; Princess tower DeathEffect, ProjectileEffect P, victims get "Damage"; the
tower princess' AttackStartEffect P (A: at her tower's x, y and AttachedCharacterHeight).

### Coverage by unit

Every character and building the 70 supported cards create (summons, spawner members, death
spawns). P ported, A approximation, – not played, f no own DamageEffect: its victims get the "Damage"
fallback (P), v area-effect view (`sc/area_view.ts`), · field not set. Columns: Sp SpawnEffect, De
DeathEffect, AS AttackStartEffect, Dm DamageEffect, DS DamageEffectSpecial, Mv MoveEffect, Pr
ProjectileEffect, La LandingEffect, Co ContinuousEffect, Ch ChargeEffect, TH TargetedHitEffect, SL
ShieldLostEffect, SC SpawnCharacterEffect, AH Appear/HideEffect, SP SpawnPathfindEffect, In Inferno
beam / flame / transition, LA LoadAttackEffect*, DA DeathAreaEffect.

| Unit (cards) | Sp | De | AS | Dm | DS | Mv | Pr | La | Co | Ch | TH | SL | SC | AH | SP | In | LA | DA |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| AngryBarbarian (AngryBarbarians) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| Archer (Archer) | P | P | P | f | · | P | P | · | · | · | · | · | · | · | · | · | · | · |
| AxeMan (AxeMan) | P | P | · | P | · | P | · | · | · | · | P | · | · | · | · | · | · | · |
| BabyDragon (BabyDragon) | P | P | P | f | · | P | P | · | · | · | · | · | · | · | · | · | · | · |
| Balloon (Balloon) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| BalloonBomb (Balloon) | P | P | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | v |
| Barbarian (BarbLog, BattleRam, Barbarians…) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| BarbarianHut (BarbarianHut) | P | P | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| BarrelGoblin (GoblinBarrel) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| Bat (Bats, DarkWitch) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| BattleRam (BattleRam) | P | P | P | P | · | P | · | · | · | P | P | · | · | · | · | · | · | · |
| BlowdartGoblin (BlowdartGoblin) | P | P | P | f | · | P | P | · | · | · | · | · | · | · | · | · | · | · |
| Bomber (Bomber) | P | P | P | f | · | P | P | · | · | · | · | · | · | · | · | · | · | · |
| Bowler (Bowler) | P | P | P | f | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| Cannon (Cannon) | P | P | · | f | · | · | P | · | · | · | · | · | · | · | · | · | · | · |
| DarkPrince (DarkPrince) | P | P | P | P | P | P | · | P | · | P | · | P | · | · | · | · | · | · |
| DarkWitch (DarkWitch) | P | P | P | P | · | P | · | · | · | · | · | · | P | · | · | · | · | · |
| ElectroDragon (ElectroDragon) | P | P | · | f | · | P | P | · | · | · | · | · | · | · | · | · | – | · |
| ElectroSpirit (ElectroSpirit) | P | P | · | f | · | P | P | · | P | · | · | · | · | · | · | · | · | · |
| ElectroWizard (ElectroWizard) | P | P | P | P | · | P | · | · | · | · | P | · | · | · | · | · | · | · |
| EliteArcher (EliteArcher) | P | P | P | f | · | P | P | · | · | · | · | · | · | · | · | · | · | · |
| ElixirCollector (Elixir Collector) | P | P | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| ElixirGolem1 (ElixirGolem) | P | P | P | P | · | P | · | · | P | · | · | · | · | · | · | · | · | · |
| ElixirGolem2 (ElixirGolem) | P | P | P | P | · | P | · | · | P | · | · | · | · | · | · | · | · | · |
| ElixirGolem4 (ElixirGolem) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| FireSpirits (FireSpirits) | P | P | · | f | · | P | P | · | P | · | · | · | · | · | · | · | · | · |
| Giant (Giant) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| GiantSkeleton (GiantSkeleton) | P | · | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| GiantSkeletonBomb (GiantSkeleton) | P | P | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | v |
| Goblin_Stab (Goblins, GoblinGang) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| Golem (Golem) | P | P | P | P | · | P | · | · | P | · | · | · | · | · | · | · | · | v |
| Golemite (Golem) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | v |
| HogRider (HogRider) | P | P | P | P | · | P | · | P | · | · | · | · | · | · | · | · | · | · |
| IceSpirits (IceSpirits) | P | P | · | f | · | P | P | · | P | · | · | · | · | · | · | · | · | · |
| IceWizard (IceWizard) | P | P | P | f | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| InfernoDragon (InfernoDragon) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | P | · | · |
| InfernoTower (InfernoTower) | P | P | P | P | · | · | · | · | P | · | · | · | · | · | · | P | · | · |
| Knight (Knight) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| LavaHound (LavaHound) | P | P | · | f | · | P | P | · | · | · | · | · | · | · | · | · | · | · |
| LavaPups (LavaHound) | P | P | · | f | · | P | P | · | · | · | · | · | · | · | · | · | · | · |
| MegaMinion (MegaMinion) | P | P | P | f | · | P | P | · | · | · | · | · | · | · | · | · | · | · |
| Miner (Miner) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | P | · | · | · |
| MiniPekka (MiniPekka) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| Minion (Minions, MinionHorde) | P | P | P | f | · | P | P | · | · | · | · | · | · | · | · | · | · | · |
| Mortar (Mortar) | P | P | · | f | · | · | P | · | · | · | · | · | · | · | · | · | · | · |
| Musketeer (Musketeer) | P | P | P | P | · | P | P | · | · | · | · | · | · | · | · | · | · | · |
| Pekka (Pekka) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| Prince (Prince) | P | P | P | P | P | P | · | P | · | P | · | · | · | · | · | · | · | · |
| RageBottle (Rage) | P | P | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | v |
| RascalBoy (Rascals) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| RascalGirl (Rascals) | P | P | P | f | · | P | P | · | · | · | · | · | · | · | · | · | · | · |
| RoyalGiant (RoyalGiant) | P | P | P | f | · | P | P | · | · | · | · | · | · | · | · | · | · | · |
| RoyalHog (RoyalHogs) | P | P | P | P | · | P | · | P | · | · | · | · | · | · | · | · | · | · |
| Skeleton (Skeletons, SkeletonArmy, Tombstone…) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| SkeletonDragon (SkeletonDragons) | P | P | P | f | · | P | P | · | · | · | · | · | · | · | · | · | · | · |
| SkeletonWarrior (SkeletonWarriors) | P | P | P | P | · | P | · | · | · | · | · | P | · | · | · | · | · | · |
| SpearGoblin (SpearGoblins, GoblinGang) | P | P | P | f | · | P | P | · | · | · | · | · | · | · | · | · | · | · |
| Tesla (Tesla) | P | P | – | P | · | · | · | · | · | · | P | · | · | P | · | · | · | · |
| Tombstone (Tombstone) | P | P | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| Valkyrie (Valkyrie) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| Wallbreaker (Wallbreakers) | P | P | P | P | · | P | · | · | P | · | · | · | · | · | · | · | · | · |
| Witch (Witch) | P | P | P | P | · | P | · | · | · | · | · | · | P | · | · | · | · | · |
| Wizard (Wizard) | P | P | P | P | · | P | · | · | · | · | · | · | · | · | · | · | · | · |
| Xbow (Xbow) | P | P | · | f | · | · | P | · | · | · | · | · | · | · | · | · | · | · |

Many SpawnEffect / AttackStartEffect / DamageEffect rows name sound-only effects (their components have
no ExportName); the viewer still plays them, so a sound hook on the effect system gets the call.

### Projectile coverage

n: the field is set but the client never plays it (a piercing projectile's HitEffect, 0xf9188c /
0xf8ff74 play it only with CheckCollisions).

| Projectile | Hit | Trail | Death | Pingpong | Targetted | Override shooter | piercing |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| ArcherArrow | P | · | · | · | · | · |  |
| ArrowsSpell | P | P | · | · | · | · |  |
| AxeManProjectile | n | P | · | P | · | · | yes |
| BabyDragonProjectile | P | P | · | · | · | · |  |
| BarbLogProjectile | P | P | · | · | · | · |  |
| BarbLogProjectileRolling | n | P | P | · | · | · | yes |
| BlowdartGoblinProjectile | P | P | · | · | · | · |  |
| BombSkeletonProjectile | P | P | · | · | · | · |  |
| BowlerProjectile | · | P | P | · | · | · | yes |
| ElectroDragonProjectile | P | · | · | · | P | · |  |
| ElectroSpiritProjectile | P | P | · | · | P | · |  |
| EliteArcherArrow | n | P | P | · | · | · | yes |
| FireSpiritsProjectile | P | P | · | · | · | · |  |
| FireballSpell | P | P | · | · | · | · |  |
| GoblinBarrelSpell | P | P | · | · | · | · |  |
| IceSpiritsProjectile | P | P | · | · | · | · |  |
| KingProjectile | P | · | · | · | · | · |  |
| LavaHoundProjectile | P | P | · | · | · | · |  |
| LavaPupProjectile | P | P | · | · | · | · |  |
| LighningSpell | P | · | · | · | · | · |  |
| LogProjectile | P | P | · | · | · | · |  |
| LogProjectileRolling | n | P | P | · | · | · | yes |
| MegaMinionSpit | P | · | · | · | · | · |  |
| MinionSpit | P | · | · | · | · | · |  |
| MortarProjectile | P | · | · | · | · | · |  |
| MusketeerProjectile | P | · | · | · | · | · |  |
| RascalGirlProjectile | P | P | · | · | · | · |  |
| RocketSpell | P | P | · | · | · | · |  |
| RoyalGiantProjectile | P | · | · | · | · | · |  |
| SkeletonDragonProjectile | P | P | · | · | · | · |  |
| SnowballSpell | P | P | · | · | · | · |  |
| SpearGoblinProjectile | P | · | · | · | · | · |  |
| TowerCannonball | P | · | · | · | · | · |  |
| TowerPrincessProjectile | P | · | · | · | · | · |  |
| WallbreakerProjectile | P | P | · | · | · | · |  |
| WitchProjectile | P | · | · | · | · | · |  |
| chr_wizardProjectile | P | P | · | · | · | · |  |
| ice_wizardProjectile | P | P | · | · | · | · |  |
| xbow_projectile | P | · | · | · | · | · |  |

### Bake

`tools/art/bake_web.py` exports every effect the supported cards name (CHAR_EFFECT_FIELDS,
PROJ_EFFECT_FIELDS, the buff fields incl. HitEffect, AEO fields) and the global "Damage" effect
(GLOBAL_EFFECTS), plus TargetEffectY and UseFallbackDamageEffect on characters; every unit, projectile,
area effect and buff the 70 cards reach is in the manifest (`missingEffects` empty).
