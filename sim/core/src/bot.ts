// A deterministic scripted opponent for any deck the engine supports.
//
// This is NOT a port of anything native: the original client's AI is not used or imitated. It is
// a hand-written heuristic player (docs/DECISIONS.md, "Scripted AI opponent"). Card roles come
// from the build's data through the engine's definitions (UnitDef, ProjectileDef, AreaEffectDef,
// CardDef): hit points, damage, hit speed, range, speed, splash, air/ground targeting, building
// targeting, death spawns, spawners and spell radii/damage. No card is recognised by name.
//
// Determinism: a decision depends only on the battle state and the bot's own seeded xorshift32,
// which advances only inside decide(). The bot uses +, -, *, /, Math.sqrt/min/max/floor/abs/round
// only (IEEE-exact operations, no Math.pow/exp/hypot), so the same (seed, battle) gives the same
// play on every engine. Call act() (or decide() and play the result) once per tick, in a fixed
// order relative to the other side's policy, and a replay reproduces the match.

import { ARENA_H } from './arena.ts';
import type { Battle, PlayError } from './battle.ts';
import type { AreaEffectDef, CardDef, ProjectileDef, UnitDef } from './data.ts';
import { KING_ACTIVE, ST_DEAD, ST_DEPLOYING, TOWER_NONE, type Unit } from './entities.ts';

// ------------------------------------------------------------------------------------------------
// Card roles (derived from data only)

/** Per-member combat summary of a unit definition. */
export interface UnitRole {
  /** Hit points plus shield (spawners and death spawns add a share of their units). */
  hp: number;
  /** Damage per hit against troops (projectile damage for ranged units). */
  hit: number;
  /** Damage per second against troops (a kamikaze's one burst counts as one second). */
  dps: number;
  /** Single-target hits per second (overkill floor against swarms). */
  hitRate: number;
  /** Damage per second against crown towers. */
  towerDps: number;
  /** Splash radius (area damage, splash or piercing projectile, chain), 0 = single target. */
  splash: number;
  air: boolean;
  hitsAir: boolean;
  hitsGround: boolean;
  range: number;
  speed: number;
  buildingsOnly: boolean;
  kamikaze: boolean;
  building: boolean;
  /** Elixir value from the stats alone (used when the summoning card is unknown). */
  statValue: number;
  /** Elixir the opponent gets when this unit dies (ManaOnDeathForOpponent), and with its death spawns. */
  giftSelf: number;
  gift: number;
}

export type SpellKind = 'damage' | 'roll' | 'spawn' | 'freeze' | 'rage' | 'none';

export interface SpellRole {
  kind: SpellKind;
  /** Total damage to one troop target (all waves / pulses / damage over time). */
  damage: number;
  /** Total damage to one crown tower. */
  towerDamage: number;
  radius: number;
  hitsAir: boolean;
  hitsGround: boolean;
  /** Flight speed from the King tower in units per tick (0 = instant). */
  speed: number;
  /** Rolling spells (cast on the own side, roll forward): length and half-width. */
  rollRange: number;
  rollWidth: number;
  /** Strikes on the biggest targets (Lightning-like area effects), 0 = everything in the radius. */
  strikes: number;
  /** Damage over time (targets can walk out). */
  dot: boolean;
  /** Stun / freeze time in ms. */
  stun: number;
}

export interface CardRole {
  name: string;
  cost: number;
  type: 'troop' | 'building' | 'spell';
  members: { def: UnitDef; role: UnitRole; count: number; value: number }[];
  count: number;
  hp: number;
  dpsG: number;
  dpsA: number;
  towerDps: number;
  splash: number;
  /** Every member flies / some member flies. */
  air: boolean;
  anyAir: boolean;
  range: number;
  speed: number;
  deployTicks: number;
  /** Win condition: building-targeting troop, troop deployable on the enemy side, spawning spell, siege building. */
  win: boolean;
  tank: boolean;
  building: boolean;
  siege: boolean;
  collector: boolean;
  swarm: boolean;
  splashy: boolean;
  antiAir: boolean;
  ranged: boolean;
  kamikaze: boolean;
  enemySide: boolean;
  buildingsOnly: boolean;
  /** Elixir the opponent gets when everything this card summons dies (Elixir Golem). */
  gift: number;
  spell: SpellRole | null;
}

function crownPct(dmg: number, pct: number): number {
  return Math.floor((dmg * (100 + pct)) / 100);
}

function projTowerDamage(p: ProjectileDef): number {
  return p.towerDamage >= 0 ? p.towerDamage : crownPct(p.damage, p.crownTowerDamagePercent);
}

function unitRoleOf(d: UnitDef, depth = 0): UnitRole {
  const p = d.projectile;
  let hit = d.damage;
  let splash = d.areaDamageRadius;
  let pct = d.crownTowerDamagePercent;
  if (p) {
    hit = p.damage;
    if (p.pingpongTime > 0) hit *= 2; // out and back
    if (p.radius > 0) splash = Math.max(splash, p.radius);
    if (p.pierce) splash = Math.max(splash, p.pierceRadius, 800);
    if (p.chainCount > 1) {
      hit = hit * Math.min(p.chainCount, 3) / 2; // chain hops: more targets, counted as splash too
      splash = Math.max(splash, 1500);
    }
    if (p.crownTowerDamagePercent !== 0) pct = p.crownTowerDamagePercent;
  }
  if (d.variableDamage) hit = Math.max(hit, d.variableDamage[1]);
  // a charge (Prince, Dark Prince, Battle Ram) opens with DamageSpecial
  if (!p && d.chargeRange > 0 && d.damageSpecial > hit) hit = (d.damageSpecial + 2 * hit) / 3;
  if (d.multipleTargets > 1) hit = hit * Math.min(d.multipleTargets, 3) * 0.75;
  const hs = d.hitSpeed > 0 ? d.hitSpeed : 1000;
  let dps = (hit * 1000) / hs;
  let hitRate = 1000 / hs;
  if (d.kamikaze) { dps = hit; hitRate = 1; }
  if (!(d.attacksAir || d.attacksGround)) { dps = 0; hitRate = 0; }
  let hp = d.hitpoints + d.shieldHitpoints;
  let towerDps = d.targetOnlyTroops ? 0 : crownPct(dps, pct);
  // a ramping beam reaches its last stage on a crown tower (it never retargets)
  if (d.variableDamage && !d.kamikaze) towerDps = crownPct((d.variableDamage[2] * 1000) / hs, pct);
  // spawners (huts, Tombstone, Witch): about half a wave alive on average
  if (d.spawn && depth < 2) {
    const s = unitRoleOf(d.spawn.unit, depth + 1);
    const n = Math.max(1, d.spawn.number) * 0.5;
    dps += s.dps * n;
    hitRate += s.hitRate * n;
    towerDps += s.towerDps * n;
    hp += s.hp * n;
  }
  // death spawns extend the fight (and may hand the opponent more elixir)
  const giftSelf = (d.manaOnDeathForOpponent * 10) / 10000; // the engine credits value x 10 (x10000 units)
  let gift = giftSelf;
  if (d.deathSpawn && depth < 3) {
    const s = unitRoleOf(d.deathSpawn.unit, depth + 1);
    const n = Math.max(1, d.deathSpawn.count);
    hp += s.hp * n * 0.6;
    dps += s.dps * n * 0.25;
    towerDps += s.towerDps * n * 0.25;
    gift += s.gift * n;
  }
  if (d.deathAreaEffect && d.deathAreaEffect.damage > 0) dps += d.deathAreaEffect.damage * 0.1;
  const building = d.kind === 'building';
  if (building && d.lifeTime > 0) hp = Math.min(hp, hp * 0.5 + d.lifeTime * 0.02);
  const role: UnitRole = {
    hp,
    hit,
    dps,
    hitRate,
    towerDps,
    splash,
    air: d.flyingHeight > 0,
    hitsAir: d.attacksAir && dps > 0,
    hitsGround: d.attacksGround && dps > 0,
    range: d.range,
    speed: d.speed,
    buildingsOnly: d.targetOnlyBuildings,
    kamikaze: d.kamikaze,
    building,
    statValue: 0,
    giftSelf,
    gift,
  };
  role.statValue = Math.max(0.15, Math.min(8, (hp + 8 * dps) / 1050));
  return role;
}

function spellRoleOf(c: CardDef): SpellRole | null {
  if (c.type !== 'spell') return null;
  const s: SpellRole = {
    kind: 'none', damage: 0, towerDamage: 0, radius: 0, hitsAir: true, hitsGround: true, speed: 0,
    rollRange: 0, rollWidth: 0, strikes: 0, dot: false, stun: 0,
  };
  const p = c.spellProjectile;
  if (p) {
    const roll = p.spawnProjectile;
    if (c.spellAsDeploy && roll && roll.pierce) {
      s.kind = 'roll';
      s.damage = roll.damage + p.damage;
      s.towerDamage = projTowerDamage(roll);
      s.rollRange = roll.range;
      s.rollWidth = roll.pierceRadius;
      s.hitsAir = roll.aoeToAir;
      s.hitsGround = true;
      s.speed = roll.speed;
    } else if (p.spawnUnit) {
      s.kind = 'spawn';
      s.radius = p.radius;
      s.speed = p.speed;
      s.damage = p.damage;
    } else {
      const waves = Math.max(1, c.waves);
      s.kind = 'damage';
      s.damage = p.damage * waves;
      s.towerDamage = projTowerDamage(p) * waves;
      s.radius = c.multipleProjectiles > 1 && c.spellRadius > 0 ? c.spellRadius : p.radius;
      s.hitsAir = p.aoeToAir || p.radius === 0;
      s.hitsGround = p.aoeToGround || p.radius === 0;
      s.speed = p.speed;
      if (p.targetBuff && p.targetBuff.speedMul <= -100) s.stun = p.buffTime;
    }
  }
  const a = c.areaEffect;
  if (a) applyAreaSpell(s, a);
  for (const e of c.summon) {
    const dae = e.unit.deathAreaEffect;
    if (dae && dae.buff && (dae.buff.speedMul > 100 || dae.buff.hitSpeedMul > 100) && dae.damage === 0) {
      s.kind = 'rage';
      s.radius = dae.radius;
    }
  }
  return s;
}

function applyAreaSpell(s: SpellRole, a: AreaEffectDef): void {
  s.radius = Math.max(s.radius, a.radius);
  if (a.filter) s.hitsAir = !a.filter.exFlying;
  const pulses = a.hitSpeed > 0 ? Math.max(1, Math.floor(a.lifeDuration / a.hitSpeed)) : 1;
  if (a.projectile && a.targetProjectiles) {
    s.kind = 'damage';
    s.strikes = pulses * Math.max(1, a.maxTargets);
    s.damage = a.projectile.damage;
    s.towerDamage = projTowerDamage(a.projectile);
    return;
  }
  let dmg = a.damage * pulses;
  let tdmg = a.towerDamage >= 0 ? a.towerDamage * pulses : crownPct(a.damage, a.crownTowerDamagePercent) * pulses;
  const b = a.buff;
  if (b && b.dps > 0) {
    const secs = (a.lifeDuration > 0 ? a.lifeDuration : a.buffTime) / 1000;
    dmg += b.dps * secs;
    tdmg += b.crownTowerDamagePerHit > 0 ? b.crownTowerDamagePerHit * secs : crownPct(b.dps, b.crownTowerDamagePercent) * secs;
    s.dot = true;
  }
  s.damage += dmg;
  s.towerDamage += tdmg;
  const freezes = b !== null && b.speedMul <= -100;
  if (freezes) s.stun = Math.max(a.buffTime, a.lifeDuration);
  if (b && (b.speedMul > 100 || b.hitSpeedMul > 100) && dmg === 0) s.kind = 'rage';
  else if (freezes && a.lifeDuration >= 1000) s.kind = 'freeze';
  else if (s.damage > 0) s.kind = 'damage';
}

/** Derive a card's roles from its definition (cached per CardDef object by the bot). */
export function cardRole(c: CardDef): CardRole {
  const members: CardRole['members'] = [];
  for (const e of c.summon) {
    const role = unitRoleOf(e.unit);
    const same = members.find((m) => m.def === e.unit);
    if (same) same.count += Math.max(1, e.count);
    else members.push({ def: e.unit, role, count: Math.max(1, e.count), value: 0 });
  }
  let count = 0, hp = 0, dpsG = 0, dpsA = 0, towerDps = 0, splash = 0, range = 0, speed = 0, deploy = 0;
  let allAir = members.length > 0, anyAir = false, allTob = members.length > 0, allKamikaze = members.length > 0;
  let weight = 0;
  for (const m of members) {
    const r = m.role;
    count += m.count;
    hp += r.hp * m.count;
    if (!r.buildingsOnly) {
      if (r.hitsGround) dpsG += r.dps * m.count;
      if (r.hitsAir) dpsA += r.dps * m.count;
    }
    towerDps += r.towerDps * m.count;
    if (r.dps > 0) splash = Math.max(splash, r.splash);
    range = Math.max(range, r.range);
    if (r.speed > 0) speed = speed === 0 ? r.speed : Math.min(speed, r.speed);
    deploy = Math.max(deploy, m.def.deployTime + m.def.deployDelay);
    allAir = allAir && r.air;
    anyAir = anyAir || r.air;
    allTob = allTob && r.buildingsOnly;
    allKamikaze = allKamikaze && r.kamikaze;
    weight += (r.hp + 6 * r.dps) * m.count;
  }
  for (const m of members) {
    m.value = weight > 0 ? (c.cost * (m.role.hp + 6 * m.role.dps)) / weight : c.cost / Math.max(1, count);
  }
  const spell = spellRoleOf(c);
  if (spell && spell.kind === 'spawn' && c.spellProjectile?.spawnUnit) {
    const r = unitRoleOf(c.spellProjectile.spawnUnit);
    const n = Math.max(1, c.spellProjectile.spawnCount);
    count = n;
    hp = r.hp * n;
    dpsG = r.hitsGround ? r.dps * n : 0;
    towerDps = r.towerDps * n;
    speed = r.speed;
  }
  const building = c.type === 'building';
  const siege = building && range >= 9000 && towerDps > 0;
  const collector = members.some((m) => m.def.manaCollect > 0);
  const enemySide = c.type === 'troop' && c.canDeployOnEnemySide;
  const avgHp = count > 0 ? hp / count : 0;
  let gift = 0;
  for (const m of members) gift += m.role.gift * m.count;
  return {
    name: c.name,
    cost: c.cost,
    type: c.type,
    members,
    count,
    hp,
    dpsG,
    dpsA,
    towerDps,
    splash,
    air: allAir,
    anyAir,
    range,
    speed,
    deployTicks: Math.round(deploy / 50),
    win: (c.type === 'troop' && allTob) || enemySide || (spell !== null && spell.kind === 'spawn') || siege,
    tank: !building && c.type === 'troop' && (hp >= 2400 || (hp >= 1600 && hp / Math.max(1, c.cost) >= 550)),
    building,
    siege,
    collector,
    swarm: c.type === 'troop' && count >= 3 && avgHp <= 400,
    splashy: splash >= 1000 && dpsG + dpsA > 0,
    antiAir: dpsA >= 50,
    ranged: range >= 3500,
    kamikaze: c.type === 'troop' && allKamikaze,
    enemySide,
    buildingsOnly: allTob,
    gift,
    spell,
  };
}

// ------------------------------------------------------------------------------------------------
// Fight model: a coarse Lanchester-style estimate between two forces.

class Force {
  hpG = 0; hpA = 0; hpB = 0;
  nG = 0; nA = 0; nB = 0;
  /** dps applicable to ground / air targets, the splash part of it, single-target hit rates. */
  dG = 0; dA = 0; sG = 0; sA = 0; rG = 0; rA = 0;
  /** dps of building-only attackers (they hit buildings and crown towers only). */
  dB = 0;
  /** dps of members that hit only ground / only air targets. */
  dGo = 0; dAo = 0;
  /** dps against crown towers of every member, and of the building-only members. */
  tw = 0; twB = 0;
  /** Hit points of members that stand in front (melee troops, buildings). */
  front = 0;
  value = 0;
  /** Value of building members (they do not counter-push). */
  bValue = 0;

  clear(): void {
    this.hpG = this.hpA = this.hpB = this.nG = this.nA = this.nB = 0;
    this.dG = this.dA = this.sG = this.sA = this.rG = this.rA = this.dB = this.tw = this.twB = this.front = this.value = 0;
    this.dGo = this.dAo = this.bValue = 0;
  }

  copy(o: Force): void {
    this.hpG = o.hpG; this.hpA = o.hpA; this.hpB = o.hpB; this.nG = o.nG; this.nA = o.nA; this.nB = o.nB;
    this.dG = o.dG; this.dA = o.dA; this.sG = o.sG; this.sA = o.sA; this.rG = o.rG; this.rA = o.rA;
    this.dB = o.dB; this.tw = o.tw; this.twB = o.twB; this.front = o.front; this.value = o.value;
    this.dGo = o.dGo; this.dAo = o.dAo; this.bValue = o.bValue;
  }

  /** `front`: the member stands where the enemy reaches it before our tower (default: melee and buildings). */
  add(r: UnitRole, hp: number, n: number, value: number, front = r.building || r.range < 2500): void {
    if (r.building) { this.hpB += hp * n; this.nB += n; this.bValue += value * n; }
    else if (r.air) { this.hpA += hp * n; this.nA += n; }
    else { this.hpG += hp * n; this.nG += n; }
    if (front) this.front += hp * n;
    this.value += value * n;
    this.tw += r.towerDps * n;
    if (r.buildingsOnly) { this.dB += r.dps * n; this.twB += r.towerDps * n; return; }
    const spl = r.splash >= 800;
    if (r.hitsGround) { this.dG += r.dps * n; if (spl) this.sG += r.dps * n; else this.rG += r.hitRate * n; }
    if (r.hitsAir) { this.dA += r.dps * n; if (spl) this.sA += r.dps * n; else this.rA += r.hitRate * n; }
    if (r.hitsGround && !r.hitsAir) this.dGo += r.dps * n;
    if (r.hitsAir && !r.hitsGround) this.dAo += r.dps * n;
  }

  /**
   * Share of the enemy's fire our troops take: ranged troops behind a covering tower let the
   * tower tank, melee troops and buildings in front take it all.
   */
  exposure(towerCovers: boolean): number {
    const hp = this.hpG + this.hpA + this.hpB;
    const f = hp > 0 ? this.front / hp : 1;
    return towerCovers ? 0.45 + 0.55 * f : 0.8 + 0.2 * f;
  }
}

function splashBonus(n: number): number {
  return n <= 1 ? 0 : Math.min(n - 1, 3) * 0.6;
}

/** Seconds for (dps, splash dps, single hit rate, tower dps) to kill hp spread over n members. */
function killTime(hp: number, n: number, dps: number, spl: number, rate: number, tower: number): number {
  if (hp <= 0) return 0;
  const r = dps + spl * splashBonus(n) + tower;
  if (r <= 0) return Infinity;
  let t = hp / r;
  if (spl <= 0 && n > 1) {
    const hits = rate + (tower > 0 ? 1.2 : 0);
    if (hits > 0 && n / hits > t) t = n / hits;
  }
  return t;
}

interface FightOut { k: number; surv: number; towerDmg: number; killed: number }

const HORIZON = 10; // seconds of tower damage considered

/**
 * Outcome of our force against an enemy group: k = fraction of their hit points our side removes
 * (towers covering the fight included), surv = fraction of our force left, towerDmg = damage they
 * deal to the tower they walk to, killed = their elixir value destroyed in the horizon.
 */
function fight(ours: Force, th: Force, towerFight: number, towerTarget: number, eta: number, out: FightOut, horizon = HORIZON): void {
  const ex = ours.exposure(towerFight > 0);
  const tK = killTime(th.hpG, th.nG, ours.dG - ours.sG, ours.sG, ours.rG, towerFight)
    + killTime(th.hpA, th.nA, ours.dA - ours.sA, ours.sA, ours.rA, towerFight);
  const tD = killTime(ours.hpG, ours.nG, (th.dG - th.sG) * ex, th.sG * ex, th.rG * ex, 0)
    + killTime(ours.hpA, ours.nA, (th.dA - th.sA) * ex, th.sA * ex, th.rA * ex, 0)
    + killTime(ours.hpB, ours.nB, th.dG + th.dB, 0, th.rG, 0);
  let k: number;
  let surv: number;
  if (tK <= 0) { k = 1; surv = 1; }
  else if (tK === Infinity) { k = 0; surv = tD === Infinity ? 1 : 0; }
  else if (tK <= tD) { k = 1; surv = tD === Infinity ? 1 : 1 - tK / tD; }
  else { k = tD / tK; surv = 0; }
  const tFight = Math.min(tK, tD, horizon);
  let towerDmg = 0;
  // building-only attackers hit our tower while the fight lasts (after our buildings fall)
  if (th.dB > 0) {
    const tB = ours.hpB > 0 ? ours.hpB / th.dB : 0;
    const tEnd = Math.min(tK, horizon);
    const start = Math.max(eta, tB);
    if (tEnd > start) {
      const avg = tK === Infinity ? 1 : Math.max(0, 1 - (start + tEnd) / (2 * tK));
      towerDmg += th.twB * (tEnd - start) * avg;
    }
  }
  // the others' fire our troops cannot draw (nothing of ours they can target), or do not draw
  // (ranged troops behind the tower), lands on the tower while they live
  const total = th.dG + th.dAo;
  if (total > 0 && th.tw > th.twB) {
    const free = ((ours.hpG + ours.hpB <= 0 ? th.dGo : 0) + (ours.hpA <= 0 ? th.dAo : 0)) / total;
    const share = free + (1 - free) * (1 - ex);
    const tEnd = Math.min(tK, horizon);
    if (share > 0 && tEnd > eta) {
      const avg = tK === Infinity ? 1 : Math.max(0, 1 - (eta + tEnd) / (2 * tK));
      towerDmg += (th.tw - th.twB) * share * (tEnd - eta) * avg;
    }
  }
  // what is left after our defenders fall walks into the target tower
  let killed = th.value * k;
  if (k < 1) {
    // they reach the tower once our defenders are down (and not before they walk there)
    const rem = 1 - k;
    const tT = killTime((th.hpG + th.hpA) * rem, Math.max(1, Math.round((th.nG + th.nA) * rem)), 0, 0, 0, towerTarget);
    const start = Math.max(eta, Math.min(tK, tD));
    const left = Math.max(0, horizon - start);
    towerDmg += (th.tw - th.twB) * rem * Math.min(left, tT) * 0.6;
    killed += th.value * rem * (tT === Infinity ? 0 : Math.min(1, left / tT));
  }
  out.k = k;
  out.surv = surv;
  out.towerDmg = towerDmg;
  out.killed = killed;
}

// ------------------------------------------------------------------------------------------------
// Bot

export interface BotOptions {
  /** Seed of the bot's own RNG (tie-breaks, placement jitter). */
  seed?: number;
  /** Strength 1 (easy) .. 3 (hard, default): think rate, reaction time, placement noise. */
  level?: number;
}

export interface BotPlay {
  slot: number;
  x: number;
  y: number;
  card: string;
  /** Short human-readable reason (debugging, viewer overlays). */
  reason: string;
  /** The option's estimated gain in elixir-equivalents. */
  score: number;
}

interface LevelParams {
  think: number; // ticks between decisions
  react: number; // ticks an enemy unit must have existed before the bot reacts to it
  noise: number; // placement jitter (game units)
  gap: number; // minimum ticks between two plays
  leak: number; // elixir at which the bot plays anything rather than leak
  spellK: number; // spell value / cost threshold
  slop: number; // share of decisions replaced by a hesitation or a random card in its natural spot
  tricks: boolean; // cycling toward an answer, saving up for a held card
}

const LEVELS: LevelParams[] = [
  { think: 10, react: 30, noise: 1500, gap: 30, leak: 10, spellK: 2, slop: 0.4, tricks: false },
  { think: 5, react: 12, noise: 600, gap: 12, leak: 9.8, spellK: 1.5, slop: 0.15, tricks: true },
  { think: 2, react: 4, noise: 200, gap: 6, leak: 9.4, spellK: 1.25, slop: 0, tricks: true },
];

interface Seen {
  u: Unit;
  role: UnitRole;
  value: number;
  /** World position (a tunnelling unit: its destination) and local position (own side at low y). */
  x: number;
  y: number;
  lx: number;
  ly: number;
  /** World velocity estimate, units per tick. */
  vx: number;
  vy: number;
  hp: number;
  lane: number;
}

interface Group {
  lane: number;
  list: Seen[];
  lead: Seen;
  f: Force;
  value: number;
  /** Seconds until the lead reaches attack range of the tower it walks to. */
  eta: number;
  target: Unit;
  air: boolean;
  tob: boolean;
  /** Not handled by what we already have on the field (set by defend). */
  open: boolean;
}

interface DefCtx {
  /** Predicted local position of the group's lead, towers covering it, the tower it walks to, baseline score. */
  px: number;
  py: number;
  tBase: number;
  tTarget: number;
  base: number;
}

interface Option {
  slot: number;
  card: CardRole;
  score: number;
  x: number; // world
  y: number;
  reason: string;
}

/** Elixir-equivalent of a whole crown tower: tower hit points are worth more than troops. */
const PRINCESS_VALUE = 24;
const KING_VALUE = 60;
const LANE_X = [3500, 14500];

/** One elixir of whatever the opponent will defend with (generic melee, hits air and ground). */
const VIRTUAL_DEFENDER: UnitRole = {
  hp: 300, hit: 45, dps: 45, hitRate: 0.8, towerDps: 0, splash: 0, air: false, hitsAir: true, hitsGround: true,
  range: 1000, speed: 60, buildingsOnly: false, kamikaze: false, building: false, statValue: 1, giftSelf: 0, gift: 0,
};
/** Its splash half (spells, splash troops): what answers swarms. */
const VIRTUAL_SPLASH: UnitRole = { ...VIRTUAL_DEFENDER, hp: 250, dps: 40, hit: 40, splash: 1500, range: 4000 };

export class Bot {
  readonly team: number;
  readonly level: number;
  private readonly p: LevelParams;
  private s: number;
  private phase: number;
  private lastPlay = -1000;
  private battle: Battle | null = null;
  private roles = new Map<CardDef, CardRole>();
  private byName = new Map<string, CardRole | null>();
  private unitRoles = new Map<UnitDef, UnitRole>();
  private memberValue = new Map<string, Map<UnitDef, number>>();
  private ours = new Force();
  private cand = new Force();
  private att = new Force();
  private def = new Force();
  private fo: FightOut = { k: 0, surv: 0, towerDmg: 0, killed: 0 };
  // per-think snapshot
  private enemies: Seen[] = [];
  private friends: Seen[] = [];
  private seenPool: Seen[] = [];
  private avail = 0;
  private oppElixir = 0;
  /** Deck index seen in each hand slot and the tick it arrived (to unclog cards held too long). */
  private handSeen = [-2, -2, -2, -2];
  private handSince = [0, 0, 0, 0];
  /** Slot of a long-held card the bot is saving elixir for (-1 = none). */
  private saving = -1;
  /** Optional sink for decision traces (debugging). */
  trace: ((msg: string) => void) | null = null;
  /** Counters for benchmarks and tests. */
  readonly stats = { thinks: 0, plays: 0, rejected: 0 };

  constructor(team: number, opts: BotOptions = {}) {
    this.team = team;
    const lv = Math.max(1, Math.min(3, Math.round(opts.level ?? 3)));
    this.level = lv;
    this.p = LEVELS[lv - 1];
    let s = ((opts.seed ?? 1) ^ 0x2545f491 ^ Math.imul(team + 1, 0x9e3779b9)) >>> 0;
    if (s === 0) s = 0x6d2b79f5;
    this.s = s;
    this.phase = this.rand(this.p.think);
  }

  private rand(n: number): number {
    let s = this.s;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.s = s;
    return n > 0 ? s % n : 0;
  }

  private jitter(): number {
    const n = this.p.noise;
    return n > 0 ? this.rand(2 * n + 1) - n : 0;
  }

  /** Decide and play. Returns the play made, or null. Call once per tick before battle.step(). */
  act(b: Battle): BotPlay | null {
    const d = this.decide(b);
    if (!d) return null;
    const err: PlayError | null = b.play(this.team, d.slot, d.x, d.y);
    if (err) { this.stats.rejected++; return null; }
    return d;
  }

  /**
   * The play the bot wants this tick, or null. It assumes the caller plays it at once (act() does);
   * the position is checked with battle.checkPlay, so the play is valid on this tick.
   */
  decide(b: Battle): BotPlay | null {
    if (b.ended) return null;
    if (this.battle !== b) this.reset(b);
    if ((b.tick + this.phase) % this.p.think !== 0) return null;
    if (b.tick - this.lastPlay < this.p.gap) return null;
    this.stats.thinks++;
    const opt = this.think(b);
    if (!opt) return null;
    const pos = b.checkPlay(this.team, opt.slot, opt.x, opt.y);
    if (typeof pos === 'string') { this.stats.rejected++; return null; }
    this.lastPlay = b.tick;
    this.stats.plays++;
    return { slot: opt.slot, x: opt.x, y: opt.y, card: opt.card.name, reason: opt.reason, score: opt.score };
  }

  private reset(b: Battle): void {
    this.battle = b;
    this.lastPlay = -1000;
    this.handSeen = [-2, -2, -2, -2];
    this.handSince = [0, 0, 0, 0];
    this.roles.clear();
    this.byName.clear();
    this.unitRoles.clear();
    this.memberValue.clear();
    for (const pl of b.players) for (const c of pl.deck) this.roleOf(c);
  }

  /** Role of a card (cached). */
  roleOf(c: CardDef): CardRole {
    let r = this.roles.get(c);
    if (!r) {
      r = cardRole(c);
      this.roles.set(c, r);
      this.byName.set(c.name, r);
      const mv = new Map<UnitDef, number>();
      for (const m of r.members) mv.set(m.def, m.value);
      this.memberValue.set(c.name, mv);
    }
    return r;
  }

  private unitRole(d: UnitDef): UnitRole {
    let r = this.unitRoles.get(d);
    if (!r) { r = unitRoleOf(d); this.unitRoles.set(d, r); }
    return r;
  }

  private valueOf(u: Unit, role: UnitRole): number {
    if (!this.byName.has(u.card)) {
      let r: CardRole | null = null;
      if (u.card && this.battle) {
        try { r = this.roleOf(this.battle.defs.card(u.card, this.battle.levels[u.team])); } catch { r = null; }
      }
      if (!r) this.byName.set(u.card, null);
    }
    const v = this.memberValue.get(u.card)?.get(u.def);
    return v !== undefined ? v : role.statValue * 0.6;
  }

  // ---------------------------------------------------------------- geometry helpers

  /** Local y: own side at low y for both teams (the arena is mirrored in y only). */
  private ly(y: number): number {
    return this.team === 0 ? y : ARENA_H - y;
  }

  private laneOfX(x: number): number {
    return x < 9000 ? 0 : 1;
  }

  /** Snap a local placement for `card`; null if no deploy tile is near enough. */
  private place(b: Battle, card: CardDef, lx: number, lly: number, maxMove = 3500): { x: number; y: number } | null {
    const x = Math.round(Math.max(0, Math.min(17999, lx)));
    const y = Math.round(this.ly(Math.max(0, Math.min(31999, lly))));
    const pos = b.deployPlace(this.team, card, x, y);
    if (!pos) return null;
    const dx = pos.x - x;
    const dy = pos.y - y;
    if (dx * dx + dy * dy > maxMove * maxMove) return null;
    return { x, y };
  }

  // ---------------------------------------------------------------- snapshot

  private snapshot(b: Battle): void {
    // reuse the arrays and the Seen records between thinks (no garbage per tick)
    const enemies = this.enemies;
    const friends = this.friends;
    enemies.length = 0;
    friends.length = 0;
    let used = 0;
    const pool = this.seenPool;
    const react = this.p.react;
    for (const u of b.units) {
      if (u.state === ST_DEAD || u.tower !== TOWER_NONE) continue;
      const mine = u.team === this.team;
      if (!mine && b.tick - u.spawnTick < react) continue;
      if (u.hidden && !mine) continue;
      const role = this.unitRole(u.def);
      const x = u.tunneling ? u.tunnelX : u.x;
      const y = u.tunneling ? u.tunnelY : u.y;
      let vx = 0;
      let vy = 0;
      if (u.state === ST_DEPLOYING) {
        vy = role.speed > 0 ? (u.team === 0 ? 1 : -1) * role.speed * 0.5 : 0;
      } else if (u.moving && !u.locked && !u.tunneling) {
        vx = (u.dirX * role.speed) / 256;
        vy = (u.dirY * role.speed) / 256;
      }
      let s = pool[used];
      if (!s) {
        s = { u, role, value: 0, x: 0, y: 0, lx: 0, ly: 0, vx: 0, vy: 0, hp: 0, lane: 0 };
        pool.push(s);
      }
      used++;
      s.u = u; s.role = role; s.value = this.valueOf(u, role) + (mine ? 0 : role.giftSelf); s.x = x; s.y = y; s.lx = x; s.ly = this.ly(y);
      s.vx = vx; s.vy = vy; s.hp = u.hp + u.shield; s.lane = this.laneOfX(x);
      if (mine) friends.push(s); else enemies.push(s);
    }
  }

  // ---------------------------------------------------------------- main decision

  private think(b: Battle): Option | null {
    const opt = this.bestOption(b);
    const slop = this.p.slop;
    if (slop <= 0 || this.rand(1000) >= slop * 1000) return opt;
    // a weaker player: hesitates, or plays some card where it usually goes
    if (opt && this.rand(2) === 0) return null;
    const hand = this.handOptions(b).filter((h) => h.role.cost <= this.avail && !h.role.collector);
    if (hand.length === 0) return opt;
    const h = hand[this.rand(hand.length)];
    return this.naturalPlay(b, h, this.pickLane(b)) ?? opt;
  }

  private bestOption(b: Battle): Option | null {
    const me = b.players[this.team];
    const opp = b.players[1 - this.team];
    this.avail = b.infiniteElixir ? 10 : (me.elixir - me.pending) / 10000;
    this.oppElixir = opp.elixir / 10000;
    for (let i = 0; i < 4; i++) {
      if (me.hand[i] !== this.handSeen[i]) { this.handSeen[i] = me.hand[i]; this.handSince[i] = b.tick; }
    }
    this.snapshot(b);
    const hand = this.handOptions(b);
    if (hand.length === 0) return null;
    // a card held for a long time that we cannot afford yet: save up for it
    this.saving = -1;
    let most = this.p.tricks ? 1.5 : Infinity;
    for (const h of hand) {
      const st = this.stale(b, h.slot);
      if (st >= most && h.role.cost > this.avail && !h.role.collector) { most = st; this.saving = h.slot; }
    }

    // 1. defence (when about to leak, a marginal defensive play beats wasting elixir)
    const groups = this.threats(b);
    const leaking = this.avail >= this.p.leak && !b.infiniteElixir; // sandbox: no bar to fill
    let waiting = false;
    for (const g of groups) {
      const r = this.defend(b, g, hand, leaking);
      if (r === 'wait') { waiting = true; break; }
      if (r) return r;
    }

    // 2. spells for value anywhere (tower finishes, clusters)
    const sp = this.spellPlay(b, hand, groups.length > 0);
    if (sp) return sp;
    if (waiting && !leaking) return null;

    // 3. offence and elixir management
    return this.offence(b, hand, groups);
  }

  /** Playable hand slots: filled, not pending, supported. */
  private handOptions(b: Battle): { slot: number; card: CardDef; role: CardRole }[] {
    const me = b.players[this.team];
    const out: { slot: number; card: CardDef; role: CardRole }[] = [];
    for (let slot = 0; slot < 4; slot++) {
      const di = me.hand[slot];
      if (di < 0) continue;
      let pending = false;
      for (const c of b.commands) if (c.team === this.team && c.slot === slot) { pending = true; break; }
      if (pending) continue;
      const card = me.deck[di];
      if (card.unsupported.length) continue;
      out.push({ slot, card, role: this.roleOf(card) });
    }
    return out;
  }

  // ---------------------------------------------------------------- threats

  private towerDps(t: Unit): number {
    const d = t.def;
    if (t.state === ST_DEAD || t.kingState !== KING_ACTIVE) return 0;
    const dmg = d.projectile ? d.projectile.damage : d.damage;
    return d.hitSpeed > 0 ? (dmg * 1000) / d.hitSpeed : 0;
  }

  private ourTarget(b: Battle, lane: number): Unit {
    const me = b.players[this.team];
    const p = me.princess[lane];
    return p.state !== ST_DEAD ? p : me.king;
  }

  /** Enemy groups that threaten our side, most urgent first. */
  private threats(b: Battle): Group[] {
    const me = b.players[this.team];
    const cand: Seen[] = [];
    for (const e of this.enemies) {
      const r = e.role;
      if (r.dps <= 0 && r.towerDps <= 0 && !(e.u.def.spawn)) continue;
      let threat = e.ly < 18500;
      if (!threat && r.building && r.range >= 7000) {
        // siege buildings that reach a tower from their side
        for (const t of [me.princess[0], me.princess[1], me.king]) {
          if (t.state === ST_DEAD) continue;
          const dx = t.x - e.x;
          const dy = t.y - e.y;
          const reach = r.range + t.radius + 1500;
          if (dx * dx + dy * dy <= reach * reach) { threat = true; break; }
        }
      }
      if (!threat && r.speed >= 90 && e.ly < 21000 && e.vy !== 0) threat = true;
      if (threat) cand.push(e);
    }
    if (cand.length === 0) return [];
    cand.sort((a, c) => a.lane - c.lane || a.ly - c.ly || a.u.id - c.u.id);
    const groups: Group[] = [];
    let cur: Seen[] = [];
    const flush = () => {
      if (cur.length) groups.push(this.makeGroup(b, cur));
      cur = [];
    };
    for (const e of cand) {
      if (cur.length && (cur[0].lane !== e.lane || e.ly - cur[cur.length - 1].ly > 4500)) flush();
      cur.push(e);
    }
    flush();
    groups.sort((a, c) => a.eta - c.eta || c.value - a.value || a.lead.u.id - c.lead.u.id);
    return groups;
  }

  private makeGroup(b: Battle, list: Seen[]): Group {
    const f = new Force();
    let value = 0;
    let air = true;
    let tob = false;
    for (const e of list) {
      f.add(e.role, e.hp, 1, e.value);
      value += e.value;
      air = air && e.role.air;
      tob = tob || e.role.buildingsOnly;
    }
    const lead = list[0];
    const target = this.ourTarget(b, lead.lane);
    const dx = target.x - lead.x;
    const dy = target.y - lead.y;
    const d = Math.sqrt(dx * dx + dy * dy) - target.radius - lead.role.range;
    const sp = lead.role.speed;
    const eta = d <= 0 ? 0 : sp > 0 ? d / sp / 20 : Infinity;
    return { lane: lead.lane, list, lead, f, value, eta, target, air, tob, open: true };
  }

  // ---------------------------------------------------------------- defence

  /**
   * Whether a ranged troop at local (x, y) is shielded by the tower the group walks to: the threat
   * (predicted at local (px, py)) reaches the tower first.
   */
  private shielded(g: Group, x: number, y: number, px: number, py: number): boolean {
    const t = g.target;
    const tx = t.x - px;
    const ty = this.ly(t.y) - py;
    const ux = x - px;
    const uy = y - py;
    const dt = Math.sqrt(tx * tx + ty * ty);
    return Math.sqrt(ux * ux + uy * uy) > dt + 500;
  }

  /** Friendly force near a group (units, pending plays); (px, py) the threat's predicted local position. */
  private friendlyForce(b: Battle, g: Group, px: number, py: number): void {
    const F = this.ours;
    F.clear();
    const lx = g.lead.x;
    const ly = g.lead.y;
    const R2 = 6500 * 6500;
    for (const f of this.friends) {
      const r = f.role;
      const dx = f.x - lx;
      const dy = f.y - ly;
      let near = dx * dx + dy * dy <= R2;
      if (!near && f.u.target) for (const e of g.list) if (e.u === f.u.target) { near = true; break; }
      if (near) F.add(r, f.hp, 1, f.value, r.building || r.range < 2500 || !this.shielded(g, f.lx, f.ly, px, py));
    }
    for (const c of b.commands) {
      if (c.team !== this.team) continue;
      const cr = this.roleOf(c.card);
      if (cr.type === 'spell') continue;
      const dx = c.x - lx;
      const dy = c.y - ly;
      if (dx * dx + dy * dy > 8000 * 8000) continue;
      const front = !this.shielded(g, c.x, this.ly(c.y), px, py);
      for (const m of cr.members) F.add(m.role, m.role.hp, m.count, m.value, m.role.building || m.role.range < 2500 || front);
    }
  }

  private towersCovering(b: Battle, x: number, y: number): number {
    const me = b.players[this.team];
    let dps = 0;
    for (const t of [me.princess[0], me.princess[1], me.king]) {
      if (t.state === ST_DEAD) continue;
      const dx = t.x - x;
      const dy = t.y - y;
      const r = t.def.range + 1000;
      if (dx * dx + dy * dy <= r * r) dps += this.towerDps(t);
    }
    return dps;
  }

  private towerValuePerHp(t: Unit): number {
    return (t.tower === 2 ? KING_VALUE : PRINCESS_VALUE) / Math.max(1, t.maxHp);
  }

  private score(f: Force, g: Group, towerFight: number, towerTarget: number, cost: number): number {
    const o = this.fo;
    fight(f, g.f, towerFight, towerTarget, g.eta, o);
    const t = g.target;
    const dmg = Math.min(o.towerDmg, t.hp);
    let loss = dmg * this.towerValuePerHp(t);
    if (o.towerDmg >= t.hp) loss += t.tower === 2 ? 100 : 6;
    // survivors are worth something: they counter-push (buildings only keep defending)
    return o.killed - loss + ((f.value - f.bValue) * 0.35 + f.bValue * 0.15) * o.surv - cost;
  }

  private defend(b: Battle, g: Group, hand: { slot: number; card: CardDef; role: CardRole }[], relax = false): Option | 'wait' | null {
    const lead = g.lead;
    const [px, py] = this.predictLead(g, 40);
    this.friendlyForce(b, g, px, py);
    const tBase = this.towersCovering(b, px, this.ly(py));
    const tTarget = Math.max(this.towerDps(g.target), tBase);
    const base = this.score(this.ours, g, tBase, tTarget, 0);
    g.open = base < -1 || this.fo.towerDmg > 250;
    const ctx: DefCtx = { px, py, tBase, tTarget, base };
    const imminent = lead.ly < 16500 || g.eta < 3;
    // elixir we would like to keep for what the opponent can send next
    let pressure = this.oppElixir * 0.5;
    for (const e of this.enemies) if (e.ly >= 18500 && e.role.speed > 0) pressure += e.value;
    const keep = Math.min(5, 0.4 * pressure);
    let best: Option | null = null;
    let bestWait = -Infinity;
    const rate = Math.max(1, b.elixirPerTick()) / 10000; // elixir per tick
    for (const h of hand) {
      const cr = h.role;
      if (cr.spell && cr.cost > this.avail) continue;
      const r = this.defenceScore(b, g, h.card, cr, ctx);
      if (!r) continue;
      let sc = r.sc - 0.25 * Math.max(0, keep - (this.avail - cr.cost)) + (cr.spell ? 0 : 0.5 * this.stale(b, h.slot));
      if (this.saving >= 0 && h.slot !== this.saving && base > -6) sc -= 2;
      if (this.trace) this.trace(`defend ${lead.u.def.name}: ${cr.name} sc=${sc.toFixed(2)} base=${base.toFixed(2)}`);
      if (!(sc > -Infinity)) continue; // also drops NaN
      const cost = cr.cost;
      if (cost > this.avail) {
        const wait = (cost - this.avail) / rate / 20; // seconds
        if (wait + 2 < g.eta && sc > bestWait) bestWait = sc;
        continue;
      }
      if (!imminent && !cr.ranged && !cr.building && !cr.spell) {
        // melee defenders wait until the threat is on our side
        if (sc > bestWait) bestWait = sc;
        continue;
      }
      if (best && sc <= best.score) continue;
      let pos = r.pos;
      if (!pos && r.lp) pos = this.place(b, h.card, r.lp[0] + this.jitter(), r.lp[1] + this.jitter(), cr.building ? 3000 : 4000);
      if (!pos) continue;
      best = { slot: h.slot, card: cr, score: sc, x: pos.x, y: pos.y, reason: `defend ${lead.u.def.name}` };
    }
    const minGain = relax ? -1.5 : base < -4 ? 0.2 : 0.6;
    if (!relax && bestWait > minGain && (!best || bestWait > best.score + 1.5)) return 'wait';
    if (best && best.score >= minGain) return best;
    if (g.open && base < -2 && this.p.tricks) return this.cyclePlay(b, g, hand, ctx);
    return null;
  }

  /** Estimated gain of playing `card` against group g, with its placement (world pos or local lp). */
  private defenceScore(b: Battle, g: Group, card: CardDef, cr: CardRole, ctx: DefCtx):
    { sc: number; pos: { x: number; y: number } | null; lp: [number, number] | null } | null {
    if (cr.spell) {
      if (cr.spell.kind !== 'damage' && cr.spell.kind !== 'roll' && cr.spell.kind !== 'freeze') return null;
      const sv = this.bestSpell(b, card, cr, g);
      if (!sv) return null;
      // what the spell leaves of the group fights what we already have
      const killed = this.spellOnGroup(b, cr, g, sv.x, sv.y, this.cand);
      const saved = g.f;
      g.f = this.cand;
      const after = this.score(this.ours, g, ctx.tBase, ctx.tTarget, 0);
      g.f = saved;
      return { sc: killed + after - ctx.base - cr.cost + (sv.value - killed) * 0.5, pos: { x: sv.x, y: sv.y }, lp: null };
    }
    if (cr.kamikaze) {
      if (cr.buildingsOnly) return null;
      return { sc: this.kamikazeValue(cr, g) - cr.cost, pos: null, lp: this.defencePlacement(cr, g) };
    }
    if (cr.collector) return null;
    const F = this.cand;
    F.copy(this.ours);
    const lp = this.defencePlacement(cr, g);
    const exposed = cr.buildingsOnly || !this.shielded(g, lp[0], lp[1], ctx.px, ctx.py);
    for (const m of cr.members) F.add(m.role, m.role.hp, m.count, m.value, m.role.building || m.role.range < 2500 || exposed);
    // the fight happens between the defender and the threat's predicted position
    const ex = cr.building ? lp[0] : (lp[0] + ctx.px) / 2;
    const ey = cr.building ? lp[1] : (lp[1] + ctx.py) / 2;
    const tFight = this.towersCovering(b, ex, this.ly(ey));
    let sc = this.score(F, g, tFight, Math.max(ctx.tTarget, tFight), cr.cost) - ctx.base - cr.gift * 0.6;
    if (cr.buildingsOnly && !cr.building) sc -= g.tob ? 99 : 1;
    return { sc, pos: null, lp };
  }

  /**
   * Nothing in hand answers an open threat but the next card does: play the cheapest card (at the
   * threat, for what little it does) to draw the answer. The next card is visible to a player.
   */
  private cyclePlay(b: Battle, g: Group, hand: { slot: number; card: CardDef; role: CardRole }[], ctx: DefCtx): Option | null {
    const me = b.players[this.team];
    if (me.queue.length === 0) return null;
    const next = me.deck[me.queue[0]];
    const nr = this.roleOf(next);
    const r = this.defenceScore(b, g, next, nr, ctx);
    if (!r || !(r.sc >= 2)) return null;
    let pick: { slot: number; card: CardDef; role: CardRole } | null = null;
    for (const h of hand) {
      if (h.role.cost + nr.cost > this.avail + 1) continue;
      if (h.role.collector) continue;
      if (!pick || h.role.cost < pick.role.cost || (h.role.cost === pick.role.cost && h.slot < pick.slot)) pick = h;
    }
    if (!pick) return null;
    const cr = pick.role;
    let pos: { x: number; y: number } | null = null;
    if (cr.spell) {
      if (cr.spell.kind === 'damage' || cr.spell.kind === 'roll' || cr.spell.kind === 'freeze') {
        const sv = this.bestSpell(b, pick.card, cr, g);
        if (sv) pos = { x: sv.x, y: sv.y };
      }
      if (!pos) {
        const t = this.enemyTarget(b, g.lane);
        if (b.deployPlace(this.team, pick.card, t.x, t.y)) pos = { x: t.x, y: t.y };
      }
    } else {
      const lp = cr.building || cr.buildingsOnly ? this.defencePlacement(cr, g) : this.defencePlacement(cr, g);
      pos = this.place(b, pick.card, lp[0], lp[1], 4000);
    }
    if (!pos) return null;
    return { slot: pick.slot, card: cr, score: 0, x: pos.x, y: pos.y, reason: `cycle to ${next.name}` };
  }

  /** Predicted local position of a group's lead after T ticks, not past the tower it walks to. */
  private predictLead(g: Group, T: number): [number, number] {
    const lead = g.lead;
    const tly = this.ly(g.target.y);
    const px = lead.lx + lead.vx * T;
    let py = lead.ly + (this.team === 0 ? lead.vy : -lead.vy) * T;
    if (py < tly + 1500) py = Math.max(lead.ly < tly + 1500 ? lead.ly : tly + 1500, py);
    return [px, py];
  }

  private kamikazeValue(cr: CardRole, g: Group): number {
    const m = cr.members[0];
    if (!m) return 0;
    const r = m.role;
    const R = Math.max(r.splash, 600);
    let best = 0;
    for (const c of g.list) {
      let v = 0;
      for (const e of g.list) {
        if (e.role.air ? !r.hitsAir : !r.hitsGround) continue;
        const dx = e.x - c.x;
        const dy = e.y - c.y;
        if (dx * dx + dy * dy > R * R) continue;
        const dmg = r.hit * m.count;
        v += dmg >= e.hp ? e.value : (e.value * dmg) / Math.max(1, e.u.maxHp) * 0.8;
      }
      if (v > best) best = v;
    }
    return best;
  }

  /**
   * The group after a spell at world (x, y): survivors (with the spell's damage taken off) go into
   * `out`; returns the elixir value the spell destroys outright (kills, prorated damage).
   */
  private spellOnGroup(b: Battle, cr: CardRole, g: Group, x: number, y: number, out: Force): number {
    const s = cr.spell!;
    const T = this.impactTicks(b, s, x, y);
    const fwd = this.team === 0 ? 1 : -1;
    out.clear();
    let killed = 0;
    const hits: Seen[] = [];
    for (const e of g.list) {
      let hit = !(e.role.air ? !s.hitsAir : !s.hitsGround) && !e.u.tunneling;
      if (hit) {
        const [px, py] = this.predict(e, T);
        const dx = px - x;
        const dy = py - y;
        if (s.kind === 'roll') hit = dy * fwd >= -800 && dy * fwd <= s.rollRange && Math.abs(dx) <= s.rollWidth + e.u.radius * 0.5;
        else { const R = s.radius + e.u.radius * 0.5; hit = dx * dx + dy * dy <= R * R; }
      }
      if (hit) hits.push(e);
      else out.add(e.role, e.hp, 1, e.value);
    }
    if (s.strikes > 0) hits.sort((a, c) => c.hp - a.hp || a.u.id - c.u.id);
    for (let i = 0; i < hits.length; i++) {
      const e = hits[i];
      if (s.strikes > 0 && i >= s.strikes) { out.add(e.role, e.hp, 1, e.value); continue; }
      let dmg = s.damage;
      if (s.dot && (e.vx !== 0 || e.vy !== 0)) dmg *= 0.7;
      if (dmg >= e.hp) { killed += e.value; continue; }
      const frac = (e.hp - dmg) / e.hp;
      killed += e.value * (1 - frac) * 0.5;
      out.add(e.role, e.hp - dmg, 1, e.value * frac);
    }
    return killed;
  }

  /** Local placement for a defender against group g. */
  private defencePlacement(cr: CardRole, g: Group): [number, number] {
    const tgt = g.target;
    const tly = this.ly(tgt.y);
    const [px, py] = this.predictLead(g, 20 + cr.deployTicks);
    // unit direction from the threat to its target tower
    let dx = tgt.x - px;
    let dy = tly - py;
    let d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1) { dx = 0; dy = -1; d = 1; } else { dx /= d; dy /= d; }
    const laneSign = g.lane === 0 ? -1 : 1;
    if (cr.building) {
      // the centre pull, three to four tiles from the river
      return [9000 + laneSign * 500, 10000];
    }
    if (cr.kamikaze) return [px + dx * 2500, py + dy * 2500];
    // a building-targeting troop only soaks fire: in the threat's path
    if (cr.buildingsOnly) return [px + dx * 1500 - laneSign * 800, py + dy * 1500];
    if (cr.ranged) {
      // behind the tower the threat walks to, within reach of a troop attacking it: the tower tanks
      const back = Math.max(1200, Math.min(3000, cr.range - 2200));
      return [tgt.x + dx * back - laneSign * 600, tly + dy * back];
    }
    if (cr.swarm || g.tob) return [px + dx * 800, py + dy * 800]; // on top of the threat
    if (cr.splashy && g.list.length >= 3) {
      let sx = 0, sy = 0;
      for (const e of g.list) { sx += e.lx; sy += e.ly; }
      return [sx / g.list.length + dx * 1000, sy / g.list.length + dy * 1000];
    }
    // melee: in front of the threat, pulled toward the centre so both towers shoot
    return [px + dx * 2000 - laneSign * 1200, py + dy * 2000];
  }

  // ---------------------------------------------------------------- spells

  private predict(e: Seen, T: number): [number, number] {
    let mx = e.vx * T;
    let my = e.vy * T;
    const m2 = mx * mx + my * my;
    if (m2 > 3000 * 3000) {
      const k = 3000 / Math.sqrt(m2);
      mx *= k;
      my *= k;
    }
    return [e.x + mx, e.y + my];
  }

  private impactTicks(b: Battle, s: SpellRole, x: number, y: number): number {
    if (s.kind === 'roll') return 30;
    if (s.speed <= 0) return 22;
    const k = b.players[this.team].king;
    const dx = x - k.x;
    const dy = y - k.y;
    return 20 + Math.sqrt(dx * dx + dy * dy) / s.speed;
  }

  /** Elixir value of a spell cast at world (x, y). */
  private spellValue(b: Battle, cr: CardRole, x: number, y: number): number {
    const s = cr.spell!;
    const T = this.impactTicks(b, s, x, y);
    const fwd = this.team === 0 ? 1 : -1;
    let v = 0;
    let engaged = 0;
    const strikes: { hp: number; value: number; tower: Unit | null; vph: number }[] | null = s.strikes > 0 ? [] : null;
    for (const e of this.enemies) {
      const air = e.role.air;
      if (air ? !s.hitsAir : !s.hitsGround) continue;
      if (e.u.tunneling) continue;
      const [px, py] = this.predict(e, T);
      const dx = px - x;
      const dy = py - y;
      if (s.kind === 'roll') {
        const along = dy * fwd;
        if (along < -800 || along > s.rollRange) continue;
        if (Math.abs(dx) > s.rollWidth + e.u.radius * 0.5) continue;
      } else {
        const R = s.radius + e.u.radius * 0.5;
        if (dx * dx + dy * dy > R * R) continue;
      }
      if (strikes) { strikes.push({ hp: e.hp, value: e.value, tower: null, vph: 0 }); continue; }
      let dmg = s.damage;
      if (s.dot && (e.vx !== 0 || e.vy !== 0)) dmg *= 0.7;
      v += dmg >= e.hp ? e.value : ((e.value * dmg) / Math.max(1, e.u.maxHp)) * 0.8;
      if (s.stun > 0 && e.role.dps > 0 && e.u.locked) engaged += e.value; // only what is busy hitting something
    }
    const opp = b.players[1 - this.team];
    for (const t of [opp.princess[0], opp.princess[1], opp.king]) {
      if (t.state === ST_DEAD) continue;
      const dx = t.x - x;
      const dy = t.y - y;
      let hit: boolean;
      if (s.kind === 'roll') hit = dy * fwd >= -800 && dy * fwd <= s.rollRange + t.radius && Math.abs(dx) <= s.rollWidth + t.radius;
      else { const R = s.radius + t.radius; hit = dx * dx + dy * dy <= R * R; }
      if (!hit) continue;
      const vph = this.towerValuePerHp(t);
      if (strikes) { strikes.push({ hp: t.hp, value: 0, tower: t, vph }); continue; }
      v += this.towerHitValue(t, s.towerDamage, vph);
    }
    if (strikes) {
      strikes.sort((a, c) => c.hp - a.hp);
      for (let i = 0; i < strikes.length && i < s.strikes; i++) {
        const st = strikes[i];
        if (st.tower) v += this.towerHitValue(st.tower, s.towerDamage, st.vph);
        else v += s.damage >= st.hp ? st.value : ((st.value * s.damage) / Math.max(1, st.hp)) * 0.8;
      }
    }
    if (s.kind === 'freeze') {
      // a freeze pays off when our troops get free hits (on frozen troops or a tower) during it
      let ours = 0;
      for (const f of this.friends) {
        if (!f.u.locked || f.role.dps <= 0) continue;
        const dx = f.x - x;
        const dy = f.y - y;
        const R = s.radius + 3000;
        if (dx * dx + dy * dy <= R * R) ours += f.value;
      }
      v += Math.min(engaged, ours + 2) * 0.35 + Math.min(ours, 8) * 0.15;
    } else if (s.stun > 0) v += engaged * 0.1;
    return v;
  }

  private towerHitValue(t: Unit, dmg: number, vph: number): number {
    if (dmg <= 0) return 0;
    if (dmg >= t.hp) return t.tower === 2 ? 1000 : t.hp * vph + 10;
    let v = dmg * vph;
    if (t.tower === 2 && t.kingState !== KING_ACTIVE) v -= 2.5; // waking the King
    return v;
  }

  /** Best cast point for a damage spell, optionally restricted to a threat group. */
  private bestSpell(b: Battle, card: CardDef, cr: CardRole, g: Group | null): { x: number; y: number; value: number } | null {
    const s = cr.spell!;
    const pts: number[] = [];
    const src = g ? g.list : this.enemies;
    const fwd = this.team === 0 ? 1 : -1;
    for (const e of src) {
      if (e.role.air ? !s.hitsAir : !s.hitsGround) continue;
      if (e.u.tunneling) continue;
      const T = this.impactTicks(b, s, e.x, e.y);
      const [px, py] = this.predict(e, T);
      if (s.kind === 'roll') {
        pts.push(px, py - fwd * 1500);
        continue;
      }
      pts.push(px, py);
      // centroid of what the radius around this unit catches
      let sx = 0, sy = 0, n = 0;
      const R = s.radius;
      for (const o of this.enemies) {
        const [ox, oy] = this.predict(o, T);
        const dx = ox - px;
        const dy = oy - py;
        if (dx * dx + dy * dy <= R * R) { sx += ox; sy += oy; n++; }
      }
      if (n > 1) pts.push(sx / n, sy / n);
    }
    if (!g && s.kind !== 'roll') {
      const opp = b.players[1 - this.team];
      for (const t of [opp.princess[0], opp.princess[1], opp.king]) if (t.state !== ST_DEAD) pts.push(t.x, t.y + fwd * -Math.min(s.radius * 0.6, 1200));
    }
    let bestV = 0;
    let bx = 0;
    let by = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const v = this.spellValue(b, cr, pts[i], pts[i + 1]);
      if (v > bestV) { bestV = v; bx = pts[i]; by = pts[i + 1]; }
    }
    if (bestV <= 0) return null;
    const x = Math.round(Math.max(0, Math.min(17999, bx)));
    const y = Math.round(Math.max(0, Math.min(31999, by)));
    const pos = b.deployPlace(this.team, card, x, y);
    if (!pos) return null;
    const v = this.spellValue(b, cr, pos.x, pos.y);
    if (v <= 0) return null;
    return { x, y, value: Math.min(v, bestV) };
  }

  private spellPlay(b: Battle, hand: { slot: number; card: CardDef; role: CardRole }[], underThreat: boolean): Option | null {
    const late = b.tick >= b.regulationTicks - 600;
    const me = b.players[this.team];
    const opp = b.players[1 - this.team];
    const tied = me.crowns === opp.crowns;
    const chip = late && me.crowns <= opp.crowns;
    let best: Option | null = null;
    for (const h of hand) {
      const cr = h.role;
      const s = cr.spell;
      if (!s || cr.cost > this.avail) continue;
      if (s.kind === 'damage' || s.kind === 'roll' || s.kind === 'freeze') {
        const r = this.bestSpell(b, h.card, cr, null);
        if (!r) continue;
        let need = cr.cost * this.p.spellK + (this.saving >= 0 ? 2 : 0);
        if (chip) need = cr.cost * (tied && b.tick >= b.regulationTicks + b.overtimeTicks - 400 ? 0.2 : 0.6);
        if (underThreat) need += 0.5;
        if (r.value < need) continue;
        const sc = r.value - cr.cost;
        if (!best || sc > best.score) best = { slot: h.slot, card: cr, score: sc, x: r.x, y: r.y, reason: 'spell value' };
      } else if (s.kind === 'rage') {
        const r = this.ragePlay(b, h.card, cr);
        if (r && (!best || r.score > best.score)) best = { ...r, slot: h.slot };
      }
    }
    return best;
  }

  private ragePlay(b: Battle, card: CardDef, cr: CardRole): Option | null {
    const s = cr.spell!;
    let bestV = 0;
    let bx = 0;
    let by = 0;
    for (const f of this.friends) {
      if (!f.u.locked || f.role.dps <= 0) continue;
      let v = 0;
      for (const o of this.friends) {
        if (!o.u.locked || !o.u.target) continue;
        const dx = o.x - f.x;
        const dy = o.y - f.y;
        if (dx * dx + dy * dy <= s.radius * s.radius) v += o.value * 0.3 + (o.u.target.tower !== TOWER_NONE ? o.role.towerDps * 0.01 : 0);
      }
      if (v > bestV) { bestV = v; bx = f.x; by = f.y; }
    }
    if (bestV < cr.cost * 2) return null;
    const pos = b.deployPlace(this.team, card, Math.round(bx), Math.round(by));
    if (!pos) return null;
    return { slot: -1, card: cr, score: bestV - cr.cost, x: Math.round(bx), y: Math.round(by), reason: 'rage the push' };
  }

  // ---------------------------------------------------------------- offence

  private enemyTarget(b: Battle, lane: number): Unit {
    const opp = b.players[1 - this.team];
    const p = opp.princess[lane];
    return p.state !== ST_DEAD ? p : opp.king;
  }

  private laneScore(b: Battle, lane: number): number {
    const opp = b.players[1 - this.team];
    const t = this.enemyTarget(b, lane);
    let s = (1 - t.hp / Math.max(1, t.maxHp)) * 3;
    if (opp.princess[lane].state === ST_DEAD) s += 1.2;
    for (const e of this.enemies) {
      if (e.ly < 17000) continue;
      if (e.lane === lane) s -= e.value * 0.25;
      else s += e.value * 0.12;
    }
    for (const f of this.friends) if (f.lane === lane && f.ly > 9000 && !f.role.building) s += f.value * 0.15;
    return s;
  }

  private pickLane(b: Battle): number {
    const a = this.laneScore(b, 0);
    const c = this.laneScore(b, 1);
    if (Math.abs(a - c) < 0.3) return this.rand(2);
    return a > c ? 0 : 1;
  }

  /** Local "bridge" placement for a lane (the pocket when that princess tower is down). */
  private bridge(b: Battle, lane: number): [number, number] {
    const opp = b.players[1 - this.team];
    if (opp.princess[lane].state === ST_DEAD) return [LANE_X[lane], 19500];
    return [LANE_X[lane], 14500];
  }

  /** Bonus for a card held a long time: a card that never gets played shrinks the hand to three. */
  private stale(b: Battle, slot: number): number {
    const secs = (b.tick - this.handSince[slot]) / 20;
    return secs <= 12 ? 0 : Math.min(4, (secs - 12) * 0.25);
  }

  /** The most advanced friendly troop in a lane past our back (the head of a push), or null. */
  private pushHead(lane: number): Seen | null {
    let head: Seen | null = null;
    for (const f of this.friends) {
      if (f.lane !== lane || f.role.building || f.ly < 8000 || f.role.speed <= 0) continue;
      if (!head || f.ly > head.ly) head = f;
    }
    return head;
  }

  /** Candidate local placements (x, y, bonus) for an offensive play of `cr` in `lane`. */
  private pushPlacements(b: Battle, cr: CardRole, lane: number, out: number[], stale = 0): void {
    const t = this.enemyTarget(b, lane);
    const tly = this.ly(t.y);
    if (cr.spell) { out.push(t.x, tly - 1200, 3); return; } // spawning spell onto the tower
    if (cr.enemySide) { out.push(t.x + (t.x < 9000 ? 600 : -600), tly - 1800, 3); return; }
    if (cr.siege) { out.push(LANE_X[lane], 13500, 3); return; }
    const br = this.bridge(b, lane);
    out.push(br[0], br[1], 0);
    const head = this.pushHead(lane);
    if (head) {
      const front = cr.tank || cr.buildingsOnly;
      const ly = front ? head.ly + 1000 : head.ly - (cr.ranged ? 2800 : 1500);
      out.push(head.lx, Math.min(ly, br[1]), 1);
    }
    if (cr.tank && cr.speed <= 60 && (this.avail >= 8 || (stale >= 1 && this.avail >= cr.cost + 1))) out.push(lane === 0 ? 4500 : 13500, 1500, 2);
  }

  /**
   * Value of our push in a lane (existing troops there plus an optional card played at local
   * (lx, ly)): the fight model with the enemy's defenders near that lane, their crown tower and a
   * virtual defender for the elixir they will have when the push arrives.
   */
  private pushScore(b: Battle, lane: number, cr: CardRole | null, lx: number, lly: number): number {
    const att = this.att;
    const def = this.def;
    att.clear();
    def.clear();
    let front = -1;
    let speed = 0;
    for (const f of this.friends) {
      if (f.lane !== lane || f.role.building || f.ly < 8000) continue;
      att.add(f.role, f.hp, 1, f.value);
      if (f.ly > front) front = f.ly;
      if (f.role.speed > 0) speed = speed === 0 ? f.role.speed : Math.min(speed, f.role.speed);
    }
    if (cr) {
      for (const m of cr.members) att.add(m.role, m.role.hp, m.count, m.value);
      if (cr.spell && cr.spell.kind === 'spawn') {
        // the spawned troops (the card's member list is empty)
        att.hpG += cr.hp; att.nG += cr.count; att.dG += cr.dpsG; att.rG += cr.count; att.tw += cr.towerDps; att.front += cr.hp;
        att.value += cr.cost;
      }
      if (lly > front) front = lly;
      if (cr.speed > 0) speed = speed === 0 ? cr.speed : Math.min(speed, cr.speed);
    }
    if (att.hpG + att.hpA + att.hpB <= 0 || front < 0) return 0;
    const t = this.enemyTarget(b, lane);
    const tly = this.ly(t.y);
    for (const e of this.enemies) {
      let near = false;
      if (e.ly >= 15000) {
        const dx = e.x - t.x;
        const dy = e.y - t.y;
        near = e.lane === lane || dx * dx + dy * dy <= 8000 * 8000;
      }
      if (!near && e.lane === lane) {
        // enemy troops on our side already fighting the units of this push
        for (const f of this.friends) {
          if (f.lane !== lane || f.role.building || f.ly < 8000) continue;
          const dx = e.x - f.x;
          const dy = e.y - f.y;
          if (dx * dx + dy * dy <= 5000 * 5000) { near = true; break; }
        }
      }
      if (near) def.add(e.role, e.hp, 1, e.value);
    }
    const dist = Math.max(0, tly - front - t.radius - 1000);
    const eta = speed > 0 ? dist / speed / 20 : 0;
    const elPerSec = (b.elixirPerTick() * 20) / 10000;
    const v = 0.6 * Math.min(10, this.oppElixir + eta * elPerSec);
    if (v > 0) {
      def.add(VIRTUAL_DEFENDER, VIRTUAL_DEFENDER.hp, v * 0.5, 1);
      def.add(VIRTUAL_SPLASH, VIRTUAL_SPLASH.hp, v * 0.5, 1);
    }
    const opp = b.players[1 - this.team];
    let tDps = this.towerDpsAny(t);
    if (t.tower !== 2 && opp.king.state !== ST_DEAD && opp.king.kingState === KING_ACTIVE) tDps += this.towerDps(opp.king) * 0.3;
    const o = this.fo;
    fight(def, att, tDps, tDps, Math.min(eta, 2.5), o, 12);
    let sc = Math.min(o.towerDmg, t.hp) * this.towerValuePerHp(t);
    if (o.towerDmg >= t.hp) sc += t.tower === 2 ? 50 : 8;
    sc += def.value * (1 - o.surv) * 0.8;
    sc -= o.killed;
    return sc;
  }

  /** A crown tower's dps, counting an inactive King tower as active (it wakes when hit). */
  private towerDpsAny(t: Unit): number {
    if (t.state === ST_DEAD) return 0;
    const d = t.def;
    const dmg = d.projectile ? d.projectile.damage : d.damage;
    return d.hitSpeed > 0 ? (dmg * 1000) / d.hitSpeed : 0;
  }

  private offence(b: Battle, hand: { slot: number; card: CardDef; role: CardRole }[], groups: Group[]): Option | null {
    const me = b.players[this.team];
    const opp = b.players[1 - this.team];
    const avail = this.avail;
    const oppEl = this.oppElixir;
    const double = b.elixirPerTick() > 200;
    const late = b.tick >= b.regulationTicks - 600;
    const ahead = me.crowns > opp.crowns && late;
    // behind (or level) with little time left, or in sudden-death overtime: press
    const behind = (late && me.crowns < opp.crowns) || (b.tick >= b.regulationTicks && me.crowns === opp.crowns) ||
      (b.tick >= b.regulationTicks - 400 && me.crowns <= opp.crowns);
    const leaking = avail >= this.p.leak && !b.infiniteElixir;
    for (const g of groups) if (g.open && !leaking) return null; // a threat is not handled yet
    // elixir kept back for defence: what the opponent has walking at us plus part of their bar
    let incoming = 0;
    for (const e of this.enemies) if (e.ly >= 18500 && e.role.speed > 0) incoming += e.value;
    let reserve = Math.max(1, Math.min(5, 0.5 * incoming + 0.35 * oppEl));
    if (ahead) reserve += 2;
    if (behind) reserve *= 0.5;
    const fullish = avail >= (double ? 7 : 8.5);
    if (fullish) reserve *= 0.5;
    if (leaking) reserve = 0;
    const punish = (oppEl <= 2.5 && incoming <= 2) || avail - oppEl >= 4;

    // push options: every card x lane x placement, scored by the fight model run the other way
    const base = [this.pushScore(b, 0, null, 0, 0), this.pushScore(b, 1, null, 0, 0)];
    const laneBias = [0, 0];
    {
      const a0 = this.laneScore(b, 0);
      const a1 = this.laneScore(b, 1);
      laneBias[0] = (a0 - a1) * 0.15;
      laneBias[1] = -laneBias[0];
    }
    let best: Option | null = null;
    const pts: number[] = [];
    for (const h of hand) {
      const cr = h.role;
      if (this.saving >= 0 && h.slot !== this.saving && !leaking) continue;
      if (cr.spell && cr.spell.kind !== 'spawn') continue; // damage spells: spellPlay
      if (cr.collector || (cr.building && !cr.siege)) continue;
      if (avail - cr.cost < reserve) continue;
      for (let lane = 0; lane < 2; lane++) {
        pts.length = 0;
        this.pushPlacements(b, cr, lane, pts, this.stale(b, h.slot));
        for (let i = 0; i < pts.length; i += 3) {
          const lx = pts[i];
          const lly = pts[i + 1];
          const tag = pts[i + 2];
          let gain = this.pushScore(b, lane, cr, lx, lly) - base[lane] - cr.gift * 0.7;
          // a swarm push invites a cheap spell or splash answer the model does not see
          if (cr.swarm && gain > 0) gain *= 0.4;
          const sc = gain + laneBias[lane] + (tag === 2 ? 1.2 : tag === 1 ? 0.3 : 0) + this.stale(b, h.slot);
          if (!(sc > -Infinity) || (best && sc <= best.score)) continue;
          let x: number;
          let y: number;
          if (cr.spell) {
            x = Math.round(lx);
            y = Math.round(this.ly(lly));
            if (!b.deployPlace(this.team, h.card, x, y)) continue;
          } else {
            const p = this.place(b, h.card, lx + this.jitter() * 0.5, lly, 4000);
            if (!p) continue;
            x = p.x;
            y = p.y;
          }
          const why = cr.spell ? 'spawn on the tower' : cr.enemySide ? 'tower drop' : cr.siege ? 'siege'
            : tag === 2 ? 'tank in the back' : tag === 1 ? 'support the push' : 'bridge push';
          best = { slot: h.slot, card: cr, score: sc, x, y, reason: `${why} (${lane === 0 ? 'left' : 'right'})` };
        }
      }
    }
    const opening = b.tick < 240 && oppEl > 2;
    const need = leaking ? -Infinity : ahead || opening ? 6 : behind ? 0 : fullish ? 0.3 : punish ? 0.8 : 1.5;
    if (best && best.score >= need) return best;

    // nothing worth a push: something sensible rather than leak, and unclog cards held too long
    const lane = this.pickLane(b);
    const open = groups.some((g) => g.open);
    let pick: Option | null = null;
    for (const h of hand) {
      const cr = h.role;
      if (avail < cr.cost) continue;
      const st = this.stale(b, h.slot);
      const unclog = st >= 2 && !open && incoming <= 3 && avail - cr.cost >= Math.max(1, reserve);
      const collector = cr.collector && fullish && groups.length === 0 && this.enemies.every((e) => e.ly > 17000);
      if (!leaking && !unclog && !collector) continue;
      const n = this.naturalPlay(b, h, lane);
      if (!n) continue;
      if (cr.spell && !leaking && n.score + cr.cost < cr.cost * 0.4) continue;
      const sc = n.score + st;
      if (!pick || sc > pick.score) {
        pick = { ...n, score: sc, reason: leaking ? `${n.reason} (leaking)` : collector ? n.reason : `${n.reason} (unclog)` };
      }
    }
    return pick;
  }

  /** Where a card goes when played proactively (no threat to answer, no push worth it). */
  private naturalPlay(b: Battle, h: { slot: number; card: CardDef; role: CardRole }, lane: number): Option | null {
    const cr = h.role;
    if (cr.spell) {
      const s = cr.spell;
      if (s.kind !== 'damage' && s.kind !== 'roll' && s.kind !== 'freeze') return null;
      const r = this.bestSpell(b, h.card, cr, null);
      if (!r) return null;
      return { slot: h.slot, card: cr, score: r.value - cr.cost, x: r.x, y: r.y, reason: 'spell' };
    }
    let lp: [number, number];
    let why: string;
    let sc = cr.hp / 1000 + (cr.dpsG + cr.dpsA) / 120 + (cr.tank ? 2 : 0) - cr.cost * 0.2 - cr.gift;
    if (cr.collector) { lp = [lane === 0 ? 2500 : 15500, 3000]; why = 'collector'; sc = 3; }
    else if (cr.siege) { lp = [LANE_X[lane], 13500]; why = 'siege'; }
    else if (cr.building) { lp = [9000 + (lane === 0 ? -500 : 500), 10000]; why = 'pre-place building'; sc = 0.2; }
    else if (cr.enemySide) {
      const t = this.enemyTarget(b, lane);
      lp = [t.x + (t.x < 9000 ? 600 : -600), this.ly(t.y) - 1800];
      why = 'tower drop';
    } else if (cr.tank && cr.speed <= 60) { lp = [lane === 0 ? 4500 : 13500, 1500]; why = 'tank in the back'; }
    else if (cr.win || cr.tank) { lp = this.bridge(b, lane); why = 'bridge push'; }
    else if (cr.ranged || cr.swarm || cr.air) { lp = [LANE_X[lane] + (lane === 0 ? 1500 : -1500), 3500]; why = 'support from the back'; }
    else { lp = this.bridge(b, lane); why = 'bridge push'; }
    const p = this.place(b, h.card, lp[0] + this.jitter() * 0.5, lp[1], 4000);
    if (!p) return null;
    return { slot: h.slot, card: cr, score: sc, x: p.x, y: p.y, reason: why };
  }
}
