// Death spawns, spawners, shields, river jump, charge.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ST_DEAD } from '../src/index.ts';
import { addActive, newBattle } from './helpers.ts';

const still = () => newBattle({ fixture: { width: 18000, height: 32000 } });

test('Golem splits into 2 Golemites on death', () => {
  const b = still();
  const g = addActive(b, 'Golem', 1, 9000, 20000);
  g.hp = 1;
  addActive(b, 'Knight', 0, 9000, 19000);
  b.run(40);
  assert.equal(g.state === ST_DEAD || !b.units.includes(g), true);
  assert.equal(b.units.filter((u) => u.def.name === 'Golemite').length, 2);
});

test('Balloon drops a bomb that explodes after landing (3000 ms)', () => {
  const b = still();
  const bal = addActive(b, 'Balloon', 1, 9000, 20000);
  const k = addActive(b, 'Knight', 0, 9000, 20000);
  const hp0 = k.hp;
  bal.hp = 1;
  addActive(b, 'Musketeer', 0, 9000, 16000);
  b.run(30);
  const bomb = b.units.find((u) => u.def.name === 'BalloonBomb');
  assert.ok(bomb, 'bomb spawned');
  b.run(60);
  assert.ok(!b.units.includes(bomb!), 'bomb expired');
  assert.ok(k.hp < hp0, `knight hit by the explosion (${hp0} -> ${k.hp})`);
});

test('Witch summons 4 skeletons after 1 s, then every 7 s', () => {
  const b = still();
  addActive(b, 'Witch', 0, 9000, 10000);
  const counts: number[] = [];
  for (let t = 0; t < 320; t++) {
    b.step();
    counts.push(b.units.filter((u) => u.def.name === 'Skeleton').length);
  }
  // counts[t] is after tick t: the first group spawns on tick 19 (20 ticks = 1000 ms), the next 140 ticks later
  assert.equal(counts[18], 0);
  assert.equal(counts[19], 4, `at 1 s: ${counts[19]}`);
  assert.equal(counts[158], 4);
  assert.equal(counts[159], 8, `at 8 s: ${counts[159]}`);
});

test('Guards shield absorbs the first hit', () => {
  const b = newBattle();
  const g = addActive(b, 'SkeletonWarrior', 1, 9000, 13000);
  assert.equal(g.shield, 256);
  addActive(b, 'Knight', 0, 9000, 12000);
  b.run(10);
  assert.equal(g.hp, g.maxHp, 'hp untouched while shielded');
  assert.equal(g.shield, 256 - 202);
});

test('Hog Rider jumps the river instead of using the bridge', () => {
  const b = newBattle();
  b.spawn(0, 'HogRider', 9000, 14500);
  let minDistToBridge = Infinity;
  let crossed = false;
  for (let t = 0; t < 200 && !crossed; t++) {
    b.step();
    const h = b.units.find((u) => u.def.name === 'HogRider');
    if (h && h.y >= 15000 && h.y <= 17000) minDistToBridge = Math.min(minDistToBridge, Math.min(Math.abs(h.x - 3500), Math.abs(h.x - 14500)));
    if (h && h.y > 17000) crossed = true;
  }
  assert.ok(crossed, 'crossed');
  assert.ok(minDistToBridge > 2000, `crossed away from the bridges (min ${minDistToBridge})`);
});

test('Prince charges after travelling and deals DamageSpecial on the first hit', () => {
  const b = still();
  const p = addActive(b, 'Prince', 0, 9000, 8000);
  const g = addActive(b, 'Golem', 1, 9000, 14000);
  const hp0 = g.hp;
  let charged = false;
  for (let t = 0; t < 200 && g.hp === hp0; t++) { b.step(); charged ||= p.charging; }
  assert.ok(charged, 'charged');
  assert.equal(hp0 - g.hp, p.def.damageSpecial);
  assert.equal(p.def.damageSpecial, Math.floor((306 * 256) / 100));
});
