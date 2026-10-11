// Arena geometry, tile flags, path costs and A* search on the 36x64 path grid.
//
// Sources (docs/MECHANICS_BRIEF.md §2, §4; globals.csv):
// - grid of 500-unit cells from assets/tilemaps/tilemap.csv; row r covers y 500r..500r+500 (blue at y=0)
// - flags: 1/2 lane road, 16 blocked, 32 water [DATA]
// - step cost 10 (straight) / 14 (diagonal) x destination cell cost; costs default 8, road 5,
//   water 7, blocked 50, building 50 [DATA + native fixture costs 448/280/406/496]
// - neighbour order N, S, W, E, NW, SW, SE, NE; octile heuristic x PATHFINDING_DEFAULTHEURISTIC_COST;
//   open nodes refreshed, closed nodes never reopened; path returned without the start cell [STAT]
// Approximations (A): water is impassable for non-jumping ground units (the 7 cost is assumed to
// serve river-jumping units); heap tie-breaking order is not the native one.

import type { GameData } from './data.ts';

export const CELL = 500;
export const GRID_W = 36;
export const GRID_H = 64;
export const ARENA_W = 18000;
export const ARENA_H = 32000;
export const RIVER_Y0 = 15000;
export const RIVER_Y1 = 17000;

export const F_ROAD_L = 1;
export const F_ROAD_R = 2;
export const F_BLOCKED = 16;
export const F_WATER = 32;

// Neighbour order N, S, W, E, NW, SW, SE, NE. "N" is taken as -y (row index decreasing).
const NB_DX = [0, 0, -1, 1, -1, -1, 1, 1];
const NB_DY = [-1, 1, 0, 0, -1, 1, 1, -1];
const NB_STEP = [10, 10, 10, 10, 14, 14, 14, 14];

export class Arena {
  readonly flags: Uint16Array;
  /** Base cell cost from the tilemap. */
  readonly baseCost: Uint8Array;
  /** Dynamic building occlusion per team (PATHFINDING_FRIENDLYONLY_OCCLUSIONS): count of buildings. */
  readonly occluded: [Uint8Array, Uint8Array];
  readonly costDefault: number;
  readonly costRoad: number;
  readonly costWater: number;
  readonly costBlocked: number;
  readonly costBuilding: number;
  readonly heuristicCost: number;
  /** Bumped whenever occlusion changes; invalidates cached paths. */
  version = 0;

  // A* scratch (reused, no per-search allocation)
  private g = new Int32Array(GRID_W * GRID_H);
  private parent = new Int32Array(GRID_W * GRID_H);
  private openGen = new Uint32Array(GRID_W * GRID_H);
  private closedGen = new Uint32Array(GRID_W * GRID_H);
  private heapPos = new Int32Array(GRID_W * GRID_H);
  private heap = new Int32Array(GRID_W * GRID_H);
  private heapF = new Int32Array(GRID_W * GRID_H);
  private heapN = 0;
  private gen = 0;
  private pathCache = new Map<number, Int32Array>();

  constructor(data: GameData) {
    const t = data.tilemap;
    if (t.width !== GRID_W || t.height !== GRID_H) throw new Error('unexpected tilemap size');
    const G = data.globals;
    const gi = (k: string, d: number) => (typeof G[k] === 'number' ? (G[k] as number) : d);
    this.costDefault = gi('PATHFINDING_DEFAULT_COST', 8);
    this.costRoad = gi('PATHFINDING_ROAD_COST', 5);
    this.costWater = gi('PATHFINDING_WATER_COST', 7);
    this.costBlocked = gi('PATHFINDING_BLOCKED_COST', 50);
    this.costBuilding = gi('PATHFINDING_BUILDING_COST', 50);
    this.heuristicCost = gi('PATHFINDING_DEFAULTHEURISTIC_COST', 5);
    this.flags = Uint16Array.from(t.grid);
    this.baseCost = new Uint8Array(GRID_W * GRID_H);
    for (let i = 0; i < this.flags.length; i++) {
      const f = this.flags[i];
      this.baseCost[i] = f & F_BLOCKED ? this.costBlocked
        : f & F_WATER ? this.costWater
          : f & (F_ROAD_L | F_ROAD_R) ? this.costRoad
            : this.costDefault;
    }
    this.occluded = [new Uint8Array(GRID_W * GRID_H), new Uint8Array(GRID_W * GRID_H)];
  }

  static cellOf(x: number, y: number): number {
    let cx = Math.floor(x / CELL);
    let cy = Math.floor(y / CELL);
    if (cx < 0) cx = 0; else if (cx >= GRID_W) cx = GRID_W - 1;
    if (cy < 0) cy = 0; else if (cy >= GRID_H) cy = GRID_H - 1;
    return cy * GRID_W + cx;
  }

  static cellCenterX(c: number): number {
    return (c % GRID_W) * CELL + (CELL >> 1);
  }

  static cellCenterY(c: number): number {
    return Math.floor(c / GRID_W) * CELL + (CELL >> 1);
  }

  isWaterAt(x: number, y: number): boolean {
    return (this.flags[Arena.cellOf(x, y)] & F_WATER) !== 0;
  }

  /** Ground units may stand on this point (not water, not blocked). */
  walkableAt(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= ARENA_W || y >= ARENA_H) return false;
    return (this.flags[Arena.cellOf(x, y)] & (F_WATER | F_BLOCKED)) === 0;
  }

  /** Mark/unmark the cells a building covers as occluded for its team's pathing. */
  setOcclusion(team: number, x: number, y: number, radius: number, add: boolean): void {
    const occ = this.occluded[team];
    const r = radius + (CELL >> 1);
    const x0 = Math.max(0, Math.floor((x - r) / CELL));
    const x1 = Math.min(GRID_W - 1, Math.floor((x + r) / CELL));
    const y0 = Math.max(0, Math.floor((y - r) / CELL));
    const y1 = Math.min(GRID_H - 1, Math.floor((y + r) / CELL));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const dx = cx * CELL + (CELL >> 1) - x;
        const dy = cy * CELL + (CELL >> 1) - y;
        if (dx * dx + dy * dy <= r * r) {
          const i = cy * GRID_W + cx;
          occ[i] = add ? occ[i] + 1 : Math.max(0, occ[i] - 1);
        }
      }
    }
    this.version++;
    this.pathCache.clear();
  }

  private cellCost(i: number, team: number): number {
    if (this.occluded[team][i] > 0) return this.costBuilding;
    return this.baseCost[i];
  }

  private heapPush(node: number, f: number): void {
    let i = this.heapN++;
    // sift up (strictly smaller f moves up: equal f keeps insertion order bias)
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.heapF[p] <= f) break;
      this.heap[i] = this.heap[p];
      this.heapF[i] = this.heapF[p];
      this.heapPos[this.heap[i]] = i;
      i = p;
    }
    this.heap[i] = node;
    this.heapF[i] = f;
    this.heapPos[node] = i;
  }

  private heapDecrease(node: number, f: number): void {
    let i = this.heapPos[node];
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.heapF[p] <= f) break;
      this.heap[i] = this.heap[p];
      this.heapF[i] = this.heapF[p];
      this.heapPos[this.heap[i]] = i;
      i = p;
    }
    this.heap[i] = node;
    this.heapF[i] = f;
    this.heapPos[node] = i;
  }

  private heapPop(): number {
    const top = this.heap[0];
    const n = --this.heapN;
    if (n > 0) {
      const node = this.heap[n];
      const f = this.heapF[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && this.heapF[r] < this.heapF[l] ? r : l;
        if (this.heapF[c] >= f) break;
        this.heap[i] = this.heap[c];
        this.heapF[i] = this.heapF[c];
        this.heapPos[this.heap[i]] = i;
        i = c;
      }
      this.heap[i] = node;
      this.heapF[i] = f;
      this.heapPos[node] = i;
    }
    return top;
  }

  private heuristic(a: number, b: number): number {
    const dx = Math.abs((a % GRID_W) - (b % GRID_W));
    const dy = Math.abs(Math.floor(a / GRID_W) - Math.floor(b / GRID_W));
    const mn = dx < dy ? dx : dy;
    const mx = dx < dy ? dy : dx;
    return (10 * mx + 4 * mn) * this.heuristicCost;
  }

  /**
   * A* from start cell to goal cell for a ground unit of `team`. Returns the path in walking
   * order without the start cell (empty if start == goal or unreachable). Cached per
   * (team, start, goal) until occlusion changes. The returned array must not be mutated.
   */
  findPath(start: number, goal: number, team: number, canCrossWater: boolean): Int32Array {
    if (start === goal) return EMPTY;
    const key = ((team * 2 + (canCrossWater ? 1 : 0)) * 4096 + start) * 4096 + goal;
    const cached = this.pathCache.get(key);
    if (cached) return cached;
    const path = this.search(start, goal, team, canCrossWater);
    if (this.pathCache.size > 20000) this.pathCache.clear();
    this.pathCache.set(key, path);
    return path;
  }

  private search(start: number, goal: number, team: number, canCrossWater: boolean): Int32Array {
    const gen = ++this.gen;
    this.heapN = 0;
    this.g[start] = 0;
    this.parent[start] = -1;
    this.openGen[start] = gen;
    this.heapPush(start, this.heuristic(start, goal));
    let found = false;
    while (this.heapN > 0) {
      const node = this.heapPop();
      if (node === goal) { found = true; break; }
      this.closedGen[node] = gen;
      const nx = node % GRID_W;
      const ny = (node - nx) / GRID_W;
      const gn = this.g[node];
      for (let k = 0; k < 8; k++) {
        const ax = nx + NB_DX[k];
        const ay = ny + NB_DY[k];
        if (ax < 0 || ay < 0 || ax >= GRID_W || ay >= GRID_H) continue;
        const nb = ay * GRID_W + ax;
        if (this.closedGen[nb] === gen) continue;
        if (!canCrossWater && nb !== goal && (this.flags[nb] & F_WATER) !== 0) continue;
        if (k >= 4 && !canCrossWater) {
          // no diagonal corner cutting across water (A)
          if ((this.flags[ny * GRID_W + ax] & F_WATER) !== 0 || (this.flags[ay * GRID_W + nx] & F_WATER) !== 0) continue;
        }
        const ng = gn + NB_STEP[k] * this.cellCost(nb, team);
        if (this.openGen[nb] === gen) {
          if (ng >= this.g[nb]) continue;
          this.g[nb] = ng;
          this.parent[nb] = node;
          this.heapDecrease(nb, ng + this.heuristic(nb, goal));
        } else {
          this.openGen[nb] = gen;
          this.g[nb] = ng;
          this.parent[nb] = node;
          this.heapPush(nb, ng + this.heuristic(nb, goal));
        }
      }
    }
    if (!found) return EMPTY;
    let n = 0;
    for (let c = goal; c !== start; c = this.parent[c]) n++;
    const out = new Int32Array(n);
    let i = n - 1;
    for (let c = goal; c !== start; c = this.parent[c]) out[i--] = c;
    return out;
  }

  /** Cost of a path (for tests against the native fixture costs). */
  pathCost(start: number, path: Int32Array, team: number): number {
    let prev = start;
    let total = 0;
    for (const c of path) {
      const diag = prev % GRID_W !== c % GRID_W && Math.floor(prev / GRID_W) !== Math.floor(c / GRID_W);
      total += (diag ? 14 : 10) * this.cellCost(c, team);
      prev = c;
    }
    return total;
  }
}

const EMPTY = new Int32Array(0);
