// The deterministic battle engine: one fixed 50 ms tick, integer game units,
// seeded RNG, stable (id-ordered) iteration. Headless and browser share this code.
//
// Per-tick order follows the native world loop (docs/MECHANICS_BRIEF.md §8):
//   1. command manager: commit commands aged >= 20 ticks (debit elixir, spawn, card leaves the hand)
//   2. King tower update parts: hand refill tick, then elixir regeneration (after commits: native
//      debit observations)
//   3. world tick: attack updates for every actor, then actor/movement updates,
//      projectile updates, then the damage flush (damage applied end of tick)
//   4. end check
//   5. frame counter increments
// Once time is up with equal crowns (GameMode NoDraws), the battle manager's tiebreak (0x10ca9a0)
// replaces 1-4 on every later tick (tiebreakTick) until a tower falls or the towers are level.
// Each function below says where its behaviour comes from; see docs/FIDELITY.md.

import { Arena, ARENA_H, ARENA_W, CELL, F_BLOCKED, F_OCCLUDER, F_WATER, PATH_CROSS, PATH_WALK } from './arena.ts';
import { SpatialGrid } from './grid.ts';
import {
  type AreaEffectDef, type BuffDef, Defs, ELIXIR_ONE, type CardDef, type FilterDef, type GameData, type ProjectileDef, TICK_MS,
  type SummonEntry, type Timeline, type UnitDef,
} from './data.ts';
import {
  AreaEffect, type BattleEvent, BuffInst, type Command, KING_ACTIVATING, KING_ACTIVE, KING_INACTIVE, Projectile, type SpellGroup, ST_ACTIVE, ST_DEAD,
  ST_DEPLOYING, TOWER_KING, TOWER_NONE, TOWER_PRINCESS, Unit,
} from './entities.ts';
import { clamp, Hasher, idiv, isqrt, NativeRng, Rng } from './math.ts';
import { formationOffset } from './formation.ts';
import { cos1e6, rotate1024, sin1024, sin1e6 } from './trig.ts';

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
   * The game mode's end flags (GameModeData NoDraws +0x180 / BestOfGame +0x181, loader 0xe2dd44,
   * game_modes.csv). Default: the Ladder row (NoDraws true, BestOfGame false). NoDraws runs the
   * tiebreak when time is up with equal crowns; BestOfGame (the Duel modes) takes its coin-flip branch.
   */
  noDraws?: boolean;
  bestOfGame?: boolean;
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
  /** 4 deck indices; -1 = an empty slot (its card left when its play committed, refilled by handTick). */
  hand: number[];
  queue: number[]; // remaining deck indices in cycle order (queue[0] = next card)
  /** Hand fill timer in ms (player +0x208, 0xfa5b4c): an empty slot is refilled once it runs out. */
  cycleTimer: number;
  king: Unit;
  princess: [Unit, Unit]; // [left (x<9000), right]
}

export interface BattleResult {
  winner: number; // 0, 1, or -1 for a draw
  reason: 'king' | 'time' | 'overtime' | 'tiebreak';
  tick: number;
}

export type PlayError =
  | 'ended' | 'bad-slot' | 'empty-slot' | 'pending' | 'elixir' | 'position' | 'unsupported';

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
  /** LOGIC_PENDING_DAMAGE_IGNORE_IF_DURATION_LESS (600), CURRENT_TARGET_IGNORES_PENDING_DAMAGE, PROTECTION_CAP_PERCENTAGE. */
  readonly pendingIgnoreMs: number;
  readonly currentIgnoresPending: boolean;
  readonly protectionCap: number;
  /** LOGIC_SYMMETRICAL_DEPLOY_SNAP (0xf9e16c). */
  readonly symmetricSnap: boolean;
  /** GameModeData NoDraws / BestOfGame (see BattleConfig). */
  readonly noDraws: boolean;
  readonly bestOfGame: boolean;

  tick = 0;
  /**
   * Time is up (0xd360a8) and the end check was held back by the tiebreak gate: from the next tick
   * on, step() runs the battle manager's tiebreak branch (0x10ca9a0) instead of the world tick.
   */
  timeUp = false;
  /** Tiebreak clock, battle manager +0x1f4 (ms): +50 per tiebreak tick. The HUD shows print_tiebreaker past 1000. */
  tiebreakMs = 0;
  /** Draw clock, battle manager +0x1f8 (ms, BestOfGame only): +50 per tick while <= 2499. The HUD shows duel_battle_draw while non-zero. */
  drawMs = 0;
  /** Tiebreak finished, battle manager +0x1ef: the end check runs on the next tick. */
  tiebreakDone = false;
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
  /** Damage key (event +8), buff applied when the damage lands (0xfd09ac) with its time and source id. */
  private dmgKey: number[] = [];
  private dmgBuff: (BuffDef | null)[] = [];
  private dmgBuffTime: number[] = [];
  private dmgSrc: number[] = [];
  private dmgN = 0;
  /** Projectile damage-key counter (ctx +800). */
  private nextKey = 0;
  private scratch3: Unit[] = [];
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
    this.pendingIgnoreMs = typeof G.LOGIC_PENDING_DAMAGE_IGNORE_IF_DURATION_LESS === 'number' ? G.LOGIC_PENDING_DAMAGE_IGNORE_IF_DURATION_LESS : 0;
    this.currentIgnoresPending = G.CURRENT_TARGET_IGNORES_PENDING_DAMAGE === true;
    this.protectionCap = typeof G.PROTECTION_CAP_PERCENTAGE === 'number' ? G.PROTECTION_CAP_PERCENTAGE : 100;
    this.symmetricSnap = G.LOGIC_SYMMETRICAL_DEPLOY_SNAP === true;
    this.noDraws = cfg.noDraws ?? true;
    this.bestOfGame = cfg.bestOfGame ?? false;

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
        cycleTimer: 0,
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

  /**
   * Hand fill cooldown in ms: the timeline's NextSpellCooldownMS for the current
   * NextSpellCooldownLength section (timeline +0x58, set from those columns by 0xd567ac and read by
   * 0xd56790). The section switch follows the match clock (D: the native switch tick is not traced).
   */
  nextCardCooldownMs(): number {
    const raw = this.timeline.raw;
    const lens = (raw.NextSpellCooldownLength as number[] | undefined) ?? [];
    const ms = (raw.NextSpellCooldownMS as number[] | undefined) ?? [];
    let t = 0;
    const sec = this.timeMs / 1000;
    for (let i = 0; i < ms.length; i++) {
      if (sec < t + (lens[i] ?? 0)) return ms[i];
      t += lens[i] ?? 0;
    }
    return ms.length ? ms[ms.length - 1] : 0;
  }

  /**
   * Deploy position check 0xf9e16c [STAT], run by the play command when it commits (0xd77504):
   * the input is clamped to the arena and snapped to the card's tile grid (0xde0838: 1000k+500 for
   * troops and spells, tile corners for even-sized buildings); then rings of 1000-unit steps around
   * it (up to 30) are searched for positions whose whole footprint (1 tile, TileSize for buildings)
   * lies on deployable tiles of the zone map (0xfa2c0c) and on cells passing 0xe8b6b4 (no water
   * unless CanPlaceOnWater, no no-deploy/building cells unless CanPlaceOnBuildings), inside the
   * DeployWTileMargin columns; the nearest by dist2 to the clamped input wins (first found on
   * ties), the first ring with a valid position ends the search. With LOGIC_SYMMETRICAL_DEPLOY_SNAP
   * a ground non-building troop is moved 1 left when the input x is in the left half and 1 down for
   * team 1 (1000k+499). Returns null when nothing valid is found (the command fails).
   */
  deployPlace(team: number, card: CardDef, x: number, y: number): { x: number; y: number } | null {
    const A = this.arena;
    const xMax = A.w * CELL - 1;
    const yMax = A.h * CELL - 1;
    const xi = x < 1 ? 0 : x >= xMax ? xMax : x;
    const yi = y < 1 ? 0 : y >= yMax ? yMax : y;
    if (this.fixture) return { x: trunc(xi / 1000) * 1000 + 500, y: trunc(yi / 1000) * 1000 + 500 };
    // bVar12: not a SpellAsDeploy card with a projectile or area effect
    const plain = !(card.spellAsDeploy && (card.spellProjectile !== null || card.areaEffect !== null));
    const W = A.w >> 1;
    const H = A.h >> 1;
    const arr = this.zoneMap(team, card.canDeployOnEnemySide, card.canPlaceOnBuildings);
    // the deploying character (summon index 0, else the spell projectile's SpawnCharacter)
    let d: UnitDef | null = card.spec.main ?? card.spec.second ?? card.spec.list[0] ?? null;
    if (d === null && card.spellProjectile !== null) d = card.spellProjectile.spawnUnit;
    let foot = 1;
    let sx = trunc(xi / 1000) * 1000 + 500;
    let sy = trunc(yi / 1000) * 1000 + 500;
    if (d !== null) {
      if (d.spawnPathfindMorph !== null) d = d.spawnPathfindMorph; // 0xde06d0
      if (plain) {
        if (d.kind === 'building') foot = this.tileSize(d);
        sx = this.snapCoord(d, xi);
        sy = this.snapCoord(d, yi);
      }
    }
    const margin = card.deployWTileMargin;
    const flags = A.flags;
    const water = card.canPlaceOnWater;
    const onBuildings = card.canPlaceOnBuildings;
    const cellOk = (cx: number, cy: number): boolean => {
      const v = flags[cx + A.w * cy];
      return (v & F_WATER) === 0 ? (v & (F_BLOCKED | F_OCCLUDER)) === 0 || onBuildings : water;
    };
    let best = 0x7fffffff;
    let bx = 0;
    let by = 0;
    let maxRing = 30;
    for (let r = 0; ; r++) {
      const n = r === 0 ? 1 : 2 * r;
      for (let j = 0; j < n; j++) {
        for (let q = 0; q < 4; q++) {
          if (r === 0 && q > 0) break;
          let a = -r;
          let b = j - r;
          if (q & 1) { a = r - j; b = -r; }
          const cx = sx + (q < 2 ? b : -b) * 1000;
          const cy = sy + (q < 2 ? a : -a) * 1000;
          const top = cy - foot * 500;
          const c0 = trunc((cx - foot * 500) / 1000);
          const c1 = trunc((cx + foot * 500) / 1000);
          const r0 = trunc(top / 1000);
          const r1 = trunc((cy + foot * 500) / 1000);
          let ok = true;
          for (let c = c0; c < c1 && ok; c++) {
            if (r0 >= r1) continue;
            if (c < margin || c >= W - margin || top < -999) { ok = false; break; }
            for (let row = r0; row < r1; row++) {
              if (row >= H || arr[row * W + c] === 0 || !cellOk(2 * c, 2 * row) || !cellOk(2 * c + 1, 2 * row)
                || !cellOk(2 * c, 2 * row + 1) || !cellOk(2 * c + 1, 2 * row + 1)) { ok = false; break; }
            }
          }
          if (!ok) continue;
          const ex = cx - xi;
          const ey = cy - yi;
          const d2 = ex * ex + ey * ey;
          if (d2 < best) { best = d2; bx = cx; by = cy; maxRing = 0; }
        }
      }
      if (maxRing <= r) break;
    }
    if (best === 0x7fffffff) return null;
    if (d !== null && this.symmetricSnap && !(d.flyingHeight > 0) && d.kind !== 'building' && d.spawnPathfindSpeed === 0) {
      if (xi < A.w * 250) bx -= 1;
      by -= team & 1;
    }
    return { x: bx, y: by };
  }

  /** TileSize 0xde07ec [STAT]: TileSizeOverride, else (CollisionRadius + 499)/500 + 1 tiles. */
  private tileSize(d: UnitDef): number {
    return d.tileSizeOverride > 0 ? d.tileSizeOverride : trunc((d.collisionRadius + 499) / 500) + 1;
  }

  /** 0xde0838 [STAT]: tile centre for troops and odd-sized buildings, tile corner for even sizes. */
  private snapCoord(d: UnitDef, v: number): number {
    const base = trunc(v / 1000) * 1000;
    if (d.kind !== 'building') return base + 500;
    return this.tileSize(d) & 1 ? base + 500 : base;
  }

  private zoneArr = new Uint8Array(0);

  /**
   * Deploy-zone map 0xfa2c0c [STAT] on 1000-unit tiles (18 x 32), 1 = deployable, for a card of
   * `team` (normal mode: no touchdown, DeployStartY/EndY unset, FullLaneDeploy unsupported). Every
   * live building (or IsSummoner actor) stamps 0 over a rectangle around it: an enemy one with
   * NoDeploySizeW > 0 (the crown towers) its NoDeploySizeW x NoDeploySizeH tiles unless the card
   * CanDeployOnEnemySide, any other its TileSize footprint. With CanPlaceOnBuildings only the enemy
   * crown towers stamp (their no-deploy area), and not at all with CanDeployOnEnemySide. A fallen
   * Princess tower stops stamping, which opens the pocket.
   */
  private zoneMap(team: number, enemySideOk: boolean, onBuildings: boolean): Uint8Array {
    const W = this.arena.w >> 1;
    const H = this.arena.h >> 1;
    if (this.zoneArr.length !== W * H) this.zoneArr = new Uint8Array(W * H);
    const arr = this.zoneArr;
    arr.fill(1);
    const units = this.units;
    for (let i = 0; i < units.length; i++) {
      const a = units[i];
      if (a.state === ST_DEAD) continue;
      const d = a.def;
      if (!a.isBuilding && !d.isSummoner) continue;
      const enemy = a.team !== team;
      let w = 0;
      let h = 0;
      if (!onBuildings) {
        if (enemy && d.noDeployW > 0 && !enemySideOk) { w = d.noDeployW; h = d.noDeployH; }
        else { w = this.tileSize(d); h = w; }
      } else {
        if (enemySideOk || !enemy || !(d.isSummoner || a.tower === TOWER_PRINCESS)) continue;
        w = d.noDeployW;
        h = d.noDeployH;
      }
      if (w === 0) continue;
      const r0 = trunc((a.y - h * 500) / 1000);
      const r1 = trunc((a.y + h * 500) / 1000);
      const c0 = trunc((a.x - w * 500) / 1000);
      const c1 = trunc((a.x + w * 500) / 1000);
      for (let r = r0 < 0 ? 0 : r0; r < r1 && r < H; r++) {
        for (let c = c0 < 0 ? 0 : c0; c < c1 && c < W; c++) arr[r * W + c] = 0;
      }
    }
    return arr;
  }

  /**
   * Deploy-zone y range for a summon at column x, 0xfa023c [STAT] (Tower_castSpell passes it to
   * Deploy_summon, which clamps ground members' y into it): over the zone map's tiles in the
   * column, team 0 spans [1000·row, 1000·row + 500], team 1 [1000·row + 500 − 1, 1000·row]; no
   * clamp when nothing is deployable or the span reaches 16000 (e.g. a pocket lane).
   */
  private summonZone(team: number, x: number, card: CardDef): [number, number] {
    const NONE: [number, number] = [-0x80000000, 0x7fffffff];
    if (this.fixture) return NONE;
    const W = this.arena.w >> 1;
    const H = this.arena.h >> 1;
    const arr = this.zoneMap(team, card.canDeployOnEnemySide, false);
    const col = trunc(x / 500) >> 1;
    let lo = 0x7fffffff;
    let hi = -0x80000000;
    let found = false;
    const odd = team & 1;
    for (let r = 0; r < H; r++) {
      if (col >= 0 && col < W && arr[r * W + col] !== 0) {
        const mn = r * 1000 + (odd ? 500 : 0);
        const mx = r * 1000 + (odd ? 0 : 500);
        if (mn < lo) lo = mn;
        if (mx > hi) hi = mx;
        found = true;
      }
    }
    if (odd) lo -= 1;
    if (!found || hi - lo >= this.arena.h * 250) return NONE;
    return [lo, hi];
  }

  /** Snapped deploy position (viewer preview): deployPlace, or the clamped input if none is valid. */
  snapDeploy(team: number, x: number, y: number, card: CardDef): { x: number; y: number } {
    return this.deployPlace(team, card, x, y) ?? { x: clamp(x, 0, ARENA_W - 1), y: clamp(y, 0, ARENA_H - 1) };
  }

  /** Whether the native deploy check finds a position for a play at (x, y). */
  deployPositionOk(team: number, x: number, y: number, card: CardDef): boolean {
    return this.deployPlace(team, card, x, y) !== null;
  }

  /** Validate a hand play without side effects. Returns the snapped position or an error. */
  checkPlay(team: number, slot: number, x: number, y: number): { x: number; y: number } | PlayError {
    if (this.result) return 'ended';
    if (slot < 0 || slot > 3) return 'bad-slot';
    const p = this.players[team];
    if (p.hand[slot] < 0) return 'empty-slot';
    // a played card stays in its slot until its play commits; the client hides it until the slot
    // changes (0x8e2868 hide timer, 0x8e1408), so it cannot be played again meanwhile
    for (const c of this.commands) if (c.team === team && c.slot === slot) return 'pending';
    const card = p.deck[p.hand[slot]];
    if (card.unsupported.length) return 'unsupported';
    if (!this.infiniteElixir && p.elixir - p.pending < card.cost * ELIXIR_ONE) return 'elixir';
    // client-side prediction of the commit-time check (0xf9e16c)
    return this.deployPlace(team, card, x, y) ?? 'position';
  }

  /**
   * Play the card in hand slot `slot` at (x, y). It commits 20 ticks later; only then does the card
   * leave the hand (cycleOut) and the hand timer refill the slot (handTick), as in 0xd77504.
   */
  play(team: number, slot: number, x: number, y: number): PlayError | null {
    const pos = this.checkPlay(team, slot, x, y);
    if (typeof pos === 'string') return pos;
    const p = this.players[team];
    const di = p.hand[slot];
    const card = p.deck[di];
    const cost = this.infiniteElixir ? 0 : card.cost * ELIXIR_ONE;
    p.pending += cost;
    // the command carries the input position; the deploy check runs again when it commits
    this.commands.push({ team, card, x, y, submitTick: this.tick, slot, deck: di, cost });
    return null;
  }

  /** Sandbox: deploy any card for either side, bypassing hand and elixir (same timing). */
  spawn(team: number, cardName: string, x: number, y: number): PlayError | null {
    if (this.result) return 'ended';
    const card = this.defs.card(cardName, this.levels[team]);
    if (card.unsupported.length) return 'unsupported';
    if (this.deployPlace(team, card, x, y) === null) return 'position';
    this.commands.push({ team, card, x, y, submitTick: this.tick, slot: -1, deck: -1, cost: 0 });
    return null;
  }

  /** Advance one tick. Phase order follows the native world tick 0xf8cd90 (PORT_NOTES §1.3). */
  step(): void {
    if (this.result) return;
    if (this.recordEvents) this.events.length = 0;
    if (this.timeUp) {
      // battle manager tick 0x10ca9a0 with the time up (0xd360a8): the tiebreak branch while its gate
      // holds, else the end check 0x10cb17c -> 0xd3e360
      if (this.tiebreakGate()) this.tiebreakTick();
      else this.endMatch('tiebreak');
      this.tick++;
      return;
    }
    this.commitCommands();
    this.worldTick();
    this.checkEnd();
    this.tick++;
  }

  /**
   * The battle tick 0xd33f74 (timeline and world, without the command manager): King tower parts
   * (hand refill, elixir), then the world phases of 0xf8cd90 (PORT_NOTES §1.3) and its maintenance.
   */
  private worldTick(): void {
    this.handTick();
    this.regenElixir();
    const units = this.units;
    this.preTick();
    for (let i = 0; i < units.length; i++) this.applyHeights(units[i]); // actor preUpdate (vt+0x40)
    for (let i = 0; i < units.length; i++) this.attackUpdate(units[i]); // all attack components
    for (let i = 0; i < units.length; i++) this.movementUpdate(units[i]); // all movement components
    for (let i = 0; i < units.length; i++) this.healthUpdate(units[i]); // health components
    for (let i = 0; i < units.length; i++) if (units[i].buffs.length) this.updateBuffs(units[i]); // buff components
    // scripted actions (f89524): JumpHack_Check_Jump_Interval every 50 ms gives a jumping unit the
    // 50 ms JumpHack_Ignore_Pushback_Buff, which lasts until the next tick's buff phase
    for (let i = 0; i < units.length; i++) { const u = units[i]; if (u.def.jumpHack) u.pushImmune = u.jumping && u.state !== ST_DEAD; }
    for (let i = 0; i < units.length; i++) this.updateActor(units[i]); // actor updates (vt+0x48)
    this.updateProjectiles();
    this.updateAreaEffects();
    this.flushDamage(); // world vt+0x90 damage queue flush
    this.projectileMaintenance(); // world vt+0x18 at the end of the tick
    this.removeDead();
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

  /**
   * Play command commit 0xd77504 [STAT]: the deploy check 0xf9e16c runs on the input position; a
   * play with no valid position fails without a debit; otherwise min(cost, elixir) is debited and
   * the card is cast at the checked position.
   */
  private executeCommand(c: Command): void {
    const p = this.players[c.team];
    const card = c.card;
    const pos = this.deployPlace(c.team, card, c.x, c.y);
    if (pos === null) {
      p.pending -= c.cost;
      return;
    }
    if (c.cost > 0) {
      // Debit min(cost, current) at commit [STAT/OBS: native debit observations].
      const debit = Math.min(c.cost, p.elixir);
      p.elixir -= debit;
      p.pending -= c.cost;
    }
    if (this.recordEvents) this.events.push({ tick: this.tick, type: 'cast', team: c.team, x: pos.x, y: pos.y, name: card.name, id: -1 });
    this.castSpell(c.team, card, pos.x, pos.y);
    if (c.deck >= 0) this.cycleOut(p, c.deck);
  }

  /**
   * The cast card leaves the hand (0xf9ea68 -> 0xf9f23c: 0xfa58e0 finds its slot, 0xfa5810 empties
   * it and appends the card to the queue) [STAT]. The slot stays empty until handTick refills it.
   */
  private cycleOut(p: Player, deck: number): void {
    const slot = p.hand.indexOf(deck);
    if (slot < 0) return;
    p.hand[slot] = -1;
    p.queue.push(deck);
  }

  /**
   * Hand tick 0xfa5b4c, run by the King tower's update 0xfa06ec before its elixir regeneration
   * [STAT]: the fill timer (player +0x208) drops by 50 ms, not below 0; when it was at most 50 ms the
   * first empty slot (lowest index) takes the queue's head and the timer restarts at the current
   * NextSpellCooldownMS (0xd56790). Without an empty slot the timer waits at 0.
   */
  private handTick(): void {
    if (this.fixture) return; // no King tower
    for (const p of this.players) {
      const t = p.cycleTimer - 50;
      p.cycleTimer = t > 0 ? t : 0;
      if (t >= 1) continue;
      const slot = p.hand.indexOf(-1);
      if (slot < 0) continue;
      if (p.queue.length) p.hand[slot] = p.queue.shift()!;
      p.cycleTimer = this.nextCardCooldownMs();
    }
  }

  /**
   * Tower_castSpell 0xf9f47c [STAT], called at command commit from the player's King tower:
   * projectiles first (rolling SpellAsDeploy ones start at the target point), then the summon,
   * then the area effect object at the target point.
   */
  private castSpell(team: number, card: CardDef, x: number, y: number): void {
    if (card.spellProjectile) this.castProjectiles(team, card, x, y);
    if (card.summon.length) this.summonCard(team, card, x, y);
    if (card.areaEffect) this.spawnAreaEffect(team, card.areaEffect, x, y);
  }

  /**
   * Projectile part of 0xf9f47c [STAT]: ProjectileWaves waves of MultipleProjectiles each, delayed
   * by ProjectileWaveInterval per wave and ProjectileInterval per projectile. With several
   * projectiles (Arrows) the first aims at the target and the others at a ring of radius
   * R − 0.6·r (R spell radius, r projectile radius) at 360/(n−1) steps, each jittered by 0.6·r in a
   * random direction (battle RNG) and kept within 0.9·R; one wave shares a group (0xf8f498 /
   * 0xf93784): a hit list, so a target is hit once per wave, and the spell circle (target point, R)
   * that every damaged actor must also touch (World_areaDamage second circle). Each starts at the
   * King tower offset by (dx/4, dy) of its aim offset, 3 × the tower's CollisionRadius high.
   * SpellAsDeploy cards (Log, Barbarian Barrel) start at the target point instead, 5 × the radius
   * (1400 if none) high: with a SpawnProjectile, MinDistance behind the target (toward the
   * caster's side) and aimed at it, else at the target and aimed MinDistance ahead.
   * The scatter mode is the spell's vt+0x1c0 (0xd59d50: its name is "Arrows"); other
   * multi-projectile spells spread their extra projectiles at random radii in [R/4, R) on
   * 360/n steps.
   */
  private castProjectiles(team: number, card: CardDef, x: number, y: number): void {
    const king = this.players[team].king;
    const kx = king ? king.x : x;
    const ky = king ? king.y : y;
    const kr = king ? king.radius : 0;
    // tower in the lower half (y < mapH·250) casts toward +y
    const fwd = ky < this.arena.h * 250 ? 1 : -1;
    const R = card.spellRadius;
    const n = Math.max(card.multipleProjectiles, 1);
    const waves = Math.max(card.waves, 1);
    const scatter = card.name === 'Arrows'; // spell vt+0x1c0 0xd59d50 [STAT]
    const len = Math.trunc((R * 90) / 100);
    const ringStep = n - 1 !== 0 ? Math.trunc(360 / (n - 1)) : 0;
    const step = Math.trunc(360 / n);
    let waveDelay = 0;
    for (let w = 0; w < waves; w++) {
      let delay = waveDelay;
      let angle = 0;
      // one group per wave (0xf8f498 / 0xf93784): shared hit list and the spell's circle (target, Radius)
      const group: SpellGroup | null = scatter ? { ids: [], x, y, r: R } : null;
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
        const ax = x + ox;
        const ay = y + oy;
        const pr = new Projectile(this.nextProjId++, def, team, ax, ay, this.tick);
        pr.spell = card.name;
        pr.group = group;
        if (card.spellAsDeploy) {
          const r = kr !== 0 ? kr : 1400;
          const md = def.minDistance;
          if (def.spawnProjectile !== null) this.setupProjectile(pr, null, ax, ay - fwd * md, r * 5, null, ax, ay);
          else this.setupProjectile(pr, null, ax, ay, r * 5, null, ax, ay + md * fwd);
        } else {
          this.setupProjectile(pr, null, kx + (ox >> 2), ky + oy, kr * 3, null, ax, ay);
        }
        pr.delay = delay; // +0x1b4 (Projectile_setup p13)
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
      const ux = x + ox;
      let uy = y + oy;
      if (!def.flyingHeight && !this.fixture) uy = clamp(uy, zone[0], zone[1]);
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
      // 0xd35ab4 with the deploy x as lane hint; no lane there: the deploy point's lane (0xd423bc)
      const u = this.createUnit(team, card.name, def, ux, uy, Math.round(wait / TICK_MS) + Math.round(deployMs / TICK_MS), x);
      if (u.lane < 1) u.lane = lane;
      u.waitTicks = Math.round(wait / TICK_MS); // state 11 until the delay ends (0xd423bc)
    }
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

  /**
   * Create an actor (0xd35ab4 [STAT]): the position is clamped to [250, width − 250] ×
   * [250, height − 250]; the lane comes from 0xd38d9c at that position, with the deploy point's x
   * as hint for summons and projectile spawns (`hint`, -1 = none). It joins the live list at the end
   * of this tick.
   */
  private createUnit(team: number, card: string, def: UnitDef, x: number, y: number, deployTicks: number, hint = -1): Unit {
    const xm = this.boundW - 250;
    const ym = this.boundH - 250;
    if (x < 251) x = 250;
    if (xm <= x) x = xm;
    if (y < 251) y = 250;
    if (ym <= y) y = ym;
    const u = new Unit(this.nextId++, def, card, team, x, y, this.tick + 1);
    u.lane = hint === -1 ? this.laneOf(x, y) : this.laneHint(x, y, hint);
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
   * AttackComp_isValidTarget 0xfc4008 -> 0xf94824 (subset for implemented mechanics) [STAT]. Units
   * waiting out a summon delay (state 11) are not targetable (vt148 0xf825e4 -> vtf8 0xf85420).
   * With `checkPending`, an attacker that has a Projectile skips a target whose pending damage
   * would kill it (0xf94824 tail, see pendingOverkill).
   */
  private isValidTarget(u: Unit, t: Unit | null, checkPending: boolean): boolean {
    if (t === null || t === u) return false;
    if (t.state === ST_DEAD || t.maxHp <= 0) return false;
    if (t.team === u.team) return false;
    if (t.hidden || t.tunneling || t.waitTicks > 0) return false;
    const d = u.def;
    if (d.targetOnlyBuildings && !t.isBuilding && !(d.attacksAir && !d.attacksGround && t.isAir)) return false;
    if (d.targetOnlyTroops && t.isBuilding) return false;
    if (t.isAir && !d.attacksAir) return false;
    if (!t.isAir && !d.attacksGround && d.attacksAir) return false;
    if (t.jumping && !d.attacksAir) return false; // a jumping character (state 5) needs AttacksAir (0xf94824)
    if (checkPending && d.projectile !== null && t.pending !== 0 && this.pendingOverkill(t)) return false;
    return true;
  }

  /**
   * Pending-damage overkill test, the tail of 0xf94824 [STAT]. With pending damage p (actor +0x114)
   * and its duration (actor +0x118) the target is skipped when all of these hold:
   * - 0xfcc054: no shield up, and p reduced by the target's damage-reduction buffs (0xfc1e84, at
   *   least 1) is at least its current hitpoints;
   * - duration <= LOGIC_PENDING_DAMAGE_IGNORE_IF_DURATION_LESS (600);
   * - not MorphKeepTarget (+0x58d) and not a troop with a LifeTime;
   * - not dash-immune (0xf820b4: attack +0x48 > 0, DashImmuneToDamageTime >= 1 and attack +0x48 <=
   *   duration; no supported unit dashes, so never);
   * - no healing buff (0xfc2530: HealPerSecond > 0) unless p reaches its full scaled hitpoints.
   * The UNKILLABLE tag and the dash/attached immunity of 0xf817b0 have no supported users.
   */
  private pendingOverkill(t: Unit): boolean {
    const pend = t.pending;
    if (t.shield > 0) return false;
    let p = pend;
    if (t.buffs.length) {
      p = this.reduceDamage(t, p);
      if (p < 2) p = 1;
    }
    if (t.hp > p) return false;
    if (t.pendingDur > this.pendingIgnoreMs) return false;
    const d = t.def;
    if (d.morphKeepTarget || (d.lifeTime > 0 && !t.isBuilding)) return false;
    if (d.hitpoints > pend) {
      for (const b of t.buffs) if (b.def.hps > 0) return false;
    }
    return true;
  }

  /**
   * Buff damage reduction 0xfc1e84 [STAT]: the strongest positive and the strongest negative
   * DamageReduction of the active buffs are added, clamped to +-PROTECTION_CAP_PERCENTAGE, and the
   * damage scaled by (100 - r)/100 (truncated).
   */
  private reduceDamage(t: Unit, dmg: number): number {
    let mx = 0;
    let mn = 0;
    for (const b of t.buffs) {
      const r = b.def.damageReduction;
      if (mx <= r) mx = r;
      if (r <= mn) mn = r;
    }
    const r = mx + mn;
    const cap = this.protectionCap;
    let c = r;
    if (cap <= r) c = cap;
    if (r <= -cap) c = -cap;
    return idiv((100 - c) * dmg, 100);
  }

  /**
   * Actor vt1b8 0xf8553c [STAT]: pending damage += dmg; a non-negative flight time raises the
   * duration to max(duration, time rounded up to 50), capped at 1000.
   */
  private addPending(t: Unit, dmg: number, time: number): void {
    t.pending += dmg;
    if (time >= 0) {
      let d = idiv(time + 49, 50) * 50;
      if (d < t.pendingDur) d = t.pendingDur;
      if (d > 999) d = 1000;
      t.pendingDur = d;
    }
  }

  /** Projectile damage against `t` (0xf8ef58): the crown-tower value for crown towers [STAT]. */
  private projDamageVs(p: Projectile, t: Unit): number {
    if (t.tower === TOWER_NONE) return p.damage;
    if (p.towerDamage >= 0) return p.towerDamage;
    return idiv((Math.max(p.crownPct, -100) + 100) * p.damage + 99, 100);
  }

  /**
   * 0xf8fa94 [STAT], when the projectile joins the world list (vt20 0xf93584) or is set up again
   * in the world (chain hop): a Homing projectile with a target adds its damage to the target's
   * pending damage with the flight time isqrt(dist2)·50/Speed.
   */
  private registerPending(p: Projectile): void {
    const t = p.target;
    if (t === null || !p.def.homing) return;
    const dx = t.x - p.x;
    const dy = t.y - p.y;
    const dist = isqrt(dx * dx + dy * dy);
    const sp = p.def.speed;
    this.addPending(t, this.projDamageVs(p, t), sp !== 0 ? idiv(dist * 50, sp) : 0);
    p.pendReg = true;
  }

  /** Pending release on reaching the aim point (0xf90708 / 0xf8eed8) [STAT]. */
  private releasePending(p: Projectile): void {
    const t = p.target;
    if (t !== null && p.pendReg) t.pending -= this.projDamageVs(p, t);
    p.pendReg = false;
  }

  /**
   * End-of-tick world maintenance 0xf8c9d8 for projectiles [STAT]: actors that died are removed
   * and every reference to them replaced by null (projectile vt38 0xf92ed8: a homing projectile
   * first aims at the target's last position); then the projectiles created this tick join the
   * world list (vt20 0xf93584) and register their pending damage (0xf8fa94).
   */
  private projectileMaintenance(): void {
    const ps = this.projectiles;
    const tick = this.tick;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const t = p.target;
      if (t !== null && t.state === ST_DEAD) {
        if (p.def.homing) { p.tx = t.x; p.ty = t.y; p.aimZ = t.z; }
        p.target = null;
      }
      const t2 = p.target2;
      if (t2 !== null && t2.state === ST_DEAD) { p.target2 = null; p.homingT = 0; } // vt38 0xf92ed8
      if (p.born === tick && !p.pendReg && p.target !== null) this.registerPending(p);
    }
  }

  /**
   * AttackComp_findTarget 0xfc4c38 [STAT]: candidates from the spatial grid in native order;
   * sight = SightRange + own radius, limit per candidate = its radius + sight (+2000 to crown
   * towers); SightClip / SightClipSide limits; nearest by dist2, ties keep the earlier candidate.
   * Without a candidate: the default target (lane crown tower) (A for findDefaultTarget).
   */
  private findTarget(u: Unit): void {
    if (u.jumping) return; // states 3 and 5 keep their target (0xfc4c38)
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
      // distance less the candidate's target priority (vt1d8, actor +0x1a0), at least 0
      let d2 = dx * dx + dy * dy - c.prio;
      if (d2 < 0) d2 = 0;
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
    // (LOGIC_PATHFIND_BACKWARDS_TRY_KEEP_TARGET), else the default target, for buildings and crown
    // towers too (an enemy crown tower, out of range, so setTarget resets the attack); an invalid
    // choice leaves the current target unchanged [STAT 0xfc4c38 tail]. The native default is never
    // null; without towers (fixture arenas) buildings drop their target.
    let cand: Unit | null;
    if (u.target && this.mobile(u) && u.pathBack && this.isValidTarget(u, u.target, true)) cand = u.target;
    else cand = this.defaultTarget(u);
    if (cand === null) { if (u.isBuilding) this.setTarget(u, null, false, true); return; }
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

  /**
   * Lane id with a hint x, the hint branch of 0xd38d9c [STAT]: the lane of the nearest road cell to
   * the point (as laneOf) and, separately, of the nearest road cell to the hint's column on the
   * point's row distance; when the point lies across the middle column from the hint (hint column
   * < 18 <= point column ((x + 5)/500) with hint < x, or the mirror) and both choices agree, lanes
   * 1 and 2 are swapped.
   */
  laneHint(x: number, y: number, hint: number): number {
    const A = this.arena;
    const W = A.w;
    const H = A.h;
    const xc = trunc(x / CELL);
    const yc = trunc(y / CELL);
    const hc = trunc(hint / CELL);
    const xc5 = trunc((x + 5) / CELL);
    const half = W >> 1;
    let lane = 0;
    let best = 0x7fffffff;
    let laneH = -1;
    let bestH = 0x7fffffff;
    let cross = false;
    for (let cx = 0; cx < W; cx++) {
      for (let cy = 0; cy < H; cy++) {
        const v = A.flags[cx + W * cy] & 3;
        if (v <= 0) continue;
        const dy2 = (cy - yc) * (cy - yc);
        const dH = dy2 + (cx - hc) * (cx - hc);
        const dP = dy2 + (cx - xc) * (cx - xc);
        if (dH < bestH) { bestH = dH; laneH = v; }
        const le = dP <= best;
        if (dP < best) { best = dP; lane = v; }
        if (!cross && le) {
          if (hint < x && hc < half && half <= xc5) { cross = true; continue; }
          cross = x < hint ? (half < hc && xc5 <= half) : false;
        }
      }
    }
    if (cross && lane === laneH) lane = laneH === 1 ? 2 : laneH === 2 ? 1 : laneH;
    return lane;
  }

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
    u.attackedTarget = false; // +0x19
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
    if (u.axeWait > 0) return 0; // attack +0x64 > 0 (vtb8 0xf82a18)
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
    if (d.hitSpeed <= 0 || u.atkOff) return; // atkOff: component disabled while frozen (0xf7fee4)
    u.load = Math.max(u.load, 50) - 50;
    u.retargetCd = Math.max(u.retargetCd, 50) - 50;
    if (u.target) { u.tsx = u.target.x; u.tsy = u.target.y; }
    // out-and-back projectile in flight (attack +0x58) and its PingpongVisualTime wait (+0x60/+0x64):
    // nothing else happens until both are over, then the timer restarts at 1 (0xfc7e20)
    if (u.axeWait > 0) {
      u.axeMs += 50;
      if (u.axeMs < u.axeWait) return;
      u.axeMs = 0;
      u.axeWait = 0;
      if (u.axe !== null) return;
      u.atkTimer = 1;
    } else if (u.axe !== null) {
      return;
    }
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
    // keep a valid target in range; a unit that already attacked it and has
    // KeepTargetWithPendingDamage keeps it ignoring the pending damage (CURRENT_TARGET_IGNORES_PENDING_DAMAGE)
    let kept = false;
    if (tg && keep) {
      kept = this.isValidTarget(u, tg, true)
        || (u.attackedTarget && d.keepTargetWithPendingDamage && this.currentIgnoresPending && this.isValidTarget(u, tg, false));
    }
    if (!kept) {
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
    u.attackedTarget = true; // +0x19
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
          // BuffOnDamage lands with the damage (flush callback 0xfd09ac)
          this.queueDamage(t, dmg, -1, d.crownTowerDamagePercent, 0, d.buffOnDamage, d.buffOnDamageTime, u.id);
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
      this.queueDamage(best, dmg, -1, d.crownTowerDamagePercent, 0, d.buffOnDamage, d.buffOnDamageTime, u.id);
    }
  }

  /**
   * Projectile_init 0xf8e4c8 as called by AttackComp_execute 0xfc619c [STAT], for the single
   * projectile of an ordinary attack (MultipleProjectiles <= 1, no angle offset): aimed at the
   * target snapshot of this attack update (no projectile in this build sets TargetToEdge); it
   * starts ProjectileStartRadius from the shooter toward the aim, plus ProjectileYOffset (negated
   * for team 1), at the shooter's height + ProjectileStartZ, then Projectile_setup. An
   * out-and-back projectile (PingpongVisualTime) is linked to the shooter's attack (0xfc7914) and
   * steps by the shooter's buff time scale of 50 ms (0xfc27b8).
   */
  private fireProjectile(u: Unit, t: Unit, def: ProjectileDef): void {
    const ax = u.tsx;
    const ay = u.tsy;
    const dx = ax - u.x;
    const dy = ay - u.y;
    const dd = isqrt(dx * dx + dy * dy);
    const sr = u.def.projectileStartRadius;
    let ox = dx;
    let oy = dy;
    if (dd !== 0) {
      ox = idiv(dx * sr, dd);
      oy = idiv(dy * sr, dd);
    }
    const yoff = u.team === 0 ? u.def.projectileYOffset : -u.def.projectileYOffset;
    const pr = new Projectile(this.nextProjId++, def, u.team, u.x + ox, u.y + oy + yoff, this.tick);
    pr.sourceId = u.id;
    pr.shooter = u;
    this.setupProjectile(pr, u, u.x + ox, u.y + oy + yoff, u.z + u.def.projectileStartZ, t, ax, ay);
    if (def.pingpongTime > 0) {
      // 0xfc7914: attack +0x58 = projectile; +0x60 = 0, +0x64 = PingpongVisualTime
      u.axe = pr;
      u.axeMs = 0;
      u.axeWait = def.pingpongTime;
      pr.pingStep = this.clockDelta(u);
    }
    this.projectiles.push(pr);
  }

  /**
   * Projectile_setup 0xf8e6fc [STAT], the paths supported cards use: position and target; the aim
   * through setAim 0xf8fb34 (a piercing projectile, or one with a ProjectileRange, is aimed
   * ProjectileRange from the shooter, or from its start without one, toward the given point and
   * drops its target); HomingTime re-aim when the target is farther than HomingMinDistance;
   * MinDistance pushes the aim out; the aim height (a projectile that spawns a piercing one lands at
   * that one's ProjectileRadiusY, or ProjectileRadius, high; a piercing one stays at its start
   * height; ConstantHeight overrides both); the damage key of SpawnProjectile chains (only when
   * neither it nor its spawn pierces); the chain-hit count; SpawnChain. Pending damage registers
   * when it joins the world list (projectileMaintenance) or at once in a chain hop.
   */
  private setupProjectile(p: Projectile, shooter: Unit | null, x: number, y: number, z: number, target: Unit | null,
    tx: number, ty: number): void {
    const def = p.def;
    p.x = x;
    p.y = y;
    p.z = z;
    p.target = target;
    this.setAim(p, shooter ? shooter.x : x, shooter ? shooter.y : y, tx, ty);
    p.startX = x;
    p.startY = y;
    p.startZ = z;
    if (target !== null && def.homingTime > 0) {
      const vx = target.x - x;
      const vy = target.y - y;
      if (def.homingMinDistance < isqrt(vx * vx + vy * vy)) {
        p.target2 = target;
        p.homingT = def.homingTime;
      }
    }
    if (def.minDistance !== 0) {
      let vx = p.tx - p.startX;
      let vy = p.ty - p.startY;
      const l = isqrt(vx * vx + vy * vy);
      if (l < def.minDistance && l !== 0) {
        vx = idiv(vx * def.minDistance, l);
        vy = idiv(vy * def.minDistance, l);
        p.tx = p.startX + vx;
        p.ty = p.startY + vy;
      }
    }
    const sp = def.spawnProjectile;
    if ((sp === null || !sp.pierce) && !def.pierce) {
      if ((sp !== null || p.fromParent) && p.key === 0) p.key = ++this.nextKey;
    } else if (!def.pierce) {
      p.aimZ = sp!.pierceRadiusY !== 0 ? Math.min(sp!.pierceRadiusY, sp!.pierceRadius) : sp!.pierceRadius;
    } else {
      p.aimZ = p.startZ;
    }
    if (def.constantHeight !== 0) {
      p.aimZ = def.constantHeight;
      p.startZ = def.constantHeight;
      p.z = def.constantHeight;
    }
    if (def.chainRadius > 0) {
      p.chainHits++;
      if (p.target !== null) p.ignoreIds.push(p.target.id);
    }
    if (shooter !== null && p.homingT > 0) {
      p.startX = shooter.x;
      p.startY = shooter.y;
    }
    p.chainLeft = def.spawnChain;
  }

  /**
   * setAim 0xf8fb34 [STAT]: aim at (tx, ty); a piercing projectile or one with a ProjectileRange is
   * aimed ProjectileRange from (sx, sy) through that point (RandomDistance: no supported user) and
   * loses its target.
   */
  private setAim(p: Projectile, sx: number, sy: number, tx: number, ty: number): void {
    const def = p.def;
    p.tx = tx;
    p.ty = ty;
    if (def.pierce || def.range > 0) {
      let vx = tx - sx;
      let vy = ty - sy;
      const l = isqrt(vx * vx + vy * vy);
      if (l !== 0) {
        vx = idiv(vx * def.range, l);
        vy = idiv(vy * def.range, l);
      }
      p.target = null;
      p.tx = vx + sx;
      p.ty = vy + sy;
    }
  }

  /**
   * Flight height 0xf927ec [STAT]: with k = distance flown / Speed and n = full distance / Speed
   * (at least 1), z = startZ + (aimZ − startZ)·k/n + (k − n)·k·(Gravity·−500/1000).
   */
  private arcZ(p: Projectile, x: number, y: number): number {
    const def = p.def;
    const t = p.target;
    const ax = t !== null && def.homing ? t.x : p.tx;
    const ay = t !== null && def.homing ? t.y : p.ty;
    let sp = def.speed;
    if (sp < 2) sp = 1;
    let dx = ax - p.startX;
    let dy = ay - p.startY;
    let n = idiv(isqrt(dx * dx + dy * dy), sp);
    if (n < 2) n = 1;
    dx = x - p.startX;
    dy = y - p.startY;
    const k = idiv(isqrt(dx * dx + dy * dy), sp);
    return idiv((p.aimZ - p.startZ) * k, n) + p.startZ + (k - n) * k * idiv(def.gravity * -500, 1000);
  }

  /**
   * Damage_enqueue 0xfca3d4: queued, applied in the end-of-tick flush. `key` is the damage key
   * (event +8, 0 = none); `buff` is the damage-landed buff (projectile TargetBuff / BuffOnDamage,
   * 0xfd09ac), applied only if the damage lands.
   */
  private queueDamage(t: Unit, amount: number, towerDamage: number, pct: number, key = 0,
    buff: BuffDef | null = null, buffTime = 0, srcId = -1): void {
    const i = this.dmgN++;
    this.dmgTarget[i] = t;
    this.dmgAmount[i] = amount;
    this.dmgTower[i] = towerDamage;
    this.dmgPct[i] = pct;
    this.dmgKey[i] = key;
    this.dmgBuff[i] = buff;
    this.dmgBuffTime[i] = buffTime;
    this.dmgSrc[i] = srcId;
  }

  /** Actor_circleOverlapSq 0xf95084 [STAT]: circles overlap strictly; buildings by the closest point of their square. */
  private overlaps(t: Unit, x: number, y: number, R: number): boolean {
    if (t.isBuilding) {
      const r0 = t.radius;
      const ex = clamp(x, t.x - r0, t.x + r0) - x;
      const ey = clamp(y, t.y - r0, t.y + r0) - y;
      return ex <= R && ex >= -R && ey <= R && ey >= -R && ex * ex + ey * ey < R * R;
    }
    const dx = t.x - x;
    const dy = t.y - y;
    const r = R + t.radius;
    return dx * dx + dy * dy < r * r;
  }

  /**
   * World_areaDamage 0xf97be8 [STAT]: candidates in world-list order that are enemies, targetable
   * (not hidden, tunnelling or waiting out a deploy delay) and on an affected layer, overlapping the
   * circle (and the spell wave's circle when `group` is given); the group's shared list skips actors
   * already hit by the wave and records new ones. At most one crown tower is taken (the first);
   * collection stops at `maxTargets` (> 0). Each is damaged (crown-tower value for towers) and
   * knocked back from (x, y).
   */
  private areaDamage(team: number, x: number, y: number, radius: number, air: boolean, ground: boolean,
    damage: number, towerDamage: number, pct: number, pushback: number, pushAll: boolean,
    buff: BuffDef | null = null, buffTime = 0, sourceId = -1, group: SpellGroup | null = null, maxTargets = 0, key = 0): void {
    const units = this.units;
    const hits = this.scratch3;
    let n = 0;
    let tower = false;
    for (let i = 0; i < units.length; i++) {
      const t = units[i];
      if (t.team === team || t.state === ST_DEAD) continue;
      if (t.maxHp <= 0 || t.hidden || t.tunneling || t.waitTicks > 0) continue;
      if (t.isAir ? !air : !ground) continue;
      if (!this.overlaps(t, x, y, radius)) continue;
      if (group !== null) {
        if (group.r > 0 && !this.overlaps(t, group.x, group.y, group.r)) continue;
        if (group.ids.includes(t.id)) continue;
        group.ids.push(t.id);
      }
      const isTower = t.tower !== TOWER_NONE;
      if (isTower && tower) continue;
      tower = tower || isTower;
      hits[n++] = t;
      if (maxTargets > 0 && n >= maxTargets) break;
    }
    for (let i = 0; i < n; i++) {
      const t = hits[i];
      hits[i] = null as unknown as Unit;
      if (damage > 0) this.queueDamage(t, damage, towerDamage, pct, key, buff, buffTime, sourceId);
      if (pushback > 0) this.applyPushback(t, x, y, pushback, pushAll);
    }
  }

  // ---------------------------------------------------------------- actors & movement

  private updateActor(u: Unit): void {
    if (u.state === ST_DEAD) return;
    // Character update 0xf800bc [STAT]: state 11 (summon delay) only counts down; otherwise the
    // pending-damage duration (actor +0x118) drops by 50.
    if (u.waitTicks > 0) u.waitTicks--;
    else u.pendingDur = (u.pendingDur > 50 ? u.pendingDur : 50) - 50;
    if (u.tunneling) { this.tunnel(u); return; }
    if (u.state === ST_DEPLOYING) {
      if (u.deployTicks > 0) u.deployTicks--;
      if (u.deployTicks === 0) {
        u.state = ST_ACTIVE;
        // Actors without hitpoints (Rage bottle) expire on landing, triggering their death effect.
        if (u.maxHp <= 0) this.kill(u);
        // 0xf800bc goes on the tick the deploy ends: collector and hide timer run once already
        else this.collectAndHide(u);
      }
      return;
    }
    if (u.tower === TOWER_KING && u.kingState === KING_ACTIVATING) {
      // 3300 ms ACTIVATING action [DATA]; with LoadTime gives first shot 621 -> 697 [OBS].
      if (--u.kingTicks <= 0) u.kingState = KING_ACTIVE;
      return;
    }
    if (u.def.spawn) this.updateSpawner(u);
    this.collectAndHide(u);
    this.combatGate(u);
  }

  /**
   * End of the character update, 0xf7fee4 [STAT] (frozen path): while the buff time scale of 50 ms
   * is 0 (a −100 HitSpeedMultiplier: Freeze, Zap and Electro stuns) and no buff carries a
   * Projectile, the target is dropped (setTarget(null): the attack timer and the swing in progress
   * are kept, ResetHitTimerWhenNoTarget defaults to false) and the attack component is disabled
   * (component mask bit 0, COMBAT_DISABLED) until a character update ends unfrozen. The update of
   * the tick a stun lands still runs, with a zero clock step.
   */
  private combatGate(u: Unit): void {
    if (u.buffs.length !== 0 && this.clockDelta(u) === 0) {
      this.setTarget(u, null, false, false);
      u.atkOff = true;
    } else {
      u.atkOff = false;
    }
  }

  private collectAndHide(u: Unit): void {
    if (u.def.manaCollect > 0 && !this.fixture) this.collectorUpdate(u);
    if (u.def.hides) this.updateHiding(u);
  }

  /**
   * Elixir Collector, 0xf800bc [STAT]: the generate timer (actor +0x130) gains half the spawn-speed
   * percentage (0xfc23f0: 100 -> 50 ms) per tick; at ManaGenerateTimeMs the player gets
   * ManaCollectAmount (0xfa1bb8) and the timer drops by the period, unless that would pass MAX_MANA
   * (whole elixir, 0xfa1c64): then the timer waits at the period and retries every tick. The view
   * plays the pump on each collection (vt+0x130 -> 0x84692c). ManaGenerateLimit (no supported card)
   * is not modelled.
   */
  private collectorUpdate(u: Unit): void {
    const period = u.def.manaPeriod;
    u.manaT += Math.trunc(this.spawnPct(u) / 2);
    if (u.manaT < period) return;
    const p = this.players[u.team];
    const amount = u.def.manaCollect;
    if (this.maxElixir < amount + Math.trunc(p.elixir / ELIXIR_ONE) * ELIXIR_ONE) {
      u.manaT = Math.min(u.manaT, period);
      return;
    }
    u.manaT -= period;
    p.elixir = Math.min(this.maxElixir, p.elixir + amount);
    if (this.recordEvents) this.events.push({ tick: this.tick, type: 'collect', team: u.team, x: u.x, y: u.y, name: u.def.name, id: u.id });
  }

  /** Spawn-speed percentage 0xfc23f0 (SpawnSpeedMultiplier buffs): clamp(100 + slow) * haste / 100. */
  private spawnPct(u: Unit): number {
    if (u.buffs.length === 0) return 100;
    let haste = 100;
    let slow = 0;
    for (const b of u.buffs) {
      const m = b.def.spawnSpeedMul;
      if (m >= 100) { if (m > haste) haste = m; } else if (m < 0 && m < slow) slow = m;
    }
    return idiv(clamp(100 + slow, 0, 100) * haste, 100);
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

  /**
   * Actor preUpdate, the height part (character vt+0x40 0xf80080 -> 0xf96040, which first snapshots
   * the previous position and z through vt+0x160 0xf95ac4, then tail-calls 0xfd0320 for an actor with
   * a movement component) [STAT]: the heights the movement component recorded last tick (list m+0x10,
   * count m+0x1c; absolute heights m+0x20, count m+0x2c) become the actor's z base (+0x74): their sum
   * clamped to [min − zo, max − zo] of the absolute records, both bounds starting at the z offset zo
   * (+0x8c); both lists are cleared. Only the river jump records heights in this engine (0xfccd94;
   * the other recorders, 0xfcf48c from 0xfa6774.., belong to unported mechanics), and it records at
   * most one value v ≥ 1 per tick, so the z base is v, or 0 without a record. The actor z (0xf942a8)
   * is z base + z offset (FlyingHeight).
   */
  private applyHeights(u: Unit): void {
    if (u.def.speed <= 0) return; // no movement component (0xf7ed38: only with data Speed > 0)
    u.z = u.def.flyingHeight + u.jumpZ;
    u.jumpZ = 0;
  }

  /**
   * Jump state 5 of the movement update (0xfccd94) [STAT]: JumpSpeed steps toward the landing cell;
   * the total distance (m+0x204) grows to the current distance when larger once the unit has ever
   * been knocked back (m+0x1ec != 0); with n = total/JumpSpeed and k = remaining/JumpSpeed the jump
   * ends when k < 2, else u = clamp(2·min(k, n − k), 0, 32) and the arc height
   * h = (u − u²/64)·JumpHeight is recorded as h >> 4 when h ≥ 16 (m+0x10 list, and z offset + h >> 4
   * in m+0x20); the next tick's preUpdate turns the record into the actor's z (applyHeights).
   */
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
    const d2 = dx * dx + dy * dy;
    let total = u.jumpTotal;
    if (u.kbStep !== 0 && total * total < d2) { total = isqrt(d2); u.jumpTotal = total; }
    const n = idiv(total, speed);
    const k = idiv(isqrt(d2), speed);
    const m = n - k <= k ? n - k : k;
    let a = m * 2;
    if (a > 31) a = 32;
    if (k < 2) { u.jumping = false; u.jumpZ = 0; return; }
    if (a < 0) a = 0;
    const h = (a - ((a * a) >> 6)) * u.def.jumpHeight;
    u.jumpZ = h >= 16 ? h >> 4 : 0;
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
      // the view hears of every A* run (vt+0x178 -> 0x845bb0) with the facing at that moment
      if (this.recordEvents) this.events.push({ tick: this.tick, type: 'path', team: u.team, x: u.dirX, y: u.dirY, name: u.def.name, id: u.id });
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
    if (!this.mobile(t) || t.state === ST_DEAD || t.tunneling || t.waitTicks > 0) return; // vtf8 (state 11) refuses
    if (t.kbActive) return;
    if (t.def.ignorePushback && !ignoreImmune) return;
    if (t.pushImmune && !ignoreImmune) return; // IgnorePushBack buff (0xfc2c4c)
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
   * Hide timer 0xf81b3c (HidesWhenNotAttacking: Tesla) [STAT], once per character update. The unit
   * wants to hide unless it is attacking or deploying (native states 2 / 4, 0xf85368); the step is
   * the buff speed scale of 50 ms (0xfc26d4; frozen: no change). Hiding counts the timer from 0 up to
   * HideTimeMs, where the unit is fully hidden and untargetable (0xf85420). Leaving full hiding it
   * counts on through UpTimeMs and wraps to 0 (up); interrupted part-way down it turns negative and
   * climbs back to 0; a rising unit asked to hide again turns around. A building plays HideEffect and
   * OnHideAction as hiding starts and the appear event 0xf8247c (AppearEffect, OnAppearAction, appear
   * area object and pushback) as it leaves full hiding or turns back from more than half way down.
   */
  private updateHiding(u: Unit): void {
    const d = u.def;
    const want = u.state !== ST_DEPLOYING && !u.locked;
    const dt = u.buffs.length ? this.speedScale(u, TICK_MS) : TICK_MS;
    if (dt === 0) return;
    const hide = d.hideTime;
    const cyc = hide + d.upTime;
    let v = u.hideT;
    let s = v + dt;
    if (v < 0 && s >= 0) { v = 0; s += cyc; u.hideT = 0; }
    let out: number;
    toEnd: {
      if (s < 0) {
        if (!want) { out = s; break toEnd; }
        s = -s;
        u.hideT = Math.max(s - dt, 0);
        if (hide <= s && u.hideT <= hide) { out = hide; break toEnd; }
      } else {
        let f = u.hideT;
        if (!(want || hide <= v || f < 1)) {
          if (u.isBuilding && hide < s * 2) this.appear(u);
          f = Math.max(-s - dt, -hide);
          u.hideT = f;
          out = -s;
          if (s !== 0) break toEnd;
        }
        if (want) {
          if (hide <= s && u.hideT <= hide) { out = hide; break toEnd; }
        } else {
          out = 0;
          if (f === 0 || cyc < s) break toEnd;
        }
      }
      if (u.isBuilding) {
        if (u.hideT === 0 && this.recordEvents) {
          this.events.push({ tick: this.tick, type: 'hide', team: u.team, x: u.x, y: u.y, name: d.name, id: u.id });
        }
        if (u.hideT === hide) this.appear(u);
      }
      out = cyc !== 0 ? s % cyc : s;
    }
    u.hideT = out;
    u.hidden = out === hide;
  }

  /** Appear event 0xf8247c: AppearEffect for the view (no supported unit has appear actions, areas or pushback). */
  private appear(u: Unit): void {
    if (this.recordEvents) this.events.push({ tick: this.tick, type: 'appear', team: u.team, x: u.x, y: u.y, name: u.def.name, id: u.id });
  }

  /**
   * Health component update 0xfc99e0, lifetime decay [STAT]: rate = (maxHp*100000/LifeTime)/20
   * hundredths of HP per tick (0xfc9774), accumulated; whole HP come off when the accumulator
   * reaches 100. Not while deploying. At 0 HP the actor dies at once.
   */
  private healthUpdate(u: Unit): void {
    if (u.dmgKeys.length) this.expireDamageKeys(u);
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


  /**
   * Health update 0xfc99e0, first part [STAT]: damage keys recorded more than 999 ms ago are
   * dropped (the last record moves into the freed slot), whatever the actor's state.
   */
  private expireDamageKeys(u: Unit): void {
    const now = this.tick * TICK_MS;
    const ks = u.dmgKeys;
    const ts = u.dmgKeyTimes;
    let n = ks.length;
    let i = 0;
    while (i < n) {
      if (now - ts[i] > 999) {
        n--;
        ks[i] = ks[n];
        ts[i] = ts[n];
        ks.length = n;
        ts.length = n;
      } else {
        i++;
      }
    }
  }

  // ---------------------------------------------------------------- buffs & area effects

  /**
   * Buff_add 0xfc0e08 (paths for supported buffs) [STAT]: an existing instance of the same buff
   * (with EnableStacking: of the same buff and source) is refreshed (0xf86e18: its remaining time
   * becomes the new time if that is longer), else a new instance is added. PlayerSpecificBuff,
   * AddAsIndividualBuff and ChainedBuff rules have no supported user.
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
    // HitTickFromSource: the native counter follows the source area effect's pulse (0xf86668); here
    // the first tick comes at once (A: no supported card uses it)
    inst.hitTimer = raw && raw.HitTickFromSource === true && def.hitFrequency > 0 ? idiv(def.hitFrequency, 50) - 1 : 0;
    u.buffs.push(inst);
  }

  /**
   * Buff component update 0xfc0748 / buff instance update 0xf86668 [STAT]: buffs are processed from
   * the last to the first; remaining time −50; damage/heal over time with a counter: with
   * HitFrequency > 0 it ticks on every (HitFrequency/50)-th update (the first one HitFrequency after
   * the buff was added), with HitFrequency < 0 once, on its first update, for 1000 ms worth, never
   * with 0 (the loader default). Per tick: DamagePerSecond (scaled, rounded down to a multiple of
   * 1000/HitFrequency when HitFrequency ≤ 1000, 0xddaa80) × period/1000, × BuildingDamagePercent/100
   * on non-tower buildings; crown towers take CrownTowerDamagePerHit when set, else
   * ceil((CrownTowerDamagePercent+100)·dps/100)·max(HitFrequency,0)/1000 (0xdda984); healing
   * likewise (not on crown towers). Expired buffs are removed after their update.
   */
  private updateBuffs(u: Unit): void {
    const bs = u.buffs;
    let removed = false;
    for (let i = bs.length - 1; i >= 0; i--) {
      const b = bs[i];
      const d = b.def;
      const hf = d.hitFrequency;
      if (hf !== 0) {
        b.hitTimer++;
        let period = hf > 0 ? hf : 0;
        let tick = false;
        if (b.hitTimer === 1 && hf < 0) { period = 1000; tick = true; }
        else if (!(b.hitTimer < idiv(period, 50) || hf < 0)) { b.hitTimer = 0; tick = true; }
        if (tick) {
          let dps = d.dps;
          let hps = d.hps;
          if (hf - 1 >= 0 && hf - 1 < 1000) {
            const q = idiv(1000, hf & 0xffff);
            if (q !== 0) { dps = idiv(dps, q) * q; hps = idiv(hps, q) * q; }
          }
          let dmg: number;
          let heal: number;
          if (u.tower === TOWER_NONE) {
            dmg = idiv(dps * period, 1000);
            heal = idiv(hps * period, 1000);
            if (u.isBuilding && d.buildingDamagePercent !== 0) dmg = idiv(d.buildingDamagePercent * dmg, 100);
          } else {
            const pct = d.crownTowerDamagePercent < -99 ? -100 : d.crownTowerDamagePercent;
            dmg = d.crownTowerDamagePerHit > 0 ? d.crownTowerDamagePerHit
              : idiv(idiv((pct + 100) * dps + 99, 100) * (hf > 0 ? hf : 0), 1000);
            heal = 0;
          }
          if (dmg > 0) this.queueDamage(u, dmg, dmg, 0, 0, null, 0, b.sourceId);
          if (heal > 0) u.hp = Math.min(u.maxHp, u.hp + heal);
        }
      }
      if (--b.ticksLeft <= 0) { bs[i] = null as unknown as BuffInst; removed = true; }
    }
    if (removed) {
      let w = 0;
      for (let i = 0; i < bs.length; i++) if (bs[i] !== null) bs[w++] = bs[i];
      bs.length = w;
    }
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
   * Projectile updates (vt+0x48 0xf90708). A projectile joins the world list at the end of the tick
   * it was created in, so its first update is on the next tick.
   */
  private updateProjectiles(): void {
    const ps = this.projectiles;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.born !== this.tick && p.alive) this.moveProjectile(p);
      if (p.alive) ps[w++] = p;
    }
    ps.length = w;
  }

  /**
   * Projectile_update 0xf90708 [STAT], the paths supported cards use (no drag/hook, circle scatter,
   * deflection or speed override):
   * - HomingTime: while +0x1bc > 0 the aim is set again from the start through target2 (0xf8fb34);
   * - start delays (+0x1b0, then +0x1b4) count down 50 per update;
   * - Homing aims at the target (0xf91378); remaining = isqrt(dist2(aim, pos));
   * - out-and-back (PingpongVisualTime): t += step; crossing half the time clears the hit list and
   *   skips the update; otherwise the collision check runs at the current position (piercing) and the
   *   projectile moves to start + sin(180·t/PVT)·(aim − start) (sin1024, rounded toward zero);
   *   once t reached PVT it arrives back at its start;
   * - otherwise, while Speed < remaining, it moves Speed toward the aim (truncating), its height on
   *   the arc 0xf927ec, and a piercing one checks collisions at the new position (0xf8f2d0);
   * - arrival: pending damage released, snapped to the aim at max(ConstantHeight, 0) (an
   *   out-and-back one to its start at height 0, unlinking the shooter's attack 0xfc7914), then
   *   Projectile_applyHit 0xf9188c.
   */
  private moveProjectile(p: Projectile): void {
    const def = p.def;
    if (p.homingT > 0) {
      const t2 = p.target2;
      if (t2 === null) p.homingT = 0;
      else {
        this.setAim(p, p.startX, p.startY, t2.x, t2.y);
        p.homingT -= 50;
      }
    }
    if (p.delay > 0) { p.delay = (p.delay > 50 ? p.delay : 50) - 50; return; }
    const t = p.target;
    if (t !== null && def.homing) { p.tx = t.x; p.ty = t.y; p.aimZ = t.z; }
    let dx = p.tx - p.x;
    let dy = p.ty - p.y;
    const rem = isqrt(dx * dx + dy * dy);
    const sp = def.speed;
    const pvt = def.pingpongTime;
    if (pvt > 0) {
      if (p.pingT < pvt) {
        const t0 = p.pingT;
        p.pingT = t0 + p.pingStep;
        const half = pvt >> 1;
        if (half <= p.pingT && t0 < half) { p.hitIds.length = 0; return; }
        const s = sin1024(idiv(p.pingT * 180, pvt));
        const nx = p.startX + idiv(s * (p.tx - p.startX), 1024);
        const ny = p.startY + idiv(s * (p.ty - p.startY), 1024);
        dx = p.x - p.startX;
        dy = p.y - p.startY;
        p.travel = isqrt(dx * dx + dy * dy);
        if (def.pierce) this.projCollide(p, p.x, p.y);
        p.x = nx;
        p.y = ny;
        return;
      }
    } else if (sp < rem) {
      const nx = p.x + idiv(dx * sp, rem);
      const ny = p.y + idiv(dy * sp, rem);
      p.z = this.arcZ(p, nx, ny);
      p.x = nx;
      p.y = ny;
      if (def.pierce) this.projCollide(p, nx, ny);
      return;
    }
    if (def.checkCollisions) { p.reached = true; p.alive = false; return; } // stops without a hit (0xf91790 effect only)
    this.releasePending(p);
    p.reached = true;
    p.alive = false;
    if (p.pingT < 1) {
      p.x = p.tx;
      p.y = p.ty;
      p.z = def.constantHeight > 0 ? def.constantHeight : 0;
    } else {
      p.x = p.startX;
      p.y = p.startY;
      p.z = 0;
      const sh = p.shooter;
      if (sh !== null && sh.state !== ST_DEAD) sh.axe = null; // 0xfc7914(attack, 0)
    }
    this.applyHit(p);
  }

  /**
   * Collision step 0xf8f2d0 [STAT] of a piercing projectile at (x, y): the spatial-grid query
   * 0xf9b008 with ProjectileRadius (cells of that radius on both axes) and ProjectileRadiusY: a
   * circle (buildings by their square, 0xf95084) without RadiusY, else a box of half-sizes
   * (R, RY) (0xf95488; buildings 0xf9564c), in grid order; each candidate is tried by 0xf8ff74 until
   * one asks to stop. (Area effects that deflect projectiles: no supported card has one.)
   */
  private projCollide(p: Projectile, x: number, y: number): void {
    const def = p.def;
    if (def.pierceRadius < 1) return;
    const list = this.gridQueryBox(x, y, def.pierceRadius, def.pierceRadiusY);
    for (let i = 0; i < list.length; i++) if (this.projHit(p, list[i])) break;
    list.length = 0;
  }

  /**
   * Per-candidate hit 0xf8ff74 [STAT]: skipped when OnlyEnemies and on the projectile's team, already
   * on its hit list, on a layer it does not affect (air without AoeToAir, ground without
   * AoeToGround, a jumping unit (state 5) without AoeToAir), or without hitpoints; otherwise its id
   * joins the hit list and the damage (crown-tower value for crown towers) is queued with the
   * projectile's key; a unit with movement is knocked back from the projectile's position (or
   * along its flight with DoDirectionalPushback, 0xfcfe18); TargetBuff lands at once (0xf8f890).
   * With CheckCollisions the flight ends at the first target alive before the hit. Hidden and
   * deploying actors are not exempt (0xf82e68 is called without its state checks).
   */
  private projHit(p: Projectile, a: Unit): boolean {
    const def = p.def;
    if (def.onlyEnemies && a.team === p.team) return false;
    if (p.hitIds.includes(a.id)) return false;
    if (a.isAir ? !def.aoeToAir : !def.aoeToGround) return false;
    if (a.jumping && !def.aoeToAir) return false;
    if (a.maxHp <= 0 || a.state === ST_DEAD) return false;
    if (a.tunneling) return false; // the engine's Miner tunnel (A: native state 6 is not modelled)
    p.hitIds.push(a.id);
    const hp = a.hp;
    this.queueDamage(a, p.damage, p.towerDamage, p.crownPct, p.key, null, 0, p.id);
    if (this.mobile(a) && def.pushback >= 1) {
      if (def.directionalPushback) this.directionalPushback(a, p.x - p.startX, p.y - p.startY, def.pushback, def.pushbackAll);
      else this.applyPushback(a, p.x, p.y, def.pushback, def.pushbackAll);
    }
    if (def.targetBuff !== null && def.buffTime > 0) this.applyBuff(a, def.targetBuff, def.buffTime, p.id);
    if (hp > 0 && def.checkCollisions) { p.reached = true; p.alive = false; return true; }
    return false;
  }

  /**
   * Grid_queryCircleXY 0xf9b008 with a Y radius [STAT]: cells (x ± R) × (y ± R) in scan order;
   * without RY the strict circle test (buildings by their square, 0xf95084); with RY a unit must
   * touch the box [x − R, x + R] × [y − RY, y + RY] (closest point within its radius, strictly,
   * 0xf95488) and a building's square must overlap it (0xf9564c). Returns a shared scratch array.
   */
  private gridQueryBox(qx: number, qy: number, R: number, RY: number): Unit[] {
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
    if (qx1 < qx0 || qy1 < qy0) return out;
    const units = this.units;
    for (let i = 0; i < units.length; i++) {
      const a = units[i];
      if (a.radius <= 0 || !a.inGrid) continue;
      const r = a.radius;
      if (RY === 0) {
        if (!this.overlaps(a, qx, qy, R)) continue;
      } else if (a.isBuilding) {
        // 0xf9564c
        if (a.x + r < qx - R || !(qy - RY <= a.y + r) || !(a.x - r < qx + R) || !(a.y - r < qy + RY)) continue;
      } else {
        // 0xf95488 on the box (qx - R, qy - RY, 2R, 2RY)
        const bx = qx - R;
        const by = qy - RY;
        let cx = a.x;
        if (bx + 2 * R <= a.x) cx = bx + 2 * R;
        if (a.x <= bx) cx = bx;
        const ex = cx - a.x;
        if (ex > r || ex < -r) continue;
        let cy = a.y;
        if (by + 2 * RY <= a.y) cy = by + 2 * RY;
        if (a.y <= by) cy = by;
        const ey = cy - a.y;
        if (ey > r || ey < -r) continue;
        if (ex * ex + ey * ey >= r * r) continue;
      }
      const gr = r + (this.mobile(a) ? 250 : 0);
      let ax0 = (a.gx - gr) >> 10;
      let ay0 = (a.gy - gr) >> 10;
      const ax1 = (a.gx + gr) >> 10;
      const ay1 = (a.gy + gr) >> 10;
      if (ax0 < 0) ax0 = 0;
      if (ay0 < 0) ay0 = 0;
      if (ax0 > qx1 || ax1 < qx0 || ay0 > qy1 || ay1 < qy0) continue;
      const cx = ax0 > qx0 ? ax0 : qx0;
      const cy = ay0 > qy0 ? ay0 : qy0;
      out.push(a);
      keys.push(((cx - qx0) * (qy1 - qy0 + 1) + (cy - qy0)) * 65536 + i);
    }
    if (out.length > 1) this.sortByKeys(out, keys);
    return out;
  }

  /** Stable reorder of `out` by `keys` (grid scan order, then list index). */
  private sortByKeys(out: Unit[], keys: number[]): void {
    const idx = this.scratchIdx;
    idx.length = 0;
    for (let i = 0; i < out.length; i++) idx.push(i);
    idx.sort((p, q) => keys[p] - keys[q]);
    const copy = this.scratch2;
    copy.length = 0;
    for (let i = 0; i < idx.length; i++) copy.push(out[idx[i]]);
    out.length = 0;
    for (let i = 0; i < copy.length; i++) out.push(copy[i]);
    copy.length = 0;
  }

  /**
   * Characters spawned where a projectile lands, 0xf9188c [STAT]: SpawnCharacterCount members at
   * the impact point plus Deploy_formationOffset 0xd42ce0 (index i of n, ring of the character's
   * CollisionRadius when n > 1, no width, flipped for team 0, the impact point's lane, the
   * character's SpawnAngleShift), created by 0xd35ab4 (clamped into the arena, lane from its
   * position with the impact x as hint); SpawnConstPriority gives member i the target priority
   * (20·i)²; SpawnCharacterDeployTime starts the deploy (0xf85324); a ground character is moved to
   * dry land (0xd392c8).
   */
  private spawnFromProjectile(p: Projectile): void {
    const def = p.def;
    const u = def.spawnUnit!;
    const n = def.spawnCount;
    const ix = p.tx;
    const iy = p.ty;
    const lane = this.laneOf(ix, iy);
    const r = n !== 1 ? u.collisionRadius : 0;
    const ticks = Math.round((def.spawnDeployTime > 0 ? def.spawnDeployTime : u.deployTime) / TICK_MS);
    for (let i = 0; i < n; i++) {
      const [ox, oy] = formationOffset(i, n, r, 0, p.team === 0, lane, u.spawnAngleShift, 0, this.laneSeqDeploy);
      const m = this.createUnit(p.team, p.spell || u.name, u, ix + ox, iy + oy, ticks, ix);
      if (def.spawnConstPriority) m.prio = (20 * i) * (20 * i);
      if (u.flyingHeight === 0 && !this.fixture) {
        // after 0xd35ab4 (whose lane stays): z == 0 -> nearest dry position (0xd392c8)
        const d = this.nearestDry(m.x, m.y, -1);
        m.x = d & 0xffff;
        m.y = d >> 16;
      }
    }
  }

  /**
   * Projectile_applyHit 0xf9188c [STAT]. Without Radius: the target (if still referenced) takes the
   * damage wherever it is (0xf8f618, crown-tower value for towers, the projectile's damage key),
   * TargetBuff landing with it, and Pushback away from the aim point (or along the flight with
   * DoDirectionalPushback, 0xfcfe18). With Radius: World_areaDamage at the aim point with
   * MaximumTargets and the spell wave's group (0xf8f03c); a piercing projectile instead checks
   * collisions once more where it stopped (not an out-and-back one at its end). Then spawned
   * characters, the SpawnAreaEffectObject, SpawnProjectile copies (while the spawn chain lasts) and
   * the chain hop.
   */
  private applyHit(p: Projectile): void {
    const def = p.def;
    if (this.recordEvents) this.events.push({ tick: this.tick, type: 'impact', team: p.team, x: p.x, y: p.y, name: p.spell || p.def.name, id: p.id });
    if (def.radius < 1) {
      const t = p.target;
      if (t !== null) {
        if (p.damage > 0) this.queueDamage(t, p.damage, p.towerDamage, p.crownPct, p.key, def.targetBuff, def.buffTime, p.id);
        if (def.pushback > 0) {
          if (def.directionalPushback) this.directionalPushback(t, p.x - p.startX, p.y - p.startY, def.pushback, def.pushbackAll);
          else this.applyPushback(t, p.tx, p.ty, def.pushback, def.pushbackAll);
        }
      }
    } else if (def.pierce) {
      if (def.pingpongTime <= 0) this.projCollide(p, p.tx, p.ty);
    } else {
      // 0xf8f03c: PushbackAll is not passed to the splash (p21 = 0)
      this.areaDamage(p.team, p.tx, p.ty, def.radius, p.aoeAir, p.aoeGround, p.damage, p.towerDamage, p.crownPct, p.pushback, false,
        def.targetBuff, def.buffTime, p.id, p.group, def.maxTargets, p.key);
    }
    if (def.pierce) this.projCollide(p, p.x, p.y);
    if (def.spawnUnit) this.spawnFromProjectile(p);
    const sp = def.spawnProjectile;
    if (sp !== null && p.chainLeft >= 1) this.spawnProjectiles(p, sp);
    if (def.chainRadius > 0 && p.chainHits < def.chainCount) this.chainHop(p);
  }

  /**
   * SpawnProjectile copies, 0xf9188c [STAT]: max(SpawnCount, 1) copies k = 0..n−1 of the spawned
   * projectile, each from where this one stopped at its aim height, aimed at the aim point plus
   * (aim − start) turned by SpawnRadius·(k − n/2)/n degrees (0x1295174) (SpawnAxisX/Y: MinDistance
   * along x or y instead), set up with no shooter (so a piercing one is aimed ProjectileRange from
   * its start); they keep this one's damage key unless ChainIsNewProjectile and continue the chain
   * with one link less. They join the world at the end of the tick.
   */
  private spawnProjectiles(p: Projectile, sp: ProjectileDef): void {
    const def = p.def;
    const n = sp.spawnProjCount < 2 ? 1 : sp.spawnProjCount;
    let k = -(n >> 1);
    for (let left = n; left > 0; left--, k++) {
      const c = new Projectile(this.nextProjId++, sp, p.team, p.x, p.y, this.tick);
      if (def.spawnAxisX) p.axisDir = p.tx < 9000 ? 1 : -1;
      if (!def.chainIsNew) c.key = p.key;
      c.sourceId = p.sourceId;
      c.spell = p.spell;
      c.fromParent = true;
      const [vx, vy] = rotate1024(p.tx - p.startX, p.ty - p.startY, idiv(sp.spawnProjRadius * k, n));
      let ax: number;
      let ay = p.ty;
      if (!def.spawnAxisX) {
        if (!def.spawnAxisY) {
          ay = vy + p.ty;
          ax = vx + p.tx;
        } else {
          const d = p.team === 0 ? -1 : 1;
          ax = p.tx;
          p.axisDir = d;
          ay = p.ty - d * def.minDistance;
        }
      } else {
        ax = p.tx + p.axisDir * def.minDistance;
      }
      this.setupProjectile(c, null, p.x, p.y, p.aimZ, null, ax, ay);
      c.chainLeft = p.chainLeft - 1;
      c.axisDir = p.axisDir;
      this.projectiles.push(c);
    }
  }

  /**
   * Chain hop, the ChainedHitRadius tail of 0xf9188c [STAT]: the nearest actor (world-list order,
   * strict <) whose isqrt distance from the projectile is below ChainedHitRadius, valid for the
   * projectile (0xf94824 as a projectile: enemy, targetable, not on its ignore list; air and ground
   * alike, crown towers included) becomes the new target: the projectile is set up again from where
   * it is (Projectile_setup: hit count + 1, target onto the ignore list, pending damage registered
   * at once), aims at the mirror of its start through the hit point (homing follows the target) and
   * waits 150 ms (+0x1b0) before flying on.
   */
  private chainHop(p: Projectile): void {
    const def = p.def;
    const units = this.units;
    let best: Unit | null = null;
    let bestD = 0x7fffffff;
    for (let i = 0; i < units.length; i++) {
      const a = units[i];
      if (a.team === p.team || a.maxHp <= 0 || a.hidden || a.tunneling || a.waitTicks > 0) continue;
      if (a.state === ST_DEAD && a.tower !== TOWER_NONE) continue; // tower ruins are not actors
      if (p.ignoreIds.includes(a.id)) continue;
      const dx = a.x - p.x;
      const dy = a.y - p.y;
      const d = isqrt(dx * dx + dy * dy);
      if (d < def.chainRadius && d < bestD) { best = a; bestD = d; }
    }
    if (best === null) return;
    this.setupProjectile(p, null, p.x, p.y, p.aimZ, best, p.tx * 2 - p.startX, p.ty * 2 - p.startY);
    p.reached = false;
    p.alive = true;
    p.delay = 150;
    this.registerPending(p);
  }

  /** Directional pushback 0xfcfe18 [STAT]: origin 100 units behind the target along (dx, dy). */
  private directionalPushback(t: Unit, dx: number, dy: number, amount: number, all: boolean): void {
    const l = isqrt(dx * dx + dy * dy);
    const bx = l !== 0 ? idiv(dx * 100, l) : dx;
    const by = l !== 0 ? idiv(dy * 100, l) : dy;
    this.applyPushback(t, t.x - bx, t.y - by, amount, all);
  }

  // ---------------------------------------------------------------- damage & death

  /**
   * World_flushDamageQueue 0xf992e0 -> Damage_apply 0xfcaeec per event in queue order [STAT]:
   * crown towers take the crown-tower value (TowerDamage, or ceil((max(p,-100)+100)·dmg/100),
   * 0xde0334/0xe5aed8); nothing happens for 0 damage; damage-reduction buffs scale it (0xfc1e84,
   * at least 1); a non-zero damage key already recorded on the target within the last 1000 ms only
   * refreshes the record's time, else it is recorded; then the hit (shield first, excess on the
   * breaking hit lost, 0xfcb29c) and the landed-damage buff (0xfd09ac). Attacker damage multipliers
   * (buff +0x38/+0x3c) have no supported source.
   */
  private flushDamage(): void {
    const now = this.tick * TICK_MS;
    for (let i = 0; i < this.dmgN; i++) {
      const t = this.dmgTarget[i];
      if (t.state === ST_DEAD) continue;
      let amount = this.dmgAmount[i];
      if (t.tower !== TOWER_NONE) {
        if (this.dmgTower[i] >= 0) amount = this.dmgTower[i];
        else if (this.dmgPct[i] !== 0) amount = Math.trunc(((Math.max(this.dmgPct[i], -100) + 100) * amount + 99) / 100);
      }
      if (amount <= 0) continue;
      if (t.buffs.length) {
        amount = this.reduceDamage(t, amount);
        if (amount < 2) amount = 1;
      }
      const key = this.dmgKey[i];
      if (key !== 0) {
        const ks = t.dmgKeys;
        let j = 0;
        while (j < ks.length && ks[j] !== key) j++;
        if (j < ks.length) { t.dmgKeyTimes[j] = now; continue; }
        ks.push(key);
        t.dmgKeyTimes.push(now);
      }
      if (t.tower === TOWER_KING && t.kingState === KING_INACTIVE) this.activateKing(t);
      t.lastHurtTick = this.tick;
      // Shield absorbs first; excess damage on the breaking hit is lost [STAT 0xfcb29c].
      if (t.shield > 0) {
        t.shield = Math.max(0, t.shield - amount);
      } else {
        t.hp -= amount;
      }
      if (t.hp <= 0) this.kill(t);
      const buff = this.dmgBuff[i];
      if (buff !== null && this.dmgBuffTime[i] > 0) this.applyBuff(t, buff, this.dmgBuffTime[i], this.dmgSrc[i]);
    }
    // release references
    for (let i = 0; i < this.dmgN; i++) { this.dmgTarget[i] = null as unknown as Unit; this.dmgBuff[i] = null; }
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
   * End check at the end of a world tick. A King at 0 HP ends the match at once [STAT runner
   * audit]. Time is up (0xd360a8 / timeline 0xd5665c) at the end of regulation when the crowns
   * differ, during overtime as soon as they differ, and at the end of overtime. Then the battle
   * manager (0x10ca9a0) skips the end check while the tiebreak gate holds (equal crowns, NoDraws)
   * and runs the tiebreak from the next tick on; otherwise the end check 0x10cb17c -> 0xd3e360 ends
   * the match with the crown winner (equal crowns: a draw, -1).
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
    if (t < this.regulationTicks) return;
    if (p0.crowns === p1.crowns && t < this.regulationTicks + this.overtimeTicks) return;
    if (this.tiebreakGate()) {
      this.timeUp = true;
      return;
    }
    this.endMatch(t === this.regulationTicks ? 'time' : 'overtime');
  }

  /** 0xd3e360 (non-BestOfGame branch): winner by crowns (0xfa4038), equal crowns -1. */
  private endMatch(reason: BattleResult['reason']): void {
    const a = this.players[0].crowns;
    const b = this.players[1].crowns;
    this.result = { winner: a === b ? -1 : a > b ? 0 : 1, reason, tick: this.tick };
  }

  /**
   * Tiebreak gate of 0x10ca9a0: crowns equal (0xd3d63c) && GameMode.NoDraws && !touchdown (0xd36084,
   * TargetTouchdowns; no touchdown modes here) && !tiebreak done (+0x1ef) && !ended (0xd4220c).
   */
  private tiebreakGate(): boolean {
    return this.players[0].crowns === this.players[1].crowns && this.noDraws && !this.tiebreakDone && this.result === null;
  }

  /**
   * One battle-manager tick of the tiebreak (0x10ca9a0, time up and gate held) [STAT]. Clock +0x1f4
   * += 50 (compared before the add). Up to 1450 ms: the field is cleared (0x10cad30) and, if it
   * held anything, one battle tick runs (0xd33f74). From 3250 ms: the towers drain (0x10cae90)
   * until the lowest tower HP (0xd3d464) is gone or both sides' lowest are equal (0x10cb060); then
   * done (+0x1ef). BestOfGame: equal sides at 1 HP (or a dead King) run the draw clock +0x1f8 to
   * 2500 ms, then the drain picks one side at random (the coin flip). Every tiebreak tick ends with
   * the world's damage flush (vt+0x90), its maintenance (vt+0x18) and the command manager (0xd75ed0).
   */
  private tiebreakTick(): void {
    const old = this.tiebreakMs;
    this.tiebreakMs = old + 50;
    if (old <= 1450) {
      if (this.tiebreakClear() > 0) this.worldTick();
    } else if (old >= 3250) {
      // 0xd3c0ec: leader (King) HP of side 0 / 1
      const kingDead = this.players[0].king.hp < 1 || this.players[1].king.hp < 1;
      let done: boolean;
      if (!this.bestOfGame) {
        this.tiebreakDrain(false);
        done = this.lowestTowerHp() < 1 || this.towersTied();
      } else {
        const draw = this.towersTied() ? kingDead || this.lowestTowerHp() === 1 : kingDead;
        let drain = !draw;
        if (draw) {
          if (this.drawMs <= 2499) this.drawMs += 50;
          else if (kingDead) this.players[0].king.hp = 1; // leader 0 health +0x10 = 1
          else drain = true;
        }
        if (drain) this.tiebreakDrain(true);
        done = this.lowestTowerHp() <= 0 && !kingDead;
      }
      if (done) {
        this.projectileMaintenance(); // world vt+0x18(0)
        this.tiebreakDone = true;
      }
    }
    this.flushDamage(); // world vt+0x90
    this.projectileMaintenance(); // world vt+0x18(0)
    this.removeDead();
    this.commitCommands(); // command manager 0xd75ed0
  }

  /**
   * 0x10cad30 [STAT]: over the world list in id order (area effects from 3,000,000, projectiles
   * from 4,000,000, characters from 5,000,000) area effects and projectiles are removed and every
   * character except the crown towers (tower class vt+0x178, IsSummonerTower, CaptureTower) gets
   * Actor_resumeDefaultState (0xf81a28; here the attack reset the engine uses for it) and a queued
   * kill (0xfca24c: damage = its current HP, flag 8). Returns the number of actors found.
   */
  private tiebreakClear(): number {
    let n = this.areaEffects.length + this.projectiles.length;
    this.areaEffects.length = 0;
    this.projectiles.length = 0;
    for (const u of this.units) {
      if (u.tower !== TOWER_NONE) continue;
      if (u.state !== ST_DEAD) {
        this.resetAttack(u);
        this.queueDamage(u, u.hp, -1, 0);
      }
      n++;
    }
    return n;
  }

  /**
   * Lowest tower HP of a side, 0xd3d4c8: min over its live Princess towers (list ctx +0x110) and
   * its King (leader), from 999999.
   */
  private sideLowestHp(team: number): number {
    const p = this.players[team];
    let v = 999999;
    for (const t of p.princess) if (t.alive && t.hp < v) v = t.hp;
    return Math.min(v, p.king.hp);
  }

  /** 0xd3d464: lowest tower HP over both sides. */
  lowestTowerHp(): number {
    return Math.min(this.sideLowestHp(0), this.sideLowestHp(1));
  }

  /** 0x10cb060 (1v1): both sides' lowest tower HP are equal. */
  towersTied(): boolean {
    return this.sideLowestHp(0) === this.sideLowestHp(1);
  }

  /**
   * Tower drain 0x10cae90(mgr, 0, coinFlip) [STAT]: the amount follows the lowest tower HP L
   * (L < 21: 1, < 200: 10, < 500: 20, > 999: 50, else 40); every live Princess tower then the King of
   * side 0, then side 1, gets it as queued damage (0xfca4d8, flag 8). With coinFlip, L == 1 and equal
   * sides, only side Rng_rand(battle RNG, 2) drains. The DummyKingTower leaders (0xde09f4) are not
   * drained; the crown towers here are never those.
   */
  private tiebreakDrain(coinFlip: boolean): void {
    const low = this.lowestTowerHp();
    const amount = low < 21 ? 1 : low < 200 ? 10 : low < 500 ? 20 : low > 999 ? 50 : 40;
    let from = 0;
    let to = 2;
    if (low === 1 && this.towersTied() && coinFlip) {
      from = this.nrng.next(2);
      to = from + 1;
    }
    for (let i = from; i < to; i++) {
      const p = this.players[i];
      for (const t of p.princess) if (t.alive) this.queueDamage(t, amount, -1, 0);
      this.queueDamage(p.king, amount, -1, 0);
    }
  }

  // ---------------------------------------------------------------- state hash

  /** Hash of the complete simulation state (for replay/determinism tests). */
  hash(): string {
    const h = new Hasher();
    h.add(this.tick);
    h.add(this.timeUp ? 1 : 0); h.add(this.tiebreakMs); h.add(this.drawMs); h.add(this.tiebreakDone ? 1 : 0);
    h.add(this.nrng.state);
    for (const p of this.players) {
      h.add(p.elixir); h.add(p.pending); h.add(p.crowns);
      for (const c of p.hand) h.add(c);
      for (const c of p.queue) h.add(c);
      h.add(p.cycleTimer);
    }
    for (const u of this.units) {
      h.add(u.id); h.add(u.x); h.add(u.y); h.add(u.hp); h.add(u.shield); h.add(u.state);
      h.add(u.deployTicks); h.add(u.atkTimer); h.add(u.atkDelay); h.add(u.target ? u.target.id : -1);
      h.add(u.locked ? 1 : 0); h.add(u.kingState); h.add(u.kingTicks); h.add(u.kbActive ? u.kbStep : -1000);
      h.add(u.spawnTimer); h.add(u.spawnLeft); h.add(u.spawnSub); h.add(u.charge); h.add(u.load); h.add(u.retargetCd);
      h.add(u.hitStarted ? 1 : 0); h.add(u.loaded ? 1 : 0); h.add(u.finishMs);
      h.add(u.lifeTicks); h.add(u.decayed); h.add(u.rampMs); h.add(u.manaT); h.add(u.hideT); h.add(u.tunneling ? 1 : 0);
      h.add(u.pending); h.add(u.pendingDur); h.add(u.waitTicks); h.add(u.dmgKeys.length);
      h.add(u.prio); h.add(u.axeMs); h.add(u.axeWait); h.add(u.axe ? u.axe.id : -1); h.add(u.pushImmune ? 1 : 0);
      for (const b of u.buffs) { h.add(b.sourceId); h.add(b.ticksLeft); h.add(b.hitTimer); }
    }
    for (const a of this.areaEffects) { h.add(a.id); h.add(a.life); }
    for (const p of this.projectiles) {
      h.add(p.id); h.add(p.x); h.add(p.y); h.add(p.tx); h.add(p.ty); h.add(p.target ? p.target.id : -1);
      h.add(p.z); h.add(p.pingT); h.add(p.homingT); h.add(p.chainLeft); h.add(p.hitIds.length); h.add(p.delay); h.add(p.chainHits);
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
