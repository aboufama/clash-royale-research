// The native A* (path.ts) against the 12 cases the research track ran through the original
// libg factory/search on synthetic 5x5 grids (research/evidence/native-pathfinding.json).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Battle, Unit } from '../src/index.ts';
import { PathSearch } from '../src/path.ts';
import { data, DECK_A, DECK_B } from './helpers.ts';

interface Case {
  name: string;
  width: number;
  height: number;
  start: number;
  goal: number;
  cells: number[];
  dynamic_costs: number[];
  dynamic_enabled: boolean;
  path_reverse_excludes_start: number[];
  goal_cost: number;
}

const ev = JSON.parse(readFileSync(new URL('../../../research/evidence/native-pathfinding.json', import.meta.url), 'utf8')) as { cases: Case[] };

// Path_cellCost 0x11d9304 with a null actor and this build's PATHFINDING_* globals.
function cost(c: Case, i: number): number {
  const f = c.cells[i];
  if (f & 32) return 50; // blocked tile -> blocked cost
  if (f & 64) return 50; // static building tile -> blocked cost
  const base = f & 3 ? 5 : 8; // road : default
  return c.dynamic_enabled ? Math.max(base, c.dynamic_costs[i]) : base;
}

test('native A*: 12 recorded fixture cases (paths and goal costs exact)', () => {
  assert.equal(ev.cases.length, 12);
  for (const c of ev.cases) {
    const s = new PathSearch(c.width, c.height, 5);
    for (let i = 0; i < c.width * c.height; i++) s.cost[i] = cost(c, i);
    const W = c.width;
    const p = s.search(c.start % W, Math.floor(c.start / W), c.goal % W, Math.floor(c.goal / W));
    assert.deepEqual([...p], c.path_reverse_excludes_start, `${c.name} ${c.start}->${c.goal} path`);
    assert.equal(s.goalCost, c.goal_cost, `${c.name} ${c.start}->${c.goal} goal cost`);
  }
});

test('fast goal-cell search equals the native scan (0xfcdefc) on random cases', () => {
  const b = new Battle(data, { seed: 3, decks: [DECK_A, DECK_B], noShuffle: true });
  b.step(); // build the occlusion grid (crown towers)
  let s = 12345;
  const r = (n: number) => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) % n);
  const defs = [b.defs.unit('Knight', 11), b.defs.unit('Musketeer', 11), b.defs.unit('BabyDragon', 11), b.defs.unit('HogRider', 11)];
  const g = b as unknown as { goalCell(u: Unit, t: Unit, R: number): number; goalCellReference(u: Unit, t: Unit, R: number): number };
  for (let i = 0; i < 20000; i++) {
    const u = new Unit(1, defs[r(defs.length)], '', r(2), r(18000), r(32000), 0);
    const t = i % 3 === 0 ? b.units[r(b.units.length)] : new Unit(2, defs[r(defs.length)], '', 1, r(18000), r(32000), 0);
    const R = r(8000);
    assert.equal(g.goalCell(u, t, R), g.goalCellReference(u, t, R), `case ${i}`);
  }
});
