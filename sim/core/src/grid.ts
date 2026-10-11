// Spatial grid ported from the native world grid (world+0xa0):
//   - cells of 1024 units (index = x >> 10), rebuilt once per tick before the attack phase
//     (native pre-tick 0xf967a4 -> 0xf9ac50); not updated mid-tick
//   - each actor with CollisionRadius > 0 is inserted, in world-list order, into every cell its
//     square [x-r', x+r'] x [y-r', y+r'] overlaps, r' = radius + 250 for actors that can move
//   - queries walk cells x-outer, y-inner and return actors in insertion order within a cell,
//     each once; circle test dist2 < (r + R)^2 (strict), buildings optionally by the closest point
//     of their square (testMode & 1)  [STAT 0xf9b008 / 0xf95434 / 0xf95084]
// See work/native/PORT_NOTES.md §4.1 (owner's Mac / cloud work dir, not in the repo).

import type { Unit } from './entities.ts';

export class SpatialGrid {
  readonly w: number;
  readonly h: number;
  private start: Int32Array; // CSR offsets per cell (length w*h+1)
  private items: Unit[] = [];
  private counts: Int32Array;
  private stamp = 0;

  constructor(width: number, height: number) {
    this.w = ((width - 1) >> 10) + 1;
    this.h = ((height - 1) >> 10) + 1;
    this.start = new Int32Array(this.w * this.h + 1);
    this.counts = new Int32Array(this.w * this.h);
  }

  private cellRange(x: number, y: number, r: number): [number, number, number, number] {
    let x0 = (x - r) >> 10;
    let x1 = (x + r) >> 10;
    let y0 = (y - r) >> 10;
    let y1 = (y + r) >> 10;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 >= this.w) x1 = this.w - 1;
    if (y1 >= this.h) y1 = this.h - 1;
    return [x0, x1, y0, y1];
  }

  /** Rebuild from the world list (order matters: it is the within-cell order). */
  rebuild(actors: Unit[]): void {
    const counts = this.counts;
    counts.fill(0);
    const n = actors.length;
    for (let i = 0; i < n; i++) {
      const a = actors[i];
      if (a.radius <= 0 || a.state === 2 /* dead */) continue;
      const r = a.radius + (a.def.speed > 0 ? 250 : 0);
      const [x0, x1, y0, y1] = this.cellRange(a.x, a.y, r);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) counts[cy * this.w + cx]++;
    }
    const start = this.start;
    let acc = 0;
    for (let c = 0; c < counts.length; c++) { start[c] = acc; acc += counts[c]; }
    start[counts.length] = acc;
    if (this.items.length < acc) this.items.length = acc;
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const a = actors[i];
      if (a.radius <= 0 || a.state === 2) continue;
      const r = a.radius + (a.def.speed > 0 ? 250 : 0);
      const [x0, x1, y0, y1] = this.cellRange(a.x, a.y, r);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const c = cy * this.w + cx;
          this.items[start[c] + counts[c]++] = a;
        }
      }
    }
  }

  /**
   * Actors whose circle (or building square when testMode & 1) meets the circle (x, y, R),
   * in native query order. Appends to `out`.
   */
  queryCircle(x: number, y: number, R: number, testMode: number, out: Unit[]): Unit[] {
    const st = ++this.stamp;
    const [x0, x1, y0, y1] = this.cellRange(x, y, R);
    const start = this.start;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const c = cy * this.w + cx;
        for (let k = start[c], e = start[c + 1]; k < e; k++) {
          const a = this.items[k];
          if (a.gridStamp === st) continue;
          a.gridStamp = st;
          if ((testMode & 1) !== 0 && a.isBuilding) {
            const r = a.radius;
            const ex = (x < a.x - r ? a.x - r : x > a.x + r ? a.x + r : x) - x;
            const ey = (y < a.y - r ? a.y - r : y > a.y + r ? a.y + r : y) - y;
            if (ex > R || ex < -R || ey > R || ey < -R) continue;
            if (ex * ex + ey * ey >= R * R) continue;
          } else {
            const dx = a.x - x;
            const dy = a.y - y;
            const rr = a.radius + R;
            if (dx * dx + dy * dy >= rr * rr) continue;
          }
          out.push(a);
        }
      }
    }
    return out;
  }
}
