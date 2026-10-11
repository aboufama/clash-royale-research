// Native A* path search, ported from libg 160402020 (docs/FIDELITY.md "Path search").
//
// Path_astarRun 0x11d84ac / expand 0x11d7e18 / heuristic 0x11d83a0 [STAT; 12 native fixture
// cases reproduced exactly by core/test/path.test.ts]:
// - the start cell is expanded first and never enters the open heap;
// - neighbours N (y-1), S (y+1), W (x-1), E (x+1) cost 10 x cell cost, then NW, SW, SE, NE cost 14;
//   no corner-cutting rule; cells with cost -1 (outside the grid) are skipped;
// - f = g + heuristicWeight x h, h = 10*(dx+dy) - 6*min(dx,dy) (PATHFINDING_HEURISTIC_METHOD 1);
// - binary min-heap on f: push sifts up while f[parent] > f[node]; pop moves the last entry to the
//   root and sifts down taking the right child if f[right] < f[moving], then the left child if
//   f[left] < f[chosen] (ties between children go right);
// - open nodes are re-scored when the new f is smaller (REFRESH_OPENNODES), closed nodes never
//   reopen (REOPEN_CLOSEDNODES false); the search stops once the goal is closed or the heap is empty;
// - the result runs from the goal back to (excluding) the start; empty when unreachable or start == goal;
// - a goal outside the grid is first replaced by the nearest in-grid cell inside a box of half-size
//   |goal - start| around it (first minimum in row-major order).

export class PathSearch {
  readonly w: number;
  readonly h: number;
  /** Per-cell cost for the current search; -1 = impassable. Set by the caller before search(). */
  cost: Int32Array;
  heuristicWeight: number;

  private state: Uint8Array;
  /** Generation stamp per cell: state[i] is valid only when stamp[i] === gen (no per-search clears). */
  private stamp: Uint32Array;
  private gen = 0;
  private g: Int32Array;
  private f: Int32Array;
  private parent: Int32Array;
  private heap: Int32Array;
  private heapPos: Int32Array;
  private heapN = 0;
  private goalX = 0;
  private goalY = 0;
  /** g of the goal after the last search (native "goal cost"; tests). */
  goalCost = 0;

  constructor(w: number, h: number, heuristicWeight: number) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.cost = new Int32Array(n);
    this.heuristicWeight = heuristicWeight;
    this.state = new Uint8Array(n);
    this.stamp = new Uint32Array(n);
    this.g = new Int32Array(n);
    this.f = new Int32Array(n);
    this.parent = new Int32Array(n);
    this.heap = new Int32Array(n);
    this.heapPos = new Int32Array(n);
  }

  private costAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return this.cost[y * this.w + x];
  }

  /**
   * Search from cell (sx, sy) to (gx, gy). Returns cells from the goal back to the first step
   * (start excluded) — the native order — or an empty array.
   */
  search(sx: number, sy: number, gx: number, gy: number): Int32Array {
    const W = this.w;
    this.goalCost = 0;
    if (sx < 0 || sy < 0 || sx >= W || sy >= this.h) return EMPTY;
    if (this.costAt(gx, gy) === -1) {
      // goal outside the grid: nearest in-grid cell within |goal - start| of it
      const ex = gx - sx;
      const ey = gy - sy;
      const r = isqrtInt(ex * ex + ey * ey);
      const lx = gx - r > 0 ? Math.min(gx - r, W) : 0;
      const ly = gy - r > 0 ? Math.min(gy - r, this.h) : 0;
      const hx = gx + r > 0 ? Math.min(gx + r, W) : 0;
      const hy = gy + r > 0 ? Math.min(gy + r, this.h) : 0;
      if (hy <= ly || hx <= lx) return EMPTY;
      let best = 0x7fffffff;
      let bx = -1;
      let by = -1;
      for (let y = ly; y < hy; y++) {
        for (let x = lx; x < hx; x++) {
          const d = (y - gy) * (y - gy) + (x - gx) * (x - gx);
          if (this.costAt(x, y) !== -1 && d < best) { best = d; bx = x; by = y; }
        }
      }
      if (bx === -1) return EMPTY;
      gx = bx;
      gy = by;
    }
    const goal = gx + W * gy;
    const start = sx + W * sy;
    this.goalX = gx;
    this.goalY = gy;
    const gen = ++this.gen;
    this.heapN = 0;
    this.parent[start] = -1;
    this.parent[goal] = -1;
    this.g[start] = 0;
    this.g[goal] = 0;
    this.expand(start);
    this.stamp[start] = gen;
    this.state[start] = 2;
    while (this.heapN > 0) {
      const node = this.pop();
      this.state[node] = 2;
      this.expand(node);
      if (this.stamp[goal] === gen && this.state[goal] === 2) break;
    }
    this.goalCost = this.g[goal];
    if (this.parent[goal] === -1) return EMPTY;
    let n = 0;
    for (let c = goal; this.parent[c] !== -1; c = this.parent[c]) n++;
    const out = new Int32Array(n);
    let i = 0;
    for (let c = goal; this.parent[c] !== -1; c = this.parent[c]) out[i++] = c;
    return out;
  }

  private expand(node: number): void {
    const W = this.w;
    const x = node % W;
    const y = (node - x) / W;
    this.visit(node, x, y - 1, 10);
    this.visit(node, x, y + 1, 10);
    this.visit(node, x - 1, y, 10);
    this.visit(node, x + 1, y, 10);
    this.visit(node, x - 1, y - 1, 14);
    this.visit(node, x - 1, y + 1, 14);
    this.visit(node, x + 1, y + 1, 14);
    this.visit(node, x + 1, y - 1, 14);
  }

  private heuristic(x: number, y: number): number {
    const dx = x > this.goalX ? x - this.goalX : this.goalX - x;
    const dy = y > this.goalY ? y - this.goalY : this.goalY - y;
    return 10 * (dx + dy) - 6 * (dx < dy ? dx : dy);
  }

  private visit(from: number, x: number, y: number, step: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    const c = this.cost[i];
    if (c === -1) return;
    const st = this.stamp[i] === this.gen ? this.state[i] : 0;
    if (st === 2) return;
    const g = this.g[from] + c * step;
    const f = g + this.heuristicWeight * this.heuristic(x, y);
    if (st === 0) {
      this.stamp[i] = this.gen;
      this.state[i] = 1;
      this.parent[i] = from;
      this.g[i] = g;
      this.f[i] = f;
      const k = this.heapN++;
      this.heap[k] = i;
      this.heapPos[i] = k;
      this.siftUp(k);
      return;
    }
    if (f < this.f[i]) {
      this.parent[i] = from;
      this.g[i] = g;
      this.f[i] = f;
      this.siftUp(this.heapPos[i]);
    }
  }

  private siftUp(k: number): void {
    const heap = this.heap;
    const node = heap[k];
    const fn = this.f[node];
    while (k > 0) {
      const p = (k - 1) >> 1;
      const pn = heap[p];
      if (this.f[pn] <= fn) break;
      heap[k] = pn;
      this.heapPos[pn] = k;
      k = p;
    }
    heap[k] = node;
    this.heapPos[node] = k;
  }

  private pop(): number {
    const heap = this.heap;
    const top = heap[0];
    const n = --this.heapN;
    if (n === 0) return top;
    const moving = heap[n];
    const fm = this.f[moving];
    heap[0] = moving;
    this.heapPos[moving] = 0;
    let i = 0;
    for (;;) {
      let c = i;
      let fc = fm;
      const r = 2 * i + 2;
      if (r < n && this.f[heap[r]] < fm) { c = r; fc = this.f[heap[r]]; }
      const l = 2 * i + 1;
      if (l < n && this.f[heap[l]] < fc) c = l;
      if (c === i) break;
      const cn = heap[c];
      heap[i] = cn;
      this.heapPos[cn] = i;
      heap[c] = moving;
      this.heapPos[moving] = c;
      i = c;
    }
    return top;
  }
}

function isqrtInt(v: number): number {
  if (v <= 0) return 0;
  let r = Math.floor(Math.sqrt(v));
  while (r * r > v) r--;
  while ((r + 1) * (r + 1) <= v) r++;
  return r;
}

export const EMPTY = new Int32Array(0);
