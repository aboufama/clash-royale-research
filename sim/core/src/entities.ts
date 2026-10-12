// Battle actors. One monomorphic class per actor kind keeps V8 fast: every field is
// initialised in the constructor and only ever holds one type.

import type { AreaEffectDef, BuffDef, CardDef, ProjectileDef, UnitDef } from './data.ts';

export const ST_DEPLOYING = 0;
export const ST_ACTIVE = 1;
export const ST_DEAD = 2;

export const TOWER_NONE = 0;
export const TOWER_PRINCESS = 1;
export const TOWER_KING = 2;

export const KING_INACTIVE = 0;
export const KING_ACTIVATING = 1;
export const KING_ACTIVE = 2;

const NO_PATH = new Int32Array(0);

/** A buff on a unit. One instance per (buff, source) when the buff stacks, else per buff. */
export class BuffInst {
  def: BuffDef;
  sourceId: number;
  ticksLeft: number;
  /** Damage/heal tick counter (buff instance +0x10, 0xf86668): updates since the last tick. */
  hitTimer: number;
  /** Tick the buff was applied (viewer colour filters). */
  startTick: number;

  constructor(def: BuffDef, sourceId: number, ticks: number, tick = 0) {
    this.def = def;
    this.sourceId = sourceId;
    this.ticksLeft = ticks;
    this.hitTimer = 0;
    this.startTick = tick;
  }
}

export class Unit {
  id: number;
  def: UnitDef;
  card: string; // card that summoned it ('' for towers)
  team: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  shield: number;
  state: number;
  /** Ticks left before the unit becomes active (DeployTime + group stagger). */
  deployTicks: number;
  deployTotal: number;
  target: Unit | null;
  /** Locked on: target in attack range, attack clock running. */
  locked: boolean;
  /** Attack timer in ms (native attack component +0x24). */
  atkTimer: number;
  /** Delay before the timer may advance again (native +0x2c). */
  atkDelay: number;
  /** Tick of the last hit (for the viewer's attack animation). */
  lastHitTick: number;
  /** Tick this unit last took damage (viewer hit flash). */
  lastHurtTick: number;
  /** Path cells in walking order; the remaining path is path[pathIdx..] (native m+0x3c, reversed). */
  path: Int32Array;
  pathIdx: number;
  /** Path goes "backwards" relative to the target (m+0x215, 0xfcf680). */
  pathBack: boolean;
  /** Facing vector (actor+0xf8), length 256 once set by movement or attack. */
  dirX: number;
  dirY: number;
  moving: boolean;
  tower: number;
  /** Lane id (actor+0x158) assigned at spawn: road bits of the nearest road cell. */
  lane: number;
  kingState: number;
  kingTicks: number;
  isAir: boolean;
  isBuilding: boolean;
  radius: number;
  mass: number;
  /** Knockback (startPushback 0xfcfbd4): active (m+0x1fc), step (m+0x1ec), destination (m+0x1e4/0x1e8). */
  kbActive: boolean;
  kbStep: number;
  kbX: number;
  kbY: number;
  /** Knockback ignores immunity (m+0x1fd, PushbackAll): no swing, keeps charge. */
  kbIgnore: boolean;
  /**
   * Death-spawn slide (DeathSpawnPushback, 0xfcff3c): steps left (m+0x1f8); each movement update moves
   * the actor up to kbStep (250) toward (kbX, kbY) (0xfcc578), kbStep = 0 when it ends.
   */
  slideN: number;
  /**
   * LOGIC_DEATH_SPAWN_IMMUNE_FIRST_TICK (actor +0x174, set by 0xf8aac8 for death spawns): characters and
   * towers cannot target the actor (vt+0x148 0xf825e4) until the counter (+0x178, +50 per character
   * update 0xf800bc) passes ATTACK_FINISH_TIME_MS.
   */
  spawnImmune: boolean;
  spawnImmuneMs: number;
  /** River jump (state 5) and its total distance (m+0x204). */
  jumping: boolean;
  jumpTotal: number;
  /** Stop-and-go walking clock ms (m+0x1f0). */
  walkMs: number;
  /** Tick-start position (spatial grid cells) and grid membership for this tick. */
  gx: number;
  gy: number;
  inGrid: boolean;
  spawnTick: number;
  buffs: BuffInst[];
  /** Ticks active (unused by the native decay) and the lifetime-decay accumulator in hundredths of HP (health +0x34). */
  lifeTicks: number;
  decayed: number;
  /**
   * Periodic spawner (0xf800bc): the spawn timer (actor +0x144, SpawnStartTime at Character_initComponents
   * 0xf7ed38), the members spawned in the current group (+0x148) and the SpawnCharacter / 2 / 3 rotation (+0x150).
   */
  spawnTimer: number;
  spawnGroup: number;
  spawnRot: number;
  /** Pending damage of homing projectiles in flight toward this actor (actor +0x114, 0xf8553c). */
  pending: number;
  /** Pending-damage duration ms (actor +0x118): max of the registered flight times rounded up to
   * 50, capped at 1000; -50 per actor update. */
  pendingDur: number;
  /** Waiting out a summon deploy delay (native state 11): untargetable, no pending decay. */
  waitTicks: number;
  /** Recent damage keys and their times (health +0x58 / +0x68): a key is ignored for 1000 ms (0xfcaeec). */
  dmgKeys: number[];
  dmgKeyTimes: number[];
  /**
   * Attack-sequence index (attack +0x20; -1 = none): for mode-3 sequences (Inferno Tower / Dragon) set after
   * every clock step of a swing to the entry the attack timer is in (0xde0e5c); it stays when the attack
   * resets until the next swing. Picks the damage (0xde0cec) and the range / sight / clock overrides.
   */
  seqIndex: number;
  /** Target kept through the pending-damage exemption this tick (attack +0x18, 0xfc7e20): the removal notice 0xfc7640 then starts no finish wait. */
  keepFlag: boolean;
  /** Elixir Collector: generate timer, ms (actor +0x130). */
  manaT: number;
  /**
   * HidesWhenNotAttacking (Tesla) hide timer, ms (actor +0x138): 0 up; counts to HideTimeMs while
   * hiding; HideTimeMs..HideTimeMs+UpTimeMs while appearing from fully hidden; negative while coming
   * back up from part-way (|value| = how far down).
   */
  hideT: number;
  /** Fully hidden, so untargetable: hideT === HideTimeMs (vtf8 0xf85420). */
  hidden: boolean;
  /** Miner: native state 6, tunnelling along its path to the movement destination (tunnelX, tunnelY: m+0x1cc/+0x1d0, the deploy point) before deploying. */
  tunneling: boolean;
  tunnelX: number;
  tunnelY: number;
  // --- native attack component (AttackComp, PORT_NOTES §2) ---
  /** Retarget cooldown ms (+0x1c): searches only when 0. */
  retargetCd: number;
  /** Load countdown ms (+0x28): set to LoadTime after an attack, -50 per tick. */
  load: number;
  /** Hit started (+0x3d) and "loaded" flag (+0x3e). */
  hitStarted: boolean;
  loaded: boolean;
  /** Attack finish timer ms (+0x50). */
  finishMs: number;
  /** Target position snapshot taken at the start of this tick's attack update (+0x68/+0x6c). */
  tsx: number;
  tsy: number;
  // --- native movement component (MovementComp, PORT_NOTES §4) ---
  pushAccX: number;
  pushAccY: number;
  pushCount: number;
  /** Unit direction (x256) toward the current waypoint (+0x30/+0x34). */
  wpDirX: number;
  wpDirY: number;
  /** Charge progress (+0x1e0): += step*1000/ChargeRange; charging at >= 10000. */
  charge: number;
  /** Charged first hit pending (attack+0x3f): the next swing skips the load and hits at once. */
  chargeHit: boolean;
  /** Attacked the current target (attack +0x19): set by execute, cleared by a target change. */
  attackedTarget: boolean;
  /** Avoidance sidestep (m+0x1f4): +-200, decays 10 per tick. */
  sidestep: number;
  gridStamp: number;
  /**
   * Target priority bonus (actor +0x1a0, vt1d8): subtracted from the squared distance when others
   * pick a target (0xfc4c38). (20·i)² for the i-th character a SpawnConstPriority projectile spawns.
   */
  prio: number;
  /** Attack component disabled while frozen (0xf7fee4: component mask bit 0 cleared). */
  atkOff: boolean;
  /**
   * Height (native actor z 0xf942a8 = z base +0x74 + z offset +0x8c): the z offset is FlyingHeight
   * for flyers, else 0; the z base is the river-jump height the movement component recorded in the
   * previous tick (`jumpZ`), applied at the start of each tick by the actor preUpdate (0xf96040 ->
   * 0xfd0320), so a jumping unit's z trails its arc by one tick and is back to 0 the tick after the
   * last record. The client view draws the sprite at lerp(previous z, z) (0x84d738).
   */
  z: number;
  /**
   * Jump height recorded by this tick's movement update (state 5, 0xfccd94) and not yet applied:
   * with n = total/JumpSpeed and k = remaining/JumpSpeed, u = clamp(2·min(k, n − k), 0, 32) and
   * h = (u − u²/64)·JumpHeight, h >> 4 when h ≥ 16, else 0 (no record). The next tick's preUpdate
   * moves it into `z` and clears it.
   */
  jumpZ: number;
  /**
   * JumpHack_Ignore_Pushback_Buff (IgnorePushBack, 50 ms): the JumpHack_Check_Jump_Interval action
   * (every 50 ms, in the scripted-action phase after the buff components) gives it to a unit
   * that is jumping, so knockback without PushbackAll is refused (0xfcfac4 / 0xfc2c4c).
   */
  pushImmune: boolean;
  /**
   * Out-and-back projectile in flight (attack +0x58, 0xfc7914) and the PingpongVisualTime wait
   * (attack +0x60 / +0x64): the attack component does nothing until both are over (0xfc7e20).
   */
  axe: Projectile | null;
  axeMs: number;
  axeWait: number;

  constructor(id: number, def: UnitDef, card: string, team: number, x: number, y: number, tick: number) {
    this.id = id;
    this.def = def;
    this.card = card;
    this.team = team;
    this.x = x;
    this.y = y;
    this.hp = def.hitpoints;
    this.maxHp = def.hitpoints;
    this.shield = def.shieldHitpoints;
    this.state = ST_DEPLOYING;
    this.deployTicks = 0;
    this.deployTotal = 0;
    this.target = null;
    this.locked = false;
    // Units spawn preloaded: the timer starts at LoadTime [OBS, MECHANICS_BRIEF §6].
    this.atkTimer = def.loadTime;
    this.atkDelay = 0;
    this.lastHitTick = -1000;
    this.lastHurtTick = -1000;
    this.path = NO_PATH;
    this.pathIdx = 0;
    this.pathBack = false;
    // spawn facing (0xd35ab4): (0, +256) for team 0, (0, -256) for team 1
    this.dirX = 0;
    this.dirY = team === 0 ? 256 : -256;
    this.moving = false;
    this.tower = TOWER_NONE;
    this.lane = 0;
    this.kingState = KING_ACTIVE;
    this.kingTicks = 0;
    this.isAir = def.flyingHeight > 0;
    this.isBuilding = def.kind === 'building';
    this.radius = def.collisionRadius;
    this.mass = def.mass > 0 ? def.mass : 1;
    this.kbActive = false;
    this.kbStep = 0;
    this.kbX = 0;
    this.kbY = 0;
    this.kbIgnore = false;
    this.slideN = 0;
    this.spawnImmune = false;
    this.spawnImmuneMs = 0;
    this.jumping = false;
    this.jumpTotal = 0;
    this.walkMs = 0;
    this.gx = x;
    this.gy = y;
    this.inGrid = false;
    this.spawnTick = tick;
    this.buffs = [];
    this.lifeTicks = 0;
    this.decayed = 0;
    this.spawnTimer = def.spawn ? def.spawn.startTime : 0;
    this.spawnGroup = 0;
    this.spawnRot = 0;
    this.pending = 0;
    this.pendingDur = 0;
    this.waitTicks = 0;
    this.dmgKeys = [];
    this.dmgKeyTimes = [];
    this.seqIndex = -1;
    this.keepFlag = false;
    this.manaT = 0;
    this.hideT = 0;
    this.hidden = false;
    this.tunneling = false;
    this.tunnelX = 0;
    this.tunnelY = 0;
    this.retargetCd = 0;
    this.load = 0;
    this.hitStarted = false;
    this.loaded = false;
    this.finishMs = 0;
    this.tsx = 0;
    this.tsy = 0;
    this.pushAccX = 0;
    this.pushAccY = 0;
    this.pushCount = 0;
    this.wpDirX = 0;
    this.wpDirY = 0;
    this.charge = 0;
    this.chargeHit = false;
    this.attackedTarget = false;
    this.sidestep = 0;
    this.gridStamp = 0;
    this.prio = 0;
    this.atkOff = false;
    this.z = def.flyingHeight;
    this.jumpZ = 0;
    this.pushImmune = false;
    this.axe = null;
    this.axeMs = 0;
    this.axeWait = 0;
    // Native attack timer starts at 0; the first swing starts at LoadTime - load (load 0 for a fresh
    // unit) so the first hit lands HitSpeed - LoadTime later [STAT 0xfc90b0].
    this.atkTimer = 0;
  }

  get alive(): boolean {
    return this.state !== ST_DEAD;
  }

  /**
   * View only (the viewer's Inferno level reads it): the start of the current attack-sequence entry in ms
   * of attack timer, i.e. the summed durations of the entries before `seqIndex` (0 without one). Not state.
   */
  get rampMs(): number {
    let ms = 0;
    const seq = this.def.seq;
    for (let i = 0; i < this.seqIndex && i < seq.length; i++) ms += seq[i].duration;
    return ms;
  }

  /** Charging (movement +0x1e0 >= 10000). */
  get charging(): boolean {
    return this.charge >= 10000;
  }

  get isCrownTower(): boolean {
    return this.tower !== TOWER_NONE;
  }
}

export class Projectile {
  id: number;
  def: ProjectileDef;
  team: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  /** Fixed destination (non-homing) or last known target position (homing). */
  tx: number;
  ty: number;
  target: Unit | null;
  damage: number;
  towerDamage: number;
  crownPct: number;
  radius: number;
  aoeAir: boolean;
  aoeGround: boolean;
  pushback: number;
  /** Who fired it; spells have source null. */
  sourceId: number;
  /** Spell name for spell projectiles ('' for unit shots). */
  spell: string;
  born: number;
  alive: boolean;
  /**
   * Height (native actor z, +0x8c) as Projectile_update 0xf90708 sets it: the arc 0xf927ec between
   * startZ and aimZ with the data's Gravity while flying, ConstantHeight (at least 0) on arrival,
   * 0 back at the start for an out-and-back projectile. Read-only for the view.
   */
  z: number;
  /** Start height (+0x134) and aim height (+0x128). */
  startZ: number;
  aimZ: number;
  /** Ids of the actors already hit (+0x60): a piercing projectile hits each once (0xf8ff74). */
  hitIds: number[];
  /** Who fired it (p->shooter / source, +0xf0); null for spells and spawned projectiles. */
  shooter: Unit | null;
  /**
   * Out-and-back flight (PingpongVisualTime, Executioner's axe): elapsed ms (+0x138) and its step
   * per update (+0x140, the shooter's buff time scale of 50 ms when thrown). The position is
   * start + sin(180·t/PingpongVisualTime)·(aim − start); at the half-way update the hit list is
   * cleared so the way back hits again.
   */
  pingT: number;
  pingStep: number;
  /** Distance from the start of an out-and-back projectile before its last move (+0x13c, for the view). */
  travel: number;
  /** HomingTime re-aim (+0x1bc ms left) at target2 (+0x110). */
  homingT: number;
  target2: Unit | null;
  /** Spawn-chain depth left (+0x1c8, SpawnChain): a SpawnProjectile is created on impact while > 0. */
  chainLeft: number;
  /** SpawnAxisX/Y side (+0x1d8). */
  axisDir: number;
  /** Arrived (+0x170, markReached 0xf8eed8). */
  reached: boolean;
  /** Spawned by another projectile (+0x1d0 set): such a copy gets a damage key of its own when it has none. */
  fromParent: boolean;
  /** Pending damage registered on the target (projectile +0x1dc, 0xf8fa94). */
  pendReg: boolean;
  /** Damage key (projectile +0xc0): non-zero only for SpawnProjectile chains (0xf8e6fc). */
  key: number;
  /** Chain lightning: hits so far (+0x1b8) and the ignore list of actor ids (+0x60). */
  chainHits: number;
  ignoreIds: number[];
  /** Start delay ms (projectile +0x1b0): counts down 50 per update before the projectile moves. */
  delay: number;
  /** Spell-wave group (0xf8f498): shared ignore list and the spell circle every target must touch. */
  group: SpellGroup | null;

  constructor(id: number, def: ProjectileDef, team: number, x: number, y: number, tick: number) {
    this.id = id;
    this.def = def;
    this.team = team;
    this.x = x;
    this.y = y;
    this.startX = x;
    this.startY = y;
    this.tx = x;
    this.ty = y;
    this.target = null;
    this.damage = def.damage;
    this.towerDamage = def.towerDamage;
    this.crownPct = def.crownTowerDamagePercent;
    this.radius = def.radius;
    this.aoeAir = def.aoeToAir;
    this.aoeGround = def.aoeToGround;
    this.pushback = def.pushback;
    this.sourceId = -1;
    this.spell = '';
    this.born = tick;
    this.alive = true;
    this.delay = 0;
    this.group = null;
    this.z = 0;
    this.startZ = 0;
    this.aimZ = 0;
    this.hitIds = [];
    this.shooter = null;
    this.pingT = 0;
    this.pingStep = 0;
    this.travel = 0;
    this.homingT = 0;
    this.target2 = null;
    this.chainLeft = 0;
    this.axisDir = 0;
    this.reached = false;
    this.fromParent = false;
    this.pendReg = false;
    this.key = 0;
    this.chainHits = 0;
    this.ignoreIds = [];
  }
}

/** One spell wave's shared hit list and circle (0xf8f498 / 0xf93784): World_areaDamage ignore list and second circle. */
export interface SpellGroup {
  ids: number[];
  x: number;
  y: number;
  r: number;
  /**
   * Group +0xc: set by the first hit of the wave (0xf8f03c); later hits pass World_areaDamage flag 1, so
   * the wave shows one area ring. Only the event path reads it (no effect on the simulation).
   */
  ringShown?: boolean;
}

/** Area effect object (Zap, Freeze, Poison, Rage...). */
export class AreaEffect {
  id: number;
  def: AreaEffectDef;
  team: number;
  x: number;
  y: number;
  /** Remaining life ms (area effect +0x100): LifeDuration, -50 per update; removed once negative. */
  life: number;
  /** Ids already hit (OneHitPerTarget, +0x120). */
  hitIds: number[];
  born: number;
  alive: boolean;
  /**
   * The SpawnAreaEffectObject is still to be created (+0xf8, set by the ctor 0xf79ca0 when the data has
   * one): the first update creates it (0xf7b254) before its own pulse logic.
   */
  spawnPending: boolean;

  constructor(id: number, def: AreaEffectDef, team: number, x: number, y: number, tick: number) {
    this.id = id;
    this.def = def;
    this.team = team;
    this.x = x;
    this.y = y;
    this.life = def.lifeDuration;
    this.hitIds = [];
    this.born = tick;
    this.alive = true;
    this.spawnPending = def.spawnAreaEffect !== null;
  }
}

export interface Command {
  team: number;
  card: CardDef;
  x: number;
  y: number;
  submitTick: number;
  /** Hand slot used (-1 for sandbox spawns that bypass the hand). */
  slot: number;
  /** Deck index of the played card (-1 for sandbox spawns); it leaves the hand when the play commits. */
  deck: number;
  cost: number;
}

/**
 * Visual events for the viewer (recorded only when enabled).
 * - areaRing: World_areaDamage 0xf97be8 called the battle screen's vt+0x3a8 (0xbe76e8) with (x, y, r, r2):
 *   r2 > 0 draws a rectangle frame, else an ellipse; name/id are the damage source (unit or projectile).
 * - pushRing: vt+0x3b0 (0xbe7980) with (x, y, r): the pushback of World_areaDamage (r = pushback) or
 *   of an area-effect pulse (0xf7a34c, r = its Pushback).
 * - landing: Actor_setState 0xf7f2c8 left the jump state 5; the view plays LandingEffect (vt+0x80
 *   0x84e784) at the actor's x, y, z.
 * - kingActivate: the King's activation actions (king_tower.toml: ActionWaitToActivate on
 *   `king_tower_damaged() || tower_destroyed()`, ActionWithDuration 3300 ms with ACTIVATING, then the
 *   ActionFilter `is_npc_battle()` -> ActionPlayEffect King_player_activate) reached the effect: recorded
 *   when the King turns active; `name` = the effect, `id` / `team` / `x` / `y` = the King.
 */
export interface BattleEvent {
  tick: number;
  type: 'hit' | 'death' | 'spawn' | 'impact' | 'cast' | 'tower' | 'shoot' | 'aoe' | 'appear' | 'hide' | 'collect' | 'path'
    | 'areaRing' | 'pushRing' | 'landing' | 'aoePulse' | 'elixir' | 'projEnd' | 'reject'
    | 'damage' | 'shieldLost' | 'wobble' | 'kingActivate' | 'dash' | 'shake';
  team: number;
  x: number;
  y: number;
  /** Unit/card/projectile name. */
  name: string;
  id: number;
  /** areaRing / pushRing: radius (game units); areaRing: second radius (0: none). */
  r?: number;
  r2?: number;
  /** landing: actor z (game units). */
  z?: number;
  /**
   * elixir (battle screen listener vt+0x398 0xbe4a8c from 0xf83990 / 0xfca5ec): `team` receives
   * `amount` (1/10000 elixir) at the dying unit's (x, y); `side` is the listener's owner argument
   * (-1: ManaOnDeath, neutral colour; else the receiving owner). `id` = the dying unit.
   */
  amount?: number;
  side?: number;
  /** cast: id of the first projectile Tower_castSpell created (-1: none). spawn: the projectile whose
   * hit made it (0xf9188c), else absent. */
  pid?: number;
  /**
   * Character-view effect data (viewer sc/char_effects.ts):
   * - damage: a queued damage entry was applied (World_flushDamageQueue 0xf992e0 -> Health_applyHit
   *   0xfcb29c, which plays the entry's effect on the victim's view, vt+0xc0). `id`/`team`/`x`/`y` are the
   *   victim; `fx` the entry's effect: 0 none (area-effect pulses 0xfd068c, tiebreak drains), 1 the global
   *   "Damage" effect (World_areaDamage 0xf97be8; spell and spawned projectiles; Tables +0xec0), 2 the
   *   attacker's DamageEffect, 3 its DamageEffectSpecial (charge hit, 0xfc619c), 4 the projectile's effect
   *   (Projectile_init's: the shooter's DamageEffect, else "Damage"), 5 the buff's damage effect
   *   (0xf86668: BuffData +0x248, else "Damage"); `name` is the attacker / shooter / buff data name ('' for
   *   none); `src` the source actor or projectile id.
   *   `vx`/`vy` are the entry's vector (+0x10: single melee and projectile hits, piercing hits; 0 for
   *   area damage), whose native angle the lethal entry stores as the death angle (health +0x18).
   * - wobble: the victim view's hit call vt+0xe8 (damage filter 0x83e3d8) with the vector `vx`/`vy`.
   * - shieldLost: the entry broke the victim's shield (0xfcb29c -> 0xf85730 -> view vt+0x110 0x846850).
   * - spawn: `src` = the source character of a spawner or death spawn (0xf8aac8 reads its
   *   SpawnCharacterEffect), else absent.
   * - hit / shoot: `src` = the target id; `fx` = 1 for a charged attack (movement +0x1e0 >= 10000).
   * - impact: `src` = the projectile's target id (-1: none); `z` = the projectile's z (+0x8c) at the hit.
   * - dash: AttackComp_update 0xfc7e20 calls the attacker view's vt+0x40 (0x845ce8, the AttackDashTime lunge)
   *   when (AttackDashTime + attack timer) / HitSpeed steps up this tick; `id` the attacker, `src` the target,
   *   `x`/`y` its position, `vx`/`vy` attacker − target, `r` its collision radius (target vt+0xa0).
   * - shake: a piercing hit 0xf8ff74 of a ShakesTargets projectile calls the victim view's vt+0xf0 (0x83e488)
   *   with `vx`/`vy` = victim − projectile (0xf90640).
   */
  fx?: number;
  src?: number;
  /** damage / wobble: direction vector (logic units). */
  vx?: number;
  vy?: number;
  /**
   * hit / shoot: the attack was cancelled (LOGIC_CANCEL_HIT_FROM_LONG_DISTANCE: the target is beyond range
   * + 1500, 0xfc619c): no damage or projectile, and the client skips its attack view call (vt+0x90) and the
   * ATTACKING tag. Absent otherwise. `src` may be -1: an area attack that completes without a target
   * (0xfc7d98: SelfAsAoeCenter or a non-homing projectile).
   */
  cancelled?: boolean;
  /** hit / shoot: the attacker's attack-sequence index for this attack (attack +0x20; Inferno level 0..2), absent without a sequence. */
  seq?: number;
}
