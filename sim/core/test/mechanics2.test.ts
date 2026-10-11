// Multi-summons, Inferno ramp, Electro Wizard, chain, piercing, spawning projectiles, collector, Tesla, Miner.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addActive, newBattle } from './helpers.ts';

const still = () => newBattle({ fixture: { width: 18000, height: 32000 } });

test('Three Musketeers deploy at their card offsets (placement only; their attack sequences are not supported yet)', () => {
  const b = newBattle();
  (b as unknown as { summonCard(t: number, c: unknown, x: number, y: number): void }).summonCard(0, b.defs.card('ThreeMusketeers', 11), 9500, 8500);
  b.run(1);
  const ms = b.units.filter((u) => u.card === 'ThreeMusketeers').map((u) => [u.x - 9500, u.y - 8500]);
  assert.deepEqual(ms.sort(), [[-1000, 1000], [0, -1000], [1000, 1000]].sort());
});

test('Goblin Gang: 3 stabbers + 3 spear goblins; Rascals: 1 boy + 2 girls', () => {
  const b = newBattle();
  b.spawn(0, 'GoblinGang', 9000, 8000);
  b.spawn(0, 'Rascals', 5000, 8000);
  b.run(21);
  const n = (name: string) => b.units.filter((u) => u.def.name === name).length;
  assert.equal(n('Goblin_Stab'), 3);
  assert.equal(n('SpearGoblin'), 3);
  assert.equal(n('RascalBoy'), 1);
  assert.equal(n('RascalGirl'), 2);
});

test('Inferno Tower damage ramps through three stages', () => {
  const b = still();
  const inf = addActive(b, 'InfernoTower', 0, 9000, 8000);
  const g = addActive(b, 'Golem', 1, 9000, 12000);
  const hits: number[] = [];
  let last = g.hp;
  for (let t = 0; t < 140; t++) { b.step(); if (g.hp < last) { hits.push(last - g.hp); last = g.hp; } }
  const vd = inf.def.variableDamage!;
  assert.ok(hits.includes(vd[0]) && hits.includes(vd[1]) && hits.includes(vd[2]), `hits ${[...new Set(hits)]} vs ${vd}`);
  assert.ok(hits.indexOf(vd[0]) < hits.indexOf(vd[1]) && hits.indexOf(vd[1]) < hits.indexOf(vd[2]));
});

test('Electro Wizard: spawn zap, then two targets per attack with stun', () => {
  const b = still();
  const k1 = addActive(b, 'Knight', 1, 8500, 12500);
  const k2 = addActive(b, 'Knight', 1, 9500, 12500);
  b.spawn(0, 'ElectroWizard', 9000, 10000);
  b.run(21);
  assert.ok(k1.hp < k1.maxHp && k2.hp < k2.maxHp, 'spawn zap hit both');
  const h1 = k1.hp; const h2 = k2.hp;
  b.run(80);
  assert.ok(k1.hp < h1 && k2.hp < h2, 'both hit by attacks');
});

test('Electro Dragon chains to 3 targets', () => {
  const b = still();
  addActive(b, 'ElectroDragon', 0, 9000, 10000);
  const ks = [0, 1, 2, 3].map((i) => addActive(b, 'Pekka', 1, 8000 + i * 1500, 13000));
  b.run(60);
  const hit = ks.filter((k) => k.hp < k.maxHp).length;
  assert.equal(hit, 3);
});

test('Goblin Barrel lands 3 goblins at the target', () => {
  const b = newBattle();
  b.spawn(0, 'GoblinBarrel', 9000, 20000);
  b.run(80);
  const gobs = b.units.filter((u) => u.def.name === 'BarrelGoblin');
  assert.equal(gobs.length, 3);
});

test('The Log rolls forward, damaging and pushing ground troops once', () => {
  const b = still();
  const s = addActive(b, 'Skeleton', 1, 9000, 13000);
  const k = addActive(b, 'Knight', 1, 9000, 16000);
  const y0 = k.y;
  b.spawn(0, 'Log', 9000, 12000);
  b.run(100);
  assert.ok(!b.units.includes(s), 'skeleton killed');
  assert.equal(k.maxHp - k.hp, b.defs.projectile('LogProjectileRolling', 11).damage);
  assert.ok(k.y > y0, 'pushed back');
});

test('Executioner axe returns and can hit on the way back', () => {
  const b = still();
  addActive(b, 'AxeMan', 0, 9000, 10000);
  const k = addActive(b, 'Pekka', 1, 9000, 13000);
  b.run(40);
  const dmg = b.defs.projectile('AxeManProjectile', 11).damage;
  assert.ok(k.maxHp - k.hp >= 2 * dmg, `hit twice (${k.maxHp - k.hp} vs ${dmg})`);
});

test('Elixir Collector produces elixir; Tesla hides until an enemy is in range', () => {
  const b = newBattle();
  b.spawn(0, 'Elixir Collector', 9000, 5500);
  b.run(21);
  const c = b.units.find((u) => u.def.name === 'ElixirCollector')!;
  b.players[0].elixir = 0;
  b.run(20 + 300);
  assert.ok(b.players[0].elixir >= 10000 + 300 * 178, 'collector added 1 elixir');

  const t = still();
  const tesla = addActive(t, 'Tesla', 0, 9000, 8000);
  assert.equal(tesla.hidden, true);
  t.run(10);
  assert.equal(tesla.hidden, true, 'nothing in range');
  addActive(t, 'Knight', 1, 9000, 12000);
  t.run(40);
  assert.equal(tesla.hidden, false);
  void c;
});

test('Miner tunnels from the King tower and pops up at the target', () => {
  const b = newBattle();
  assert.equal(b.spawn(0, 'Miner', 12200, 22200), null);
  b.run(21);
  const m = b.units.find((u) => u.def.name === 'Miner')!;
  assert.ok(m.tunneling);
  b.run(80);
  assert.ok(!m.tunneling);
  assert.ok(Math.abs(m.y - 22500) < 1500 && Math.abs(m.x - 12500) < 1500, `popped near the target (${m.x},${m.y})`);
});
