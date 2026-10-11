// Arena geometry, tile flags, path cell costs, the dynamic building-occlusion grid and
// the native arena collision, on the 36x64 path grid of 500-unit cells.
//
// Sources: tilemap.csv [DATA]; libg 160402020 decompilation [STAT]:
// - tile bits: 1|2 lane road (0xe8b560), 32 "blocked" tile = river water (0xe8b6e0), 64 static
//   building tile (0xe8b734). Bit 16 marks no-deploy cells and plays no part in pathing or collision.
// - Path_cellCost 0x11d9304: -1 outside the grid; bit 32: water cost for Hovering/JumpEnabled actors,
//   else the blocked cost; bit 64: blocked cost; actor states 6/7/15: default cost; else road cost
//   on a lane cell (matching-road cost on the actor's own lane) or default cost; then, with dynamic
//   occlusions, max(cost, dynamic grid).
// - dynamic grid (0x11d8d9c each pre-tick): every building in world-list order stamps the building
//   cost (PATHFINDING_BUILDING_COST) over the cells of a square of half-size CollisionRadius around the
//   cell corner at or above its position (0x11d8f10); per-team hashes of the occluder ids flag
//   "friendly occlusion changed" for re-pathing. The previous tick's grid is kept for comparing paths.
// - Arena_collision 0x11d988c: the move is applied, then per axis a crossing into a neighbour cell
//   is undone (clamped to the cell edge) if that cell is outside the grid, or if blocking is on and
//   the cell is a bit-32 tile. Blocking is the caller's flag; for characters it is forced to
//   (state == deploying && ground) unless the caller set it.

import type { GameData } from './data.ts';
import { EMPTY, PathSearch } from './path.ts';

export const CELL = 500;
export const GRID_W = 36;
export const GRID_H = 64;
export const ARENA_W = 18000;
export const ARENA_H = 32000;
export const RIVER_Y0 = 15000;
export const RIVER_Y1 = 17000;

export const F_ROAD_L = 1;
export const F_ROAD_R = 2;
/** No-deploy tile (tower pads, back corners, river banks). Not used by pathing or collision. */
export const F_BLOCKED = 16;
/** Native "blocked" tile bit 0xe8b6e0: the river. */
export const F_WATER = 32;
/** Native static building tile bit 0xe8b734 (absent from the standard map). */
export const F_OCCLUDER = 64;

/** Path cost classes: bit 0 = crosses water (Hovering/JumpEnabled), bit 1 = state 6/7/15 costs. */
export const PATH_WALK = 0;
export const PATH_CROSS = 1;
export const PATH_SPAWN = 2;

export class Arena {
  /** Grid size in cells (36x64; a synthetic fixture grid in fixture mode). */
  readonly w: number;
  readonly h: number;
  readonly flags: Uint16Array;
  readonly costWater: number;
  readonly costBlocked: number;
  readonly costBuilding: number;
  readonly costDefault: number;
  readonly costRoad: number;
  readonly costMatchingRoad: number;
  readonly heuristicCost: number;
  readonly dynamicOcclusions: boolean;
  readonly friendlyOnlyOcclusions: boolean;
  /** Dynamic occlusion grid of the current tick and of the previous tick. */
  dyn: Int32Array;
  dynPrev: Int32Array;
  /** Per-team occluder hash and "changed this tick" flags (0x11d8d9c). */
  readonly teamHash: [number, number] = [0, 0];
  readonly teamChanged: [boolean, boolean] = [false, false];
  /** Bumped whenever the dynamic grid's contents change; invalidates cached paths. */
  version = 0;

  private search: PathSearch;
  private costs: Int32Array[] = [];
  private costsVersion = -1;
  private pathCache = new Map<number, Int32Array>();

  /** `fixture`: a synthetic grid of that many units with no tile flags (native fixture arenas). */
  constructor(data: GameData, fixture?: { width: number; height: number }) {
    const t = data.tilemap;
    if (t.width !== GRID_W || t.height !== GRID_H) throw new Error('unexpected tilemap size');
    this.w = fixture ? Math.ceil(fixture.width / CELL) : GRID_W;
    this.h = fixture ? Math.ceil(fixture.height / CELL) : GRID_H;
    const G = data.globals;
    const gi = (k: string, d: number) => (typeof G[k] === 'number' ? (G[k] as number) : d);
    const gb = (k: string, d: boolean) => (typeof G[k] === 'boolean' ? (G[k] as boolean) : d);
    this.costWater = gi('PATHFINDING_WATER_COST', 7);
    this.costBlocked = gi('PATHFINDING_BLOCKED_COST', 50);
    this.costBuilding = gi('PATHFINDING_BUILDING_COST', 50);
    this.costDefault = gi('PATHFINDING_DEFAULT_COST', 8);
    this.costRoad = gi('PATHFINDING_ROAD_COST', 5);
    this.costMatchingRoad = gi('PATHFINDING_MATCHINGROAD_COST', 5);
    this.heuristicCost = gi('PATHFINDING_DEFAULTHEURISTIC_COST', 5);
    this.dynamicOcclusions = gb('PATHFINDING_DYNAMIC_OCCLUSIONS', true);
    this.friendlyOnlyOcclusions = gb('PATHFINDING_FRIENDLYONLY_OCCLUSIONS', true);
    // Actor lanes (actor+0x158) are not modelled: with this build's equal road and matching-road
    // costs the lane never changes a cost.
    if (this.costRoad !== this.costMatchingRoad) throw new Error('matching-road cost differs from road cost: actor lanes needed');
    if (gi('PATHFINDING_HEURISTIC_METHOD', 1) !== 1) throw new Error('only heuristic method 1 is ported');
    this.flags = fixture ? new Uint16Array(this.w * this.h) : Uint16Array.from(t.grid);
    this.dyn = new Int32Array(this.w * this.h);
    this.dynPrev = new Int32Array(this.w * this.h);
    this.search = new PathSearch(this.w, this.h, this.heuristicCost);
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

  /** Deployable ground (not water, not a no-deploy tile). */
  walkableAt(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= ARENA_W || y >= ARENA_H) return false;
    return (this.flags[Arena.cellOf(x, y)] & (F_WATER | F_BLOCKED)) === 0;
  }

  /** Bit-32 ("blocked") tile test 0xe8b6e0 on cell coordinates. */
  waterCell(cx: number, cy: number): boolean {
    return (this.flags[cx + this.w * cy] & F_WATER) !== 0;
  }

  /** 0x11d9674: the dynamic grid marks the cell as building-occluded. */
  dynOccluded(cx: number, cy: number): boolean {
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h || !this.dynamicOcclusions) return false;
    return this.dyn[cx + this.w * cy] >= this.costBuilding;
  }

  // ---------------------------------------------------------------- dynamic occlusion

  /** dynPrev already equals dyn (the grid did not change last tick). */
  private prevEqual = false;

  /**
   * A tick whose occluders are exactly last tick's (same buildings, positions, radii, order): the
   * grid is unchanged, so only the previous-tick copy needs to catch up. Same result as a rebuild.
   */
  keepOcclusion(): void {
    if (!this.prevEqual) { this.dynPrev.set(this.dyn); this.prevEqual = true; }
    this.teamChanged[0] = false;
    this.teamChanged[1] = false;
  }

  /** Start a tick's occlusion pass: the current grid becomes the previous one; the new one is empty. */
  beginOcclusion(): void {
    const t = this.dynPrev;
    this.dynPrev = this.dyn;
    this.dyn = t;
    t.fill(0);
  }

  /** 0x11d8f10: stamp `cost` over the square of half-size (rx, ry) around the cell corner at/above (x, y). */
  stampOccluder(x: number, y: number, rx: number, ry: number): void {
    const bx = trunc((x - 1) / CELL) * CELL + CELL;
    const left = bx - rx;
    if (left < 0) return;
    const by = trunc((y - 1) / CELL) * CELL + CELL;
    const bottom = by - ry;
    if (bottom < 0) return;
    const right = bx + rx;
    if (right >= this.w * CELL) return;
    const top = by + ry;
    if (top >= this.h * CELL) return;
    const cx0 = trunc(left / CELL);
    const cx1 = trunc((right - 1) / CELL);
    const cy0 = trunc(bottom / CELL);
    const cy1 = trunc((top - 1) / CELL);
    const v = this.costBuilding;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const i = cx + this.w * cy;
        if (this.dyn[i] < v) this.dyn[i] = v;
      }
    }
  }

  /** Finish the occlusion pass with the per-team occluder hashes. */
  endOcclusion(h0: number, h1: number): void {
    this.teamChanged[0] = h0 !== this.teamHash[0];
    this.teamChanged[1] = h1 !== this.teamHash[1];
    this.teamHash[0] = h0;
    this.teamHash[1] = h1;
    const a = this.dyn;
    const b = this.dynPrev;
    let same = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) { same = false; this.version++; this.pathCache.clear(); break; }
    }
    this.prevEqual = same;
  }

  /** The re-path trigger 0x11d921c / 0x11d9204 for a team. */
  occlusionChanged(team: number): boolean {
    return this.friendlyOnlyOcclusions ? this.teamChanged[team] : this.teamChanged[0] || this.teamChanged[1];
  }

  /**
   * 0x11d9c2c: does the occlusion change between the previous and the current tick touch either
   * path (a cell of the old path newly occluded, or a cell of the new path newly freed)?
   */
  pathTouchedByOcclusion(oldPath: Int32Array, oldFrom: number, newPath: Int32Array): boolean {
    if (oldPath.length - oldFrom === 0 || newPath.length === 0) return true;
    const cur = this.dyn;
    const prev = this.dynPrev;
    for (let i = oldFrom; i < oldPath.length; i++) {
      const c = oldPath[i];
      if (prev[c] === 0 && cur[c] > 0) return true;
    }
    for (let i = 0; i < newPath.length; i++) {
      const c = newPath[i];
      if (prev[c] > 0 && cur[c] === 0) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- path costs and search

  /** Path_cellCost 0x11d9304 for an actor of cost class `cls`, at an in-grid cell. */
  cellCost(cx: number, cy: number, cls: number): number {
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return -1;
    const i = cx + this.w * cy;
    const f = this.flags[i];
    if (f & F_WATER) return cls & PATH_CROSS ? this.costWater : this.costBlocked;
    if (f & F_OCCLUDER) return this.costBlocked;
    if (cls & PATH_SPAWN) return this.costDefault;
    const c = f & 3 ? this.costRoad : this.costDefault;
    if (this.dynamicOcclusions) {
      const d = this.dyn[i];
      return d > c ? d : c;
    }
    return c;
  }

  private costTable(cls: number): Int32Array {
    if (this.costsVersion !== this.version) {
      this.costs = [];
      this.costsVersion = this.version;
    }
    let t = this.costs[cls];
    if (!t) {
      t = new Int32Array(this.w * this.h);
      for (let cy = 0; cy < this.h; cy++) for (let cx = 0; cx < this.w; cx++) t[cx + this.w * cy] = this.cellCost(cx, cy, cls);
      this.costs[cls] = t;
    }
    return t;
  }

  /**
   * Native A* (path.ts) from cell (sx, sy) to (gx, gy) — the goal may lie outside the grid (native
   * fallback goal). Returns the cells in WALKING order (first step first, goal last), start excluded.
   * Cached per (class, start, goal) until the dynamic grid changes. Must not be mutated.
   */
  findPath(sx: number, sy: number, gx: number, gy: number, cls: number): Int32Array {
    const inGrid = gx >= 0 && gy >= 0 && gx < this.w && gy < this.h;
    const key = inGrid ? ((cls * 4096 + sx + this.w * sy) * 4096 + gx + this.w * gy) : -1;
    if (inGrid) {
      const cached = this.pathCache.get(key);
      if (cached) return cached;
    }
    this.search.cost = this.costTable(cls);
    const rev = this.search.search(sx, sy, gx, gy);
    let path = EMPTY;
    if (rev.length) {
      path = new Int32Array(rev.length);
      for (let i = 0; i < rev.length; i++) path[i] = rev[rev.length - 1 - i];
    }
    if (inGrid) {
      if (this.pathCache.size > 50000) this.pathCache.clear();
      this.pathCache.set(key, path);
    }
    return path;
  }

  /**
   * Arena_collision 0x11d988c: apply (vx, vy) to (x, y); undo per-axis crossings into a cell outside
   * the grid, or into a bit-32 tile when `block` is set. Returns the new position in `out`.
   */
  collide(x: number, y: number, vx: number, vy: number, block: boolean, out: { x: number; y: number }): void {
    const cx = trunc(x / CELL);
    const cy = trunc(y / CELL);
    let nx = x + vx;
    let ny = y + vy;
    const mx = x - cx * CELL; // x % 500 (C remainder; positions are non-negative)
    const my = y - cy * CELL;
    if (vx < 0) {
      if (mx + vx < 0) {
        const n = cx - 1;
        const inside = n >= 0 && cy >= 0 && cx <= this.w && cy < this.h;
        if (!inside || (block && this.waterCell(n, cy))) nx = cx * CELL;
      }
    } else if (vx !== 0 && mx + vx >= CELL) {
      const n = cx + 1;
      const inside = n >= 0 && cy >= 0 && n < this.w && cy < this.h;
      if (!inside || (block && this.waterCell(n, cy))) nx = cx * CELL + CELL - 1;
    }
    if (vy < 0) {
      if (my + vy < 0) {
        const n = cy - 1;
        const inside = n >= 0 && cx >= 0 && cx < this.w && cy <= this.h;
        if (!inside || (block && this.waterCell(cx, n))) ny = cy * CELL;
      }
    } else if (vy !== 0 && my + vy >= CELL) {
      const n = cy + 1;
      const inside = n >= 0 && cx >= 0 && cx < this.w && n < this.h;
      if (!inside || (block && this.waterCell(cx, n))) ny = cy * CELL + CELL - 1;
    }
    out.x = nx;
    out.y = ny;
  }
}

function trunc(v: number): number {
  return v < 0 ? Math.ceil(v) : Math.floor(v);
}
