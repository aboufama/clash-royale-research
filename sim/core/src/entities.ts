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

  constructor(def: BuffDef, sourceId: number, ticks: number) {
    this.def = def;
    this.sourceId = sourceId;
    this.ticksLeft = ticks;
    this.hitTimer = 0;
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
  path: Int32Array;
  pathIdx: number;
  pathGoal: number;
  pathVersion: number;
  /** Facing vector (game units), for the viewer. */
  dirX: number;
  dirY: number;
  moving: boolean;
  tower: number;
  kingState: number;
  kingTicks: number;
  isAir: boolean;
  isBuilding: boolean;
  radius: number;
  mass: number;
  /** Remaining knockback displacement to apply (game units). */
  pushX: number;
  pushY: number;
  pushTicks: number;
  spawnTick: number;
  buffs: BuffInst[];
  /** Ticks active and HP already lost to building lifetime decay. */
  lifeTicks: number;
  decayed: number;
  /** Spawner: ms until the next group, members left in the current group, ms to the next member. */
  spawnTimer: number;
  spawnLeft: number;
  spawnSub: number;
  spawnIndex: number;
  /** Pending damage from in-flight projectiles aimed at this unit (targeting overkill test). */
  pending: number;
  /** Inferno ramp: ms spent attacking the current target. */
  rampMs: number;
  /** Elixir Collector: ms until the next elixir. */
  manaTimer: number;
  /** Tesla: hidden underground; ms idle; ms until up. */
  hidden: boolean;
  idleMs: number;
  upMs: number;
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
    this.path = NO_PATH;
    this.pathIdx = 0;
    this.pathGoal = -1;
    this.pathVersion = -1;
    this.dirX = 0;
    this.dirY = team === 0 ? 1 : -1;
    this.moving = false;
    this.tower = TOWER_NONE;
    this.kingState = KING_ACTIVE;
    this.kingTicks = 0;
    this.isAir = def.flyingHeight > 0;
    this.isBuilding = def.kind === 'building';
    this.radius = def.collisionRadius;
    this.mass = def.mass > 0 ? def.mass : 1;
    this.pushX = 0;
    this.pushY = 0;
    this.pushTicks = 0;
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
    this.rampMs = 0;
    this.manaTimer = Math.round(def.manaPeriod / 50);
    this.hidden = def.hides;
    this.idleMs = 0;
    this.upMs = 0;
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
  /** Unit whose pending damage this projectile counts toward. */
  pendingOn: Unit | null;

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
    this.dirX = 0;
    this.dirY = 1000;
    this.rangeLeft = 0;
    this.hitIds = [];
    this.returning = false;
    this.source = null;
    this.pendingOn = null;
  }
}

/** Area effect object (Zap, Freeze, Poison, Rage...). */
export class AreaEffect {
  id: number;
  def: AreaEffectDef;
  team: number;
  x: number;
  y: number;
  /** ms since creation */
  age: number;
  /** ms until the next hit (-1: no more hits) */
  nextHit: number;
  hitIds: number[];
  born: number;
  alive: boolean;

  constructor(id: number, def: AreaEffectDef, team: number, x: number, y: number, tick: number) {
    this.id = id;
    this.def = def;
    this.team = team;
    this.x = x;
    this.y = y;
    this.age = 0;
    this.nextHit = def.hitSpeedOffset;
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
  type: 'hit' | 'death' | 'spawn' | 'impact' | 'cast' | 'tower' | 'shoot' | 'aoe';
  team: number;
  x: number;
  y: number;
  /** Unit/card/projectile name. */
  name: string;
  id: number;
}
