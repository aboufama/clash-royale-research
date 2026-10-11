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

import { Arena, ARENA_H, ARENA_W, CELL, F_BLOCKED, F_OCCLUDER, F_WATER, PATH_CROSS, PATH_WALK } from './arena.ts';
import { SpatialGrid } from './grid.ts';
import {
  type AreaEffectDef, type BuffDef, Defs, ELIXIR_ONE, type CardDef, type FilterDef, type GameData, type ProjectileDef, TICK_MS,
  type SummonEntry, type Timeline, type UnitDef,
} from './data.ts';
import {
  AreaEffect, type BattleEvent, BuffInst, type Command, KING_ACTIVATING, KING_ACTIVE, KING_INACTIVE, Projectile, ST_ACTIVE, ST_DEAD,
  ST_DEPLOYING, TOWER_KING, TOWER_NONE, TOWER_PRINCESS, Unit,
} from './entities.ts';
import { clamp, Hasher, idiv, isqrt, NativeRng, Rng } from './math.ts';
import { formationOffset } from './formation.ts';
import { cos1e6, rotate1024, sin1e6 } from './trig.ts';

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

export class Battle {
  readonly data: GameData;
  readonly defs: Defs;
  readonly arena: Arena;
  readonly rng: Rng;
  /** Battle RNG with the native algorithm (0x1294bb4): spell scatter. Seeded from the config seed (A: native seed source). */
  readonly nrng: NativeRng;
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
  readonly maxPushback: number;
  readonly laneSeqDeploy: boolean;
  readonly avoidBuildings: boolean;
  readonly flyingNoWater: boolean;

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
  // Damage queue (parallel arrays, reused)
  private dmgTarget: Unit[] = [];
  private dmgAmount: number[] = [];
  private dmgTower: number[] = [];
  private dmgPct: number[] = [];
  private dmgN = 0;
  private scratch: Unit[] = [];
  private scratch2: Unit[] = [];
  readonly grid: SpatialGrid;

  constructor(data: GameData, cfg: BattleConfig) {
    this.data = data;
    this.defs = new Defs(data);
    this.arena = new Arena(data, cfg.fixture);
    this.rng = new Rng(cfg.seed ?? 1);
    this.nrng = new NativeRng(cfg.seed ?? 1);
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
    this.maxPushback = typeof G.MAX_PUSHBACK_LENGTH === 'number' ? G.MAX_PUSHBACK_LENGTH : 40000;
    this.laneSeqDeploy = G.LOGIC_LANE_ID_BASED_DEPLOY_SEQUENCE !== false;
    this.avoidBuildings = G.KS_POS_TO_TARGET_GROUND_AVOID_BUILDINGS !== false;
    this.flyingNoWater = G.KS_POS_TO_TARGET_FLYING_NO_WATER !== false;

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
    this.grid = new SpatialGrid(this.boundW, this.boundH);
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
        u.lane = this.laneOf(x, y);
        u.state = ST_ACTIVE;
        u.tower = kind === 'king' ? TOWER_KING : TOWER_PRINCESS;
        // King starts INACTIVE until damaged or a Princess tower falls [DATA king_tower.toml].
        u.kingState = kind === 'king' ? KING_INACTIVE : KING_ACTIVE;
        if (kind === 'king') p.king = u;
        else p.princess[pi++] = u;
        this.units.push(u);
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
    // Cards that may be placed anywhere (Miner, Goblin Drill) skip the zone clamp (D: CanDeployOnEnemySide).
    if (card.canDeployOnEnemySide) maxY = ARENA_H - 1;
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

  /** Advance one tick. Phase order follows the native world tick 0xf8cd90 (PORT_NOTES §1.3). */
  step(): void {
    if (this.result) return;
    if (this.recordEvents) this.events.length = 0;
    this.commitCommands();
    this.regenElixir();
    const units = this.units;
    this.preTick();
    for (let i = 0; i < units.length; i++) this.attackUpdate(units[i]); // all attack components
    for (let i = 0; i < units.length; i++) this.movementUpdate(units[i]); // all movement components
    for (let i = 0; i < units.length; i++) this.healthUpdate(units[i]); // health components
    for (let i = 0; i < units.length; i++) if (units[i].buffs.length) this.updateBuffs(units[i]); // buff components
    for (let i = 0; i < units.length; i++) this.updateActor(units[i]); // actor updates (vt+0x48)
    this.updateProjectiles();
    this.updateAreaEffects();
    this.flushDamage(); // world vt+0x90 damage queue flush
    this.removeDead();
    this.checkEnd();
    this.tick++;
  }

  /** Advance n ticks (stops at the end of the match). */
  /**
   * World pre-tick 0xf967a4 [STAT]: the spatial grid is rebuilt from the world list (here: each
   * actor's tick-start position is recorded; queries scan the list and reproduce the grid's
   * membership and order), then the dynamic occlusion grid (0x11d8d9c): every building stamps its
   * square and feeds its team's occluder hash.
   */
  private preTick(): void {
    const A = this.arena;
    const units = this.units;
    const sig = this.occSig;
    let n = 0;
    let same = true;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      u.gx = u.x;
      u.gy = u.y;
      u.inGrid = u.state !== ST_DEAD;
      if (u.isBuilding && u.state !== ST_DEAD) {
        if (same && (sig[n] !== u.id || sig[n + 1] !== u.x || sig[n + 2] !== u.y || sig[n + 3] !== u.radius)) same = false;
        sig[n] = u.id; sig[n + 1] = u.x; sig[n + 2] = u.y; sig[n + 3] = u.radius;
        n += 4;
      }
    }
    if (same && n === this.occSigLen && this.tick > 0) { A.keepOcclusion(); return; }
    this.occSigLen = n;
    sig.length = n;
    A.beginOcclusion();
    let h0 = 0;
    let h1 = 0;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.isBuilding && u.state !== ST_DEAD) {
        A.stampOccluder(u.x, u.y, u.radius, u.radius);
        if (u.team === 0) h0 = ((h0 >>> 31 | h0 << 1) + u.id + 9) | 0;
        else h1 = ((h1 >>> 31 | h1 << 1) + u.id + 9) | 0;
      }
    }
    A.endOcclusion(h0, h1);
  }

  private occSig: number[] = [];
  private occSigLen = -1;

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
      if (this.tick - c.submitTick >= COMMAND_DELAY_TICKS) this.executeCommand(c);
      else cmds[w++] = c;
    }
    cmds.length = w;
  }

  private executeCommand(c: Command): void {
    const p = this.players[c.team];
    if (c.cost > 0) {
      // Debit min(cost, current) at commit [STAT/OBS: native debit observations].
      const debit = Math.min(c.cost, p.elixir);
      p.elixir -= debit;
      p.pending -= c.cost;
    }
    const card = c.card;
    if (this.recordEvents) this.events.push({ tick: this.tick, type: 'cast', team: c.team, x: c.x, y: c.y, name: card.name, id: -1 });
    this.castSpell(c.team, card, c.x, c.y);
  }

  /**
   * Tower_castSpell 0xf9f47c [STAT], called at command commit from the player's King tower:
   * projectiles first (rolling SpellAsDeploy ones start at the target point), then the summon,
   * then the area effect object at the target point.
   */
  private castSpell(team: number, card: CardDef, x: number, y: number): void {
    const pd = card.spellProjectile;
    if (pd && pd.pierceRange > 0) {
      // Rolling spells start at the target point (Log, Barbarian Barrel) (A: pierce flight model).
      this.firePierce(team, pd, x, y, 0, team === 0 ? 1000 : -1000, null);
    } else if (pd?.spawnProjectile && pd.spawnProjectile.pierceRange > 0) {
      this.firePierce(team, pd.spawnProjectile, x, y, 0, team === 0 ? 1000 : -1000, null);
    } else if (pd) {
      this.castProjectiles(team, card, x, y);
    }
    if (card.summon.length) this.summonCard(team, card, x, y);
    if (card.areaEffect) this.spawnAreaEffect(team, card.areaEffect, x, y);
  }

  /**
   * Projectile part of 0xf9f47c [STAT]: ProjectileWaves waves of MultipleProjectiles each, delayed
   * by ProjectileWaveInterval per wave and ProjectileInterval per projectile. With several
   * projectiles (Arrows) the first aims at the target and the others at a ring of radius
   * R − 0.6·r (R spell radius, r projectile radius) at 360/(n−1) steps, each jittered by 0.6·r in a
   * random direction (battle RNG) and kept within 0.9·R; one wave shares a hit list so a target is
   * hit once per wave. Each starts at the King tower offset by (dx/4, dy) of its aim offset.
   * The scatter mode is assumed for MultipleProjectiles > 1 (A: spell vt+0x1c0 not decoded).
   */
  private castProjectiles(team: number, card: CardDef, x: number, y: number): void {
    const king = this.players[team].king;
    const kx = king ? king.x : x;
    const ky = king ? king.y : y;
    const R = card.spellRadius;
    const n = Math.max(card.multipleProjectiles, 1);
    const waves = Math.max(card.waves, 1);
    const scatter = n > 1;
    const len = Math.trunc((R * 90) / 100);
    const ringStep = n - 1 !== 0 ? Math.trunc(360 / (n - 1)) : 0;
    const step = Math.trunc(360 / n);
    let waveDelay = 0;
    for (let w = 0; w < waves; w++) {
      let delay = waveDelay;
      let angle = 0;
      const group: number[] | null = scatter ? [] : null;
      for (let k = 0; k < n; k++) {
        const def = (k === 0 && card.firstProjectile) ? card.firstProjectile : card.spellProjectile!;
        let ox = 0;
        let oy = 0;
        if (scatter) {
          let bx = 0;
          let by = 0;
          if (k > 0) [bx, by] = rotate1024(R - Math.trunc((def.radius * 60) / 100), 0, ringStep * (k - 1));
          const [jx, jy] = rotate1024(0, Math.trunc((def.radius * 60) / 100), this.nrng.next(359));
          ox = jx + bx;
          oy = jy + by;
          const l2 = ox * ox + oy * oy;
          if (len * len < l2) {
            const l = isqrt(l2);
            if (l !== 0) { ox = idiv(ox * len, l); oy = idiv(oy * len, l); }
          }
        } else if (k > 0) {
          const rr = this.nrng.next(R - (R >> 2)) + (R >> 2);
          [ox, oy] = rotate1024(rr, 0, angle);
        }
        const pr = new Projectile(this.nextProjId++, def, team, kx + (ox >> 2), ky + oy, this.tick);
        pr.tx = x + ox;
        pr.ty = y + oy;
        pr.spell = card.name;
        pr.delay = delay;
        pr.group = group;
        this.projectiles.push(pr);
        delay += card.projectileInterval;
        angle += step;
      }
      waveDelay += card.waveInterval;
    }
  }

  /**
   * Deploy_summon 0xd423bc [STAT]: summon index i = 0..total-1 over SummonCharacter (SummonNumber),
   * SummonCharacterSecond (its count) and SummonCharactersList. Circle-group members take
   * Deploy_formationOffset 0xd42ce0 (ring of the first character's radius, line for SummonWidth,
   * authored for the top side and negated for team 0, mirrored by lane); list members take
   * SummonCharactersOffsetsX/Y (negated for team 0, Spell_summonOffset 0xe7e8f8). Ground units are
   * clamped into the deploy zone's y range (A: own half and pockets). Deploy delays: the delay list
   * for list members, else SummonDeployDelay·i (buildings: SummonDeployDelay each), the second
   * group SummonDeployDelaySecond·(1 + i − SummonNumber); then DeployTime.
   */
  private summonCard(team: number, card: CardDef, x: number, y: number): void {
    const sp = card.spec;
    const n1 = sp.main ? sp.number : 0;
    const n2 = sp.second ? sp.secondCount : 0;
    const nCircle = n1 + n2;
    const total = nCircle + sp.list.length;
    if (total === 0) return;
    const unitAt = (i: number): UnitDef => {
      const k = i - nCircle;
      if (k >= 0 && k < sp.list.length) return sp.list[k];
      return (i >= n1 && sp.second ? sp.second : sp.main)!;
    };
    const d0 = unitAt(0);
    const r = sp.radius !== 0 ? sp.radius : d0.spawnRadius !== 0 ? d0.spawnRadius : d0.collisionRadius;
    const negY = team === 0;
    const lane = this.laneOf(x, y);
    const zone = this.summonZone(team, x, card);
    for (let i = 0; i < total; i++) {
      const def = unitAt(i);
      let ox: number;
      let oy: number;
      if (i < nCircle) {
        [ox, oy] = formationOffset(i, sp.number, r, sp.width, negY, lane, d0.spawnAngleShift, sp.secondCount, this.laneSeqDeploy);
      } else {
        const k = i - nCircle;
        const sx = sp.offsetsX[k] ?? 0;
        const sy = sp.offsetsY[k] ?? 0;
        ox = negY ? -sx : sx;
        oy = negY ? -sy : sy;
      }
      let ux = x + ox;
      let uy = y + oy;
      if (!def.flyingHeight && !this.fixture) uy = clamp(uy, zone[0], zone[1]);
      ux = clamp(ux, 0, this.boundW - 1);
      uy = clamp(uy, 0, this.boundH - 1);
      const entry = card.summon.find((e) => e.unit === def) ?? null;
      const deployMs = entry && entry.deployTime >= 0 ? entry.deployTime : def.deployTime;
      if (def.spawnPathfindSpeed > 0 && !this.fixture) {
        // Miner / drill: tunnel from the King tower, then deploy at the target (D speed; path A).
        const king = this.players[team].king;
        const u = this.createUnit(team, card.name, def, king.x, king.y, Math.round(deployMs / TICK_MS));
        u.tunneling = true;
        u.tunnelX = ux;
        u.tunnelY = uy;
        continue;
      }
      let wait = 0;
      if (deployMs > 0) {
        const k = i - nCircle;
        if (k >= 0 && sp.delayList.length >= 1 && sp.delayList[Math.min(k, sp.delayList.length - 1)] >= 1) {
          wait = sp.delayList[Math.min(k, sp.delayList.length - 1)];
        } else if (sp.deployDelay >= 1 && d0.kind === 'building') {
          wait = sp.deployDelay;
        } else if (i === 0 || sp.deployDelay < 1) {
          if (sp.deployDelaySecond > 0 && sp.number <= i) wait = sp.deployDelaySecond + sp.deployDelaySecond * (i - sp.number);
        } else {
          wait = sp.deployDelay * i;
        }
      }
      this.createUnit(team, card.name, def, ux, uy, Math.round(wait / TICK_MS) + Math.round(deployMs / TICK_MS));
    }
  }

  /** Deploy-zone y range for summoned ground units (0xfa023c; A: own half plus destroyed-tower pockets). */
  private summonZone(team: number, x: number, card: CardDef): [number, number] {
    if (card.canDeployOnEnemySide || this.fixture) return [0, ARENA_H - 1];
    const enemy = this.players[1 - team];
    const left = x < ARENA_W / 2;
    const tower = enemy.princess[left ? 0 : 1];
    if (team === 0) return [0, tower.alive ? 14999 : 24999];
    return [tower.alive ? 17000 : 7000, ARENA_H - 1];
  }

  /**
   * Spawn a summoned group. The actor joins the live list on the tick after commit and is
   * active DeployTime later [OBS: 117 commit -> 118 live -> 138 moving]. Group members are
   * staggered by SummonDeployDelay [OBS: Barbarians 145,147,...]. Formation positions on a
   * circle of SummonRadius are an approximation (A).
   */
  private summon(team: number, card: string, def: UnitDef, count: number, radius: number, delayMs: number, x: number, y: number,
    entry: SummonEntry | null = null, slot0 = 0, slots = count): void {
    const r = slots > 1 ? (radius > 0 ? radius : 500) : 0;
    const deployMs = entry && entry.deployTime >= 0 ? entry.deployTime : def.deployTime;
    if (def.spawnPathfindSpeed > 0 && !this.fixture) {
      // Miner / drill: tunnel from the King tower, then deploy at the target (D speed; path A).
      const king = this.players[team].king;
      const u = this.createUnit(team, card, def, king.x, king.y, Math.round(deployMs / TICK_MS));
      u.tunneling = true;
      u.tunnelX = x;
      u.tunnelY = y;
      return;
    }
    for (let i = 0; i < count; i++) {
      let ux = x;
      let uy = y;
      if (r > 0) {
        // start at 180 deg (left) and go around; team 1 mirrored
        const deg = 180 + Math.floor(((slot0 + i) * 360) / slots);
        ux = x + idiv(cos1e6(deg) * r, 1000000) * (team === 0 ? 1 : -1);
        uy = y + idiv(sin1e6(deg) * r, 1000000) * (team === 0 ? 1 : -1);
        ux = clamp(ux, 0, ARENA_W - 1);
        uy = clamp(uy, 0, ARENA_H - 1);
        if (!def.flyingHeight && !this.arena.walkableAt(ux, uy)) { ux = x; uy = y; }
      }
      this.createUnit(team, card, def, ux, uy, Math.round(deployMs / TICK_MS) + Math.round((i * delayMs) / TICK_MS));
    }
  }

  /** Create an actor; it joins the live list at the end of this tick. */
  private createUnit(team: number, card: string, def: UnitDef, x: number, y: number, deployTicks: number): Unit {
    const u = new Unit(this.nextId++, def, card, team, x, y, this.tick + 1);
    u.lane = this.laneOf(x, y);
    u.deployTicks = deployTicks;
    u.deployTotal = deployTicks;
    this.newUnits.push(u);
    if (this.recordEvents) this.events.push({ tick: this.tick, type: 'spawn', team, x, y, name: def.name, id: u.id });
    return u;
  }

  /** Point on a circle around (x, y); team 1 mirrored. Falls back to the centre if not standable. */
  private ringPos(team: number, x: number, y: number, r: number, deg: number, air: boolean): [number, number] {
    const s = team === 0 ? 1 : -1;
    let px = clamp(x + s * idiv(cos1e6(deg) * r, 1000000), 0, this.boundW - 1);
    let py = clamp(y + s * idiv(sin1e6(deg) * r, 1000000), 0, this.boundH - 1);
    if (!air && !this.fixture && !this.arena.walkableAt(px, py)) { px = x; py = y; }
    return [px, py];
  }

  /**
   * Death spawns: DeathSpawnCount units on a circle of DeathSpawnRadius (centre for one),
   * deploying for DeathSpawnDeployTime or their own DeployTime (D; positions A).
   */
  private deathSpawn(t: Unit): void {
    const ds = t.def.deathSpawn!;
    const ticks = Math.round((ds.deployTime >= 0 ? ds.deployTime : ds.unit.deployTime) / TICK_MS);
    for (let i = 0; i < ds.count; i++) {
      const [x, y] = ds.count > 1 && ds.radius > 0
        ? this.ringPos(t.team, t.x, t.y, ds.radius, 180 + Math.floor((i * 360) / ds.count), ds.unit.flyingHeight > 0)
        : [t.x, t.y];
      this.createUnit(t.team, t.card, ds.unit, x, y, ticks);
    }
  }

  /**
   * Spawners (Witch, Night Witch, Tombstone, huts): a group of SpawnNumber every SpawnPauseTime,
   * the first after SpawnStartTime (else SpawnPauseTime), members SpawnInterval apart; timers run
   * at the SpawnSpeedMultiplier rate (D). Placement: on a circle of SpawnRadius starting in front
   * (+SpawnAngleShift), or in front of a building (A).
   */
  private updateSpawner(u: Unit): void {
    const sp = u.def.spawn!;
    const dt = this.spawnDelta(u);
    if (dt <= 0) return;
    u.spawnTimer -= dt;
    if (u.spawnTimer <= 0) {
      u.spawnTimer += sp.pauseTime > 0 ? sp.pauseTime : 1000;
      u.spawnLeft = sp.number;
      u.spawnSub = 0;
      u.spawnIndex = 0;
    }
    if (u.spawnLeft > 0) {
      u.spawnSub -= dt;
      while (u.spawnLeft > 0 && u.spawnSub <= 0) {
        this.spawnMember(u, sp, u.spawnIndex++);
        u.spawnLeft--;
        if (sp.interval > 0) u.spawnSub += sp.interval;
      }
    }
  }

  private spawnMember(u: Unit, sp: NonNullable<UnitDef['spawn']>, index: number): void {
    let x = u.x;
    let y = u.y;
    const air = sp.unit.flyingHeight > 0;
    if (sp.radius > 0) {
      [x, y] = this.ringPos(u.team, u.x, u.y, sp.radius, 90 + sp.angleShift + Math.floor((index * 360) / Math.max(1, sp.number)), air);
    } else if (u.isBuilding) {
      const off = u.radius + sp.unit.collisionRadius;
      const side = sp.number > 1 ? ((index % 3) - 1) * sp.unit.collisionRadius : 0;
      [x, y] = [clamp(u.x + side, 0, this.boundW - 1), clamp(u.y + (u.team === 0 ? off : -off), 0, this.boundH - 1)];
      if (!air && !this.fixture && !this.arena.walkableAt(x, y)) { x = u.x; y = u.y; }
    }
    this.createUnit(u.team, u.card, sp.unit, x, y, Math.round(sp.unit.deployTime / TICK_MS));
  }

  private spawnDelta(u: Unit): number {
    if (u.buffs.length === 0) return TICK_MS;
    let haste = 100;
    let slow = 0;
    for (const b of u.buffs) {
      const m = b.def.spawnSpeedMul;
      if (m >= 100) { if (m > haste) haste = m; } else if (m < 0 && m < slow) slow = m;
    }
    return idiv(idiv(TICK_MS * haste, 100) * clamp(100 + slow, 0, 100), 100);
  }

  private regenElixir(): void {
    const add = this.elixirPerTick();
    for (const p of this.players) {
      if (this.infiniteElixir) { p.elixir = this.maxElixir; continue; }
      p.elixir = Math.min(this.maxElixir, p.elixir + add);
    }
  }

  // ---------------------------------------------------------------- targeting & attack

  /** Legacy filter used by AEO/extra-target code: enemy, alive, targetable, air/ground compatible. */
  private canAttack(u: Unit, t: Unit): boolean {
    if (t.team === u.team || t.state === ST_DEAD || t.maxHp <= 0 || t.hidden || t.tunneling) return false;
    const d = u.def;
    if (t.isAir ? !d.attacksAir : !d.attacksGround) return false;
    if (d.targetOnlyBuildings && !t.isBuilding) return false;
    if (d.targetOnlyTroops && t.isBuilding) return false;
    return true;
  }

  /** getRange 0xfc4afc: Range + own CollisionRadius (ADD_CHARACTER_RANGE_TO_RADIUS) [STAT]. */
  private getRange(u: Unit): number {
    return u.def.range + u.radius;
  }

  /** getMinRange 0xfc4a68: MinimumRange (+ own radius when set) [STAT]. */
  private getMinRange(u: Unit): number {
    const m = u.def.minimumRange;
    return m > 0 ? m + u.radius : m;
  }

  /** AttackComp_inRange 0xfc3f74: dist2 <= (r_t + range + extra)^2, outside min range [STAT]. */
  private inRange(u: Unit, t: Unit, extra: number): boolean {
    const R = this.getRange(u);
    const minR = this.getMinRange(u);
    const rt = t.radius;
    const lim = rt + R + extra;
    const dx = t.x - u.x;
    const dy = t.y - u.y;
    const d2 = dx * dx + dy * dy;
    if (minR < 1) return d2 <= lim * lim;
    return d2 <= lim * lim && (rt + minR) * (rt + minR) <= d2;
  }

  /** Actor_isPointInRange 0xf958e0 [STAT]. */
  private pointInRange(t: Unit, x: number, y: number, range: number, minRange: number, flag: boolean): boolean {
    const rt = t.radius;
    const a = (rt + range) * (rt + range);
    const dx = t.x - x;
    const dy = t.y - y;
    const d2 = dx * dx + dy * dy;
    if (minRange < 1) return flag || d2 <= a;
    const b = (rt + minRange) * (rt + minRange);
    return flag ? b <= d2 : d2 <= a && b <= d2;
  }

  /**
   * AttackComp_isValidTarget 0xfc4008 (subset for implemented mechanics) [STAT]. The pending-damage
   * overkill test for projectile attackers is approximated: a target already covered by in-flight
   * projectile damage is skipped (A on the exact duration rule).
   */
  private isValidTarget(u: Unit, t: Unit | null, checkPending: boolean): boolean {
    if (t === null || t === u) return false;
    if (t.state === ST_DEAD || t.maxHp <= 0) return false;
    if (t.team === u.team) return false;
    if (t.hidden || t.tunneling) return false;
    const d = u.def;
    if (d.targetOnlyBuildings && !t.isBuilding && !(d.attacksAir && !d.attacksGround && t.isAir)) return false;
    if (d.targetOnlyTroops && t.isBuilding) return false;
    if (t.isAir && !d.attacksAir) return false;
    if (!t.isAir && !d.attacksGround && d.attacksAir) return false;
    if (checkPending && d.projectile && t.pending > 0 && t.pending >= t.hp + t.shield) return false;
    return true;
  }

  /**
   * AttackComp_findTarget 0xfc4c38 [STAT]: candidates from the spatial grid in native order;
   * sight = SightRange + own radius, limit per candidate = its radius + sight (+2000 to crown
   * towers); SightClip / SightClipSide limits; nearest by dist2, ties keep the earlier candidate.
   * Without a candidate: the default target (lane crown tower) (A for findDefaultTarget).
   */
  private findTarget(u: Unit): void {
    const d = u.def;
    const sight = d.sightRange + u.radius;
    const minR = this.getMinRange(u);
    const exT = this.extraSightCrownTowers;
    const R = exT + sight; // grid query radius
    const units = this.units;
    let best: Unit | null = null;
    let bestD = 0x7fffffff;
    let bestIdx = -1;
    for (let i = 0; i < units.length; i++) {
      const c = units[i];
      // the grid holds only actors with a collision radius
      if (c.radius <= 0 || !this.isValidTarget(u, c, true)) continue;
      const dx = c.x - u.x;
      const dy = c.y - u.y;
      const d2 = dx * dx + dy * dy;
      let lim = c.radius + sight;
      if (c.tower !== TOWER_NONE) {
        lim += exT;
        const rr = c.radius + R;
        if (d2 >= rr * rr) continue; // strict grid query edge
      }
      if (d2 > lim * lim) continue;
      if (minR > 0 && !this.pointInRange(c, u.x, u.y, 0, minR, true)) continue;
      const clip = d.sightClip;
      if (clip >= 1 && !u.isBuilding) {
        const L = Math.max(0, lim - clip);
        if (u.team === 0 ? dy < -L : dy > L) continue;
      }
      const side = d.sightClipSide;
      if (side > 0 && Math.abs(dx) > Math.max(0, lim - side)) continue;
      if (d2 < bestD || (d2 === bestD && best !== null && this.gridBefore(c, i, best, bestIdx, u.x, u.y, R))) {
        best = c; bestD = d2; bestIdx = i;
      }
    }
    if (best) { this.setTarget(u, best, false, true); return; }
    // Nothing in sight: keep the current target while the path to it runs "backwards"
    // (LOGIC_PATHFIND_BACKWARDS_TRY_KEEP_TARGET), else the default target; an invalid choice leaves
    // the current target unchanged [STAT 0xfc4c38 tail]. Buildings take no default target (A).
    let cand: Unit | null;
    if (u.target && this.mobile(u) && u.pathBack && this.isValidTarget(u, u.target, true)) cand = u.target;
    else cand = u.isBuilding || u.tower !== TOWER_NONE ? null : this.defaultTarget(u);
    if (cand === null) { if (u.isBuilding || u.tower !== TOWER_NONE) this.setTarget(u, null, false, true); return; }
    if (!this.isValidTarget(u, cand, true)) return;
    this.setTarget(u, cand, false, true);
  }

  /**
   * Exact native tie-break for equal distances: does `a` come before `b` in the spatial-grid query
   * order (cells x-outer, y-inner from the query's lower corner; insertion = list order within a
   * cell)? Cells are 1024 units; an actor occupies the cells of its square radius (+250 if mobile).
   */
  private gridBefore(a: Unit, ai: number, b: Unit, bi: number, qx: number, qy: number, R: number): boolean {
    const ka = this.gridKey(a, qx, qy, R);
    const kb = this.gridKey(b, qx, qy, R);
    return ka !== kb ? ka < kb : ai < bi;
  }

  private gridKey(a: Unit, qx: number, qy: number, R: number): number {
    const gw = this.grid.w;
    const gh = this.grid.h;
    let qx0 = (qx - R) >> 10;
    let qy0 = (qy - R) >> 10;
    let qy1 = (qy + R) >> 10;
    if (qx0 < 0) qx0 = 0;
    if (qy0 < 0) qy0 = 0;
    if (qy1 >= gh) qy1 = gh - 1;
    const r = a.radius + (a.def.speed > 0 ? 250 : 0);
    let ax0 = (a.x - r) >> 10;
    let ay0 = (a.y - r) >> 10;
    if (ax0 < 0) ax0 = 0;
    if (ay0 < 0) ay0 = 0;
    if (ax0 >= gw) ax0 = gw - 1;
    // first occupied cell inside the query rectangle in scan order
    const cx = Math.max(ax0, qx0);
    const cy = Math.max(ay0, qy0);
    return (cx - qx0) * (qy1 - qy0 + 1) + (cy - qy0);
  }

  /**
   * AttackComp_findDefaultTarget 0xfc5398 with LOGIC_XPOS_BASED_TOWER_TARGETING and
   * LOGIC_PRINCESS_TOWERS_ALWAYS_AS_DEFAULT_TARGET [STAT]: the enemy princess tower on the unit's
   * lane with the smallest |dx|, if it is nearer than the enemy King (and valid), else the King.
   */
  private defaultTarget(u: Unit): Unit | null {
    if (this.fixture) return null;
    const enemy = this.players[1 - u.team];
    const K = enemy.king.alive ? enemy.king : null;
    let dK = 0x7fffffff;
    if (K) { const dx = K.x - u.x; const dy = K.y - u.y; dK = dx * dx + dy * dy; }
    let best: Unit | null = null;
    let bx = 0x7fffffff;
    for (const t of enemy.princess) {
      if (!t.alive || t.lane !== u.lane) continue;
      const ax = t.x > u.x ? t.x - u.x : u.x - t.x;
      if (ax < bx) { best = t; bx = ax; }
    }
    if (best) {
      const dx = best.x - u.x;
      const dy = best.y - u.y;
      const L = isqrt(dx * dx + dy * dy);
      if (L * L < dK) return this.isValidTarget(u, best, true) ? best : K;
    }
    return K;
  }

  /** Lane id at spawn (0xd38d9c with no hint) [STAT]: lane bits of the nearest road cell (first in x-outer scan). */
  laneOf(x: number, y: number): number {
    const A = this.arena;
    const x0 = trunc(x / CELL);
    const y0 = trunc(y / CELL);
    const key = x0 * 65536 + y0;
    const hit = this.laneCache.get(key);
    if (hit !== undefined) return hit;
    let best = 0x7fffffff;
    let lane = 0;
    for (let cx = 0; cx < A.w; cx++) {
      for (let cy = 0; cy < A.h; cy++) {
        const v = A.flags[cx + A.w * cy] & 3;
        if (v <= 0) continue;
        const d = (cx - x0) * (cx - x0) + (cy - y0) * (cy - y0);
        if (d < best) { best = d; lane = v; }
      }
    }
    this.laneCache.set(key, lane);
    return lane;
  }

  private laneCache = new Map<number, number>();

  /** resetAttack(): timer 0, hit/loaded/finish flags cleared [STAT]. */
  private resetAttack(u: Unit): void {
    u.atkTimer = 0;
    u.hitStarted = false;
    u.loaded = false;
    u.finishMs = 0;
  }

  /** AttackComp_setTarget 0xfc3cb4 (paths for implemented mechanics) [STAT]. */
  private setTarget(u: Unit, t: Unit | null, force: boolean, fromSearch: boolean): void {
    if (u.target === t && !force) return;
    u.target = t;
    if (t === null) {
      // ordinary troop: timer kept (LoadFirstHit/LoadAfterRetarget units not supported yet)
    } else if (!this.pointInRange(t, u.x, u.y, this.getRange(u), this.getMinRange(u), false)) {
      this.resetAttack(u); // new target out of range
    }
    // new target in range: timer kept [OBS: native Knight retargeted at tick 3, hit at tick 9]
    u.rampMs = 0;
    // every target change requests a path (0xfc3cb4 -> 0xfcca18) unless an attack is finishing
    if (u.finishMs === 0 && this.mobile(u) && u.state !== ST_DEAD) this.requestPath(u);
    void fromSearch;
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

  /** Movement speed vtb8 0xf82a18 with buffScale 0xfc26d4 and charge multiplier [STAT]. */
  private moveSpeed(u: Unit): number {
    let v = u.def.speed;
    if (u.buffs.length) {
      let haste = 100;
      let slow = 0;
      for (const b of u.buffs) {
        const m = b.def.speedMul;
        if (m >= 100) { if (m > haste) haste = m; } else if (m < 0 && m < slow) slow = m;
      }
      v = idiv(idiv(v * haste, 100) * clamp(100 + slow, 0, 100), 100);
    }
    if (u.charge >= 10000 && u.def.chargeSpeedMul > 0) v = idiv(u.def.chargeSpeedMul * v, 100);
    return v;
  }

  /** AttackComp_advanceClock 0xfc90b0 [STAT]. */
  private advanceClock(u: Unit): void {
    const dt = this.clockDelta(u);
    if (dt <= 0) { u.loaded = false; return; }
    const HS = u.def.hitSpeed;
    let t = u.atkTimer;
    if (t === 0 && !u.chargeHit) {
      if (u.atkDelay > 0) { u.atkDelay = Math.max(u.atkDelay, 50) - 50; u.loaded = false; return; }
      const LT = u.def.loadTime;
      if (HS < LT) {
        if (u.load > HS) { u.atkTimer = 0; u.loaded = false; return; }
        if (u.target) u.loaded = true;
        u.load = 0;
        t = 0;
      } else {
        t = LT - u.load;
        u.load = LT;
        if (t % HS < LT) u.loaded = false;
        else if (u.target) u.loaded = true;
      }
    }
    if (u.chargeHit) {
      // charged: the swing completes at once (attack+0x3f) [STAT 0xfc90b0]
      u.atkTimer = HS + Math.floor(t / HS) * HS;
      u.chargeHit = false;
    } else {
      u.atkTimer = t + dt;
    }
  }

  /** AttackComp_update 0xfc7e20 (ordinary attack path) [STAT]. Runs for every actor before movement. */
  private attackUpdate(u: Unit): void {
    if (u.state !== ST_ACTIVE || u.tunneling) return;
    if (u.tower === TOWER_KING && u.kingState !== KING_ACTIVE) return;
    const d = u.def;
    if (d.hitSpeed <= 0) return;
    u.load = Math.max(u.load, 50) - 50;
    u.retargetCd = Math.max(u.retargetCd, 50) - 50;
    if (u.hidden) return;
    if (u.buffs.length && this.clockDelta(u) === 0) { u.locked = false; return; } // frozen / stunned
    if (u.target) { u.tsx = u.target.x; u.tsy = u.target.y; }
    // keep-target test
    let keep = false;
    const tg = u.target;
    if (tg) {
      const ext = !u.isBuilding ? this.keepTargetExt : 0;
      keep = tg.state !== ST_DEAD && this.inRange(u, tg, ext);
      if (!keep && d.projectile && d.hitSpeed !== 0 && u.atkTimer % d.hitSpeed > 50 && tg.state !== ST_DEAD) {
        keep = this.inRange(u, tg, 500); // LOGIC_PRESERVE_TARGET_IF_HIT_STARTED (ranged, mid-swing)
      }
    }
    if (!(tg && keep && this.isValidTarget(u, tg, true))) {
      if (u.retargetCd === 0 && u.finishMs === 0) this.findTarget(u);
      if (u.target) { u.tsx = u.target.x; u.tsy = u.target.y; }
    }
    if (u.jumping) { this.resetAttack(u); u.locked = false; return; } // states 3/5: no attack
    const t = u.target;
    if (!t && !u.loaded) {
      if (u.finishMs > 0) {
        u.finishMs += 50;
        if (u.finishMs < 250) return; // ATTACK_FINISH_TIME_MS
        this.resetAttack(u);
        u.locked = false;
        return;
      }
      this.resetAttack(u);
      u.locked = false;
      return;
    }
    const HS = d.hitSpeed;
    const t0 = u.atkTimer;
    const inR = t ? this.inRange(u, t, 0) : false;
    const hitStarted = u.atkTimer % HS > 50;
    // no swing while knocked back (m+0x1fc); otherwise in range or mid-swing
    const doSwing = !u.kbActive && (inR || hitStarted);
    if (!doSwing) {
      // not swinging: the attack resets and the unit resumes walking [STAT 0xfc7e20 LAB_00fc8b54]
      this.resetAttack(u);
      u.locked = false;
      return;
    }
    u.locked = true;
    const q0 = Math.floor(t0 / HS);
    if (t) { u.dirX = t.x - u.x; u.dirY = t.y - u.y; }
    const before = u.atkTimer;
    this.advanceClock(u);
    if (d.variableDamage && t) u.rampMs += u.atkTimer - before;
    const q1 = Math.floor(u.atkTimer / HS);
    u.hitStarted = u.atkTimer % HS > 50;
    const doHit = q0 < q1 && (t !== null || u.loaded);
    if (!doHit) return;
    u.hitStarted = false;
    u.loaded = false;
    this.execute(u, t);
  }

  /** AttackComp_execute 0xfc619c + meleeHit 0xfc7080 (implemented paths) [STAT]. */
  private execute(u: Unit, t: Unit | null): void {
    const d = u.def;
    u.lastHitTick = this.tick;
    // LOGIC_CANCEL_HIT_FROM_LONG_DISTANCE: target beyond range + 1500 -> no damage
    const cancelled = !u.isBuilding && t !== null && !this.pointInRange(t, u.x, u.y, 1500 + this.getRange(u), 0, false);
    u.load = d.loadTime; // !LoadFirstHit
    if (this.recordEvents && t) this.events.push({ tick: this.tick, type: d.projectile ? 'shoot' : 'hit', team: u.team, x: t.x, y: t.y, name: d.name, id: u.id });
    if (!cancelled && t) {
      if (d.projectile) {
        this.fireProjectile(u, t, d.projectile);
      } else {
        let dmg = u.charge >= 10000 && d.damageSpecial > 0 ? d.damageSpecial : d.damage;
        if (d.variableDamage) {
          // Inferno ramp: Damage, VariableDamage2, VariableDamage3 after VariableDamageTime1/2 (D)
          const [t1, t2] = d.variableDamageTime;
          dmg = u.rampMs < t1 ? d.variableDamage[0] : u.rampMs < t1 + t2 ? d.variableDamage[1] : d.variableDamage[2];
        }
        if (d.areaDamageRadius > 0) {
          const cx = d.selfAsAoeCenter ? u.x : u.tsx;
          const cy = d.selfAsAoeCenter ? u.y : u.tsy;
          this.areaDamage(u.team, cx, cy, d.areaDamageRadius, d.attacksAir, d.attacksGround, dmg, -1, d.crownTowerDamagePercent, 0, false);
        } else {
          this.queueDamage(t, dmg, -1, d.crownTowerDamagePercent);
          if (d.buffOnDamage) this.applyBuff(t, d.buffOnDamage, d.buffOnDamageTime, u.id);
          if (d.multipleTargets > 1) this.extraTargets(u, t, dmg);
        }
      }
    }
    if (u.charge >= 10000) u.charge = 0; // charge spent by the hit
    if (d.kamikaze) {
      u.hp = 0;
      u.state = ST_DEAD;
    }
  }

  /** Electro Wizard: also hit the nearest other enemies in range, up to MultipleTargets (D; order A). */
  private extraTargets(u: Unit, first: Unit, dmg: number): void {
    const d = u.def;
    const units = this.units;
    const picked: Unit[] = [first];
    while (picked.length < d.multipleTargets) {
      let best: Unit | null = null;
      let bestD = 0;
      for (let i = 0; i < units.length; i++) {
        const t = units[i];
        if (picked.includes(t) || !this.canAttack(u, t) || !this.inRange(u, t, 0)) continue;
        const dx = t.x - u.x;
        const dy = t.y - u.y;
        const d2 = dx * dx + dy * dy;
        if (best === null || d2 < bestD) { best = t; bestD = d2; }
      }
      if (best === null) break;
      picked.push(best);
      this.queueDamage(best, dmg, -1, d.crownTowerDamagePercent);
      if (d.buffOnDamage) this.applyBuff(best, d.buffOnDamage, d.buffOnDamageTime, u.id);
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
    if (def.pierceRange > 0) {
      const ddx = dd > 0 ? idiv(dx * 1000, dd) : 0;
      const ddy = dd > 0 ? idiv(dy * 1000, dd) : (u.team === 0 ? 1000 : -1000);
      const pr = this.firePierce(u.team, def, sx, sy, ddx, ddy, u);
      if (def.pingpong) pr.rangeLeft = Math.min(def.pierceRange >> 1, Math.max(def.minDistance, dd));
      return;
    }
    const pr = new Projectile(this.nextProjId++, def, u.team, sx, sy, this.tick);
    pr.sourceId = u.id;
    pr.tx = t.x;
    pr.ty = t.y;
    if (def.homing) {
      pr.target = t;
      if (def.radius <= 0) { t.pending += def.damage; pr.pendingOn = t; }
    }
    this.projectiles.push(pr);
  }

  /** Straight piercing flight (Bowler boulder, Executioner axe, Magic Archer arrow, Log). */
  private firePierce(team: number, def: ProjectileDef, x: number, y: number, dirX: number, dirY: number, src: Unit | null): Projectile {
    const pr = new Projectile(this.nextProjId++, def, team, x, y, this.tick);
    pr.pierce = true;
    pr.dirX = dirX;
    pr.dirY = dirY;
    pr.rangeLeft = def.pierceRange;
    pr.source = src;
    pr.sourceId = src ? src.id : -1;
    pr.tx = x + idiv(dirX * def.pierceRange, 1000);
    pr.ty = y + idiv(dirY * def.pierceRange, 1000);
    this.projectiles.push(pr);
    return pr;
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
    buff: BuffDef | null = null, buffTime = 0, sourceId = -1, ignore: number[] | null = null): void {
    const units = this.units;
    for (let i = 0; i < units.length; i++) {
      const t = units[i];
      if (t.team === team || t.state === ST_DEAD) continue;
      if (t.isAir ? !air : !ground) continue;
      const dx = t.x - x;
      const dy = t.y - y;
      const d2 = dx * dx + dy * dy;
      // Actor_circleOverlapSq: circle dist2 < (r_a + R)^2; buildings by the closest point of their square [STAT]
      if (t.isBuilding) {
        const r0 = t.radius;
        const ex = clamp(x, t.x - r0, t.x + r0) - x;
        const ey = clamp(y, t.y - r0, t.y + r0) - y;
        if (ex * ex + ey * ey >= radius * radius) continue;
      } else {
        const r = radius + t.radius;
        if (d2 >= r * r) continue;
      }
      if (t.maxHp <= 0 || t.hidden || t.tunneling) continue;
      if (ignore) { if (ignore.includes(t.id)) continue; ignore.push(t.id); }
      this.queueDamage(t, damage, towerDamage, pct);
      if (buff) this.applyBuff(t, buff, buffTime, sourceId);
      if (pushback > 0) this.applyPushback(t, x, y, pushback, pushAll); // World_areaDamage 0xf97be8
    }
  }

  // ---------------------------------------------------------------- actors & movement

  private updateActor(u: Unit): void {
    if (u.state === ST_DEAD) return;
    if (u.tunneling) { this.tunnel(u); return; }
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
    if (u.def.spawn) this.updateSpawner(u);
    if (u.def.manaCollect > 0 && !this.fixture && --u.manaTimer <= 0) {
      // Elixir Collector: ManaCollectAmount every ManaGenerateTimeMs (D)
      u.manaTimer = Math.max(1, Math.round(u.def.manaPeriod / TICK_MS));
      const p = this.players[u.team];
      p.elixir = Math.min(this.maxElixir, p.elixir + u.def.manaCollect);
    }
    if (u.def.hides) this.updateHiding(u);
  }

  /** Native actor state for the movement predicates (actor+0x11c): 4 deploying, 2 attacking, 1 walking. */
  private nativeState(u: Unit): number {
    return u.state === ST_DEPLOYING ? 4 : u.jumping ? 5 : u.locked ? 2 : 1;
  }

  /** Has a movement component (Speed > 0 characters). */
  private mobile(u: Unit): boolean {
    return !u.isBuilding && u.def.speed > 0;
  }

  /**
   * MovementComp_update 0xfcc578 [STAT]: knockback phase; path request while walking (0xfcca18);
   * avoidance sidestep (0xfce42c) and its decay; collision push (0xfce900); speed (vtb8, 0 unless
   * walking) with stop-and-go (StopMovementAfterMS/WaitMS); path waypoints in sub-steps of at most
   * 250 units, each through geometricStep; without a path one step toward getWaypoint (0xfcedb0).
   */
  private movementUpdate(u: Unit): void {
    if (u.state === ST_DEAD || u.tunneling || !this.mobile(u)) return;
    if (u.kbActive) { this.knockbackStep(u); return; }
    const st = this.nativeState(u);
    if (st === 5) { this.jumpStep(u); return; }
    if (st === 1) this.requestPath(u);
    if (st !== 2) this.avoidSidestep(u); // vtd0: not in states 0,2,3,5..8,10,12,13
    const s = u.sidestep;
    u.sidestep = s < 1 ? (s > -11 ? 0 : s + 10) : (s < 11 ? 0 : s - 10);
    this.collidePush(u); // vtd8: every state here
    let speed = st === 1 ? this.moveSpeed(u) : 0;
    const facing = st === 1; // vtc8
    u.moving = false;
    if (speed > 0) {
      // stop-and-go walking clock (movement +0x1f0) [STAT]
      u.walkMs += u.buffs.length ? idiv(this.speedScale(u, 100), 2) : 50;
      const sma = u.def.stopMoveMs;
      if (sma > 0 && u.walkMs > sma) {
        const cycle = sma + u.def.waitMs;
        if (cycle <= u.walkMs) u.walkMs -= cycle;
        else speed = 0;
      }
    }
    if (u.pathIdx < u.path.length && !(u.def.flyDirectPaths && u.isAir && u.target)) {
      if (speed < -249) return;
      const n = idiv(speed, 250);
      let rem = speed;
      for (let i = 0; ; i++) {
        const wp = u.path[u.pathIdx];
        const step = speed >= 250 ? (rem > 249 ? 250 : rem) : rem;
        const reached = this.geometricStep(u, this.cellX(wp), this.cellY(wp), step, facing, false);
        if (reached) {
          u.pathIdx++;
          this.advancePath(u);
          if (u.def.jumpEnabled && u.path.length - u.pathIdx > 1) this.maybeJump(u);
        }
        if (n <= i) return;
        rem -= 250;
        if (u.pathIdx >= u.path.length) return;
      }
    }
    this.waypoint(u);
    this.geometricStep(u, this.wpX, this.wpY, speed, facing, false);
  }

  /**
   * River jump start (0xfcc578 after a reached waypoint, 0xfcf594) [STAT]: when the next path cell is
   * water, jump to the first non-water cell further along the path (or the goal); state 5.
   */
  private maybeJump(u: Unit): void {
    const A = this.arena;
    const W = A.w;
    const next = u.path[u.pathIdx];
    if (!A.waterCell(next % W, Math.floor(next / W))) return;
    let land = u.path[u.path.length - 1];
    for (let i = u.pathIdx + 1; i < u.path.length; i++) {
      const c = u.path[i];
      if (!A.waterCell(c % W, Math.floor(c / W))) { land = c; break; }
    }
    u.path = Int32Array.of(land);
    u.pathIdx = 0;
    this.advancePath(u);
    const dx = this.cellX(land) - u.x;
    const dy = this.cellY(land) - u.y;
    u.jumpTotal = isqrt(dx * dx + dy * dy);
    u.jumping = true;
  }

  /** Jump state 5 of 0xfcc578 [STAT]: JumpSpeed steps toward the landing cell; ends when < 2 steps remain. */
  private jumpStep(u: Unit): void {
    const speed = u.def.jumpSpeed;
    if (speed === 0) return;
    let wx = u.x;
    let wy = u.y;
    if (u.pathIdx < u.path.length) { wx = this.cellX(u.path[u.pathIdx]); wy = this.cellY(u.path[u.pathIdx]); }
    this.geometricStep(u, wx, wy, speed, true, false);
    u.moving = true;
    const dx = wx - u.x;
    const dy = wy - u.y;
    if (idiv(isqrt(dx * dx + dy * dy), speed) < 2) u.jumping = false;
  }

  private cellX(c: number): number {
    return (c % this.arena.w) * CELL + (CELL >> 1);
  }

  private cellY(c: number): number {
    return Math.floor(c / this.arena.w) * CELL + (CELL >> 1);
  }

  /** Buff speed scale 0xfc26d4: haste/slow over active buffs, integer truncation [STAT]. */
  private speedScale(u: Unit, v: number): number {
    let haste = 100;
    let slow = 0;
    for (const b of u.buffs) {
      const m = b.def.speedMul;
      if (m >= 100) { if (m > haste) haste = m; } else if (m < 0 && m < slow) slow = m;
    }
    return idiv(idiv(v * haste, 100) * clamp(100 + slow, 0, 100), 100);
  }

  private wpX = 0;
  private wpY = 0;

  /**
   * Movement_getWaypoint 0xfcedb0 without a path [STAT]: no target, or the target already in range:
   * stand (own position); else the approach point target + (self - target) scaled to the approach
   * distance (vt128 = Range + own radius).
   */
  private waypoint(u: Unit): void {
    const t = u.target;
    if (!t || (!(u.def.flyDirectPaths && u.isAir) && this.inRange(u, t, 0))) {
      this.wpX = u.x;
      this.wpY = u.y;
      return;
    }
    let vx = u.x - t.x;
    let vy = u.y - t.y;
    if (isqrt(vx * vx + vy * vy) === 0) vy = 1;
    const l = isqrt(vx * vx + vy * vy);
    const R = this.getRange(u);
    if (l !== 0) { vx = idiv(vx * R, l); vy = idiv(vy * R, l); }
    this.wpX = t.x + vx;
    this.wpY = t.y + vy;
  }

  /**
   * Movement_requestPath 0xfcca18 [STAT]: goal cell from 0xfcdefc (or, if none, the target's raw
   * coordinates, as natively); keep the current path while its goal cell is unchanged, unless the
   * friendly occlusion changed (ground units); flyers get the goal cell alone; ground units run
   * A* (keeping the old path when the occlusion change touches neither path), then the path flag
   * 0xfcf680 and advancePath 0xfcddb8. Without a target the default lane goal (0xd43a4c) is not
   * ported: the path is kept (A).
   */
  private requestPath(u: Unit): void {
    const t = u.target;
    if (!t) return;
    const A = this.arena;
    const W = A.w;
    let gx: number;
    let gy: number;
    const g = this.goalCell(u, t, this.getRange(u));
    if (g >= 0) { gx = g >> 16; gy = g & 0xffff; } else { gx = t.x; gy = t.y; }
    const ground = !u.isAir;
    let fresh = true;
    if (u.pathIdx < u.path.length) {
      const goal = u.path[u.path.length - 1];
      if (gx === goal % W && gy === Math.floor(goal / W)) {
        if (!(A.occlusionChanged(u.team) && ground)) return;
        fresh = false;
      }
    }
    if (!ground) {
      u.path = Int32Array.of(gx + W * gy);
      u.pathIdx = 0;
    } else {
      const oldPath = u.path;
      const oldIdx = u.pathIdx;
      u.path = A.findPath(trunc(u.x / CELL), trunc(u.y / CELL), gx, gy, this.pathClass(u));
      u.pathIdx = 0;
      if (!fresh && !A.pathTouchedByOcclusion(oldPath, oldIdx, u.path)) {
        u.path = oldPath;
        u.pathIdx = oldIdx;
      }
      u.pathBack = this.pathBackwards(u, t);
    }
    if (u.pathIdx < u.path.length) this.advancePath(u);
  }

  private pathClass(u: Unit): number {
    return u.def.jumpEnabled || u.def.hovering ? PATH_CROSS : PATH_WALK;
  }

  /**
   * 0xfcdefc [STAT]: the cell to path to for reaching `t` at approach distance R. Cells within
   * R/500+1 of the target's cell, rows ascending, columns from the end nearer the arena's left half
   * (left end when self.x < W*250); a cell qualifies when its centre is within R of the target.
   * Class 2 (ground: not water and not building-occluded; flyers: any) beats class 1; within a class
   * the first strictly nearest centre to self wins. Returns cy | cx << 16, or -1.
   */
  private goalCell(u: Unit, t: Unit, R: number): number {
    const A = this.arena;
    const W = A.w;
    const H = A.h;
    const tx = trunc(t.x / CELL);
    const ty = trunc(t.y / CELL);
    const k = trunc(R / CELL) + 1;
    const cx1 = tx + k >= W - 1 ? W - 1 : tx + k;
    const cy1 = ty + k >= H - 1 ? H - 1 : ty + k;
    const cy0 = ty - k < 0 ? 0 : ty - k;
    const cx0 = tx - k < 0 ? 0 : tx - k;
    if (cy0 > cy1 || cx0 > cx1) return -1;
    const ground = !u.isAir;
    const avoid = ground && this.avoidBuildings;
    const classify = ground || !this.flyingNoWater;
    const fromRight = W * 250 <= u.x;
    const R2 = R * R;
    // Exact fast path: the native result is the class-2 cell with the smallest dist2 to self, ties
    // to the earlier row, then the earlier column in scan order. Per row the qualifying columns form
    // an interval; visit them by increasing distance to self.x (ties in scan order) and stop at the
    // first class-2 cell. Rows are taken in ascending order and only a strictly smaller dist2 wins.
    let bestD = 0x7fffffff;
    let best = -1;
    for (let cy = cy0; cy <= cy1; cy++) {
      const py = cy * CELL + 250;
      const dty = py - t.y;
      const m = R2 - dty * dty;
      if (m < 0) continue;
      const sq = isqrt(m);
      let a = ceilDiv(t.x - sq - 250, CELL);
      let b = floorDiv(t.x + sq - 250, CELL);
      if (a < cx0) a = cx0;
      if (b > cx1) b = cx1;
      if (a > b) continue;
      const dsy = py - u.y;
      const dsy2 = dsy * dsy;
      if (dsy2 >= bestD) continue;
      // L walks left from the last column whose centre is <= self.x, Rr walks right from the next
      let L = floorDiv(u.x - 250, CELL);
      let Rr = L + 1;
      if (L > b) { L = b; Rr = b + 1; }
      if (Rr < a) { Rr = a; L = a - 1; }
      for (;;) {
        const okL = L >= a;
        const okR = Rr <= b;
        if (!okL && !okR) break;
        let c: number;
        if (okL && okR) {
          const dl = u.x - (L * CELL + 250);
          const dr = (Rr * CELL + 250) - u.x;
          const dlA = dl < 0 ? -dl : dl;
          const drA = dr < 0 ? -dr : dr;
          if (dlA < drA || (dlA === drA && !fromRight)) c = L--; else c = Rr++;
        } else if (okL) c = L--; else c = Rr++;
        const dsx = c * CELL + 250 - u.x;
        const d = dsx * dsx + dsy2;
        if (d >= bestD) break; // farther columns cannot win
        if (classify && (A.waterCell(c, cy) || (avoid && A.dynOccluded(c, cy)))) continue;
        bestD = d;
        best = cy | (c << 16);
        break;
      }
    }
    if (best >= 0) return best;
    // No class-2 cell: the native scan, where class-1 cells qualify.
    let bestC = 0;
    bestD = 0x7fffffff;
    for (let cy = cy0; cy <= cy1; cy++) {
      const py = cy * CELL + 250;
      const dty = py - t.y;
      const dsy = py - u.y;
      for (let i = 0; i <= cx1 - cx0; i++) {
        const cx = fromRight ? cx1 - i : cx0 + i;
        const px = cx * CELL + 250;
        const dtx = px - t.x;
        if (dtx * dtx + dty * dty > R2) continue;
        const dsx = px - u.x;
        const d = dsx * dsx + dsy * dsy;
        let c = 2;
        if (classify && (A.waterCell(cx, cy) || (avoid && A.dynOccluded(cx, cy)))) c = 1;
        if (c > bestC || (c === bestC && d < bestD)) { bestC = c; bestD = d; best = cy | (cx << 16); }
      }
    }
    return best;
  }

  /** Reference implementation of 0xfcdefc (the plain native scan), for tests. */
  goalCellReference(u: Unit, t: Unit, R: number): number {
    const A = this.arena;
    const W = A.w;
    const H = A.h;
    const tx = trunc(t.x / CELL);
    const ty = trunc(t.y / CELL);
    const k = trunc(R / CELL) + 1;
    const cx1 = tx + k >= W - 1 ? W - 1 : tx + k;
    const cy1 = ty + k >= H - 1 ? H - 1 : ty + k;
    const cy0 = ty - k < 0 ? 0 : ty - k;
    const cx0 = tx - k < 0 ? 0 : tx - k;
    if (cy0 > cy1 || cx0 > cx1) return -1;
    const ground = !u.isAir;
    const avoid = ground && this.avoidBuildings;
    const classify = ground || !this.flyingNoWater;
    const fromRight = W * 250 <= u.x;
    let bestC = 0;
    let bestD = 0x7fffffff;
    let best = -1;
    for (let cy = cy0; cy <= cy1; cy++) {
      const py = cy * CELL + 250;
      for (let i = 0; i <= cx1 - cx0; i++) {
        const cx = fromRight ? cx1 - i : cx0 + i;
        const px = cx * CELL + 250;
        if ((px - t.x) * (px - t.x) + (py - t.y) * (py - t.y) > R * R) continue;
        const d = (px - u.x) * (px - u.x) + (py - u.y) * (py - u.y);
        let c = 2;
        if (classify && (A.waterCell(cx, cy) || (avoid && A.dynOccluded(cx, cy)))) c = 1;
        if (c > bestC || (c === bestC && d < bestD)) { bestC = c; bestD = d; best = cy | (cx << 16); }
      }
    }
    return best;
  }

  /** 0xfcf680 [STAT]: some remaining path cell lies farther from the target than self does. */
  private pathBackwards(u: Unit, t: Unit): boolean {
    const n = u.path.length - u.pathIdx;
    if (n < 2) return false;
    const sx = t.x - u.x;
    const sy = t.y - u.y;
    const own = isqrt(sx * sx + sy * sy);
    for (let i = u.pathIdx; i < u.path.length; i++) {
      const c = u.path[i];
      const dx = this.cellX(c) - t.x;
      const dy = this.cellY(c) - t.y;
      if (isqrt(dx * dx + dy * dy) > own) return true;
    }
    return false;
  }

  /** 0xfcddb8 [STAT]: unit direction (x256) from the actor to the next waypoint (movement +0x30/+0x34). */
  private advancePath(u: Unit): void {
    if (u.pathIdx >= u.path.length) { u.wpDirX = 0; u.wpDirY = 0; return; }
    const wp = u.path[u.pathIdx];
    const dx = this.cellX(wp) - u.x;
    const dy = this.cellY(wp) - u.y;
    const l = isqrt(dx * dx + dy * dy);
    if (l !== 0) {
      u.wpDirX = idiv(dx * 256, l);
      u.wpDirY = idiv(dy * 256, l);
    } else {
      u.wpDirX = dx;
      u.wpDirY = dy;
    }
  }

  /**
   * Movement_geometricStep 0xfcef48 [STAT]: velocity quantised to 1/256 with step <= 250; facing set
   * to the step direction (length 256); sidestep rotation; plus the averaged collision push (capped at
   * length 150); then Arena_collision. Returns "reached": remaining distance along the waypoint
   * direction < 1001. Charge accrues step*1000/ChargeRange while walking; otherwise it resets.
   */
  private geometricStep(u: Unit, tx: number, ty: number, stepIn: number, setFacing: boolean, flag5: boolean): boolean {
    const dx0 = tx - u.x;
    const dy0 = ty - u.y;
    let dist = isqrt(dx0 * dx0 + dy0 * dy0);
    if (dist < 2) dist = 1;
    let step = stepIn < dist ? stepIn : dist;
    if (step > 249) step = 250;
    let vx = idiv(idiv(dx0 * 256, dist) * step, 256);
    let vy = idiv(idiv(dy0 * 256, dist) * step, 256);
    if (!u.kbActive && setFacing && (dx0 !== 0 || dy0 !== 0)) {
      const l = isqrt(dx0 * dx0 + dy0 * dy0);
      u.dirX = idiv(dx0 * 256, l);
      u.dirY = idiv(dy0 * 256, l);
    }
    const s0 = u.sidestep;
    if (s0 !== 0) {
      const s = s0 > 255 ? 256 : s0 < -255 ? -256 : s0;
      const a = s < 0 ? -s : s;
      let nx = (((256 - a) * vx) >> 8) + ((s * vy) >> 8);
      let ny = (((256 - a) * vy) >> 8) + ((-(vx * s)) >> 8);
      const l = isqrt(nx * nx + ny * ny);
      if (l !== 0) { nx = idiv(nx * step, l); ny = idiv(ny * step, l); }
      vx = nx;
      vy = ny;
    }
    if (u.pushCount >= 1) {
      let px = idiv(u.pushAccX, u.pushCount);
      let py = idiv(u.pushAccY, u.pushCount);
      if (px * px + py * py > 22500) {
        const l = isqrt(px * px + py * py);
        px = idiv(px * 150, l);
        py = idiv(py * 150, l);
      }
      u.pushAccX = 0;
      u.pushAccY = 0;
      u.pushCount = 0;
      vx += px;
      vy += py;
    }
    const ox = u.x;
    const oy = u.y;
    this.arenaCollide(u, vx, vy, false);
    if (step > 0 && setFacing && (u.x !== ox || u.y !== oy)) u.moving = true;
    const remaining = idiv(u.wpDirX * (tx - u.x), 256) + idiv(u.wpDirY * (ty - u.y), 256);
    const cr = u.def.chargeRange / 10; // data ChargeRange
    if (cr > 0) {
      const st = this.nativeState(u);
      if (step < 1 || st !== 1) {
        if (!flag5 && st !== 5) { u.charge = 0; u.chargeHit = false; }
      } else if (u.charge < 10000) {
        u.charge += idiv(step * 1000, cr);
      } else {
        u.chargeHit = true;
      }
    }
    return remaining < 1001;
  }

  /**
   * Arena_collision 0x11d988c with the character override [STAT]: blocking (bit-32 water tiles) is
   * the caller's flag, or for characters (state == deploying && ground). Fixture mode clamps to its
   * bounds the same way the grid edge does.
   */
  private arenaCollide(u: Unit, vx: number, vy: number, block: boolean): void {
    if (!block && u.state === ST_DEPLOYING && !u.isAir) block = true;
    this.arena.collide(u.x, u.y, vx, vy, block, this.colOut);
    u.x = this.colOut.x;
    u.y = this.colOut.y;
  }

  private colOut = { x: 0, y: 0 };

  /**
   * Movement_avoidSidestep 0xfce42c [STAT]: look one facing vector ahead (query radius min(r, 500));
   * a static blocker (no movement component) whose circle covers the next waypoint drops that
   * waypoint; static blockers decide the side by the cross product with the facing, moving ones
   * (not heading the same way, not lighter than a charging self) by theirs or their sidestep.
   * A new sidestep is +-200; with static blockers an existing one is nudged by +-20 (clamped).
   */
  private avoidSidestep(u: Unit): void {
    const fx = u.dirX;
    const fy = u.dirY;
    const qx = u.x + fx;
    const qy = u.y + fy;
    const rq = u.radius < 500 ? u.radius : 500;
    const list = this.gridQuery(qx, qy, rq, u);
    let nStatic = 0;
    let nMoving = 0;
    let sideStatic = 1;
    let sideMoving = 1;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === u || o.isAir !== u.isAir) continue;
      if (!this.avoidsAgainst(o)) continue;
      const cross = fy * (o.x - u.x) + fx * (u.y - o.y);
      if (!this.mobile(o)) {
        const n = u.path.length - u.pathIdx;
        if (n > 1) {
          const wp = u.path[u.pathIdx];
          const ex = this.cellX(wp) - o.x;
          const ey = this.cellY(wp) - o.y;
          if (ex * ex + ey * ey < o.radius * o.radius) u.pathIdx++;
        }
        sideStatic = cross < 0 ? 1 : 0;
        nStatic++;
      } else {
        let dot = o.dirX * fx + o.dirY * fy;
        const ost = this.nativeState(o);
        if (ost === 2) dot = 0; // states 0, 2, 8, 10
        if ((u.charge < 10000 || o.mass >= u.mass) && dot < 1) {
          nMoving++;
          sideMoving = o.sidestep === 0 ? (cross < 0 ? 1 : 0) : (o.sidestep > 0 ? 1 : 0);
        }
      }
    }
    const side = nStatic < 1 ? sideMoving : sideStatic;
    if (nStatic + nMoving > 0) {
      if (u.sidestep === 0) u.sidestep = side ? 200 : -200;
      else if (nStatic >= 1) {
        const v = u.sidestep + (sideStatic ? 20 : -20);
        u.sidestep = v > 199 ? 200 : v < -199 ? -200 : v;
      }
    }
  }

  /** vte8 -> vte0(other, 1) canCollide for avoidance [STAT]: not attached/dashing/jumping. */
  private avoidsAgainst(o: Unit): boolean {
    return o.state !== ST_DEAD && !o.tunneling && !o.jumping;
  }

  /**
   * Grid_queryCircleXY 0xf9b008 [STAT]: actors with a collision radius whose tick-start cells
   * (1024-unit cells of the square radius, +250 when mobile) meet the query's cells, in scan order
   * (cells x-outer, y-inner; list order within a cell), passing dist2 < (r + R)^2 at their live
   * positions. Returns a shared scratch array.
   */
  private gridQuery(qx: number, qy: number, R: number, self: Unit): Unit[] {
    const out = this.scratch;
    out.length = 0;
    const keys = this.scratchKeys;
    keys.length = 0;
    const gw = this.grid.w;
    const gh = this.grid.h;
    let qx0 = (qx - R) >> 10;
    let qy0 = (qy - R) >> 10;
    let qx1 = (qx + R) >> 10;
    let qy1 = (qy + R) >> 10;
    if (qx0 < 0) qx0 = 0;
    if (qy0 < 0) qy0 = 0;
    if (qx1 >= gw) qx1 = gw - 1;
    if (qy1 >= gh) qy1 = gh - 1;
    const units = this.units;
    for (let i = 0; i < units.length; i++) {
      const a = units[i];
      if (a.radius <= 0 || a.state === ST_DEAD || !a.inGrid) continue;
      const dx = a.x - qx;
      const dy = a.y - qy;
      const rr = a.radius + R;
      if (dx >= rr || dx <= -rr || dy >= rr || dy <= -rr || dx * dx + dy * dy >= rr * rr) continue;
      const r = a.radius + (this.mobile(a) ? 250 : 0);
      let ax0 = (a.gx - r) >> 10;
      let ay0 = (a.gy - r) >> 10;
      const ax1 = (a.gx + r) >> 10;
      const ay1 = (a.gy + r) >> 10;
      if (ax0 < 0) ax0 = 0;
      if (ay0 < 0) ay0 = 0;
      if (ax0 > qx1 || ax1 < qx0 || ay0 > qy1 || ay1 < qy0) continue;
      const cx = ax0 > qx0 ? ax0 : qx0;
      const cy = ay0 > qy0 ? ay0 : qy0;
      out.push(a);
      keys.push(((cx - qx0) * (qy1 - qy0 + 1) + (cy - qy0)) * 65536 + i);
    }
    void self;
    if (out.length > 1) {
      // sort by (first cell in scan order, list index)
      const idx = this.scratchIdx;
      idx.length = 0;
      for (let i = 0; i < out.length; i++) idx.push(i);
      idx.sort((p, q) => keys[p] - keys[q]);
      const copy = this.scratch2;
      copy.length = 0;
      for (let i = 0; i < idx.length; i++) copy.push(out[idx[i]]);
      out.length = 0;
      for (let i = 0; i < copy.length; i++) out.push(copy[i]);
    }
    return out;
  }

  private scratchKeys: number[] = [];
  private scratchIdx: number[] = [];

  /**
   * Movement_collidePush 0xfce900 [STAT, arithmetic as decompiled]: neighbours from the grid
   * within radius+20, same layer; penetration min(R - len, 300) x m_other / m_self, at most 299;
   * push += (pen+1) x d / len per neighbour; static neighbours count self radius at most 500.
   * The accumulated push is an integer sum, so the neighbour order does not matter.
   */
  private collidePush(u: Unit): void {
    const r = u.radius;
    if (r === 0 || u.jumping) return;
    const list = this.units;
    const rCap = r < 500 ? r : 500;
    const qr = r + 20;
    const gw = this.grid.w;
    const gh = this.grid.h;
    let qx0 = (u.x - qr) >> 10;
    let qy0 = (u.y - qr) >> 10;
    let qx1 = (u.x + qr) >> 10;
    let qy1 = (u.y + qr) >> 10;
    if (qx0 < 0) qx0 = 0;
    if (qy0 < 0) qy0 = 0;
    if (qx1 >= gw) qx1 = gw - 1;
    if (qy1 >= gh) qy1 = gh - 1;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === u || o.state === ST_DEAD || o.isAir !== u.isAir || o.tunneling || o.radius <= 0) continue;
      if (!o.inGrid || o.jumping) continue; // not in this tick's grid; jumpers do not collide (vte0)
      {
        const qx = o.x - u.x;
        const qy = o.y - u.y;
        const rr = o.radius + qr;
        if (qx >= rr || qx <= -rr || qy >= rr || qy <= -rr || qx * qx + qy * qy >= rr * rr) continue; // grid query test
        const gr = o.radius + (this.mobile(o) ? 250 : 0);
        let ax0 = (o.gx - gr) >> 10;
        let ay0 = (o.gy - gr) >> 10;
        if (ax0 < 0) ax0 = 0;
        if (ay0 < 0) ay0 = 0;
        if (ax0 > qx1 || ((o.gx + gr) >> 10) < qx0 || ay0 > qy1 || ((o.gy + gr) >> 10) < qy0) continue;
      }
      const mo = o.mass;
      const hasMove = this.mobile(o);
      const rs = hasMove ? r : rCap;
      let dx = u.x - o.x;
      let dy = u.y - o.y;
      const R = o.radius + rs;
      if (dx > R || dx < -R || dy > R || dy < -R) continue;
      let d2 = dx * dx + dy * dy;
      if (d2 === 0) { d2 = 1; dx = 0; dy = u.team === 0 ? -1 : 1; }
      if (d2 > R * R) continue;
      let len = isqrt(d2);
      if (len < 2) len = 1;
      const ms = u.mass;
      let pen = R - len;
      if (pen >= 300) pen = 300;
      if (pen < 0) pen = 0;
      pen = ms === 0 ? 0 : idiv(pen * mo, ms);
      if (pen >= 299) pen = 299;
      u.pushAccY += idiv((pen + 1) * dy, len);
      u.pushAccX += idiv((pen + 1) * dx, len);
      u.pushCount++;
    }
  }

  // ---------------------------------------------------------------- knockback

  /**
   * Movement_applyPushback 0xfcfac4 + startPushback 0xfcfbd4 [STAT]: refused while already knocked
   * back, for IgnorePushback units (unless `ignoreImmune`), or without a movement component. The
   * destination is pos + (pos - origin) scaled to min(amount, MAX_PUSHBACK_LENGTH); the step speed
   * starts at the smallest 25n with 25(1+..+n) >= distance and drops by 25 per tick.
   */
  private applyPushback(t: Unit, ox: number, oy: number, amount: number, ignoreImmune: boolean): void {
    if (!this.mobile(t) || t.state === ST_DEAD || t.tunneling) return;
    if (t.kbActive) return;
    if (t.def.ignorePushback && !ignoreImmune) return;
    let dx = t.x - ox;
    const dy = t.y - oy;
    let len = isqrt(dx * dx + dy * dy);
    if (len === 0) { len = 1; dx = t.id & 1 ? -1 : 1; }
    const dist = amount < this.maxPushback ? amount : this.maxPushback;
    t.kbIgnore = ignoreImmune;
    t.kbX = t.x;
    t.kbY = t.y;
    if (len < 1 || dist < 1) { t.kbActive = false; t.kbIgnore = false; return; }
    let s = 0;
    let acc = 0;
    do { s += 25; acc += s; } while (acc < dist);
    t.kbStep = s;
    t.kbX += idiv(dist * dx, len);
    t.kbY += idiv(dist * dy, len);
    t.kbActive = true;
  }

  /** Knockback phase of 0xfcc578 [STAT]: push + dry-land snap while stepping, step -= 25 (ends after -25). */
  private knockbackStep(u: Unit): void {
    if (u.kbStep > 0) {
      this.collidePush(u);
      if (!u.isAir && !u.def.hovering && this.wetOrPad(u.x, u.y)) {
        const p = this.nearestDry(u.x, u.y, -1);
        u.x = p & 0xffff;
        u.y = p >> 16;
      }
    }
    u.kbStep -= 25;
    this.geometricStep(u, u.kbX, u.kbY, u.kbStep, true, u.kbIgnore);
    if (u.kbStep < 0) {
      u.kbActive = false;
      u.pathIdx = u.path.length;
      u.pathBack = false;
    }
  }

  /** 0x11d96c8: outside the arena, a no-deploy/static-building tile (bits 16|64), or water. */
  private wetOrPad(x: number, y: number): boolean {
    const A = this.arena;
    if (x < 0 || y < 0 || x >= A.w * CELL || y >= A.h * CELL) return true;
    return (A.flags[trunc(x / CELL) + A.w * trunc(y / CELL)] & (F_BLOCKED | F_OCCLUDER | F_WATER)) !== 0;
  }

  /**
   * 0xd392c8 [STAT]: clamp into [250, size-250]; if on water, the nearest dry candidate among
   * x + (-2250..2750 step 500), y + 500k + 250 (k = -5..5, or one side when preferY is given).
   * Returns x | y << 16.
   */
  private nearestDry(x: number, y: number, preferY: number): number {
    const A = this.arena;
    const xm = A.w * CELL - 250;
    const ym = A.h * CELL - 250;
    if (x < 251) x = 250;
    if (xm <= x) x = xm;
    if (y < 251) y = 250;
    if (ym <= y) y = ym;
    if (!A.waterCell(trunc(x / CELL), trunc(y / CELL))) return x | (y << 16);
    let k0 = -5;
    let k1 = 5;
    if (preferY !== -1) {
      if (preferY <= y) k1 = y <= preferY ? 5 : 0;
      else k0 = 1;
    }
    let best = 0x7fffffff;
    let bx = x;
    let by = y;
    for (let k = k0; ; k++) {
      const cy = y + k * CELL;
      if (cy > -251) {
        const ny = cy + 250;
        for (let j = -5500; j !== 0; j += 500) {
          const nx = x + j + 3250;
          if (nx > -1 && nx < A.w * CELL && ny < A.h * CELL && !A.waterCell(trunc(nx / CELL), trunc(ny / CELL))) {
            const ex = j + 3250;
            const ey = ny - y;
            const l = isqrt(ex * ex + ey * ey);
            if (l < best) { best = l; bx = nx; by = ny; }
          }
        }
      }
      if (k === k1) break;
    }
    return bx | (by << 16);
  }

  /** Tunnel at SpawnPathfindSpeed in a straight line, then start deploying (A: straight path). */
  private tunnel(u: Unit): void {
    const dx = u.tunnelX - u.x;
    const dy = u.tunnelY - u.y;
    const d = isqrt(dx * dx + dy * dy);
    const sp = u.def.spawnPathfindSpeed;
    if (d <= sp) {
      u.x = u.tunnelX;
      u.y = u.tunnelY;
      u.tunneling = false;
      return;
    }
    u.x += idiv(dx * sp, d);
    u.y += idiv(dy * sp, d);
  }

  /**
   * Tesla: hidden (untargetable) while idle; with an enemy in range it rises for UpTimeMs before
   * attacking, and hides again after HideTimeMs without a target (D times; state machine A).
   */
  private updateHiding(u: Unit): void {
    let t = false;
    for (const c of this.units) if (c.radius > 0 && this.isValidTarget(u, c, false) && this.inRange(u, c, 0)) { t = true; break; }
    if (t) {
      u.idleMs = 0;
      if (u.hidden) {
        u.upMs += TICK_MS;
        if (u.upMs >= u.def.upTime) { u.hidden = false; u.upMs = 0; }
      }
    } else if (!u.hidden) {
      u.idleMs += TICK_MS;
      if (u.idleMs >= u.def.hideTime) { u.hidden = true; u.idleMs = 0; u.target = null; u.locked = false; }
    }
  }

  /**
   * Health component update 0xfc99e0, lifetime decay [STAT]: rate = (maxHp*100000/LifeTime)/20
   * hundredths of HP per tick (0xfc9774), accumulated; whole HP come off when the accumulator
   * reaches 100. Not while deploying. At 0 HP the actor dies at once.
   */
  private healthUpdate(u: Unit): void {
    if (u.state !== ST_ACTIVE || u.hp < 1 || u.tunneling) return;
    const lt = u.def.lifeTime;
    if (lt <= 0 || u.tower !== TOWER_NONE) return;
    const acc = u.decayed + idiv(idiv(u.maxHp * 100000, lt), 20);
    if (acc < 100) { u.decayed = acc; return; }
    u.decayed = acc % 100;
    u.hp -= idiv(acc, 100);
    if (u.hp > 0) return;
    u.hp = 0;
    u.decayed = 0;
    this.kill(u);
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
    const inst = new BuffInst(def, sourceId, ticks, this.tick);
    const raw = this.data.buffs[def.name];
    inst.hitTimer = raw && raw.HitTickFromSource === true ? 0 : def.hitFrequency;
    u.buffs.push(inst);
    if (def.hitSpeedMul <= -100) {
      u.atkTimer = 0;
      u.locked = false;
      u.target = null;
      u.charge = 0;
      u.rampMs = 0;
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

  /** Area effect objects join the world list at the end of the tick; first update next tick. */
  private spawnAreaEffect(team: number, def: AreaEffectDef, x: number, y: number): void {
    const a = new AreaEffect(this.nextAeoId++, def, team, x, y, this.tick);
    this.newAeos.push(a);
    if (this.recordEvents) this.events.push({ tick: this.tick, type: 'aoe', team, x, y, name: def.name, id: a.id });
    if (def.spawnAreaEffect) this.spawnAreaEffect(team, def.spawnAreaEffect, x, y);
  }

  private newAeos: AreaEffect[] = [];

  private filterMatch(f: FilterDef | null, team: number, onlyEnemies: boolean, u: Unit): boolean {
    if (u.state === ST_DEAD || u.maxHp <= 0 || u.tunneling) return false;
    if (u.hidden && (f === null || f.name !== 'aeo_enemy_affects_hidden')) return false;
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
  /**
   * AreaEffect_update 0xf7a34c [STAT]: life -= 50 per update; a pulse when the elapsed updates
   * (LifeDuration - lifeBefore)/50 equal HitSpeedOffset/50, or exceed it by a multiple of HitSpeed/50
   * (HitSpeed >= 50). Targets: circle overlap with the filter, stable-sorted by distance, then by
   * hitpoints + shield (HitBiggestTargets), at most MaximumTargets newly hit; already-hit targets
   * (OneHitPerTarget) are skipped. Per target: pushback (mobile units), damage, buff for BuffTime
   * (capped at life + HitSpeed with CapBuffTimeToAreaEffectTime), per-target projectile. The object
   * is removed once its life is negative.
   */
  private updateAreaEffects(): void {
    const as = this.areaEffects;
    let w = 0;
    for (let i = 0; i < as.length; i++) {
      const a = as[i];
      const def = a.def;
      const before = a.life;
      a.life -= TICK_MS;
      const el = idiv(def.lifeDuration - before, TICK_MS);
      const off = idiv(def.hitSpeedOffset, TICK_MS);
      let pulse = el === off;
      if (!pulse && def.hitSpeed >= TICK_MS && el > off) {
        const per = idiv(def.hitSpeed, TICK_MS);
        pulse = (el - off) % per === 0;
      }
      if (pulse) this.aeoHit(a);
      if (a.life < 0) a.alive = false;
      if (a.alive) as[w++] = a;
    }
    as.length = w;
  }

  private aeoHit(a: AreaEffect): void {
    const def = a.def;
    const units = this.units;
    const targets = this.scratch2;
    targets.length = 0;
    const R = def.radius;
    for (let i = 0; i < units.length; i++) {
      const t = units[i];
      if (t.radius <= 0 && t.tower === TOWER_NONE) continue; // only actors in the spatial grid
      if (!this.filterMatch(def.filter, a.team, def.onlyEnemies, t)) continue;
      // Actor_circleOverlapSq 0xf95084: strict circle test; buildings by their square's closest point
      if (t.isBuilding) {
        const r0 = t.radius;
        const ex = clamp(a.x, t.x - r0, t.x + r0) - a.x;
        const ey = clamp(a.y, t.y - r0, t.y + r0) - a.y;
        if (ex > R || ex < -R || ey > R || ey < -R || ex * ex + ey * ey >= R * R) continue;
      } else {
        const dx = t.x - a.x;
        const dy = t.y - a.y;
        const r = R + t.radius;
        if (dx * dx + dy * dy >= r * r) continue;
      }
      targets.push(t);
    }
    if (targets.length > 1) {
      // stable sorts (0xf7bbec by distance, 0xf7cebc by hitpoints + shield, biggest first)
      const ax = a.x;
      const ay = a.y;
      const keyed = targets.map((t, i) => ({ t, i, d: (t.x - ax) * (t.x - ax) + (t.y - ay) * (t.y - ay) }));
      keyed.sort((p, q) => p.d - q.d || p.i - q.i);
      if (def.hitBiggest) {
        keyed.forEach((k, i) => { k.i = i; });
        keyed.sort((p, q) => (q.t.hp + q.t.shield) - (p.t.hp + p.t.shield) || p.i - q.i);
      }
      for (let i = 0; i < keyed.length; i++) targets[i] = keyed[i].t;
    }
    let left = def.maxTargets > 0 ? def.maxTargets : targets.length;
    for (let i = 0; i < targets.length && left > 0; i++) {
      const t = targets[i];
      if (def.oneHitPerTarget) {
        if (a.hitIds.includes(t.id)) continue;
        a.hitIds.push(t.id);
      }
      if (def.pushback > 0) this.applyPushback(t, a.x, a.y, def.pushback, def.pushbackAll);
      if (def.damage > 0) this.queueDamage(t, def.damage, def.towerDamage, def.crownTowerDamagePercent);
      if (def.buff) {
        let bt = def.buffTime;
        if (def.capBuffTime) bt = Math.min(bt, a.life + def.hitSpeed);
        if (bt > 0) this.applyBuff(t, def.buff, bt, a.id);
      }
      if (def.projectile && def.targetProjectiles) {
        // bolt from ProjectileStartHeight above the target, aimed at it (lands on its first update)
        const pr = new Projectile(this.nextProjId++, def.projectile, a.team, t.x, t.y, this.tick);
        pr.target = t;
        pr.tx = t.x;
        pr.ty = t.y;
        pr.spell = def.name;
        this.projectiles.push(pr);
      }
      left--;
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
      if (p.born !== this.tick) {
        if (p.delay > 0) p.delay = Math.max(p.delay, 50) - 50; // start delay (0xf90708)
        else this.moveProjectile(p);
      }
      if (p.alive) ps[w++] = p;
    }
    ps.length = w;
  }

  private movePierce(p: Projectile): void {
    const def = p.def;
    let step = def.speed;
    if (p.returning && p.source && p.source.state !== ST_DEAD) {
      // fly back toward the thrower
      const dx = p.source.x - p.x;
      const dy = p.source.y - p.y;
      const d = isqrt(dx * dx + dy * dy);
      if (d <= step) { p.x = p.source.x; p.y = p.source.y; p.alive = false; return; }
      p.x += idiv(dx * step, d);
      p.y += idiv(dy * step, d);
    } else {
      if (step > p.rangeLeft) step = p.rangeLeft;
      p.x += idiv(p.dirX * step, 1000);
      p.y += idiv(p.dirY * step, 1000);
      p.rangeLeft -= step;
    }
    // hit every eligible enemy the hitbox touches, once per pass
    const rx = def.pierceRadius;
    const ry = def.pierceRadiusY;
    const units = this.units;
    for (let i = 0; i < units.length; i++) {
      const t = units[i];
      if (t.team === p.team || t.state === ST_DEAD || t.maxHp <= 0 || t.hidden || t.tunneling) continue;
      if (t.isAir ? !def.aoeToAir : !def.aoeToGround) continue;
      if (p.hitIds.includes(t.id)) continue;
      const dx = t.x - p.x;
      const dy = t.y - p.y;
      let inside: boolean;
      if (ry > 0) inside = Math.abs(dx) <= rx + t.radius && Math.abs(dy) <= ry + t.radius;
      else { const r = rx + t.radius; inside = dx * dx + dy * dy <= r * r; }
      if (!inside) continue;
      p.hitIds.push(t.id);
      this.queueDamage(t, p.damage, p.towerDamage, p.crownPct);
      if (def.targetBuff) this.applyBuff(t, def.targetBuff, def.buffTime, p.id);
      if (def.pushback > 0) {
        // directional pushback 0xfcfe18: origin 100 units behind the target along the flight direction
        const l = isqrt(p.dirX * p.dirX + p.dirY * p.dirY);
        const bx = l ? idiv(p.dirX * 100, l) : p.dirX;
        const by = l ? idiv(p.dirY * 100, l) : p.dirY;
        this.applyPushback(t, t.x - bx, t.y - by, def.pushback, def.pushbackAll);
      }
    }
    if (!p.returning && p.rangeLeft <= 0) {
      if (def.pingpong && p.source) { p.returning = true; p.hitIds.length = 0; return; }
      p.alive = false;
      if (def.spawnUnit) this.spawnFromProjectile(p, null);
    }
  }

  /** Characters spawned by a projectile (Goblin Barrel on impact, Barbarian Barrel at the end). */
  private spawnFromProjectile(p: Projectile, offsets: [number, number][] | null): void {
    const def = p.def;
    const u = def.spawnUnit!;
    const ticks = Math.round((def.spawnDeployTime >= 0 ? def.spawnDeployTime : u.deployTime) / TICK_MS);
    const s = p.team === 0 ? 1 : -1;
    for (let i = 0; i < def.spawnCount; i++) {
      const [ox, oy] = offsets?.[i] ?? [0, 0];
      const x = clamp(p.x + s * ox, 0, this.boundW - 1);
      const y = clamp(p.y + s * oy, 0, this.boundH - 1);
      this.createUnit(p.team, p.spell || u.name, u, x, y, ticks);
    }
  }

  private releasePending(p: Projectile): void {
    if (p.pendingOn) { p.pendingOn.pending -= p.damage; p.pendingOn = null; }
  }

  private moveProjectile(p: Projectile): void {
    if (p.pierce) { this.movePierce(p); return; }
    const t = p.target;
    if (t !== null) {
      if (t.state === ST_DEAD) { p.target = null; this.releasePending(p); }
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
    this.releasePending(p);
    if (this.recordEvents) this.events.push({ tick: this.tick, type: 'impact', team: p.team, x: p.x, y: p.y, name: p.spell || p.def.name, id: p.id });
    if (p.radius > 0) {
      this.areaDamage(p.team, p.x, p.y, p.radius, p.aoeAir, p.aoeGround, p.damage, p.towerDamage, p.crownPct, p.pushback, p.def.pushbackAll, p.def.targetBuff, p.def.buffTime, p.id, p.group);
    } else if (p.target !== null) {
      this.queueDamage(p.target, p.damage, p.towerDamage, p.crownPct);
      if (p.def.targetBuff) this.applyBuff(p.target, p.def.targetBuff, p.def.buffTime, p.id);
      if (p.def.chainCount > 1) this.chain(p, p.target);
    }
    if (p.def.spawnUnit) this.spawnFromProjectile(p, p.spell ? this.defs.card(p.spell, this.levels[p.team]).spawnOffsets : null);
  }

  /**
   * Chain lightning: from the first target, hop to the nearest enemy not yet hit within
   * ChainedHitRadius, up to ChainedHitCount targets in all; hops are instantaneous (A).
   */
  private chain(p: Projectile, first: Unit): void {
    const hit: Unit[] = [first];
    let last = first;
    const units = this.units;
    while (hit.length < p.def.chainCount) {
      let best: Unit | null = null;
      let bestD = 0;
      for (let i = 0; i < units.length; i++) {
        const t = units[i];
        if (t.team === p.team || t.state === ST_DEAD || t.maxHp <= 0 || t.hidden || t.tunneling || hit.includes(t)) continue;
        const dx = t.x - last.x;
        const dy = t.y - last.y;
        const d2 = dx * dx + dy * dy;
        const r = p.def.chainRadius + t.radius;
        if (d2 > r * r) continue;
        if (best === null || d2 < bestD) { best = t; bestD = d2; }
      }
      if (best === null) break;
      hit.push(best);
      this.queueDamage(best, p.damage, p.towerDamage, p.crownPct);
      if (p.def.targetBuff) this.applyBuff(best, p.def.targetBuff, p.def.buffTime, p.id);
      last = best;
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
        // crown-tower damage 0xde0334: ((max(p,-100)+100)*dmg + 99)/100 (ceil) [STAT]
        if (this.dmgTower[i] >= 0) amount = this.dmgTower[i];
        else if (this.dmgPct[i] !== 0) amount = Math.trunc(((Math.max(this.dmgPct[i], -100) + 100) * amount + 99) / 100);
        if (t.tower === TOWER_KING && t.kingState === KING_INACTIVE && amount > 0) this.activateKing(t);
      }
      if (amount > 0) t.lastHurtTick = this.tick;
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
    if (t.def.deathAreaEffect) this.spawnAreaEffect(t.team, t.def.deathAreaEffect, t.x, t.y);
    if (t.def.deathSpawn) this.deathSpawn(t);
    if (t.def.manaOnDeath > 0 && !this.fixture) {
      const p = this.players[t.team];
      p.elixir = Math.min(this.maxElixir, p.elixir + t.def.manaOnDeath);
    }
    if (t.def.manaOnDeathForOpponent > 0 && !this.fixture) {
      // ManaOnDeathForOpponent read as elixir x1000 (A)
      const p = this.players[1 - t.team];
      p.elixir = Math.min(this.maxElixir, p.elixir + t.def.manaOnDeathForOpponent * 10);
    }
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
    if (this.newAeos.length) {
      for (const a of this.newAeos) this.areaEffects.push(a);
      this.newAeos.length = 0;
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
      h.add(u.locked ? 1 : 0); h.add(u.kingState); h.add(u.kingTicks); h.add(u.kbActive ? u.kbStep : -1000);
      h.add(u.spawnTimer); h.add(u.spawnLeft); h.add(u.spawnSub); h.add(u.charge); h.add(u.load); h.add(u.retargetCd);
      h.add(u.hitStarted ? 1 : 0); h.add(u.loaded ? 1 : 0); h.add(u.finishMs);
      h.add(u.lifeTicks); h.add(u.decayed); h.add(u.rampMs); h.add(u.manaTimer); h.add(u.hidden ? 1 : 0);
      h.add(u.idleMs); h.add(u.upMs); h.add(u.tunneling ? 1 : 0);
      for (const b of u.buffs) { h.add(b.sourceId); h.add(b.ticksLeft); h.add(b.hitTimer); }
    }
    for (const a of this.areaEffects) { h.add(a.id); h.add(a.life); }
    for (const p of this.projectiles) {
      h.add(p.id); h.add(p.x); h.add(p.y); h.add(p.tx); h.add(p.ty); h.add(p.target ? p.target.id : -1);
      h.add(p.rangeLeft); h.add(p.returning ? 1 : 0); h.add(p.hitIds.length);
    }
    for (const c of this.commands) { h.add(c.team); h.add(c.x); h.add(c.y); h.add(c.submitTick); }
    for (const s of this.rng.state()) h.add(s);
    return h.hex();
  }
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function ceilDiv(a: number, b: number): number {
  return Math.ceil(a / b);
}

function trunc(v: number): number {
  return v < 0 ? Math.ceil(v) : Math.floor(v);
}
