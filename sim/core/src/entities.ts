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
  /** ms until the next damage/heal tick. */
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
  /** Spawner: ms until the next group, members left in the current group, ms to the next member. */
  spawnTimer: number;
  spawnLeft: number;
  spawnSub: number;
  spawnIndex: number;
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
  /** Inferno ramp: ms spent attacking the current target. */
  rampMs: number;
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
  /** Miner: tunnelling toward (tunnelX, tunnelY) before deploying. */
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
    const sp = def.spawn;
    this.spawnTimer = sp ? (sp.startTime >= 0 ? sp.startTime : sp.pauseTime) : 0;
    this.spawnLeft = 0;
    this.spawnSub = 0;
    this.spawnIndex = 0;
    this.pending = 0;
    this.pendingDur = 0;
    this.waitTicks = 0;
    this.dmgKeys = [];
    this.dmgKeyTimes = [];
    this.rampMs = 0;
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
    // Native attack timer starts at 0; the first swing starts at LoadTime - load (load 0 for a fresh
    // unit) so the first hit lands HitSpeed - LoadTime later [STAT 0xfc90b0].
    this.atkTimer = 0;
  }

  get alive(): boolean {
    return this.state !== ST_DEAD;
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
  /** Piercing flight: direction x1000, distance left, units already hit, return trip. */
  pierce: boolean;
  dirX: number;
  dirY: number;
  rangeLeft: number;
  hitIds: number[];
  returning: boolean;
  source: Unit | null;
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
    this.pierce = false;
    this.delay = 0;
    this.group = null;
    this.dirX = 0;
    this.dirY = 1000;
    this.rangeLeft = 0;
    this.hitIds = [];
    this.returning = false;
    this.source = null;
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
  cost: number;
}

/** Visual events for the viewer (recorded only when enabled). */
export interface BattleEvent {
  tick: number;
  type: 'hit' | 'death' | 'spawn' | 'impact' | 'cast' | 'tower' | 'shoot' | 'aoe' | 'appear' | 'hide' | 'collect';
  team: number;
  x: number;
  y: number;
  /** Unit/card/projectile name. */
  name: string;
  id: number;
}
