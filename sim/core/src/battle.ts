// The deterministic battle engine: one fixed 50 ms tick, integer game units,
// seeded RNG, stable (id-ordered) iteration. Headless and browser share this code.
//
// Per-tick order follows the native world loop (docs/MECHANICS_BRIEF.md §8):
//   1. command manager: commit commands aged >= 20 ticks (debit elixir, spawn)
//   2. elixir regeneration (after commits: native debit observations)
//   3. world tick: attack updates for every actor, then actor/movement updates,
//      projectile updates, then the damage flush (damage applied end of tick)
//   4. end check
//   5. frame counter increments
// Each function below says where its behaviour comes from; see docs/FIDELITY.md.

import { Arena, ARENA_H, ARENA_W, CELL, GRID_W } from './arena.ts';
import {
  type AreaEffectDef, type BuffDef, Defs, ELIXIR_ONE, type CardDef, type FilterDef, type GameData, type ProjectileDef, TICK_MS,
  type Timeline, type UnitDef,
} from './data.ts';
import {
  AreaEffect, type BattleEvent, BuffInst, type Command, KING_ACTIVATING, KING_ACTIVE, KING_INACTIVE, Projectile, ST_ACTIVE, ST_DEAD,
  ST_DEPLOYING, TOWER_KING, TOWER_NONE, TOWER_PRINCESS, Unit,
} from './entities.ts';
import { clamp, Hasher, idiv, isqrt, Rng } from './math.ts';
import { cos1e6, sin1e6 } from './trig.ts';

export interface BattleConfig {
  seed?: number;
  /** Two decks of 8 card names. */
  decks: [string[], string[]];
  /** Card level for each side (default 11 = tournament standard). */
  level?: number | [number, number];
  /** King/tower level for each side (default 11). */
  towerLevel?: number | [number, number];
  timeline?: string;
  /** Record visual events (viewer). Off for headless speed. */
  recordEvents?: boolean;
  /** Deal decks in order instead of shuffling (tests). */
  noShuffle?: boolean;
  /**
   * Synthetic fixture mode (differential tests against native fixtures): no towers, every
   * point walkable, positions clamped to [0,width-1] x [0,height-1], no end checks.
   */
  fixture?: { width: number; height: number };
}

export interface Player {
  team: number;
  elixir: number; // x10000
  /** Elixir committed by queued commands not yet debited (client-side check). */
  pending: number;
  crowns: number;
  deck: CardDef[];
  hand: number[]; // 4 deck indices
  queue: number[]; // remaining deck indices in cycle order (queue[0] = next card)
  /** Tick from which each hand slot may be played (NextSpellCooldown). */
  slotReady: number[];
  king: Unit;
  princess: [Unit, Unit]; // [left (x<9000), right]
}

export interface BattleResult {
  winner: number; // 0, 1, or -1 for a draw
  reason: 'king' | 'time' | 'overtime' | 'tiebreak';
  tick: number;
}

export type PlayError =
  | 'ended' | 'bad-slot' | 'slot-cooldown' | 'elixir' | 'position' | 'unsupported';

/** Native command delay: commands commit when aged >= 20 ticks [OBS+STAT]. */
export const COMMAND_DELAY_TICKS = 20;

const MAX_ELIXIR_DEFAULT = 10;
/** Collision push constants fitted to the native trace (see separate()). */
const PUSH_CAP = 90;
const PUSH_SPEED = 150;

export class Battle {
  readonly data: GameData;
  readonly defs: Defs;
  readonly arena: Arena;
  readonly rng: Rng;
  readonly timeline: Timeline;
  readonly levels: [number, number];
  readonly towerLevels: [number, number];
  readonly recordEvents: boolean;
  readonly maxElixir: number;
  readonly regulationTicks: number;
  readonly overtimeTicks: number;
  readonly keepTargetExt: number;
  readonly extraSightCrownTowers: number;
  readonly fixture: boolean;
  readonly boundW: number;
  readonly boundH: number;

  tick = 0;
  units: Unit[] = [];
  projectiles: Projectile[] = [];
  areaEffects: AreaEffect[] = [];
  players: [Player, Player];
  commands: Command[] = [];
  result: BattleResult | null = null;
  events: BattleEvent[] = [];
  /** Infinite elixir for the sandbox (does not affect replays: part of state). */
  infiniteElixir = false;

  private nextId = 5000000;
  private nextProjId = 4000000;
  private nextAeoId = 3000000;
  private newUnits: Unit[] = [];
  private spellWaves: { tick: number; team: number; card: CardDef; x: number; y: number }[] = [];
  // Damage queue (parallel arrays, reused)
  private dmgTarget: Unit[] = [];
  private dmgAmount: number[] = [];
  private dmgTower: number[] = [];
  private dmgPct: number[] = [];
  private dmgN = 0;
  private scratch: Unit[] = [];

  constructor(data: GameData, cfg: BattleConfig) {
    this.data = data;
    this.defs = new Defs(data);
    this.arena = new Arena(data);
    this.rng = new Rng(cfg.seed ?? 1);
    this.timeline = data.timelines[cfg.timeline ?? 'Default'];
    const lv = cfg.level ?? 11;
    this.levels = Array.isArray(lv) ? [lv[0], lv[1]] : [lv, lv];
    const tl = cfg.towerLevel ?? 11;
    this.towerLevels = Array.isArray(tl) ? [tl[0], tl[1]] : [tl, tl];
    this.recordEvents = cfg.recordEvents ?? false;
    const G = data.globals;
    this.maxElixir = (typeof G.MAX_MANA === 'number' ? G.MAX_MANA : MAX_ELIXIR_DEFAULT) * ELIXIR_ONE;
    const secs = this.timeline.sections;
    this.regulationTicks = (secs[0]?.lengthSec ?? 180) * 1000 / TICK_MS;
    this.overtimeTicks = (secs[1]?.lengthSec ?? 0) * 1000 / TICK_MS;
    this.keepTargetExt = typeof G.LOGIC_RANGE_EXTENSION_TO_KEEP_TARGET === 'number' ? G.LOGIC_RANGE_EXTENSION_TO_KEEP_TARGET : 25;
    this.extraSightCrownTowers = typeof G.EXTRA_SIGHT_RANGE_TO_CROWN_TOWERS === 'number' ? G.EXTRA_SIGHT_RANGE_TO_CROWN_TOWERS : 0;

    const mk = (team: number): Player => {
      const deckNames = cfg.decks[team];
      if (deckNames.length !== 8) throw new Error(`deck ${team} must have 8 cards`);
      const deck = deckNames.map((n) => this.defs.card(n, this.levels[team]));
      const order = [0, 1, 2, 3, 4, 5, 6, 7];
      if (!cfg.noShuffle) {
        for (let i = 7; i > 0; i--) {
          const j = this.rng.int(i + 1);
          const t = order[i]; order[i] = order[j]; order[j] = t;
        }
      }
      return {
        team,
        elixir: this.timeline.startingElixir * ELIXIR_ONE,
        pending: 0,
        crowns: 0,
        deck,
        hand: order.slice(0, 4),
        queue: order.slice(4),
        slotReady: [0, 0, 0, 0],
        king: null as unknown as Unit,
        princess: [null, null] as unknown as [Unit, Unit],
      };
    };
    this.players = [mk(0), mk(1)];
    this.fixture = cfg.fixture !== undefined;
    this.boundW = cfg.fixture ? cfg.fixture.width : ARENA_W;
    this.boundH = cfg.fixture ? cfg.fixture.height : ARENA_H;
    if (!this.fixture) this.placeTowers();
  }

  /** Allocate an actor id (actor ids start at 5,000,000 like the native ones). */
  allocId(): number {
    return this.nextId++;
  }

  // ---------------------------------------------------------------- setup

  private placeTowers(): void {
    // Spawn group King_PrincessTowers: cell coords x500 [DATA], mirrored for team 1 (y' = 32000 - y).
    const grp = this.data.spawnGroups.King_PrincessTowers.Objects;
    for (const team of [0, 1]) {
      const p = this.players[team];
      let pi = 0;
      for (const o of grp) {
        const kind = o.Data === 'KingTower' ? 'king' : 'princess';
        const def = this.defs.tower(kind, this.towerLevels[team]);
        const x = o.x * CELL;
        const y0 = o.y * CELL;
        const y = team === 0 ? y0 : ARENA_H - y0;
        const u = new Unit(this.nextId++, def, '', team, x, y, 0);
        u.state = ST_ACTIVE;
        u.tower = kind === 'king' ? TOWER_KING : TOWER_PRINCESS;
        // King starts INACTIVE until damaged or a Princess tower falls [DATA king_tower.toml].
        u.kingState = kind === 'king' ? KING_INACTIVE : KING_ACTIVE;
        if (kind === 'king') p.king = u;
        else p.princess[pi++] = u;
        this.units.push(u);
        if (kind === 'princess') this.arena.setOcclusion(team, x, y, u.radius, true);
      }
      // order princesses left, right
      if (p.princess[0].x > p.princess[1].x) p.princess = [p.princess[1], p.princess[0]];
    }
  }

  // ---------------------------------------------------------------- public API

  get timeMs(): number {
    return this.tick * TICK_MS;
  }

  get ended(): boolean {
    return this.result !== null;
  }

  /** Elixir regeneration per tick for the current phase: floor(10000*50 / msPerElixir). */
  elixirPerTick(): number {
    const sec = this.timeMs / 1000;
    let fullBar = this.timeline.elixirRates[0].fullBarMs;
    for (const r of this.timeline.elixirRates) if (sec >= r.fromSec) fullBar = r.fullBarMs;
    // fullBar is the time to fill 10 elixir: per tick = 10*10000*50/fullBar, floored.
    return Math.floor((this.maxElixir * TICK_MS) / fullBar);
  }

  nextCardCooldownTicks(): number {
    const raw = this.timeline.raw;
    const lens = (raw.NextSpellCooldownLength as number[] | undefined) ?? [];
    const ms = (raw.NextSpellCooldownMS as number[] | undefined) ?? [];
    let t = 0;
    const sec = this.timeMs / 1000;
    for (let i = 0; i < ms.length; i++) {
      if (sec < t + (lens[i] ?? 0)) return Math.ceil(ms[i] / TICK_MS);
      t += lens[i] ?? 0;
    }
    return ms.length ? Math.ceil(ms[ms.length - 1] / TICK_MS) : 0;
  }

  /**
   * Snap/clamp a requested troop position the way the native command does [OBS]:
   * team 0 snaps to tile centres 1000k+500 and clamps y <= 14500; team 1 snaps in the
   * mirrored frame (17999-x, 31999-y), i.e. to 1000k+499, and clamps y >= 17499
   * (LOGIC_SYMMETRICAL_DEPLOY_SNAP). Pocket areas after a Princess tower falls (A).
   */
  snapDeploy(team: number, x: number, y: number, card: CardDef): { x: number; y: number } {
    let mx = team === 0 ? x : ARENA_W - 1 - x;
    let my = team === 0 ? y : ARENA_H - 1 - y;
    mx = clamp(mx, 0, ARENA_W - 1);
    my = clamp(my, 0, ARENA_H - 1);
    mx = Math.floor(mx / 1000) * 1000 + 500;
    my = Math.floor(my / 1000) * 1000 + 500;
    const enemy = this.players[1 - team];
    let maxY = 14500;
    // Pocket (A): with the enemy Princess tower on that side destroyed, the zone extends into
    // that half of the enemy side up to y 25000 (mirrored frame). Community knowledge, unverified.
    if (card.type !== 'spell' && !this.fixture) {
      const sideLeft = mx < 9000;
      // In the mirrored frame of team 1, "left" is the enemy's right tower.
      const tower = team === 0 ? enemy.princess[sideLeft ? 0 : 1] : enemy.princess[sideLeft ? 1 : 0];
      if (!tower.alive) maxY = 24500;
    }
    if (my > maxY) my = maxY;
    mx = clamp(mx, 250, ARENA_W - 250);
    my = clamp(my, 250, ARENA_H - 250);
    return team === 0 ? { x: mx, y: my } : { x: ARENA_W - 1 - mx, y: ARENA_H - 1 - my };
  }

  /** Whether a (snapped) troop position is free of blocked tiles and towers (UI rule, A). */
  deployPositionOk(team: number, x: number, y: number, card: CardDef): boolean {
    if (card.type === 'spell') return x >= 0 && y >= 0 && x < ARENA_W && y < ARENA_H;
    if (!this.arena.walkableAt(x, y)) return false;
    const r = card.summon[0]?.unit.collisionRadius ?? 500;
    for (const u of this.units) {
      if (!u.isBuilding || !u.alive) continue;
      const dx = u.x - x;
      const dy = u.y - y;
      const rr = u.radius + r;
      if (dx * dx + dy * dy < rr * rr) return false;
    }
    return true;
  }

  /** Validate a hand play without side effects. Returns the snapped position or an error. */
  checkPlay(team: number, slot: number, x: number, y: number): { x: number; y: number } | PlayError {
    if (this.result) return 'ended';
    if (slot < 0 || slot > 3) return 'bad-slot';
    const p = this.players[team];
    if (this.tick < p.slotReady[slot]) return 'slot-cooldown';
    const card = p.deck[p.hand[slot]];
    if (card.unsupported.length) return 'unsupported';
    if (!this.infiniteElixir && p.elixir - p.pending < card.cost * ELIXIR_ONE) return 'elixir';
    const pos = card.type === 'spell' ? { x: clamp(x, 0, ARENA_W - 1), y: clamp(y, 0, ARENA_H - 1) } : this.snapDeploy(team, x, y, card);
    if (!this.deployPositionOk(team, pos.x, pos.y, card)) return 'position';
    return pos;
  }

  /** Play the card in hand slot `slot` at (x, y). It commits 20 ticks later. */
  play(team: number, slot: number, x: number, y: number): PlayError | null {
    const pos = this.checkPlay(team, slot, x, y);
    if (typeof pos === 'string') return pos;
    const p = this.players[team];
    const di = p.hand[slot];
    const card = p.deck[di];
    const cost = this.infiniteElixir ? 0 : card.cost * ELIXIR_ONE;
    p.pending += cost;
    // Cycle: played card to the back of the queue, next card into the slot.
    p.queue.push(di);
    p.hand[slot] = p.queue.shift()!;
    p.slotReady[slot] = this.tick + this.nextCardCooldownTicks();
    this.commands.push({ team, card, x: pos.x, y: pos.y, submitTick: this.tick, slot, cost });
    return null;
  }

  /** Sandbox: deploy any card for either side, bypassing hand and elixir (same timing). */
  spawn(team: number, cardName: string, x: number, y: number): PlayError | null {
    if (this.result) return 'ended';
    const card = this.defs.card(cardName, this.levels[team]);
    if (card.unsupported.length) return 'unsupported';
    const pos = card.type === 'spell' ? { x: clamp(x, 0, ARENA_W - 1), y: clamp(y, 0, ARENA_H - 1) } : this.snapDeploy(team, x, y, card);
    if (!this.deployPositionOk(team, pos.x, pos.y, card)) return 'position';
    this.commands.push({ team, card, x: pos.x, y: pos.y, submitTick: this.tick, slot: -1, cost: 0 });
    return null;
  }

  /** Advance one tick. */
  step(): void {
    if (this.result) return;
    if (this.recordEvents) this.events.length = 0;
    this.commitCommands();
    this.regenElixir();
    this.fireSpellWaves();
    // world tick
    const units = this.units;
    for (let i = 0; i < units.length; i++) this.updateAttack(units[i]);
    for (let i = 0; i < units.length; i++) this.updateActor(units[i]);
    this.updateProjectiles();
    this.updateAreaEffects();
    this.flushDamage();
    this.removeDead();
    this.checkEnd();
    this.tick++;
  }

  /** Advance n ticks (stops at the end of the match). */
  run(n: number): void {
    for (let i = 0; i < n && !this.result; i++) this.step();
  }

  // ---------------------------------------------------------------- commands, elixir

  private commitCommands(): void {
    const cmds = this.commands;
    if (cmds.length === 0) return;
    let w = 0;
    for (let i = 0; i < cmds.length; i++) {
      const c = cmds[i];
      if (this.tick - c.submitTick >= COMMAND_DELAY_TICKS) this.execute(c);
      else cmds[w++] = c;
    }
    cmds.length = w;
  }

  private execute(c: Command): void {
    const p = this.players[c.team];
    if (c.cost > 0) {
      // Debit min(cost, current) at commit [STAT/OBS: native debit observations].
      const debit = Math.min(c.cost, p.elixir);
      p.elixir -= debit;
      p.pending -= c.cost;
    }
    const card = c.card;
    if (this.recordEvents) this.events.push({ tick: this.tick, type: 'cast', team: c.team, x: c.x, y: c.y, name: card.name, id: -1 });
    if (card.areaEffect) {
      this.spawnAreaEffect(c.team, card.areaEffect, c.x, c.y);
      return;
    }
    if (card.spellProjectile) {
      for (let w = 0; w < card.waves; w++) {
        const t = this.tick + Math.round((w * card.waveInterval) / TICK_MS);
        this.spellWaves.push({ tick: t, team: c.team, card, x: c.x, y: c.y });
      }
      this.fireSpellWaves();
      return;
    }
    for (const s of card.summon) this.summon(c.team, card.name, s.unit, s.count, s.radius, s.deployDelay, c.x, c.y);
  }

  /**
   * Spawn a summoned group. The actor joins the live list on the tick after commit and is
   * active DeployTime later [OBS: 117 commit -> 118 live -> 138 moving]. Group members are
   * staggered by SummonDeployDelay [OBS: Barbarians 145,147,...]. Formation positions on a
   * circle of SummonRadius are an approximation (A).
   */
  private summon(team: number, card: string, def: UnitDef, count: number, radius: number, delayMs: number, x: number, y: number): void {
    const r = count > 1 ? (radius > 0 ? radius : 500) : 0;
    for (let i = 0; i < count; i++) {
      let ux = x;
      let uy = y;
      if (r > 0) {
        // start at 180 deg (left) and go around; team 1 mirrored
        const deg = 180 + Math.floor((i * 360) / count);
        ux = x + idiv(cos1e6(deg) * r, 1000000) * (team === 0 ? 1 : -1);
        uy = y + idiv(sin1e6(deg) * r, 1000000) * (team === 0 ? 1 : -1);
        ux = clamp(ux, 0, ARENA_W - 1);
        uy = clamp(uy, 0, ARENA_H - 1);
        if (!def.flyingHeight && !this.arena.walkableAt(ux, uy)) { ux = x; uy = y; }
      }
      const u = new Unit(this.nextId++, def, card, team, ux, uy, this.tick + 1);
      const ticks = Math.round(def.deployTime / TICK_MS) + Math.round((i * delayMs) / TICK_MS);
      u.deployTicks = ticks;
      u.deployTotal = ticks;
      this.newUnits.push(u);
      if (u.isBuilding) this.arena.setOcclusion(team, ux, uy, u.radius, true);
      if (this.recordEvents) this.events.push({ tick: this.tick, type: 'spawn', team, x: ux, y: uy, name: def.name, id: u.id });
    }
  }

  private regenElixir(): void {
    const add = this.elixirPerTick();
    for (const p of this.players) {
      if (this.infiniteElixir) { p.elixir = this.maxElixir; continue; }
      p.elixir = Math.min(this.maxElixir, p.elixir + add);
    }
  }

  private fireSpellWaves(): void {
    const waves = this.spellWaves;
    if (waves.length === 0) return;
    let w = 0;
    for (let i = 0; i < waves.length; i++) {
      const s = waves[i];
      if (s.tick <= this.tick) this.castSpellProjectile(s.team, s.card, s.x, s.y);
      else waves[w++] = s;
    }
    waves.length = w;
  }

  /**
   * Spell projectiles fly from the caster's King tower to the target point (A: origin assumed).
   * Damage radius is the card's Radius when set (Arrows 3500), else the projectile's (A).
   */
  private castSpellProjectile(team: number, card: CardDef, x: number, y: number): void {
    const def = card.spellProjectile!;
    const king = this.players[team].king;
    const pr = new Projectile(this.nextProjId++, def, team, king.x, king.y, this.tick);
    pr.tx = x;
    pr.ty = y;
    pr.spell = card.name;
    if (card.spellRadius > 0) pr.radius = card.spellRadius;
    this.projectiles.push(pr);
  }

  // ---------------------------------------------------------------- targeting & attack

  private canAttack(u: Unit, t: Unit): boolean {
    if (t.team === u.team || t.state === ST_DEAD || t.maxHp <= 0) return false;
    const d = u.def;
    if (t.isAir ? !d.attacksAir : !d.attacksGround) return false;
    if (d.targetOnlyBuildings && !t.isBuilding) return false;
    if (d.targetOnlyTroops && t.isBuilding) return false;
    return true;
  }

  /** dist^2 <= (Range + target radius + ext)^2 [STAT attack_range_check]. */
  private inRange(u: Unit, t: Unit, ext: number): boolean {
    const dx = t.x - u.x;
    const dy = t.y - u.y;
    const r = u.def.range + t.radius + ext;
    const d2 = dx * dx + dy * dy;
    if (d2 > r * r) return false;
    if (u.def.minimumRange > 0) {
      const m = u.def.minimumRange + t.radius;
      if (d2 < m * m) return false;
    }
    return true;
  }

  /**
   * Target selection (A, informed by globals and one native fixture): towers take the nearest
   * enemy in range; other units take the nearest (centre distance) attackable enemy within SightRange (+2000 to crown towers,
   * EXTRA_SIGHT_RANGE_TO_CROWN_TOWERS), else the default crown tower of their lane
   * (LOGIC_XPOS_BASED_TOWER_TARGETING, LOGIC_PRINCESS_TOWERS_ALWAYS_AS_DEFAULT_TARGET).
   */
  private findTarget(u: Unit): Unit | null {
    const units = this.units;
    const isTower = u.tower !== TOWER_NONE;
    let best: Unit | null = null;
    let bestD = 0;
    for (let i = 0; i < units.length; i++) {
      const t = units[i];
      if (!this.canAttack(u, t)) continue;
      const dx = t.x - u.x;
      const dy = t.y - u.y;
      const d2 = dx * dx + dy * dy;
      let reach: number;
      if (isTower || u.isBuilding) reach = u.def.range + t.radius;
      else reach = u.def.sightRange + t.radius + (t.tower !== TOWER_NONE ? this.extraSightCrownTowers : 0);
      if (d2 > reach * reach) continue;
      if (u.def.minimumRange > 0) {
        const m = u.def.minimumRange + t.radius;
        if (d2 < m * m) continue;
      }
      // nearest by centre distance [OBS native-automatic-combat: the Knight chose the enemy
      // Knight at 1000 over the King at 1118 although the King's edge was nearer]
      if (best === null || d2 < bestD) { best = t; bestD = d2; }
    }
    if (best || isTower || u.isBuilding) return best;
    return this.defaultTarget(u);
  }

  private defaultTarget(u: Unit): Unit | null {
    if (this.fixture) return null;
    const enemy = this.players[1 - u.team];
    const left = u.x < 9000;
    const lane = enemy.princess[left ? 0 : 1];
    if (lane.alive && this.canAttack(u, lane)) return lane;
    if (enemy.king.alive && this.canAttack(u, enemy.king)) return enemy.king;
    const other = enemy.princess[left ? 1 : 0];
    if (other.alive && this.canAttack(u, other)) return other;
    return null;
  }

  /**
   * Attack clock increment: 50 x max(100, strongest haste)/100 x clamp(100 - strongest slow, 0..100)/100
   * with integer truncation [STAT time_delta_scale; OBS haste 150 -> 75, slow -35 -> 32, both -> 48].
   */
  private clockDelta(u: Unit): number {
    if (u.buffs.length === 0) return TICK_MS;
    let haste = 100;
    let slow = 0;
    for (const b of u.buffs) {
      const m = b.def.hitSpeedMul;
      if (m >= 100) { if (m > haste) haste = m; } else if (m < 0 && m < slow) slow = m;
    }
    return idiv(idiv(TICK_MS * haste, 100) * clamp(100 + slow, 0, 100), 100);
  }

  /** Movement speed with buffs, same shape as the attack clock (A for movement). */
  private moveSpeed(u: Unit): number {
    const sp = u.def.speed;
    if (u.buffs.length === 0) return sp;
    let haste = 100;
    let slow = 0;
    for (const b of u.buffs) {
      const m = b.def.speedMul;
      if (m >= 100) { if (m > haste) haste = m; } else if (m < 0 && m < slow) slow = m;
    }
    return idiv(idiv(sp * haste, 100) * clamp(100 + slow, 0, 100), 100);
  }

  private updateAttack(u: Unit): void {
    if (u.state !== ST_ACTIVE) return;
    if (u.tower === TOWER_KING && u.kingState !== KING_ACTIVE) return;
    if (u.def.hitSpeed <= 0) return;
    if (u.buffs.length && this.clockDelta(u) === 0) return; // frozen/stunned
    let t = u.target;
    if (t !== null && (t.state === ST_DEAD || !this.canAttack(u, t))) {
      t = null;
      u.target = null;
      u.locked = false;
    }
    if (u.locked && t !== null && !this.inRange(u, t, this.keepTargetExt)) u.locked = false;
    if (!u.locked) {
      const nt = this.findTarget(u);
      if (nt !== u.target) {
        // Retarget keeps the attack clock running [OBS native-automatic-combat: the Knight
        // switched target at tick 3 and still hit at tick 9].
        u.target = nt;
        u.path = EMPTY_PATH;
        u.pathGoal = -1;
      }
      t = nt;
      if (t !== null && this.inRange(u, t, 0)) u.locked = true;
    }
    const dt = this.clockDelta(u);
    if (u.locked && t !== null) {
      u.dirX = t.x - u.x;
      u.dirY = t.y - u.y;
      if (u.atkDelay > 0) {
        u.atkDelay -= dt;
        return;
      }
      u.atkTimer += dt;
      if (u.atkTimer >= u.def.hitSpeed) {
        this.hit(u, t);
        // LOGIC_LOAD_FIRST_HIT_RESET_TIMER_AFTER_ATTACK: timer back to 0 [OBS: 9, 33, 57].
        u.atkTimer = 0;
      }
    } else if (u.atkTimer < u.def.loadTime) {
      // Reload continues while not attacking, up to the preloaded state (A).
      u.atkTimer = Math.min(u.def.loadTime, u.atkTimer + dt);
    }
  }

  private hit(u: Unit, t: Unit): void {
    u.lastHitTick = this.tick;
    const d = u.def;
    if (this.recordEvents) this.events.push({ tick: this.tick, type: d.projectile ? 'shoot' : 'hit', team: u.team, x: t.x, y: t.y, name: d.name, id: u.id });
    if (d.projectile) {
      this.fireProjectile(u, t, d.projectile);
    } else if (d.areaDamageRadius > 0) {
      const cx = d.selfAsAoeCenter ? u.x : t.x;
      const cy = d.selfAsAoeCenter ? u.y : t.y;
      this.areaDamage(u.team, cx, cy, d.areaDamageRadius, d.attacksAir, d.attacksGround, d.damage, -1, d.crownTowerDamagePercent, 0, false);
    } else {
      this.queueDamage(t, d.damage, -1, d.crownTowerDamagePercent);
    }
    if (d.kamikaze) {
      u.hp = 0;
      u.state = ST_DEAD;
    }
  }

  /** Projectile spawns ProjectileStartRadius toward the target, plus ProjectileYOffset [OBS King (9750,3400)]. */
  private fireProjectile(u: Unit, t: Unit, def: ProjectileDef): void {
    const dx = t.x - u.x;
    const dy = t.y - u.y;
    const dd = isqrt(dx * dx + dy * dy);
    const sr = u.def.projectileStartRadius;
    let sx = u.x;
    let sy = u.y;
    if (dd > 0) {
      sx += idiv(dx * sr, dd);
      sy += idiv(dy * sr, dd);
    }
    sy += u.team === 0 ? u.def.projectileYOffset : -u.def.projectileYOffset;
    const pr = new Projectile(this.nextProjId++, def, u.team, sx, sy, this.tick);
    pr.sourceId = u.id;
    pr.tx = t.x;
    pr.ty = t.y;
    if (def.homing) pr.target = t;
    this.projectiles.push(pr);
  }

  private queueDamage(t: Unit, amount: number, towerDamage: number, pct: number): void {
    const i = this.dmgN++;
    this.dmgTarget[i] = t;
    this.dmgAmount[i] = amount;
    this.dmgTower[i] = towerDamage;
    this.dmgPct[i] = pct;
  }

  /** Damage every enemy whose collision circle meets the area (A: edge overlap rule). */
  private areaDamage(team: number, x: number, y: number, radius: number, air: boolean, ground: boolean,
    damage: number, towerDamage: number, pct: number, pushback: number, pushAll: boolean,
    buff: BuffDef | null = null, buffTime = 0, sourceId = -1): void {
    const units = this.units;
    for (let i = 0; i < units.length; i++) {
      const t = units[i];
      if (t.team === team || t.state === ST_DEAD) continue;
      if (t.isAir ? !air : !ground) continue;
      const dx = t.x - x;
      const dy = t.y - y;
      const r = radius + t.radius;
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      if (t.maxHp <= 0) continue;
      this.queueDamage(t, damage, towerDamage, pct);
      if (buff) this.applyBuff(t, buff, buffTime, sourceId);
      if (pushback > 0 && !t.isBuilding && (pushAll || !t.def.ignorePushback)) {
        const d = isqrt(d2);
        // Knockback spread over 4 ticks (A).
        const px = d > 0 ? idiv(dx * pushback, d) : 0;
        const py = d > 0 ? idiv(dy * pushback, d) : (t.team === 0 ? -pushback : pushback);
        t.pushX = px;
        t.pushY = py;
        t.pushTicks = 4;
      }
    }
  }

  // ---------------------------------------------------------------- actors & movement

  private updateActor(u: Unit): void {
    if (u.state === ST_DEAD) return;
    if (u.buffs.length) this.updateBuffs(u);
    if (u.state === ST_DEPLOYING) {
      if (u.deployTicks > 0) u.deployTicks--;
      if (u.deployTicks === 0) {
        u.state = ST_ACTIVE;
        // Actors without hitpoints (Rage bottle) expire on landing, triggering their death effect.
        if (u.maxHp <= 0) this.kill(u);
      }
      return;
    }
    if (u.tower === TOWER_KING && u.kingState === KING_ACTIVATING) {
      // 3300 ms ACTIVATING action [DATA]; with LoadTime gives first shot 621 -> 697 [OBS].
      if (--u.kingTicks <= 0) u.kingState = KING_ACTIVE;
      return;
    }
    if (u.isBuilding) {
      if (u.def.lifeTime > 0) this.decay(u);
      return;
    }
    if (u.pushTicks > 0) this.applyPush(u);
    u.moving = false;
    if (!u.locked && u.target !== null && u.def.speed > 0) this.moveToward(u, u.target);
    this.separate(u);
  }

  /**
   * Collision push, part of each actor's movement update (the native movement component runs
   * a neighbour scan every tick, also while attacking). Each overlapping neighbour on the same
   * layer pushes along the centre line with weight min(overlap, 90) x 150/90; the total is
   * capped at 150 units per tick. Fitted to the native King-vs-Knight trace
   * (research/evidence/native-automatic-combat.json: 29/38 steps exact, max error 3 units);
   * unit-vs-unit weights by Mass are an approximation (A).
   */
  private separate(u: Unit): void {
    const units = this.units;
    let px = 0;
    let py = 0;
    let any = false;
    for (let i = 0; i < units.length; i++) {
      const n = units[i];
      if (n === u || n.state === ST_DEAD || n.isAir !== u.isAir) continue;
      const dx = u.x - n.x;
      const dy = u.y - n.y;
      const minD = u.radius + n.radius;
      if (dx >= minD || dx <= -minD || dy >= minD || dy <= -minD) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minD * minD) continue;
      const d = isqrt(d2);
      const overlap = minD - d;
      let w = (overlap < PUSH_CAP ? overlap : PUSH_CAP) * PUSH_SPEED;
      if (!n.isBuilding) w = idiv(w * 2 * n.mass, u.mass + n.mass);
      if (d === 0) {
        // coincident: push apart along y, older unit stays (deterministic)
        py += (u.id > n.id ? 1 : -1) * (u.team === 0 ? -1 : 1) * idiv(w, PUSH_CAP);
      } else {
        px += (dx * w) / (d * PUSH_CAP);
        py += (dy * w) / (d * PUSH_CAP);
      }
      any = true;
    }
    if (!any) return;
    // integerise (truncate toward zero) and cap the step length
    let mx = Math.trunc(px);
    let my = Math.trunc(py);
    const l2 = mx * mx + my * my;
    if (l2 > PUSH_SPEED * PUSH_SPEED) {
      const l = isqrt(l2);
      mx = idiv(mx * PUSH_SPEED, l);
      my = idiv(my * PUSH_SPEED, l);
    }
    if (mx !== 0 || my !== 0) this.tryMove(u, mx, my);
  }

  /**
   * Building lifetime: HP decays linearly so the building expires after LifeTime ms of being
   * active (D: LifeTime; A: linear integer schedule).
   */
  private decay(u: Unit): void {
    u.lifeTicks++;
    const total = Math.max(1, Math.round(u.def.lifeTime / TICK_MS));
    const due = Math.floor((u.maxHp * u.lifeTicks) / total);
    const step = due - u.decayed;
    u.decayed = due;
    if (step > 0) {
      u.hp -= step;
      if (u.hp <= 0) this.kill(u);
    }
  }

  private applyPush(u: Unit): void {
    const n = u.pushTicks;
    const sx = idiv(u.pushX, n);
    const sy = idiv(u.pushY, n);
    u.pushX -= sx;
    u.pushY -= sy;
    u.pushTicks--;
    this.tryMove(u, sx, sy);
  }

  /**
   * Path following as observed natively: walk toward the centre of the next path cell; a
   * waypoint is consumed on entering its cell; with the path empty (goal cell reached) walk
   * straight at the target [OBS native-world-movement: (750,750) -> (1520,1520)].
   * Step = Speed units per tick, components truncated [OBS: speed 50 diagonal = (+35,+35)].
   */
  private moveToward(u: Unit, t: Unit): void {
    let gx = t.x;
    let gy = t.y;
    if (!u.isAir && !this.fixture) {
      const cell = Arena.cellOf(u.x, u.y);
      const goal = Arena.cellOf(t.x, t.y);
      if (u.pathGoal !== goal || u.pathVersion !== this.arena.version) {
        u.path = this.arena.findPath(cell, goal, u.team, false);
        u.pathIdx = 0;
        u.pathGoal = goal;
        u.pathVersion = this.arena.version;
      }
      const path = u.path;
      while (u.pathIdx < path.length && path[u.pathIdx] === cell) u.pathIdx++;
      if (u.pathIdx < path.length) {
        // If we strayed off the path (pushed), replan from here.
        const c = path[u.pathIdx];
        const cx = c % GRID_W;
        const cy = (c - cx) / GRID_W;
        const ux = Math.floor(u.x / CELL);
        const uy = Math.floor(u.y / CELL);
        if (Math.abs(cx - ux) > 1 || Math.abs(cy - uy) > 1) {
          u.path = this.arena.findPath(cell, goal, u.team, false);
          u.pathIdx = 0;
          if (u.path.length === 0) return;
        }
        const nc = u.path[u.pathIdx];
        gx = Arena.cellCenterX(nc);
        gy = Arena.cellCenterY(nc);
      }
    }
    const dx = gx - u.x;
    const dy = gy - u.y;
    const d = isqrt(dx * dx + dy * dy);
    if (d === 0) return;
    const sp = this.moveSpeed(u);
    if (sp <= 0) return;
    const step = sp < d ? sp : d;
    const mx = idiv(dx * step, d);
    const my = idiv(dy * step, d);
    if (mx !== 0 || my !== 0) {
      u.dirX = mx;
      u.dirY = my;
      u.moving = this.tryMove(u, mx, my);
    }
  }

  /** Move with arena bounds and (for ground units) water/blocked cells as walls. */
  private tryMove(u: Unit, mx: number, my: number): boolean {
    const nx = clamp(u.x + mx, 0, this.boundW - 1);
    const ny = clamp(u.y + my, 0, this.boundH - 1);
    if (u.isAir || this.fixture || this.arena.walkableAt(nx, ny)) {
      u.x = nx;
      u.y = ny;
      return true;
    }
    if (mx !== 0 && this.arena.walkableAt(nx, u.y)) { u.x = nx; return true; }
    if (my !== 0 && this.arena.walkableAt(u.x, ny)) { u.y = ny; return true; }
    return false;
  }

  // ---------------------------------------------------------------- buffs & area effects

  /**
   * Apply (or refresh) a buff. Stacking buffs keep one instance per source, others one per
   * buff. Damage/heal ticks every HitFrequency, the first one HitFrequency after application
   * (immediately for HitTickFromSource buffs) — chosen so Poison deals 8 ticks and Earthquake 3 (A).
   * A full stop (-100 hit speed) resets the attack wind-up (A, community knowledge: Zap/Freeze reset).
   */
  applyBuff(u: Unit, def: BuffDef, timeMs: number, sourceId: number): void {
    if (u.state === ST_DEAD) return;
    const ticks = Math.max(1, Math.ceil(timeMs / TICK_MS));
    for (const b of u.buffs) {
      if (b.def === def && (!def.stacking || b.sourceId === sourceId)) {
        if (ticks > b.ticksLeft) b.ticksLeft = ticks;
        return;
      }
    }
    const inst = new BuffInst(def, sourceId, ticks);
    const raw = this.data.buffs[def.name];
    inst.hitTimer = raw && raw.HitTickFromSource === true ? 0 : def.hitFrequency;
    u.buffs.push(inst);
    if (def.hitSpeedMul <= -100) {
      u.atkTimer = 0;
      u.locked = false;
      u.target = null;
    }
  }

  private updateBuffs(u: Unit): void {
    const bs = u.buffs;
    let w = 0;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      const d = b.def;
      if (d.dps > 0 || d.hps > 0) {
        b.hitTimer -= TICK_MS;
        if (b.hitTimer <= 0) {
          b.hitTimer += d.hitFrequency;
          if (d.dps > 0) {
            let amount = Math.floor((d.dps * d.hitFrequency) / 1000);
            if (d.buildingDamagePercent > 0 && u.isBuilding && u.tower === TOWER_NONE) amount = Math.floor((amount * d.buildingDamagePercent) / 100);
            this.queueDamage(u, amount, -1, d.crownTowerDamagePercent);
          }
          if (d.hps > 0 && u.tower === TOWER_NONE) u.hp = Math.min(u.maxHp, u.hp + Math.floor((d.hps * d.hitFrequency) / 1000));
        }
      }
      if (--b.ticksLeft > 0) bs[w++] = b;
    }
    bs.length = w;
  }

  private spawnAreaEffect(team: number, def: AreaEffectDef, x: number, y: number): void {
    const a = new AreaEffect(this.nextAeoId++, def, team, x, y, this.tick);
    this.areaEffects.push(a);
    if (this.recordEvents) this.events.push({ tick: this.tick, type: 'aoe', team, x, y, name: def.name, id: a.id });
    if (def.spawnAreaEffect) this.spawnAreaEffect(team, def.spawnAreaEffect, x, y);
  }

  private filterMatch(f: FilterDef | null, team: number, onlyEnemies: boolean, u: Unit): boolean {
    if (u.state === ST_DEAD || u.maxHp <= 0) return false;
    if (f === null) return onlyEnemies ? u.team !== team : true;
    if (!((f.enemy && u.team !== team) || (f.own && u.team === team))) return false;
    if (f.towersOnly && u.tower === TOWER_NONE) return false;
    if (f.buildingsOnly && !u.isBuilding) return false;
    if (f.exBuildings && u.isBuilding && u.tower === TOWER_NONE) return false;
    if (f.exKing && u.tower === TOWER_KING) return false;
    if (f.exPrincess && u.tower === TOWER_PRINCESS) return false;
    if (f.exFlying && u.isAir) return false;
    if (f.include && !f.include.includes(u.def.name)) return false;
    if (f.exclude && f.exclude.includes(u.def.name)) return false;
    return true;
  }

  /**
   * Area effects hit at HitSpeedOffset, then every HitSpeed while age <= LifeDuration (a single
   * hit when HitSpeed is 0). Targets: actors matching the Filter whose circle meets the radius;
   * HitBiggestTargets takes the MaximumTargets highest-HP ones, OneHitPerTarget never repeats.
   * Hit schedule chosen to give Lightning 3 strikes (A on exact timing).
   */
  private updateAreaEffects(): void {
    const as = this.areaEffects;
    let w = 0;
    for (let i = 0; i < as.length; i++) {
      const a = as[i];
      const def = a.def;
      while (a.nextHit >= 0 && a.age >= a.nextHit) {
        this.aeoHit(a);
        a.nextHit = def.hitSpeed > 0 && a.nextHit + def.hitSpeed <= def.lifeDuration ? a.nextHit + def.hitSpeed : -1;
      }
      a.age += TICK_MS;
      if (a.age > def.lifeDuration && a.nextHit < 0) a.alive = false;
      if (a.alive) as[w++] = a;
    }
    as.length = w;
  }

  private aeoHit(a: AreaEffect): void {
    const def = a.def;
    const units = this.units;
    const targets = this.scratch;
    targets.length = 0;
    for (let i = 0; i < units.length; i++) {
      const t = units[i];
      if (!this.filterMatch(def.filter, a.team, def.onlyEnemies, t)) continue;
      if (def.oneHitPerTarget && a.hitIds.includes(t.id)) continue;
      const dx = t.x - a.x;
      const dy = t.y - a.y;
      const r = def.radius + t.radius;
      if (dx * dx + dy * dy > r * r) continue;
      targets.push(t);
    }
    if (def.hitBiggest) targets.sort((p, q) => q.hp - p.hp || p.id - q.id);
    const n = def.maxTargets > 0 ? Math.min(def.maxTargets, targets.length) : targets.length;
    let buffTime = def.buffTime;
    if (def.capBuffTime) buffTime = Math.min(buffTime, Math.max(TICK_MS, def.lifeDuration - a.age));
    for (let i = 0; i < n; i++) {
      const t = targets[i];
      if (def.oneHitPerTarget) a.hitIds.push(t.id);
      if (def.projectile) {
        // Strike from above (Lightning): a projectile that lands on the target next tick (A).
        const pr = new Projectile(this.nextProjId++, def.projectile, a.team, t.x, t.y, this.tick);
        pr.target = t;
        pr.tx = t.x;
        pr.ty = t.y;
        pr.spell = def.name;
        this.projectiles.push(pr);
        continue;
      }
      if (def.damage > 0) this.queueDamage(t, def.damage, def.towerDamage, def.crownTowerDamagePercent);
      if (def.buff) this.applyBuff(t, def.buff, buffTime, a.id);
    }
    targets.length = 0;
  }

  // ---------------------------------------------------------------- projectiles

  /**
   * Projectiles fly Speed units per tick toward the target (homing follows it); they do not
   * move on their spawn tick; on reaching the target point they deal damage that same tick
   * (applied in the flush) [OBS: King shot, arrows].
   */
  private updateProjectiles(): void {
    const ps = this.projectiles;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.born !== this.tick) this.moveProjectile(p);
      if (p.alive) ps[w++] = p;
    }
    ps.length = w;
  }

  private moveProjectile(p: Projectile): void {
    const t = p.target;
    if (t !== null) {
      if (t.state === ST_DEAD) p.target = null;
      else { p.tx = t.x; p.ty = t.y; }
    }
    const dx = p.tx - p.x;
    const dy = p.ty - p.y;
    const d = isqrt(dx * dx + dy * dy);
    const sp = p.def.speed;
    if (d <= sp) {
      p.x = p.tx;
      p.y = p.ty;
      p.alive = false;
      this.impact(p);
      return;
    }
    p.x += idiv(dx * sp, d);
    p.y += idiv(dy * sp, d);
  }

  private impact(p: Projectile): void {
    if (this.recordEvents) this.events.push({ tick: this.tick, type: 'impact', team: p.team, x: p.x, y: p.y, name: p.spell || p.def.name, id: p.id });
    if (p.radius > 0) {
      this.areaDamage(p.team, p.x, p.y, p.radius, p.aoeAir, p.aoeGround, p.damage, p.towerDamage, p.crownPct, p.pushback, p.def.pushbackAll, p.def.targetBuff, p.def.buffTime, p.id);
    } else if (p.target !== null) {
      this.queueDamage(p.target, p.damage, p.towerDamage, p.crownPct);
      if (p.def.targetBuff) this.applyBuff(p.target, p.def.targetBuff, p.def.buffTime, p.id);
    }
  }

  // ---------------------------------------------------------------- damage & death

  private flushDamage(): void {
    for (let i = 0; i < this.dmgN; i++) {
      const t = this.dmgTarget[i];
      if (t.state === ST_DEAD) continue;
      let amount = this.dmgAmount[i];
      if (t.tower !== TOWER_NONE) {
        // Crown towers: TowerDamage (absolute) or CrownTowerDamagePercent; floor (A on rounding).
        if (this.dmgTower[i] >= 0) amount = this.dmgTower[i];
        else if (this.dmgPct[i] !== 0) amount = Math.floor((amount * (100 + this.dmgPct[i])) / 100);
        if (t.tower === TOWER_KING && t.kingState === KING_INACTIVE && amount > 0) this.activateKing(t);
      }
      // Shield absorbs first; excess damage on the breaking hit is lost [OBS].
      if (t.shield > 0) {
        t.shield = Math.max(0, t.shield - amount);
      } else {
        t.hp -= amount;
      }
      if (t.hp <= 0) this.kill(t);
    }
    // release references
    for (let i = 0; i < this.dmgN; i++) this.dmgTarget[i] = null as unknown as Unit;
    this.dmgN = 0;
  }

  private activateKing(k: Unit): void {
    if (k.kingState !== KING_INACTIVE) return;
    k.kingState = KING_ACTIVATING;
    k.kingTicks = 3300 / TICK_MS;
  }

  private kill(t: Unit): void {
    if (t.state === ST_DEAD) return;
    t.state = ST_DEAD;
    if (this.recordEvents) this.events.push({ tick: this.tick, type: t.tower ? 'tower' : 'death', team: t.team, x: t.x, y: t.y, name: t.def.name, id: t.id });
    if (t.isBuilding) this.arena.setOcclusion(t.team, t.x, t.y, t.radius, false);
    if (t.def.deathAreaEffect) this.spawnAreaEffect(t.team, t.def.deathAreaEffect, t.x, t.y);
    if (t.tower !== TOWER_NONE) {
      const owner = this.players[t.team];
      const other = this.players[1 - t.team];
      if (t.tower === TOWER_KING) other.crowns = 3;
      else {
        other.crowns = Math.min(3, other.crowns + 1);
        this.activateKing(owner.king);
      }
    }
  }

  private removeDead(): void {
    const units = this.units;
    let w = 0;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      // keep dead crown towers (ruins stay; they are not targetable)
      if (u.state !== ST_DEAD || u.tower !== TOWER_NONE) units[w++] = u;
    }
    units.length = w;
    if (this.newUnits.length) {
      for (const u of this.newUnits) units.push(u);
      this.newUnits.length = 0;
    }
  }

  // ---------------------------------------------------------------- end of match

  /**
   * End rules [STAT runner audit]: a King at 0 HP ends the match at once. At the end of
   * regulation the match ends if crowns differ, else overtime, where the first crown lead
   * wins. Tied after overtime: tiebreak by the lowest tower HP (A, community rule).
   */
  private checkEnd(): void {
    if (this.fixture) return;
    const [p0, p1] = this.players;
    if (!p0.king.alive || !p1.king.alive) {
      const w = !p0.king.alive && !p1.king.alive ? -1 : !p0.king.alive ? 1 : 0;
      this.result = { winner: w, reason: 'king', tick: this.tick };
      return;
    }
    const t = this.tick + 1; // ticks elapsed after this one
    if (t >= this.regulationTicks) {
      if (p0.crowns !== p1.crowns) {
        this.result = { winner: p0.crowns > p1.crowns ? 0 : 1, reason: t === this.regulationTicks ? 'time' : 'overtime', tick: this.tick };
        return;
      }
      if (t >= this.regulationTicks + this.overtimeTicks) {
        const low = (p: Player) => Math.min(...[p.king, ...p.princess].filter((u) => u.alive).map((u) => u.hp));
        const a = low(p0);
        const b = low(p1);
        this.result = { winner: a === b ? -1 : a > b ? 0 : 1, reason: 'tiebreak', tick: this.tick };
      }
    }
  }

  // ---------------------------------------------------------------- state hash

  /** Hash of the complete simulation state (for replay/determinism tests). */
  hash(): string {
    const h = new Hasher();
    h.add(this.tick);
    for (const p of this.players) {
      h.add(p.elixir); h.add(p.pending); h.add(p.crowns);
      for (const c of p.hand) h.add(c);
      for (const c of p.queue) h.add(c);
      for (const c of p.slotReady) h.add(c);
    }
    for (const u of this.units) {
      h.add(u.id); h.add(u.x); h.add(u.y); h.add(u.hp); h.add(u.shield); h.add(u.state);
      h.add(u.deployTicks); h.add(u.atkTimer); h.add(u.atkDelay); h.add(u.target ? u.target.id : -1);
      h.add(u.locked ? 1 : 0); h.add(u.kingState); h.add(u.kingTicks); h.add(u.pushTicks);
      for (const b of u.buffs) { h.add(b.sourceId); h.add(b.ticksLeft); h.add(b.hitTimer); }
    }
    for (const a of this.areaEffects) { h.add(a.id); h.add(a.age); h.add(a.nextHit); }
    for (const p of this.projectiles) {
      h.add(p.id); h.add(p.x); h.add(p.y); h.add(p.tx); h.add(p.ty); h.add(p.target ? p.target.id : -1);
    }
    for (const c of this.commands) { h.add(c.team); h.add(c.x); h.add(c.y); h.add(c.submitTick); }
    for (const s of this.rng.state()) h.add(s);
    return h.hex();
  }
}

const EMPTY_PATH = new Int32Array(0);
