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
  /** Charge: distance travelled uninterrupted, charging flag. */
  chargeDist: number;
  charging: boolean;

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
    this.chargeDist = 0;
    this.charging = false;
  }

  get alive(): boolean {
    return this.state !== ST_DEAD;
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
